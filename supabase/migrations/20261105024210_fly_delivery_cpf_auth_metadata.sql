create or replace function fly_delivery.create_cpf_customer()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  profile jsonb := new.raw_user_meta_data->'fly_delivery_customer';
begin
  if coalesce(new.email,'') !~ '^fd-c-[a-f0-9]{40}@fly-delivery-piloto\.up\.railway\.app$' then
    raise exception 'Invalid Fly Delivery customer identity';
  end if;

  if jsonb_typeof(profile) is distinct from 'object' then return new; end if;

  insert into fly_delivery.accounts(id,role) values(new.id,'customer')
  on conflict (id) do nothing;
  insert into fly_delivery.customer_profiles(user_id,full_name,phone,cpf_login)
  values(new.id,btrim(profile->>'name'),profile->>'phone',true)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger fd_auth_cpf_customer on auth.users;
create trigger fd_auth_cpf_customer after insert or update of raw_app_meta_data, raw_user_meta_data on auth.users
  for each row when (new.raw_app_meta_data->>'fly_delivery_cpf_login'='true')
  execute function fly_delivery.create_cpf_customer();

insert into fly_delivery.accounts(id,role)
select id,'customer' from auth.users where raw_app_meta_data->>'fly_delivery_cpf_login'='true'
on conflict (id) do nothing;

insert into fly_delivery.customer_profiles(user_id,full_name,phone,cpf_login)
select id,btrim(raw_user_meta_data->'fly_delivery_customer'->>'name'),
  raw_user_meta_data->'fly_delivery_customer'->>'phone',true
from auth.users
where raw_app_meta_data->>'fly_delivery_cpf_login'='true'
  and char_length(btrim(raw_user_meta_data->'fly_delivery_customer'->>'name')) between 3 and 120
  and (raw_user_meta_data->'fly_delivery_customer'->>'phone') ~ '^[1-9][0-9]{9,10}$'
on conflict do nothing;
