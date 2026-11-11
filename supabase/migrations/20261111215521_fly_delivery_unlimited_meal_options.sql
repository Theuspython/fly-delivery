-- Limit each size to the number of configured options, with no fixed cap per group.
CREATE OR REPLACE FUNCTION fly_delivery.valid_meal_choices(value jsonb, sizes jsonb, category text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  g jsonb;
  rule record;
  allowed text[];
  ids text[]:='{}';
  option_count integer;
begin
  if jsonb_typeof(value) is distinct from 'array' or jsonb_array_length(value)>8 then return false;end if;
  if value='[]'::jsonb then return true;end if;
  select coalesce(array_agg(v->>'name'),array['']) into allowed from jsonb_array_elements(sizes) v;
  for g in select * from jsonb_array_elements(value) loop
    if jsonb_typeof(g)<>'object' or g-array['id','name','required','limits','options']<>'{}'::jsonb
      or coalesce(g->>'id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or g->>'id'=any(ids) or jsonb_typeof(g->'name') is distinct from 'string'
      or length(btrim(g->>'name')) not between 2 and 60 or jsonb_typeof(g->'required') is distinct from 'boolean'
      or jsonb_typeof(g->'options') is distinct from 'array' or jsonb_array_length(g->'options')=0
      or jsonb_typeof(g->'limits') is distinct from 'object' or g->'limits'='{}'::jsonb then return false;end if;
    ids:=array_append(ids,g->>'id');
    option_count:=jsonb_array_length(g->'options');
    if exists(
      select 1 from jsonb_array_elements(g->'options') as options(opt)
      where jsonb_typeof(opt) is distinct from 'object' or opt-array['id','name']<>'{}'::jsonb
        or coalesce(opt->>'id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or jsonb_typeof(opt->'name') is distinct from 'string'
        or length(btrim(opt->>'name')) not between 1 and 60
    ) or (
      select count(distinct opt->>'id')<>option_count or count(distinct lower(btrim(opt->>'name')))<>option_count
      from jsonb_array_elements(g->'options') as options(opt)
    ) then return false; end if;
    for rule in select * from jsonb_each(g->'limits') loop
      if not rule.key=any(allowed) or jsonb_typeof(rule.value)<>'number' or rule.value::text !~ '^[1-9][0-9]*$'
        or rule.value::numeric>option_count then return false;end if;
    end loop;
  end loop;
  return true;
exception when others then return false;
end;
$function$;

CREATE OR REPLACE FUNCTION fly_delivery.resolve_meal_choices(configuration jsonb, selection jsonb, size_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare g jsonb; chosen jsonb; ids jsonb; options jsonb; result jsonb:='[]'; limit_value integer;
begin
  if jsonb_typeof(selection) is distinct from 'array' or jsonb_array_length(selection)>8 then
    raise exception 'FD: Revise as escolhas de montagem no cardápio.';end if;
  for chosen in select * from jsonb_array_elements(selection) loop
    if jsonb_typeof(chosen)<>'object' or chosen-array['group_id','option_ids']<>'{}'::jsonb
      or jsonb_typeof(chosen->'group_id') is distinct from 'string'
      or jsonb_typeof(chosen->'option_ids') is distinct from 'array'
      or not exists(select 1 from jsonb_array_elements(configuration) v where v->>'id'=chosen->>'group_id' and v->'limits' ? coalesce(size_name,'')) then
      raise exception 'FD: Revise as escolhas de montagem no cardápio.';end if;
  end loop;
  if (select count(distinct v->>'group_id') from jsonb_array_elements(selection) v)<>jsonb_array_length(selection) then
    raise exception 'FD: Revise as escolhas de montagem no cardápio.';end if;
  for g in select * from jsonb_array_elements(configuration) loop
    if not g->'limits' ? coalesce(size_name,'') then continue;end if;
    limit_value:=(g->'limits'->>coalesce(size_name,''))::integer;
    select v->'option_ids' into ids from jsonb_array_elements(selection) v where v->>'group_id'=g->>'id';
    ids:=coalesce(ids,'[]'::jsonb);
    if jsonb_array_length(ids)>limit_value or ((g->>'required')::boolean and jsonb_array_length(ids)=0) then
      raise exception 'FD: Revise as escolhas de montagem: % (até % opção/ões).',g->>'name',limit_value;end if;
    if jsonb_array_length(ids)>0 then
      if exists(select 1 from jsonb_array_elements(ids) as chosen_id(id) where jsonb_typeof(id)<>'string') then
        raise exception 'FD: Revise as escolhas de montagem no cardápio.';
      end if;
      select jsonb_agg(jsonb_build_object('id',v->>'id','name',v->>'name') order by v->>'id') into options
      from jsonb_array_elements(g->'options') v
      join (select distinct id from jsonb_array_elements_text(ids) as chosen_id(id)) selected
        on selected.id=v->>'id';
      if coalesce(jsonb_array_length(options),0)<>jsonb_array_length(ids) then
        raise exception 'FD: Revise as escolhas de montagem no cardápio.';
      end if;
      result:=result||jsonb_build_array(jsonb_build_object('id',g->>'id','name',g->>'name','options',options));
    end if;
  end loop;
  return result;
end;
$function$;
