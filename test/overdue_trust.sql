-- Exact day boundaries, noon enforcement and per-invoice trust, all rolled back.
begin;
do $$
declare
 admin uuid:=gen_random_uuid(); merchant uuid:=gen_random_uuid(); buyer uuid:=gen_random_uuid(); actor uuid;
 shop uuid:=gen_random_uuid(); first_order uuid:=gen_random_uuid(); last_order uuid:=gen_random_uuid(); next_order uuid:=gen_random_uuid(); current_order uuid:=gen_random_uuid();
 first_invoice uuid; next_invoice uuid; fresh_invoice uuid; invoice_id uuid; lock_id uuid;
 day_value date:=(now() at time zone 'America/Sao_Paulo')::date-4; deadline timestamptz;
 store_row fly_delivery.stores; result jsonb; secret text:=repeat('fixture-overdue-secret-',4);
 schedule jsonb:=(select jsonb_agg(jsonb_build_object('open','00:00','close','00:00')) from generate_series(1,7));
begin
 foreach actor in array array[admin,merchant,buyer] loop insert into auth.users(id,email,email_confirmed_at) values(actor,actor::text||'@example.invalid',now());end loop;
 insert into fly_delivery.accounts(id,role) values(admin,'admin'),(merchant,'merchant'),(buyer,'customer');
 insert into fly_delivery.customer_profiles(user_id,full_name,phone) values(buyer,'Cliente Vencimento','31992345678');
 insert into fly_delivery.stores(id,owner_id,name,category,categories,address,active,is_open,fee,weekly_hours) values(shop,merchant,'Loja Vencimento','Pizza',array['Pizza'],'Rua Loja 123',true,true,500,schedule);
 update fly_delivery.billing_config set commission_bps=1000,payments_ready=true,bridge_hash=encode(extensions.digest(secret,'sha256'),'hex') where id=true;
 insert into fly_delivery.orders(id,customer_id,store_id,request_id,address,payment,subtotal,fee,status) values
 (first_order,buyer,shop,gen_random_uuid(),'Rua Cliente 10','cash_delivery',10000,500,'delivered'),
 (last_order,buyer,shop,gen_random_uuid(),'Rua Cliente 10','cash_delivery',20000,500,'delivered'),
 (next_order,buyer,shop,gen_random_uuid(),'Rua Cliente 10','cash_delivery',30000,500,'delivered'),
 (current_order,buyer,shop,gen_random_uuid(),'Rua Cliente 10','cash_delivery',40000,500,'delivered');
 update fly_delivery.orders set completed_at=(day_value+time '00:00') at time zone 'America/Sao_Paulo' where id=first_order;
 update fly_delivery.orders set completed_at=(day_value+time '23:59:59.999999') at time zone 'America/Sao_Paulo' where id=last_order;
 update fly_delivery.orders set completed_at=((day_value+1)+time '00:00') at time zone 'America/Sao_Paulo' where id=next_order;
 select * into store_row from fly_delivery.stores where id=shop;
 deadline:=((day_value+1)+time '12:00') at time zone 'America/Sao_Paulo';
 if (fly_delivery.store_suspension_at(store_row,deadline-interval '1 microsecond')->>'suspended')::boolean then raise exception 'Blocked before noon';end if;
 if not (fly_delivery.store_suspension_at(store_row,deadline)->>'suspended')::boolean then raise exception 'Server downtime bypasses noon block';end if;
 perform fly_delivery.close_daily_invoices(shop);perform fly_delivery.close_daily_invoices(shop);
 select id into first_invoice from fly_delivery.daily_invoices where store_id=shop and invoice_date=day_value;
 select id into next_invoice from fly_delivery.daily_invoices where store_id=shop and invoice_date=day_value+1;
 if (select count(*) from fly_delivery.daily_invoices where store_id=shop)<>2 then raise exception 'Current day closed or duplicate invoices';end if;
 if not exists(select 1 from fly_delivery.daily_invoices where id=first_invoice and order_count=2 and sales_cents=30000 and amount_cents=3000 and due_at=deadline) then raise exception '00:00 to midnight window wrong';end if;
 if not exists(select 1 from fly_delivery.daily_invoices where id=next_invoice and order_count=1 and sales_cents=30000 and amount_cents=3000) then raise exception 'Next midnight included in previous day';end if;
 if (fly_delivery.store_suspension_at(store_row,deadline-interval '1 microsecond')->>'suspended')::boolean or not (fly_delivery.store_suspension_at(store_row,deadline)->>'suspended')::boolean then raise exception 'Exact noon deadline wrong';end if;
 perform set_config('request.jwt.claim.sub',merchant::text,true);
 if public.fd_api('session')->>'role'<>'merchant' then raise exception 'Suspended merchant cannot log in';end if;
 if jsonb_array_length(public.fd_api('merchant_invoices')->'invoices')<>2 then raise exception 'Suspended merchant cannot pay invoices';end if;
 if exists(select 1 from jsonb_array_elements(public.fd_api('catalog')) s where s->>'id'=shop::text) then raise exception 'Automatically suspended shop visible';end if;
 begin perform public.fd_api('admin_set_suspension',jsonb_build_object('id',shop,'suspend',false,'trust',true));raise exception 'Merchant granted own trust';exception when raise_exception then if sqlerrm not like 'FD: Acesso restrito%' then raise;end if;end;
 perform set_config('request.jwt.claim.sub',buyer::text,true);
 begin perform public.fd_api('place',jsonb_build_object('store_id',shop,'request_id',gen_random_uuid()));raise exception 'Customer bypassed suspension';exception when raise_exception then if sqlerrm not like 'FD: A loja não está aceitando%' then raise;end if;end;
 perform set_config('request.jwt.claim.sub',admin::text,true);
 begin perform public.fd_api('admin_set_suspension',jsonb_build_object('id',shop,'suspend',false));raise exception 'Trust released without confirmation';exception when raise_exception then if sqlerrm not like 'FD: Confirme a liberação%' then raise;end if;end;
 perform public.fd_api('admin_set_suspension',jsonb_build_object('id',shop,'suspend',false,'trust',true));
 if (select count(*) from fly_delivery.daily_invoices where store_id=shop and status='pending' and trust_released_by=admin and trust_released_at is not null)<>2 then raise exception 'Trust erased debt or missing audit';end if;
 select * into store_row from fly_delivery.stores where id=shop;
 result:=fly_delivery.store_suspension(store_row);
 if (result->>'suspended')::boolean or not (result->>'trusted')::boolean then raise exception 'Trust did not unblock';end if;
 if not exists(select 1 from jsonb_array_elements(public.fd_api('catalog')) s where s->>'id'=shop::text) then raise exception 'Trusted shop absent from storefront';end if;
 -- A later invoice is not covered by the earlier trust release.
 update fly_delivery.orders set completed_at=((day_value+2)+time '00:00') at time zone 'America/Sao_Paulo' where id=current_order;
 perform fly_delivery.close_daily_invoices(shop);
 select id into fresh_invoice from fly_delivery.daily_invoices where store_id=shop and invoice_date=day_value+2;
 if not (fly_delivery.store_suspension(store_row)->>'suspended')::boolean then raise exception 'Old trust released future invoice';end if;
 update fly_delivery.billing_config set payments_ready=false where id=true;
 if not (fly_delivery.store_suspension(store_row)->>'suspended')::boolean then raise exception 'Missing payment config forgave existing overdue debt';end if;
 update fly_delivery.billing_config set payments_ready=true where id=true;
 result:=public.fd_billing_backend(secret,'acquire',jsonb_build_object('id',fresh_invoice,'actor',merchant));lock_id:=(result->>'checkout_lock_id')::uuid;
 perform public.fd_billing_backend(secret,'save_link',jsonb_build_object('id',fresh_invoice,'lock_id',lock_id,'url','https://checkout.infinitepay.io/test'));
 perform public.fd_billing_backend(secret,'paid',jsonb_build_object('id',fresh_invoice,'amount',4000,'transaction','new-payment','slug','new-slug'));
 if (fly_delivery.store_suspension(store_row)->>'suspended')::boolean then raise exception 'Payment did not automatically unblock debt suspension';end if;
 foreach invoice_id in array array[first_invoice,next_invoice] loop
   result:=public.fd_billing_backend(secret,'acquire',jsonb_build_object('id',invoice_id,'actor',merchant));lock_id:=(result->>'checkout_lock_id')::uuid;
   perform public.fd_billing_backend(secret,'save_link',jsonb_build_object('id',invoice_id,'lock_id',lock_id,'url','https://checkout.infinitepay.io/test'));
   perform public.fd_billing_backend(secret,'paid',jsonb_build_object('id',invoice_id,'amount',3000,'transaction',invoice_id::text,'slug','paid'));
 end loop;
 result:=fly_delivery.store_suspension(store_row);
 if (result->>'suspended')::boolean or (result->>'trusted')::boolean or result->>'overdue_count'<>'0' then raise exception 'Paid debt still visible as pending';end if;
end;
$$;
select 'Dia completo, meia-noite, vencimento exato às 12h, bloqueio, pagamento e confiança por fatura verificados' as integration;
rollback;
