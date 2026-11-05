create function fly_delivery.scoped_orders(view_name text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  profile fly_delivery.accounts;
begin
  select * into profile from fly_delivery.accounts where id=actor and enabled;
  if not found then raise exception 'FD: Acesso indisponível.'; end if;
  if not coalesce(view_name='customer' or (view_name='merchant' and profile.role in ('merchant','admin')) or
    (view_name='courier' and profile.role='courier') or (view_name='admin' and profile.role='admin'),false) then
    raise exception 'FD: Acesso indisponível.';
  end if;
  return coalesce((select jsonb_agg(fly_delivery.order_details(q,true) order by q.created_at desc)
    from (select ord.* from fly_delivery.orders ord join fly_delivery.stores st on st.id=ord.store_id
      where (view_name='customer' and ord.customer_id=actor)
        or (view_name='courier' and ord.courier_id=actor)
        or (view_name='merchant' and (st.owner_id=actor or profile.role='admin'))
        or view_name='admin'
      order by ord.created_at desc limit 80) q),'[]'::jsonb);
end;
$$;
revoke all on function fly_delivery.scoped_orders(text) from public, anon, authenticated;
grant execute on function fly_delivery.scoped_orders(text) to authenticated;

create or replace function public.fd_api(action text, input jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$
  select case when action='orders' and input ? 'view' then fly_delivery.scoped_orders(input->>'view')
    else fly_delivery.api(action,input) end;
$$;
