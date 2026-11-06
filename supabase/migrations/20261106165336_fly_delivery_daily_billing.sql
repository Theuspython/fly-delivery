-- Billing is isolated from Flycar. All amounts are integer BRL cents.
create table fly_delivery.billing_config (
  id boolean primary key default true check(id),
  commission_bps integer check(commission_bps between 0 and 10000),
  payments_ready boolean not null default false,
  bridge_hash text,
  updated_at timestamptz not null default now()
);
insert into fly_delivery.billing_config(id) values(true);
create table fly_delivery.commission_changes (
  id bigint generated always as identity primary key,
  commission_bps integer not null check(commission_bps between 0 and 10000),
  changed_by uuid not null references fly_delivery.accounts,
  changed_at timestamptz not null default clock_timestamp()
);
alter table fly_delivery.stores add column suspended_at timestamptz;
alter table fly_delivery.stores add column suspension_reason text check(char_length(suspension_reason)<=500);
alter table fly_delivery.orders add column commission_bps integer check(commission_bps between 0 and 10000);
alter table fly_delivery.orders add column platform_fee_cents integer check(platform_fee_cents>=0);
create index fd_orders_commission_day on fly_delivery.orders(store_id,completed_at) where platform_fee_cents>0 and status='delivered';
create table fly_delivery.daily_invoices (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references fly_delivery.stores,
  invoice_date date not null,
  due_at timestamptz not null,
  sales_cents bigint not null check(sales_cents>0),
  amount_cents bigint not null check(amount_cents>0 and amount_cents<=2147483647),
  order_count integer not null check(order_count>0),
  status text not null default 'pending' check(status in ('pending','paid')),
  checkout_url text,
  checkout_lock_at timestamptz,
  checkout_lock_id uuid,
  paid_at timestamptz,
  transaction_nsu text,
  payment_slug text,
  created_at timestamptz not null default clock_timestamp(),
  unique(store_id,invoice_date)
);
create unique index fd_invoice_payment_identity on fly_delivery.daily_invoices(transaction_nsu,payment_slug) where transaction_nsu is not null;
alter table fly_delivery.billing_config enable row level security;
alter table fly_delivery.commission_changes enable row level security;
alter table fly_delivery.daily_invoices enable row level security;
revoke all on fly_delivery.billing_config,fly_delivery.commission_changes,fly_delivery.daily_invoices from public,anon,authenticated;

create function fly_delivery.capture_commission()
returns trigger language plpgsql security definer set search_path=''
as $$
declare config fly_delivery.billing_config;
begin
  if new.status='delivered' and (tg_op='INSERT' or old.status<>'delivered') then
    perform pg_advisory_xact_lock(hashtextextended('fd-billing:'||new.store_id::text,0));
    new.completed_at:=clock_timestamp();
    select * into config from fly_delivery.billing_config where id=true for share;
    if config.payments_ready and config.commission_bps is not null then
      new.commission_bps:=config.commission_bps;
      new.platform_fee_cents:=round(new.subtotal::numeric*config.commission_bps/10000)::integer;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function fly_delivery.capture_commission() from public,anon,authenticated;
create trigger zz_fd_capture_commission before insert or update of status on fly_delivery.orders
  for each row execute function fly_delivery.capture_commission();

create function fly_delivery.close_daily_invoices(target_store uuid default null)
returns void language plpgsql security definer set search_path=''
as $$
declare shop_id uuid;
begin
  for shop_id in select id from fly_delivery.stores where not sample and (target_store is null or id=target_store) order by id loop
    perform pg_advisory_xact_lock(hashtextextended('fd-billing:'||shop_id::text,0));
    insert into fly_delivery.daily_invoices(store_id,invoice_date,due_at,sales_cents,amount_cents,order_count)
    select shop_id,(o.completed_at at time zone 'America/Sao_Paulo')::date,
      (((o.completed_at at time zone 'America/Sao_Paulo')::date+1)+time '12:00') at time zone 'America/Sao_Paulo',
      sum(o.subtotal)::bigint,sum(o.platform_fee_cents)::bigint,count(*)::integer
    from fly_delivery.orders o
    where o.store_id=shop_id and o.status='delivered' and o.commission_bps is not null
      and (o.completed_at at time zone 'America/Sao_Paulo')::date<(clock_timestamp() at time zone 'America/Sao_Paulo')::date
    group by (o.completed_at at time zone 'America/Sao_Paulo')::date
    having sum(o.platform_fee_cents)>0
    on conflict(store_id,invoice_date) do nothing;
  end loop;
