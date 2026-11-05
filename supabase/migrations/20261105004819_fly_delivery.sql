create schema fly_delivery;
revoke all on schema fly_delivery from public, anon, authenticated;
grant usage on schema fly_delivery to anon, authenticated;

create table fly_delivery.accounts (
  id uuid primary key references auth.users on delete cascade,
  role text not null default 'customer' check (role in ('customer','merchant','courier','admin')),
  enabled boolean not null default true,
  online boolean not null default false,
  last_seen timestamptz,
  lat double precision check (lat between -90 and 90),
  lng double precision check (lng between -180 and 180)
);
create table fly_delivery.stores (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references fly_delivery.accounts,
  name text not null check (char_length(name) between 2 and 80),
  description text not null default '' check (char_length(description) <= 260),
  category text not null check (category in ('Hambúrguer','Pizza','Japonesa','Brasileira','Açaí','Outros')),
  active boolean not null default false,
  is_open boolean not null default false,
  sample boolean not null default false check (not sample or owner_id is null),
  address text not null check (char_length(address) between 5 and 240),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  fee integer not null default 0 check (fee between 0 and 100000),
  delivery_radius integer not null default 8 check (delivery_radius between 1 and 50),
  eta integer not null default 30 check (eta between 5 and 180)
);
create index fd_stores_owner on fly_delivery.stores(owner_id);
create table fly_delivery.products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references fly_delivery.stores,
  name text not null check (char_length(name) between 2 and 100),
  description text not null default '' check (char_length(description) <= 500),
  price integer not null check (price between 1 and 1000000),
  image text check (char_length(image) <= 500),
  active boolean not null default true
);
create index fd_products_store on fly_delivery.products(store_id);
create table fly_delivery.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references fly_delivery.accounts,
  store_id uuid not null references fly_delivery.stores,
  courier_id uuid references fly_delivery.accounts,
  request_id uuid not null,
  status text not null default 'placed' check (status in ('placed','preparing','ready','assigned','picked_up','delivered','cancelled')),
  address text not null check (char_length(address) between 5 and 240),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  payment text not null check (payment in ('pix_delivery','card_delivery','cash_delivery')),
  subtotal integer not null check (subtotal > 0),
  fee integer not null check (fee >= 0),
  distance_km numeric(6,2) not null check (distance_km >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id, request_id)
);
create index fd_orders_customer on fly_delivery.orders(customer_id, created_at desc);
create index fd_orders_store on fly_delivery.orders(store_id, created_at desc);
create index fd_orders_available on fly_delivery.orders(created_at) where status = 'ready';
create unique index fd_one_active_delivery on fly_delivery.orders(courier_id) where status in ('assigned','picked_up');
create table fly_delivery.order_items (
  order_id uuid not null references fly_delivery.orders,
  product_id uuid not null references fly_delivery.products,
  name text not null,
  price integer not null check (price > 0),
  quantity integer not null check (quantity between 1 and 25),
  primary key (order_id, product_id)
);
create table fly_delivery.order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references fly_delivery.orders,
  actor_id uuid not null references fly_delivery.accounts,
  status text not null,
  created_at timestamptz not null default now()
);
create index fd_events_order on fly_delivery.order_events(order_id, id);

alter table fly_delivery.accounts enable row level security;
alter table fly_delivery.stores enable row level security;
alter table fly_delivery.products enable row level security;
alter table fly_delivery.orders enable row level security;
alter table fly_delivery.order_items enable row level security;
alter table fly_delivery.order_events enable row level security;

