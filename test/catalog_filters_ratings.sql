-- Verify ratings and aggregate catalogue filters without retaining any test data.
begin;
do $$
declare
  buyer uuid:=gen_random_uuid();
  other_buyer uuid:=gen_random_uuid();
  merchant uuid:=gen_random_uuid();
  shop uuid:=gen_random_uuid();
  first_order uuid:=gen_random_uuid();
  second_order uuid:=gen_random_uuid();
  cancelled uuid:=gen_random_uuid();
  top_product uuid:=gen_random_uuid();
  other_product uuid:=gen_random_uuid();
  inactive_product uuid:=gen_random_uuid();
  day date:=(now() at time zone 'America/Sao_Paulo')::date;
  data jsonb;
  store jsonb;
  product jsonb;
  filler uuid;
begin
  insert into auth.users(id,email,email_confirmed_at)
    values (buyer,buyer::text||'@example.invalid',now()),(other_buyer,other_buyer::text||'@example.invalid',now()),
      (merchant,merchant::text||'@example.invalid',now());
  insert into fly_delivery.accounts(id,role) values (buyer,'customer'),(other_buyer,'customer'),(merchant,'merchant');
  insert into fly_delivery.stores(id,owner_id,name,category,categories,active,is_open,fee)
    values (shop,merchant,'Loja Avaliação','Pizza',array['Pizza'],true,true,0);
  insert into fly_delivery.products(id,store_id,name,price,active) values
    (top_product,shop,'Pizza Campeã',3000,true),(other_product,shop,'Pizza Padrão',3000,true),(inactive_product,shop,'Pizza Inativa',3000,false);
  insert into fly_delivery.orders(id,customer_id,store_id,request_id,address,payment,subtotal,fee,status)
    values (first_order,buyer,shop,gen_random_uuid(),'Rua Teste 1 Centro','pix_delivery',3000,0,'delivered'),
      (second_order,other_buyer,shop,gen_random_uuid(),'Rua Teste 2 Centro','pix_delivery',3000,0,'delivered'),
      (cancelled,buyer,shop,gen_random_uuid(),'Rua Teste 3 Centro','pix_delivery',3000,0,'cancelled');
  insert into fly_delivery.order_items(order_id,product_id,name,price,quantity) values
    (first_order,top_product,'Pizza Campeã',3000,8),(second_order,top_product,'Pizza Campeã',3000,8),
    (first_order,other_product,'Pizza Padrão',3000,4),(cancelled,other_product,'Pizza Padrão',3000,25),
    (first_order,inactive_product,'Pizza Inativa',3000,25);
  for n in 1..21 loop
    insert into fly_delivery.products(store_id,name,price,active)
      values (shop,'Pizza Fixture '||n,3000,true) returning id into filler;
    insert into fly_delivery.order_items(order_id,product_id,name,price,quantity)
      values (first_order,filler,'Pizza Fixture '||n,3000,1);
  end loop;
  insert into fly_delivery.store_coupons(store_id,code,rate_bps,day,start_minute,end_minute,product_ids,enabled) values
    (shop,'ATUAL10',1000,day,0,1440,null,true),
    (shop,'ATUAL25',2500,day,0,1440,array[top_product],true),
    (shop,'INATIVO',8000,day,0,1440,array[inactive_product],true),
    (shop,'PAUSADO',9000,day,0,1440,null,false),
    (shop,'VENCIDO',9900,day-1,0,1440,null,true);

  perform set_config('request.jwt.claim.sub',buyer::text,true);
  set local role authenticated;
  if public.fd_api('customer_rate_order',jsonb_build_object('id',first_order,'rating',5))->>'rating' is distinct from '5' then
    raise exception 'Rating was not saved';
  end if;
  perform public.fd_api('customer_rate_order',jsonb_build_object('id',first_order,'rating',4));
  begin
    perform public.fd_api('customer_rate_order',jsonb_build_object('id',second_order,'rating',5));
    raise exception 'Another customer order accepted a rating';
  exception when raise_exception then if sqlerrm not like 'FD: Pedido entregue não encontrado%' then raise;end if;end;
  begin
    perform public.fd_api('customer_rate_order',jsonb_build_object('id',cancelled,'rating',5));
    raise exception 'Cancelled order accepted a rating';
  exception when raise_exception then if sqlerrm not like 'FD: Pedido entregue não encontrado%' then raise;end if;end;
  begin
    perform public.fd_api('customer_rate_order',jsonb_build_object('id',first_order,'rating',6));
    raise exception 'Out-of-range rating accepted';
  exception when raise_exception then if sqlerrm not like 'FD: Escolha de 1 a 5%' then raise;end if;end;
  select x into data from jsonb_array_elements(public.fd_api('customer_order_history')->'orders') x where x->>'id'=first_order::text;
  if data->>'rating' is distinct from '4' then raise exception 'Customer cannot see saved rating';end if;
  perform set_config('request.jwt.claim.sub',other_buyer::text,true);
  perform public.fd_api('customer_rate_order',jsonb_build_object('id',second_order,'rating',5));
  perform set_config('request.jwt.claim.sub',merchant::text,true);
  select x into data from jsonb_array_elements(public.fd_api('merchant_history')->'orders') x where x->>'id'=first_order::text;
  if data is null or data ? 'rating' then raise exception 'Merchant history missing or exposed individual rating';end if;
  begin
    perform public.fd_api('customer_rate_order',jsonb_build_object('id',first_order,'rating',2));
    raise exception 'Merchant allowed to rate a customer order';
  exception when raise_exception then if sqlerrm not like 'FD: Avaliação exclusiva%' then raise;end if;end;
  reset role;

  set local role anon;
  data:=public.fd_api('catalog');
  select x into store from jsonb_array_elements(data) x where x->>'id'=shop::text;
  if store->>'coupon_bps' is distinct from '2500' or store->>'fee' is distinct from '0' or
      (store->>'rating_average')::numeric is distinct from 4.5 or store->>'rating_count' is distinct from '2' or
      store::text like '%ATUAL25%' then raise exception 'Public coupon or rating data incorrect: %',store;end if;
  select x into product from jsonb_array_elements(store->'products') x where x->>'id'=top_product::text;
  if product->>'sales_rank' is null then raise exception 'Delivered product missing from ranking';end if;
  if exists(select 1 from jsonb_array_elements(store->'products') x where x->>'id'=other_product::text
      and (x->>'sales_rank')::integer <= (product->>'sales_rank')::integer) then
    raise exception 'Cancelled sales affected ranking';
  end if;
  if (select count(*) from jsonb_array_elements(data) s cross join jsonb_array_elements(s->'products') p
      where p->>'sales_rank' is not null)<>20 then raise exception 'Ranking did not cap at twenty products';end if;
  reset role;
end;
$$;
select 'Filtros, ranking por unidades entregues, avaliação individual e média pública verificados' as integration;
rollback;
