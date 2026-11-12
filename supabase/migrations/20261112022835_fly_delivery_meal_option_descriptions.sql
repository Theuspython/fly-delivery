-- Optional plain-text descriptions are stored with their accompaniment option.
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
      where jsonb_typeof(opt) is distinct from 'object' or opt-array['id','name','description']<>'{}'::jsonb
        or coalesce(opt->>'id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or jsonb_typeof(opt->'name') is distinct from 'string'
        or length(btrim(opt->>'name')) not between 1 and 60
        or (opt ? 'description' and (jsonb_typeof(opt->'description') is distinct from 'string'
          or char_length(opt->>'description')>200))
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
