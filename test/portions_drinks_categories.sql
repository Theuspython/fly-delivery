-- Isolated fixtures; all accounts, menus and orders are rolled back.
begin;
do $$
declare
 admin uuid:=gen_random_uuid(); merchant uuid:=gen_random_uuid(); buyer uuid:=gen_random_uuid(); operator_id uuid:=gen_random_uuid();actor uuid;
 shop uuid:=gen_random_uuid(); portion uuid; drink uuid; assigned uuid; result jsonb; payload jsonb;
 schedule jsonb:=(select jsonb_agg(jsonb_build_object('open','00:00','close','00:00')) from generate_series(1,7));
begin
 foreach actor in array array[admin,merchant,buyer] loop insert into auth.users(id,email,email_confirmed_at) values(actor,actor::text||'@example.invalid',now());end loop;
 insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data) values(operator_id,operator_id::text||'@example.invalid',now(),'{"fly_delivery_operator":{"role":"merchant","login":"category-fixture"}}');
 insert into fly_delivery.accounts(id,role) values(admin,'admin'),(merchant,'merchant'),(buyer,'customer');
 insert into fly_delivery.customer_profiles(user_id,full_name,phone) values(buyer,'Cliente Categorias','31992345678');
 insert into fly_delivery.stores(id,owner_id,name,category,categories,address,active,is_open,fee,weekly_hours)
  values(shop,merchant,'Porções e Bebidas','Porções',array['Porções','Bebidas'],'Rua Loja 123',true,true,500,schedule);
 perform set_config('request.jwt.claim.sub',merchant::text,true);
 result:=public.fd_api('save_product',jsonb_build_object('store_id',shop,'name','Batata frita','category','Porções','price',2000));portion:=(result->>'id')::uuid;
 result:=public.fd_api('save_product',jsonb_build_object('store_id',shop,'name','Refrigerante','category','Bebidas','price',500));drink:=(result->>'id')::uuid;
 -- Older tabs may still submit the old names, but storage is always canonical.
 perform public.fd_api('save_product',jsonb_build_object('id',portion,'store_id',shop,'name','Batata frita','category','Brasileira','price',2000));
 perform public.fd_api('save_product',jsonb_build_object('id',drink,'store_id',shop,'name','Refrigerante','category','Outros','price',500));
 if (select category from fly_delivery.products where id=portion)<>'Porções' or (select category from fly_delivery.products where id=drink)<>'Bebidas' then raise exception 'Product aliases not normalized';end if;
 perform set_config('request.jwt.claim.sub',admin::text,true);
 perform public.fd_api('admin_update_store',jsonb_build_object('id',shop,'name','Porções e Bebidas','categories',jsonb_build_array('Porções','Bebidas')));
 perform public.fd_api('admin_update_store',jsonb_build_object('id',shop,'name','Porções e Bebidas','categories',jsonb_build_array('Brasileira','Outros')));
 if (select categories from fly_delivery.stores where id=shop)<>array['Bebidas','Porções'] then raise exception 'Store aliases not normalized';end if;
 if exists(select 1 from fly_delivery.products where store_id=shop and category is null) then raise exception 'Renaming lost product categories';end if;
 result:=public.fd_api('assign_operator',jsonb_build_object('user_id',operator_id,'role','merchant','login','category-fixture','request_id',gen_random_uuid(),'name','Nova loja','categories',jsonb_build_array('Marmitex','Porções','Bebidas')));assigned:=(result->>'id')::uuid;
 if not exists(select 1 from fly_delivery.stores where id=assigned and categories @> array['Marmitex','Porções','Bebidas']) then raise exception 'Provisioning rejected new categories';end if;
 begin perform public.fd_api('admin_update_store',jsonb_build_object('id',shop,'name','Teste','categories',jsonb_build_array('Inválida')));raise exception 'Invalid category accepted';exception when raise_exception then if sqlerrm not like 'FD: Selecione pelo menos%' then raise;end if;end;
 perform set_config('request.jwt.claim.sub',buyer::text,true);
 if not exists(select 1 from jsonb_array_elements(public.fd_api('catalog')) s cross join jsonb_array_elements(s->'products') p where s->>'id'=shop::text and p->>'id'=portion::text and p->>'category'='Porções') then raise exception 'Catalog missing portions';end if;
 payload:=jsonb_build_object('store_id',shop,'request_id',gen_random_uuid(),'address','Rua Cliente 10 - Centro','payment','cash_delivery','fee',500,'items',jsonb_build_array(jsonb_build_object('id',portion,'price',2000,'quantity',1),jsonb_build_object('id',drink,'price',500,'quantity',2)));
 result:=public.fd_api('place',payload);
 if result->>'subtotal'<>'3000' or result->>'fee'<>'500' or jsonb_array_length(result->'items')<>2 then raise exception 'Checkout changed IDs, prices or quantities';end if;
 if exists(select 1 from fly_delivery.stores where category in ('Brasileira','Outros') or categories && array['Brasileira','Outros'])
   or exists(select 1 from fly_delivery.products where category in ('Brasileira','Outros')) then raise exception 'Old categories remain';end if;
end;
$$;
select 'Porções/Bebidas: cadastro, edição, compatibilidade, catálogo, vínculos e checkout verificados' as integration;
rollback;
