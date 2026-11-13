create table fly_delivery.push_config (
  id boolean primary key default true check (id),
  bridge_hash text not null check (bridge_hash ~ '^[a-f0-9]{64}$')
);

create table fly_delivery.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references fly_delivery.accounts(id) on delete cascade,
  role text not null check (role in ('customer','merchant')),
  endpoint text not null,
  p256dh text not null,
  auth_secret text not null,
  unique (endpoint,role)
);
create index fd_push_subscriptions_account on fly_delivery.push_subscriptions(account_id);

create table fly_delivery.push_messages (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 70),
  body text not null check (char_length(body) between 1 and 240),
  audience text not null check (audience in ('customer','merchant','all')),
  account_id uuid references fly_delivery.accounts(id) on delete cascade,
  path text,
  created_by uuid references fly_delivery.accounts(id) on delete set null,
  scheduled_at timestamptz not null default clock_timestamp(),
  daily boolean not null default false,
  queued_at timestamptz,
  cancelled_at timestamptz,
  expired_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (series_id,scheduled_at)
);
create index fd_push_messages_due on fly_delivery.push_messages(scheduled_at,id)
  where queued_at is null and cancelled_at is null;
create index fd_push_messages_history on fly_delivery.push_messages(scheduled_at desc,id)
  where account_id is null;
create index fd_push_messages_account on fly_delivery.push_messages(account_id);

create table fly_delivery.push_deliveries (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references fly_delivery.push_messages(id) on delete cascade,
  subscription_id uuid references fly_delivery.push_subscriptions(id) on delete set null,
  account_id uuid not null,
  state text not null default 'pending' check (state in ('pending','sent','failed','skipped')),
  next_attempt_at timestamptz not null default clock_timestamp(),
  lease uuid,
  attempts integer not null default 0,
  unique (message_id,subscription_id)
);
create index fd_push_deliveries_subscription on fly_delivery.push_deliveries(subscription_id);
create index fd_push_deliveries_pending on fly_delivery.push_deliveries(next_attempt_at,id) where state='pending';

alter table fly_delivery.push_config enable row level security;
alter table fly_delivery.push_subscriptions enable row level security;
alter table fly_delivery.push_messages enable row level security;
alter table fly_delivery.push_deliveries enable row level security;
revoke all on fly_delivery.push_config,fly_delivery.push_subscriptions,fly_delivery.push_messages,fly_delivery.push_deliveries
  from public,anon,authenticated;

