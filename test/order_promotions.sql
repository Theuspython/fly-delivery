-- Discount quotes, promotion billing and single-row order history use rollback-only fixtures.
begin;
do $$
declare
  admin uuid:=gen_random_uuid();
  merchant uuid:=gen_random_uuid();
  other_merchant uuid:=gen_random_uuid();
  buyer uuid:=gen_random_uuid();
  actor uuid;
  shop uuid:=gen_random_uuid();
  pizza uuid;
  drink uuid;
  coupon_id uuid;
  order_id uuid;
  result jsonb;
  payload jsonb;
  quote jsonb;
  base_day date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;
  shop_record fly_delivery.stores;
  schedule jsonb:=(select jsonb_agg('{"open":"00:00","close":"00:00"}'::jsonb) from generate_series(1,7));
begin
  foreach actor in array array[admin,merchant,other_merchant,buyer] loop
    insert into auth.users(id,email,email_confirmed_at) values(actor,actor::text||'@example.invalid',now());
  end loop;
  insert into fly_delivery.accounts(id,role) values(admin,'admin'),(merchant,'merchant'),(other_merchant,'merchant'),(buyer,'customer');
  insert into fly_delivery.customer_profiles(user_id,full_name,phone) values(buyer,'Cliente Promoções','31992345679');
  insert into fly_delivery.stores(id,owner_id,name,category,categories,address,active,is_open,fee,weekly_hours)
    values(shop,merchant,'Loja Promoções','Pizza',array['Pizza'],'Rua da Loja 30',true,true,500,schedule);
  update fly_delivery.billing_config set commission_bps=1000,payments_ready=true where id=true;
  perform set_config('request.jwt.claim.sub',admin::text,true);
  result:=public.fd_api('admin_save_promotion_day',jsonb_build_object('day',base_day,'enabled',true));
  if result->>'commission_bps' is distinct from '1000' then raise exception 'Admin promotion rate incorrect';end if;
  perform public.fd_api('admin_save_promotion_day',jsonb_build_object('day',base_day+1,'enabled',false));
  if fly_delivery.promotion_rate(base_day::timestamp at time zone 'America/Sao_Paulo') is distinct from 1000 or
     fly_delivery.promotion_rate((base_day+1)::timestamp at time zone 'America/Sao_Paulo') is not null then
    raise exception 'Promotion local-day boundary incorrect';
  end if;
  perform set_config('request.jwt.claim.sub',merchant::text,true);
  pizza:=(public.fd_api('save_product',jsonb_build_object('store_id',shop,'name','Pizza','price',3000))->>'id')::uuid;
  drink:=(public.fd_api('save_product',jsonb_build_object('store_id',shop,'name','Bebida','price',2000))->>'id')::uuid;
  result:=public.fd_api('merchant_save_coupon',jsonb_build_object('store_id',shop,'code','pizza20','rate_bps',2000,'day',base_day,
    'start_minute',0,'end_minute',1440,'product_ids',jsonb_build_array(pizza),'enabled',true));
  coupon_id:=(result->>'id')::uuid;
  if coupon_id is null or result->>'code' is distinct from 'PIZZA20' then raise exception 'Coupon not saved';end if;
  perform set_config('request.jwt.claim.sub',other_merchant::text,true);
  if public.fd_api('merchant_coupons') is distinct from '[]'::jsonb then raise exception 'Cross-store coupon list';end if;
  begin
    perform public.fd_api('merchant_toggle_coupon',jsonb_build_object('id',coupon_id,'store_id',shop,'enabled',false));
    raise exception 'Cross-store coupon update';
  exception when raise_exception then if sqlerrm not like 'FD: Você não tem acesso%' then raise;end if;end;
  perform set_config('request.jwt.claim.sub',buyer::text,true);
  begin
    perform public.fd_api('admin_promotion_days');
    raise exception 'Customer allowed into promotion admin';
  exception when raise_exception then if sqlerrm not like 'FD: Acesso exclusivo%' then raise;end if;end;
  payload:=jsonb_build_object('store_id',shop,'fee',500,'request_id',gen_random_uuid(),'address','Rua do Cliente 123 - Centro','payment','pix_delivery',
    'items',jsonb_build_array(jsonb_build_object('id',pizza,'price',3000,'quantity',1),jsonb_build_object('id',drink,'price',2000,'quantity',1)));
  result:=public.fd_api('quote_order',payload);
  if result->>'subtotal' is distinct from '4500' or result->>'total' is distinct from '5000' then raise exception 'Platform-only discount incorrect';end if;
  payload:=payload||'{"coupon_code":"PIZZA20"}'::jsonb;
  quote:=public.fd_api('quote_order',payload);
  if quote->>'coupon_discount_cents' is distinct from '600' or quote->>'platform_discount_cents' is distinct from '440'
    or quote->>'total' is distinct from '4460' then raise exception 'Combined discounts incorrect: %',quote;end if;
  result:=public.fd_api('place',payload||jsonb_build_object('quote',quote));
  order_id:=(result->>'id')::uuid;
  if result->>'gross_subtotal' is distinct from '5000' or result->>'subtotal' is distinct from '3960' then raise exception 'Order discount snapshot incorrect';end if;
  perform set_config('request.jwt.claim.sub',admin::text,true);
  perform public.fd_api('admin_save_promotion_day',jsonb_build_object('day',base_day,'enabled',false));
  perform set_config('request.jwt.claim.sub',buyer::text,true);
  if public.fd_api('place',payload||jsonb_build_object('quote',quote))->>'id' is distinct from order_id::text then raise exception 'Retry duplicated order';end if;
  begin
    perform public.fd_api('place',payload||jsonb_build_object('quote',quote,'request_id',gen_random_uuid()));
    raise exception 'Stale discount quote accepted';
  exception when raise_exception then if sqlerrm not like 'FD: Os descontos mudaram%' then raise;end if;end;
  perform set_config('request.jwt.claim.sub',merchant::text,true);
  if public.fd_api('merchant_active_orders')->0 ? 'address' then raise exception 'Address exposed before acceptance';end if;
  result:=public.fd_api('transition',jsonb_build_object('id',order_id,'status','preparing'));
  if result->>'address' is distinct from 'Rua do Cliente 123 - Centro' then raise exception 'Address absent after acceptance';end if;
  perform public.fd_api('transition',jsonb_build_object('id',order_id,'status','picked_up'));
  result:=public.fd_api('transition',jsonb_build_object('id',order_id,'status','delivered'));
  if result->'events'->3->>'status' is distinct from 'delivered' or jsonb_array_length(result->'events')<>4 or
    not exists(select 1 from fly_delivery.orders o where o.id=order_id and o.accepted_at is not null and o.dispatched_at is not null
      and o.promotion_bps=1000 and o.commission_bps is null and o.platform_fee_cents=0) then raise exception 'Order history or commission snapshot incorrect';end if;
  update fly_delivery.orders set completed_at=(base_day-1)::timestamp at time zone 'America/Sao_Paulo' where id=order_id;
  perform fly_delivery.close_daily_invoices(shop);
  if exists(select 1 from fly_delivery.daily_invoices where store_id=shop) then raise exception 'Promotional order generated an invoice';end if;
  perform public.fd_api('merchant_toggle_coupon',jsonb_build_object('id',coupon_id,'store_id',shop,'enabled',false));
  perform set_config('request.jwt.claim.sub',buyer::text,true);
  begin
    perform public.fd_api('quote_order',payload);
    raise exception 'Paused coupon accepted';
  exception when raise_exception then if sqlerrm not like 'FD: Cupom inválido%' then raise;end if;end;
  perform set_config('request.jwt.claim.sub',merchant::text,true);
  perform public.fd_api('merchant_save_coupon',jsonb_build_object('id',coupon_id,'store_id',shop,'code','PIZZA20','rate_bps',10000,
    'day',base_day,'start_minute',600,'end_minute',660,'enabled',true));
  select * into shop_record from fly_delivery.stores where id=shop;
  result:=fly_delivery.price_order(shop_record,payload,(base_day+time '10:00') at time zone 'America/Sao_Paulo')->'quote';
  if result->>'subtotal' is distinct from '0' or result->>'total' is distinct from '500' then
    raise exception '100%% coupon or opening time incorrect';
  end if;
  begin
    perform fly_delivery.price_order(shop_record,payload,(base_day+time '11:00') at time zone 'America/Sao_Paulo');
    raise exception 'Coupon accepted at closing time';
  exception when raise_exception then if sqlerrm not like 'FD: Cupom inválido%' then raise;end if;end;
  if to_regclass('fly_delivery.order_events') is not null then raise exception 'Legacy table still present';end if;
end;
$$;
select 'Cupons, desconto automático, cotação, comissão e histórico verificados' as integration;
rollback;
