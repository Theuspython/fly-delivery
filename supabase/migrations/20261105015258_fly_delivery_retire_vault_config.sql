-- Remove only the superseded configuration for Fly Delivery.
drop function public.fd_admin_bootstrap(text,text,uuid);
drop function fly_delivery.bootstrap_admin(text,text,uuid);
drop function public.fd_google_browser_key();
drop function fly_delivery.google_browser_key();

-- Preserve any values the operator may have entered during the transition.
delete from vault.secrets
where id in (
  select id from vault.decrypted_secrets
  where name in ('GOOGLE_MAPS_BROWSER_KEY','FLY_DELIVERY_ADMIN_LOGIN','FLY_DELIVERY_ADMIN_PASSWORD')
    and decrypted_secret='PREENCHER'
);
