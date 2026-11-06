CREATE OR REPLACE FUNCTION fly_delivery.merchant_workspace(action_name text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid();
  page_number integer;
  terminal_status text;
  total_count bigint;
  rows jsonb;
  start_date date;
  end_date date;
  range_start timestamptz;
  range_end timestamptz;
begin
  if fly_delivery.actor_role() is distinct from 'merchant' then
    raise exception 'FD: Acesso exclusivo do estabelecimento.';
  end if;
  if action_name='merchant_active_orders' then
    return coalesce((select jsonb_agg(fly_delivery.merchant_order_details(o) order by o.created_at,o.id)
      from fly_delivery.orders o join fly_delivery.stores s on s.id=o.store_id
      where s.owner_id=actor and o.status in ('placed','preparing','ready','assigned','picked_up')),'[]'::jsonb);
  end if;

  page_number := coalesce((payload->>'page')::integer,0);
  if page_number<0 or page_number>1000000 then raise exception 'FD: Página inválida.'; end if;
  if action_name='merchant_history' then
    terminal_status := coalesce(payload->>'status','delivered');
    if terminal_status not in ('delivered','cancelled','all') then raise exception 'FD: Filtro inválido.'; end if;
    select count(*) into total_count from fly_delivery.orders o join fly_delivery.stores s on s.id=o.store_id
      where s.owner_id=actor and o.status in ('delivered','cancelled')
        and (terminal_status='all' or o.status=terminal_status);
    select coalesce(jsonb_agg(fly_delivery.merchant_order_details(q) order by q.completed_at desc,q.id),'[]'::jsonb)
      into rows
      from (select o.* from fly_delivery.orders o join fly_delivery.stores s on s.id=o.store_id
        where s.owner_id=actor and o.status in ('delivered','cancelled')
          and (terminal_status='all' or o.status=terminal_status)
        order by o.completed_at desc,o.id limit 25 offset page_number*25) q;
    return jsonb_build_object('count',total_count,'page',page_number,'pages',ceil(total_count/25.0),'orders',rows);
  end if;
  if action_name<>'merchant_finance' then raise exception 'FD: Consulta inválida.'; end if;

  if coalesce(payload->>'date_from','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or coalesce(payload->>'date_to','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'FD: Informe a data inicial e a data final.';
  end if;
  start_date := (payload->>'date_from')::date;
  end_date := (payload->>'date_to')::date;
  if end_date<start_date then raise exception 'FD: A data final deve ser igual ou posterior à inicial.'; end if;
  range_start := start_date::timestamp at time zone 'America/Sao_Paulo';
  range_end := (end_date+1)::timestamp at time zone 'America/Sao_Paulo';

  return (
    with sales as materialized (
      select o.* from fly_delivery.orders o join fly_delivery.stores s on s.id=o.store_id
      where s.owner_id=actor and o.status='delivered'
        and o.completed_at>=range_start and o.completed_at<range_end
    ), summary as (
      select count(*) as amount,coalesce(sum(subtotal),0) as products,
        coalesce(sum(fee),0) as delivery,coalesce(sum(subtotal::bigint+fee),0) as total,
        coalesce(sum(platform_fee_cents),0) as platform,
        coalesce(sum(subtotal::bigint+fee-coalesce(platform_fee_cents,0)),0) as net from sales
    ), daily as (
      select (completed_at at time zone 'America/Sao_Paulo')::date as day,count(*) as amount,
        sum(subtotal) as products,sum(fee) as delivery,sum(subtotal::bigint+fee) as total,
        coalesce(sum(platform_fee_cents),0) as platform,
        sum(subtotal::bigint+fee-coalesce(platform_fee_cents,0)) as net
      from sales group by 1
    ), selected_orders as (
      select * from sales order by completed_at desc,id limit 25 offset page_number*25
    )
    select jsonb_build_object('count',amount,'products',products,'delivery',delivery,'total',total,'platform',platform,'net',net,
      'page',page_number,'pages',ceil(amount/25.0),'date_from',start_date,'date_to',end_date,
      'days',coalesce((select jsonb_agg(to_jsonb(daily) order by day desc) from daily),'[]'::jsonb),
      'orders',coalesce((select jsonb_agg(fly_delivery.merchant_order_details(selected_orders) || jsonb_build_object(
        'platform',coalesce(selected_orders.platform_fee_cents,0),
        'net',selected_orders.subtotal::bigint+selected_orders.fee-coalesce(selected_orders.platform_fee_cents,0))
        order by completed_at desc,id) from selected_orders),'[]'::jsonb))
    from summary
  );
exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow or invalid_datetime_format then
  raise exception 'FD: Confira as datas e a página selecionadas.';
end;
$function$;

-- Opt-in small batches for scrolling history; existing clients retain 25 rows.
create or replace function fly_delivery.customer_orders(action_name text,payload jsonb)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare actor uuid:=auth.uid(); page_number integer:=coalesce((payload->>'page')::integer,0); page_size integer:=coalesce((payload->>'page_size')::integer,25); total bigint; result jsonb;
begin
  if fly_delivery.actor_role() is distinct from 'customer' then raise exception 'FD: Consulta exclusiva do cliente.'; end if;
  if page_number not between 0 and 1000000 or page_size not between 1 and 25 then raise exception 'FD: Página inválida.'; end if;
  if action_name='customer_active_orders' then
    select coalesce(jsonb_agg(fly_delivery.order_details(o,true) order by o.created_at desc,o.id),'[]'::jsonb)
      into result from fly_delivery.orders o where o.customer_id=actor and o.status not in ('delivered','cancelled');
    return jsonb_build_object('orders',result,'count',jsonb_array_length(result),'page',0,'pages',1);
  elsif action_name='customer_order_history' then
    select count(*) into total from fly_delivery.orders where customer_id=actor and status in ('delivered','cancelled');
    select coalesce(jsonb_agg(fly_delivery.order_details(q,true) order by q.completed_at desc nulls last,q.created_at desc,q.id),'[]'::jsonb)
      into result from (select * from fly_delivery.orders where customer_id=actor and status in ('delivered','cancelled')
        order by completed_at desc nulls last,created_at desc,id limit page_size offset page_number*page_size) q;
    return jsonb_build_object('orders',result,'count',total,'page',page_number,'page_size',page_size,'pages',greatest(1,ceil(total::numeric/page_size)::integer));
  end if;
  raise exception 'FD: Consulta inválida.';
exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'FD: Página inválida.';
end;
$$;
