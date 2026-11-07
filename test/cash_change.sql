-- Order validation and both views use temporary fixtures only.
begin;
do $$
declare
  merchant uuid:=gen_random_uuid();
  buyer uuid:=gen_random_uuid();
  shop uuid:=gen_random_uuid();
  product uuid;
  placed uuid;
  input jsonb;
  quote jsonb;
  result jsonb;
  invalid_amount jsonb;
  total integer;
  schedule jsonb:=(select jsonb_agg('{"open":"00:00","close":"00:00"}'::jsonb) from generate_series(1,7));
begin
  insert into auth.users(id,email,email_confirmed_at)
    values (merchant,merchant::text||'@example.invalid',now()),(buyer,buyer::text||'@example.invalid',now());
  insert into fly_delivery.accounts(id,role) values (merchant,'merchant'),(buyer,'customer');
  insert into fly_delivery.customer_profiles(user_id,full_name,phone) values (buyer,'Cliente Troco','31992345679');
  insert into fly_delivery.stores(id,owner_id,name,category,categories,address,active,is_open,fee,weekly_hours)
    values (shop,merchant,'Loja Troco','Pizza',array['Pizza'],'Rua da Loja 50',true,true,500,schedule);
  perform set_config('request.jwt.claim.sub',merchant::text,true);
  product:=(public.fd_api('save_product',jsonb_build_object('store_id',shop,'name','Pizza','price',3000))->>'id')::uuid;
  perform set_config('request.jwt.claim.sub',buyer::text,true);
  input:=jsonb_build_object('store_id',shop,'fee',500,'request_id',gen_random_uuid(),'address','Rua do Cliente 123 - Centro',
    'payment','cash_delivery','items',jsonb_build_array(jsonb_build_object('id',product,'price',3000,'quantity',1)));
  quote:=public.fd_api('quote_order',input);
  total:=(quote->>'total')::integer;
  input:=input||jsonb_build_object('quote',quote);
  foreach invalid_amount in array array['null'::jsonb,to_jsonb(total-1),to_jsonb(1.2),to_jsonb(total::text),to_jsonb(2147483648::bigint)] loop
    begin
      perform public.fd_api('place',input||jsonb_build_object('cash_tendered_cents',invalid_amount));
      raise exception 'Accepted invalid tender %',invalid_amount;
    exception when raise_exception then if sqlerrm not like 'FD: Informe um valor em dinheiro%' then raise;end if;end;
  end loop;
  begin
    perform public.fd_api('place',input||jsonb_build_object('payment','pix_delivery','cash_tendered_cents',total));
    raise exception 'Accepted cash tender for Pix';
  exception when raise_exception then if sqlerrm not like 'FD: O troco está disponível%' then raise;end if;end;
  result:=public.fd_api('place',input||jsonb_build_object('cash_tendered_cents',total+1000));
  placed:=(result->>'id')::uuid;
  if result->>'cash_tendered_cents' is distinct from (total+1000)::text or result->>'created_at' is null then
    raise exception 'Cash value or placement time missing from customer view';
  end if;
  result:=public.fd_api('place',input||jsonb_build_object('request_id',gen_random_uuid(),'cash_tendered_cents',total));
  if result->>'cash_tendered_cents' is distinct from total::text then raise exception 'Exact cash rejected';end if;
  result:=public.fd_api('place',input||jsonb_build_object('request_id',gen_random_uuid(),'payment','pix_delivery','cash_tendered_cents',null));
  if result->>'cash_tendered_cents' is not null then raise exception 'Pix cash tender not empty';end if;
  perform set_config('request.jwt.claim.sub',merchant::text,true);
  select entry into result from jsonb_array_elements(public.fd_api('merchant_active_orders')) entry where entry->>'id'=placed::text;
  if result->>'cash_tendered_cents' is distinct from (total+1000)::text or result ? 'address' then
    raise exception 'Merchant cash or address visibility incorrect';
  end if;
end;
$$;
select 'Troco, valor exato, validação, data e visibilidade verificados' as integration;
rollback;
