alter table fly_delivery.stores add column registration_request uuid unique;

create function fly_delivery.register_store(payload jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  request_id uuid := (payload->>'request_id')::uuid;
  existing_id uuid;
  owner_email text;
  result jsonb;
begin
  if not exists (
    select 1 from fly_delivery.accounts where id=(select auth.uid()) and role='admin' and enabled
  ) then raise exception 'FD: Acesso restrito à administração.'; end if;
  if request_id is null then raise exception 'FD: Identificador de cadastro inválido.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('fd:register-store:' || request_id::text,0));

  select s.id,u.email into existing_id,owner_email
    from fly_delivery.stores s left join auth.users u on u.id=s.owner_id
    where s.registration_request=request_id;
  if found then
    if lower(owner_email) is distinct from lower(btrim(payload->>'owner_email')) then
      raise exception 'FD: O cadastro anterior foi salvo com outro responsável. Reabra o formulário.';
    end if;
    return jsonb_build_object('id',existing_id);
  end if;

  result := fly_delivery.api('save_store',payload - 'id');
  update fly_delivery.stores set registration_request=request_id where id=(result->>'id')::uuid;
  return result;
exception when invalid_text_representation then
  raise exception 'FD: Identificador de cadastro inválido.';
end;
$$;
revoke all on function fly_delivery.register_store(jsonb) from public, anon, authenticated;
grant execute on function fly_delivery.register_store(jsonb) to authenticated;

create or replace function fly_delivery.registration_target(email_address text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  target auth.users;
begin
  if not exists (
    select 1 from fly_delivery.accounts where id=(select auth.uid()) and role='admin' and enabled
  ) then raise exception 'FD: Acesso restrito à administração.'; end if;
  select * into target from auth.users where lower(email)=lower(btrim(email_address));
  if not found then return null; end if;
  return jsonb_build_object('confirmed',target.email_confirmed_at is not null,
    'setup',coalesce(target.raw_app_meta_data->>'fly_delivery_setup'='true',false));
end;
$$;

create or replace function public.fd_api(action text, input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
begin
  if action not in ('catalog','session') and auth.jwt()->'app_metadata'->>'fly_delivery_setup'='true' then
    raise exception 'FD: Ative sua conta antes de acessar esta área.';
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

create policy fly_delivery_activated_upload on storage.objects as restrictive for insert to authenticated
with check (
  bucket_id<>'fly-delivery-menu' or
  (auth.jwt()->'app_metadata'->>'fly_delivery_setup') is distinct from 'true'
);