end;
$$;
revoke all on function fly_delivery.close_daily_invoices(uuid) from public,anon,authenticated;

create function fly_delivery.store_suspension(shop fly_delivery.stores)
returns jsonb language sql stable security definer set search_path=''
as $$
  select jsonb_build_object('suspended',shop.suspended_at is not null or overdue,'manual',shop.suspended_at is not null,
    'reason',case when shop.suspended_at is not null then coalesce(nullif(shop.suspension_reason,''),'Estabelecimento suspenso pela administração. Acesse Faturas Fly Delivery para verificar as pendências.')
      when overdue then 'Seu estabelecimento está suspenso para novos pedidos por falta de pagamento da comissão Fly Delivery. Acesse Faturas Fly Delivery para regularizar.' else null end)
  from (select (select payments_ready from fly_delivery.billing_config where id=true) and exists(
    select 1 from fly_delivery.orders o left join fly_delivery.daily_invoices i
      on i.store_id=o.store_id and i.invoice_date=(o.completed_at at time zone 'America/Sao_Paulo')::date
    where o.store_id=shop.id and o.status='delivered' and o.platform_fee_cents>0 and
      ((((o.completed_at at time zone 'America/Sao_Paulo')::date+1)+time '12:00') at time zone 'America/Sao_Paulo')<=now()
      and coalesce(i.status,'pending')='pending') as overdue) q;
$$;
revoke all on function fly_delivery.store_suspension(fly_delivery.stores) from public,anon,authenticated;

create function fly_delivery.billing_api(action_name text,payload jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare actor uuid:=auth.uid(); role_name text:=fly_delivery.actor_role(); config fly_delivery.billing_config;
  shop fly_delivery.stores; rate integer; page_input integer:=greatest(0,least(coalesce((payload->>'page')::integer,0),10000));
  result jsonb; total integer; search_value text:=left(coalesce(payload->>'search',''),100);
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
    for shop in select * from fly_delivery.stores where owner_id=actor and not sample and deleted_at is null loop perform fly_delivery.close_daily_invoices(shop.id); end loop;
    select coalesce(jsonb_agg(to_jsonb(q) order by q.invoice_date desc,q.id),'[]'::jsonb) into result from (
      select i.id,i.store_id,s.name store_name,i.invoice_date,i.due_at,i.sales_cents,i.amount_cents,i.order_count,i.status,i.paid_at,
        (i.status='pending' and i.due_at<=now()) overdue
      from fly_delivery.daily_invoices i join fly_delivery.stores s on s.id=i.store_id
      where s.owner_id=actor and not s.sample and s.deleted_at is null
      order by i.invoice_date desc,i.id limit 40 offset page_input*40) q;
    select count(*) into total from fly_delivery.daily_invoices i join fly_delivery.stores s on s.id=i.store_id where s.owner_id=actor and s.deleted_at is null and not s.sample;
    return jsonb_build_object('invoices',result,'page',page_input,'count',total,'pages',greatest(1,ceil(total/40.0)::integer),
      'commission_bps',config.commission_bps,'payments_ready',config.payments_ready,
      'stores',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'suspension',fly_delivery.store_suspension(s))),'[]'::jsonb) from fly_delivery.stores s where s.owner_id=actor and s.deleted_at is null and not s.sample),
      'today',jsonb_build_object('date',(now() at time zone 'America/Sao_Paulo')::date,
        'sales_cents',(select coalesce(sum(o.subtotal),0) from fly_delivery.orders o join fly_delivery.stores s on s.id=o.store_id where s.owner_id=actor and o.status='delivered' and o.commission_bps is not null and (o.completed_at at time zone 'America/Sao_Paulo')::date=(now() at time zone 'America/Sao_Paulo')::date),
        'amount_cents',(select coalesce(sum(o.platform_fee_cents),0) from fly_delivery.orders o join fly_delivery.stores s on s.id=o.store_id where s.owner_id=actor and o.status='delivered' and o.commission_bps is not null and (o.completed_at at time zone 'America/Sao_Paulo')::date=(now() at time zone 'America/Sao_Paulo')::date)));
  end if;
  raise exception 'FD: Operação inválida.';
end;
$$;
revoke all on function fly_delivery.billing_api(text,jsonb) from public,anon;
grant execute on function fly_delivery.billing_api(text,jsonb) to authenticated;

