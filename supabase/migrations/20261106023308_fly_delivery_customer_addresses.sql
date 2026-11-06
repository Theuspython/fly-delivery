-- One primary delivery address per registered customer; orders keep their own snapshot.
create table fly_delivery.customer_addresses (
  customer_id uuid primary key references fly_delivery.customer_profiles(user_id) on delete cascade,
  street text not null check (char_length(btrim(street)) between 2 and 120),
  number text not null check (char_length(btrim(number)) between 1 and 20),
  neighborhood text not null check (char_length(btrim(neighborhood)) between 2 and 80),
  updated_at timestamptz not null default now()
);
alter table fly_delivery.customer_addresses enable row level security;
revoke all on table fly_delivery.customer_addresses from public,anon,authenticated;
create policy fd_primary_address_owner on fly_delivery.customer_addresses
  for all to authenticated
  using ((select auth.uid())=customer_id and (select fly_delivery.actor_role())='customer')
  with check ((select auth.uid())=customer_id and (select fly_delivery.actor_role())='customer');

create function fly_delivery.customer_address(action_name text,payload jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  saved fly_delivery.customer_addresses;
  street_input text := btrim(payload->>'street');
  number_input text := btrim(payload->>'number');
  neighborhood_input text := btrim(payload->>'neighborhood');
begin
  if actor is null or fly_delivery.actor_role() is distinct from 'customer' then
    raise exception 'FD: Endereço exclusivo da conta do cliente.';
  end if;
  if action_name='save_customer_address' then
    if jsonb_typeof(payload->'street') is distinct from 'string' or
       jsonb_typeof(payload->'number') is distinct from 'string' or
       jsonb_typeof(payload->'neighborhood') is distinct from 'string' or
       coalesce(char_length(street_input),0) not between 2 and 120 or
       coalesce(char_length(number_input),0) not between 1 and 20 or
       coalesce(char_length(neighborhood_input),0) not between 2 and 80 then
      raise exception 'FD: Preencha rua, número e bairro corretamente.';
    end if;
    insert into fly_delivery.customer_addresses(customer_id,street,number,neighborhood)
    values(actor,street_input,number_input,neighborhood_input)
    on conflict(customer_id) do update set street=excluded.street,number=excluded.number,
      neighborhood=excluded.neighborhood,updated_at=now()
    returning * into saved;
  elsif action_name='customer_address' then
    select * into saved from fly_delivery.customer_addresses where customer_id=actor;
    if not found then return null; end if;
  else raise exception 'FD: Operação de endereço inválida.';
  end if;
  return jsonb_build_object('street',saved.street,'number',saved.number,'neighborhood',saved.neighborhood,
    'text',saved.street || ', ' || saved.number || ' - ' || saved.neighborhood);
exception when foreign_key_violation then
  raise exception 'FD: Complete seu cadastro antes de salvar o endereço.';
end;
$$;
revoke all on function fly_delivery.customer_address(text,jsonb) from public,anon,authenticated;
grant execute on function fly_delivery.customer_address(text,jsonb) to authenticated;

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
  if action in ('customer_address','save_customer_address') then
    return fly_delivery.customer_address(action,input);
  end if;
  if action in ('merchant_active_orders','merchant_history','merchant_finance') then
    return fly_delivery.merchant_workspace(action,input);
  end if;
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
