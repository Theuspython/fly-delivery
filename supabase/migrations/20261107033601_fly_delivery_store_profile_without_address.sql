-- Publishing a store no longer requires a pickup address.
CREATE OR REPLACE FUNCTION fly_delivery.save_store_profile(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  s fly_delivery.stores;
  schedule jsonb := payload->'weekly_hours';
  day_hours jsonb;
  picture text := nullif(payload->>'image','');
begin
  if fly_delivery.actor_role() is distinct from 'merchant' then raise exception 'FD: Configuração exclusiva do estabelecimento.'; end if;
  select * into s from fly_delivery.stores
    where id=(payload->>'id')::uuid and owner_id=(select auth.uid()) and not sample and deleted_at is null for update;
  if not found then raise exception 'FD: Você não tem acesso a esta loja.'; end if;
  if jsonb_typeof(schedule) is distinct from 'array' then raise exception 'FD: Confira os horários da semana.'; end if;
  if jsonb_array_length(schedule)<>7 then raise exception 'FD: Confira os horários da semana.'; end if;
  for day_hours in select value from jsonb_array_elements(schedule) loop
    if day_hours<>'null'::jsonb and (
      jsonb_typeof(day_hours)<>'object' or
      coalesce(day_hours->>'open','') !~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$' or
      coalesce(day_hours->>'close','') !~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$'
    ) then raise exception 'FD: Preencha os horários dos dias abertos.'; end if;
  end loop;
  if picture is not null and picture !~ ('^https://[a-z0-9]+[.]supabase[.]co/storage/v1/object/public/fly-delivery-menu/' || s.id::text || '/[0-9a-f-]{36}[.](jpg|png|webp)$') then
    raise exception 'FD: Envie a foto pelo painel da loja.';
  end if;
  if payload ? 'address' and coalesce(char_length(btrim(payload->>'address')),0) not between 5 and 240 then
    raise exception 'FD: Informe o endereço completo do estabelecimento.';
  end if;
  update fly_delivery.stores set
    description=case when payload ? 'description' then coalesce(btrim(payload->>'description'),'') else s.description end,
    address=case when payload ? 'address' then btrim(payload->>'address') else s.address end,
    fee=(payload->>'fee')::integer,eta=(payload->>'eta')::integer,
    active=coalesce((payload->>'active')::boolean,false),is_open=case when s.address is null and s.weekly_hours is null then true else s.is_open end,
    image=picture,weekly_hours=schedule
  where id=s.id;
  return jsonb_build_object('id',s.id);
exception when invalid_text_representation or check_violation or not_null_violation or numeric_value_out_of_range then
  raise exception 'FD: Confira os dados do estabelecimento.';
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
      'price',pr.price,'image',pr.image,'category',pr.category,'options',pr.options,'sizes',pr.sizes,'meal_choices',pr.meal_choices) order by pr.name)
      from fly_delivery.products pr where pr.store_id=st.id and pr.active),'[]'::jsonb))
    order by fly_delivery.store_open_at(st,now()) desc,st.name),'[]'::jsonb)
  from fly_delivery.stores st
  where not (fly_delivery.store_suspension(st)->>'suspended')::boolean and st.active and not st.sample and st.deleted_at is null;
$function$;
