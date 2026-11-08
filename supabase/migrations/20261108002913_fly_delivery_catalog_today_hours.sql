-- Publish only the store's schedule for the current day in Brasília.
CREATE OR REPLACE FUNCTION fly_delivery.market_catalog()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',st.id,'name',st.name,'description',st.description,'category',st.category,'categories',st.categories,
    'image',st.image,'is_open',fly_delivery.store_open_at(st,now()),
    'today_hours',case when st.weekly_hours is not null then jsonb_build_object(
      'weekday',day.weekday,'opens',hours.today->>'open','closes',hours.today->>'close',
      'overnight_until',case when hours.yesterday->>'open'>hours.yesterday->>'close' and hours.yesterday->>'close'<>'00:00'
        then hours.yesterday->>'close' end) end,
    'fee',st.fee,'eta',st.eta,'promotion_bps',(select fly_delivery.promotion_rate(now())),
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',pr.id,'name',pr.name,'description',pr.description,
      'price',pr.price,'image',pr.image,'category',pr.category,'options',pr.options,'sizes',pr.sizes,'meal_choices',pr.meal_choices) order by pr.name)
      from fly_delivery.products pr where pr.store_id=st.id and pr.active),'[]'::jsonb))
    order by fly_delivery.store_open_at(st,now()) desc,st.name),'[]'::jsonb)
  from fly_delivery.stores st
  cross join (select extract(dow from now() at time zone 'America/Sao_Paulo')::integer as weekday) day
  cross join lateral (select st.weekly_hours->day.weekday as today,st.weekly_hours->((day.weekday+6)%7) as yesterday) hours
  where not (fly_delivery.store_suspension(st)->>'suspended')::boolean and st.active and not st.sample and st.deleted_at is null;
$function$;
