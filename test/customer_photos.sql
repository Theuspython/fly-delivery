-- Metadata-only storage fixtures and orders are rolled back; no files are uploaded.
begin;
do $$
declare
  buyer uuid:=gen_random_uuid();
  other_buyer uuid:=gen_random_uuid();
  merchant uuid:=gen_random_uuid();
  other_merchant uuid:=gen_random_uuid();
  actor uuid;
  shop uuid:=gen_random_uuid();
  order_id uuid:=gen_random_uuid();
  photo text:=buyer::text || '/' || gen_random_uuid()::text || '.jpg';
  old_photo text:=buyer::text || '/' || gen_random_uuid()::text || '.png';
  other_photo text:=other_buyer::text || '/' || gen_random_uuid()::text || '.webp';
begin
  foreach actor in array array[buyer,other_buyer,merchant,other_merchant] loop
    insert into auth.users(id,email,email_confirmed_at) values(actor,actor::text || '@example.invalid',now());
  end loop;
  insert into fly_delivery.accounts(id,role) values(buyer,'customer'),(other_buyer,'customer'),(merchant,'merchant'),(other_merchant,'merchant');
  insert into fly_delivery.customer_profiles(user_id,full_name,phone) values(buyer,'Cliente Foto','31996781111'),(other_buyer,'Outro Cliente','31996782222');
  insert into storage.objects(bucket_id,name) values('fly-delivery-profiles',photo),('fly-delivery-profiles',old_photo),('fly-delivery-profiles',other_photo);
  insert into fly_delivery.stores(id,owner_id,name,category,categories) values(shop,merchant,'Loja Foto','Pizza',array['Pizza']);
  insert into fly_delivery.orders(id,customer_id,store_id,request_id,address,payment,subtotal,fee)
    values(order_id,buyer,shop,gen_random_uuid(),'Rua Cliente, 10 - Centro','cash_delivery',1000,0);
  perform set_config('fd_test.buyer',buyer::text,true);
  perform set_config('fd_test.other_buyer',other_buyer::text,true);
  perform set_config('fd_test.merchant',merchant::text,true);
  perform set_config('fd_test.other_merchant',other_merchant::text,true);
  perform set_config('fd_test.photo',photo,true);
  perform set_config('fd_test.old_photo',old_photo,true);
  perform set_config('fd_test.other_photo',other_photo,true);
end;
$$;
set local role authenticated;
do $$
declare
  buyer text:=current_setting('fd_test.buyer');
  other_buyer text:=current_setting('fd_test.other_buyer');
  photo text:=current_setting('fd_test.photo');
  old_photo text:=current_setting('fd_test.old_photo');
  other_photo text:=current_setting('fd_test.other_photo');
  result jsonb;
begin
  perform set_config('request.jwt.claim.sub',buyer,true);
  result:=public.fd_api('save_customer_photo',jsonb_build_object('path',photo));
  if result->>'photo' is distinct from photo then raise exception 'Own photo did not persist'; end if;
  if public.fd_api('customer_profile')->>'photo' is distinct from photo then raise exception 'Photo absent on next profile read'; end if;
  if not exists(select 1 from storage.objects where bucket_id='fly-delivery-profiles' and name=photo) then raise exception 'Owner cannot read photo'; end if;
  if exists(select 1 from storage.objects where bucket_id='fly-delivery-profiles' and name=other_photo) then raise exception 'Owner can read other customer photo'; end if;
  begin
    perform public.fd_api('save_customer_photo',jsonb_build_object('path',other_photo));
    raise exception 'Foreign photo accepted';
  exception when raise_exception then if sqlerrm not like 'FD: Envie sua foto%' then raise; end if; end;
  begin
    insert into storage.objects(bucket_id,name) values('fly-delivery-profiles',other_buyer || '/' || gen_random_uuid()::text || '.jpg');
    raise exception 'Customer can upload to another folder';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub',current_setting('fd_test.merchant'),true);
  result:=public.fd_api('merchant_active_orders');
  if result->0->>'customer_photo' is distinct from photo then raise exception 'Merchant order missing profile photo'; end if;
  if not exists(select 1 from storage.objects where bucket_id='fly-delivery-profiles' and name=photo) then raise exception 'Responsible merchant cannot read photo'; end if;
  if exists(select 1 from storage.objects where bucket_id='fly-delivery-profiles' and name=old_photo) then raise exception 'Merchant sees an unused photo'; end if;
  if fly_delivery.can_access_profile_photo(photo,true) then raise exception 'Merchant can change customer photos'; end if;
  perform set_config('request.jwt.claim.sub',current_setting('fd_test.other_merchant'),true);
  if exists(select 1 from storage.objects where bucket_id='fly-delivery-profiles' and name=photo) then raise exception 'Unrelated merchant can read photo'; end if;
  perform set_config('request.jwt.claim.sub',other_buyer,true);
  if exists(select 1 from storage.objects where bucket_id='fly-delivery-profiles' and name=photo) then raise exception 'Other buyer can read photo'; end if;
  perform set_config('request.jwt.claim.sub','',true);
  if fly_delivery.can_access_profile_photo(photo,false) then raise exception 'Anonymous photo access'; end if;
end;
$$;
reset role;
select 'Foto do cliente: cadastro, persistência, pedido da loja e permissões reais de Storage verificados' as integration;
rollback;
