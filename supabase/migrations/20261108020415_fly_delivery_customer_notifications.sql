-- Coupon activations have a distinct identity so a reactivation can notify customers again.
alter table fly_delivery.store_coupons add column notice_id uuid, add column notice_created_at timestamptz;
update fly_delivery.store_coupons set notice_id=gen_random_uuid(),notice_created_at=clock_timestamp()
  where enabled and day>=(now() at time zone 'America/Sao_Paulo')::date;

create function fly_delivery.track_coupon_notice()
returns trigger language plpgsql set search_path=''
as $function$
begin
  if new.enabled and (tg_op='INSERT' or not old.enabled) then
    new.notice_id:=gen_random_uuid();
    new.notice_created_at:=clock_timestamp();
  end if;
  return new;
end;
$function$;
revoke all on function fly_delivery.track_coupon_notice() from public,anon,authenticated;
create trigger store_coupon_notice before insert or update of enabled on fly_delivery.store_coupons
  for each row execute function fly_delivery.track_coupon_notice();

create table fly_delivery.customer_coupon_reads (
  customer_id uuid not null references fly_delivery.accounts(id) on delete cascade,
  coupon_id uuid not null references fly_delivery.store_coupons(id) on delete cascade,
  notice_id uuid not null,
  primary key(customer_id,coupon_id)
);
alter table fly_delivery.customer_coupon_reads enable row level security;
revoke all on fly_delivery.customer_coupon_reads from public,anon,authenticated;
create index fd_coupon_reads_coupon on fly_delivery.customer_coupon_reads(coupon_id);
create index fd_enabled_coupons_day on fly_delivery.store_coupons(day) where enabled;
create index fd_pending_customer_reviews on fly_delivery.orders(customer_id,completed_at desc,id)
  where status='delivered' and rating is null;

