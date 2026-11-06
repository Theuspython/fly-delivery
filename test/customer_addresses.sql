-- Temporary customers and addresses are rolled back after these assertions.
begin;
do $$
declare
  buyer uuid := gen_random_uuid();
  other_buyer uuid := gen_random_uuid();
  merchant uuid := gen_random_uuid();
  actor uuid;
  result jsonb;
begin
  foreach actor in array array[buyer,other_buyer,merchant] loop
    insert into auth.users(id,email,email_confirmed_at) values(actor,actor::text || '@example.invalid',now());
  end loop;
  insert into fly_delivery.accounts(id,role) values(buyer,'customer'),(other_buyer,'customer'),(merchant,'merchant');
  insert into fly_delivery.customer_profiles(user_id,full_name,phone)
    values(buyer,'Cliente Endereço','31992341111'),(other_buyer,'Outro Cliente','31992342222');
  perform set_config('request.jwt.claim.sub',buyer::text,true);
  if public.fd_api('customer_address') is not null then raise exception 'Unexpected initial address'; end if;
  result:=public.fd_api('save_customer_address',jsonb_build_object('street',' Rua das Flores ','number',' 110 ',
    'neighborhood',' Centro ','customer_id',other_buyer));
  if result->>'text'<>'Rua das Flores, 110 - Centro' then raise exception 'Address formatting incorrect'; end if;
  if public.fd_api('customer_address')->>'number'<>'110' then raise exception 'Address did not persist'; end if;
  perform public.fd_api('save_customer_address','{"street":"Rua Nova","number":"S/N","neighborhood":"Jardim"}');
  if (select count(*) from fly_delivery.customer_addresses where customer_id=buyer)<>1 then raise exception 'Duplicate primary address'; end if;
  if public.fd_api('customer_address')->>'street'<>'Rua Nova' then raise exception 'Primary address update failed'; end if;
  begin
    perform public.fd_api('save_customer_address','{"street":"Rua","number":" ","neighborhood":"Centro"}');
    raise exception 'Blank house number accepted';
  exception when raise_exception then
    if sqlerrm not like 'FD: Preencha rua%' then raise; end if;
  end;
  begin
    perform public.fd_api('save_customer_address','{"street":"Rua","number":"1"}');
    raise exception 'Missing neighborhood accepted';
  exception when raise_exception then
    if sqlerrm not like 'FD: Preencha rua%' then raise; end if;
  end;
  perform set_config('request.jwt.claim.sub',other_buyer::text,true);
  if public.fd_api('customer_address',jsonb_build_object('customer_id',buyer)) is not null then
    raise exception 'Another buyer address exposed';
  end if;
  perform public.fd_api('save_customer_address',jsonb_build_object('street','Rua Outro','number','25','neighborhood','Outro Bairro','customer_id',buyer));
  perform set_config('request.jwt.claim.sub',buyer::text,true);
  if public.fd_api('customer_address')->>'street'<>'Rua Nova' then raise exception 'Other buyer overwrote primary address'; end if;
  update fly_delivery.accounts set enabled=false where id=buyer;
  begin
    perform public.fd_api('customer_address');
    raise exception 'Disabled customer can access address';
  exception when raise_exception then
    if sqlerrm not like 'FD: Endereço exclusivo%' then raise; end if;
  end;
  perform set_config('request.jwt.claim.sub',merchant::text,true);
  begin
    perform public.fd_api('save_customer_address','{"street":"Rua","number":"1","neighborhood":"Centro"}');
    raise exception 'Merchant can use customer addresses';
  exception when raise_exception then
    if sqlerrm not like 'FD: Endereço exclusivo%' then raise; end if;
  end;
  perform set_config('request.jwt.claim.sub','',true);
  begin
    perform public.fd_api('customer_address');
    raise exception 'Anonymous caller can access address';
  exception when raise_exception then
    if sqlerrm not like 'FD: Entre para continuar%' then raise; end if;
  end;
end;
$$;
select 'Endereço principal: cadastro, edição, validação e isolamento entre contas verificados' as integration;
rollback;
