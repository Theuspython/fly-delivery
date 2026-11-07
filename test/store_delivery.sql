-- Integration fixtures run in a single transaction. No accounts, orders or products persist.
begin;
do $$
declare
  admin_id uuid := gen_random_uuid();
  merchant_id uuid := gen_random_uuid();
  buyer_id uuid := gen_random_uuid();
  courier1 uuid := gen_random_uuid();
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
  shop fly_delivery.stores;
  photo text;
  schedule jsonb := (select jsonb_agg(jsonb_build_object('open','00:00','close','00:00')) from generate_series(1,7));
begin
  foreach actor_id in array array[admin_id,merchant_id,buyer_id,courier1,foreign_buyer] loop
    insert into auth.users(id,email,email_confirmed_at)
    values(actor_id,actor_id::text || '@example.invalid',now());
  end loop;
  insert into fly_delivery.accounts (id,role) values(admin_id,'admin');
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  update auth.users set raw_app_meta_data=jsonb_build_object('fly_delivery_operator',
    jsonb_build_object('role','merchant','login','fixture-shop')) where id=merchant_id;
  update auth.users set raw_app_meta_data=jsonb_build_object('fly_delivery_operator',
    jsonb_build_object('role','courier','login',id::text)) where id=courier1;
  registration := jsonb_build_object('user_id',merchant_id,'role','merchant','login','fixture-shop',
    'request_id',registration_id,'name','Fixture Store','categories',array['Pizza','Porções']);
  result := public.fd_api('assign_operator',registration);
  store_id := (result->>'id')::uuid;
  if public.fd_api('assign_operator',registration)->>'id' <> store_id::text then raise exception 'Duplicate registration retry'; end if;
  if (select active from fly_delivery.stores where id=store_id) then raise exception 'Draft store was published'; end if;
  begin
    perform public.fd_api('assign_operator',jsonb_build_object('user_id',courier1,'role','courier',
      'login',courier1::text,'request_id',gen_random_uuid()));
    raise exception 'Courier registration remains enabled';
  exception when raise_exception then
    if sqlerrm not like 'FD: Dados do cadastro%' then raise; end if;
  end;
  insert into fly_delivery.accounts(id,role) values(courier1,'courier');
  begin
    perform public.fd_api('save_product',jsonb_build_object('store_id',store_id,'name','Admin Product','price',1990));
    raise exception 'Admin can create products';
  exception when raise_exception then
    if sqlerrm not like 'FD: Operação exclusiva%' then raise; end if;
  end;

  perform set_config('request.jwt.claim.sub',merchant_id::text,true);
  photo := 'https://fixture.supabase.co/storage/v1/object/public/fly-delivery-menu/' || store_id || '/' || gen_random_uuid() || '.webp';
  perform public.fd_api('save_store_profile',jsonb_build_object('id',store_id,'active',true,
    'fee',650,'eta',25,'weekly_hours',schedule,'image',photo));
  select * into shop from fly_delivery.stores where id=store_id;
  if shop.address is not null or not shop.is_open then raise exception 'First publication without address failed'; end if;
  shop.weekly_hours := '[null,{"open":"20:00","close":"02:00"},null,null,null,null,null]';
  if shop.lat is not null or shop.lng is not null then raise exception 'Store needs coordinates'; end if;
  if not fly_delivery.store_open_at(shop,'2026-11-10 01:00-03'::timestamptz)
    or fly_delivery.store_open_at(shop,'2026-11-10 02:00-03'::timestamptz) then
    raise exception 'Overnight hours incorrect';
  end if;
  if not exists(select 1 from jsonb_array_elements(public.fd_api('catalog')) item
    where item->>'id'=store_id::text and item->>'image'=photo and item->'is_open'='true' and item->'categories' @> '["Pizza","Porções"]'::jsonb) then
    raise exception 'Store cover or categories not visible';
  end if;
  perform public.fd_api('set_open',jsonb_build_object('store_id',store_id,'open',false));
  perform public.fd_api('save_store_profile',jsonb_build_object('id',store_id,'active',true,'fee',650,'eta',25,'weekly_hours',schedule,'image',photo));
  if (select is_open from fly_delivery.stores where id=store_id) then raise exception 'Editing the profile resumed paused orders'; end if;
  perform public.fd_api('set_open',jsonb_build_object('store_id',store_id,'open',true));
  result := public.fd_api('save_product',jsonb_build_object('store_id',store_id,'name','Pizza Teste','category','Pizza','price',1990,'active',true));
  product_id := (result->>'id')::uuid;
  if not fly_delivery.can_upload(store_id::text || '/' || gen_random_uuid() || '.webp') then raise exception 'Merchant cannot upload'; end if;

  perform set_config('request.jwt.claim.sub',buyer_id::text,true);
  perform public.fd_api('session');
  order_input := jsonb_build_object('store_id',store_id,'request_id',request_id,'address','Rua Cliente 456, Centro, Cidade Teste',
    'payment','pix_delivery','fee',650,'items',jsonb_build_array(jsonb_build_object('id',product_id,'quantity',2,'price',1990)));
  begin
    perform public.fd_api('place',order_input);
    raise exception 'Incomplete customer can order';
  exception when raise_exception then
    if sqlerrm not like 'FD: Complete seu cadastro%' then raise; end if;
  end;
  perform public.fd_api('customer_profile','{"name":"Cliente Teste","phone":"31987654321"}');
  begin
    perform public.fd_api('place',order_input || '{"address":" "}'::jsonb);
    raise exception 'Empty typed address accepted';
  exception when raise_exception then
    if sqlerrm not like 'FD: Confira o endereço%' then raise; end if;
  end;
  begin
    perform public.fd_api('place',order_input || jsonb_build_object('items',jsonb_build_array(
      jsonb_build_object('id',product_id,'quantity',2,'price',1))));
    raise exception 'Client price tampering accepted';
  exception when raise_exception then
    if sqlerrm not like 'FD: Os preços mudaram%' then raise; end if;
  end;
  result := public.fd_api('place',order_input);
  order_id := (result->>'id')::uuid;
  if result->>'lat' is not null or result->>'lng' is not null or result->>'distance_km' is not null then raise exception 'New order stores fake coordinates'; end if;
  if result->>'subtotal' <> '3980' then raise exception 'Incorrect server total'; end if;
  if public.fd_api('place',order_input)->>'id' <> order_id::text then raise exception 'Duplicate retry'; end if;
  if fly_delivery.can_upload(store_id::text || '/' || gen_random_uuid() || '.webp') then raise exception 'Buyer can upload'; end if;

  perform set_config('request.jwt.claim.sub',foreign_buyer::text,true);
  perform public.fd_api('session');
  begin
    perform public.fd_api('assign_operator',registration);
    raise exception 'Customer can create operator accounts';
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
  begin
    perform public.fd_api('transition',jsonb_build_object('id',order_id,'status','delivered'));
    raise exception 'Delivery confirmed before dispatch';
  exception when raise_exception then
    if sqlerrm not like 'FD: Esta etapa%' then raise; end if;
  end;
  result := public.fd_api('transition',jsonb_build_object('id',order_id,'status','picked_up'));
  if result->>'status'<>'picked_up' then raise exception 'Shop cannot mark dispatch'; end if;
  if jsonb_array_length(public.fd_api('merchant_active_orders'))<>1 then raise exception 'Dispatched order disappeared'; end if;
  perform set_config('request.jwt.claim.sub',courier1::text,true);
  foreach actor_id in array array[courier1] loop
    begin
      perform public.fd_api('offers');
      raise exception 'Retired courier can access dispatch';
    exception when raise_exception then
      if sqlerrm not like 'FD:%' then raise; end if;
    end;
    begin
      perform fly_delivery.api('transition',jsonb_build_object('id',order_id,'status','delivered'));
      raise exception 'Retired courier can confirm delivery';
    exception when raise_exception then
      if sqlerrm not like 'FD:%' then raise; end if;
    end;
  end loop;
  perform set_config('request.jwt.claim.sub',buyer_id::text,true);
  result:=public.fd_api('orders','{"view":"customer"}');
  if result->0->>'status'<>'picked_up' then raise exception 'Customer cannot see dispatch status'; end if;
  perform set_config('request.jwt.claim.sub',merchant_id::text,true);
  result := public.fd_api('transition',jsonb_build_object('id',order_id,'status','delivered'));
  if public.fd_api('merchant_active_orders')<>'[]'::jsonb then raise exception 'Delivered order stayed in queue'; end if;
  if public.fd_api('merchant_history','{"status":"delivered"}')->>'count'<>'1' then raise exception 'Delivered history missing'; end if;
  if not exists(select 1 from public.fd_order_updates u where u.order_id=(result->>'id')::uuid and u.customer_id=buyer_id) then
    raise exception 'Order status update did not create a realtime signal';
  end if;
  if result->>'status' <> 'delivered' or result->'items'->0->>'name' <> 'Pizza Teste' or
    jsonb_array_length(result->'events') <> 4 then raise exception 'Delivery history was not preserved'; end if;
  perform public.fd_api('save_store_profile',jsonb_build_object('id',store_id,'active',true,'fee',650,'eta',25,'weekly_hours',schedule,'image',photo,
    'address','Rua do cadastro anterior','description','Descrição anterior'));
  perform public.fd_api('save_store_profile',jsonb_build_object('id',store_id,'active',true,'fee',650,'eta',25,'weekly_hours',schedule,'image',photo));
  select * into shop from fly_delivery.stores where id=store_id;
  if shop.address is distinct from 'Rua do cadastro anterior' or shop.description is distinct from 'Descrição anterior' then
    raise exception 'Saving the new profile cleared legacy data';
  end if;
end $$;
select 'Fly Delivery: endereço digitado, entrega própria, acesso, preços, status em tempo real e histórico verificados' as integration;
rollback;
