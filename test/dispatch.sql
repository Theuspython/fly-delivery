-- Integration fixtures run in a single transaction. No accounts, orders or products persist.
begin;
do $$
declare
  admin_id uuid := gen_random_uuid();
  merchant_id uuid := gen_random_uuid();
  buyer_id uuid := gen_random_uuid();
  courier1 uuid := gen_random_uuid();
  courier2 uuid := gen_random_uuid();
  foreign_buyer uuid := gen_random_uuid();
  store_id uuid;
  registration_id uuid := gen_random_uuid();
  registration jsonb;
  product_id uuid;
  request_id uuid := gen_random_uuid();
  order_id uuid;
  result jsonb;
  order_input jsonb;
  actor_id uuid;
begin
  foreach actor_id in array array[admin_id,merchant_id,buyer_id,courier1,courier2,foreign_buyer] loop
    insert into auth.users(id,email,email_confirmed_at)
    values(actor_id,actor_id::text || '@example.invalid',now());
  end loop;
  insert into fly_delivery.accounts (id,role) values(admin_id,'admin');
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  if public.fd_registration_target(merchant_id::text || '@example.invalid')->>'confirmed' <> 'true' then
    raise exception 'Registration lookup did not find the confirmed account';
  end if;
  registration := jsonb_build_object('owner_email',merchant_id::text || '@example.invalid','request_id',registration_id,
    'name','Fixture Store','category','Pizza','active',true,'address','Rua Teste 123','lat',-19.9,'lng',-43.9,'fee',650,'delivery_radius',8,'eta',25);
  result := public.fd_api('register_store',registration);
  store_id := (result->>'id')::uuid;
  if public.fd_api('register_store',registration)->>'id' <> store_id::text then raise exception 'Duplicate registration retry'; end if;
  perform public.fd_api('set_courier',jsonb_build_object('email',courier1::text || '@example.invalid','enabled',true));
  perform public.fd_api('set_courier',jsonb_build_object('email',courier2::text || '@example.invalid','enabled',true));

  perform set_config('request.jwt.claim.sub',merchant_id::text,true);
  perform public.fd_api('set_open',jsonb_build_object('store_id',store_id,'open',true));
  result := public.fd_api('save_product',jsonb_build_object('store_id',store_id,'name','Pizza Teste','price',1990,'active',true));
  product_id := (result->>'id')::uuid;
  if not fly_delivery.can_upload(store_id::text || '/' || gen_random_uuid() || '.webp') then raise exception 'Merchant cannot upload'; end if;

  perform set_config('request.jwt.claim.sub',buyer_id::text,true);
  perform public.fd_api('session');
  order_input := jsonb_build_object('store_id',store_id,'request_id',request_id,'address','Rua Cliente 456','lat',-19.91,'lng',-43.91,
    'payment','pix_delivery','fee',650,'items',jsonb_build_array(jsonb_build_object('id',product_id,'quantity',2,'price',1990)));
  begin
    perform public.fd_api('place',order_input);
    raise exception 'Incomplete customer can order';
  exception when raise_exception then
    if sqlerrm not like 'FD: Complete seu cadastro%' then raise; end if;
  end;
  perform public.fd_api('customer_profile','{"name":"Cliente Teste","phone":"31987654321"}');
  begin
    perform public.fd_api('place',order_input || '{"lat":0,"lng":0}'::jsonb);
    raise exception 'Accepted out-of-range order';
  exception when raise_exception then
    if sqlerrm not like 'FD: O endereço está fora%' then raise; end if;
  end;
  result := public.fd_api('place',order_input);
  order_id := (result->>'id')::uuid;
  if result->>'subtotal' <> '3980' then raise exception 'Incorrect server total'; end if;
  if public.fd_api('place',order_input)->>'id' <> order_id::text then raise exception 'Duplicate retry'; end if;
  if fly_delivery.can_upload(store_id::text || '/' || gen_random_uuid() || '.webp') then raise exception 'Buyer can upload'; end if;

  perform set_config('request.jwt.claim.sub',foreign_buyer::text,true);
  perform public.fd_api('session');
  begin
    perform public.fd_registration_target(merchant_id::text || '@example.invalid');
    raise exception 'Customer can look up Auth accounts';
  exception when raise_exception then
    if sqlerrm not like 'FD: Acesso restrito%' then raise; end if;
  end;
  if public.fd_api('orders','{"view":"customer"}') <> '[]'::jsonb then raise exception 'Buyer can read another buyer order'; end if;
  begin
    perform public.fd_api('transition',jsonb_build_object('id',order_id,'status','cancelled'));
    raise exception 'Buyer can cancel another buyer order';
  exception when raise_exception then
    if sqlerrm not like 'FD:%' then raise; end if;
  end;

  perform set_config('request.jwt.claim.sub',merchant_id::text,true);
  perform public.fd_api('save_product',jsonb_build_object('id',product_id,'store_id',store_id,'name','Preço Novo','price',2990));
  perform public.fd_api('transition',jsonb_build_object('id',order_id,'status','preparing'));
  perform public.fd_api('transition',jsonb_build_object('id',order_id,'status','ready'));

  foreach actor_id in array array[courier1,courier2] loop
    perform set_config('request.jwt.claim.sub',actor_id::text,true);
    perform public.fd_api('presence','{"online":true,"lat":-19.9,"lng":-43.9}');
    select item into result from jsonb_array_elements(public.fd_api('offers')) item where item->>'id'=order_id::text;
    if result is null or result ? 'address' or result ? 'lat' then raise exception 'Offer missing or leaks destination'; end if;
  end loop;
  perform set_config('request.jwt.claim.sub',courier1::text,true);
  result := public.fd_api('transition',jsonb_build_object('id',order_id,'status','assigned'));
  if jsonb_array_length(public.fd_api('orders','{"view":"courier"}')) <> 1
     or public.fd_api('orders','{"view":"customer"}') <> '[]'::jsonb then
    raise exception 'Courier operations and shopping history were not separated';
  end if;
  if result->>'address' <> 'Rua Cliente 456' then raise exception 'Assigned courier cannot see destination'; end if;
  perform set_config('request.jwt.claim.sub',courier2::text,true);
  begin
    perform public.fd_api('transition',jsonb_build_object('id',order_id,'status','assigned'));
    raise exception 'Second courier accepted the same order';
  exception when raise_exception then
    if sqlerrm not like 'FD:%' then raise; end if;
  end;
  perform set_config('request.jwt.claim.sub',courier1::text,true);
  perform public.fd_api('transition',jsonb_build_object('id',order_id,'status','picked_up'));
  result := public.fd_api('transition',jsonb_build_object('id',order_id,'status','delivered'));
  if not exists(select 1 from public.fd_order_updates u where u.order_id=(result->>'id')::uuid and u.customer_id=buyer_id) then
    raise exception 'Order status update did not create a realtime signal';
  end if;
  if result->>'status' <> 'delivered' or result->'items'->0->>'name' <> 'Pizza Teste' or
    jsonb_array_length(result->'events') <> 6 then raise exception 'Delivery history was not preserved'; end if;
end $$;
select 'Fly Delivery: cadastro, checkout, acesso, sinal de status, aceite exclusivo e entrega verificados' as integration;
rollback;
