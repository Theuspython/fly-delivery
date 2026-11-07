-- Store the customer's tendered cash independently of the order total.
alter table fly_delivery.orders add column cash_tendered_cents integer;
alter table fly_delivery.orders add constraint orders_valid_cash_tendered check (
  cash_tendered_cents is null or (payment='cash_delivery' and cash_tendered_cents >= subtotal::bigint + fee)
);

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
  saved_options jsonb;
  saved_choices jsonb;
  priced jsonb;
  quote jsonb;
  order_time timestamptz;
  sizes_input jsonb;
  base_price_input integer;
  note_input text;
  tendered integer;
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
  when 'quote_order' then
    if a.role<>'customer' then raise exception 'FD: Operação exclusiva do cliente.';end if;
    select * into s from fly_delivery.stores where id=(input->>'store_id')::uuid for share;
    if not found or not fly_delivery.store_open_at(s,now()) then raise exception 'FD: A loja não está aceitando pedidos agora.';end if;
    return fly_delivery.price_order(s,input,clock_timestamp())->'quote';
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
    order_time:=clock_timestamp();
    priced:=fly_delivery.price_order(s,input,order_time);
    quote:=priced->'quote';
    if (input ? 'quote' or (quote->>'coupon_code') is not null or (quote->>'platform_discount_cents')::integer>0)
      and input->'quote' is distinct from quote then
      raise exception 'FD: Os descontos mudaram. Confira o total atualizado antes de confirmar.';
    end if;
    note_input:=coalesce(btrim(input->>'note'),'');
    if char_length(note_input)>500 or (input ? 'note' and jsonb_typeof(input->'note') is distinct from 'string') then
      raise exception 'FD: A observação deve ter até 500 caracteres.';
    end if;
    if coalesce(char_length(btrim(input->>'address')),0) not between 5 and 240 or
       coalesce(input->>'payment','') not in ('pix_delivery','card_delivery','cash_delivery') then
      raise exception 'FD: Confira o endereço e a forma de pagamento.';
    end if;
    -- Older installed clients can still submit orders while their PWA updates.
    if input ? 'cash_tendered_cents' then
      if input->>'payment'='cash_delivery' then
        if jsonb_typeof(input->'cash_tendered_cents') is distinct from 'number'
           or coalesce(input->>'cash_tendered_cents','') !~ '^[0-9]{1,10}$' then
          raise exception 'FD: Informe um valor em dinheiro válido.';
        end if;
        if (input->>'cash_tendered_cents')::bigint not between (quote->>'total')::integer and 2147483647 then
          raise exception 'FD: Informe um valor em dinheiro igual ou maior que o total do pedido.';
        end if;
        tendered:=(input->>'cash_tendered_cents')::integer;
      elsif input->'cash_tendered_cents'<>'null'::jsonb then
        raise exception 'FD: O troco está disponível apenas para pagamento em dinheiro.';
      end if;
    end if;
    insert into fly_delivery.orders(customer_id,store_id,request_id,address,payment,subtotal,fee,customer_note,created_at,cash_tendered_cents,
      coupon_code,coupon_bps,coupon_discount_cents,promotion_bps,platform_discount_cents)
      values(actor,s.id,req,btrim(input->>'address'),input->>'payment',(quote->>'subtotal')::integer,s.fee,note_input,order_time,tendered,
        quote->>'coupon_code',(quote->>'coupon_bps')::integer,(quote->>'coupon_discount_cents')::integer,
        (quote->>'promotion_bps')::integer,(quote->>'platform_discount_cents')::integer)
      returning * into o;
    insert into fly_delivery.order_items(order_id,product_id,name,price,quantity,options,option_key,size,meal_choices)
      select o.id,j.id,j.name,j.price,j.quantity,j.options,j.key,j.size,j.meal_choices
      from jsonb_to_recordset(priced->'items') as j(id uuid,name text,price integer,quantity integer,options jsonb,key text,size text,meal_choices jsonb);
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
    return fly_delivery.order_details(o,true);
  else raise exception 'FD: Comando inválido.';
  end case;
exception
  when invalid_text_representation or check_violation or not_null_violation or numeric_value_out_of_range then
    raise exception 'FD: Confira os dados preenchidos.';
end;
$function$;

CREATE OR REPLACE FUNCTION fly_delivery.order_details(o fly_delivery.orders, reveal boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object('id',o.id,'store_id',s.id,'store',s.name,'status',o.status,
    'created_at',o.created_at,'updated_at',o.updated_at,'fee',o.fee,
    'pickup',s.address,'pickup_lat',s.lat,'pickup_lng',s.lng)
    || case when reveal then jsonb_build_object('subtotal',o.subtotal,'gross_subtotal',o.subtotal::bigint+o.coupon_discount_cents+o.platform_discount_cents,
      'coupon_code',o.coupon_code,'coupon_discount_cents',o.coupon_discount_cents,'platform_discount_cents',o.platform_discount_cents,
      'promotion_bps',o.promotion_bps,'payment',o.payment,'cash_tendered_cents',o.cash_tendered_cents,'note',o.customer_note,'courier_assigned',o.courier_id is not null,
      'items',coalesce((select jsonb_agg(jsonb_build_object('name',i.name,'price',i.price,'quantity',i.quantity,'options',i.options,'size',i.size,'meal_choices',i.meal_choices) order by i.name)
        from fly_delivery.order_items i where i.order_id=o.id),'[]'::jsonb),
       'events',coalesce((select jsonb_agg(e.event-'actor_id'-'id' order by e.ordinal)
        from jsonb_array_elements(o.status_history) with ordinality e(event,ordinal)),'[]'::jsonb)) else '{}'::jsonb end
    || case when (select fly_delivery.actor_role())='merchant' and
      (o.status='placed' or (o.status='cancelled' and o.accepted_at is null))
      then jsonb_build_object('address_hidden',true)
      when reveal then jsonb_build_object('address',o.address,'lat',o.lat,'lng',o.lng,'distance_km',o.distance_km)
      else jsonb_build_object('distance_km',o.distance_km) end
  from fly_delivery.stores s where s.id=o.store_id;
$function$;
