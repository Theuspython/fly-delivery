-- Delivery belongs to each store. Retain historical coordinates and courier IDs,
-- but new orders use only a typed address and never enter the dispatch marketplace.
alter table fly_delivery.orders
  alter column lat drop not null,
  alter column lng drop not null,
  alter column distance_km drop not null;

create or replace function fly_delivery.market_catalog()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',st.id,'name',st.name,'description',st.description,'category',st.category,'categories',st.categories,
    'image',st.image,'is_open',fly_delivery.store_open_at(st,now()),
    'fee',st.fee,'eta',st.eta,
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',pr.id,'name',pr.name,'description',pr.description,
      'price',pr.price,'image',pr.image) order by pr.name)
      from fly_delivery.products pr where pr.store_id=st.id and pr.active),'[]'::jsonb))
    order by fly_delivery.store_open_at(st,now()) desc,st.name),'[]'::jsonb)
  from fly_delivery.stores st
  where st.active and not st.sample and st.address is not null;
$$;

create or replace function fly_delivery.save_store_profile(payload jsonb)
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
  if coalesce(char_length(btrim(payload->>'address')),0)not between 5 and 240 then
    raise exception 'FD: Informe o endereço completo do estabelecimento.';
  end if;
  update fly_delivery.stores set
    description=coalesce(btrim(payload->>'description'),''),address=btrim(payload->>'address'),
    fee=(payload->>'fee')::integer,eta=(payload->>'eta')::integer,
    active=coalesce((payload->>'active')::boolean,false),is_open=case when s.address is null then true else s.is_open end,
    image=picture,weekly_hours=schedule
  where id=s.id;
  return jsonb_build_object('id',s.id);
exception when invalid_text_representation or check_violation or not_null_violation or numeric_value_out_of_range then
  raise exception 'FD: Confira os dados do estabelecimento.';
end;
$$;

create or replace function fly_delivery.assign_operator(payload jsonb)
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

