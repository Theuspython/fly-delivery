alter table fly_delivery.stores
  alter column address drop not null,
  alter column lat drop not null,
  alter column lng drop not null,
  add column categories text[],
  add column image text,
  add column weekly_hours jsonb;

update fly_delivery.stores set categories=array[category];
alter table fly_delivery.stores alter column categories set not null;

create function fly_delivery.actor_role()
returns text language sql stable security definer set search_path = ''
as $$
  select role from fly_delivery.accounts where id=(select auth.uid()) and enabled;
$$;

create function fly_delivery.store_open_at(store fly_delivery.stores, instant timestamptz)
returns boolean language plpgsql stable set search_path = ''
as $$
declare
  local_time timestamp := instant at time zone 'America/Sao_Paulo';
  day_number integer := extract(dow from local_time)::integer;
  clock_now text := to_char(local_time,'HH24:MI');
  today jsonb := store.weekly_hours->day_number;
  yesterday jsonb := store.weekly_hours->((day_number+6)%7);
begin
  if not store.is_open or not store.active or store.sample then return false; end if;
  if store.weekly_hours is null then return true; end if;
  return coalesce(
    (today->>'open'=today->>'close') or
    (today->>'open'<today->>'close' and clock_now>=today->>'open' and clock_now<today->>'close') or
    (today->>'open'>today->>'close' and clock_now>=today->>'open') or
    (yesterday->>'open'>yesterday->>'close' and clock_now<yesterday->>'close'),false);
end;
$$;

create function fly_delivery.market_catalog()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',st.id,'name',st.name,'description',st.description,'category',st.category,'categories',st.categories,
    'image',st.image,'is_open',fly_delivery.store_open_at(st,now()),
    'fee',st.fee,'eta',st.eta,'lat',st.lat,'lng',st.lng,'delivery_radius',st.delivery_radius,
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',pr.id,'name',pr.name,'description',pr.description,
      'price',pr.price,'image',pr.image) order by pr.name)
      from fly_delivery.products pr where pr.store_id=st.id and pr.active),'[]'::jsonb))
    order by fly_delivery.store_open_at(st,now()) desc,st.name),'[]'::jsonb)
  from fly_delivery.stores st
  where st.active and not st.sample and st.address is not null and st.lat is not null and st.lng is not null;
$$;

create function fly_delivery.operator_stores()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  actor_role text := fly_delivery.actor_role();
begin
  if actor_role='admin' then
    return coalesce((select jsonb_agg(jsonb_build_object(
      'id',s.id,'name',s.name,'categories',s.categories,'active',s.active,
      'owner_login',u.raw_app_meta_data->'fly_delivery_operator'->>'login') order by s.name)
      from fly_delivery.stores s left join auth.users u on u.id=s.owner_id where not s.sample),'[]'::jsonb);
  elsif actor_role='merchant' then
    return coalesce((select jsonb_agg(to_jsonb(s) || jsonb_build_object(
      'accepting_now',fly_delivery.store_open_at(s,now()),
      'products',coalesce((select jsonb_agg(to_jsonb(p) order by p.name)
        from fly_delivery.products p where p.store_id=s.id),'[]'::jsonb)) order by s.name)
      from fly_delivery.stores s where not s.sample and s.owner_id=(select auth.uid())),'[]'::jsonb);
  end if;
  raise exception 'FD: Acesso restrito às lojas.';
end;
$$;

create function fly_delivery.operator_couriers()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if fly_delivery.actor_role() is distinct from 'admin' then raise exception 'FD: Acesso restrito à administração.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'login',u.raw_app_meta_data->'fly_delivery_operator'->>'login') order by u.raw_app_meta_data->'fly_delivery_operator'->>'login')
    from fly_delivery.accounts a join auth.users u on u.id=a.id where a.role='courier' and a.enabled),'[]'::jsonb);
end;
$$;

