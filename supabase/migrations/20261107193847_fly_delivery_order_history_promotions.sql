-- Preserve the complete event history in each order before retiring the event table.
lock table fly_delivery.orders, fly_delivery.order_events in share row exclusive mode;
alter table fly_delivery.orders
  add column status_history jsonb not null default '[]' check (jsonb_typeof(status_history)='array'),
  add column accepted_at timestamptz,
  add column dispatched_at timestamptz,
  add column cancelled_at timestamptz,
  add column coupon_code text,
  add column coupon_bps integer check (coupon_bps between 1 and 10000),
  add column coupon_discount_cents integer not null default 0 check (coupon_discount_cents>=0),
  add column promotion_bps integer check (promotion_bps between 0 and 10000),
  add column platform_discount_cents integer not null default 0 check (platform_discount_cents>=0),
  drop constraint orders_subtotal_check,
  add constraint orders_subtotal_check check (subtotal>=0);

with history as (
  select order_id,jsonb_agg(jsonb_build_object('id',id,'status',status,'created_at',created_at,'actor_id',actor_id) order by id) as events,
    min(created_at) filter (where status in ('preparing','ready','assigned','picked_up','delivered')) as accepted_at,
    min(created_at) filter (where status='picked_up') as dispatched_at,
    min(created_at) filter (where status='cancelled') as cancelled_at
  from fly_delivery.order_events group by order_id
)
update fly_delivery.orders o set status_history=h.events,accepted_at=h.accepted_at,dispatched_at=h.dispatched_at,cancelled_at=h.cancelled_at
from history h where h.order_id=o.id;

do $$
begin
  if (select coalesce(sum(jsonb_array_length(status_history)),0) from fly_delivery.orders)
     <> (select count(*) from fly_delivery.order_events) then
    raise exception 'Order history migration incomplete';
  end if;
end;
$$;

create table fly_delivery.promotion_days (
  day date primary key,
  enabled boolean not null default true
);
create table fly_delivery.store_coupons (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references fly_delivery.stores(id),
  code text not null check (code ~ '^[A-Z0-9_-]{3,24}$'),
  rate_bps integer not null check (rate_bps between 1 and 10000),
  day date not null,
  start_minute integer not null check (start_minute between 0 and 1439),
  end_minute integer not null check (end_minute between 1 and 1440 and end_minute>start_minute),
  product_ids uuid[],
  enabled boolean not null default true,
  unique (store_id,code)
);
alter table fly_delivery.promotion_days enable row level security;
alter table fly_delivery.store_coupons enable row level security;
revoke all on fly_delivery.promotion_days,fly_delivery.store_coupons from public,anon,authenticated;

create function fly_delivery.promotion_rate(instant timestamptz)
returns integer language sql stable set search_path=''
as $$
  select coalesce(c.commission_bps,0) from fly_delivery.promotion_days p cross join fly_delivery.billing_config c
  where p.day=(instant at time zone 'America/Sao_Paulo')::date and p.enabled and c.id=true;
$$;
revoke all on function fly_delivery.promotion_rate(timestamptz) from public,anon,authenticated;

