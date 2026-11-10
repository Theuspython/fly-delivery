CREATE OR REPLACE FUNCTION fly_delivery.valid_product_options(value jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare opt jsonb;
begin
  if value is null or jsonb_typeof(value)<>'array' then return false; end if;
  for opt in select * from jsonb_array_elements(value) loop
    if jsonb_typeof(opt)<>'object' or jsonb_typeof(opt->'id') is distinct from 'string' or
       coalesce(opt->>'id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or
       jsonb_typeof(opt->'name') is distinct from 'string' or coalesce(char_length(btrim(opt->>'name')),0) not between 1 and 80 or
       jsonb_typeof(opt->'price') is distinct from 'number' or coalesce(opt->>'price','') !~ '^[0-9]{1,7}$' then return false; end if;
    if (opt->>'price')::integer>1000000 then return false; end if;
  end loop;
  return (select count(distinct entry->>'id')=count(*) from jsonb_array_elements(value) entry);
end;
$function$;

CREATE OR REPLACE FUNCTION fly_delivery.resolve_product_options(available jsonb, selected jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  matched_count bigint;
  prices_changed boolean;
  result jsonb;
begin
  if selected is null or jsonb_typeof(selected)<>'array' then
    raise exception 'FD: Revise os opcionais do produto no cardápio.';
  end if;
  if selected='[]'::jsonb then return selected; end if;
  if (select count(distinct choice->>'id')<>count(*) from jsonb_array_elements(selected) choice) then
    raise exception 'FD: Revise os opcionais do produto no cardápio.';
  end if;
  select count(opt),
    bool_or(jsonb_typeof(choice->'price') is distinct from 'number' or choice->>'price' is distinct from opt->>'price'),
    jsonb_agg(opt order by opt->>'id')
  into matched_count,prices_changed,result
  from jsonb_array_elements(selected) choice
  left join jsonb_array_elements(available) opt on opt->>'id'=choice->>'id';
  if matched_count<>jsonb_array_length(selected) then
    raise exception 'FD: Os opcionais mudaram. Volte ao cardápio e revise o carrinho.';
  end if;
  if prices_changed then
    raise exception 'FD: Os preços mudaram. Volte ao cardápio e revise o carrinho.';
  end if;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION fly_delivery.price_order(s fly_delivery.stores, input jsonb, instant timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  items jsonb; item jsonb; p fly_delivery.products;
  total bigint; normalized_items jsonb;
  selected_options jsonb; selected_choices jsonb; choices_key text; item_key text;
  quantity_input integer; unit_price bigint; size_input text; base_price_input integer;
  local_time timestamp:=instant at time zone 'America/Sao_Paulo';
  minute_of_day integer:=extract(hour from local_time)::integer*60+extract(minute from local_time)::integer;
  code_input text:=nullif(upper(btrim(input->>'coupon_code')),'');
  coupon fly_delivery.store_coupons;
  platform_coupon fly_delivery.platform_coupons;
  config fly_delivery.billing_config;
  coupon_rate integer;
  limited_product record;
  eligible bigint;
  coupon_discount integer:=0;
  platform_discount integer:=0;
  promo_rate integer;
  quote jsonb;
begin
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
      -- Keep large combinations within the order_items primary-key index.
      if octet_length(item_key)>2000 then
        item_key:='sha256:'||encode(sha256(convert_to(item_key,'UTF8')),'hex');
      end if;
      if exists(select 1 from jsonb_array_elements(normalized_items) v where v->>'id'=p.id::text and v->>'key'=item_key) then
        raise exception 'FD: Revise os itens disponíveis no cardápio.';
      end if;
      select base_price_input+coalesce(sum((v->>'price')::integer),0) into unit_price from jsonb_array_elements(selected_options) v;
      total:=total+unit_price*quantity_input;
      if total+s.fee>2147483647 then raise exception 'FD: Revise o valor total do carrinho.'; end if;
      normalized_items:=normalized_items || jsonb_build_array(jsonb_build_object('id',p.id,'key',item_key,'name',p.name,'price',unit_price,'quantity',quantity_input,'options',selected_options,'size',size_input,'meal_choices',selected_choices));
    end loop;
    if s.fee is distinct from (input->>'fee')::integer then
      raise exception 'FD: Os preços mudaram. Volte ao cardápio e revise o carrinho.';
    end if;
  for limited_product in
    select p2.id,p2.name,p2.stock_quantity,sum(j.quantity) as requested
    from jsonb_to_recordset(normalized_items) j(id uuid,quantity integer)
      join fly_delivery.products p2 on p2.id=j.id and p2.stock_quantity is not null
    group by p2.id,p2.name,p2.stock_quantity
  loop
    if limited_product.requested + fly_delivery.stock_reserved(limited_product.id) > limited_product.stock_quantity then
      raise exception 'FD: Estoque insuficiente para %. Revise a quantidade no carrinho.',limited_product.name;
    end if;
  end loop;
  promo_rate:=fly_delivery.promotion_rate(instant);
  if code_input is not null then
    select * into platform_coupon from fly_delivery.platform_coupons c where c.code=code_input and c.deleted_at is null;
    if found then
      select * into config from fly_delivery.billing_config where id=true;
      if not platform_coupon.enabled or platform_coupon.expires_on<local_time::date or
        (platform_coupon.store_id is not null and platform_coupon.store_id<>s.id) or
        not coalesce(config.payments_ready,false) or platform_coupon.rate_bps>coalesce(config.commission_bps,0) or
        (platform_coupon.use_limit is not null and fly_delivery.platform_coupon_uses(platform_coupon.id)>=platform_coupon.use_limit) then
        raise exception 'FD: Cupom inválido ou fora do horário de validade.';
      end if;
      if promo_rate is not null then raise exception 'FD: Cupom da plataforma indisponível durante o dia promocional.';end if;
      coupon_rate:=platform_coupon.rate_bps;
      coupon_discount:=round(total::numeric*coupon_rate/10000)::integer;
    else
    select * into coupon from fly_delivery.store_coupons c where c.store_id=s.id and c.code=code_input and c.enabled
      and c.day=local_time::date and c.start_minute<=minute_of_day and c.end_minute>minute_of_day;
    if not found then raise exception 'FD: Cupom inválido ou fora do horário de validade.';end if;
    select coalesce(sum((j.entry->>'price')::bigint*(j.entry->>'quantity')::integer),0) into eligible
      from jsonb_array_elements(normalized_items) j(entry)
      where coupon.product_ids is null or (j.entry->>'id')::uuid=any(coupon.product_ids);
    if eligible=0 then raise exception 'FD: O cupom não se aplica aos produtos deste carrinho.';end if;
      coupon_rate:=coupon.rate_bps;
      coupon_discount:=round(eligible::numeric*coupon_rate/10000)::integer;
    end if;
  end if;
  platform_discount:=coalesce(round((total-coupon_discount)::numeric*promo_rate/10000)::integer,0);
  quote:=jsonb_build_object('gross_subtotal',total,'subtotal',total-coupon_discount-platform_discount,'fee',s.fee,
    'total',total-coupon_discount-platform_discount+s.fee,'coupon_code',coalesce(coupon.code,platform_coupon.code),'coupon_bps',coupon_rate,
    'coupon_discount_cents',coupon_discount,'promotion_bps',promo_rate,'platform_discount_cents',platform_discount);
  if platform_coupon.id is not null then
    quote:=quote||jsonb_build_object('coupon_source','platform','commission_bps',config.commission_bps);
  end if;
  return jsonb_build_object('quote',quote,'items',normalized_items,'platform_coupon_id',platform_coupon.id,
    'platform_coupon_commission_bps',case when platform_coupon.id is not null then config.commission_bps end);
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
  previous_photo text;
  product_category_input text;
  custom_category text;
  category_order_input text[];
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
    select * into s from fly_delivery.stores where id=store_id_input for no key update;
    if not found or not fly_delivery.store_open_at(s,now()) then
      raise exception 'FD: A loja não está aceitando pedidos agora.';
    end if;
    if nullif(btrim(input->>'coupon_code'),'') is not null then
      perform pg_advisory_xact_lock(hashtextextended('fd-platform-coupon',0));
      perform 1 from fly_delivery.billing_config where id=true for share;
    end if;
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
      coupon_code,coupon_bps,coupon_discount_cents,promotion_bps,platform_discount_cents,platform_coupon_id,platform_coupon_commission_bps)
      values(actor,s.id,req,btrim(input->>'address'),input->>'payment',(quote->>'subtotal')::integer,s.fee,note_input,order_time,tendered,
        quote->>'coupon_code',(quote->>'coupon_bps')::integer,(quote->>'coupon_discount_cents')::integer,
        (quote->>'promotion_bps')::integer,(quote->>'platform_discount_cents')::integer,
        (priced->>'platform_coupon_id')::uuid,(priced->>'platform_coupon_commission_bps')::integer)
      returning * into o;
    insert into fly_delivery.order_items(order_id,product_id,name,price,quantity,options,option_key,size,meal_choices)
      select o.id,j.id,j.name,j.price,j.quantity,j.options,j.key,j.size,j.meal_choices
      from jsonb_to_recordset(priced->'items') as j(id uuid,name text,price integer,quantity integer,options jsonb,key text,size text,meal_choices jsonb);
    return fly_delivery.order_details(o,true);
  when 'set_open', 'save_product', 'merchant_adjust_stock', 'save_menu_category_order' then
    if a.role<>'merchant' then raise exception 'FD: Operação exclusiva do estabelecimento.'; end if;
    store_id_input := (input->>'store_id')::uuid;
    select * into s from fly_delivery.stores where id=store_id_input and not sample and deleted_at is null and owner_id=actor for update;
    if not found then raise exception 'FD: Você não tem acesso a esta loja.'; end if;
    if action='set_open' then
      update fly_delivery.stores set is_open=coalesce((input->>'open')::boolean,false) where id=s.id;
      return '{}'::jsonb;
    end if;
    if action='merchant_adjust_stock' then
      return fly_delivery.write_stock(s,(input->>'id')::uuid,input);
    end if;
    if action='save_menu_category_order' then
      if jsonb_typeof(input->'order') is distinct from 'array' then
        raise exception 'FD: Confira a ordem das categorias.';
      end if;
      if jsonb_array_length(input->'order')>cardinality(s.categories || s.menu_categories)
        or exists (select 1 from jsonb_array_elements(input->'order') item where jsonb_typeof(item)<>'string') then
        raise exception 'FD: Confira a ordem das categorias.';
      end if;
      select coalesce(array_agg(label order by position),'{}')
        into category_order_input
        from jsonb_array_elements_text(input->'order') with ordinality as requested(label,position);
      if not (category_order_input <@ (s.categories || s.menu_categories))
        or cardinality(category_order_input)<>(select count(distinct label) from unnest(category_order_input) as labels(label)) then
        raise exception 'FD: Confira a ordem das categorias. Reabra a lista se alguma categoria mudou.';
      end if;
      update fly_delivery.stores set menu_category_order=category_order_input where id=s.id;
      return jsonb_build_object('id',s.id,'menu_category_order',category_order_input);
    end if;
    if input ? 'new_category' then
      if jsonb_typeof(input->'new_category') is distinct from 'string' then
        raise exception 'FD: Informe um nome para a nova categoria.';
      end if;
      custom_category := btrim(regexp_replace(input->>'new_category','[[:space:]]+',' ','g'));
      if char_length(custom_category) not between 2 and 40 or custom_category ~ '[[:cntrl:]]'
        or lower(custom_category) in ('todas','uncategorized') then
        raise exception 'FD: Use de 2 a 40 caracteres e escolha um nome diferente de Todas.';
      end if;
      select label into product_category_input
        from unnest(s.categories || s.menu_categories) with ordinality as known(label,position)
        where lower(label)=lower(custom_category) order by position limit 1;
      if not found then
        if cardinality(s.menu_categories)>=50 then raise exception 'FD: A loja já tem 50 categorias próprias.'; end if;
        product_category_input := custom_category;
        update fly_delivery.stores set menu_categories=array_append(menu_categories,custom_category)
          where id=s.id returning * into s;
      end if;
    else
      product_category_input := nullif(btrim(input->>'category'),'');
      if product_category_input='Brasileira' and not (product_category_input=any(s.menu_categories)) then
        product_category_input := fly_delivery.category_name(product_category_input);
      end if;
      if product_category_input is null and not (input ? 'category') and nullif(input->>'id','') is not null then
        select category into product_category_input from fly_delivery.products where id=(input->>'id')::uuid and store_id=s.id;
      end if;
      if product_category_input is null and cardinality(s.categories)=1 then product_category_input:=s.categories[1]; end if;
    end if;
    if product_category_input is null or not (product_category_input=any(s.categories || s.menu_categories)) then
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
    if not fly_delivery.valid_product_options(saved_options) then raise exception 'FD: Revise os nomes e valores dos opcionais.'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('id',v->>'id','name',btrim(v->>'name'),'price',(v->>'price')::integer) order by n),'[]'::jsonb)
      into saved_options from jsonb_array_elements(saved_options) with ordinality as j(v,n);
    if input ? 'meal_choices' then saved_choices:=input->'meal_choices';
    elsif nullif(input->>'id','') is not null then
      select meal_choices into saved_choices from fly_delivery.products where id=(input->>'id')::uuid and store_id=s.id;
    else saved_choices:='[]'::jsonb;end if;
    if not fly_delivery.valid_meal_choices(saved_choices,sizes_input,product_category_input) then
      raise exception 'FD: Revise os grupos, tamanhos e escolhas gratuitas dos acompanhamentos.';end if;
    select coalesce(jsonb_agg(g||jsonb_build_object('name',btrim(g->>'name'),'options',
      (select jsonb_agg(opt||jsonb_build_object('name',btrim(opt->>'name')) order by n)
       from jsonb_array_elements(g->'options') with ordinality j(opt,n))) order by ordinal),'[]'::jsonb)
      into saved_choices from jsonb_array_elements(saved_choices) with ordinality j(g,ordinal);
    if nullif(input->>'id','') is not null then
      select image into previous_photo from fly_delivery.products
      where id=(input->>'id')::uuid and store_id=s.id for update;
    end if;
    photo := case when input ? 'image' then nullif(input->>'image','') else previous_photo end;
    if photo is not null and photo is distinct from previous_photo and not fly_delivery.menu_photo_exists(photo,s.id) then
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
    if input ? 'stock_quantity' then perform fly_delivery.write_stock(s,p.id,input);end if;
    return jsonb_build_object('id',p.id,'replaced_photo',case when previous_photo is distinct from p.image then previous_photo end);
  when 'transition' then
    select * into a from fly_delivery.accounts where id=actor and enabled for update;
    if not found then raise exception 'FD: Acesso indisponível.'; end if;
    select * into o from fly_delivery.orders where id=(input->>'id')::uuid for update;
    if not found then raise exception 'FD: Pedido indisponível.'; end if;
    select * into s from fly_delivery.stores where id=o.store_id for no key update;
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
