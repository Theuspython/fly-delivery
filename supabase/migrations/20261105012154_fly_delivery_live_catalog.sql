-- Keep the pilot records for history and remove them from the public catalog.
update fly_delivery.stores set active=false, is_open=false where sample;

create function fly_delivery.registration_target(email_address text)
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
  return jsonb_build_object(
    'confirmed',target.email_confirmed_at is not null,
    'setup',coalesce(target.raw_app_meta_data->>'fly_delivery_setup'='true' and target.last_sign_in_at is null,false)
  );
end;
$$;
revoke all on function fly_delivery.registration_target(text) from public, anon, authenticated;
grant execute on function fly_delivery.registration_target(text) to authenticated;

create function public.fd_registration_target(email_address text)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
begin
  return fly_delivery.registration_target(email_address);
end;
$$;
revoke all on function public.fd_registration_target(text) from public, anon, authenticated;
grant execute on function public.fd_registration_target(text) to authenticated;
