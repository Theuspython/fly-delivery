-- Keep privileged payment code in the private schema, behind the authenticated backend bridge.
create function fly_delivery.billing_backend(secret text,action text,input jsonb default '{}'::jsonb)
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
revoke all on function fly_delivery.billing_backend(text,text,jsonb) from public,authenticated;
grant execute on function fly_delivery.billing_backend(text,text,jsonb) to anon;
create or replace function public.fd_billing_backend(secret text,action text,input jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path=''
as $$ select fly_delivery.billing_backend(secret,action,input); $$;
revoke all on function public.fd_billing_backend(text,text,jsonb) from public,authenticated;
grant execute on function public.fd_billing_backend(text,text,jsonb) to anon;
