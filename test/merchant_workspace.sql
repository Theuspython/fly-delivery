-- Disposable fixtures are contained in this transaction.
begin;
do $$
declare
  merchant uuid := gen_random_uuid();
  other_merchant uuid := gen_random_uuid();
  buyer uuid := gen_random_uuid();
  shop uuid := gen_random_uuid();
  other_shop uuid := gen_random_uuid();
  actor uuid;
  active_order uuid := gen_random_uuid();
  second_order uuid := gen_random_uuid();
  result jsonb;
begin
  foreach actor in array array[merchant,other_merchant,buyer] loop
    insert into auth.users(id,email,email_confirmed_at) values(actor,actor::text || '@example.invalid',now());
  end loop;
  insert into fly_delivery.accounts(id,role) values(merchant,'merchant'),(other_merchant,'merchant'),(buyer,'customer');
  insert into fly_delivery.customer_profiles(user_id,full_name,phone) values(buyer,'Nome do Cliente','31990001111');
  insert into fly_delivery.stores(id,owner_id,name,category,categories,address,lat,lng,active,is_open)
    values(shop,merchant,'Loja de Teste','Pizza',array['Pizza'],'Rua Teste 123',-19.9,-43.9,true,true),
    (other_shop,other_merchant,'Outra Loja','Pizza',array['Pizza'],'Rua Teste 456',-19.9,-43.9,true,true);

  insert into fly_delivery.orders(id,customer_id,store_id,request_id,status,address,lat,lng,payment,subtotal,fee,distance_km)
    values(active_order,buyer,shop,gen_random_uuid(),'placed','Endereço teste',-19.91,-43.91,'cash_delivery',1500,350,1),
      (second_order,buyer,shop,gen_random_uuid(),'preparing','Endereço teste',-19.91,-43.91,'cash_delivery',1500,350,1);
  insert into fly_delivery.orders(customer_id,store_id,request_id,status,address,lat,lng,payment,subtotal,fee,distance_km)
    select buyer,shop,gen_random_uuid(),'delivered','Endereço teste',-19.91,-43.91,'cash_delivery',1000,200,1
    from generate_series(1,84);
  update fly_delivery.orders set completed_at='2026-11-04 12:00:00-03' where store_id=shop and status='delivered';

  insert into fly_delivery.orders(customer_id,store_id,request_id,status,address,lat,lng,payment,subtotal,fee,distance_km)
    select buyer,shop,gen_random_uuid(),'delivered','Endereço teste',-19.91,-43.91,'cash_delivery',1500,350,1 from generate_series(1,3);
  with selected as (
    select id,row_number() over(order by id) as ordinal
    from fly_delivery.orders where store_id=shop and status='delivered' and completed_at>'2026-11-04 12:00:00-03'
  )
  update fly_delivery.orders o set completed_at=case selected.ordinal
    when 1 then '2026-11-05 00:00:00-03'::timestamptz
    when 2 then '2026-11-05 23:59:59.999999-03'::timestamptz
    else '2026-11-06 00:00:00-03'::timestamptz end
  from selected where o.id=selected.id;
  insert into fly_delivery.orders(customer_id,store_id,request_id,status,address,lat,lng,payment,subtotal,fee,distance_km)
    values(buyer,shop,gen_random_uuid(),'cancelled','Endereço teste',-19.91,-43.91,'cash_delivery',99999,999,1),
      (buyer,other_shop,gen_random_uuid(),'delivered','Endereço teste',-19.91,-43.91,'cash_delivery',99999,999,1);
  update fly_delivery.orders set completed_at='2026-11-05 12:00:00-03' where status='cancelled' or store_id=other_shop;
  update fly_delivery.customer_profiles set full_name='Nome atualizado' where user_id=buyer;

  perform set_config('request.jwt.claim.sub',merchant::text,true);
  result:=public.fd_api('merchant_active_orders');
  if jsonb_array_length(result)<>2 or result->0->>'customer_name'<>'Nome do Cliente' then
    raise exception 'Active queue or name snapshot incorrect';
  end if;
  result:=public.fd_api('merchant_history','{"status":"delivered","page":0}');
  if result->>'count'<>'87' or result->>'pages'<>'4' or jsonb_array_length(result->'orders')<>25 then
    raise exception 'History pagination incorrect';
  end if;
  result:=public.fd_api('merchant_finance','{"date_from":"2026-11-05","date_to":"2026-11-05"}');
  if result->>'count'<>'2' or result->>'products'<>'3000' or result->>'delivery'<>'700' or result->>'total'<>'3700' then
    raise exception 'Daily accounting or timezone boundary incorrect';
  end if;
  result:=public.fd_api('merchant_finance','{"date_from":"2026-11-04","date_to":"2026-11-05","page":3}');
  if result->>'count'<>'86' or jsonb_array_length(result->'orders')<>11 then
    raise exception 'Date range aggregation or ledger pagination incorrect';
  end if;
  update fly_delivery.orders set status='delivered' where id=active_order;
  if jsonb_array_length(public.fd_api('merchant_active_orders'))<>1 then raise exception 'Delivered order stayed in queue'; end if;
  result:=public.fd_api('merchant_history','{"status":"cancelled"}');
  if result->>'count'<>'1' then raise exception 'Cancelled history missing'; end if;
  begin
    perform public.fd_api('merchant_finance','{"date_from":"2026-11-06","date_to":"2026-11-05"}');
    raise exception 'Reverse date range accepted';
  exception when raise_exception then
    if sqlerrm not like 'FD: A data final%' then raise; end if;
  end;

  perform set_config('request.jwt.claim.sub',other_merchant::text,true);
  if public.fd_api('merchant_active_orders')<>'[]'::jsonb then raise exception 'Other merchant sees active queue'; end if;
  result:=public.fd_api('merchant_finance','{"date_from":"2026-11-05","date_to":"2026-11-05"}');
  if result->>'count'<>'1' or result->>'products'<>'99999' then raise exception 'Finance crossed store boundaries'; end if;

  perform set_config('request.jwt.claim.sub',buyer::text,true);
  begin
    perform public.fd_api('merchant_active_orders');
    raise exception 'Buyer can view merchant queue';
  exception when raise_exception then
    if sqlerrm not like 'FD: Acesso exclusivo%' then raise; end if;
  end;
end;
$$;
select 'Fila, nome do cliente, finalizados, paginação, financeiro e isolamento verificados' as integration;
rollback;
