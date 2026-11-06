-- Size, note and price fixtures are isolated and rolled back.
begin;
do $$
declare
  merchant uuid:=gen_random_uuid(); buyer uuid:=gen_random_uuid(); other_buyer uuid:=gen_random_uuid(); actor uuid;
  shop uuid:=gen_random_uuid(); pizza uuid; fixed_product uuid; extra uuid:=gen_random_uuid(); request uuid:=gen_random_uuid();
  sizes jsonb:='[{"name":"P","price":4000},{"name":"M","price":5500},{"name":"G","price":7000}]';
  result jsonb; input jsonb; bad jsonb; order_id_value uuid; single_order uuid;
  note_text text:=E'Sem cebola.\nCortar em oito pedaços.';
  schedule jsonb:=(select jsonb_agg(jsonb_build_object('open','00:00','close','00:00')) from generate_series(1,7));
begin
  foreach actor in array array[merchant,buyer,other_buyer] loop
    insert into auth.users(id,email,email_confirmed_at) values(actor,actor::text||'@example.invalid',now());
  end loop;
  insert into fly_delivery.accounts(id,role) values(merchant,'merchant'),(buyer,'customer'),(other_buyer,'customer');
  insert into fly_delivery.customer_profiles(user_id,full_name,phone) values(buyer,'Cliente Tamanhos','31992345678');
  insert into fly_delivery.stores(id,owner_id,name,category,categories,address,active,is_open,fee,weekly_hours)
    values(shop,merchant,'Pizzaria Tamanhos','Pizza',array['Pizza'],'Rua Loja 123',true,true,500,schedule);
  perform set_config('request.jwt.claim.sub',merchant::text,true);
  result:=public.fd_api('save_product',jsonb_build_object('store_id',shop,'name','Pizza Calabresa','price',1,'sizes',sizes,'options',jsonb_build_array(jsonb_build_object('id',extra,'name','Borda','price',500))));
  pizza:=(result->>'id')::uuid;
  if result->'sizes'<>sizes or result->>'price'<>'4000' then raise exception 'Sizes or minimum price not stored correctly'; end if;
  perform public.fd_api('save_product',jsonb_build_object('store_id',shop,'id',pizza,'name','Pizza Calabresa','price',99));
  if (select p.sizes from fly_delivery.products p where p.id=pizza)<>sizes or (select p.price from fly_delivery.products p where p.id=pizza)<>4000 then raise exception 'Legacy edit lost sizes'; end if;
  foreach bad in array array['null'::jsonb,'{}'::jsonb,'[{"name":"GG","price":1000}]'::jsonb,'[{"name":"P","price":0}]'::jsonb,'[{"name":"P","price":1.5}]'::jsonb,'[{"name":"P","price":1000},{"name":"P","price":2000}]'::jsonb] loop
    begin
      perform public.fd_api('save_product',jsonb_build_object('id',pizza,'store_id',shop,'name','Pizza','price',1000,'sizes',bad));
      raise exception 'Invalid sizes accepted: %',bad;
    exception when raise_exception then if sqlerrm not like 'FD: Revise os tamanhos%' then raise; end if; end;
  end loop;
  if not exists(select 1 from jsonb_array_elements(public.fd_api('catalog')) s cross join jsonb_array_elements(s->'products') p where p->>'id'=pizza::text and p->'sizes'=sizes) then raise exception 'Catalog missing sizes'; end if;
  result:=public.fd_api('save_product',jsonb_build_object('store_id',shop,'name','Refrigerante','price',1000));fixed_product:=(result->>'id')::uuid;
  perform set_config('request.jwt.claim.sub',buyer::text,true);
  input:=jsonb_build_object('store_id',shop,'request_id',request,'address','Rua Cliente 10 - Centro','payment','cash_delivery','fee',500,'note',note_text,'items',jsonb_build_array(
    jsonb_build_object('id',pizza,'size','P','price',4000,'quantity',1),
    jsonb_build_object('id',pizza,'size','M','price',5500,'quantity',2,'options',jsonb_build_array(jsonb_build_object('id',extra,'price',500))),
    jsonb_build_object('id',pizza,'size','G','price',7000,'quantity',1)));
  result:=public.fd_api('place',input);order_id_value:=(result->>'id')::uuid;
  if result->>'subtotal'<>'23000' or result->>'fee'<>'500' or result->>'note'<>note_text or jsonb_array_length(result->'items')<>3 then raise exception 'Sizes, totals or note incorrect: %',result; end if;
  if not exists(select 1 from jsonb_array_elements(result->'items') i where i->>'size'='M' and i->>'price'='6000' and i->>'quantity'='2') then raise exception 'Size price did not include options'; end if;
  if public.fd_api('place',input)->>'id'<>order_id_value::text then raise exception 'Idempotency failed'; end if;
  result:=public.fd_api('place',input||jsonb_build_object('request_id',gen_random_uuid(),'items',jsonb_build_array(jsonb_build_object('id',pizza,'size','M','price',5500,'quantity',1))));single_order:=(result->>'id')::uuid;
  if (result->>'subtotal')::integer+(result->>'fee')::integer<>6000 then raise exception '55 plus 5 delivery did not equal 60'; end if;
  foreach bad in array array[jsonb_build_object('id',pizza,'price',4000,'quantity',1),jsonb_build_object('id',pizza,'size','GG','price',4000,'quantity',1),jsonb_build_object('id',pizza,'size','M','price',1,'quantity',1),jsonb_build_object('id',fixed_product,'size','P','price',1000,'quantity',1)] loop
    begin
      perform public.fd_api('place',input||jsonb_build_object('request_id',gen_random_uuid(),'items',jsonb_build_array(bad)));
      raise exception 'Invalid size or quote accepted: %',bad;
    exception when raise_exception then if sqlerrm not like 'FD:%' then raise; end if; end;
  end loop;
  foreach bad in array array[to_jsonb(repeat('x',501)),'{}'::jsonb,'null'::jsonb] loop
    begin
      perform public.fd_api('place',input||jsonb_build_object('request_id',gen_random_uuid(),'note',bad));
      raise exception 'Invalid order note accepted';
    exception when raise_exception then if sqlerrm not like 'FD: A observação%' then raise; end if; end;
  end loop;
  perform set_config('request.jwt.claim.sub',other_buyer::text,true);
  if public.fd_api('orders','{"view":"customer"}')<>'[]'::jsonb then raise exception 'Other buyer read order notes'; end if;
  perform set_config('request.jwt.claim.sub',merchant::text,true);
  if not exists(select 1 from jsonb_array_elements(public.fd_api('merchant_active_orders')) o where o->>'id'=order_id_value::text and o->>'note'=note_text) then raise exception 'Merchant cannot read note'; end if;
  perform public.fd_api('save_product',jsonb_build_object('store_id',shop,'id',pizza,'name','Nova Pizza','price',1,'sizes','[{"name":"M","price":6000},{"name":"G","price":8000}]'::jsonb,'options','[]'::jsonb));
  perform set_config('request.jwt.claim.sub',buyer::text,true);
  result:=public.fd_api('orders','{"view":"customer"}');
  if not exists(select 1 from jsonb_array_elements(result) o cross join jsonb_array_elements(o->'items') i where o->>'id'=order_id_value::text and o->>'note'=note_text and i->>'size'='P' and i->>'name'='Pizza Calabresa' and i->>'price'='4000') then raise exception 'Historical size, price or note changed'; end if;
end;
$$;
select 'Tamanhos e observações: preços, opcionais, catálogo, validação, acesso, entrega e histórico verificados' as integration;
rollback;
