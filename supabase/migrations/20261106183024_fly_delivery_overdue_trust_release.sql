-- Trust releases apply only to already-overdue invoices, without marking them paid.
alter table fly_delivery.daily_invoices add column trust_released_at timestamptz;
alter table fly_delivery.daily_invoices add column trust_released_by uuid references fly_delivery.accounts(id);
alter table fly_delivery.daily_invoices add constraint fd_invoice_trust_actor check ((trust_released_at is null)=(trust_released_by is null));
create index fd_invoices_overdue on fly_delivery.daily_invoices(store_id,due_at) where status='pending';

create function fly_delivery.store_suspension_at(shop fly_delivery.stores,instant timestamptz)
returns jsonb language sql stable security definer set search_path=''
as $$
  with debts as (
    select i.amount_cents,i.trust_released_at from fly_delivery.daily_invoices i
      where i.store_id=shop.id and i.status='pending' and i.due_at<=instant
    union all
    -- If the server was offline at midnight, checkout is still blocked at noon.
    select sum(o.platform_fee_cents)::bigint,null::timestamptz from fly_delivery.orders o
      where o.store_id=shop.id and o.status='delivered' and o.commission_bps is not null
        and ((((o.completed_at at time zone 'America/Sao_Paulo')::date+1)+time '12:00') at time zone 'America/Sao_Paulo')<=instant
        and not exists(select 1 from fly_delivery.daily_invoices i where i.store_id=shop.id and i.invoice_date=(o.completed_at at time zone 'America/Sao_Paulo')::date)
      group by (o.completed_at at time zone 'America/Sao_Paulo')::date having sum(o.platform_fee_cents)>0
  ), summary as (
    select count(*)::integer overdue_count,coalesce(sum(amount_cents),0) overdue_cents,
      count(*) filter(where trust_released_at is null)::integer blocked_count,
      count(*) filter(where trust_released_at is not null)::integer trusted_count from debts
  )
  select jsonb_build_object('suspended',shop.suspended_at is not null or blocked_count>0,
    'manual',shop.suspended_at is not null,'automatic',blocked_count>0,
    'trusted',shop.suspended_at is null and blocked_count=0 and trusted_count>0,
    'overdue_count',overdue_count,'overdue_cents',overdue_cents,'blocked_count',blocked_count,'trusted_count',trusted_count,
    'reason',case when shop.suspended_at is not null then coalesce(nullif(shop.suspension_reason,''),'Estabelecimento suspenso pela administração. Acesse Faturas Fly Delivery para verificar as pendências.')
      when blocked_count>0 then 'Estabelecimento suspenso automaticamente por fatura Fly Delivery vencida. Quite as faturas em atraso para voltar à vitrine ou solicite uma liberação de confiança à administração.'
      when trusted_count>0 then 'Estabelecimento liberado por confiança pela administração. A dívida continua em aberto; quite as faturas vencidas.' else null end)
  from summary;
$$;
revoke all on function fly_delivery.store_suspension_at(fly_delivery.stores,timestamptz) from public,anon,authenticated;

create or replace function fly_delivery.store_suspension(shop fly_delivery.stores)
returns jsonb language sql stable security definer set search_path=''
as $$ select fly_delivery.store_suspension_at(shop,now()); $$;
revoke all on function fly_delivery.store_suspension(fly_delivery.stores) from public,anon,authenticated;

CREATE OR REPLACE FUNCTION fly_delivery.billing_api(action_name text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    perform fly_delivery.close_daily_invoices(shop.id);
    if not (payload->>'suspend')::boolean and exists(select 1 from fly_delivery.daily_invoices where store_id=shop.id and status='pending' and due_at<=now()) then
      if payload->'trust' is distinct from 'true'::jsonb then raise exception 'FD: Confirme a liberação de confiança para manter a dívida em aberto.'; end if;
      update fly_delivery.daily_invoices set trust_released_at=clock_timestamp(),trust_released_by=actor
        where store_id=shop.id and status='pending' and due_at<=now();
    end if;
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
      select i.id,i.store_id,s.name store_name,i.invoice_date,i.due_at,i.sales_cents,i.amount_cents,i.order_count,i.status,i.paid_at,i.trust_released_at,
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
$function$;
