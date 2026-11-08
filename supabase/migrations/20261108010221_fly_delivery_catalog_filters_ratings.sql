-- One rating per delivered order, with individual ratings visible only to its customer.
alter table fly_delivery.orders add column rating smallint
  check (rating is null or (status='delivered' and rating between 1 and 5));
create index fd_order_ratings_by_store on fly_delivery.orders(store_id) include (rating)
  where status='delivered' and rating is not null;
create index fd_delivered_product_sales on fly_delivery.orders(id) include (store_id) where status='delivered';

create function fly_delivery.rate_order(payload jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare
  order_id uuid;
  stars smallint;
begin
  if fly_delivery.actor_role() is distinct from 'customer' then
    raise exception 'FD: Avaliação exclusiva do cliente.';
  end if;
  if jsonb_typeof(payload->'rating') is distinct from 'number'
     or coalesce(payload->>'rating','') !~ '^[1-5]$' then
    raise exception 'FD: Escolha de 1 a 5 estrelas.';
  end if;
  order_id:=(payload->>'id')::uuid;
  stars:=(payload->>'rating')::smallint;
  update fly_delivery.orders o set rating=stars
    where o.id=order_id and o.customer_id=(select auth.uid()) and o.status='delivered'
    returning o.rating into stars;
  if not found then raise exception 'FD: Pedido entregue não encontrado no seu histórico.';end if;
  return jsonb_build_object('rating',stars);
exception when invalid_text_representation then
  raise exception 'FD: Pedido inválido.';
end;
$function$;
revoke all on function fly_delivery.rate_order(jsonb) from public,anon;
grant execute on function fly_delivery.rate_order(jsonb) to authenticated;

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
    || case when reveal and o.customer_id=(select auth.uid()) and o.status='delivered'
      then jsonb_build_object('rating',o.rating) else '{}'::jsonb end
    || case when (select fly_delivery.actor_role())='merchant' and
      (o.status='placed' or (o.status='cancelled' and o.accepted_at is null))
      then jsonb_build_object('address_hidden',true)
      when reveal then jsonb_build_object('address',o.address,'lat',o.lat,'lng',o.lng,'distance_km',o.distance_km)
      else jsonb_build_object('distance_km',o.distance_km) end
  from fly_delivery.stores s where s.id=o.store_id;
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
  if action='customer_rate_order' then return fly_delivery.rate_order(input); end if;
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

CREATE OR REPLACE FUNCTION fly_delivery.market_catalog()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with local_clock as (
    select now() at time zone 'America/Sao_Paulo' as instant
  ), market_stores as materialized (
    select s.id from fly_delivery.stores s
    where not (fly_delivery.store_suspension(s)->>'suspended')::boolean and s.active and not s.sample and s.deleted_at is null
  ), coupon_rates as (
    select c.store_id,max(c.rate_bps) as rate_bps
    from fly_delivery.store_coupons c join market_stores s on s.id=c.store_id cross join local_clock
    cross join lateral (select extract(hour from instant)::integer*60+extract(minute from instant)::integer as minute) clock
    where c.enabled and c.day=instant::date and c.start_minute<=clock.minute and c.end_minute>clock.minute
      and exists (select 1 from fly_delivery.products p where p.store_id=c.store_id and p.active
        and (c.product_ids is null or p.id=any(c.product_ids)))
    group by c.store_id
  ), ratings as (
    select o.store_id,avg(o.rating) as average,count(*) as amount
    from fly_delivery.orders o join market_stores s on s.id=o.store_id
    where o.status='delivered' and o.rating is not null group by o.store_id
  ), best_sellers as (
    select i.product_id,(row_number() over (order by sum(i.quantity) desc,i.product_id))::integer as sales_rank
    from fly_delivery.orders o join fly_delivery.order_items i on i.order_id=o.id
      join fly_delivery.products p on p.id=i.product_id and p.active and p.store_id=o.store_id
      join market_stores s on s.id=o.store_id
    where o.status='delivered'
    group by i.product_id
    order by sum(i.quantity) desc,i.product_id
    limit 20
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',st.id,'name',st.name,'description',st.description,'category',st.category,'categories',st.categories,
    'image',st.image,'is_open',fly_delivery.store_open_at(st,now()),
    'today_hours',case when st.weekly_hours is not null then jsonb_build_object(
      'weekday',day.weekday,'opens',hours.today->>'open','closes',hours.today->>'close',
      'overnight_until',case when hours.yesterday->>'open'>hours.yesterday->>'close' and hours.yesterday->>'close'<>'00:00'
        then hours.yesterday->>'close' end) end,
    'fee',st.fee,'eta',st.eta,'promotion_bps',(select fly_delivery.promotion_rate(now())),
    'coupon_bps',c.rate_bps,'rating_average',r.average,'rating_count',coalesce(r.amount,0),
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',pr.id,'name',pr.name,'description',pr.description,
      'price',pr.price,'image',pr.image,'category',pr.category,'options',pr.options,'sizes',pr.sizes,'meal_choices',pr.meal_choices,'sales_rank',b.sales_rank) order by pr.name)
      from fly_delivery.products pr left join best_sellers b on b.product_id=pr.id where pr.store_id=st.id and pr.active),'[]'::jsonb))
    order by fly_delivery.store_open_at(st,now()) desc,st.name),'[]'::jsonb)
  from fly_delivery.stores st join market_stores ms on ms.id=st.id
  left join coupon_rates c on c.store_id=st.id
  left join ratings r on r.store_id=st.id
  cross join (select extract(dow from instant)::integer as weekday from local_clock) day
  cross join lateral (select st.weekly_hours->day.weekday as today,st.weekly_hours->((day.weekday+6)%7) as yesterday) hours;
$function$;
