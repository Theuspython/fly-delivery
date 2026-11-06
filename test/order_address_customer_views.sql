-- Privacy, ownership and customer partitions are tested without persistent fixtures.
begin;
do $$
declare
 merchant uuid:=gen_random_uuid(); other_merchant uuid:=gen_random_uuid(); buyer uuid:=gen_random_uuid(); other_buyer uuid:=gen_random_uuid(); actor uuid;
 shop uuid:=gen_random_uuid(); product uuid; pending uuid; accepted uuid; cancelled_before uuid; cancelled_after uuid; index_value integer;
 result jsonb; order_row jsonb; input jsonb; page_one jsonb; page_two jsonb;
 private_address text:='Rua Sigilosa 123 - Bairro Privado';
 schedule jsonb:=(select jsonb_agg(jsonb_build_object('open','00:00','close','00:00')) from generate_series(1,7));
begin
 foreach actor in array array[merchant,other_merchant,buyer,other_buyer] loop insert into auth.users(id,email,email_confirmed_at) values(actor,actor::text||'@example.invalid',now());end loop;
 insert into fly_delivery.accounts(id,role) values(merchant,'merchant'),(other_merchant,'merchant'),(buyer,'customer'),(other_buyer,'customer');
 insert into fly_delivery.customer_profiles(user_id,full_name,phone) values(buyer,'Cliente Privacidade','31992345678');
 insert into fly_delivery.stores(id,owner_id,name,category,categories,address,active,is_open,fee,weekly_hours) values(shop,merchant,'Loja Privacidade','Pizza',array['Pizza'],'Rua da Loja 20',true,true,500,schedule);
 perform set_config('request.jwt.claim.sub',merchant::text,true);
 result:=public.fd_api('save_product',jsonb_build_object('store_id',shop,'name','Pizza','price',2500));product:=(result->>'id')::uuid;
 perform set_config('request.jwt.claim.sub',buyer::text,true);
 input:=jsonb_build_object('store_id',shop,'request_id',gen_random_uuid(),'address',private_address,'payment','cash_delivery','fee',500,'note','Sem azeitona','items',jsonb_build_array(jsonb_build_object('id',product,'price',2500,'quantity',2)));
 result:=public.fd_api('place',input);pending:=(result->>'id')::uuid;
 if result->>'address'<>private_address then raise exception 'Customer lost own address before merchant acceptance';end if;
 update fly_delivery.orders set created_at=now()-interval '1 year',lat=-19.12,lng=-43.12,distance_km=1.25 where id=pending;
 result:=public.fd_api('place',input||jsonb_build_object('request_id',gen_random_uuid()));accepted:=(result->>'id')::uuid;
 result:=public.fd_api('place',input||jsonb_build_object('request_id',gen_random_uuid()));cancelled_before:=(result->>'id')::uuid;
 perform public.fd_api('transition',jsonb_build_object('id',cancelled_before,'status','cancelled'));
 result:=public.fd_api('place',input||jsonb_build_object('request_id',gen_random_uuid()));cancelled_after:=(result->>'id')::uuid;
 perform set_config('request.jwt.claim.sub',merchant::text,true);
 result:=public.fd_api('merchant_active_orders');
 select x into order_row from jsonb_array_elements(result) x where x->>'id'=pending::text;
 if order_row is null or order_row ?| array['address','lat','lng','distance_km'] or order_row->>'address_hidden'<>'true' or order_row::text like '%'||private_address||'%' then raise exception 'Pending address leaked in merchant queue';end if;
 if order_row->>'note'<>'Sem azeitona' or jsonb_array_length(order_row->'items')<>1 then raise exception 'Pending items or preparation note hidden';end if;
 foreach input in array array['{}'::jsonb,'{"view":"merchant"}'::jsonb] loop
   select x into order_row from jsonb_array_elements(public.fd_api('orders',input)) x where x->>'id'=pending::text;
   if order_row ?| array['address','lat','lng','distance_km'] or order_row->>'address_hidden'<>'true' then raise exception 'Legacy merchant orders leaked delivery data';end if;
 end loop;
 result:=public.fd_api('transition',jsonb_build_object('id',accepted,'status','preparing'));
 if result->>'address'<>private_address or coalesce((result->>'address_hidden')::boolean,false) then raise exception 'Accepted order did not reveal address in transition response';end if;
 perform public.fd_api('transition',jsonb_build_object('id',cancelled_after,'status','preparing'));
 perform public.fd_api('transition',jsonb_build_object('id',cancelled_after,'status','cancelled'));
 result:=public.fd_api('merchant_history','{"status":"all"}');
 select x into order_row from jsonb_array_elements(result->'orders') x where x->>'id'=cancelled_before::text;
 if order_row ? 'address' or order_row->>'address_hidden'<>'true' then raise exception 'Cancel-before-accept exposed address';end if;
 select x into order_row from jsonb_array_elements(result->'orders') x where x->>'id'=cancelled_after::text;
 if order_row->>'address'<>private_address then raise exception 'Previously accepted order lost legitimate delivery details';end if;
 -- More than the old 80-order limit, with an active order older than every history entry.
 for index_value in 1..82 loop
   insert into fly_delivery.orders(customer_id,store_id,request_id,address,payment,subtotal,fee,status)
     values(buyer,shop,gen_random_uuid(),private_address,'cash_delivery',2500,500,case when index_value%2=0 then 'delivered' else 'cancelled' end);
 end loop;
 foreach input in array array['{"status":"ready"}'::jsonb,'{"status":"assigned"}'::jsonb,'{"status":"picked_up"}'::jsonb] loop
   insert into fly_delivery.orders(customer_id,store_id,request_id,address,payment,subtotal,fee,status) values(buyer,shop,gen_random_uuid(),private_address,'cash_delivery',2500,500,input->>'status');
 end loop;
 perform set_config('request.jwt.claim.sub',buyer::text,true);
 result:=public.fd_api('customer_active_orders');
 if result->>'count'<>'5' or not exists(select 1 from jsonb_array_elements(result->'orders') x where x->>'id'=pending::text and x->>'address'=private_address) then raise exception 'History displaced older active orders';end if;
 if exists(select 1 from jsonb_array_elements(result->'orders') x where x->>'status' in ('delivered','cancelled')) then raise exception 'Terminal order remained active';end if;
 page_one:=public.fd_api('customer_order_history','{"page":0}');page_two:=public.fd_api('customer_order_history','{"page":1}');
 if page_one->>'count'<>'84' or page_one->>'pages'<>'4' or jsonb_array_length(page_one->'orders')<>25 or jsonb_array_length(page_two->'orders')<>25 then raise exception 'Customer history pagination incorrect';end if;
 if exists(select 1 from jsonb_array_elements(page_one->'orders') a join jsonb_array_elements(page_two->'orders') b on a->>'id'=b->>'id') then raise exception 'History pages overlap';end if;
 if exists(select 1 from jsonb_array_elements(page_one->'orders') x where x->>'status' not in ('delivered','cancelled')) then raise exception 'Active order entered history';end if;
 if jsonb_array_length(public.fd_api('customer_order_history','{"page":3}')->'orders')<>9 then raise exception 'Last history page incomplete';end if;
 perform set_config('request.jwt.claim.sub',other_buyer::text,true);
 if public.fd_api('customer_active_orders')->>'count'<>'0' or public.fd_api('customer_order_history',jsonb_build_object('customer_id',buyer))->>'count'<>'0' then raise exception 'Other customer accessed private orders';end if;
 perform set_config('request.jwt.claim.sub',other_merchant::text,true);
 if public.fd_api('merchant_active_orders')<>'[]'::jsonb then raise exception 'Other merchant accessed orders';end if;
 begin perform public.fd_api('customer_order_history');raise exception 'Merchant queried customer history';exception when raise_exception then if sqlerrm not like 'FD: Consulta exclusiva do cliente%' then raise;end if;end;
end;
$$;
select 'Endereço protegido até o aceite, cancelamentos, propriedade, pedidos ativos e histórico paginado verificados' as integration;
rollback;