create function fly_delivery.customer_notices(action_name text,payload jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare
  actor uuid:=(select auth.uid());
  shop_coupon uuid;
  notice uuid;
  page_number integer:=coalesce((payload->>'page')::integer,0);
  page_size constant integer:=20;
  local_time timestamp:=now() at time zone 'America/Sao_Paulo';
  minute_of_day integer:=extract(hour from local_time)::integer*60+extract(minute from local_time)::integer;
  result jsonb;
begin
  if fly_delivery.actor_role() is distinct from 'customer' then raise exception 'FD: Notificações exclusivas do cliente.';end if;
  if action_name='customer_read_coupon_notice' then
    shop_coupon:=(payload->>'coupon_id')::uuid;
    notice:=(payload->>'notice_id')::uuid;
    perform 1 from fly_delivery.store_coupons c where c.id=shop_coupon and c.notice_id=notice and c.enabled for share;
    if not found then return jsonb_build_object('ok',false);end if;
    insert into fly_delivery.customer_coupon_reads(customer_id,coupon_id,notice_id) values(actor,shop_coupon,notice)
      on conflict(customer_id,coupon_id) do update set notice_id=excluded.notice_id;
    return jsonb_build_object('ok',true);
  end if;
  if page_number not between 0 and 100000 then raise exception 'FD: Página inválida.';end if;

  with pending as (
    select o.id,coalesce(o.completed_at,o.created_at) as instant,true as unread,
      jsonb_build_object('kind','review','id',o.id,'store_name',s.name,'unread',true) as item
    from fly_delivery.orders o join fly_delivery.stores s on s.id=o.store_id
    where o.customer_id=actor and o.status='delivered' and o.rating is null
  ), eligible_coupons as (
    select c.id,c.notice_created_at as instant,(r.notice_id is distinct from c.notice_id) as unread,
      jsonb_build_object('kind','coupon','id',c.id,'notice_id',c.notice_id,'store_id',s.id,'store_name',s.name,
        'code',c.code,'rate_bps',c.rate_bps,'day',c.day,'products',eligible.names,'product_count',eligible.amount,
        'unread',r.notice_id is distinct from c.notice_id) as item
    from fly_delivery.store_coupons c join fly_delivery.stores s on s.id=c.store_id
    left join fly_delivery.customer_coupon_reads r on r.customer_id=actor and r.coupon_id=c.id
    cross join lateral (
      select coalesce(jsonb_agg(x.name order by x.name) filter(where x.position<=3),'[]'::jsonb) as names,count(*) as amount
      from (select p.name,row_number() over(order by p.name,p.id) as position
        from fly_delivery.products p where p.store_id=s.id and p.active and p.id=any(c.product_ids)) x
    ) eligible
    where c.enabled and c.notice_id is not null and c.day=local_time::date and c.start_minute<=minute_of_day and minute_of_day<c.end_minute
      and fly_delivery.store_open_at(s,now()) and (c.product_ids is null or eligible.amount>0)
      and exists(select 1 from fly_delivery.products p where p.store_id=s.id and p.active)
  ), notices as (
    select * from pending union all select * from eligible_coupons
  ), batch as (
    select * from notices order by unread desc,instant desc,id limit page_size offset page_number*page_size
  )
  select jsonb_build_object('unread',(select count(*) from notices where unread),
    'items',coalesce((select jsonb_agg(item order by unread desc,instant desc,id) from batch),'[]'::jsonb),
    'has_more',(select count(*) from notices)>(page_number+1)*page_size) into result;
  return result;
exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'FD: Notificação inválida.';
end;
$function$;
revoke all on function fly_delivery.customer_notices(text,jsonb) from public,anon;
grant execute on function fly_delivery.customer_notices(text,jsonb) to authenticated;

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
  if action in ('customer_notifications','customer_read_coupon_notice') then
    return fly_delivery.customer_notices(action,input);
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

CREATE OR REPLACE FUNCTION fly_delivery.customer_orders(action_name text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare actor uuid:=auth.uid(); page_number integer:=coalesce((payload->>'page')::integer,0); page_size integer:=coalesce((payload->>'page_size')::integer,25); total bigint; result jsonb;
begin
  if fly_delivery.actor_role() is distinct from 'customer' then raise exception 'FD: Consulta exclusiva do cliente.'; end if;
  if page_number not between 0 and 1000000 or page_size not between 1 and 25 then raise exception 'FD: Página inválida.'; end if;
  if action_name='customer_active_orders' then
    select coalesce(jsonb_agg(fly_delivery.order_details(o,true) order by o.created_at desc,o.id),'[]'::jsonb)
      into result from fly_delivery.orders o where o.customer_id=actor and o.status not in ('delivered','cancelled');
    return jsonb_build_object('orders',result,'count',jsonb_array_length(result),'page',0,'pages',1);
  elsif action_name='customer_order_history' then
    if payload ? 'order_id' then
      select fly_delivery.order_details(o,true) into result
        from fly_delivery.orders o where o.id=(payload->>'order_id')::uuid and o.customer_id=actor and o.status='delivered';
      return jsonb_build_object('orders',case when result is null then '[]'::jsonb else jsonb_build_array(result) end,
        'count',case when result is null then 0 else 1 end,'page',0,'pages',1);
    end if;
    select count(*) into total from fly_delivery.orders where customer_id=actor and status in ('delivered','cancelled');
    select coalesce(jsonb_agg(fly_delivery.order_details(q,true) order by q.completed_at desc nulls last,q.created_at desc,q.id),'[]'::jsonb)
      into result from (select * from fly_delivery.orders where customer_id=actor and status in ('delivered','cancelled')
        order by completed_at desc nulls last,created_at desc,id limit page_size offset page_number*page_size) q;
    return jsonb_build_object('orders',result,'count',total,'page',page_number,'page_size',page_size,'pages',greatest(1,ceil(total::numeric/page_size)::integer));
  end if;
  raise exception 'FD: Consulta inválida.';
exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'FD: Página inválida.';
end;
$function$;
