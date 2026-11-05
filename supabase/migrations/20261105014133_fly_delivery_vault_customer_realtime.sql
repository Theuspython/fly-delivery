select vault.create_secret('PREENCHER',item.name,item.description)
from (values
  ('GOOGLE_MAPS_BROWSER_KEY','Chave de navegador da Maps JavaScript API para o domínio do Fly Delivery.'),
  ('FLY_DELIVERY_ADMIN_LOGIN','E-mail do administrador a habilitar no Fly Delivery.'),
  ('FLY_DELIVERY_ADMIN_PASSWORD','Senha de configuração inicial. Volta para PREENCHER após o primeiro acesso.')
) as item(name,description)
where not exists (select 1 from vault.secrets s where s.name=item.name);

create function fly_delivery.google_browser_key()
returns text language sql stable security definer set search_path = ''
as $$
  select btrim(decrypted_secret) from vault.decrypted_secrets
  where name='GOOGLE_MAPS_BROWSER_KEY' and btrim(decrypted_secret) ~ '^AIza[A-Za-z0-9_-]{25,}$';
$$;
revoke all on function fly_delivery.google_browser_key() from public, anon, authenticated;
grant execute on function fly_delivery.google_browser_key() to anon, authenticated;

create function public.fd_google_browser_key()
returns text language sql security invoker set search_path = ''
as $$ select fly_delivery.google_browser_key(); $$;
revoke all on function public.fd_google_browser_key() from public, anon, authenticated;
grant execute on function public.fd_google_browser_key() to anon, authenticated;

create function fly_delivery.bootstrap_admin(email_address text, supplied_password text, verified_user uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  configured_login text;
  configured_password text;
  password_id uuid;
  matched auth.users;
begin
  select id into password_id from vault.secrets where name='FLY_DELIVERY_ADMIN_PASSWORD' for update;
  select decrypted_secret into configured_password from vault.decrypted_secrets where id=password_id;
  select lower(btrim(decrypted_secret)) into configured_login from vault.decrypted_secrets
    where name='FLY_DELIVERY_ADMIN_LOGIN';
  if configured_login is distinct from lower(btrim(email_address)) or
     configured_password is null or configured_password='PREENCHER' or
     sha256(convert_to(configured_password,'UTF8')) is distinct from sha256(convert_to(supplied_password,'UTF8'))
  then return jsonb_build_object('authorized',false); end if;

  select * into matched from auth.users where lower(email)=configured_login;
  if verified_user is null then
    return jsonb_build_object('authorized',true,'exists',matched.id is not null);
  end if;
  if matched.id is distinct from verified_user or matched.email_confirmed_at is null then
    return jsonb_build_object('authorized',false);
  end if;
  insert into fly_delivery.accounts(id,role) values(verified_user,'admin')
    on conflict(id) do update set role='admin'
    where accounts.enabled and accounts.role in ('customer','admin');
  if not found then raise exception 'FD: Este perfil não pode ser habilitado como administrador.'; end if;
  perform vault.update_secret(password_id,'PREENCHER');
  return jsonb_build_object('authorized',true);
end;
$$;
revoke all on function fly_delivery.bootstrap_admin(text,text,uuid) from public, anon, authenticated;
grant usage on schema fly_delivery to service_role;
grant execute on function fly_delivery.bootstrap_admin(text,text,uuid) to service_role;

create function public.fd_admin_bootstrap(email_address text, supplied_password text, verified_user uuid default null)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
begin
  return fly_delivery.bootstrap_admin(email_address,supplied_password,verified_user);
end;
$$;
revoke all on function public.fd_admin_bootstrap(text,text,uuid) from public, anon, authenticated;
grant execute on function public.fd_admin_bootstrap(text,text,uuid) to service_role;

create table fly_delivery.customer_profiles (
  user_id uuid primary key references fly_delivery.accounts(id) on delete cascade,
  full_name text not null check (char_length(full_name) between 3 and 120),
  phone text not null check (phone ~ '^[1-9][0-9]{9,10}$')
);
alter table fly_delivery.customer_profiles enable row level security;

create function fly_delivery.customer_profile(payload jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  profile fly_delivery.customer_profiles;
  metadata jsonb;
  full_name_input text;
  phone_input text;
begin
  if not exists(select 1 from fly_delivery.accounts where id=actor and enabled) then
    raise exception 'FD: Entre para continuar.';
  end if;
  select * into profile from fly_delivery.customer_profiles where user_id=actor;
  if not found then
    select raw_user_meta_data->'fly_delivery_customer' into metadata from auth.users where id=actor;
    full_name_input := btrim(coalesce(payload->>'name',metadata->>'name',''));
    phone_input := coalesce(payload->>'phone',metadata->>'phone','');
    if char_length(full_name_input) between 3 and 120 and phone_input ~ '^[1-9][0-9]{9,10}$' then
      insert into fly_delivery.customer_profiles(user_id,full_name,phone) values(actor,full_name_input,phone_input)
      on conflict(user_id) do nothing;
      select * into profile from fly_delivery.customer_profiles where user_id=actor;
    elsif payload ? 'name' or payload ? 'phone' then
      raise exception 'FD: Informe seu nome e um celular válido com DDD.';
    end if;
  end if;
  if profile.user_id is null then return null; end if;
  return jsonb_build_object('name',profile.full_name,'phone',profile.phone);
end;
$$;
revoke all on function fly_delivery.customer_profile(jsonb) from public, anon, authenticated;
grant execute on function fly_delivery.customer_profile(jsonb) to authenticated;

create or replace function public.fd_api(action text, input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
begin
  if action not in ('catalog','session') and auth.jwt()->'app_metadata'->>'fly_delivery_setup'='true' then
    raise exception 'FD: Ative sua conta antes de acessar esta área.';
  end if;
  if action='customer_profile' then
    return fly_delivery.customer_profile(input);
  end if;
  if action='place' and fly_delivery.customer_profile('{}'::jsonb) is null then
    raise exception 'FD: Complete seu cadastro antes de fazer o pedido.';
  end if;
  if action='orders' and input ? 'view' then
    return fly_delivery.scoped_orders(input->>'view');
  end if;
  if action='register_store' then
    return fly_delivery.register_store(input);
  end if;
  return fly_delivery.api(action,input);
end;
$$;

create table public.fd_order_updates (
  order_id uuid primary key references fly_delivery.orders(id) on delete cascade,
  customer_id uuid not null references fly_delivery.accounts(id),
  updated_at timestamptz not null default now()
);
create index fd_order_updates_customer on public.fd_order_updates(customer_id);
alter table public.fd_order_updates enable row level security;
revoke all on table public.fd_order_updates from public, anon, authenticated;
grant select on table public.fd_order_updates to authenticated;
create policy fd_order_updates_own on public.fd_order_updates for select to authenticated
  using (customer_id=(select auth.uid()));

create function fly_delivery.signal_order_update()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op='UPDATE' and new.status=old.status then return new; end if;
  insert into public.fd_order_updates(order_id,customer_id,updated_at)
  values(new.id,new.customer_id,clock_timestamp())
  on conflict(order_id) do update set updated_at=excluded.updated_at;
  return new;
end;
$$;
revoke all on function fly_delivery.signal_order_update() from public, anon, authenticated;
create trigger fd_order_status_signal after insert or update of status on fly_delivery.orders
  for each row execute function fly_delivery.signal_order_update();
alter publication supabase_realtime add table public.fd_order_updates;
