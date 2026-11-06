import { mapPicker } from './google-map.js';
import { $, main, esc, icon, money, api, command, modal, toast, bindSubmit, geo,
  categories, empty, orderCard, transitionButton, bindTransitions } from './shared.js';

const profiles = {
  entregador:{ role:'courier', title:'Entregas', label:'ENTREGADOR', symbol:'bike', intro:'Fique disponível para receber entregas próximas e acompanhe sua próxima retirada.' },
  admin:{ role:'admin', title:'Administração', label:'GESTÃO FLY DELIVERY', symbol:'shield', intro:'Cadastre estabelecimentos e crie acessos para lojas e entregadores.' }
};
const mapsLink = (lat, lng, label) => '<a class="btn outline" href="https://www.google.com/maps/dir/?api=1&amp;destination=' +
  encodeURIComponent(lat + ',' + lng) + '" target="_blank" rel="noopener noreferrer">' + icon('pin') + ' ' + esc(label) + '</a>';
const formEnd = label => '<p class="form-error" data-form-error role="alert"></p><button class="btn primary wide" type="submit">' + esc(label) + '</button>';

const weekdays = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];

function showCredentials(page,login,password) {
  const url = location.origin + '/' + page + '/';
  const el = modal('Acesso criado',
    '<div class="form-stack"><label>Login<input readonly value="' + esc(login) +
    '"></label><label>Senha inicial<input readonly id="operator-secret" value="' + esc(password) +
    '"></label><a class="text-button" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Abrir aplicativo</a>' +
    '<button class="btn primary" data-copy-access>Copiar acesso</button></div>',
    'Entregue estes dados em particular ao titular da conta.');
  const field = $('#operator-secret',el);
  const erase = () => {
    if (el.open && field.isConnected) return;
    field.value = '';
    el.removeEventListener('close',erase);
  };
  el.addEventListener('close',erase);
  $('[data-copy-access]',el).onclick = async () => {
    try {
      await navigator.clipboard.writeText([url,'Login: ' + login,'Senha: ' + field.value].join('\n'));
      toast('Acesso copiado.');
    } catch { toast('Copie os dados exibidos.'); }
  };
}

function registrationForm(kind,done,legacyStore) {
  const requestId = crypto.randomUUID();
  const store = kind === 'store';
  const title = legacyStore ? 'Criar acesso para ' + legacyStore.name : store ? 'Cadastrar estabelecimento' : 'Cadastrar entregador';
  const el = modal(title,'<form class="form-stack" id="operator-form">' +
    (store && !legacyStore ? '<label>Nome do estabelecimento<input name="name" required minlength="2" maxlength="80"></label>' +
      '<fieldset class="operator-categories"><legend>Categorias</legend>' + categories.slice(1).map(([name]) =>
      '<label class="check"><input type="checkbox" name="category" value="' + esc(name) + '"> ' + esc(name) + '</label>').join('') +
      '</fieldset>' : '') +
    '<label>Login<input name="login" autocomplete="off" autocapitalize="none" spellcheck="false" minlength="3" maxlength="40" required></label>' +
    '<label>Senha inicial<input type="password" name="password" autocomplete="new-password" minlength="8" maxlength="72" required></label>' +
    formEnd('Criar acesso') + '</form>');
  bindSubmit($('#operator-form',el),async fields => {
    const input = Object.fromEntries(fields);
    if (store && !legacyStore && !fields.getAll('category').length) throw new Error('Selecione pelo menos uma categoria.');
    await api('provision',{ kind,request_id:requestId,store_id:legacyStore?.id,
      name:input.name,categories:fields.getAll('category'),login:input.login,password:input.password });
    el.close();
    showCredentials(store ? 'loja' : 'entregador',input.login.trim().toLowerCase(),input.password);
    await done();
  });
}

