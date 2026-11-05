create function fly_delivery.grant_railway_admin(email_address text, verified_user uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (
    select 1 from auth.users
    where id=verified_user and lower(email)=lower(btrim(email_address)) and email_confirmed_at is not null
      and (raw_app_meta_data->>'fly_delivery_setup') is distinct from 'true'
  ) then return false; end if;

  insert into fly_delivery.accounts(id,role) values(verified_user,'admin')
    on conflict(id) do update set role='admin'
    where accounts.enabled and accounts.role in ('customer','admin');
  return found;
end;
$$;
revoke all on function fly_delivery.grant_railway_admin(text,uuid) from public, anon, authenticated;
grant execute on function fly_delivery.grant_railway_admin(text,uuid) to service_role;

create function public.fd_grant_railway_admin(email_address text, verified_user uuid)
returns boolean language plpgsql security invoker set search_path = ''
as $$
begin
  return fly_delivery.grant_railway_admin(email_address,verified_user);
end;
$$;
revoke all on function public.fd_grant_railway_admin(text,uuid) from public, anon, authenticated;
grant execute on function public.fd_grant_railway_admin(text,uuid) to service_role;