create function fly_delivery.assign_operator(payload jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  target_id uuid := (payload->>'user_id')::uuid;
  requested_role text := payload->>'role';
  request_id uuid := (payload->>'request_id')::uuid;
  store_id uuid := (payload->>'store_id')::uuid;
  login_name text := payload->>'login';
  store_name text := btrim(payload->>'name');
  operator_meta jsonb;
  chosen_categories text[];
  existing_role text;
  target_enabled boolean;
  s fly_delivery.stores;
begin
  if fly_delivery.actor_role() is distinct from 'admin' then raise exception 'FD: Acesso restrito à administração.'; end if;
  if request_id is null or requested_role not in ('merchant','courier') then raise exception 'FD: Dados do cadastro inválidos.'; end if;
  select raw_app_meta_data->'fly_delivery_operator' into operator_meta from auth.users
    where id=target_id and email_confirmed_at is not null;
  if operator_meta->>'role' is distinct from requested_role or operator_meta->>'login' is distinct from login_name then
    raise exception 'FD: Conta de acesso inválida.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('fd:operator:' || target_id::text,0));
  select role,enabled into existing_role,target_enabled from fly_delivery.accounts where id=target_id;
  if target_enabled is false then raise exception 'FD: Este acesso está desabilitado.'; end if;
  if existing_role is not null and existing_role not in ('customer',requested_role) then
    raise exception 'FD: Este login já pertence a outro perfil.';
  end if;

  if requested_role='courier' then
    if existing_role='courier' and operator_meta->>'request_id' is distinct from request_id::text then
      raise exception 'FD: Este login já está em uso.';
    end if;
    insert into fly_delivery.accounts(id,role) values(target_id,'courier')
      on conflict(id) do update set role='courier' where accounts.role='customer' and accounts.enabled;
    return jsonb_build_object('id',target_id);
  end if;

  select * into s from fly_delivery.stores where owner_id=target_id and not sample limit 1;
  if found then
    if s.registration_request=request_id and (store_id is null or s.id=store_id) then
      return jsonb_build_object('id',s.id);
    end if;
    raise exception 'FD: Este login já está em uso.';
  end if;
  insert into fly_delivery.accounts(id,role) values(target_id,'merchant')
    on conflict(id) do update set role='merchant' where accounts.role='customer' and accounts.enabled;
  if store_id is not null then
    update fly_delivery.stores st set owner_id=target_id,registration_request=request_id
    where st.id=store_id and not st.sample and not exists (
      select 1 from auth.users u where u.id=st.owner_id and u.raw_app_meta_data ? 'fly_delivery_operator'
    ) returning st.* into s;
    if not found then raise exception 'FD: Esta loja já tem um login ou está indisponível.'; end if;
    return jsonb_build_object('id',s.id);
  end if;

  if jsonb_typeof(payload->'categories') is distinct from 'array' or coalesce(char_length(store_name),0) not between 2 and 80 then
    raise exception 'FD: Informe o nome e as categorias da loja.';
  end if;
  select array_agg(distinct value order by value) into chosen_categories from jsonb_array_elements_text(payload->'categories');
  if chosen_categories is null or not (chosen_categories <@ array['Hambúrguer','Pizza','Japonesa','Brasileira','Açaí','Outros']) then
    raise exception 'FD: Selecione pelo menos uma categoria válida.';
  end if;
  insert into fly_delivery.stores(owner_id,name,category,categories,registration_request)
    values(target_id,store_name,chosen_categories[1],chosen_categories,request_id)
    returning * into s;
  return jsonb_build_object('id',s.id);
exception when invalid_text_representation or unique_violation then
  raise exception 'FD: Confira os dados ou escolha outro login.';
end;
$$;

create function fly_delivery.save_store_profile(payload jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  s fly_delivery.stores;
  schedule jsonb := payload->'weekly_hours';
  day_hours jsonb;
  picture text := nullif(payload->>'image','');
begin
  if fly_delivery.actor_role() is distinct from 'merchant' then raise exception 'FD: Configuração exclusiva do estabelecimento.'; end if;
  select * into s from fly_delivery.stores
    where id=(payload->>'id')::uuid and owner_id=(select auth.uid()) and not sample for update;
  if not found then raise exception 'FD: Você não tem acesso a esta loja.'; end if;
  if jsonb_typeof(schedule) is distinct from 'array' then raise exception 'FD: Confira os horários da semana.'; end if;
  if jsonb_array_length(schedule)<>7 then raise exception 'FD: Confira os horários da semana.'; end if;
  for day_hours in select value from jsonb_array_elements(schedule) loop
    if day_hours<>'null'::jsonb and (
      jsonb_typeof(day_hours)<>'object' or
      coalesce(day_hours->>'open','') !~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$' or
      coalesce(day_hours->>'close','') !~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$'
    ) then raise exception 'FD: Preencha os horários dos dias abertos.'; end if;
  end loop;
  if picture is not null and picture !~ ('^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/fly-delivery-menu/' || s.id::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$') then
    raise exception 'FD: Envie a foto pelo painel da loja.';
  end if;
  if coalesce(char_length(btrim(payload->>'address')),0)<5 or payload->>'lat' is null or payload->>'lng' is null then
    raise exception 'FD: Informe o endereço e marque a retirada no mapa.';
  end if;
  update fly_delivery.stores set
    description=coalesce(btrim(payload->>'description'),''),address=btrim(payload->>'address'),
    lat=(payload->>'lat')::double precision,lng=(payload->>'lng')::double precision,
    fee=(payload->>'fee')::integer,delivery_radius=(payload->>'delivery_radius')::integer,eta=(payload->>'eta')::integer,
    active=coalesce((payload->>'active')::boolean,false),is_open=case when s.address is null then true else s.is_open end,
    image=picture,weekly_hours=schedule
  where id=s.id;
  return jsonb_build_object('id',s.id);
exception when invalid_text_representation or check_violation or not_null_violation or numeric_value_out_of_range then
  raise exception 'FD: Confira os dados do estabelecimento.';
end;
$$;

create function fly_delivery.check_store_open(store_id uuid,requested_order uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  s fly_delivery.stores;
begin
  if exists(select 1 from fly_delivery.orders where customer_id=(select auth.uid()) and request_id=requested_order) then return; end if;
  select * into s from fly_delivery.stores where id=store_id for share;
  if not found or not fly_delivery.store_open_at(s,now()) then
    raise exception 'FD: A loja não está aceitando pedidos agora.';
  end if;
end;
$$;

create or replace function fly_delivery.can_upload(object_name text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from fly_delivery.accounts a
    join fly_delivery.stores s on s.id::text=split_part(object_name,'/',1) and not s.sample
    where a.id=(select auth.uid()) and a.enabled and a.role='merchant' and s.owner_id=a.id
  ) and object_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$';
$$;

revoke all on function fly_delivery.store_open_at(fly_delivery.stores,timestamptz) from public, anon, authenticated;
revoke all on function fly_delivery.market_catalog() from public, anon, authenticated;
grant execute on function fly_delivery.market_catalog() to anon,authenticated;
revoke all on function fly_delivery.actor_role(), fly_delivery.operator_stores(), fly_delivery.operator_couriers(),
  fly_delivery.assign_operator(jsonb), fly_delivery.save_store_profile(jsonb), fly_delivery.check_store_open(uuid,uuid)
  from public, anon, authenticated;
grant execute on function fly_delivery.actor_role(), fly_delivery.operator_stores(), fly_delivery.operator_couriers(),
  fly_delivery.assign_operator(jsonb), fly_delivery.save_store_profile(jsonb), fly_delivery.check_store_open(uuid,uuid)
  to authenticated;

create or replace function public.fd_api(action text, input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  actor_role text;
begin
  if action='catalog' then return fly_delivery.market_catalog(); end if;
  if action='session' then
    return fly_delivery.api(action,input) || jsonb_build_object('operator_login',auth.jwt()->'app_metadata'->'fly_delivery_operator'->>'login');
  end if;
  if auth.uid() is null then raise exception 'FD: Entre para continuar.'; end if;
  if auth.jwt()->'app_metadata'->>'fly_delivery_setup'='true' then
    raise exception 'FD: Ative sua conta antes de acessar esta área.';
  end if;
  actor_role := fly_delivery.actor_role();
  if action='customer_profile' then return fly_delivery.customer_profile(input); end if;
  if action='assign_operator' then return fly_delivery.assign_operator(input); end if;
  if action='managed_stores' then return fly_delivery.operator_stores(); end if;
  if action='couriers' then return fly_delivery.operator_couriers(); end if;
  if action='save_store_profile' then return fly_delivery.save_store_profile(input); end if;
  if action in ('save_store','register_store','set_courier') then raise exception 'FD: Use o cadastro de acessos da administração.'; end if;
  if action in ('save_product','set_open') and actor_role is distinct from 'merchant' then
    raise exception 'FD: Operação exclusiva do estabelecimento.';
  end if;
  if action='place' then
    if fly_delivery.customer_profile('{}'::jsonb) is null then raise exception 'FD: Complete seu cadastro antes de fazer o pedido.'; end if;
    perform fly_delivery.check_store_open((input->>'store_id')::uuid,(input->>'request_id')::uuid);
  end if;
  if action in ('orders','transition') and actor_role='admin' then raise exception 'FD: Operação restrita ao atendimento.'; end if;
  if action='orders' and input ? 'view' then return fly_delivery.scoped_orders(input->>'view'); end if;
  return fly_delivery.api(action,input);
end;
$$;