-- Only the backend can create/verify a payment. End users never receive this credential.
create function public.fd_billing_backend(secret text,action text,input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare config fly_delivery.billing_config; invoice fly_delivery.daily_invoices; lock_id uuid; ready boolean;
begin
  select * into config from fly_delivery.billing_config where id=true;
  if config.bridge_hash is null or char_length(coalesce(secret,''))<48 or encode(extensions.digest(secret,'sha256'),'hex') is distinct from config.bridge_hash then raise exception 'FD: Acesso restrito ao servidor.'; end if;
  if action='tick' then
    ready:=coalesce((input->>'payments_ready')::boolean,false);
    update fly_delivery.billing_config set payments_ready=ready where id=true;
    perform fly_delivery.close_daily_invoices(null);
    return '{}'::jsonb;
  end if;
  if action='get' then
    select * into invoice from fly_delivery.daily_invoices where id=(input->>'id')::uuid;
    if not found then raise exception 'FD: Fatura não encontrada.'; end if;
    if input ? 'actor' and not exists(select 1 from fly_delivery.stores s join fly_delivery.accounts a on a.id=s.owner_id where s.id=invoice.store_id and s.owner_id=(input->>'actor')::uuid and s.deleted_at is null and a.enabled and a.role='merchant') then raise exception 'FD: Fatura não encontrada.'; end if;
    return to_jsonb(invoice);
  end if;
  select * into invoice from fly_delivery.daily_invoices where id=(input->>'id')::uuid for update;
  if not found then raise exception 'FD: Fatura não encontrada.'; end if;
  if action='acquire' then
    if not exists(select 1 from fly_delivery.stores s join fly_delivery.accounts a on a.id=s.owner_id where s.id=invoice.store_id and s.owner_id=(input->>'actor')::uuid and s.deleted_at is null and a.enabled and a.role='merchant') then raise exception 'FD: Fatura não encontrada.'; end if;
    if invoice.status<>'pending' then raise exception 'FD: Esta fatura já está paga.'; end if;
    if invoice.checkout_url is not null then return to_jsonb(invoice); end if;
    if invoice.checkout_lock_at>clock_timestamp()-interval '2 minutes' then raise exception 'FD: Pagamento sendo preparado. Tente novamente em instantes.'; end if;
    lock_id:=gen_random_uuid();
    update fly_delivery.daily_invoices set checkout_lock_id=lock_id,checkout_lock_at=clock_timestamp() where id=invoice.id returning * into invoice;
    return to_jsonb(invoice);
  elsif action='save_link' then
    if invoice.checkout_lock_id is distinct from (input->>'lock_id')::uuid or invoice.status<>'pending' then raise exception 'FD: Atualize a fatura antes de pagar.'; end if;
    if coalesce(input->>'url','') !~ '^https://([a-z0-9-]+\.)*infinitepay\.io/' then raise exception 'FD: Link de pagamento inválido.'; end if;
    update fly_delivery.daily_invoices set checkout_url=input->>'url',checkout_lock_at=null,checkout_lock_id=null where id=invoice.id;
    return '{}'::jsonb;
  elsif action='release' then
    update fly_delivery.daily_invoices set checkout_lock_at=null,checkout_lock_id=null where id=invoice.id and checkout_lock_id=(input->>'lock_id')::uuid;
    return '{}'::jsonb;
  elsif action='paid' then
    if invoice.status='paid' then return jsonb_build_object('paid',true); end if;
    if invoice.checkout_url is null or invoice.amount_cents is distinct from (input->>'amount')::bigint then raise exception 'FD: O valor confirmado diverge da fatura.'; end if;
    if coalesce(char_length(input->>'transaction'),0) not between 1 and 150 or coalesce(char_length(input->>'slug'),0) not between 1 and 150 then raise exception 'FD: Dados de transação inválidos.'; end if;
    update fly_delivery.daily_invoices set status='paid',paid_at=clock_timestamp(),transaction_nsu=input->>'transaction',payment_slug=input->>'slug',checkout_lock_at=null,checkout_lock_id=null where id=invoice.id;
    return jsonb_build_object('paid',true);
  end if;
  raise exception 'FD: Operação inválida.';
end;
$$;
revoke all on function public.fd_billing_backend(text,text,jsonb) from public,authenticated;
grant execute on function public.fd_billing_backend(text,text,jsonb) to anon;

CREATE OR REPLACE FUNCTION fly_delivery.store_open_at(store fly_delivery.stores, instant timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  local_time timestamp := instant at time zone 'America/Sao_Paulo';
  day_number integer := extract(dow from local_time)::integer;
  clock_now text := to_char(local_time,'HH24:MI');
  today jsonb := store.weekly_hours->day_number;
  yesterday jsonb := store.weekly_hours->((day_number+6)%7);
begin
  if (fly_delivery.store_suspension(store)->>'suspended')::boolean or store.deleted_at is not null or not store.is_open or not store.active or store.sample then return false; end if;
  if store.weekly_hours is null then return true; end if;
  return coalesce(
    (today->>'open'=today->>'close') or
    (today->>'open'<today->>'close' and clock_now>=today->>'open' and clock_now<today->>'close') or
    (today->>'open'>today->>'close' and clock_now>=today->>'open') or
    (yesterday->>'open'>yesterday->>'close' and clock_now<yesterday->>'close'),false);
end;
$function$;

CREATE OR REPLACE FUNCTION fly_delivery.market_catalog()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',st.id,'name',st.name,'description',st.description,'category',st.category,'categories',st.categories,
    'image',st.image,'is_open',fly_delivery.store_open_at(st,now()),
    'fee',st.fee,'eta',st.eta,
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',pr.id,'name',pr.name,'description',pr.description,
      'price',pr.price,'image',pr.image,'category',pr.category,'options',pr.options,'sizes',pr.sizes) order by pr.name)
      from fly_delivery.products pr where pr.store_id=st.id and pr.active),'[]'::jsonb))
    order by fly_delivery.store_open_at(st,now()) desc,st.name),'[]'::jsonb)
  from fly_delivery.stores st
  where not (fly_delivery.store_suspension(st)->>'suspended')::boolean and st.active and not st.sample and st.deleted_at is null and st.address is not null;