export function storeSettings(store,done) {
  let selected = Number.isFinite(store.lat) && Number.isFinite(store.lng) ? { lat:store.lat,lng:store.lng } : null;
  let map;
  let image = store.image;
  let uploadedFile;
  const el = modal('Configurar estabelecimento',
    '<form class="form-stack" id="store-form"><label>Foto ou logo da loja<input name="photo" type="file" accept="image/jpeg,image/png,image/webp"></label>' +
    (image ? '<label class="check"><input name="remove_photo" type="checkbox"> Remover foto atual</label>' : '') +
    '<p class="muted">JPG, PNG ou WebP, até 3 MB.</p><label>Descrição da loja<textarea name="description" rows="2" maxlength="260">' +
    esc(store.description) + '</textarea></label><fieldset class="operator-hours"><legend>Horário de funcionamento</legend>' +
    weekdays.map((day,index) => {
      const hours = store.weekly_hours?.[index];
      const enabled = Boolean(hours);
      return '<div class="operator-day"><label class="check"><input type="checkbox" name="day-' + index + '"' +
        (enabled ? ' checked' : '') + '> ' + day + '</label><input aria-label="Abertura de ' + day +
        '" type="time" name="open-' + index + '" value="' + esc(hours?.open ?? '09:00') + '"' + (enabled ? '' : ' disabled') +
        '><input aria-label="Fechamento de ' + day + '" type="time" name="close-' + index + '" value="' +
        esc(hours?.close ?? '18:00') + '"' + (enabled ? '' : ' disabled') + '></div>';
    }).join('') + '<p class="muted">Selecione os dias abertos. O horário é de Brasília. Para 24 horas, use 00:00 nos dois campos.</p></fieldset>' +
    '<label>Endereço de retirada<input name="address" required minlength="5" maxlength="240" value="' +
    esc(store.address) + '"></label><div class="fields-three"><label>Taxa (R$)<input name="fee" type="number" step="0.01" min="0" max="1000" required value="' +
    store.fee / 100 + '"></label><label>Raio (km)<input name="delivery_radius" type="number" min="1" max="50" required value="' +
    store.delivery_radius + '"></label><label>Prazo (min)<input name="eta" type="number" min="5" max="180" required value="' +
    store.eta + '"></label></div><p class="map-help">Marque o ponto de retirada no mapa.</p><div class="map" id="store-map"></div>' +
    '<div class="map-actions"><button class="btn outline" type="button" data-gps>' + icon('location') +
    ' Usar GPS</button><span class="muted" id="store-point">Aguardando localização</span></div>' +
    '<details class="map-coordinates"><summary>Informar coordenadas</summary><div class="fields-two">' +
    '<label>Latitude<input id="store-lat" inputmode="decimal" placeholder="-19.9235"></label>' +
    '<label>Longitude<input id="store-lng" inputmode="decimal" placeholder="-43.9381"></label></div>' +
    '<button class="btn outline" type="button" data-set-coordinates>Usar coordenadas</button></details>' +
    '<label class="check"><input name="active" type="checkbox"' + (store.active || !store.address ? ' checked' : '') +
    '> Publicar no catálogo</label>' + formEnd('Salvar configurações') + '</form>');
  weekdays.forEach((_,index) => {
    const check = $('[name="day-' + index + '"]',el);
    check.onchange = () => {
      $('[name="open-' + index + '"]',el).disabled = !check.checked;
      $('[name="close-' + index + '"]',el).disabled = !check.checked;
    };
  });
  map = mapPicker($('#store-map',el),selected,undefined,point => {
    selected = point;
    $('#store-point',el).textContent = 'Ponto selecionado';
  });
  el.addEventListener('close',() => map.remove(),{ once:true });
  $('[data-gps]',el).onclick = async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try { const point = await geo(); if (button.isConnected) map.set(point); }
    catch (error) { if (button.isConnected) $('[data-form-error]',el).textContent = error.message; }
    finally { button.disabled = false; }
  };
  $('[data-set-coordinates]',el).onclick = () => {
    const value = id => $(id,el).value.trim().replace(',','.');
    const lat = value('#store-lat');
    const lng = value('#store-lng');
    const formError = $('[data-form-error]',el);
    if (!lat || !lng || !(Number(lat) >= -90 && Number(lat) <= 90 && Number(lng) >= -180 && Number(lng) <= 180)) {
      formError.textContent = 'Informe latitude e longitude válidas.';
      return;
    }
    formError.textContent = '';
    map.set({ lat:Number(lat),lng:Number(lng) });
  };
  bindSubmit($('#store-form',el),async data => {
    if (!selected) throw new Error('Selecione o ponto de retirada no mapa, use o GPS ou informe as coordenadas.');
    const file = data.get('photo');
    if (file?.size && file !== uploadedFile) {
      if (file.size > 3 * 1024 * 1024) throw new Error('A foto deve ter até 3 MB.');
      image = (await api('upload?store=' + encodeURIComponent(store.id),file)).url;
      uploadedFile = file;
    }
    await command('save_store_profile',{ id:store.id,address:data.get('address'),description:data.get('description'),
      fee:Math.round(Number(data.get('fee'))*100),delivery_radius:Number(data.get('delivery_radius')),eta:Number(data.get('eta')),
      active:data.has('active'),lat:selected.lat,lng:selected.lng,image:data.has('remove_photo') && !file?.size ? null : image,
      weekly_hours:weekdays.map((_,index) => data.has('day-' + index) ?
        { open:data.get('open-' + index),close:data.get('close-' + index) } : null)
    });
    el.close();
    toast('Configurações salvas.');
    await done();
  });
}