create function fly_delivery.manage_promotions(action_name text,payload jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare
  actor_role text:=fly_delivery.actor_role();
  shop_id uuid;
  target_id uuid;
  chosen_day date;
  chosen_code text;
  chosen_rate integer;
  start_time integer;
  end_time integer;
  selected_ids uuid[];
  result jsonb;
begin
  if action_name in ('admin_promotion_days','admin_save_promotion_day') then
    if actor_role is distinct from 'admin' then raise exception 'FD: Acesso exclusivo da administração.'; end if;
    if action_name='admin_save_promotion_day' then
      if coalesce(payload->>'day','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or jsonb_typeof(payload->'enabled') is distinct from 'boolean' then
        raise exception 'FD: Confira a data e a situação da promoção.';
      end if;
      insert into fly_delivery.promotion_days(day,enabled) values((payload->>'day')::date,(payload->>'enabled')::boolean)
        on conflict(day) do update set enabled=excluded.enabled;
    end if;
    return jsonb_build_object('commission_bps',(select commission_bps from fly_delivery.billing_config where id=true),
      'today',(now() at time zone 'America/Sao_Paulo')::date,
      'days',coalesce((select jsonb_agg(to_jsonb(p) order by day desc) from fly_delivery.promotion_days p),'[]'::jsonb));
  end if;
  if actor_role is distinct from 'merchant' then raise exception 'FD: Acesso exclusivo do estabelecimento.'; end if;
  if action_name='merchant_coupons' then
    return coalesce((select jsonb_agg(to_jsonb(c) order by c.day desc,c.code)
      from fly_delivery.store_coupons c join fly_delivery.stores s on s.id=c.store_id
      where s.owner_id=auth.uid() and not s.sample and s.deleted_at is null),'[]'::jsonb);
  end if;
  shop_id:=(payload->>'store_id')::uuid;
  target_id:=(payload->>'id')::uuid;
  perform 1 from fly_delivery.stores s where s.id=shop_id and s.owner_id=auth.uid() and not s.sample and s.deleted_at is null for share;
  if not found then raise exception 'FD: Você não tem acesso a esta loja.'; end if;
  if jsonb_typeof(payload->'enabled') is distinct from 'boolean' then raise exception 'FD: Confira a situação do cupom.';end if;
  if action_name='merchant_toggle_coupon' then
    update fly_delivery.store_coupons set enabled=(payload->>'enabled')::boolean where id=target_id and store_id=shop_id
      returning to_jsonb(store_coupons.*) into result;
  elsif action_name='merchant_save_coupon' then
    chosen_code:=upper(btrim(payload->>'code'));
    if coalesce(chosen_code,'') !~ '^[A-Z0-9_-]{3,24}$' or coalesce(payload->>'day','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or coalesce(payload->>'rate_bps','') !~ '^[0-9]{1,5}$' then raise exception 'FD: Confira código, data e porcentagem.';end if;
    chosen_day:=(payload->>'day')::date;
    chosen_rate:=(payload->>'rate_bps')::integer;
    start_time:=(payload->>'start_minute')::integer;end_time:=(payload->>'end_minute')::integer;
    if chosen_rate not between 1 and 10000 or start_time is null or end_time is null or start_time<0 or end_time>1440 or start_time>=end_time then
      raise exception 'FD: Informe desconto de 0,01%% a 100%% e um horário final posterior ao inicial.';
    end if;
    if payload->'product_ids' is not null and payload->'product_ids'<>'null'::jsonb then
      if jsonb_typeof(payload->'product_ids')<>'array' then raise exception 'FD: Selecione os produtos do cupom.';end if;
      select array_agg(distinct value::uuid) into selected_ids from jsonb_array_elements_text(payload->'product_ids');
      if selected_ids is null or exists(select 1 from unnest(selected_ids) x(id) where not exists(select 1 from fly_delivery.products p where p.id=x.id and p.store_id=shop_id)) then
        raise exception 'FD: Selecione produtos desta loja.';
      end if;
    end if;
    if target_id is null then
      insert into fly_delivery.store_coupons(store_id,code,rate_bps,day,start_minute,end_minute,product_ids,enabled)
        values(shop_id,chosen_code,chosen_rate,chosen_day,start_time,end_time,selected_ids,(payload->>'enabled')::boolean)
        returning to_jsonb(store_coupons.*) into result;
    else
      update fly_delivery.store_coupons set code=chosen_code,rate_bps=chosen_rate,day=chosen_day,start_minute=start_time,
        end_minute=end_time,product_ids=selected_ids,enabled=(payload->>'enabled')::boolean where id=target_id and store_id=shop_id
        returning to_jsonb(store_coupons.*) into result;
    end if;
  end if;
  if result is null then raise exception 'FD: Cupom não encontrado.';end if;
  return result;
exception when unique_violation then raise exception 'FD: Já existe um cupom com esse código na loja.';
  when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow or invalid_datetime_format or not_null_violation or check_violation then
    raise exception 'FD: Confira os dados da promoção ou do cupom.';
end;
$$;
revoke all on function fly_delivery.manage_promotions(text,jsonb) from public,anon;
grant execute on function fly_delivery.manage_promotions(text,jsonb) to authenticated;

create function fly_delivery.price_order(s fly_delivery.stores,input jsonb,instant timestamptz)
returns jsonb language plpgsql set search_path=''
as $$
declare
  items jsonb; item jsonb; p fly_delivery.products;
  total bigint; normalized_items jsonb;
  selected_options jsonb; selected_choices jsonb; choices_key text; item_key text;
  quantity_input integer; unit_price integer; size_input text; base_price_input integer;
  local_time timestamp:=instant at time zone 'America/Sao_Paulo';
  minute_of_day integer:=extract(hour from local_time)::integer*60+extract(minute from local_time)::integer;
  code_input text:=nullif(upper(btrim(input->>'coupon_code')),'');
  coupon fly_delivery.store_coupons;
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
  if code_input is not null then
    select * into coupon from fly_delivery.store_coupons c where c.store_id=s.id and c.code=code_input and c.enabled
      and c.day=local_time::date and c.start_minute<=minute_of_day and c.end_minute>minute_of_day;
    if not found then raise exception 'FD: Cupom inválido ou fora do horário de validade.';end if;
    select coalesce(sum((j.entry->>'price')::bigint*(j.entry->>'quantity')::integer),0) into eligible
      from jsonb_array_elements(normalized_items) j(entry)
      where coupon.product_ids is null or (j.entry->>'id')::uuid=any(coupon.product_ids);
    if eligible=0 then raise exception 'FD: O cupom não se aplica aos produtos deste carrinho.';end if;
    coupon_discount:=round(eligible::numeric*coupon.rate_bps/10000)::integer;
  end if;
  promo_rate:=fly_delivery.promotion_rate(instant);
  platform_discount:=coalesce(round((total-coupon_discount)::numeric*promo_rate/10000)::integer,0);
  quote:=jsonb_build_object('gross_subtotal',total,'subtotal',total-coupon_discount-platform_discount,'fee',s.fee,
    'total',total-coupon_discount-platform_discount+s.fee,'coupon_code',coupon.code,'coupon_bps',coupon.rate_bps,
    'coupon_discount_cents',coupon_discount,'promotion_bps',promo_rate,'platform_discount_cents',platform_discount);
  return jsonb_build_object('quote',quote,'items',normalized_items);
end;
$$;
revoke all on function fly_delivery.price_order(fly_delivery.stores,jsonb,timestamptz) from public,anon,authenticated;

CREATE OR REPLACE FUNCTION fly_delivery.order_workspace_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare event_at timestamptz;
begin
  if tg_op='INSERT' then
    select full_name into new.customer_name from fly_delivery.customer_profiles where user_id=new.customer_id;
  end if;
  if new.status in ('delivered','cancelled') then
    if tg_op='INSERT' then new.completed_at:=clock_timestamp();
    elsif old.status is distinct from new.status then new.completed_at:=clock_timestamp();
    else new.completed_at:=old.completed_at;
    end if;
  end if;
  if tg_op='INSERT' or old.status is distinct from new.status then
    event_at:=case when tg_op='INSERT' then new.created_at else clock_timestamp() end;
    new.status_history:=new.status_history||jsonb_build_array(jsonb_build_object('status',new.status,'created_at',event_at,'actor_id',auth.uid()));
    if new.status in ('preparing','ready','assigned','picked_up','delivered') then new.accepted_at:=coalesce(new.accepted_at,event_at);end if;
    if new.status='picked_up' then new.dispatched_at:=event_at;end if;
    if new.status='cancelled' then new.cancelled_at:=event_at;end if;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION fly_delivery.capture_commission()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare config fly_delivery.billing_config;
begin
  if new.status='delivered' and (tg_op='INSERT' or old.status<>'delivered') then
    perform pg_advisory_xact_lock(hashtextextended('fd-billing:'||new.store_id::text,0));
    new.completed_at:=clock_timestamp();
    select * into config from fly_delivery.billing_config where id=true for share;
    if new.promotion_bps is not null then
      new.commission_bps:=null;
      new.platform_fee_cents:=0;
    elsif config.payments_ready and config.commission_bps is not null then
      new.commission_bps:=config.commission_bps;
      new.platform_fee_cents:=round(new.subtotal::numeric*config.commission_bps/10000)::integer;
    end if;
  end if;
  return new;
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
      'promotion_bps',o.promotion_bps,'payment',o.payment,'note',o.customer_note,'courier_assigned',o.courier_id is not null,
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
    insert into fly_delivery.orders(customer_id,store_id,request_id,address,payment,subtotal,fee,customer_note,created_at,
      coupon_code,coupon_bps,coupon_discount_cents,promotion_bps,platform_discount_cents)
      values(actor,s.id,req,btrim(input->>'address'),input->>'payment',(quote->>'subtotal')::integer,s.fee,note_input,order_time,
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
  if action in ('admin_promotion_days','admin_save_promotion_day','merchant_coupons','merchant_save_coupon','merchant_toggle_coupon') then
    return fly_delivery.manage_promotions(action,input);
  end if;
  if action='admin_commission_dashboard' then return fly_delivery.admin_commission_dashboard(input); end if;
  if action in ('customer_active_orders','customer_order_history') then return fly_delivery.customer_orders(action,input); end if;
  if action in ('billing_settings','admin_set_commission','admin_set_suspension','admin_customers','merchant_invoices') then return fly_delivery.billing_api(action,input); end if;
  if action in ('customer_address','save_customer_address') then
    return fly_delivery.customer_address(action,input);
  end if;
  if action in ('merchant_active_orders','merchant_history','merchant_finance') then
    return fly_delivery.merchant_workspace(action,input);
  end if;
  if action in ('admin_update_store','admin_delete_store') then return fly_delivery.admin_manage_store(action,input); end if;
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

CREATE OR REPLACE FUNCTION fly_delivery.market_catalog() RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',st.id,'name',st.name,'description',st.description,'category',st.category,'categories',st.categories,
    'image',st.image,'is_open',fly_delivery.store_open_at(st,now()),
    'fee',st.fee,'eta',st.eta,'promotion_bps',(select fly_delivery.promotion_rate(now())),
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',pr.id,'name',pr.name,'description',pr.description,
      'price',pr.price,'image',pr.image,'category',pr.category,'options',pr.options,'sizes',pr.sizes,'meal_choices',pr.meal_choices) order by pr.name)
      from fly_delivery.products pr where pr.store_id=st.id and pr.active),'[]'::jsonb))
    order by fly_delivery.store_open_at(st,now()) desc,st.name),'[]'::jsonb)
  from fly_delivery.stores st
  where not (fly_delivery.store_suspension(st)->>'suspended')::boolean and st.active and not st.sample and st.deleted_at is null;
$function$;

drop table fly_delivery.order_events;
