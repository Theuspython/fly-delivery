-- Store management fixtures are isolated and rolled back.
begin;
do $$
declare
  admin uuid:=gen_random_uuid();
  merchant uuid:=gen_random_uuid();
  buyer uuid:=gen_random_uuid();
  multi_owner uuid:=gen_random_uuid();
  actor uuid;
  shop uuid:=gen_random_uuid();
  archived uuid:=gen_random_uuid();
  remaining uuid:=gen_random_uuid();
  order_id uuid:=gen_random_uuid();
  result jsonb;
  schedule jsonb:=(select jsonb_agg(jsonb_build_object('open','00:00','close','00:00')) from generate_series(1,7));
begin
  foreach actor in array array[admin,merchant,buyer,multi_owner] loop
    insert into auth.users(id,email,email_confirmed_at) values(actor,actor::text || '@example.invalid',now());
  end loop;
  insert into fly_delivery.accounts(id,role) values(admin,'admin'),(merchant,'merchant'),(buyer,'customer'),(multi_owner,'merchant');
  insert into fly_delivery.customer_profiles(user_id,full_name,phone) values(buyer,'Cliente Histórico','31994551111');
  insert into fly_delivery.stores(id,owner_id,name,category,categories,active,is_open,address,weekly_hours)
    values(shop,merchant,'Loja Original','Pizza',array['Pizza'],true,true,'Rua Loja 10',schedule),
      (archived,multi_owner,'Loja para excluir','Pizza',array['Pizza'],true,true,'Rua Outra 20',schedule),
      (remaining,multi_owner,'Loja mantida','Pizza',array['Pizza'],true,true,'Rua Outra 30',schedule);
  perform set_config('request.jwt.claim.sub',buyer::text,true);
  begin
    perform public.fd_api('admin_update_store',jsonb_build_object('id',shop,'name','Inválido','categories',array['Pizza']));
    raise exception 'Buyer can edit stores';
  exception when raise_exception then if sqlerrm not like 'FD: Acesso restrito%' then raise; end if; end;
  begin
    perform public.fd_api('admin_delete_store',jsonb_build_object('id',shop));
    raise exception 'Buyer can delete stores';
  exception when raise_exception then if sqlerrm not like 'FD: Acesso restrito%' then raise; end if; end;
  perform set_config('request.jwt.claim.sub',admin::text,true);
  perform public.fd_api('admin_update_store',jsonb_build_object('id',shop,'name','Loja Editada','categories',array['Telecerveja','Marmitex']));
  if not exists(select 1 from jsonb_array_elements(public.fd_api('managed_stores')) s where s->>'id'=shop::text and s->>'name'='Loja Editada' and s->'categories' @> '["Telecerveja","Marmitex"]'::jsonb) then raise exception 'Edited store absent from admin'; end if;
  if not exists(select 1 from jsonb_array_elements(public.fd_api('catalog')) s where s->>'id'=shop::text and s->>'name'='Loja Editada') then raise exception 'Storefront did not reflect edit'; end if;
  begin
    perform public.fd_api('admin_update_store',jsonb_build_object('id',shop,'name','Loja','categories',array['Inválida']));
    raise exception 'Invalid category accepted';
  exception when raise_exception then if sqlerrm not like 'FD: Selecione pelo menos%' then raise; end if; end;
  insert into fly_delivery.orders(id,customer_id,store_id,request_id,address,payment,subtotal,fee)
    values(order_id,buyer,shop,gen_random_uuid(),'Rua Cliente, 10 - Centro','cash_delivery',1500,300);
  begin
    perform public.fd_api('admin_delete_store',jsonb_build_object('id',shop));
    raise exception 'Store with active order deleted';
  exception when raise_exception then if sqlerrm not like 'FD: Finalize ou cancele%' then raise; end if; end;
  update fly_delivery.orders set status='delivered' where id=order_id;
  perform public.fd_api('admin_delete_store',jsonb_build_object('id',shop));
  if exists(select 1 from jsonb_array_elements(public.fd_api('managed_stores')) s where s->>'id'=shop::text) then raise exception 'Deleted store remains in admin'; end if;
  if exists(select 1 from jsonb_array_elements(public.fd_api('catalog')) s where s->>'id'=shop::text) then raise exception 'Deleted store remains in storefront'; end if;
  if (select enabled from fly_delivery.accounts where id=merchant) then raise exception 'Deleted store login still enabled'; end if;
  perform set_config('request.jwt.claim.sub',buyer::text,true);
  result:=public.fd_api('orders','{"view":"customer"}');
  if result->0->>'id'<>order_id::text or result->0->>'status'<>'delivered' then raise exception 'Completed order history lost'; end if;
  begin
    perform public.fd_api('place',jsonb_build_object('store_id',shop,'request_id',gen_random_uuid()));
    raise exception 'Deleted store accepts new orders';
  exception when raise_exception then if sqlerrm not like 'FD: A loja não está aceitando%' then raise; end if; end;
  perform set_config('request.jwt.claim.sub',merchant::text,true);
  begin
    perform public.fd_api('session');
    raise exception 'Deleted store session remains available';
  exception when raise_exception then if sqlerrm not like 'FD: Acesso indisponível%' then raise; end if; end;
  perform set_config('request.jwt.claim.sub',admin::text,true);
  perform public.fd_api('admin_delete_store',jsonb_build_object('id',archived));
  if not (select enabled from fly_delivery.accounts where id=multi_owner) then raise exception 'Other store lost its account'; end if;
  perform set_config('request.jwt.claim.sub',multi_owner::text,true);
  if jsonb_array_length(public.fd_api('managed_stores'))<>1 then raise exception 'Merchant list includes deleted store'; end if;
  begin
    perform public.fd_api('save_product',jsonb_build_object('store_id',archived,'name','Produto','price',1000));
    raise exception 'Old session can change deleted store';
  exception when raise_exception then if sqlerrm not like 'FD: Você não tem acesso%' then raise; end if; end;
  begin
    perform public.fd_api('save_store_profile',jsonb_build_object('id',archived,'address','Rua Outra 20','fee',0,'eta',30,'weekly_hours',schedule,'active',true));
    raise exception 'Old session can reopen deleted store';
  exception when raise_exception then if sqlerrm not like 'FD: Você não tem acesso%' then raise; end if; end;
  if fly_delivery.can_upload(archived::text || '/' || gen_random_uuid()::text || '.jpg') then raise exception 'Deleted store accepts photos'; end if;
end;
$$;
select 'Administração: edição, exclusão, pedidos em andamento, histórico e bloqueio de acesso verificados' as integration;
rollback;
