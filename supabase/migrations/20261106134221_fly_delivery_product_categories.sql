-- Keep existing multi-category products unclassified until the merchant chooses a category.
alter table fly_delivery.products add column category text;
update fly_delivery.products p set category=s.categories[1]
from fly_delivery.stores s where p.store_id=s.id and cardinality(s.categories)=1 and not s.sample and s.deleted_at is null;

create function fly_delivery.validate_product_category()
returns trigger language plpgsql security invoker set search_path = ''
as $$
begin
  if new.category is not null and not exists(select 1 from fly_delivery.stores s where s.id=new.store_id and new.category=any(s.categories)) then
    raise exception 'FD: A categoria do produto deve pertencer ao estabelecimento.';
  end if;
  return new;
end;
$$;
revoke all on function fly_delivery.validate_product_category() from public,anon,authenticated;
create trigger fd_product_category before insert or update of category,store_id on fly_delivery.products
  for each row execute function fly_delivery.validate_product_category();

CREATE OR REPLACE FUNCTION fly_delivery.api(action text, input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  photo text;
  product_category_input text;
  quote_changed boolean;
begin
  if action='catalog' then return fly_delivery.market_catalog(); end if;
  if actor is null then raise exception 'FD: Entre para continuar.'; end if;

  if action='session' then
    insert into fly_delivery.accounts(id) values(actor) on conflict (id) do nothing;
  end if;
  select * into a from fly_delivery.accounts where id=actor;
  if a.id is null or not a.enabled or a.role='courier' then raise exception 'FD: Acesso indisponível.'; end if;

  case action
  when 'session' then
    return jsonb_build_object('id',a.id,'email',auth.jwt()->>'email','role',a.role,'online',a.online);
  when 'orders' then
    return fly_delivery.scoped_orders(coalesce(input->>'view',a.role));
  when 'place' then
    if a.role<>'customer' then raise exception 'FD: Operação exclusiva do cliente.'; end if;
    if fly_delivery.customer_profile('{}'::jsonb) is null then raise exception 'FD: Complete seu cadastro antes de fazer o pedido.'; end if;
    req := (input->>'request_id')::uuid;
    if req is null then raise exception 'FD: Identificador do pedido inválido.'; end if;
    perform pg_advisory_xact_lock(hashtextextended(actor::text || req::text, 0));
    select * into o from fly_delivery.orders where customer_id=actor and request_id=req;
    if found then return fly_delivery.order_details(o,true); end if;
    store_id_input := (input->>'store_id')::uuid;
    perform fly_delivery.check_store_open(store_id_input,req);
    select * into s from fly_delivery.stores where id=store_id_input and active and is_open and not sample and deleted_at is null for share;
    if not found then raise exception 'FD: A loja não está aceitando pedidos agora.'; end if;
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
    insert into fly_delivery.orders(customer_id,store_id,request_id,address,payment,subtotal,fee)
      values(actor,s.id,req,btrim(input->>'address'),input->>'payment',total,s.fee)
      returning * into o;
    insert into fly_delivery.order_items(order_id,product_id,name,price,quantity)
      select o.id,pr.id,pr.name,pr.price,j.quantity from jsonb_to_recordset(items) as j(id uuid,quantity integer)
      join fly_delivery.products pr on pr.id=j.id;
    insert into fly_delivery.order_events(order_id,actor_id,status) values(o.id,actor,o.status);
    return fly_delivery.order_details(o,true);
  when 'set_open', 'save_product' then
    if a.role<>'merchant' then raise exception 'FD: Operação exclusiva do estabelecimento.'; end if;
    store_id_input := (input->>'store_id')::uuid;
    select * into s from fly_delivery.stores where id=store_id_input and not sample and deleted_at is null and owner_id=actor for update;
    if not found then raise exception 'FD: Você não tem acesso a esta loja.'; end if;
    if action='set_open' then
      update fly_delivery.stores set is_open=coalesce((input->>'open')::boolean,false) where id=s.id;
      return '{}'::jsonb;
    end if;
    product_category_input := nullif(btrim(input->>'category'),'');
    if product_category_input is null and not (input ? 'category') and nullif(input->>'id','') is not null then
      select category into product_category_input from fly_delivery.products where id=(input->>'id')::uuid and store_id=s.id;
    end if;
    if product_category_input is null and cardinality(s.categories)=1 then product_category_input:=s.categories[1]; end if;
    if product_category_input is null or not (product_category_input=any(s.categories)) then
      raise exception 'FD: Selecione uma das categorias do estabelecimento para o produto.';
    end if;
    photo := nullif(input->>'image','');
    if photo is not null and photo !~ ('^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/fly-delivery-menu/' || s.id::text || '/[0-9a-f-]{36}\.(jpg|png|webp)$') then
      raise exception 'FD: Envie a foto pelo painel da loja.';
    end if;
    if nullif(input->>'id','') is null then
      insert into fly_delivery.products(store_id,name,description,price,image,active,category)
        values(s.id,btrim(input->>'name'),coalesce(btrim(input->>'description'),''),(input->>'price')::integer,
          photo,coalesce((input->>'active')::boolean,true),product_category_input) returning * into p;
    else
      update fly_delivery.products set name=btrim(input->>'name'),description=coalesce(btrim(input->>'description'),''),
        price=(input->>'price')::integer,image=photo,category=product_category_input,active=coalesce((input->>'active')::boolean,true)
        where id=(input->>'id')::uuid and store_id=s.id returning * into p;
    end if;
    if p.id is null then raise exception 'FD: Produto não encontrado.'; end if;
    return jsonb_build_object('id',p.id);
  when 'transition' then
    select * into a from fly_delivery.accounts where id=actor and enabled for update;
    if not found then raise exception 'FD: Acesso indisponível.'; end if;
    select * into o from fly_delivery.orders where id=(input->>'id')::uuid for update;
    if not found then raise exception 'FD: Pedido indisponível.'; end if;
    select * into s from fly_delivery.stores where id=o.store_id for share;
    target_status := input->>'status';
    -- Requests from an older open shop tab also mark the order as dispatched.
    if target_status='ready' then target_status:='picked_up'; end if;
    if not coalesce(
      (a.role='merchant' and s.owner_id=actor and (
        (o.status='placed' and target_status='preparing') or
        (o.status in ('preparing','ready','assigned') and target_status='picked_up') or
        (o.status='picked_up' and target_status='delivered') or
        (o.status in ('placed','preparing','ready','assigned') and target_status='cancelled')
      )) or
      (a.role='customer' and o.customer_id=actor and o.status='placed' and target_status='cancelled'),false)
    then raise exception 'FD: Esta etapa não está disponível para você.'; end if;
    update fly_delivery.orders set status=target_status,updated_at=now() where id=o.id returning * into o;
    insert into fly_delivery.order_events(order_id,actor_id,status) values(o.id,actor,o.status);
    return fly_delivery.order_details(o,true);
  else raise exception 'FD: Comando inválido.';
  end case;
exception
  when invalid_text_representation or check_violation or not_null_violation or numeric_value_out_of_range then
    raise exception 'FD: Confira os dados preenchidos.';
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
      'price',pr.price,'image',pr.image,'category',pr.category) order by pr.name)
      from fly_delivery.products pr where pr.store_id=st.id and pr.active),'[]'::jsonb))
    order by fly_delivery.store_open_at(st,now()) desc,st.name),'[]'::jsonb)
  from fly_delivery.stores st
  where st.active and not st.sample and st.deleted_at is null and st.address is not null;
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
