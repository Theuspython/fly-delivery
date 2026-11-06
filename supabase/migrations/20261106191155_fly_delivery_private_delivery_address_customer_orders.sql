-- Protect delivery information in every merchant order response, including legacy reads.
CREATE OR REPLACE FUNCTION fly_delivery.order_details(o fly_delivery.orders, reveal boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object('id',o.id,'store_id',s.id,'store',s.name,'status',o.status,
    'created_at',o.created_at,'updated_at',o.updated_at,'fee',o.fee,
    'pickup',s.address,'pickup_lat',s.lat,'pickup_lng',s.lng)
    || case when reveal then jsonb_build_object('subtotal',o.subtotal,'payment',o.payment,'note',o.customer_note,'courier_assigned',o.courier_id is not null,
      'items',coalesce((select jsonb_agg(jsonb_build_object('name',i.name,'price',i.price,'quantity',i.quantity,'options',i.options,'size',i.size) order by i.name)
        from fly_delivery.order_items i where i.order_id=o.id),'[]'::jsonb),
      'events',coalesce((select jsonb_agg(jsonb_build_object('status',e.status,'created_at',e.created_at) order by e.id)
        from fly_delivery.order_events e where e.order_id=o.id),'[]'::jsonb)) else '{}'::jsonb end
    || case when (select fly_delivery.actor_role())='merchant' and
      (o.status='placed' or (o.status='cancelled' and not exists(select 1 from fly_delivery.order_events e
        where e.order_id=o.id and e.status in ('preparing','ready','assigned','picked_up','delivered'))))
      then jsonb_build_object('address_hidden',true)
      when reveal then jsonb_build_object('address',o.address,'lat',o.lat,'lng',o.lng,'distance_km',o.distance_km)
      else jsonb_build_object('distance_km',o.distance_km) end
  from fly_delivery.stores s where s.id=o.store_id;
$function$;

-- Status filtering precedes pagination, so completed orders cannot hide active ones.
create function fly_delivery.customer_orders(action_name text,payload jsonb)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare actor uuid:=auth.uid(); page_number integer:=coalesce((payload->>'page')::integer,0); total bigint; result jsonb;
begin
  if fly_delivery.actor_role() is distinct from 'customer' then raise exception 'FD: Consulta exclusiva do cliente.'; end if;
  if page_number not between 0 and 1000000 then raise exception 'FD: Página inválida.'; end if;
  if action_name='customer_active_orders' then
    select coalesce(jsonb_agg(fly_delivery.order_details(o,true) order by o.created_at desc,o.id),'[]'::jsonb)
      into result from fly_delivery.orders o where o.customer_id=actor and o.status not in ('delivered','cancelled');
    return jsonb_build_object('orders',result,'count',jsonb_array_length(result),'page',0,'pages',1);
  elsif action_name='customer_order_history' then
    select count(*) into total from fly_delivery.orders where customer_id=actor and status in ('delivered','cancelled');
    select coalesce(jsonb_agg(fly_delivery.order_details(q,true) order by q.completed_at desc nulls last,q.created_at desc,q.id),'[]'::jsonb)
      into result from (select * from fly_delivery.orders where customer_id=actor and status in ('delivered','cancelled')
        order by completed_at desc nulls last,created_at desc,id limit 25 offset page_number*25) q;
    return jsonb_build_object('orders',result,'count',total,'page',page_number,'pages',greatest(1,ceil(total/25.0)::integer));
  end if;
  raise exception 'FD: Consulta inválida.';
exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'FD: Página inválida.';
end;
$$;
revoke all on function fly_delivery.customer_orders(text,jsonb) from public,anon;
grant execute on function fly_delivery.customer_orders(text,jsonb) to authenticated;
create index fd_customer_active_orders on fly_delivery.orders(customer_id,created_at desc,id)
  where status not in ('delivered','cancelled');
create index fd_customer_order_history on fly_delivery.orders(customer_id,completed_at desc nulls last,created_at desc,id)
  where status in ('delivered','cancelled');

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