create function fly_delivery.push_account(action_name text,payload jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare
  actor uuid:=auth.uid();
  actor_kind text:=fly_delivery.actor_role();
  message fly_delivery.push_messages;
  endpoint_value text:=payload->>'endpoint';
  title_value text:=btrim(payload->>'title');
  body_value text:=btrim(payload->>'body');
  audience_value text:=payload->>'audience';
  send_at timestamptz:=clock_timestamp();
  now_at timestamptz:=send_at;
  daily_value boolean;
  local_date timestamp;
  history jsonb;
begin
  if actor is null or actor_kind is null or auth.jwt()->'app_metadata'->>'fly_delivery_setup'='true' then
    raise exception 'FD: Entre com uma conta ativa.';
  end if;
  if action_name in ('subscribe','unsubscribe','subscription_status') then
    if actor_kind not in ('merchant','customer') or payload->>'role' is distinct from actor_kind then
      raise exception 'FD: Use a conta do cliente ou do estabelecimento.';
    end if;
    if coalesce(char_length(endpoint_value),0) not between 20 and 2048 then
      raise exception 'FD: Inscrição de notificações inválida.';
    end if;
    if action_name='unsubscribe' then
      delete from fly_delivery.push_subscriptions where endpoint=endpoint_value and account_id=actor and role=actor_kind;
    elsif action_name='subscription_status' then
      return jsonb_build_object('active',exists(select 1 from fly_delivery.push_subscriptions
        where endpoint=endpoint_value and account_id=actor and role=actor_kind));
    else
      if endpoint_value !~ '^https://(fcm[.]googleapis[.]com|([a-z0-9-]+[.])+push[.]apple[.]com|updates[.]push[.]services[.]mozilla[.]com)/[^#[:space:]]+$'
        or coalesce(payload->>'p256dh','') !~ '^[A-Za-z0-9_-]{87}$' or coalesce(payload->>'auth','') !~ '^[A-Za-z0-9_-]{22}$' then
        raise exception 'FD: Inscrição de notificações inválida.';
      end if;
      -- Assign a new ID when the device changes account or keys, so old queued deliveries cannot follow it.
      delete from fly_delivery.push_subscriptions where endpoint=endpoint_value and role=actor_kind
        and (account_id,p256dh,auth_secret) is distinct from (actor,payload->>'p256dh',payload->>'auth');
      insert into fly_delivery.push_subscriptions(account_id,role,endpoint,p256dh,auth_secret)
        values(actor,actor_kind,endpoint_value,payload->>'p256dh',payload->>'auth') on conflict (endpoint,role) do nothing;
      if not exists(select 1 from fly_delivery.push_subscriptions where endpoint=endpoint_value and account_id=actor and role=actor_kind) then
        raise exception 'FD: Não foi possível ativar as notificações. Tente novamente.';
      end if;
    end if;
    return '{}'::jsonb;
  end if;

  if actor_kind<>'admin' then raise exception 'FD: Área exclusiva da administração.';end if;
  if action_name='schedule' then
    if coalesce(char_length(title_value),0) not between 1 and 70 or coalesce(char_length(body_value),0) not between 1 and 240
      or coalesce(audience_value,'') not in ('customer','merchant','all')
      or coalesce(payload->>'mode','') not in ('now','scheduled')
      or jsonb_typeof(payload->'daily') is distinct from 'boolean' then
      raise exception 'FD: Confira o título, a mensagem e os destinatários.';
    end if;
    daily_value:=(payload->>'daily')::boolean;
    if payload->>'mode'='scheduled' then
      if coalesce(payload->>'local_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$' then
        raise exception 'FD: Informe a data e a hora de Brasília.';
      end if;
      local_date:=(payload->>'local_date')::timestamp;
      send_at:=local_date at time zone 'America/Sao_Paulo';
      if send_at<=now_at or send_at>now_at+interval '1 year' then
        raise exception 'FD: Escolha uma data futura dentro dos próximos 12 meses.';
      end if;
    elsif daily_value then
      raise exception 'FD: Escolha uma data e hora para repetir todos os dias.';
    end if;
    insert into fly_delivery.push_messages(id,series_id,title,body,audience,scheduled_at,daily,created_by)
      values((payload->>'request_id')::uuid,(payload->>'request_id')::uuid,title_value,body_value,audience_value,send_at,daily_value,actor)
      on conflict do nothing;
    return '{}'::jsonb;
  elsif action_name='cancel' then
    select * into message from fly_delivery.push_messages where id=(payload->>'id')::uuid and account_id is null;
    if not found then raise exception 'FD: Notificação indisponível.';end if;
    perform pg_advisory_xact_lock(hashtextextended('fd-push-series:'||message.series_id::text,0));
    update fly_delivery.push_messages set cancelled_at=now_at
      where series_id=message.series_id and queued_at is null and cancelled_at is null;
    if not found then raise exception 'FD: Este envio já foi processado.';end if;
    return '{}'::jsonb;
  elsif action_name='history' then
    with recent as (
      select id,series_id,title,body,audience,scheduled_at,daily,queued_at,cancelled_at,expired_at
      from fly_delivery.push_messages where account_id is null
      order by (queued_at is null and cancelled_at is null) desc,scheduled_at desc,id limit 40
    )
    select coalesce(jsonb_agg(to_jsonb(recent)||jsonb_build_object('pending',d.pending,'sent',d.sent,'failed',d.failed,'skipped',d.skipped)
      order by (recent.queued_at is null and recent.cancelled_at is null) desc,recent.scheduled_at desc,recent.id),'[]'::jsonb) into history
    from recent cross join lateral (
      select count(*) filter(where state='pending') pending,count(*) filter(where state='sent') sent,
        count(*) filter(where state='failed') failed,count(*) filter(where state='skipped') skipped
      from fly_delivery.push_deliveries where message_id=recent.id
    ) d;
    return history;
  end if;
  raise exception 'FD: Operação inválida.';
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or not_null_violation then
  raise exception 'FD: Confira os dados da notificação.';
end;
$$;

create function fly_delivery.push_worker(secret text,action_name text,payload jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare
  now_at timestamptz:=clock_timestamp();
  local_now timestamp:=now_at at time zone 'America/Sao_Paulo';
  next_at timestamp;
  message fly_delivery.push_messages;
  delivery fly_delivery.push_deliveries;
  entry jsonb;
  batch jsonb;
begin
  if char_length(coalesce(secret,''))<48 or encode(extensions.digest(secret,'sha256'),'hex')
    is distinct from (select bridge_hash from fly_delivery.push_config where id) then
    raise exception 'FD: Acesso restrito ao servidor.';
  end if;
  if action_name='finish' then
    if jsonb_typeof(payload) is distinct from 'array' or jsonb_array_length(payload)>25 then raise exception 'FD: Lote inválido.';end if;
    for entry in select * from jsonb_array_elements(payload) loop
      select * into delivery from fly_delivery.push_deliveries
        where id=(entry->>'id')::uuid and lease=(entry->>'lease')::uuid and state='pending' for update;
      if not found then continue;end if;
      update fly_delivery.push_deliveries set lease=null,
        state=case entry->>'result' when 'sent' then 'sent' when 'expired' then 'skipped'
          when 'retry' then case when delivery.attempts<5 then 'pending' else 'failed' end else 'failed' end,
        next_attempt_at=now_at+make_interval(secs=>30*power(2,least(delivery.attempts,5)))
        where id=delivery.id;
      if entry->>'result'='expired' then
        delete from fly_delivery.push_subscriptions where id=delivery.subscription_id;
      end if;
    end loop;
    return '{}'::jsonb;
  end if;
  if action_name<>'claim' then raise exception 'FD: Operação inválida.';end if;

  for message in
    select * from fly_delivery.push_messages where queued_at is null and cancelled_at is null and scheduled_at<=now_at
    order by scheduled_at,id limit 12 for update skip locked
  loop
    if message.daily and not pg_try_advisory_xact_lock(hashtextextended('fd-push-series:'||message.series_id::text,0)) then
      continue;
    end if;
    if message.daily then
      next_at:=local_now::date+(message.scheduled_at at time zone 'America/Sao_Paulo')::time;
      if next_at<=local_now then next_at:=next_at+interval '1 day';end if;
      insert into fly_delivery.push_messages(series_id,title,body,audience,scheduled_at,daily,created_by)
        values(message.series_id,message.title,message.body,message.audience,next_at at time zone 'America/Sao_Paulo',true,message.created_by)
        on conflict do nothing;
    end if;
    if message.scheduled_at<now_at-(case when message.account_id is null then interval '24 hours' else interval '15 minutes' end) then
      update fly_delivery.push_messages set queued_at=now_at,expired_at=now_at where id=message.id;
      continue;
    end if;
    insert into fly_delivery.push_deliveries(message_id,subscription_id,account_id,next_attempt_at)
      select distinct on (s.endpoint) message.id,s.id,s.account_id,now_at
      from fly_delivery.push_subscriptions s join fly_delivery.accounts a on a.id=s.account_id and a.enabled and a.role=s.role
      where (message.account_id is null or s.account_id=message.account_id)
        and (message.audience='all' or s.role=message.audience)
      order by s.endpoint,s.role,s.id
      on conflict do nothing;
    update fly_delivery.push_messages set queued_at=now_at where id=message.id;
  end loop;

  with candidates as (
    select d.id,s.endpoint,s.p256dh,s.auth_secret,s.role,m.title,m.body,m.path,m.id as tag,
      greatest(0,extract(epoch from m.scheduled_at+
        (case when m.account_id is null then interval '24 hours' else interval '15 minutes' end)-now_at)::integer) as ttl,
      coalesce(a.enabled and a.role=s.role,false) as enabled
    from fly_delivery.push_deliveries d join fly_delivery.push_messages m on m.id=d.message_id
    left join fly_delivery.push_subscriptions s on s.id=d.subscription_id and s.account_id=d.account_id
    left join fly_delivery.accounts a on a.id=s.account_id
    where d.state='pending' and d.next_attempt_at<=now_at order by d.next_attempt_at,d.id
    limit 25 for update of d skip locked
  ), claimed as (
    update fly_delivery.push_deliveries d set
      state=case when not c.enabled or c.ttl<=0 then 'skipped' when d.attempts>=5 then 'failed' else 'pending' end,
      attempts=d.attempts+1,lease=gen_random_uuid(),next_attempt_at=now_at+interval '2 minutes'
    from candidates c where d.id=c.id returning c.*,d.lease,d.state
  )
  select coalesce(jsonb_agg(to_jsonb(claimed)-'state'-'enabled'),'[]'::jsonb) into batch from claimed where state='pending';
  return batch;
end;
$$;

create function fly_delivery.queue_order_push()
returns trigger language plpgsql security definer set search_path=''
as $$
declare
  recipient uuid;
  audience_value text;
  title_value text;
  path_value text;
begin
  if tg_op='INSERT' and new.status='placed' then
    select owner_id into recipient from fly_delivery.stores where id=new.store_id and not sample and deleted_at is null;
    audience_value:='merchant';
    title_value:='Novo pedido';
    path_value:='/loja/#pedidos';
  elsif tg_op='UPDATE' and old.status is distinct from new.status then
    recipient:=new.customer_id;
    audience_value:='customer';
    title_value:=case new.status when 'preparing' then 'Pedido em produção' when 'picked_up' then 'Pedido saiu para entrega'
      when 'delivered' then 'Pedido entregue' when 'cancelled' then 'Pedido cancelado' end;
    path_value:=case when new.status in ('delivered','cancelled') then '/cliente/#historico/'||new.id::text else '/cliente/#pedidos' end;
  end if;
  if title_value is not null and recipient is not null and exists(
    select 1 from fly_delivery.push_subscriptions where account_id=recipient and role=audience_value
  ) then
    insert into fly_delivery.push_messages(title,body,audience,account_id,path)
      values(title_value,'Confira o pedido #'||left(new.id::text,8)||' no Fly Delivery.',audience_value,recipient,path_value);
  end if;
  return new;
end;
$$;
create trigger fd_order_push after insert or update of status on fly_delivery.orders
  for each row execute function fly_delivery.queue_order_push();

create function public.fd_push_account(action_name text,payload jsonb)
returns jsonb language sql security invoker set search_path=''
as $$ select fly_delivery.push_account(action_name,payload); $$;
create function public.fd_push_worker(secret text,action_name text,payload jsonb)
returns jsonb language sql security invoker set search_path=''
as $$ select fly_delivery.push_worker(secret,action_name,payload); $$;
revoke all on function fly_delivery.queue_order_push(),fly_delivery.push_account(text,jsonb),public.fd_push_account(text,jsonb),
  fly_delivery.push_worker(text,text,jsonb),public.fd_push_worker(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function fly_delivery.push_account(text,jsonb),public.fd_push_account(text,jsonb) to authenticated;
grant execute on function fly_delivery.push_worker(text,text,jsonb),public.fd_push_worker(text,text,jsonb) to anon;
