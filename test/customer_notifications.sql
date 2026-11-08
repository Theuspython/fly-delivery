-- Exercises notifications through the authenticated API with rollback-only fixtures.
begin;
do $$
declare
  buyer uuid:=gen_random_uuid();
  other_buyer uuid:=gen_random_uuid();
  merchant uuid:=gen_random_uuid();
  shop uuid:=gen_random_uuid();
  closed_shop uuid:=gen_random_uuid();
  pending_review uuid:=gen_random_uuid();
  foreign_order uuid:=gen_random_uuid();
  coupon uuid:=gen_random_uuid();
  item uuid:=gen_random_uuid();
  first_notice uuid;
  second_notice uuid;
  today date:=(now() at time zone 'America/Sao_Paulo')::date;
  data jsonb;
  row_data jsonb;
begin
  insert into auth.users(id,email,email_confirmed_at)
    values (buyer,buyer::text||'@example.invalid',now()),(other_buyer,other_buyer::text||'@example.invalid',now()),(merchant,merchant::text||'@example.invalid',now());
  insert into fly_delivery.accounts(id,role) values (buyer,'customer'),(other_buyer,'customer'),(merchant,'merchant');
  insert into fly_delivery.stores(id,owner_id,name,category,categories,active,is_open,fee) values
    (shop,merchant,'Loja Avisos','Pizza',array['Pizza'],true,true,0),
    (closed_shop,merchant,'Loja Fechada Avisos','Pizza',array['Pizza'],true,false,0);
  insert into fly_delivery.products(id,store_id,name,price,active) values
    (item,shop,'Pizza específica',3000,true),(gen_random_uuid(),closed_shop,'Pizza fechada',3000,true);
  insert into fly_delivery.orders(id,customer_id,store_id,request_id,address,payment,subtotal,fee,status) values
    (pending_review,buyer,shop,gen_random_uuid(),'Rua Cliente 10 Centro','pix_delivery',3000,0,'delivered'),
    (foreign_order,other_buyer,shop,gen_random_uuid(),'Rua Cliente 11 Centro','pix_delivery',3000,0,'delivered'),
    (gen_random_uuid(),buyer,shop,gen_random_uuid(),'Rua Cliente 10 Centro','pix_delivery',3000,0,'cancelled');
  insert into fly_delivery.store_coupons(id,store_id,code,rate_bps,day,start_minute,end_minute,product_ids,enabled) values
    (coupon,shop,'ATIVO20',2000,today,0,1440,array[item],true),
    (gen_random_uuid(),shop,'VENCIDO',9000,today-1,0,1440,null,true),
    (gen_random_uuid(),shop,'PAUSADO',9000,today,0,1440,null,false),
    (gen_random_uuid(),closed_shop,'FECHADA',9000,today,0,1440,null,true);
  select c.notice_id into first_notice from fly_delivery.store_coupons c where c.id=coupon;
  if first_notice is null then raise exception 'Creation did not register coupon notification';end if;

  perform set_config('request.jwt.claim.sub',buyer::text,true);
  set local role authenticated;
  data:=public.fd_api('customer_notifications');
  if not exists(select 1 from jsonb_array_elements(data->'items') x where x->>'id'=pending_review::text and x->>'kind'='review')
    or exists(select 1 from jsonb_array_elements(data->'items') x where x->>'id'=foreign_order::text or x->>'code' in ('VENCIDO','PAUSADO','FECHADA')) then
    raise exception 'Pending review ownership or coupon eligibility incorrect';
  end if;
  select x into row_data from jsonb_array_elements(data->'items') x where x->>'id'=coupon::text;
  if row_data->>'unread' is distinct from 'true' or row_data->>'code' is distinct from 'ATIVO20'
    or row_data->'products' is distinct from '["Pizza específica"]'::jsonb then raise exception 'Coupon notice data incorrect';end if;
  perform public.fd_api('customer_read_coupon_notice',jsonb_build_object('coupon_id',coupon,'notice_id',first_notice));
  select x into row_data from jsonb_array_elements(public.fd_api('customer_notifications')->'items') x where x->>'id'=coupon::text;
  if row_data->>'unread' is distinct from 'false' then raise exception 'Read state missing';end if;
  if public.fd_api('customer_order_history',jsonb_build_object('order_id',pending_review))->'orders'->0->>'id' is distinct from pending_review::text
    or public.fd_api('customer_order_history',jsonb_build_object('order_id',foreign_order))->>'count' is distinct from '0' then raise exception 'Deep link ownership incorrect';end if;
  perform public.fd_api('customer_rate_order',jsonb_build_object('id',pending_review,'rating',4));
  if exists(select 1 from jsonb_array_elements(public.fd_api('customer_notifications')->'items') x where x->>'id'=pending_review::text)
    then raise exception 'Rated order still pending';end if;
  perform set_config('request.jwt.claim.sub',other_buyer::text,true);
  select x into row_data from jsonb_array_elements(public.fd_api('customer_notifications')->'items') x where x->>'id'=coupon::text;
  if row_data->>'unread' is distinct from 'true' then raise exception 'Coupon read leaked to another customer';end if;
  perform set_config('request.jwt.claim.sub',merchant::text,true);
  begin
    perform public.fd_api('customer_notifications');
    raise exception 'Merchant allowed to read customer notifications';
  exception when raise_exception then if sqlerrm not like 'FD: Notificações exclusivas%' then raise;end if;end;
  perform public.fd_api('merchant_toggle_coupon',jsonb_build_object('id',coupon,'store_id',shop,'enabled',false));
  perform public.fd_api('merchant_toggle_coupon',jsonb_build_object('id',coupon,'store_id',shop,'enabled',true));
  reset role;
  select c.notice_id into second_notice from fly_delivery.store_coupons c where c.id=coupon;
  if second_notice is null or second_notice=first_notice then raise exception 'Reactivation reused a notification';end if;
  perform set_config('request.jwt.claim.sub',buyer::text,true);
  set local role authenticated;
  if public.fd_api('customer_read_coupon_notice',jsonb_build_object('coupon_id',coupon,'notice_id',first_notice))->>'ok' is distinct from 'false'
    then raise exception 'A stale receipt marked the reactivated coupon';end if;
  select x into row_data from jsonb_array_elements(public.fd_api('customer_notifications')->'items') x where x->>'id'=coupon::text;
  if row_data->>'unread' is distinct from 'true' then raise exception 'Reactivated coupon did not notify again';end if;
  reset role;
  update fly_delivery.stores set is_open=false where id=shop;
  set local role authenticated;
  if exists(select 1 from jsonb_array_elements(public.fd_api('customer_notifications')->'items') x where x->>'id'=coupon::text)
    then raise exception 'Coupon still shown after store closure';end if;
  reset role;
end;
$$;
select 'Notificações, loja aberta, reativação, leitura e autorização verificadas' as integration;
rollback;
