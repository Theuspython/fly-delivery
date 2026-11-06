-- Invoice due dates are informative; only the administrator suspends/reactivates a store.
create or replace function fly_delivery.store_suspension(shop fly_delivery.stores)
returns jsonb language sql stable security definer set search_path=''
as $$
  select jsonb_build_object('suspended',shop.suspended_at is not null,'manual',shop.suspended_at is not null,
    'reason',case when shop.suspended_at is not null then coalesce(nullif(shop.suspension_reason,''),
      'Estabelecimento suspenso pela administração. Acesse Faturas Fly Delivery para verificar as pendências.') else null end);
$$;
revoke all on function fly_delivery.store_suspension(fly_delivery.stores) from public,anon,authenticated;
