-- Use rollback-only fixtures to verify the public catalogue schedule.
begin;
do $$
declare
  local_day integer:=extract(dow from now() at time zone 'America/Sao_Paulo')::integer;
  prior_day integer:=(local_day+6)%7;
  no_hours jsonb:='[null,null,null,null,null,null,null]';
  shop uuid:=gen_random_uuid();
  result jsonb;
begin
  insert into fly_delivery.stores(id,name,category,categories,active,is_open,weekly_hours)
    values (shop,'Loja Horários','Pizza',array['Pizza'],true,true,null);
  select x->'today_hours' into result from jsonb_array_elements(public.fd_api('catalog')) x where x->>'id'=shop::text;
  if result is distinct from 'null'::jsonb then raise exception 'Unconfigured schedule exposed';end if;

  update fly_delivery.stores set weekly_hours=jsonb_set(no_hours,array[local_day::text],'{"open":"19:30","close":"23:00"}') where id=shop;
  select x->'today_hours' into result from jsonb_array_elements(public.fd_api('catalog')) x where x->>'id'=shop::text;
  if result is distinct from jsonb_build_object('weekday',local_day,'opens','19:30','closes','23:00','overnight_until',null) then
    raise exception 'Wrong local weekday or published hours: %',result;
  end if;

  update fly_delivery.stores set weekly_hours=jsonb_set(no_hours,array[prior_day::text],'{"open":"20:00","close":"02:00"}') where id=shop;
  select x->'today_hours' into result from jsonb_array_elements(public.fd_api('catalog')) x where x->>'id'=shop::text;
  if result is distinct from jsonb_build_object('weekday',local_day,'opens',null,'closes',null,'overnight_until','02:00') then
    raise exception 'Overnight hours lost or mixed with today: %',result;
  end if;
end;
$$;
select 'Horário público do dia em Brasília, funcionamento após meia-noite e agenda ausente verificados' as integration;
rollback;
