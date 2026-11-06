-- Read-only reporting, limited to enabled administrators. Values are BRL cents.
create function fly_delivery.admin_commission_dashboard(payload jsonb)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
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
        (o.completed_at at time zone 'America/Sao_Paulo')::date as sale_date
      from fly_delivery.orders o join fly_delivery.stores s on s.id=o.store_id
      where o.status='delivered' and o.commission_bps is not null and not s.sample
        and o.completed_at>=range_start and o.completed_at<range_end
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
$$;
revoke all on function fly_delivery.admin_commission_dashboard(jsonb) from public,anon;
grant execute on function fly_delivery.admin_commission_dashboard(jsonb) to authenticated;
create index fd_orders_platform_dashboard on fly_delivery.orders(completed_at,store_id)
  where status='delivered' and commission_bps is not null;

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
