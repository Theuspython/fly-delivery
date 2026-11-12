-- Record new commissions at acceptance. Previously accepted orders use the legacy delivery rule.
alter table fly_delivery.orders add column commission_accepted_at timestamptz;

create index fd_orders_commission_acceptance on fly_delivery.orders(store_id,commission_accepted_at)
  where commission_accepted_at is not null and commission_bps is not null;

create view fly_delivery.commission_orders with (security_invoker=true) as
  select id,store_id,status,subtotal,platform_fee_cents,commission_accepted_at as commission_at
  from fly_delivery.orders where commission_accepted_at is not null and commission_bps is not null
  union all
  select id,store_id,status,subtotal,platform_fee_cents,completed_at as commission_at
  from fly_delivery.orders
  where commission_accepted_at is null and status='delivered' and completed_at is not null and commission_bps is not null;

revoke all on fly_delivery.commission_orders from public,anon,authenticated;

CREATE OR REPLACE FUNCTION fly_delivery.capture_commission()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  config fly_delivery.billing_config;
  is_acceptance boolean:=tg_op='UPDATE' and old.status='placed' and new.status='preparing';
begin
  if new.commission_accepted_at is not null then return new; end if;
  if is_acceptance or (new.status='delivered' and (tg_op='INSERT' or old.status<>'delivered')) then
    perform pg_advisory_xact_lock(hashtextextended('fd-billing:'||new.store_id::text,0));
    if is_acceptance then
      new.commission_accepted_at:=clock_timestamp();
    else
      new.completed_at:=clock_timestamp();
    end if;
    select * into config from fly_delivery.billing_config where id=true for share;
    if new.platform_coupon_id is not null then
      new.commission_bps:=nullif(new.platform_coupon_commission_bps-new.coupon_bps,0);
      new.platform_fee_cents:=greatest(0,round((new.subtotal::bigint+new.coupon_discount_cents)::numeric
        *new.platform_coupon_commission_bps/10000)::integer-new.coupon_discount_cents);
    elsif new.promotion_bps is not null then
      new.commission_bps:=null;
      new.platform_fee_cents:=0;
    elsif config.payments_ready and config.commission_bps is not null then
      new.commission_bps:=config.commission_bps;
      new.platform_fee_cents:=round(new.subtotal::numeric*config.commission_bps/10000)::integer;
    end if;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION fly_delivery.close_daily_invoices(target_store uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare shop_id uuid; day_start timestamptz;
begin
  for shop_id in select id from fly_delivery.stores where not sample and (target_store is null or id=target_store) order by id loop
    perform pg_advisory_xact_lock(hashtextextended('fd-billing:'||shop_id::text,0));
    day_start:=date_trunc('day',clock_timestamp() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo';
    insert into fly_delivery.daily_invoices(store_id,invoice_date,due_at,sales_cents,amount_cents,order_count)
    select shop_id,(o.commission_at at time zone 'America/Sao_Paulo')::date,
      (((o.commission_at at time zone 'America/Sao_Paulo')::date+1)+time '12:00') at time zone 'America/Sao_Paulo',
      sum(o.subtotal)::bigint,sum(o.platform_fee_cents)::bigint,count(*)::integer
    from fly_delivery.commission_orders o
    where o.store_id=shop_id and o.commission_at<day_start
    group by (o.commission_at at time zone 'America/Sao_Paulo')::date
    having sum(o.platform_fee_cents)>0
    on conflict(store_id,invoice_date) do nothing;
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION fly_delivery.store_suspension_at(shop fly_delivery.stores, instant timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with debts as (
    select i.amount_cents,i.trust_released_at from fly_delivery.daily_invoices i
      where i.store_id=shop.id and i.status='pending' and i.due_at<=instant
    union all
    -- If the server was offline at midnight, checkout is still blocked at noon.
    select sum(o.platform_fee_cents)::bigint,null::timestamptz from fly_delivery.commission_orders o
      where o.store_id=shop.id
        and ((((o.commission_at at time zone 'America/Sao_Paulo')::date+1)+time '12:00') at time zone 'America/Sao_Paulo')<=instant
        and not exists(select 1 from fly_delivery.daily_invoices i where i.store_id=shop.id and i.invoice_date=(o.commission_at at time zone 'America/Sao_Paulo')::date)
      group by (o.commission_at at time zone 'America/Sao_Paulo')::date having sum(o.platform_fee_cents)>0
  ), summary as (
    select count(*)::integer overdue_count,coalesce(sum(amount_cents),0) overdue_cents,
      count(*) filter(where trust_released_at is null)::integer blocked_count,
      count(*) filter(where trust_released_at is not null)::integer trusted_count from debts
  )
  select jsonb_build_object('suspended',shop.suspended_at is not null or blocked_count>0,
    'manual',shop.suspended_at is not null,'automatic',blocked_count>0,
    'trusted',shop.suspended_at is null and blocked_count=0 and trusted_count>0,
    'overdue_count',overdue_count,'overdue_cents',overdue_cents,'blocked_count',blocked_count,'trusted_count',trusted_count,
    'reason',case when shop.suspended_at is not null then coalesce(nullif(shop.suspension_reason,''),'Estabelecimento suspenso pela administração. Acesse Faturas Fly Delivery para verificar as pendências.')
      when blocked_count>0 then 'Estabelecimento suspenso automaticamente por fatura Fly Delivery vencida. Quite as faturas em atraso para voltar à vitrine ou solicite uma liberação de confiança à administração.'
      when trusted_count>0 then 'Estabelecimento liberado por confiança pela administração. A dívida continua em aberto; quite as faturas vencidas.' else null end)
  from summary;
$function$;

CREATE OR REPLACE FUNCTION fly_delivery.billing_api(action_name text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare actor uuid:=auth.uid(); role_name text:=fly_delivery.actor_role(); config fly_delivery.billing_config;
  shop fly_delivery.stores; rate integer; page_input integer:=greatest(0,least(coalesce((payload->>'page')::integer,0),10000));
  result jsonb; today_totals jsonb; total integer; search_value text:=left(coalesce(payload->>'search',''),100);
begin
  if role_name not in ('admin','merchant') or role_name is null then raise exception 'FD: Acesso restrito.'; end if;
  select * into config from fly_delivery.billing_config where id=true;
  if action_name='billing_settings' then
    return jsonb_build_object('commission_bps',config.commission_bps,'payments_ready',config.payments_ready,'stores',case when role_name='merchant' then (select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'suspension',fly_delivery.store_suspension(s))),'[]'::jsonb) from fly_delivery.stores s where s.owner_id=actor and s.deleted_at is null and not s.sample) else '[]'::jsonb end);
  elsif action_name='admin_set_commission' then
    if role_name<>'admin' then raise exception 'FD: Acesso restrito à administração.'; end if;
    if jsonb_typeof(payload->'commission_bps') is distinct from 'number' or coalesce(payload->>'commission_bps','') !~ '^[0-9]{1,5}$' then raise exception 'FD: Informe uma porcentagem entre 0 e 100.'; end if;
    rate:=(payload->>'commission_bps')::integer;
    if rate not between 0 and 10000 then raise exception 'FD: Informe uma porcentagem entre 0 e 100.'; end if;
    update fly_delivery.billing_config set commission_bps=rate,updated_at=clock_timestamp() where id=true;
    insert into fly_delivery.commission_changes(commission_bps,changed_by) values(rate,actor);
    return jsonb_build_object('commission_bps',rate,'payments_ready',config.payments_ready);
  elsif action_name='admin_set_suspension' then
    if role_name<>'admin' then raise exception 'FD: Acesso restrito à administração.'; end if;
    select * into shop from fly_delivery.stores where id=(payload->>'id')::uuid and not sample and deleted_at is null for update;
    if not found then raise exception 'FD: Estabelecimento não encontrado.'; end if;
    if jsonb_typeof(payload->'suspend') is distinct from 'boolean' or char_length(coalesce(payload->>'reason',''))>500 then raise exception 'FD: Confira os dados da suspensão.'; end if;
    perform fly_delivery.close_daily_invoices(shop.id);
    if not (payload->>'suspend')::boolean and exists(select 1 from fly_delivery.daily_invoices where store_id=shop.id and status='pending' and due_at<=now()) then
      if payload->'trust' is distinct from 'true'::jsonb then raise exception 'FD: Confirme a liberação de confiança para manter a dívida em aberto.'; end if;
      update fly_delivery.daily_invoices set trust_released_at=clock_timestamp(),trust_released_by=actor
        where store_id=shop.id and status='pending' and due_at<=now();
    end if;
    update fly_delivery.stores set suspended_at=case when (payload->>'suspend')::boolean then clock_timestamp() else null end,
      suspension_reason=case when (payload->>'suspend')::boolean then coalesce(nullif(btrim(payload->>'reason'),''),'Estabelecimento suspenso por pendência de pagamento da comissão Fly Delivery. Acesse Faturas Fly Delivery para regularizar ou fale com a administração.') else null end where id=shop.id;
    return jsonb_build_object('id',shop.id);
  elsif action_name='admin_customers' then
    if role_name<>'admin' then raise exception 'FD: Acesso restrito à administração.'; end if;
    select count(*) into total from fly_delivery.customer_profiles p join fly_delivery.accounts a on a.id=p.user_id and a.role='customer'
      where search_value='' or p.full_name ilike '%'||search_value||'%' or p.phone ilike '%'||search_value||'%';
    select coalesce(jsonb_agg(to_jsonb(q) order by q.name,q.id),'[]'::jsonb) into result from (
      select p.user_id id,p.full_name name,p.phone,a.enabled
      from fly_delivery.customer_profiles p join fly_delivery.accounts a on a.id=p.user_id and a.role='customer'
      where search_value='' or p.full_name ilike '%'||search_value||'%' or p.phone ilike '%'||search_value||'%'
      order by p.full_name,p.user_id limit 40 offset page_input*40) q;
    return jsonb_build_object('customers',result,'count',total,'page',page_input,'pages',greatest(1,ceil(total/40.0)::integer));
  elsif action_name='merchant_invoices' then
    if role_name<>'merchant' then raise exception 'FD: Operação exclusiva do estabelecimento.'; end if;
    for shop in select * from fly_delivery.stores where owner_id=actor and not sample and deleted_at is null order by id loop perform fly_delivery.close_daily_invoices(shop.id); end loop;
    select coalesce(jsonb_agg(to_jsonb(q) order by q.invoice_date desc,q.id),'[]'::jsonb) into result from (
      select i.id,i.store_id,s.name store_name,i.invoice_date,i.due_at,i.sales_cents,i.amount_cents,i.order_count,i.status,i.paid_at,i.trust_released_at,
        (i.status='pending' and i.due_at<=now()) overdue
      from fly_delivery.daily_invoices i join fly_delivery.stores s on s.id=i.store_id
      where s.owner_id=actor and not s.sample and s.deleted_at is null
      order by i.invoice_date desc,i.id limit 40 offset page_input*40) q;
    select count(*) into total from fly_delivery.daily_invoices i join fly_delivery.stores s on s.id=i.store_id where s.owner_id=actor and s.deleted_at is null and not s.sample;
    select jsonb_build_object('date',(now() at time zone 'America/Sao_Paulo')::date,
      'sales_cents',coalesce(sum(o.subtotal),0),'amount_cents',coalesce(sum(o.platform_fee_cents),0))
      into today_totals
    from fly_delivery.commission_orders o join fly_delivery.stores s on s.id=o.store_id
    where s.owner_id=actor and not s.sample and s.deleted_at is null
      and (o.commission_at at time zone 'America/Sao_Paulo')::date=(now() at time zone 'America/Sao_Paulo')::date;
    return jsonb_build_object('invoices',result,'page',page_input,'count',total,'pages',greatest(1,ceil(total/40.0)::integer),
      'commission_bps',config.commission_bps,'payments_ready',config.payments_ready,
      'stores',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'suspension',fly_delivery.store_suspension(s))),'[]'::jsonb) from fly_delivery.stores s where s.owner_id=actor and s.deleted_at is null and not s.sample),
      'today',today_totals);
  end if;
  raise exception 'FD: Operação inválida.';
