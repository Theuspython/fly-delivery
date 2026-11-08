-- A store menu can request just its current coupon notices without changing unread state.
CREATE OR REPLACE FUNCTION fly_delivery.customer_notices(action_name text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid:=(select auth.uid());
  shop_coupon uuid;
  store_scope uuid:=(payload->>'store_id')::uuid;
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
    where store_scope is null and o.customer_id=actor and o.status='delivered' and o.rating is null
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
    where (store_scope is null or c.store_id=store_scope) and c.enabled and c.notice_id is not null and c.day=local_time::date and c.start_minute<=minute_of_day and minute_of_day<c.end_minute
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
