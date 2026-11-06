-- Rename categories in place; store/product IDs, orders and prices remain intact.
create function fly_delivery.category_name(value text)
returns text language sql immutable set search_path=''
as $$select case value when 'Brasileira' then 'Porções' when 'Outros' then 'Bebidas' else value end;$$;
revoke all on function fly_delivery.category_name(text) from public,anon,authenticated;

lock table fly_delivery.stores,fly_delivery.products in share row exclusive mode;
alter table fly_delivery.stores drop constraint stores_category_check;
update fly_delivery.stores s set category=fly_delivery.category_name(s.category),
  categories=array(select name from (
    select fly_delivery.category_name(value) as name,min(ordinal) as first_position
    from unnest(s.categories) with ordinality j(value,ordinal) group by 1
  ) renamed order by first_position)
where s.category in ('Brasileira','Outros') or s.categories && array['Brasileira','Outros'];
update fly_delivery.products set category=fly_delivery.category_name(category) where category in ('Brasileira','Outros');
alter table fly_delivery.stores add constraint stores_category_check
  check(category in ('Hambúrguer','Pizza','Marmitex','Porções','Açaí','Telecerveja','Japonesa','Bebidas'));

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
  total bigint;
  item jsonb;
  selected_options jsonb;
  saved_options jsonb;
  saved_choices jsonb; selected_choices jsonb; choices_key text;
  normalized_items jsonb;
  item_key text;
  quantity_input integer;
  unit_price integer;
  sizes_input jsonb;
  size_input text;
  base_price_input integer;
  note_input text;
  target_status text;
  photo text;
  product_category_input text;
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
    select * into s from fly_delivery.stores where id=store_id_input and active and is_open and not sample and deleted_at is null for share;
    if not found then raise exception 'FD: A loja não está aceitando pedidos agora.'; end if;
    items := input->'items';
    if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items) not between 1 and 30 then
      raise exception 'FD: Revise os itens do carrinho.';
    end if;
    total:=0;
    normalized_items:='[]'::jsonb;
    for item in select * from jsonb_array_elements(items) loop
      if jsonb_typeof(item)<>'object' or jsonb_typeof(item->'quantity') is distinct from 'number' or
         coalesce(item->>'quantity','') !~ '^[0-9]{1,2}$' then raise exception 'FD: Revise os itens disponíveis no cardápio.'; end if;
      quantity_input:=(item->>'quantity')::integer;
      if quantity_input not between 1 and 25 then raise exception 'FD: Revise os itens disponíveis no cardápio.'; end if;
      select * into p from fly_delivery.products where id=(item->>'id')::uuid and store_id=s.id and active for share;
      if not found then raise exception 'FD: Revise os itens disponíveis no cardápio.'; end if;
      if item ? 'size' and jsonb_typeof(item->'size') not in ('string','null') then
        raise exception 'FD: Selecione um tamanho disponível no cardápio.';
      end if;
      size_input:=nullif(btrim(item->>'size'),'');
      if jsonb_array_length(p.sizes)>0 then
        select (v->>'price')::integer into base_price_input from jsonb_array_elements(p.sizes) v where v->>'name'=size_input;
        if not found then raise exception 'FD: Selecione um tamanho disponível no cardápio.'; end if;
      else
        if size_input is not null then raise exception 'FD: Selecione um tamanho disponível no cardápio.'; end if;
        base_price_input:=p.price;
      end if;
      if jsonb_typeof(item->'price') is distinct from 'number' or base_price_input::text is distinct from item->>'price' then
        raise exception 'FD: Os preços mudaram. Volte ao cardápio e revise o carrinho.';
      end if;
      selected_options:=fly_delivery.resolve_product_options(p.options,coalesce(item->'options','[]'::jsonb));
      selected_choices:=fly_delivery.resolve_meal_choices(p.meal_choices,coalesce(item->'meal_choices','[]'::jsonb),size_input);
      select coalesce(string_agg(v->>'id',',' order by v->>'id'),'') into item_key from jsonb_array_elements(selected_options) v;
      if selected_choices<>'[]'::jsonb then
        select string_agg(g->>'id'||':'||(opt->>'id'),',' order by g->>'id',opt->>'id') into choices_key
          from jsonb_array_elements(selected_choices) g cross join jsonb_array_elements(g->'options') opt;
        item_key:=item_key||'|meal:'||choices_key;
      end if;
      if size_input is not null then item_key:=size_input || ':' || item_key; end if;
      if exists(select 1 from jsonb_array_elements(normalized_items) v where v->>'id'=p.id::text and v->>'key'=item_key) then
        raise exception 'FD: Revise os itens disponíveis no cardápio.';
      end if;
      select base_price_input+coalesce(sum((v->>'price')::integer),0) into unit_price from jsonb_array_elements(selected_options) v;
      total:=total+unit_price::bigint*quantity_input;
      if total+s.fee>2147483647 then raise exception 'FD: Revise o valor total do carrinho.'; end if;
      normalized_items:=normalized_items || jsonb_build_array(jsonb_build_object('id',p.id,'key',item_key,'name',p.name,'price',unit_price,'quantity',quantity_input,'options',selected_options,'size',size_input,'meal_choices',selected_choices));
    end loop;
    if s.fee is distinct from (input->>'fee')::integer then
      raise exception 'FD: Os preços mudaram. Volte ao cardápio e revise o carrinho.';
    end if;
    note_input:=coalesce(btrim(input->>'note'),'');
    if char_length(note_input)>500 or (input ? 'note' and jsonb_typeof(input->'note') is distinct from 'string') then
      raise exception 'FD: A observação deve ter até 500 caracteres.';
    end if;
    if coalesce(char_length(btrim(input->>'address')),0) not between 5 and 240 or
       coalesce(input->>'payment','') not in ('pix_delivery','card_delivery','cash_delivery') then
      raise exception 'FD: Confira o endereço e a forma de pagamento.';
    end if;
    insert into fly_delivery.orders(customer_id,store_id,request_id,address,payment,subtotal,fee,customer_note)
      values(actor,s.id,req,btrim(input->>'address'),input->>'payment',total::integer,s.fee,note_input)
      returning * into o;
    insert into fly_delivery.order_items(order_id,product_id,name,price,quantity,options,option_key,size,meal_choices)
      select o.id,j.id,j.name,j.price,j.quantity,j.options,j.key,j.size,j.meal_choices
      from jsonb_to_recordset(normalized_items) as j(id uuid,name text,price integer,quantity integer,options jsonb,key text,size text,meal_choices jsonb);
    insert into fly_delivery.order_events(order_id,actor_id,status) values(o.id,actor,o.status);
    return fly_delivery.order_details(o,true);
  when 'set_open', 'save_product' then
    if a.role<>'merchant' then raise exception 'FD: Operação exclusiva do estabelecimento.'; end if;
    store_id_input := (input->>'store_id')::uuid;
    select * into s from fly_delivery.stores where id=store_id_input and not sample and deleted_at is null and owner_id=actor for update;
    if not found then raise exception 'FD: Você não tem acesso a esta loja.'; end if;
    if action='set_open' then
      update fly_delivery.stores set is_open=coalesce((input->>'open')::boolean,false) where id=s.id;
      return '{}'::jsonb;
    end if;
    product_category_input := nullif(fly_delivery.category_name(btrim(input->>'category')),'');
    if product_category_input is null and not (input ? 'category') and nullif(input->>'id','') is not null then
      select category into product_category_input from fly_delivery.products where id=(input->>'id')::uuid and store_id=s.id;
    end if;
    if product_category_input is null and cardinality(s.categories)=1 then product_category_input:=s.categories[1]; end if;
    if product_category_input is null or not (product_category_input=any(s.categories)) then
      raise exception 'FD: Selecione uma das categorias do estabelecimento para o produto.';
    end if;
    if input ? 'sizes' then sizes_input:=input->'sizes';
    elsif nullif(input->>'id','') is not null then
      select sizes into sizes_input from fly_delivery.products where id=(input->>'id')::uuid and store_id=s.id;
    else sizes_input:='[]'::jsonb; end if;
    if not fly_delivery.valid_product_sizes(sizes_input) then raise exception 'FD: Revise os tamanhos P, M e G e seus preços.'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('name',v->>'name','price',(v->>'price')::integer) order by array_position(array['P','M','G'],v->>'name')),'[]'::jsonb)
      into sizes_input from jsonb_array_elements(sizes_input) v;
    if jsonb_array_length(sizes_input)>0 then
      select min((v->>'price')::integer) into base_price_input from jsonb_array_elements(sizes_input) v;
    else base_price_input:=(input->>'price')::integer; end if;
    if input ? 'options' then saved_options:=input->'options';
    elsif nullif(input->>'id','') is not null then
      select options into saved_options from fly_delivery.products where id=(input->>'id')::uuid and store_id=s.id;
    else saved_options:='[]'::jsonb; end if;
    if not fly_delivery.valid_product_options(saved_options) then raise exception 'FD: Revise os nomes e valores dos opcionais (até 20 por produto).'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('id',v->>'id','name',btrim(v->>'name'),'price',(v->>'price')::integer) order by n),'[]'::jsonb)
      into saved_options from jsonb_array_elements(saved_options) with ordinality as j(v,n);
    if input ? 'meal_choices' then saved_choices:=input->'meal_choices';
    elsif product_category_input='Marmitex' and nullif(input->>'id','') is not null then
      select meal_choices into saved_choices from fly_delivery.products where id=(input->>'id')::uuid and store_id=s.id;
    else saved_choices:='[]'::jsonb;end if;
    if not fly_delivery.valid_meal_choices(saved_choices,sizes_input,product_category_input) then
      raise exception 'FD: Revise os grupos, tamanhos e escolhas gratuitas do Marmitex.';end if;
    select coalesce(jsonb_agg(g||jsonb_build_object('name',btrim(g->>'name'),'options',
      (select jsonb_agg(opt||jsonb_build_object('name',btrim(opt->>'name')) order by n)
       from jsonb_array_elements(g->'options') with ordinality j(opt,n))) order by ordinal),'[]'::jsonb)
      into saved_choices from jsonb_array_elements(saved_choices) with ordinality j(g,ordinal);
    photo := nullif(input->>'image','');
    if photo is not null and photo !~ ('^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/fly-delivery-menu/' || s.id::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$') then
      raise exception 'FD: Envie a foto pelo painel da loja.';
    end if;
    if nullif(input->>'id','') is null then
      insert into fly_delivery.products(store_id,name,description,price,image,active,category,options,sizes,meal_choices)
        values(s.id,btrim(input->>'name'),coalesce(btrim(input->>'description'),''),base_price_input,
          photo,coalesce((input->>'active')::boolean,true),product_category_input,saved_options,sizes_input,saved_choices) returning * into p;
    else
      update fly_delivery.products set name=btrim(input->>'name'),description=coalesce(btrim(input->>'description'),''),
        price=base_price_input,image=photo,category=product_category_input,options=saved_options,sizes=sizes_input,meal_choices=saved_choices,active=coalesce((input->>'active')::boolean,true)
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

CREATE OR REPLACE FUNCTION fly_delivery.admin_manage_store(action_name text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  shop fly_delivery.stores;
  chosen_categories text[];
  store_name text:=btrim(payload->>'name');
begin
  if fly_delivery.actor_role() is distinct from 'admin' then raise exception 'FD: Acesso restrito à administração.'; end if;
  select * into shop from fly_delivery.stores where id=(payload->>'id')::uuid and not sample and deleted_at is null for update;
  if not found then raise exception 'FD: Estabelecimento não encontrado.'; end if;
  if action_name='admin_update_store' then
    if coalesce(char_length(store_name),0) not between 2 and 80 or jsonb_typeof(payload->'categories') is distinct from 'array' then
      raise exception 'FD: Informe o nome e as categorias do estabelecimento.';
    end if;
    select array_agg(distinct fly_delivery.category_name(value) order by fly_delivery.category_name(value)) into chosen_categories from jsonb_array_elements_text(payload->'categories');
    if chosen_categories is null or not (chosen_categories <@ array['Hambúrguer','Pizza','Marmitex','Porções','Açaí','Telecerveja','Japonesa','Bebidas']) then
      raise exception 'FD: Selecione pelo menos uma categoria válida.';
    end if;
    update fly_delivery.stores set name=store_name,categories=chosen_categories,category=chosen_categories[1] where id=shop.id;
    update fly_delivery.products set category=null where store_id=shop.id and category is not null and not (category=any(chosen_categories));
    return jsonb_build_object('id',shop.id);
  elsif action_name='admin_delete_store' then
    if exists(select 1 from fly_delivery.orders where store_id=shop.id and status not in ('delivered','cancelled')) then
      raise exception 'FD: Finalize ou cancele os pedidos em andamento antes de excluir o estabelecimento.';
    end if;
    perform fly_delivery.close_daily_invoices(shop.id);
    if exists(select 1 from fly_delivery.daily_invoices where store_id=shop.id and status='pending') or exists(select 1 from fly_delivery.orders where store_id=shop.id and platform_fee_cents>0 and (completed_at at time zone 'America/Sao_Paulo')::date=(now() at time zone 'America/Sao_Paulo')::date) then raise exception 'FD: Regularize as faturas da plataforma antes de excluir o estabelecimento.'; end if;
    update fly_delivery.stores set deleted_at=clock_timestamp(),active=false,is_open=false where id=shop.id;
    if shop.owner_id is not null and not exists(select 1 from fly_delivery.stores where owner_id=shop.owner_id and deleted_at is null and not sample) then
      update fly_delivery.accounts set enabled=false,online=false where id=shop.owner_id and role='merchant';
    end if;
    return jsonb_build_object('id',shop.id,'deleted',true);
  end if;
  raise exception 'FD: Operação inválida.';
exception when invalid_text_representation or check_violation then
  raise exception 'FD: Confira os dados do estabelecimento.';
end;
$function$;

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
    where st.id=store_id and not st.sample and st.deleted_at is null and not exists (
      select 1 from auth.users u where u.id=st.owner_id and u.raw_app_meta_data ? 'fly_delivery_operator'
    ) returning st.* into s;
    if not found then raise exception 'FD: Esta loja já tem um login ou está indisponível.'; end if;
    return jsonb_build_object('id',s.id);
  end if;

  if jsonb_typeof(payload->'categories') is distinct from 'array' or coalesce(char_length(store_name),0) not between 2 and 80 then
    raise exception 'FD: Informe o nome e as categorias da loja.';
  end if;
  select array_agg(distinct fly_delivery.category_name(value) order by fly_delivery.category_name(value)) into chosen_categories from jsonb_array_elements_text(payload->'categories');
  if chosen_categories is null or not (chosen_categories <@ array['Hambúrguer','Pizza','Marmitex','Porções','Açaí','Telecerveja','Japonesa','Bebidas']) then
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