create function fly_delivery.km(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision language sql immutable strict set search_path = ''
as $$
  select 12742 * asin(sqrt(least(1, power(sin(radians(lat2-lat1)/2),2)
    + cos(radians(lat1))*cos(radians(lat2))*power(sin(radians(lng2-lng1)/2),2))));
$$;

create function fly_delivery.order_details(o fly_delivery.orders, reveal boolean default true)
returns jsonb language sql stable set search_path = ''
as $$
  select jsonb_build_object('id',o.id,'store_id',s.id,'store',s.name,'status',o.status,
    'created_at',o.created_at,'updated_at',o.updated_at,'fee',o.fee,'distance_km',o.distance_km,
    'pickup',s.address,'pickup_lat',s.lat,'pickup_lng',s.lng)
    || case when reveal then jsonb_build_object('address',o.address,'lat',o.lat,'lng',o.lng,
      'subtotal',o.subtotal,'payment',o.payment,'courier_assigned',o.courier_id is not null,
      'items',coalesce((select jsonb_agg(jsonb_build_object('name',i.name,'price',i.price,'quantity',i.quantity) order by i.name)
        from fly_delivery.order_items i where i.order_id=o.id),'[]'::jsonb),
      'events',coalesce((select jsonb_agg(jsonb_build_object('status',e.status,'created_at',e.created_at) order by e.id)
        from fly_delivery.order_events e where e.order_id=o.id),'[]'::jsonb)) else '{}'::jsonb end
  from fly_delivery.stores s where s.id=o.store_id;
$$;

create function fly_delivery.can_upload(object_name text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from fly_delivery.accounts a
    join fly_delivery.stores s on s.id::text=split_part(object_name,'/',1) and not s.sample
    where a.id=(select auth.uid()) and a.enabled and (a.role='admin' or (a.role='merchant' and s.owner_id=a.id))
  ) and object_name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$';
$$;

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('fly-delivery-menu','fly-delivery-menu',true,3145728,array['image/jpeg','image/png','image/webp']);
create policy fly_delivery_menu_upload on storage.objects for insert to authenticated
with check (bucket_id='fly-delivery-menu' and fly_delivery.can_upload(name));

create function fly_delivery.api(action text, input jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  a fly_delivery.accounts;
  s fly_delivery.stores;
  o fly_delivery.orders;
  p fly_delivery.products;
  store_id_input uuid;
  req uuid;
  items jsonb;
  total integer;
  total_count integer;
  supplied_count integer;
  target_status text;
  lat_input double precision;
  lng_input double precision;
  distance double precision;
  photo text;
  email_input text;
  target uuid;
  target_role text;
  target_enabled boolean;
  quote_changed boolean;
begin
  if action='catalog' then
    return coalesce((select jsonb_agg(jsonb_build_object(
      'id',st.id,'name',st.name,'description',st.description,'category',st.category,'is_open',st.is_open,
      'sample',st.sample,'fee',st.fee,'eta',st.eta,'lat',st.lat,'lng',st.lng,'delivery_radius',st.delivery_radius,
      'products',coalesce((select jsonb_agg(jsonb_build_object('id',pr.id,'name',pr.name,'description',pr.description,
        'price',pr.price,'image',pr.image) order by pr.name) from fly_delivery.products pr where pr.store_id=st.id and pr.active),'[]'::jsonb))
      order by st.sample, st.is_open desc, st.name)
      from fly_delivery.stores st where st.active and (not st.sample or not exists (
        select 1 from fly_delivery.stores real_store where real_store.active and not real_store.sample))), '[]'::jsonb);
  end if;
  if actor is null then raise exception 'FD: Entre para continuar.'; end if;

  if action='session' then
    insert into fly_delivery.accounts(id) values(actor) on conflict (id) do nothing;
  end if;
  select * into a from fly_delivery.accounts where id=actor;
  if a.id is null or not a.enabled then raise exception 'FD: Acesso indisponível.'; end if;

  case action
  when 'session' then
    return jsonb_build_object('id',a.id,'email',auth.jwt()->>'email','role',a.role,'online',a.online);
  when 'orders' then
    return coalesce((select jsonb_agg(fly_delivery.order_details(q,true) order by q.created_at desc)
      from (select ord.* from fly_delivery.orders ord join fly_delivery.stores st on st.id=ord.store_id
        where ord.customer_id=actor or ord.courier_id=actor or a.role='admin' or (a.role='merchant' and st.owner_id=actor)
        order by ord.created_at desc limit 80) q),'[]'::jsonb);
  when 'place' then
    req := (input->>'request_id')::uuid;
    if req is null then raise exception 'FD: Identificador do pedido inválido.'; end if;
    perform pg_advisory_xact_lock(hashtextextended(actor::text || req::text, 0));
    select * into o from fly_delivery.orders where customer_id=actor and request_id=req;
    if found then return fly_delivery.order_details(o,true); end if;
    store_id_input := (input->>'store_id')::uuid;
    select * into s from fly_delivery.stores where id=store_id_input and active and is_open and not sample for share;
    if not found then raise exception 'FD: A loja não está aceitando pedidos agora.'; end if;
    lat_input := (input->>'lat')::double precision;
    lng_input := (input->>'lng')::double precision;
    if lat_input is null or lng_input is null or not (lat_input between -90 and 90 and lng_input between -180 and 180) then
      raise exception 'FD: Marque o local no mapa.';
    end if;
    distance := fly_delivery.km(s.lat,s.lng,lat_input,lng_input);
    if distance > s.delivery_radius then raise exception 'FD: O endereço está fora da área de entrega desta loja.'; end if;
    items := input->'items';
    if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items) not between 1 and 30 then
      raise exception 'FD: Revise os itens do carrinho.';
    end if;
    supplied_count := jsonb_array_length(items);
    select count(*), coalesce(sum(pr.price*j.quantity),0), coalesce(bool_or(pr.price is distinct from j.price),false)
      into total_count,total,quote_changed
    from jsonb_to_recordset(items) as j(id uuid, quantity integer, price integer)
    join (select * from fly_delivery.products where store_id=s.id and active for share) pr on pr.id=j.id
    where j.quantity between 1 and 25;
    if total_count<>supplied_count or total<=0 or
       (select count(distinct item->>'id') from jsonb_array_elements(items) item)<>supplied_count then
      raise exception 'FD: Revise os itens disponíveis no cardápio.';
    end if;
    if quote_changed or s.fee is distinct from (input->>'fee')::integer then
      raise exception 'FD: Os preços mudaram. Volte ao cardápio e revise o carrinho.';
    end if;
    if coalesce(char_length(btrim(input->>'address')),0) not between 5 and 240 or
       coalesce(input->>'payment','') not in ('pix_delivery','card_delivery','cash_delivery') then
      raise exception 'FD: Confira o endereço e a forma de pagamento.';
    end if;
    insert into fly_delivery.orders(customer_id,store_id,request_id,address,lat,lng,payment,subtotal,fee,distance_km)
      values(actor,s.id,req,btrim(input->>'address'),lat_input,lng_input,input->>'payment',total,s.fee,round(distance::numeric,2))
      returning * into o;
    insert into fly_delivery.order_items(order_id,product_id,name,price,quantity)
      select o.id,pr.id,pr.name,pr.price,j.quantity from jsonb_to_recordset(items) as j(id uuid,quantity integer)
      join fly_delivery.products pr on pr.id=j.id;
    insert into fly_delivery.order_events(order_id,actor_id,status) values(o.id,actor,o.status);
    return fly_delivery.order_details(o,true);
  when 'managed_stores' then
    if a.role not in ('merchant','admin') then raise exception 'FD: Acesso restrito às lojas.'; end if;
    return coalesce((select jsonb_agg(to_jsonb(st) || jsonb_build_object(
      'owner_email', case when a.role='admin' then (select u.email from auth.users u where u.id=st.owner_id) else null end,
      'products',coalesce((select jsonb_agg(to_jsonb(pr) order by pr.name) from fly_delivery.products pr where pr.store_id=st.id),'[]'::jsonb))
      order by st.name) from fly_delivery.stores st
      where not st.sample and (a.role='admin' or st.owner_id=actor)), '[]'::jsonb);
  when 'save_store' then
    if a.role<>'admin' then raise exception 'FD: Acesso restrito à administração.'; end if;
    email_input := lower(btrim(input->>'owner_email'));
    select u.id into target from auth.users u where lower(u.email)=email_input and u.email_confirmed_at is not null;
    if not found then raise exception 'FD: O responsável precisa ter uma conta com e-mail confirmado.'; end if;
    insert into fly_delivery.accounts(id,role) values(target,'merchant')
      on conflict(id) do update set role='merchant' where accounts.role in ('customer','merchant') and accounts.enabled;
    if not found then raise exception 'FD: A conta selecionada não pode gerenciar lojas.'; end if;
    store_id_input := (input->>'id')::uuid;
    if store_id_input is null then
      insert into fly_delivery.stores(owner_id,name,description,category,active,address,lat,lng,fee,delivery_radius,eta)
      values(target,btrim(input->>'name'),coalesce(btrim(input->>'description'),''),input->>'category',
        coalesce((input->>'active')::boolean,false),btrim(input->>'address'),(input->>'lat')::double precision,
        (input->>'lng')::double precision,(input->>'fee')::integer,(input->>'delivery_radius')::integer,(input->>'eta')::integer)
      returning * into s;
    else
      update fly_delivery.stores set owner_id=target,name=btrim(input->>'name'),description=coalesce(btrim(input->>'description'),''),
        category=input->>'category',active=coalesce((input->>'active')::boolean,false),address=btrim(input->>'address'),
        lat=(input->>'lat')::double precision,lng=(input->>'lng')::double precision,fee=(input->>'fee')::integer,
        delivery_radius=(input->>'delivery_radius')::integer,eta=(input->>'eta')::integer
      where id=store_id_input and not sample returning * into s;
    end if;
    if s.id is null then raise exception 'FD: Loja não encontrada.'; end if;
    return jsonb_build_object('id',s.id);
  when 'set_open', 'save_product' then
    store_id_input := (input->>'store_id')::uuid;
    select * into s from fly_delivery.stores where id=store_id_input and not sample and
      (a.role='admin' or (a.role='merchant' and owner_id=actor)) for update;
    if not found then raise exception 'FD: Você não tem acesso a esta loja.'; end if;
    if action='set_open' then
      update fly_delivery.stores set is_open=coalesce((input->>'open')::boolean,false) where id=s.id;
      return '{}'::jsonb;
    end if;
    photo := nullif(input->>'image','');
    if photo is not null and photo !~ ('^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/fly-delivery-menu/' || s.id::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$') then
      raise exception 'FD: Envie a foto pelo painel da loja.';
    end if;
    if nullif(input->>'id','') is null then
      insert into fly_delivery.products(store_id,name,description,price,image,active)
        values(s.id,btrim(input->>'name'),coalesce(btrim(input->>'description'),''),(input->>'price')::integer,
          photo,coalesce((input->>'active')::boolean,true)) returning * into p;
    else
      update fly_delivery.products set name=btrim(input->>'name'),description=coalesce(btrim(input->>'description'),''),
        price=(input->>'price')::integer,image=photo,active=coalesce((input->>'active')::boolean,true)
        where id=(input->>'id')::uuid and store_id=s.id returning * into p;
    end if;
    if p.id is null then raise exception 'FD: Produto não encontrado.'; end if;
    return jsonb_build_object('id',p.id);
  when 'set_courier' then
    if a.role<>'admin' then raise exception 'FD: Acesso restrito à administração.'; end if;
    email_input := lower(btrim(input->>'email'));
    select u.id into target from auth.users u where lower(u.email)=email_input and u.email_confirmed_at is not null;
    if not found then raise exception 'FD: O entregador precisa ter uma conta com e-mail confirmado.'; end if;
    insert into fly_delivery.accounts(id) values(target) on conflict do nothing;
    select role,enabled into target_role,target_enabled from fly_delivery.accounts where id=target for update;
    if target_role not in ('customer','courier') or not target_enabled then
      raise exception 'FD: A conta selecionada não pode ser alterada.';
    end if;
    if not coalesce((input->>'enabled')::boolean,false) and exists (
      select 1 from fly_delivery.orders where courier_id=target and status in ('assigned','picked_up')
    ) then raise exception 'FD: O entregador ainda tem uma entrega ativa.'; end if;
    update fly_delivery.accounts
      set role=case when coalesce((input->>'enabled')::boolean,false) then 'courier' else 'customer' end,
        online=false,last_seen=null,lat=null,lng=null where id=target;
    return '{}'::jsonb;
  when 'couriers' then
    if a.role<>'admin' then raise exception 'FD: Acesso restrito à administração.'; end if;
    return coalesce((select jsonb_agg(jsonb_build_object('email',u.email,
      'online',c.online and c.last_seen>now()-interval '90 seconds') order by u.email)
      from fly_delivery.accounts c join auth.users u on u.id=c.id where c.role='courier' and c.enabled), '[]'::jsonb);
  when 'presence' then
    if a.role<>'courier' then raise exception 'FD: Conta sem autorização para fazer entregas.'; end if;
    lat_input := (input->>'lat')::double precision;
    lng_input := (input->>'lng')::double precision;
    target_enabled := coalesce((input->>'online')::boolean,false);
    if target_enabled and (lat_input is null or lng_input is null or not (lat_input between -90 and 90 and lng_input between -180 and 180)) then
      raise exception 'FD: Ative a localização para ficar disponível.';
    end if;
    update fly_delivery.accounts set online=target_enabled,last_seen=now(),
      lat=case when target_enabled then lat_input end,lng=case when target_enabled then lng_input end
      where id=actor and role='courier' and enabled;
    if not found then raise exception 'FD: Conta sem autorização para fazer entregas.'; end if;
    return '{}'::jsonb;
  when 'offers' then
    if a.role<>'courier' then raise exception 'FD: Conta sem autorização para fazer entregas.'; end if;
    if not a.online or a.last_seen<now()-interval '90 seconds' or exists (
      select 1 from fly_delivery.orders where courier_id=actor and status in ('assigned','picked_up')
    ) then return '[]'::jsonb; end if;
    return coalesce((select jsonb_agg(fly_delivery.order_details(q,false) order by q.created_at)
      from (select ord.* from fly_delivery.orders ord join fly_delivery.stores st on st.id=ord.store_id
        where ord.status='ready' and fly_delivery.km(a.lat,a.lng,st.lat,st.lng)<=15
        order by ord.created_at limit 20) q),'[]'::jsonb);
  when 'transition' then
    select * into a from fly_delivery.accounts where id=actor and enabled for update;
    if not found then raise exception 'FD: Acesso indisponível.'; end if;
    select * into o from fly_delivery.orders where id=(input->>'id')::uuid for update;
    if not found then raise exception 'FD: Pedido indisponível.'; end if;
    select * into s from fly_delivery.stores where id=o.store_id for share;
    target_status := input->>'status';
    if target_status='assigned' then
      if a.role<>'courier' or not a.online or a.last_seen is null or a.last_seen<now()-interval '90 seconds' or
         a.lat is null or a.lng is null or fly_delivery.km(a.lat,a.lng,s.lat,s.lng)>15 then
        raise exception 'FD: Você precisa estar disponível e próximo à loja.';
      end if;
      if o.status='assigned' and o.courier_id=actor then return fly_delivery.order_details(o,true); end if;
      if o.status<>'ready' or exists (
        select 1 from fly_delivery.orders where courier_id=actor and status in ('assigned','picked_up')
      ) then raise exception 'FD: Esta oferta não está mais disponível.'; end if;
      update fly_delivery.orders set status='assigned',courier_id=actor,updated_at=now() where id=o.id returning * into o;
    else
      if not coalesce(
        ((a.role='admin' or (a.role='merchant' and s.owner_id=actor)) and
          ((o.status='placed' and target_status='preparing') or (o.status='preparing' and target_status='ready')
          or (o.status in ('placed','preparing','ready') and target_status='cancelled')))
        or (o.customer_id=actor and o.status='placed' and target_status='cancelled')
        or (a.role='courier' and o.courier_id=actor and
          ((o.status='assigned' and target_status='picked_up') or (o.status='picked_up' and target_status='delivered'))),false)
      then raise exception 'FD: Esta etapa não está disponível para você.'; end if;
      update fly_delivery.orders set status=target_status,updated_at=now() where id=o.id returning * into o;
    end if;
    insert into fly_delivery.order_events(order_id,actor_id,status) values(o.id,actor,o.status);
    return fly_delivery.order_details(o,true);
  else raise exception 'FD: Comando inválido.';
  end case;
exception
  when invalid_text_representation or check_violation or not_null_violation or numeric_value_out_of_range then
    raise exception 'FD: Confira os dados preenchidos.';
end;
$$;

revoke all on all functions in schema fly_delivery from public, anon, authenticated;
grant execute on function fly_delivery.api(text,jsonb) to anon,authenticated;
grant execute on function fly_delivery.can_upload(text) to authenticated;

create function public.fd_api(action text, input jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$ select fly_delivery.api(action,input); $$;
revoke all on function public.fd_api(text,jsonb) from public, anon, authenticated;
grant execute on function public.fd_api(text,jsonb) to anon,authenticated;

insert into fly_delivery.stores (id,name,description,category,active,is_open,sample,address,lat,lng,fee,eta) values
('f1000000-0000-4000-8000-000000000001','Brasa Smash','Hambúrgueres artesanais e batatas crocantes.','Hambúrguer',true,true,true,'Belo Horizonte, MG',-19.9235,-43.9381,599,25),
('f1000000-0000-4000-8000-000000000002','Forno & Lenha','Pizza artesanal com massa de longa fermentação.','Pizza',true,true,true,'Belo Horizonte, MG',-19.9251,-43.9415,790,40),
('f1000000-0000-4000-8000-000000000003','Nori House','Clássicos japoneses para dividir ou pedir só para você.','Japonesa',true,true,true,'Belo Horizonte, MG',-19.9282,-43.9393,690,35),
('f1000000-0000-4000-8000-000000000004','Verde Bowl','Comida fresca, colorida e feita na hora.','Brasileira',true,true,true,'Belo Horizonte, MG',-19.9318,-43.9389,499,25);
insert into fly_delivery.products (store_id,name,description,price,image) values
('f1000000-0000-4000-8000-000000000001','Smash da Casa','Pão brioche, carne na chapa, cheddar e molho da casa.',2890,'/assets/burger.webp'),
('f1000000-0000-4000-8000-000000000001','Duplo Brasa','Dois discos de carne, cheddar e picles da casa.',3690,'/assets/burger.webp'),
('f1000000-0000-4000-8000-000000000001','Batata crocante','Porção individual de batatas fritas.',1190,null),
('f1000000-0000-4000-8000-000000000002','Margherita','Tomate, muçarela e manjericão fresco.',5490,'/assets/pizza.webp'),
('f1000000-0000-4000-8000-000000000002','Calabresa artesanal','Calabresa, cebola roxa e orégano.',5890,'/assets/pizza.webp'),
('f1000000-0000-4000-8000-000000000003','Combinado Nori','Dezesseis peças de sushi e rolls da casa.',4990,'/assets/sushi.webp'),
('f1000000-0000-4000-8000-000000000004','Bowl da Estação','Grãos, folhas frescas, legumes e molho cítrico.',3190,'/assets/bowl.webp');
