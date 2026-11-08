-- Exercises stock, coupon limits and real commission snapshots with rollback-only fixtures.
begin;
do $$
<<fixture>>
declare
  admin uuid:=gen_random_uuid();
  merchant uuid:=gen_random_uuid();
  other_merchant uuid:=gen_random_uuid();
  buyer uuid:=gen_random_uuid();
  store_id uuid:=gen_random_uuid();
  other_store uuid:=gen_random_uuid();
  product uuid;
  product_other uuid;
  first_order uuid;
  second_order uuid;
  third_order uuid;
  coupon uuid;
  payload jsonb;
  quote jsonb;
  result jsonb;
  current_day date:=(now() at time zone 'America/Sao_Paulo')::date;
begin
  insert into auth.users(id,email,email_confirmed_at) select id,id::text||'@example.invalid',now() from unnest(array[admin,merchant,other_merchant,buyer]) id;
  insert into fly_delivery.accounts(id,role) values (admin,'admin'),(merchant,'merchant'),(other_merchant,'merchant'),(buyer,'customer');
  insert into fly_delivery.customer_profiles(user_id,full_name,phone) values(buyer,'Cliente Estoque','31992345679');
  insert into fly_delivery.stores(id,owner_id,name,category,categories,active,is_open,fee) values
    (store_id,merchant,'Loja Estoque','Pizza',array['Pizza'],true,true,500),
    (other_store,other_merchant,'Outra Loja Estoque','Pizza',array['Pizza'],true,true,500);
  update fly_delivery.billing_config set commission_bps=1000,payments_ready=true where id;
  update fly_delivery.promotion_days set enabled=false where day=current_day;

  perform set_config('request.jwt.claim.sub',admin::text,true);
  begin
    perform public.fd_api('admin_save_platform_coupon',jsonb_build_object('code','FDTEST12','rate_bps',1200,'expires_on',current_day));
    raise exception 'Coupon exceeded platform rate';
  exception when raise_exception then if sqlerrm not like 'FD: O desconto deve%' then raise;end if;end;
  coupon:=(public.fd_api('admin_save_platform_coupon',jsonb_build_object('code','FDTEST05','rate_bps',500,'expires_on',current_day,
    'store_id',store_id,'use_limit',1))->>'id')::uuid;
  perform public.fd_api('admin_save_platform_coupon',jsonb_build_object('code','FDTEST10','rate_bps',1000,'expires_on',current_day));
  perform set_config('request.jwt.claim.sub',merchant::text,true);
  result:=public.fd_api('save_product',jsonb_build_object('store_id',store_id,'name','Pizza Teste','category','Pizza','price',5000,'stock_quantity',2));
  product:=(result->>'id')::uuid;
  begin
    perform public.fd_api('merchant_save_coupon',jsonb_build_object('store_id',store_id,'code','FDTEST05','enabled',true));
    raise exception 'Merchant coupon reused platform code';
  exception when raise_exception then if sqlerrm not like 'FD: Esse código está reservado%' then raise;end if;end;
  perform set_config('request.jwt.claim.sub',other_merchant::text,true);
  product_other:=(public.fd_api('save_product',jsonb_build_object('store_id',other_store,'name','Pizza Outra','category','Pizza','price',5000))->>'id')::uuid;
  begin
    perform public.fd_api('merchant_adjust_stock',jsonb_build_object('store_id',store_id,'id',product,'stock_quantity',9));
    raise exception 'Other merchant could adjust stock';
  exception when raise_exception then if sqlerrm not like 'FD: Você não tem acesso%' then raise;end if;end;
  perform set_config('request.jwt.claim.sub',buyer::text,true);
  payload:=jsonb_build_object('store_id',store_id,'fee',500,'request_id',gen_random_uuid(),'address','Rua Teste 12 Centro','payment','pix_delivery',
    'coupon_code','fdtest05','items',jsonb_build_array(jsonb_build_object('id',product,'quantity',1,'price',5000)));
  begin
    perform public.fd_api('quote_order',payload||jsonb_build_object('store_id',other_store,'items',jsonb_build_array(jsonb_build_object('id',product_other,'quantity',1,'price',5000))));
    raise exception 'Store-scoped coupon accepted elsewhere';
  exception when raise_exception then if sqlerrm not like 'FD: Cupom inválido%' then raise;end if;end;
  quote:=public.fd_api('quote_order',payload);
  if quote->>'total' is distinct from '5250' or quote->>'coupon_source' is distinct from 'platform' then raise exception 'Coupon quote incorrect: %',quote;end if;
  result:=public.fd_api('place',payload||jsonb_build_object('quote',quote));first_order:=(result->>'id')::uuid;
  if public.fd_api('place',payload||jsonb_build_object('quote',quote))->>'id' is distinct from first_order::text then raise exception 'Idempotent retry failed';end if;
  if (select stock_quantity from fly_delivery.products where id=product)<>2 or fly_delivery.stock_reserved(product)<>1 then
    raise exception 'Physical stock changed before delivery or reservation missing';
  end if;
  begin
    perform public.fd_api('quote_order',payload);
    raise exception 'Limit ignored';
  exception when raise_exception then if sqlerrm not like 'FD: Cupom inválido%' then raise;end if;end;
  perform public.fd_api('transition',jsonb_build_object('id',first_order,'status','cancelled'));
  if fly_delivery.stock_reserved(product)<>0 or fly_delivery.platform_coupon_uses(coupon)<>0 then raise exception 'Cancellation did not release reservation and use';end if;
  payload:=payload||jsonb_build_object('request_id',gen_random_uuid());
  result:=public.fd_api('place',payload||jsonb_build_object('quote',public.fd_api('quote_order',payload)));second_order:=(result->>'id')::uuid;
  payload:=payload||jsonb_build_object('request_id',gen_random_uuid(),'coupon_code','FDTEST10');
  result:=public.fd_api('place',payload||jsonb_build_object('quote',public.fd_api('quote_order',payload)));third_order:=(result->>'id')::uuid;
  begin
    perform public.fd_api('quote_order',payload);
    raise exception 'Overselling accepted';
  exception when raise_exception then if sqlerrm not like 'FD: Estoque insuficiente%' then raise;end if;end;
  perform set_config('request.jwt.claim.sub',merchant::text,true);
  result:=public.fd_api('merchant_alerts');
  if not exists(select 1 from jsonb_array_elements(result->'stock') x where x->>'id'=product::text and x->>'available'='0')
    then raise exception 'Low stock alert missing';end if;
  begin
    perform public.fd_api('merchant_adjust_stock',jsonb_build_object('store_id',store_id,'id',product,'stock_quantity',1,'stock_expected',2));
    raise exception 'Stock can be adjusted below reservations';
  exception when raise_exception then if sqlerrm not like 'FD: Há %' then raise;end if;end;
  perform public.fd_api('transition',jsonb_build_object('id',second_order,'status','preparing'));
  perform public.fd_api('transition',jsonb_build_object('id',second_order,'status','picked_up'));
  if (select stock_quantity from fly_delivery.products where id=product)<>2 then raise exception 'Physical stock changed on dispatch';end if;
  perform public.fd_api('transition',jsonb_build_object('id',second_order,'status','delivered'));
  if (select stock_quantity from fly_delivery.products where id=product)<>1 then raise exception 'Stock not deducted on delivery';end if;
  if not exists(select 1 from fly_delivery.orders where id=second_order and platform_fee_cents=250 and commission_bps=500)
    then raise exception '5 percent coupon did not leave 5 percent commission';end if;
  perform public.fd_api('transition',jsonb_build_object('id',third_order,'status','preparing'));
  perform public.fd_api('transition',jsonb_build_object('id',third_order,'status','picked_up'));
  perform public.fd_api('transition',jsonb_build_object('id',third_order,'status','delivered'));
  if not exists(select 1 from fly_delivery.orders where id=third_order and platform_fee_cents=0 and commission_bps is null)
    then raise exception 'Full coupon did not waive commission';end if;
  if (select stock_quantity from fly_delivery.products where id=product)<>0 then raise exception 'Final stock incorrect';end if;
  update fly_delivery.orders set completed_at=((current_day-1)+time '19:00') at time zone 'America/Sao_Paulo' where id=second_order;
  result:=public.fd_api('merchant_alerts');
  if not exists(select 1 from jsonb_array_elements(result->'invoices') x where x->>'amount_cents'='250')
    then raise exception 'Closed invoice notification missing or mispriced';end if;
  update fly_delivery.daily_invoices i set status='paid',paid_at=now() where i.store_id=fixture.store_id;
  if jsonb_array_length(public.fd_api('merchant_alerts')->'invoices')<>0 then raise exception 'Paid invoice still generates an alert';end if;
  perform set_config('request.jwt.claim.sub',admin::text,true);
  perform public.fd_api('admin_delete_platform_coupon',jsonb_build_object('id',coupon));
  if not exists(select 1 from fly_delivery.orders where id=second_order and platform_coupon_id=coupon and platform_fee_cents=250)
    then raise exception 'Deleting coupon changed historic charge';end if;
end;
$$;
select 'Estoque, reservas, cupons, comissão e notificações verificados' as integration;
rollback;
