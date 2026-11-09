alter table fly_delivery.platform_coupons
  add column archived_uses bigint not null default 0;

create or replace function fly_delivery.platform_coupon_uses(coupon_id uuid)
returns bigint language sql stable set search_path=''
as $$
  select coalesce((select archived_uses from fly_delivery.platform_coupons where id=coupon_id),0)
       + (select count(*) from fly_delivery.orders where platform_coupon_id=coupon_id and status<>'cancelled');
$$;

create function fly_delivery.admin_history_cleanup(input jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  period_name text := input->>'period';
  phase text := input->>'phase';
  start_date date;
  end_date date;
  paid_before date;
  shop_id uuid;
  paid_invoice_ids uuid[];
  invoice_ids uuid[];
  order_ids uuid[];
  order_fingerprint bigint;
  item_count bigint;
  removed_count bigint;
  preview_token text;
  result jsonb;
begin
  if auth.uid() is null or fly_delivery.actor_role() is distinct from 'admin' then
    raise exception 'FD: Acesso exclusivo da administração.';
  end if;
  if coalesce(phase,'') not in ('preview','execute') then
    raise exception 'FD: Consulte a prévia antes de excluir.';
  end if;

  case period_name
    when '3m' then paid_before := (today-interval '3 months')::date;
    when '6m' then paid_before := (today-interval '6 months')::date;
    when '1y' then paid_before := (today-interval '1 year')::date;
    when 'day', 'range' then
      if coalesce(input->>'from','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or (period_name='range' and coalesce(input->>'to','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then
        raise exception 'FD: Informe as datas da limpeza.';
      end if;
      start_date := (input->>'from')::date;
      end_date := case when period_name='day' then start_date else (input->>'to')::date end;
      if start_date>end_date or end_date>=today then
        raise exception 'FD: Escolha um período encerrado, com data final até ontem.';
      end if;
    else raise exception 'FD: Selecione um período.';
  end case;

  if phase='execute' and (
    input->>'confirmation' is distinct from 'EXCLUIR'
    or coalesce(input->>'token','') !~ '^[0-9a-f]{32}$'
  ) then
    raise exception 'FD: Consulte a prévia e confirme a exclusão.';
  end if;
  if phase='execute' and not pg_try_advisory_xact_lock(hashtextextended('fd-history-cleanup',0)) then
    raise exception 'FD: Já existe uma limpeza em execução.';
  end if;

  select coalesce(array_agg(i.id order by i.id),'{}') into paid_invoice_ids
  from fly_delivery.daily_invoices i
  where i.status='paid' and i.paid_at is not null and i.invoice_date<today
    and case when paid_before is not null
      then i.paid_at < (paid_before::timestamp at time zone 'America/Sao_Paulo')
      else i.invoice_date between start_date and end_date end;

  if phase='execute' then
    -- Serialize with daily closing so a removed paid invoice cannot be recreated.
    for shop_id in
      select distinct i.store_id from fly_delivery.daily_invoices i
      where i.id=any(paid_invoice_ids) order by i.store_id
    loop
      if not pg_try_advisory_xact_lock(hashtextextended('fd-billing:'||shop_id::text,0)) then
        raise exception 'FD: O faturamento está sendo atualizado. Tente de novo em instantes.';
      end if;
    end loop;
  end if;

  -- Match the exact set of sales used by close_daily_invoices for each store and day.
  with billed_orders as materialized (
    select i.id as invoice_id, i.order_count, i.sales_cents, i.amount_cents,
      o.id as order_id, o.subtotal, o.platform_fee_cents
    from fly_delivery.daily_invoices i join fly_delivery.orders o on o.store_id=i.store_id
      and o.completed_at >= (i.invoice_date::timestamp at time zone 'America/Sao_Paulo')
      and o.completed_at < ((i.invoice_date+1)::timestamp at time zone 'America/Sao_Paulo')
    where i.id=any(paid_invoice_ids) and i.status='paid'
      and o.status='delivered' and o.commission_bps is not null
  ), matched as (
    select b.invoice_id from billed_orders b
    group by b.invoice_id,b.order_count,b.sales_cents,b.amount_cents
    having count(*)=b.order_count and sum(b.subtotal)=b.sales_cents
      and sum(b.platform_fee_cents)=b.amount_cents
  )
  select coalesce(array_agg(distinct b.invoice_id order by b.invoice_id),'{}'),
    coalesce(array_agg(b.order_id),'{}'), bit_xor(hashtextextended(b.order_id::text,0))
  into invoice_ids,order_ids,order_fingerprint
  from billed_orders b join matched m using(invoice_id);

  select count(*) into item_count from fly_delivery.order_items where order_id=any(order_ids);
  preview_token := md5(format('%s|%s|%s|%s|%s|%s|%s|%s|%s',
    auth.uid(),period_name,start_date,end_date,paid_before,invoice_ids,
    cardinality(order_ids),order_fingerprint,item_count));
  result := jsonb_build_object('orders',cardinality(order_ids),'items',item_count,
    'invoices',cardinality(invoice_ids),'unmatched_invoices',cardinality(paid_invoice_ids)-cardinality(invoice_ids),
    'paid_before',paid_before,'from',start_date,'to',end_date,'token',preview_token);
  if phase='preview' then return result; end if;
  if input->>'token' is distinct from preview_token or cardinality(invoice_ids)=0 then
    raise exception 'FD: Os registros mudaram. Consulte uma nova prévia.';
  end if;

  delete from fly_delivery.order_items where order_id=any(order_ids);
  get diagnostics removed_count = row_count;
  if removed_count<>item_count then raise exception 'FD: Os itens mudaram. Consulte uma nova prévia.'; end if;

  with removed as (
    delete from fly_delivery.orders where id=any(order_ids) and status='delivered'
    returning platform_coupon_id
  ), coupon_totals as (
    select platform_coupon_id,count(*) as uses from removed
    where platform_coupon_id is not null group by platform_coupon_id
  ), preserved_uses as (
    update fly_delivery.platform_coupons c set archived_uses=c.archived_uses+t.uses
    from coupon_totals t where c.id=t.platform_coupon_id
  )
  select count(*) into removed_count from removed;
  if removed_count<>cardinality(order_ids) then raise exception 'FD: Os pedidos mudaram. Consulte uma nova prévia.'; end if;

  delete from fly_delivery.daily_invoices where id=any(invoice_ids) and status='paid';
  get diagnostics removed_count = row_count;
  if removed_count<>cardinality(invoice_ids) then raise exception 'FD: As faturas mudaram. Consulte uma nova prévia.'; end if;
  return result-'token';
exception
  when invalid_datetime_format or datetime_field_overflow then
    raise exception 'FD: Confira as datas informadas.';
end;
$$;

revoke all on function fly_delivery.admin_history_cleanup(jsonb) from public, anon, authenticated;
grant execute on function fly_delivery.admin_history_cleanup(jsonb) to authenticated;

create function public.fd_admin_history_cleanup(input jsonb)
returns jsonb language sql security invoker
set search_path=''
set statement_timeout='45s'
as $$
  select fly_delivery.admin_history_cleanup(input);
$$;

revoke all on function public.fd_admin_history_cleanup(jsonb) from public, anon, authenticated;
grant execute on function public.fd_admin_history_cleanup(jsonb) to authenticated;
