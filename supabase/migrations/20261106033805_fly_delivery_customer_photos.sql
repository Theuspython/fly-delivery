-- Private customer profile images, scoped to the customer and stores handling their orders.
alter table fly_delivery.customer_profiles add column photo_path text;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('fly-delivery-profiles','fly-delivery-profiles',false,3145728,array['image/jpeg','image/png','image/webp']);

create function fly_delivery.can_access_profile_photo(object_name text,writing boolean default false)
returns boolean language sql stable security definer set search_path = ''
as $$
  select object_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$' and exists (
    select 1 from fly_delivery.accounts a where a.id=(select auth.uid()) and a.enabled and (
      (a.role='customer' and a.id::text=split_part(object_name,'/',1) and exists (
        select 1 from fly_delivery.customer_profiles p where p.user_id=a.id
      )) or
      (not writing and a.role='merchant' and exists (
        select 1 from fly_delivery.orders o join fly_delivery.stores s on s.id=o.store_id
        join fly_delivery.customer_profiles p on p.user_id=o.customer_id
        where s.owner_id=a.id and p.photo_path=object_name
      ))
    )
  );
$$;
revoke all on function fly_delivery.can_access_profile_photo(text,boolean) from public,anon,authenticated;
grant execute on function fly_delivery.can_access_profile_photo(text,boolean) to authenticated;
create policy fd_profile_photo_insert on storage.objects for insert to authenticated
  with check (bucket_id='fly-delivery-profiles' and fly_delivery.can_access_profile_photo(name,true));
create policy fd_profile_photo_select on storage.objects for select to authenticated
  using (bucket_id='fly-delivery-profiles' and fly_delivery.can_access_profile_photo(name,false));
create policy fd_profile_photo_delete on storage.objects for delete to authenticated
  using (bucket_id='fly-delivery-profiles' and fly_delivery.can_access_profile_photo(name,true));

create function fly_delivery.save_customer_photo(payload jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  object_name text := payload->>'path';
begin
  if actor is null or fly_delivery.actor_role() is distinct from 'customer' then
    raise exception 'FD: Foto exclusiva do perfil do cliente.';
  end if;
  if object_name is null or not fly_delivery.can_access_profile_photo(object_name,true) or not exists (
    select 1 from storage.objects where bucket_id='fly-delivery-profiles' and name=object_name
  ) then raise exception 'FD: Envie sua foto pelo formulário da sua conta.'; end if;
  update fly_delivery.customer_profiles set photo_path=object_name where user_id=actor;
  if not found then raise exception 'FD: Complete seu cadastro antes de enviar a foto.'; end if;
  return fly_delivery.customer_profile('{}'::jsonb);
end;
$$;
revoke all on function fly_delivery.save_customer_photo(jsonb) from public,anon,authenticated;
grant execute on function fly_delivery.save_customer_photo(jsonb) to authenticated;

CREATE OR REPLACE FUNCTION fly_delivery.customer_profile(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  return jsonb_build_object('name',profile.full_name,'phone',profile.phone,'photo',profile.photo_path);
end;
$function$;

CREATE OR REPLACE FUNCTION fly_delivery.merchant_order_details(o fly_delivery.orders)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select fly_delivery.order_details(o,true) || jsonb_build_object(
    'customer_name',coalesce(nullif(o.customer_name,''),'Cliente'),
    'completed_at',o.completed_at,
    'customer_photo',(select p.photo_path from fly_delivery.customer_profiles p where p.user_id=o.customer_id)
  );
$function$;

CREATE OR REPLACE FUNCTION public.fd_api(action text, input jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  if actor_role='courier' then raise exception 'FD: O acesso de entregadores foi encerrado.'; end if;
  if action in ('customer_address','save_customer_address') then
    return fly_delivery.customer_address(action,input);
  end if;
  if action in ('merchant_active_orders','merchant_history','merchant_finance') then
    return fly_delivery.merchant_workspace(action,input);
  end if;
  if action='save_customer_photo' then return fly_delivery.save_customer_photo(input); end if;
  if action='customer_profile' then return fly_delivery.customer_profile(input); end if;
  if action='assign_operator' then return fly_delivery.assign_operator(input); end if;
  if action='managed_stores' then return fly_delivery.operator_stores(); end if;
  if action in ('couriers','presence','offers','set_courier') then
    raise exception 'FD: A entrega é realizada pelo próprio estabelecimento.';
  end if;
  if action='save_store_profile' then return fly_delivery.save_store_profile(input); end if;
  if action in ('save_store','register_store') then raise exception 'FD: Use o cadastro de acessos da administração.'; end if;
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
$function$;
