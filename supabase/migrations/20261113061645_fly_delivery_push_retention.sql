create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create index fd_push_messages_retention
  on fly_delivery.push_messages ((coalesce(cancelled_at,scheduled_at)))
  where queued_at is not null or cancelled_at is not null;

create function fly_delivery.purge_push_history()
returns bigint language sql set search_path=''
as $$
  with expired as (
    delete from fly_delivery.push_messages
    where (queued_at is not null or cancelled_at is not null)
      and coalesce(cancelled_at,scheduled_at)<statement_timestamp()-interval '24 hours'
    returning 1
  )
  select count(*) from expired;
$$;

revoke all on function fly_delivery.purge_push_history() from public,anon,authenticated,service_role;

-- Pending sends include the next occurrence of recurring campaigns. Deliveries follow the message via ON DELETE CASCADE.
select cron.schedule(
  'fly-delivery-push-history-24h',
  '0 6 * * *',
  'select fly_delivery.purge_push_history()'
);
