create or replace function public.fd_api(action text, input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
begin
  if action='orders' and input ? 'view' then
    return fly_delivery.scoped_orders(input->>'view');
  end if;
  return fly_delivery.api(action,input);
end;
$$;
