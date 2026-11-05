create or replace function fly_delivery.bootstrap_admin(email_address text, supplied_password text, verified_user uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  configured_login text;
  configured_password text;
  password_id uuid;
  matched auth.users;
begin
  perform pg_advisory_xact_lock(hashtextextended('fd:admin-bootstrap',0));
  select id into password_id from vault.secrets where name='FLY_DELIVERY_ADMIN_PASSWORD';
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
  if action='place' then
    if fly_delivery.customer_profile('{}'::jsonb) is null then
      raise exception 'FD: Complete seu cadastro antes de fazer o pedido.';
    end if;
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

