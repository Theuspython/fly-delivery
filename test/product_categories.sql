-- Products, orders and test accounts are rolled back after these assertions.
begin;
do $$
declare
  merchant uuid:=gen_random_uuid();
  other_merchant uuid:=gen_random_uuid();
  buyer uuid:=gen_random_uuid();
  admin uuid:=gen_random_uuid();
  actor uuid;
  shop uuid:=gen_random_uuid();
  single_shop uuid:=gen_random_uuid();
  acai uuid;
  burger uuid;
  marmitex uuid;
  result jsonb;
  menu jsonb;
  schedule jsonb:=(select jsonb_agg(jsonb_build_object('open','00:00','close','00:00')) from generate_series(1,7));
begin
  foreach actor in array array[merchant,other_merchant,buyer,admin] loop
    insert into auth.users(id,email,email_confirmed_at) values(actor,actor::text || '@example.invalid',now());
  end loop;
  insert into fly_delivery.accounts(id,role) values(merchant,'merchant'),(other_merchant,'merchant'),(buyer,'customer'),(admin,'admin');
  insert into fly_delivery.customer_profiles(user_id,full_name,phone) values(buyer,'Cliente Categorias','31993456666');
  insert into fly_delivery.stores(id,owner_id,name,category,categories,address,active,is_open,weekly_hours)
    values(shop,merchant,'Açaí e Hambúrguer','Açaí',array['Açaí','Hambúrguer'],'Rua Loja 123',true,true,schedule),
      (single_shop,other_merchant,'Marmitex','Marmitex',array['Marmitex'],'Rua Loja 456',true,true,schedule);
  perform set_config('request.jwt.claim.sub',merchant::text,true);
  result:=public.fd_api('save_product',jsonb_build_object('store_id',shop,'name','Açaí 500 ml','category','Açaí','price',1000));
  acai:=(result->>'id')::uuid;
  result:=public.fd_api('save_product',jsonb_build_object('store_id',shop,'name','Hambúrguer','category','Hambúrguer','price',1500));
  burger:=(result->>'id')::uuid;
  begin
    perform public.fd_api('save_product',jsonb_build_object('store_id',shop,'name','Pizza','category','Pizza','price',2000));
    raise exception 'Product accepted a category outside the store';
  exception when raise_exception then if sqlerrm not like 'FD: Selecione uma das categorias%' then raise; end if; end;
  begin
    perform public.fd_api('save_product',jsonb_build_object('store_id',shop,'name','Sem categoria','price',2000));
    raise exception 'New multi-category product accepted without category';
  exception when raise_exception then if sqlerrm not like 'FD: Selecione uma das categorias%' then raise; end if; end;
  perform public.fd_api('save_product',jsonb_build_object('id',burger,'store_id',shop,'name','Hambúrguer','price',1700));
  if (select category from fly_delivery.products where id=burger)<>'Hambúrguer' then raise exception 'Legacy edit lost category'; end if;
  begin
    update fly_delivery.products set category='Pizza' where id=burger;
    raise exception 'Invalid direct product update bypassed validation';
  exception when raise_exception then if sqlerrm not like 'FD: A categoria do produto%' then raise; end if; end;
  perform set_config('request.jwt.claim.sub',other_merchant::text,true);
  result:=public.fd_api('save_product',jsonb_build_object('store_id',single_shop,'name','Marmita','price',2000));
  marmitex:=(result->>'id')::uuid;
  if (select category from fly_delivery.products where id=marmitex)<>'Marmitex' then raise exception 'Single category default missing'; end if;
  begin
    perform public.fd_api('save_product',jsonb_build_object('id',burger,'store_id',shop,'name','Outro','category','Açaí','price',1));
    raise exception 'Other merchant edited product category';
  exception when raise_exception then if sqlerrm not like 'FD: Você não tem acesso%' then raise; end if; end;
  select s into menu from jsonb_array_elements(public.fd_api('catalog')) s where s->>'id'=shop::text;
  if not exists(select 1 from jsonb_array_elements(menu->'products') p where p->>'id'=acai::text and p->>'category'='Açaí') or
     not exists(select 1 from jsonb_array_elements(menu->'products') p where p->>'id'=burger::text and p->>'category'='Hambúrguer') then raise exception 'Catalog missing product categories'; end if;
  perform set_config('request.jwt.claim.sub',buyer::text,true);
  result:=public.fd_api('place',jsonb_build_object('store_id',shop,'request_id',gen_random_uuid(),'address','Rua Cliente, 10 - Centro','payment','cash_delivery','fee',0,
    'items',jsonb_build_array(jsonb_build_object('id',acai,'quantity',1,'price',1000),jsonb_build_object('id',burger,'quantity',2,'price',1700))));
  if result->>'subtotal'<>'4400' then raise exception 'Mixed-category cart total incorrect'; end if;
  perform set_config('request.jwt.claim.sub',admin::text,true);
  perform public.fd_api('admin_update_store',jsonb_build_object('id',shop,'name','Açaí','categories',array['Açaí']));
  if (select category from fly_delivery.products where id=acai)<>'Açaí' or
    (select category from fly_delivery.products where id=burger) is not null then raise exception 'Removed store category was not handled safely'; end if;
  if (select count(*) from fly_delivery.products where store_id=shop)<>2 then raise exception 'Store edit deleted products'; end if;
end;
$$;
select 'Categorias dos produtos: cadastro, edição, catálogo, permissões, carrinho e alteração de categorias da loja verificados' as integration;
rollback;