export function productForm(store, product, done) {
  let photo = product?.image;
  let selectedFile;
  const el = modal(product ? 'Editar produto' : 'Adicionar produto',
    '<form class="form-stack" id="product-form"><label>Nome<input name="name" required minlength="2" maxlength="100" value="' +
    esc(product?.name) + '"></label><label>Descrição<textarea name="description" rows="3" maxlength="500">' + esc(product?.description) +
    '</textarea></label><label>Preço (R$)<input name="price" type="number" min="0.01" max="10000" step="0.01" required value="' +
    (product ? product.price / 100 : '') + '"></label><label>Foto do produto<input name="photo" type="file" accept="image/jpeg,image/png,image/webp"></label>' +
    (photo ? '<button class="text-button" type="button" data-remove-photo>Remover foto atual</button>' : '') +
    '<p class="muted">JPG, PNG ou WebP, até 3 MB.</p><label class="check"><input name="active" type="checkbox"' +
    (product?.active !== false ? ' checked' : '') + '> Disponível no cardápio</label>' + formEnd('Salvar produto') + '</form>');
  const remove = $('[data-remove-photo]',el);
  if (remove) remove.onclick = () => { photo = null; remove.textContent = 'Foto marcada para remoção'; remove.disabled = true; };
  bindSubmit($('#product-form',el), async data => {
    const file = data.get('photo');
    if (file?.size && file !== selectedFile) {
      if (file.size > 3 * 1024 * 1024) throw new Error('A foto deve ter até 3 MB.');
      photo = (await api('upload?store=' + encodeURIComponent(store.id),file)).url;
      selectedFile = file;
    }
    await command('save_product', { id:product?.id, store_id:store.id, name:data.get('name'), description:data.get('description'),
      price:Math.round(Number(data.get('price'))*100), active:data.has('active'), image:photo });
    el.close();
    toast('Produto salvo.');
    await done();
  });
}

export function storeMarkup(store, role, productsOnly = false) {
  const labels = esc((store.categories ?? [store.category]).join(' · '));
  if (role === 'admin') {
    return '<article class="panel management-card"><span class="overline">' + labels + '</span><h3>' + esc(store.name) +
      '</h3><p>' + (store.owner_login ? 'Login: ' + esc(store.owner_login) : 'Acesso a configurar') + '</p>' +
      (!store.owner_login ? '<div class="order-actions"><button class="btn outline" data-link-store="' + esc(store.id) +
        '">Criar login</button></div>' : '') + '</article>';
  }
  const actions = (productsOnly ? '' : '<button class="btn outline" data-settings="' + esc(store.id) + '">Foto e horários</button>' +
    (store.address ? '<button class="btn outline" data-open="' + esc(store.id) + '">' + (store.is_open ? 'Pausar pedidos' : 'Ativar pedidos') + '</button>' : '')) +
    '<button class="btn primary" data-add-product="' + esc(store.id) + '">' + icon('plus') + ' Produto</button>';
  return '<article class="panel management-card"><div class="management-head"><div><span class="overline">' + labels +
    '</span><h3>' + esc(store.name) + '</h3><p>' + esc(store.address || 'Configure a retirada e os horários para publicar.') + '</p></div><span class="status ' +
    (store.accepting_now ? 'status-delivered' : 'status-cancelled') + '">' +
    (store.active ? store.accepting_now ? 'Aberta agora' : 'Fechada agora' : 'Não publicada') + '</span></div>' +
    '<div class="order-actions">' + actions + '</div><div class="menu-admin">' + (store.products.length ? store.products.map(product =>
      '<div class="menu-admin-row">' + (product.image ? '<img src="' + esc(product.image) + '" alt="">' : '<span class="product-placeholder">' + icon('bag') + '</span>') +
      '<div><strong>' + esc(product.name) + '</strong><p>' + money(product.price) + ' · ' + (product.active ? 'Disponível' : 'Pausado') +
      '</p></div><button class="btn outline" data-edit-product="' + esc(product.id) + '" data-store="' + esc(store.id) + '">Editar</button></div>').join('') :
      '<p class="muted">Nenhum produto cadastrado.</p>') + '</div></article>';
}

