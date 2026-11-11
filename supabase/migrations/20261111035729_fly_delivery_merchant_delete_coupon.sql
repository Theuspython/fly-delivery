CREATE OR REPLACE FUNCTION fly_delivery.manage_promotions(action_name text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if action_name='merchant_delete_coupon' then
    delete from fly_delivery.store_coupons where id=target_id and store_id=shop_id;
    if not found then raise exception 'FD: Cupom não encontrado.'; end if;
    return jsonb_build_object('id',target_id);
  end if;
  if jsonb_typeof(payload->'enabled') is distinct from 'boolean' then raise exception 'FD: Confira a situação do cupom.';end if;
  if action_name='merchant_toggle_coupon' then
    update fly_delivery.store_coupons set enabled=(payload->>'enabled')::boolean where id=target_id and store_id=shop_id
      returning to_jsonb(store_coupons.*) into result;
  elsif action_name='merchant_save_coupon' then
    chosen_code:=upper(btrim(payload->>'code'));
    perform pg_advisory_xact_lock(hashtextextended('fd-platform-coupon',0));
    if exists(select 1 from fly_delivery.platform_coupons c where c.code=chosen_code and c.deleted_at is null) then
      raise exception 'FD: Esse código está reservado para um cupom da plataforma.';
    end if;
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
  if action in ('admin_promotion_days','admin_save_promotion_day','merchant_coupons','merchant_save_coupon','merchant_toggle_coupon','merchant_delete_coupon') then
    return fly_delivery.manage_promotions(action,input);
  end if;
  if action in ('customer_notifications','customer_read_coupon_notice') then
    return fly_delivery.customer_notices(action,input);
  end if;
  if action in ('admin_platform_coupons','admin_save_platform_coupon','admin_toggle_platform_coupon','admin_delete_platform_coupon') then
    return fly_delivery.admin_platform_coupons(action,input);
  end if;
  if action='merchant_alerts' then return fly_delivery.merchant_alerts();end if;
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
  end if;
  if action in ('orders','transition') and actor_role='admin' then raise exception 'FD: Operação restrita ao atendimento.'; end if;
  if action='orders' and input ? 'view' then return fly_delivery.scoped_orders(input->>'view'); end if;
  return fly_delivery.api(action,input);
end;
$function$;
