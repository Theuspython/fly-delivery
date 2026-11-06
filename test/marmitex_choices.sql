-- All accounts, menu changes and orders are temporary and rolled back.
begin;
do $$
declare
 merchant uuid:=gen_random_uuid(); other_merchant uuid:=gen_random_uuid(); buyer uuid:=gen_random_uuid(); actor uuid;
 shop uuid:=gen_random_uuid(); meal uuid; extra uuid:=gen_random_uuid(); meat uuid:=gen_random_uuid(); rice uuid:=gen_random_uuid();
 beef uuid:=gen_random_uuid(); chicken uuid:=gen_random_uuid(); white_rice uuid:=gen_random_uuid(); special_rice uuid:=gen_random_uuid();
 groups jsonb; selection jsonb; payload jsonb; result jsonb; bad jsonb; order_id_value uuid;
 sizes jsonb:='[{"name":"P","price":1500},{"name":"M","price":2000},{"name":"G","price":2500}]';
 schedule jsonb:=(select jsonb_agg(jsonb_build_object('open','00:00','close','00:00')) from generate_series(1,7));
begin
 foreach actor in array array[merchant,other_merchant,buyer] loop
  insert into auth.users(id,email,email_confirmed_at) values(actor,actor::text||'@example.invalid',now());
 end loop;
 insert into fly_delivery.accounts(id,role) values(merchant,'merchant'),(other_merchant,'merchant'),(buyer,'customer');
 insert into fly_delivery.customer_profiles(user_id,full_name,phone) values(buyer,'Cliente Marmita','31992345678');
 insert into fly_delivery.stores(id,owner_id,name,category,categories,address,active,is_open,fee,weekly_hours)
  values(shop,merchant,'Marmitex Teste','Marmitex',array['Marmitex','Pizza'],'Rua Loja 123',true,true,500,schedule);
 groups:=jsonb_build_array(jsonb_build_object('id',meat,'name','Tipo de carne','required',true,'limits','{"P":1,"M":1,"G":2}'::jsonb,'options',jsonb_build_array(jsonb_build_object('id',beef,'name','Bife'),jsonb_build_object('id',chicken,'name','Frango'))),jsonb_build_object('id',rice,'name','Tipo de arroz','required',false,'limits','{"G":1}'::jsonb,'options',jsonb_build_array(jsonb_build_object('id',white_rice,'name','Arroz branco'),jsonb_build_object('id',special_rice,'name','Carreteiro'))));
 perform set_config('request.jwt.claim.sub',merchant::text,true);
 result:=public.fd_api('save_product',jsonb_build_object('store_id',shop,'name','Marmita','category','Marmitex','price',1,'sizes',sizes,'meal_choices',groups,'options',jsonb_build_array(jsonb_build_object('id',extra,'name','Ovo extra','price',500))));meal:=(result->>'id')::uuid;
 if not exists(select 1 from jsonb_array_elements(public.fd_api('catalog')) s cross join jsonb_array_elements(s->'products') p where p->>'id'=meal::text and p->'meal_choices'=groups) then raise exception 'Catalog missing assembly choices';end if;
 if not exists(select 1 from jsonb_array_elements(public.fd_api('managed_stores')) s cross join jsonb_array_elements(s->'products') p where p->>'id'=meal::text and p->'meal_choices'=groups) then raise exception 'Merchant edit missing choices';end if;
 perform public.fd_api('save_product',jsonb_build_object('store_id',shop,'id',meal,'name','Marmita','price',99));
 if (select meal_choices from fly_delivery.products where id=meal)<>groups then raise exception 'Legacy edit erased choices';end if;
 foreach bad in array array['null'::jsonb,'{}'::jsonb,jsonb_set(groups,'{0,limits}','{"GG":1}'),jsonb_set(groups,'{0,limits}','{"P":3}'),jsonb_set(groups,'{0,limits}','{"P":0}'),jsonb_set(groups,'{0,limits}','{"P":1.5}'),jsonb_set(groups,'{0,options,0,price}','500'),jsonb_set(groups,'{0,options,1,name}','"Bife"')] loop
  begin perform public.fd_api('save_product',jsonb_build_object('store_id',shop,'id',meal,'name','Marmita','price',1,'meal_choices',bad));raise exception 'Invalid group configuration accepted';exception when raise_exception then if sqlerrm not like 'FD: Revise os grupos%' then raise;end if;end;
 end loop;
 begin perform public.fd_api('save_product',jsonb_build_object('store_id',shop,'id',meal,'name','Marmita','category','Pizza','price',1,'meal_choices',groups));raise exception 'Non-marmitex accepted choices';exception when raise_exception then if sqlerrm not like 'FD: Revise os grupos%' then raise;end if;end;
 perform set_config('request.jwt.claim.sub',other_merchant::text,true);
 begin perform public.fd_api('save_product',jsonb_build_object('store_id',shop,'id',meal,'name','Changed','price',1,'meal_choices','[]'::jsonb));raise exception 'Other merchant edited product';exception when raise_exception then if sqlerrm not like 'FD: Você não tem acesso%' then raise;end if;end;
 perform set_config('request.jwt.claim.sub',buyer::text,true);
 selection:=jsonb_build_array(jsonb_build_object('group_id',meat,'option_ids',jsonb_build_array(beef,chicken)),jsonb_build_object('group_id',rice,'option_ids',jsonb_build_array(white_rice)));
 payload:=jsonb_build_object('store_id',shop,'request_id',gen_random_uuid(),'address','Rua Cliente 10 - Centro','payment','cash_delivery','fee',500,'items',jsonb_build_array(
  jsonb_build_object('id',meal,'quantity',2,'price',2500,'size','G','meal_choices',selection,'options',jsonb_build_array(jsonb_build_object('id',extra,'price',500))),
  jsonb_build_object('id',meal,'quantity',1,'price',2500,'size','G','meal_choices',jsonb_build_array(jsonb_build_object('group_id',meat,'option_ids',jsonb_build_array(chicken)),jsonb_build_object('group_id',rice,'option_ids',jsonb_build_array(special_rice)))),
  jsonb_build_object('id',meal,'quantity',1,'price',1500,'size','P','meal_choices',jsonb_build_array(jsonb_build_object('group_id',meat,'option_ids',jsonb_build_array(beef))))));
 result:=public.fd_api('place',payload);order_id_value:=(result->>'id')::uuid;
 if result->>'subtotal'<>'10000' or result->>'fee'<>'500' or jsonb_array_length(result->'items')<>3 then raise exception 'Assembly changed price or merged distinct combinations';end if;
 if not exists(select 1 from jsonb_array_elements(result->'items') i where i->>'price'='3000' and i->>'quantity'='2' and jsonb_array_length(i->'meal_choices')=2) then raise exception 'Paid options or free snapshots lost';end if;
 -- Required selection, size-specific availability, duplicates, tampered options and prices are rejected.
 foreach bad in array array['[]'::jsonb,'null'::jsonb,jsonb_build_array(jsonb_build_object('group_id',meat,'option_ids','[]'::jsonb)),jsonb_build_array(jsonb_build_object('group_id',gen_random_uuid(),'option_ids',jsonb_build_array(beef))),jsonb_build_array(jsonb_build_object('group_id',meat,'option_ids',jsonb_build_array(gen_random_uuid()))),jsonb_build_array(jsonb_build_object('group_id',meat,'option_ids',jsonb_build_array(beef,beef))),jsonb_build_array(jsonb_build_object('group_id',meat,'option_ids',jsonb_build_array(beef),'price',100)),selection||selection] loop
  begin perform public.fd_api('place',payload||jsonb_build_object('request_id',gen_random_uuid(),'items',jsonb_build_array(jsonb_build_object('id',meal,'quantity',1,'price',2500,'size','G','meal_choices',bad))));raise exception 'Invalid assembly accepted: %',bad;exception when raise_exception then if sqlerrm not like 'FD: Revise as escolhas%' then raise;end if;end;
 end loop;
 begin perform public.fd_api('place',payload||jsonb_build_object('request_id',gen_random_uuid(),'items',jsonb_build_array(jsonb_build_object('id',meal,'quantity',1,'price',1500,'size','P','meal_choices',selection))));raise exception 'P accepted G-only rice or extra meat';exception when raise_exception then if sqlerrm not like 'FD: Revise as escolhas%' then raise;end if;end;
 perform set_config('request.jwt.claim.sub',merchant::text,true);
 result:=public.fd_api('merchant_active_orders');
 if not exists(select 1 from jsonb_array_elements(result) o where o->>'id'=order_id_value::text and o->>'address_hidden'='true' and not(o ? 'address') and jsonb_array_length(o->'items')=3) then raise exception 'Merchant choices lost or address leaked';end if;
 perform public.fd_api('transition',jsonb_build_object('id',order_id_value,'status','preparing'));
 groups:=jsonb_set(groups,'{0,name}','"Nova carne"');groups:=jsonb_set(groups,'{0,options,0,name}','"Novo bife"');
 perform public.fd_api('save_product',jsonb_build_object('store_id',shop,'id',meal,'name','Marmita atualizada','price',1,'meal_choices',groups));
 perform set_config('request.jwt.claim.sub',buyer::text,true);
 result:=public.fd_api('place',payload);
 if result->>'id'<>order_id_value::text or not exists(select 1 from jsonb_array_elements(result->'items') i cross join jsonb_array_elements(i->'meal_choices') g where g->>'name'='Tipo de carne' and g->'options' @> jsonb_build_array(jsonb_build_object('name','Bife'))) then raise exception 'Idempotency or historical assembly snapshot changed';end if;
 -- Fixed-size Marmitex accepts a group using the empty size key.
 perform set_config('request.jwt.claim.sub',merchant::text,true);
 groups:=jsonb_set(groups,'{0,limits}','{"":1}');groups:=jsonb_build_array(groups->0);
 perform public.fd_api('save_product',jsonb_build_object('store_id',shop,'name','Marmita única','category','Marmitex','price',1800,'meal_choices',groups));
end;
$$;
select 'Marmitex: grupos por tamanho, montagem grátis, preços, variantes, autorização e snapshots verificados' as integration;
rollback;