function courierActions(order) {
  if (order.status === 'assigned') return mapsLink(order.pickup_lat,order.pickup_lng,'Ir até a loja') +
    transitionButton(order,'picked_up','Confirmar retirada');
  if (order.status === 'picked_up') return mapsLink(order.lat,order.lng,'Ir até a entrega') +
    transitionButton(order,'delivered','Confirmar entrega');
  return '';
}

export function operations(page, context) {
  const config = profiles[page];
  let timer;
  let sequence = 0;
  let storeList = [];
  let online = false;
  let onlineKnown = false;
  let owner;
  let position;
  let heartbeat = 0;
  let watch;
  let refreshing = false;
  let availabilityChange = false;
  const allowed = user => user?.role === config.role;

  function stopWatch() {
    if (watch !== undefined) navigator.geolocation.clearWatch(watch);
    watch = undefined;
    position = null;
  }
  function startWatch() {
    if (watch === undefined && navigator.geolocation) {
      watch = navigator.geolocation.watchPosition(({ coords }) => { position = { lat:coords.latitude, lng:coords.longitude }; },
        () => { position = null; },{ enableHighAccuracy:true, maximumAge:15000, timeout:12000 });
    }
  }
  function presenceButton() {
    const button = $('[data-availability]');
    if (!button) return;
    button.textContent = online ? 'Ficar indisponível' : 'Ficar disponível';
    button.setAttribute('aria-pressed',online);
    button.disabled = availabilityChange;
    $('#availability-status').textContent = online ? 'Disponível' : 'Indisponível';
    $('#availability-status').className = 'status ' + (online ? 'status-delivered' : 'status-cancelled');
  }

  function updateRegion(id, markup, force) {
    const element = $('#' + id);
    if (!element || element.innerHTML === markup) return;
    if (!force && element.contains(document.activeElement)) return;
    element.innerHTML = markup;
  }

  async function refresh(force = false) {
    if (refreshing && !force) return;
    const user = context.user;
    if (!allowed(user)) return;
    const revision = ++sequence;
    refreshing = true;
    try {
      if (page === 'entregador' && online && position && Date.now() - heartbeat > 25000) {
        await command('presence',{ online:true, ...position });
        heartbeat = Date.now();
      }
      const [orders, stores, couriers, offers] = await Promise.all([
        page === 'admin' ? Promise.resolve([]) : command('orders',{ view:config.role }),
        page === 'entregador' ? Promise.resolve([]) : command('managed_stores'),
        page === 'admin' ? command('couriers') : Promise.resolve([]),
        page === 'entregador' && online ? command('offers') : Promise.resolve([])
      ]);
      if (revision !== sequence || context.user !== user) return;
      const orderTitle = page === 'entregador' ? 'Minhas entregas' : 'Pedidos da operação';
      updateRegion('ops-orders','<div class="section-head"><h2>' + orderTitle + '</h2></div>' +
        (orders.length ? '<div class="order-grid">' + orders.map(order => orderCard(order,
          courierActions(order),
          { address:page !== 'entregador' || order.status !== 'delivered' })).join('') + '</div>' :
          '<div class="panel">' + empty('Nenhum pedido por aqui','Os pedidos aparecerão nesta área.') + '</div>'),force);
      if (page === 'entregador') {
        updateRegion('ops-offers','<div class="section-head"><h2>Ofertas disponíveis</h2></div>' +
          (offers.length ? '<div class="order-grid">' + offers.map(order => orderCard(order,
            transitionButton(order,'assigned','Aceitar entrega'),{ offer:true })).join('') + '</div>' : '<div class="panel">' +
            empty('Nenhuma oferta no momento',online ? 'Mantenha o aplicativo aberto e a localização ativa.' :
              'Fique disponível com o GPS para receber ofertas.','bike') + '</div>'),force);
      } else {
        storeList = stores;
        updateRegion('ops-stores','<div class="section-head"><h2>' + (page === 'admin' ? 'Estabelecimentos' : 'Minhas lojas') + '</h2>' +
          (page === 'admin' ? '<button class="btn primary" data-add-store>' + icon('plus') + ' Nova loja</button>' : '') + '</div>' +
          (stores.length ? '<div class="management-grid">' + stores.map(store => storeMarkup(store,user.role)).join('') + '</div>' :
            '<div class="panel">' + empty('Nenhuma loja cadastrada',page === 'admin' ? 'Cadastre o primeiro estabelecimento.' :
              'O administrador pode vincular uma loja a esta conta.','store') + '</div>'),force);
      }
      if (page === 'admin') {
        updateRegion('ops-couriers','<div class="section-head"><h2>Entregadores</h2><button class="btn primary" data-add-courier>' +
          icon('plus') + ' Novo entregador</button></div><div class="panel">' + (couriers.length ? couriers.map(courier =>
            '<div class="cart-row"><strong>' + esc(courier.login || 'Acesso anterior') + '</strong></div>').join('') :
            empty('Nenhum entregador habilitado','Cadastre um entregador para liberar o acesso às ofertas.','bike')) + '</div>',force);
      }
      $('#ops-error').textContent = '';
    } catch (error) {
      if (revision === sequence && $('#ops-error')) $('#ops-error').textContent = error.message;
    } finally {
      if (revision === sequence) refreshing = false;
    }
  }

  async function toggleAvailability() {
    if (availabilityChange) return;
    availabilityChange = true;
    presenceButton();
    try {
      if (online) {
        await command('presence',{ online:false });
        stopWatch();
        online = false;
      } else {
        const point = await geo();
        await command('presence',{ online:true, ...point });
        position = point;
        heartbeat = Date.now();
        online = true;
        startWatch();
      }
      document.activeElement?.blur();
      await refresh(true);
    } catch (error) { toast(error.message); }
    finally { availabilityChange = false; presenceButton(); }
  }

  function render() {
    clearInterval(timer);
    sequence++;
    refreshing = false;
    const user = context.user;
    if (owner !== user?.id) {
      stopWatch();
      onlineKnown = false;
      owner = user?.id;
    }
    main.innerHTML = '<div class="wrap page ops"><div class="ops-heading"><div class="ops-mark">' + icon(config.symbol) +
      '</div><div><span class="overline accent">' + config.label + '</span><h1>' + config.title + '</h1><p>' +
      config.intro + '</p></div></div><div id="ops-body"></div></div>';
    const body = $('#ops-body');
    if (!allowed(user)) {
      body.innerHTML = '<div class="panel">' + empty(user ? 'Acesso restrito' : 'Entre para continuar',
        user ? 'Seu perfil não tem acesso a esta área.' : 'Use sua conta Fly Delivery para acessar este painel.',config.symbol) +
        (user ? '<button class="btn outline" data-switch-account>Trocar de conta</button>' : '<button class="btn primary" data-signin>Entrar</button>') + '</div>';
      return;
    }
    body.innerHTML = '<p class="form-error" id="ops-error" role="alert"></p>' +
      (page === 'entregador' ? '<div class="panel presence"><div><h2>Disponibilidade</h2><span id="availability-status" class="status"></span></div>' +
        '<button class="btn primary" data-availability></button></div><section id="ops-offers"></section>' :
        '<section id="ops-stores"></section>' + (page === 'admin' ? '<section id="ops-couriers"></section>' : '')) +
      (page === 'admin' ? '' : '<section id="ops-orders"><p class="muted">Carregando pedidos…</p></section>');
    if (page === 'entregador') {
      if (!onlineKnown) {
        online = user.online;
        onlineKnown = true;
        if (online) startWatch();
      }
      presenceButton();
      $('[data-availability]').onclick = toggleAvailability;
      bindTransitions($('#ops-offers'),() => refresh(true),() => refresh(true));
    }
    if (page !== 'admin') bindTransitions($('#ops-orders'),() => refresh(true),() => refresh(true));
    const done = () => refresh(true);
    body.addEventListener('click',async event => {
      const button = event.target.closest('button');
      if (!button || button.disabled) return;
      const { addStore,linkStore,settings,addProduct,editProduct,store,open,addCourier } = button.dataset;
      const byId = id => storeList.find(candidate => candidate.id === id);
      if (addStore !== undefined || linkStore) registrationForm('store',done,byId(linkStore));
      if (settings) storeSettings(byId(settings),done);
      if (addProduct) productForm(byId(addProduct),null,done);
      if (editProduct) productForm(byId(store),byId(store).products.find(product => product.id === editProduct),done);
      if (addCourier !== undefined) registrationForm('courier',done);
      if (!open) return;
      button.disabled = true;
      try {
        await command('set_open',{ store_id:open,open:!byId(open).is_open });
        await done();
      } catch (error) { toast(error.message); }
      finally { button.disabled = false; }
    });
    refresh(true);
    timer = setInterval(() => { if (!document.hidden) refresh(); },6000);
  }
  return { render };
}
