-- Add the two categories without changing existing stores or access rules.
alter table fly_delivery.stores drop constraint stores_category_check;
alter table fly_delivery.stores add constraint stores_category_check
  check (category in ('Hambúrguer','Pizza','Japonesa','Brasileira','Açaí','Telecerveja','Marmitex','Outros'));

CREATE OR REPLACE FUNCTION fly_delivery.assign_operator(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if request_id is null or requested_role is distinct from 'merchant' then raise exception 'FD: Dados do cadastro inválidos.'; end if;
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
  if chosen_categories is null or not (chosen_categories <@ array['Hambúrguer','Pizza','Japonesa','Brasileira','Açaí','Telecerveja','Marmitex','Outros']) then
    raise exception 'FD: Selecione pelo menos uma categoria válida.';
  end if;
  insert into fly_delivery.stores(owner_id,name,category,categories,registration_request)
    values(target_id,store_name,chosen_categories[1],chosen_categories,request_id)
    returning * into s;
  return jsonb_build_object('id',s.id);
exception when invalid_text_representation or unique_violation then
  raise exception 'FD: Confira os dados ou escolha outro login.';
end;
$function$;
