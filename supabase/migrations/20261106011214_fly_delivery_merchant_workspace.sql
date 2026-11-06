alter table fly_delivery.orders add column customer_name text, add column completed_at timestamptz;

update fly_delivery.orders o set customer_name=p.full_name
from fly_delivery.customer_profiles p where p.user_id=o.customer_id;
update fly_delivery.orders o set completed_at=coalesce(
  (select min(e.created_at) from fly_delivery.order_events e where e.order_id=o.id and e.status=o.status),
  o.updated_at
) where o.status in ('delivered','cancelled');

create function fly_delivery.order_workspace_fields()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op='INSERT' then
    select full_name into new.customer_name from fly_delivery.customer_profiles where user_id=new.customer_id;
  end if;
  if new.status in ('delivered','cancelled') then
    if tg_op='INSERT' then new.completed_at:=clock_timestamp();
    elsif old.status is distinct from new.status then new.completed_at:=clock_timestamp();
    else new.completed_at:=old.completed_at;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function fly_delivery.order_workspace_fields() from public,anon,authenticated;
create trigger fd_order_workspace_fields before insert or update of status on fly_delivery.orders
  for each row execute function fly_delivery.order_workspace_fields();
create index fd_orders_finished on fly_delivery.orders(store_id,completed_at desc,id)
  where status in ('delivered','cancelled');

create function fly_delivery.merchant_order_details(o fly_delivery.orders)
returns jsonb language sql stable set search_path = ''
as $$
  select fly_delivery.order_details(o,true) || jsonb_build_object(
    'customer_name',coalesce(nullif(o.customer_name,''),'Cliente'),
    'completed_at',o.completed_at
  );
$$;
revoke all on function fly_delivery.merchant_order_details(fly_delivery.orders) from public,anon,authenticated;

create function fly_delivery.merchant_workspace(action_name text, payload jsonb)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
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
        coalesce(sum(fee),0) as delivery,coalesce(sum(subtotal::bigint+fee),0) as total from sales
    ), daily as (
      select (completed_at at time zone 'America/Sao_Paulo')::date as day,count(*) as amount,
        sum(subtotal) as products,sum(fee) as delivery,sum(subtotal::bigint+fee) as total
      from sales group by 1
    ), selected_orders as (
      select * from sales order by completed_at desc,id limit 25 offset page_number*25
    )
    select jsonb_build_object('count',amount,'products',products,'delivery',delivery,'total',total,
      'page',page_number,'pages',ceil(amount/25.0),'date_from',start_date,'date_to',end_date,
      'days',coalesce((select jsonb_agg(to_jsonb(daily) order by day desc) from daily),'[]'::jsonb),
      'orders',coalesce((select jsonb_agg(fly_delivery.merchant_order_details(selected_orders)
        order by completed_at desc,id) from selected_orders),'[]'::jsonb))
    from summary
  );
exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow or invalid_datetime_format then
  raise exception 'FD: Confira as datas e a página selecionadas.';
end;
$$;
revoke all on function fly_delivery.merchant_workspace(text,jsonb) from public,anon,authenticated;
grant execute on function fly_delivery.merchant_workspace(text,jsonb) to authenticated;

create or replace function public.fd_api(action text, input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
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
  if action in ('merchant_active_orders','merchant_history','merchant_finance') then
    return fly_delivery.merchant_workspace(action,input);
  end if;
  if action='customer_profile' then return fly_delivery.customer_profile(input); end if;
  if action='assign_operator' then return fly_delivery.assign_operator(input); end if;
  if action='managed_stores' then return fly_delivery.operator_stores(); end if;
  if action='couriers' then return fly_delivery.operator_couriers(); end if;
  if action='save_store_profile' then return fly_delivery.save_store_profile(input); end if;
  if action in ('save_store','register_store','set_courier') then raise exception 'FD: Use o cadastro de acessos da administração.'; end if;
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
$$;