$function$;

CREATE OR REPLACE FUNCTION fly_delivery.operator_stores()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor_role text := fly_delivery.actor_role();
begin
  if actor_role='admin' then
    return coalesce((select jsonb_agg(jsonb_build_object(
      'id',s.id,'name',s.name,'categories',s.categories,'active',s.active,'suspension',fly_delivery.store_suspension(s),
      'owner_login',u.raw_app_meta_data->'fly_delivery_operator'->>'login') order by s.name)
      from fly_delivery.stores s left join auth.users u on u.id=s.owner_id where not s.sample and s.deleted_at is null),'[]'::jsonb);
  elsif actor_role='merchant' then
    return coalesce((select jsonb_agg(to_jsonb(s) || jsonb_build_object(
      'accepting_now',fly_delivery.store_open_at(s,now()),'suspension',fly_delivery.store_suspension(s),
      'products',coalesce((select jsonb_agg(to_jsonb(p) order by p.name)
        from fly_delivery.products p where p.store_id=s.id),'[]'::jsonb)) order by s.name)
      from fly_delivery.stores s where not s.sample and s.deleted_at is null and s.owner_id=(select auth.uid())),'[]'::jsonb);
  end if;
  raise exception 'FD: Acesso restrito às lojas.';
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
    select array_agg(distinct value order by value) into chosen_categories from jsonb_array_elements_text(payload->'categories');
    if chosen_categories is null or not (chosen_categories <@ array['Hambúrguer','Pizza','Japonesa','Brasileira','Açaí','Telecerveja','Marmitex','Outros']) then
      raise exception 'FD: Selecione pelo menos uma categoria válida.';
    end if;
    update fly_delivery.stores set name=store_name,categories=chosen_categories,category=chosen_categories[1] where id=shop.id;
    update fly_delivery.products set category=null where store_id=shop.id and category is not null and not (category=any(chosen_categories));
    return jsonb_build_object('id',shop.id);
  elsif action_name='admin_delete_store' then
    if exists(select 1 from fly_delivery.orders where store_id=shop.id and status not in ('delivered','cancelled')) then
      raise exception 'FD: Finalize ou cancele os pedidos em andamento antes de excluir o estabelecimento.';
    end if;
    perform fly_delivery.close_daily_invoices(shop.id);
    if exists(select 1 from fly_delivery.daily_invoices where store_id=shop.id and status='pending') or exists(select 1 from fly_delivery.orders where store_id=shop.id and platform_fee_cents>0 and (completed_at at time zone 'America/Sao_Paulo')::date=(now() at time zone 'America/Sao_Paulo')::date) then raise exception 'FD: Regularize as faturas da plataforma antes de excluir o estabelecimento.'; end if;
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