CREATE OR REPLACE FUNCTION fly_delivery.scoped_orders(view_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid();
  profile fly_delivery.accounts;
begin
  select * into profile from fly_delivery.accounts where id=actor and enabled;
  if not found then raise exception 'FD: Acesso indisponível.'; end if;
  if not coalesce((view_name='customer' and profile.role='customer') or
    (view_name='merchant' and profile.role='merchant'),false) then
    raise exception 'FD: Acesso indisponível.';
  end if;
  return coalesce((select jsonb_agg(fly_delivery.order_details(q,true) order by q.created_at desc)
    from (select ord.* from fly_delivery.orders ord join fly_delivery.stores st on st.id=ord.store_id
      where (view_name='customer' and ord.customer_id=actor)
        or (view_name='merchant' and st.owner_id=actor)
      order by ord.created_at desc limit 80) q),'[]'::jsonb);
end;
$function$;
CREATE OR REPLACE FUNCTION fly_delivery.api(action text, input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid();
  a fly_delivery.accounts;
  s fly_delivery.stores;
  o fly_delivery.orders;
  p fly_delivery.products;
  store_id_input uuid;
  req uuid;
  items jsonb;
  total integer;
  total_count integer;
  supplied_count integer;
  target_status text;
  photo text;
  quote_changed boolean;
begin
  if action='catalog' then return fly_delivery.market_catalog(); end if;
  if actor is null then raise exception 'FD: Entre para continuar.'; end if;

  if action='session' then
    insert into fly_delivery.accounts(id) values(actor) on conflict (id) do nothing;
  end if;
  select * into a from fly_delivery.accounts where id=actor;
  if a.id is null or not a.enabled or a.role='courier' then raise exception 'FD: Acesso indisponível.'; end if;

  case action
  when 'session' then
    return jsonb_build_object('id',a.id,'email',auth.jwt()->>'email','role',a.role,'online',a.online);
  when 'orders' then
    return fly_delivery.scoped_orders(coalesce(input->>'view',a.role));
  when 'place' then
    if a.role<>'customer' then raise exception 'FD: Operação exclusiva do cliente.'; end if;
    if fly_delivery.customer_profile('{}'::jsonb) is null then raise exception 'FD: Complete seu cadastro antes de fazer o pedido.'; end if;
    req := (input->>'request_id')::uuid;
    if req is null then raise exception 'FD: Identificador do pedido inválido.'; end if;
    perform pg_advisory_xact_lock(hashtextextended(actor::text || req::text, 0));
    select * into o from fly_delivery.orders where customer_id=actor and request_id=req;
    if found then return fly_delivery.order_details(o,true); end if;
    store_id_input := (input->>'store_id')::uuid;
    perform fly_delivery.check_store_open(store_id_input,req);
    select * into s from fly_delivery.stores where id=store_id_input and active and is_open and not sample for share;
    if not found then raise exception 'FD: A loja não está aceitando pedidos agora.'; end if;
    items := input->'items';
    if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items) not between 1 and 30 then
      raise exception 'FD: Revise os itens do carrinho.';
    end if;
    supplied_count := jsonb_array_length(items);
    select count(*), coalesce(sum(pr.price*j.quantity),0), coalesce(bool_or(pr.price is distinct from j.price),false)
      into total_count,total,quote_changed
    from jsonb_to_recordset(items) as j(id uuid, quantity integer, price integer)
    join (select * from fly_delivery.products where store_id=s.id and active for share) pr on pr.id=j.id
    where j.quantity between 1 and 25;
    if total_count<>supplied_count or total<=0 or
       (select count(distinct item->>'id') from jsonb_array_elements(items) item)<>supplied_count then
      raise exception 'FD: Revise os itens disponíveis no cardápio.';
    end if;
    if quote_changed or s.fee is distinct from (input->>'fee')::integer then
      raise exception 'FD: Os preços mudaram. Volte ao cardápio e revise o carrinho.';
    end if;
    if coalesce(char_length(btrim(input->>'address')),0) not between 5 and 240 or
       coalesce(input->>'payment','') not in ('pix_delivery','card_delivery','cash_delivery') then
      raise exception 'FD: Confira o endereço e a forma de pagamento.';
    end if;
    insert into fly_delivery.orders(customer_id,store_id,request_id,address,payment,subtotal,fee)
      values(actor,s.id,req,btrim(input->>'address'),input->>'payment',total,s.fee)
      returning * into o;
    insert into fly_delivery.order_items(order_id,product_id,name,price,quantity)
      select o.id,pr.id,pr.name,pr.price,j.quantity from jsonb_to_recordset(items) as j(id uuid,quantity integer)
      join fly_delivery.products pr on pr.id=j.id;
    insert into fly_delivery.order_events(order_id,actor_id,status) values(o.id,actor,o.status);
    return fly_delivery.order_details(o,true);
  when 'set_open', 'save_product' then
    if a.role<>'merchant' then raise exception 'FD: Operação exclusiva do estabelecimento.'; end if;
    store_id_input := (input->>'store_id')::uuid;
    select * into s from fly_delivery.stores where id=store_id_input and not sample and owner_id=actor for update;
    if not found then raise exception 'FD: Você não tem acesso a esta loja.'; end if;
    if action='set_open' then
      update fly_delivery.stores set is_open=coalesce((input->>'open')::boolean,false) where id=s.id;
      return '{}'::jsonb;
    end if;
    photo := nullif(input->>'image','');
    if photo is not null and photo !~ ('^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/fly-delivery-menu/' || s.id::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$') then
      raise exception 'FD: Envie a foto pelo painel da loja.';
    end if;
    if nullif(input->>'id','') is null then
      insert into fly_delivery.products(store_id,name,description,price,image,active)
        values(s.id,btrim(input->>'name'),coalesce(btrim(input->>'description'),''),(input->>'price')::integer,
          photo,coalesce((input->>'active')::boolean,true)) returning * into p;
    else
      update fly_delivery.products set name=btrim(input->>'name'),description=coalesce(btrim(input->>'description'),''),
        price=(input->>'price')::integer,image=photo,active=coalesce((input->>'active')::boolean,true)
        where id=(input->>'id')::uuid and store_id=s.id returning * into p;
    end if;
    if p.id is null then raise exception 'FD: Produto não encontrado.'; end if;
    return jsonb_build_object('id',p.id);
  when 'transition' then
    select * into a from fly_delivery.accounts where id=actor and enabled for update;
    if not found then raise exception 'FD: Acesso indisponível.'; end if;
    select * into o from fly_delivery.orders where id=(input->>'id')::uuid for update;
    if not found then raise exception 'FD: Pedido indisponível.'; end if;
    select * into s from fly_delivery.stores where id=o.store_id for share;
    target_status := input->>'status';
    -- Requests from an older open shop tab also mark the order as dispatched.
    if target_status='ready' then target_status:='picked_up'; end if;
    if not coalesce(
      (a.role='merchant' and s.owner_id=actor and (
        (o.status='placed' and target_status='preparing') or
        (o.status in ('preparing','ready','assigned') and target_status='picked_up') or
        (o.status='picked_up' and target_status='delivered') or
        (o.status in ('placed','preparing','ready','assigned') and target_status='cancelled')
      )) or
      (a.role='customer' and o.customer_id=actor and o.status='placed' and target_status='cancelled'),false)
    then raise exception 'FD: Esta etapa não está disponível para você.'; end if;
    update fly_delivery.orders set status=target_status,updated_at=now() where id=o.id returning * into o;
    insert into fly_delivery.order_events(order_id,actor_id,status) values(o.id,actor,o.status);
    return fly_delivery.order_details(o,true);
  else raise exception 'FD: Comando inválido.';
  end case;
exception
  when invalid_text_representation or check_violation or not_null_violation or numeric_value_out_of_range then
    raise exception 'FD: Confira os dados preenchidos.';
end;
$function$;
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
  if actor_role='courier' then raise exception 'FD: O acesso de entregadores foi encerrado.'; end if;
  if action in ('merchant_active_orders','merchant_history','merchant_finance') then
    return fly_delivery.merchant_workspace(action,input);
  end if;
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
$$;

-- Legacy courier listing is no longer available even through a direct private-schema call.
revoke all on function fly_delivery.operator_couriers() from public,anon,authenticated;
