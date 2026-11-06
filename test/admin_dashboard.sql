-- Isolated fixtures and assertions; no live users or financial records are changed.
begin;
do $$
declare
  admin uuid:=gen_random_uuid(); merchant uuid:=gen_random_uuid(); buyer uuid:=gen_random_uuid();
  shop uuid; first_shop uuid; sample_shop uuid:=gen_random_uuid(); order_id uuid;
  result jsonb; second_page jsonb; actor uuid; i integer; preset text; expected_start date;
  today date:=(now() at time zone 'America/Sao_Paulo')::date;
begin
  foreach actor in array array[admin,merchant,buyer] loop
    insert into auth.users(id,email,email_confirmed_at) values(actor,actor::text||'@example.invalid',now());
  end loop;
  insert into fly_delivery.accounts(id,role) values(admin,'admin'),(merchant,'merchant'),(buyer,'customer');
  for i in 1..21 loop
    shop:=gen_random_uuid();if i=1 then first_shop:=shop;end if;
    insert into fly_delivery.stores(id,owner_id,name,category,categories,address,lat,lng,active,is_open)
      values(shop,merchant,'Dashboard '||i,'Pizza',array['Pizza'],'Rua teste 10',0,0,true,true);
    insert into fly_delivery.orders(customer_id,store_id,request_id,status,address,payment,subtotal,fee)
      values(buyer,shop,gen_random_uuid(),'delivered','Endereço privado','cash_delivery',1000,500) returning id into order_id;
    update fly_delivery.orders set completed_at=(timestamp '2001-01-01 10:00:00' at time zone 'America/Sao_Paulo'),commission_bps=1000+i*100,platform_fee_cents=100+i*10 where id=order_id;
  end loop;
  insert into fly_delivery.orders(customer_id,store_id,request_id,status,address,payment,subtotal,fee)
    values(buyer,first_shop,gen_random_uuid(),'delivered','Endereço privado','cash_delivery',2000,999) returning id into order_id;
  update fly_delivery.orders set completed_at=(timestamp '2001-01-02 00:00:00' at time zone 'America/Sao_Paulo'),commission_bps=2000,platform_fee_cents=400 where id=order_id;
  insert into fly_delivery.orders(customer_id,store_id,request_id,status,address,payment,subtotal,fee)
    values(buyer,first_shop,gen_random_uuid(),'delivered','Endereço privado','cash_delivery',1500,999) returning id into order_id;
  update fly_delivery.orders set completed_at=(timestamp '2001-01-02 23:59:59.999999' at time zone 'America/Sao_Paulo'),commission_bps=0,platform_fee_cents=0 where id=order_id;
  insert into fly_delivery.orders(customer_id,store_id,request_id,status,address,payment,subtotal,fee)
    values(buyer,first_shop,gen_random_uuid(),'delivered','Endereço privado','cash_delivery',9999,999) returning id into order_id;
  update fly_delivery.orders set completed_at=(timestamp '2001-01-03 00:00:00' at time zone 'America/Sao_Paulo'),commission_bps=10000,platform_fee_cents=9999 where id=order_id;
  -- Legacy, cancelled, active and sample orders must not add platform revenue.
  insert into fly_delivery.orders(customer_id,store_id,request_id,status,address,payment,subtotal,fee)
    values(buyer,first_shop,gen_random_uuid(),'delivered','Endereço privado','cash_delivery',9999,999) returning id into order_id;
  update fly_delivery.orders set completed_at=(timestamp '2001-01-01 11:00:00' at time zone 'America/Sao_Paulo'),commission_bps=null,platform_fee_cents=null where id=order_id;
  insert into fly_delivery.orders(customer_id,store_id,request_id,status,address,payment,subtotal,fee,completed_at,commission_bps,platform_fee_cents)
    values(buyer,first_shop,gen_random_uuid(),'cancelled','Endereço privado','cash_delivery',9999,999,(timestamp '2001-01-01 11:00:00' at time zone 'America/Sao_Paulo'),10000,9999),
      (buyer,first_shop,gen_random_uuid(),'preparing','Endereço privado','cash_delivery',9999,999,(timestamp '2001-01-01 11:00:00' at time zone 'America/Sao_Paulo'),10000,9999);
  insert into fly_delivery.stores(id,owner_id,name,category,categories,address,lat,lng,sample)
    values(sample_shop,null,'Sample excluded','Pizza',array['Pizza'],'Rua teste 10',0,0,true);
  insert into fly_delivery.orders(customer_id,store_id,request_id,status,address,payment,subtotal,fee)
    values(buyer,sample_shop,gen_random_uuid(),'delivered','Endereço privado','cash_delivery',9999,999) returning id into order_id;
  update fly_delivery.orders set completed_at=(timestamp '2001-01-01 11:00:00' at time zone 'America/Sao_Paulo'),commission_bps=10000,platform_fee_cents=9999 where id=order_id;
  update fly_delivery.stores set deleted_at=now(),suspended_at=now() where id=first_shop;
  perform set_config('request.jwt.claim.sub',admin::text,true);
  result:=public.fd_api('admin_commission_dashboard','{"period":"range","date_from":"2001-01-01","date_to":"2001-01-02"}');
  if result->'summary'->>'commission_cents'<>'4810' or result->'summary'->>'sales_cents'<>'24500'
    or result->'summary'->>'orders'<>'23' or result->'summary'->>'stores'<>'21' then raise exception 'Commission snapshots, delivery exclusion, statuses or historical stores incorrect: %',result->'summary';end if;
  if result->>'pages'<>'2' or jsonb_array_length(result->'stores')<>20 or jsonb_array_length(result->'top_stores')<>5 then raise exception 'Store pagination or ranking incorrect';end if;
  if result->'top_stores'->0->>'store_id'<>first_shop::text or result->'top_stores'->0->>'commission_cents'<>'510' then raise exception 'Ranking must include deleted store historical revenue';end if;
  second_page:=public.fd_api('admin_commission_dashboard','{"period":"range","date_from":"2001-01-01","date_to":"2001-01-02","page":1}');
  if jsonb_array_length(second_page->'stores')<>1 or second_page->'summary'<>result->'summary' then raise exception 'Pagination changed global summary';end if;
  if exists(select 1 from jsonb_array_elements(result->'stores') a join jsonb_array_elements(second_page->'stores') b on a->>'store_id'=b->>'store_id') then raise exception 'Pages overlap';end if;
  if (select sum((p->>'commission_cents')::bigint) from jsonb_array_elements(result->'series') p)<>4810 then raise exception 'Chart and summary differ';end if;
  result:=public.fd_api('admin_commission_dashboard','{"period":"day","date_from":"2001-01-02","date_to":"1900-01-01"}');
  if result->'summary'->>'commission_cents'<>'400' or result->'summary'->>'orders'<>'2' or result->>'date_to'<>'2001-01-02' then raise exception 'Day or Brasília midnight boundary incorrect';end if;
  result:=public.fd_api('admin_commission_dashboard','{"period":"range","date_from":"2001-01-01","date_to":"2001-01-05"}');
  if jsonb_array_length(result->'series')<>5 or result->'series'->3->>'commission_cents'<>'0' then raise exception 'Zero days missing';end if;
  result:=public.fd_api('admin_commission_dashboard','{"period":"range","date_from":"2001-01-01","date_to":"2001-12-31"}');
  if result->>'bucket'<>'month' or jsonb_array_length(result->'series')<>12 or result->'series'->0->>'commission_cents'<>'14809' then raise exception 'Monthly aggregation incorrect';end if;
  result:=public.fd_api('admin_commission_dashboard','{"period":"day","date_from":"2000-01-01"}');
  if result->'summary'->>'commission_cents'<>'0' or result->'summary'->>'orders'<>'0' or result->>'pages'<>'1' or result->'stores'<>'[]'::jsonb then raise exception 'Empty dashboard incorrect';end if;
  foreach preset in array array['7d','15d','30d','3m'] loop
    expected_start:=case preset when '7d' then today-6 when '15d' then today-14 when '30d' then today-29 else (today-interval '3 months')::date+1 end;
    result:=public.fd_api('admin_commission_dashboard',jsonb_build_object('period',preset));
    if result->>'date_from'<>expected_start::text or result->>'date_to'<>today::text then raise exception 'Rolling preset incorrect';end if;
  end loop;
  begin perform public.fd_api('admin_commission_dashboard','{"period":"range","date_from":"2001-01-02","date_to":"2001-01-01"}');raise exception 'Reversed dates accepted';exception when raise_exception then if sqlerrm not like 'FD: A data final%' then raise;end if;end;
  begin perform public.fd_api('admin_commission_dashboard','{"period":"day","date_from":"2001-02-30"}');raise exception 'Invalid date accepted';exception when raise_exception then if sqlerrm not like 'FD: Confira as datas%' then raise;end if;end;
  begin perform public.fd_api('admin_commission_dashboard','{"period":"bad"}');raise exception 'Invalid preset accepted';exception when raise_exception then if sqlerrm not like 'FD: Período inválido%' then raise;end if;end;
  begin perform public.fd_api('admin_commission_dashboard','{"page":-1}');raise exception 'Invalid page accepted';exception when raise_exception then if sqlerrm not like 'FD: Página inválida%' then raise;end if;end;
  foreach actor in array array[merchant,buyer] loop
    perform set_config('request.jwt.claim.sub',actor::text,true);
    begin perform public.fd_api('admin_commission_dashboard');raise exception 'Non-admin accessed dashboard';exception when raise_exception then if sqlerrm not like 'FD: Dashboard exclusivo%' then raise;end if;end;
  end loop;
  perform set_config('request.jwt.claim.sub',admin::text,true);update fly_delivery.accounts set enabled=false where id=admin;
  begin perform public.fd_api('admin_commission_dashboard');raise exception 'Disabled admin accessed dashboard';exception when raise_exception then if sqlerrm not like 'FD: Dashboard exclusivo%' then raise;end if;end;
  if has_function_privilege('anon','fly_delivery.admin_commission_dashboard(jsonb)','EXECUTE') then raise exception 'Anonymous function grant';end if;
end;
$$;
select 'Dashboard: snapshots, presets, datas Brasília, tabelas, gráfico, paginação, vazios e autorização verificados' as integration;
rollback;
