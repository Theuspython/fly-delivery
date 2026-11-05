alter table fly_delivery.customer_profiles add column cpf_login boolean not null default false;
create unique index fd_customer_cpf_phone on fly_delivery.customer_profiles(phone) where cpf_login;

create function fly_delivery.create_cpf_customer()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  profile jsonb := new.raw_user_meta_data->'fly_delivery_customer';
begin
  if coalesce(new.email,'') !~ '^fd-c-[a-f0-9]{40}@fly-delivery-piloto\.up\.railway\.app$' then
    raise exception 'Invalid Fly Delivery customer identity';
  end if;

  insert into fly_delivery.accounts(id,role) values(new.id,'customer')
  on conflict (id) do nothing;
  insert into fly_delivery.customer_profiles(user_id,full_name,phone,cpf_login)
  values(new.id,btrim(profile->>'name'),profile->>'phone',true);
  return new;
end;
$$;
revoke all on function fly_delivery.create_cpf_customer() from public, anon, authenticated;

create trigger fd_auth_cpf_customer after insert on auth.users
  for each row when (new.raw_app_meta_data->>'fly_delivery_cpf_login'='true')
  execute function fly_delivery.create_cpf_customer();

create function fly_delivery.cpf_phone_exists(phone_number text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from fly_delivery.customer_profiles where cpf_login and phone=phone_number);
$$;
revoke all on function fly_delivery.cpf_phone_exists(text) from public, anon, authenticated;
grant execute on function fly_delivery.cpf_phone_exists(text) to service_role;

create function public.fd_cpf_phone_exists(phone_number text)
returns boolean language sql security invoker set search_path = ''
as $$ select fly_delivery.cpf_phone_exists(phone_number); $$;
revoke all on function public.fd_cpf_phone_exists(text) from public, anon, authenticated;
grant execute on function public.fd_cpf_phone_exists(text) to service_role;