end;
$function$;

CREATE OR REPLACE FUNCTION fly_delivery.admin_commission_dashboard(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  period_name text:=coalesce(payload->>'period','7d');
  today date:=(now() at time zone 'America/Sao_Paulo')::date;
  start_date date; end_date date; range_start timestamptz; range_end timestamptz;
  page_number integer:=coalesce((payload->>'page')::integer,0);
  bucket text;
begin
  if auth.uid() is null or fly_delivery.actor_role() is distinct from 'admin' then
    raise exception 'FD: Dashboard exclusivo da administração.';
  end if;
  if page_number not between 0 and 1000000 then raise exception 'FD: Página inválida.'; end if;
  end_date:=today;
  case period_name
    when '7d' then start_date:=today-6;
    when '15d' then start_date:=today-14;
    when '30d' then start_date:=today-29;
    when '3m' then start_date:=(today-interval '3 months')::date+1;
    when 'day','range' then
      if coalesce(payload->>'date_from','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or (period_name='range' and coalesce(payload->>'date_to','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then
        raise exception 'FD: Informe as datas do período.';
      end if;
      start_date:=(payload->>'date_from')::date;
      end_date:=case when period_name='day' then start_date else (payload->>'date_to')::date end;
    else raise exception 'FD: Período inválido.';
  end case;
  if end_date<start_date then raise exception 'FD: A data final deve ser igual ou posterior à inicial.'; end if;
  if end_date-start_date>3660 then raise exception 'FD: Consulte um intervalo de até dez anos por vez.'; end if;
  bucket:=case when end_date-start_date>120 then 'month' else 'day' end;
  range_start:=start_date::timestamp at time zone 'America/Sao_Paulo';
  range_end:=(end_date+1)::timestamp at time zone 'America/Sao_Paulo';
  return (
    with sales as materialized (
      select o.store_id,s.name as store_name,o.subtotal,coalesce(o.platform_fee_cents,0) as commission,
        (o.commission_at at time zone 'America/Sao_Paulo')::date as sale_date
      from fly_delivery.commission_orders o join fly_delivery.stores s on s.id=o.store_id
      where not s.sample
        and o.commission_at>=range_start and o.commission_at<range_end
    ), summary as (
      select count(*) as orders,count(distinct store_id) as stores,coalesce(sum(subtotal),0) as sales_cents,
        coalesce(sum(commission),0) as commission_cents from sales
    ), grouped as (
      select date_trunc(bucket,sale_date::timestamp)::date as date,count(*) as orders,
        sum(subtotal) as sales_cents,sum(commission) as commission_cents from sales group by 1
    ), timeline as (
      select d::date as date,coalesce(g.orders,0) as orders,coalesce(g.sales_cents,0) as sales_cents,
        coalesce(g.commission_cents,0) as commission_cents
      from generate_series(date_trunc(bucket,start_date::timestamp),date_trunc(bucket,end_date::timestamp),
        case when bucket='day' then interval '1 day' else interval '1 month' end) d
      left join grouped g on g.date=d::date
    ), stores as (
      select store_id,store_name,count(*) as orders,sum(subtotal) as sales_cents,sum(commission) as commission_cents
      from sales group by store_id,store_name
    )
    select jsonb_build_object('period',period_name,'date_from',start_date,'date_to',end_date,'bucket',bucket,
      'timezone','America/Sao_Paulo','summary',to_jsonb(summary),
      'series',coalesce((select jsonb_agg(to_jsonb(timeline) order by date) from timeline),'[]'::jsonb),
      'top_stores',coalesce((select jsonb_agg(to_jsonb(t) order by commission_cents desc,store_id)
        from (select * from stores order by commission_cents desc,store_id limit 5) t),'[]'::jsonb),
      'stores',coalesce((select jsonb_agg(to_jsonb(t) order by commission_cents desc,store_id)
        from (select * from stores order by commission_cents desc,store_id limit 20 offset page_number*20) t),'[]'::jsonb),
      'page',page_number,'pages',greatest(1,ceil(summary.stores/20.0)::integer))
    from summary
  );
exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow or invalid_datetime_format then
  raise exception 'FD: Confira as datas e a página selecionadas.';
end;
$function$;

CREATE OR REPLACE FUNCTION fly_delivery.admin_manage_store(action_name text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  shop fly_delivery.stores;
  chosen_categories text[];
  store_name text:=btrim(payload->>'name');
begin
  if fly_delivery.actor_role() is distinct from 'admin' then raise exception 'FD: Acesso restrito à administração.'; end if;
  select * into shop from fly_delivery.stores where id=(payload->>'id')::uuid and not sample and deleted_at is null for update;
  if not found then raise exception 'FD: Estabelecimento não encontrado.'; end if;
  if action_name='admin_update_store' then
    if coalesce(char_length(store_name),0) not between 2 and 80 or jsonb_typeof(payload->'categories') is distinct from 'array' then
      raise exception 'FD: Informe o nome e as categorias do estabelecimento.';
    end if;
    select array_agg(distinct fly_delivery.category_name(value) order by fly_delivery.category_name(value)) into chosen_categories from jsonb_array_elements_text(payload->'categories');
    if chosen_categories is null or not (chosen_categories <@ array['Hambúrguer','Pizza','Marmitex','Porções','Macarrão','Salgados','Japonesa','Açaí','Telecerveja','Bebidas','Outros']) then
      raise exception 'FD: Selecione pelo menos uma categoria válida.';
    end if;
    update fly_delivery.stores set name=store_name,categories=chosen_categories,category=chosen_categories[1] where id=shop.id;
    update fly_delivery.products set category=null where store_id=shop.id and category is not null and not (category=any(chosen_categories || shop.menu_categories));
    return jsonb_build_object('id',shop.id);
  elsif action_name='admin_delete_store' then
    if exists(select 1 from fly_delivery.orders where store_id=shop.id and status not in ('delivered','cancelled')) then
      raise exception 'FD: Finalize ou cancele os pedidos em andamento antes de excluir o estabelecimento.';
    end if;
    perform fly_delivery.close_daily_invoices(shop.id);
    if exists(select 1 from fly_delivery.daily_invoices where store_id=shop.id and status='pending') or exists(select 1 from fly_delivery.commission_orders where store_id=shop.id and platform_fee_cents>0 and (commission_at at time zone 'America/Sao_Paulo')::date=(now() at time zone 'America/Sao_Paulo')::date) then raise exception 'FD: Regularize as faturas da plataforma antes de excluir o estabelecimento.'; end if;
    update fly_delivery.stores set deleted_at=clock_timestamp(),active=false,is_open=false where id=shop.id;
    if shop.owner_id is not null and not exists(select 1 from fly_delivery.stores where owner_id=shop.owner_id and deleted_at is null and not sample) then
      update fly_delivery.accounts set enabled=false,online=false where id=shop.owner_id and role='merchant';
    end if;
    return jsonb_build_object('id',shop.id,'deleted',true);
  end if;
  raise exception 'FD: Operação inválida.';
exception when invalid_text_representation or check_violation then
  raise exception 'FD: Confira os dados do estabelecimento.';
end;
$function$;

CREATE OR REPLACE FUNCTION fly_delivery.admin_history_cleanup(input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  period_name text := input->>'period';
  phase text := input->>'phase';
  start_date date;
  end_date date;
  paid_before date;
  shop_id uuid;
  paid_invoice_ids uuid[];
  invoice_ids uuid[];
  order_ids uuid[];
  order_fingerprint bigint;
  item_count bigint;
  removed_count bigint;
  preview_token text;
  result jsonb;
  retained jsonb;
  range_start timestamptz;
  range_end timestamptz;
begin
  if auth.uid() is null or fly_delivery.actor_role() is distinct from 'admin' then
    raise exception 'FD: Acesso exclusivo da administração.';
  end if;
  if coalesce(phase,'') not in ('preview','execute') then
    raise exception 'FD: Consulte a prévia antes de excluir.';
  end if;

  case period_name
    when '3m' then paid_before := (today-interval '3 months')::date;
    when '6m' then paid_before := (today-interval '6 months')::date;
    when '1y' then paid_before := (today-interval '1 year')::date;
    when 'day', 'range' then
      if coalesce(input->>'from','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or (period_name='range' and coalesce(input->>'to','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then
        raise exception 'FD: Informe as datas da limpeza.';
      end if;
      start_date := (input->>'from')::date;
      end_date := case when period_name='day' then start_date else (input->>'to')::date end;
      if start_date>end_date or end_date>=today then
        raise exception 'FD: Escolha um período encerrado, com data final até ontem.';
      end if;
    else raise exception 'FD: Selecione um período.';
  end case;

  if phase='execute' and (
    input->>'confirmation' is distinct from 'EXCLUIR'
    or coalesce(input->>'token','') !~ '^[0-9a-f]{32}$'
  ) then
    raise exception 'FD: Consulte a prévia e confirme a exclusão.';
  end if;
  if phase='execute' and not pg_try_advisory_xact_lock(hashtextextended('fd-history-cleanup',0)) then
    raise exception 'FD: Já existe uma limpeza em execução.';
  end if;

  select coalesce(array_agg(i.id order by i.id),'{}') into paid_invoice_ids
  from fly_delivery.daily_invoices i
  where i.status='paid' and i.paid_at is not null and i.invoice_date<today
    and case when paid_before is not null
      then i.paid_at < (paid_before::timestamp at time zone 'America/Sao_Paulo')
      else i.invoice_date between start_date and end_date end;

  if phase='execute' then
    -- Serialize with daily closing so a removed paid invoice cannot be recreated.
    for shop_id in
      select distinct i.store_id from fly_delivery.daily_invoices i
      where i.id=any(paid_invoice_ids) order by i.store_id
    loop
      if not pg_try_advisory_xact_lock(hashtextextended('fd-billing:'||shop_id::text,0)) then
        raise exception 'FD: O faturamento está sendo atualizado. Tente de novo em instantes.';
      end if;
    end loop;
  end if;

  -- Match the exact set of sales used by close_daily_invoices for each store and day.
  with billed_orders as materialized (
    select i.id as invoice_id, i.order_count, i.sales_cents, i.amount_cents,
      o.id as order_id, o.status, o.subtotal, o.platform_fee_cents
    from fly_delivery.daily_invoices i join fly_delivery.commission_orders o on o.store_id=i.store_id
      and o.commission_at >= (i.invoice_date::timestamp at time zone 'America/Sao_Paulo')
      and o.commission_at < ((i.invoice_date+1)::timestamp at time zone 'America/Sao_Paulo')
    where i.id=any(paid_invoice_ids) and i.status='paid'
  ), matched as (
    select b.invoice_id from billed_orders b
    group by b.invoice_id,b.order_count,b.sales_cents,b.amount_cents
    having bool_and(b.status in ('delivered','cancelled'))
      and count(*)=b.order_count and sum(b.subtotal)=b.sales_cents
      and sum(b.platform_fee_cents)=b.amount_cents
  )
  select coalesce(array_agg(distinct b.invoice_id order by b.invoice_id),'{}'),
    coalesce(array_agg(b.order_id),'{}'), bit_xor(hashtextextended(b.order_id::text,0))
  into invoice_ids,order_ids,order_fingerprint
  from billed_orders b join matched m using(invoice_id);

  select count(*) into item_count from fly_delivery.order_items where order_id=any(order_ids);
  preview_token := md5(format('%s|%s|%s|%s|%s|%s|%s|%s|%s',
    auth.uid(),period_name,start_date,end_date,paid_before,invoice_ids,
    cardinality(order_ids),order_fingerprint,item_count));
  result := jsonb_build_object('orders',cardinality(order_ids),'items',item_count,
    'invoices',cardinality(invoice_ids),'unmatched_invoices',cardinality(paid_invoice_ids)-cardinality(invoice_ids),
    'paid_before',paid_before,'from',start_date,'to',end_date,'token',preview_token);
  if phase='preview' then
    if start_date is not null then
      range_start := start_date::timestamp at time zone 'America/Sao_Paulo';
      range_end := (end_date+1)::timestamp at time zone 'America/Sao_Paulo';
      with remaining as (
        select case
          when o.status not in ('delivered','cancelled') then 'not_delivered'
          when billing.commission_at is null or billing.commission_at<range_start or billing.commission_at>=range_end then 'outside_invoice_day'
          when i.id is null then 'without_paid_invoice'
          else 'outside_billed_orders'
        end as reason
        from fly_delivery.orders o
        cross join lateral (select coalesce(o.commission_accepted_at,case when o.status='delivered' then o.completed_at end) as commission_at) billing
        left join fly_delivery.daily_invoices i on i.store_id=o.store_id
          and i.invoice_date=(billing.commission_at at time zone 'America/Sao_Paulo')::date
          and i.status='paid' and i.paid_at is not null
        where ((o.created_at>=range_start and o.created_at<range_end)
          or (billing.commission_at>=range_start and billing.commission_at<range_end))
          and not exists (select 1 from unnest(order_ids) eligible(id) where eligible.id=o.id)
      )
      select jsonb_build_object(
        'not_delivered',count(*) filter (where reason='not_delivered'),
        'outside_invoice_day',count(*) filter (where reason='outside_invoice_day'),
        'without_paid_invoice',count(*) filter (where reason='without_paid_invoice'),
        'outside_billed_orders',count(*) filter (where reason='outside_billed_orders'),
        'pending_invoices',(select count(*) from fly_delivery.daily_invoices
          where status='pending' and invoice_date between start_date and end_date)
      ) into retained from remaining;
      result := result || jsonb_build_object('retained',retained);
    end if;
    return result;
  end if;
  if input->>'token' is distinct from preview_token or cardinality(invoice_ids)=0 then
    raise exception 'FD: Os registros mudaram. Consulte uma nova prévia.';
  end if;

  delete from fly_delivery.order_items where order_id=any(order_ids);
  get diagnostics removed_count = row_count;
  if removed_count<>item_count then raise exception 'FD: Os itens mudaram. Consulte uma nova prévia.'; end if;

  with removed as (
    delete from fly_delivery.orders where id=any(order_ids) and status in ('delivered','cancelled')
    returning platform_coupon_id,status
  ), coupon_totals as (
    select platform_coupon_id,count(*) as uses from removed
    where platform_coupon_id is not null and status='delivered' group by platform_coupon_id
  ), preserved_uses as (
    update fly_delivery.platform_coupons c set archived_uses=c.archived_uses+t.uses
    from coupon_totals t where c.id=t.platform_coupon_id
  )
  select count(*) into removed_count from removed;
  if removed_count<>cardinality(order_ids) then raise exception 'FD: Os pedidos mudaram. Consulte uma nova prévia.'; end if;

  delete from fly_delivery.daily_invoices where id=any(invoice_ids) and status='paid';
  get diagnostics removed_count = row_count;
  if removed_count<>cardinality(invoice_ids) then raise exception 'FD: As faturas mudaram. Consulte uma nova prévia.'; end if;
  return result-'token';
exception
  when invalid_datetime_format or datetime_field_overflow then
    raise exception 'FD: Confira as datas informadas.';
end;
$function$;
