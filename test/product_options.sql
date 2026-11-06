-- All fixtures and orders are isolated and rolled back.
begin;
do $$
declare
  merchant uuid:=gen_random_uuid(); buyer uuid:=gen_random_uuid(); other_actor uuid:=gen_random_uuid();
  actor uuid; shop uuid:=gen_random_uuid(); product uuid; egg uuid:=gen_random_uuid(); beef uuid:=gen_random_uuid();
  request uuid:=gen_random_uuid(); result jsonb; input jsonb; bad jsonb; options jsonb; placed_order uuid;
  schedule jsonb:=(select jsonb_agg(jsonb_build_object('open','00:00','close','00:00')) from generate_series(1,7));
begin
  foreach actor in array array[merchant,buyer,other_actor] loop
    insert into auth.users(id,email,email_confirmed_at) values(actor,actor::text||'@example.invalid',now());
  end loop;
  insert into fly_delivery.accounts(id,role) values(merchant,'merchant'),(buyer,'customer'),(other_actor,'merchant');
  insert into fly_delivery.customer_profiles(user_id,full_name,phone) values(buyer,'Cliente Opcionais','31992345678');
  insert into fly_delivery.stores(id,owner_id,name,category,categories,address,active,is_open,weekly_hours)
    values(shop,merchant,'Loja Opcionais','Hambúrguer',array['Hambúrguer'],'Rua Loja 123',true,true,schedule);
  options:=jsonb_build_array(jsonb_build_object('id',egg,'name','Ovo','price',200),jsonb_build_object('id',beef,'name','Mais bife','price',500));
  perform set_config('request.jwt.claim.sub',merchant::text,true);
  result:=public.fd_api('save_product',jsonb_build_object('store_id',shop,'name','Hambúrguer','price',1000,'options',options));
  product:=(result->>'id')::uuid;
  if result->'options'<>options then raise exception 'Option prices/names lost'; end if;
  perform public.fd_api('save_product',jsonb_build_object('id',product,'store_id',shop,'name','Hambúrguer','price',1000));
  if (select p.options from fly_delivery.products p where p.id=product)<>options then raise exception 'Legacy edit lost options'; end if;
  foreach bad in array array['null'::jsonb,'{}'::jsonb,options||options,jsonb_build_array(jsonb_build_object('id',egg,'name','Ovo','price',-1)),jsonb_build_array(jsonb_build_object('id',egg,'name','','price',200)),jsonb_build_array(jsonb_build_object('id',egg,'name','Ovo','price',0.5))] loop
    begin
      perform public.fd_api('save_product',jsonb_build_object('id',product,'store_id',shop,'name','Hambúrguer','price',1000,'options',bad));
      raise exception 'Invalid product options accepted: %',bad;
    exception when raise_exception then if sqlerrm not like 'FD: Revise os nomes%' then raise; end if; end;
  end loop;
  if not exists(select 1 from jsonb_array_elements(public.fd_api('catalog')) s cross join jsonb_array_elements(s->'products') p where p->>'id'=product::text and p->'options'=options) then raise exception 'Catalog options absent'; end if;
  if not exists(select 1 from jsonb_array_elements(public.fd_api('managed_stores')) s cross join jsonb_array_elements(s->'products') p where p->>'id'=product::text and p->'options'=options) then raise exception 'Merchant options absent'; end if;
  perform set_config('request.jwt.claim.sub',other_actor::text,true);
  begin
    perform public.fd_api('save_product',jsonb_build_object('id',product,'store_id',shop,'name','Ataque','price',1,'options','[]'::jsonb));
    raise exception 'Other merchant changed options';
  exception when raise_exception then if sqlerrm not like 'FD: Você não tem acesso%' then raise; end if; end;
  perform set_config('request.jwt.claim.sub',buyer::text,true);
  input:=jsonb_build_object('store_id',shop,'request_id',request,'address','Rua Cliente 10 - Centro','payment','cash_delivery','fee',0,'items',jsonb_build_array(
    jsonb_build_object('id',product,'price',1000,'quantity',1),
    jsonb_build_object('id',product,'price',1000,'quantity',2,'options',jsonb_build_array(jsonb_build_object('id',egg,'price',200))),
    jsonb_build_object('id',product,'price',1000,'quantity',1,'options',jsonb_build_array(jsonb_build_object('id',egg,'price',200),jsonb_build_object('id',beef,'price',500)))));
  result:=public.fd_api('place',input);placed_order:=(result->>'id')::uuid;
  if result->>'subtotal'<>'5100' or jsonb_array_length(result->'items')<>3 then raise exception 'Variants or option total incorrect: %',result; end if;
  if (select sum(i.price*i.quantity) from fly_delivery.order_items i where i.order_id=placed_order)<>5100 then raise exception 'Stored option total incorrect'; end if;
  if public.fd_api('place',input)->>'id'<>placed_order::text then raise exception 'Idempotency broken'; end if;
  foreach bad in array array[
    jsonb_build_array(jsonb_build_object('id',egg,'price',1)),
    jsonb_build_array(jsonb_build_object('id',egg)),
    jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'price',200)),
    jsonb_build_array(jsonb_build_object('id',egg,'price',200),jsonb_build_object('id',egg,'price',200)),
    'null'::jsonb,'{}'::jsonb
  ] loop
    begin
      perform public.fd_api('place',input||jsonb_build_object('request_id',gen_random_uuid(),'items',jsonb_build_array(jsonb_build_object('id',product,'price',1000,'quantity',1,'options',bad))));
      raise exception 'Invalid selected option accepted: %',bad;
    exception when raise_exception then if sqlerrm not like 'FD:%' then raise; end if; end;
  end loop;
  begin
    perform public.fd_api('place',input||jsonb_build_object('request_id',gen_random_uuid(),'items',jsonb_build_array(input->'items'->2,input->'items'->2)));
    raise exception 'Duplicate variant accepted';
  exception when raise_exception then if sqlerrm not like 'FD: Revise os itens%' then raise; end if; end;
  perform set_config('request.jwt.claim.sub',merchant::text,true);
  result:=public.fd_api('orders','{"view":"merchant"}');
  if not exists(select 1 from jsonb_array_elements(result) o cross join jsonb_array_elements(o->'items') i where o->>'id'=placed_order::text and jsonb_array_length(i->'options')=2) then raise exception 'Merchant cannot see chosen options'; end if;
  perform public.fd_api('save_product',jsonb_build_object('id',product,'store_id',shop,'name','Produto alterado','price',1500,'options','[]'::jsonb));
  perform set_config('request.jwt.claim.sub',buyer::text,true);
  result:=public.fd_api('orders','{"view":"customer"}');
  if not exists(select 1 from jsonb_array_elements(result) o cross join jsonb_array_elements(o->'items') i cross join jsonb_array_elements(i->'options') v where o->>'id'=placed_order::text and v->>'name'='Ovo' and v->>'price'='200' and i->>'name'='Hambúrguer') then raise exception 'Historical options changed after editing product'; end if;
  begin
    perform public.fd_api('place',input||jsonb_build_object('request_id',gen_random_uuid()));
    raise exception 'Stale prices accepted';
  exception when raise_exception then if sqlerrm not like 'FD: Os preços mudaram%' then raise; end if; end;
end;
$$;
select 'Opcionais: cadastro, permissões, combinações, preços, duplicidade, catálogo e histórico verificados' as integration;
rollback;
