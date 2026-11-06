-- Preserve prior products and order lines. Options are snapshotted at checkout.
create function fly_delivery.valid_product_options(value jsonb)
returns boolean language plpgsql immutable security invoker set search_path=''
as $$
declare opt jsonb;
begin
  if value is null or jsonb_typeof(value)<>'array' then return false; end if;
  if jsonb_array_length(value)>20 then return false; end if;
  for opt in select * from jsonb_array_elements(value) loop
    if jsonb_typeof(opt)<>'object' or jsonb_typeof(opt->'id') is distinct from 'string' or
       coalesce(opt->>'id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or
       jsonb_typeof(opt->'name') is distinct from 'string' or coalesce(char_length(btrim(opt->>'name')),0) not between 1 and 80 or
       jsonb_typeof(opt->'price') is distinct from 'number' or coalesce(opt->>'price','') !~ '^[0-9]{1,7}$' then return false; end if;
    if (opt->>'price')::integer>1000000 then return false; end if;
  end loop;
  return (select count(distinct entry->>'id')=count(*) from jsonb_array_elements(value) entry);
end;
$$;
revoke all on function fly_delivery.valid_product_options(jsonb) from public,anon,authenticated;
alter table fly_delivery.products add column options jsonb not null default '[]'::jsonb
  constraint fd_product_options_valid check (fly_delivery.valid_product_options(options));
alter table fly_delivery.order_items add column options jsonb not null default '[]'::jsonb;
alter table fly_delivery.order_items add column option_key text not null default '';
alter table fly_delivery.order_items drop constraint order_items_pkey;
alter table fly_delivery.order_items add primary key(order_id,product_id,option_key);

create function fly_delivery.resolve_product_options(available jsonb,selected jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=''
as $$
declare choice jsonb; opt jsonb; result jsonb:='[]'::jsonb;
begin
  if selected is null or jsonb_typeof(selected)<>'array' then raise exception 'FD: Revise os opcionais do produto no cardápio.'; end if;
  if jsonb_array_length(selected)>20 or (select count(distinct v->>'id')<>count(*) from jsonb_array_elements(selected) v) then
    raise exception 'FD: Revise os opcionais do produto no cardápio.';
  end if;
  for choice in select * from jsonb_array_elements(selected) loop
    select v into opt from jsonb_array_elements(available) v where v->>'id'=choice->>'id';
    if opt is null then raise exception 'FD: Os opcionais mudaram. Volte ao cardápio e revise o carrinho.'; end if;
    if jsonb_typeof(choice->'price') is distinct from 'number' or choice->>'price' is distinct from opt->>'price' then
      raise exception 'FD: Os preços mudaram. Volte ao cardápio e revise o carrinho.';
    end if;
    result:=result || jsonb_build_array(opt);
  end loop;
  return coalesce((select jsonb_agg(v order by v->>'id') from jsonb_array_elements(result) v),'[]'::jsonb);
end;
$$;
revoke all on function fly_delivery.resolve_product_options(jsonb,jsonb) from public,anon,authenticated;

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
  normalized_items jsonb;
  item_key text;
  quantity_input integer;
  unit_price integer;
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
      if jsonb_typeof(item->'price') is distinct from 'number' or p.price::text is distinct from item->>'price' then
        raise exception 'FD: Os preços mudaram. Volte ao cardápio e revise o carrinho.';
      end if;
      selected_options:=fly_delivery.resolve_product_options(p.options,coalesce(item->'options','[]'::jsonb));
      select coalesce(string_agg(v->>'id',',' order by v->>'id'),'') into item_key from jsonb_array_elements(selected_options) v;
      if exists(select 1 from jsonb_array_elements(normalized_items) v where v->>'id'=p.id::text and v->>'key'=item_key) then
        raise exception 'FD: Revise os itens disponíveis no cardápio.';
      end if;
      select p.price+coalesce(sum((v->>'price')::integer),0) into unit_price from jsonb_array_elements(selected_options) v;
      total:=total+unit_price::bigint*quantity_input;
      if total+s.fee>2147483647 then raise exception 'FD: Revise o valor total do carrinho.'; end if;
      normalized_items:=normalized_items || jsonb_build_array(jsonb_build_object('id',p.id,'key',item_key,'name',p.name,'price',unit_price,'quantity',quantity_input,'options',selected_options));
    end loop;
    if s.fee is distinct from (input->>'fee')::integer then
      raise exception 'FD: Os preços mudaram. Volte ao cardápio e revise o carrinho.';
    end if;
    if coalesce(char_length(btrim(input->>'address')),0) not between 5 and 240 or
       coalesce(input->>'payment','') not in ('pix_delivery','card_delivery','cash_delivery') then
      raise exception 'FD: Confira o endereço e a forma de pagamento.';
    end if;
    insert into fly_delivery.orders(customer_id,store_id,request_id,address,payment,subtotal,fee)
      values(actor,s.id,req,btrim(input->>'address'),input->>'payment',total::integer,s.fee)
      returning * into o;
    insert into fly_delivery.order_items(order_id,product_id,name,price,quantity,options,option_key)
      select o.id,j.id,j.name,j.price,j.quantity,j.options,j.key
      from jsonb_to_recordset(normalized_items) as j(id uuid,name text,price integer,quantity integer,options jsonb,key text);
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
    product_category_input := nullif(btrim(input->>'category'),'');
    if product_category_input is null and not (input ? 'category') and nullif(input->>'id','') is not null then
      select category into product_category_input from fly_delivery.products where id=(input->>'id')::uuid and store_id=s.id;
    end if;
    if product_category_input is null and cardinality(s.categories)=1 then product_category_input:=s.categories[1]; end if;
    if product_category_input is null or not (product_category_input=any(s.categories)) then
      raise exception 'FD: Selecione uma das categorias do estabelecimento para o produto.';
    end if;
    if input ? 'options' then saved_options:=input->'options';
    elsif nullif(input->>'id','') is not null then
      select options into saved_options from fly_delivery.products where id=(input->>'id')::uuid and store_id=s.id;
    else saved_options:='[]'::jsonb; end if;
    if not fly_delivery.valid_product_options(saved_options) then raise exception 'FD: Revise os nomes e valores dos opcionais (até 20 por produto).'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('id',v->>'id','name',btrim(v->>'name'),'price',(v->>'price')::integer) order by n),'[]'::jsonb)
      into saved_options from jsonb_array_elements(saved_options) with ordinality as j(v,n);
    photo := nullif(input->>'image','');
    if photo is not null and photo !~ ('^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/fly-delivery-menu/' || s.id::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$') then
      raise exception 'FD: Envie a foto pelo painel da loja.';
    end if;
    if nullif(input->>'id','') is null then
      insert into fly_delivery.products(store_id,name,description,price,image,active,category,options)
        values(s.id,btrim(input->>'name'),coalesce(btrim(input->>'description'),''),(input->>'price')::integer,
          photo,coalesce((input->>'active')::boolean,true),product_category_input,saved_options) returning * into p;
    else
      update fly_delivery.products set name=btrim(input->>'name'),description=coalesce(btrim(input->>'description'),''),
        price=(input->>'price')::integer,image=photo,category=product_category_input,options=saved_options,active=coalesce((input->>'active')::boolean,true)
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
CREATE OR REPLACE FUNCTION fly_delivery.market_catalog()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',st.id,'name',st.name,'description',st.description,'category',st.category,'categories',st.categories,
    'image',st.image,'is_open',fly_delivery.store_open_at(st,now()),
    'fee',st.fee,'eta',st.eta,
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',pr.id,'name',pr.name,'description',pr.description,
      'price',pr.price,'image',pr.image,'category',pr.category,'options',pr.options) order by pr.name)
      from fly_delivery.products pr where pr.store_id=st.id and pr.active),'[]'::jsonb))
    order by fly_delivery.store_open_at(st,now()) desc,st.name),'[]'::jsonb)
  from fly_delivery.stores st
  where st.active and not st.sample and st.deleted_at is null and st.address is not null;
$function$;
CREATE OR REPLACE FUNCTION fly_delivery.order_details(o fly_delivery.orders, reveal boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object('id',o.id,'store_id',s.id,'store',s.name,'status',o.status,
    'created_at',o.created_at,'updated_at',o.updated_at,'fee',o.fee,'distance_km',o.distance_km,
    'pickup',s.address,'pickup_lat',s.lat,'pickup_lng',s.lng)
    || case when reveal then jsonb_build_object('address',o.address,'lat',o.lat,'lng',o.lng,
      'subtotal',o.subtotal,'payment',o.payment,'courier_assigned',o.courier_id is not null,
      'items',coalesce((select jsonb_agg(jsonb_build_object('name',i.name,'price',i.price,'quantity',i.quantity,'options',i.options) order by i.name)
        from fly_delivery.order_items i where i.order_id=o.id),'[]'::jsonb),
      'events',coalesce((select jsonb_agg(jsonb_build_object('status',e.status,'created_at',e.created_at) order by e.id)
        from fly_delivery.order_events e where e.order_id=o.id),'[]'::jsonb)) else '{}'::jsonb end
  from fly_delivery.stores s where s.id=o.store_id;
$function$;
