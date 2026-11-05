import { mapPicker } from './google-map.js';
import { $, main, esc, icon, money, api, command, modal, toast, bindSubmit, geo,
  categories, empty, orderCard, transitionButton, bindTransitions } from './shared.js';

const profiles = {
  loja:{ role:'merchant', title:'Painel da loja', label:'ESTABELECIMENTO', symbol:'store', intro:'Organize seu cardápio e acompanhe o preparo dos pedidos.' },
  entregador:{ role:'courier', title:'Entregas', label:'ENTREGADOR', symbol:'bike', intro:'Fique disponível para receber entregas próximas e acompanhe sua próxima retirada.' },
  admin:{ role:'admin', title:'Administração', label:'GESTÃO FLY DELIVERY', symbol:'shield', intro:'Cadastre lojas, habilite entregadores e acompanhe a operação.' }
};
const mapsLink = (lat, lng, label) => '<a class="btn outline" href="https://www.google.com/maps/dir/?api=1&amp;destination=' +
  encodeURIComponent(lat + ',' + lng) + '" target="_blank" rel="noopener noreferrer">' + icon('pin') + ' ' + esc(label) + '</a>';
const formEnd = label => '<p class="form-error" data-form-error role="alert"></p><button class="btn primary wide" type="submit">' + esc(label) + '</button>';

function showRegistration(result, page, message) {
  if (!result.activationToken) {
    toast(result.activationPending ? 'Cadastro salvo. Edite o cadastro para tentar gerar o link novamente.' : message);
    return;
  }
  const url = location.origin + '/' + page + '/#ativar=' + encodeURIComponent(result.activationToken);
  const el = modal('Link de ativação',
    '<div class="form-stack"><label>Link individual<input id="activation-link" readonly value="' + esc(url) +
    '"></label><button class="btn primary" data-copy-link>Copiar link</button></div>',
    message + ' Compartilhe este link em particular com o titular da conta para que ele defina a senha.');
  $('[data-copy-link]',el).onclick = async () => {
    const field = $('#activation-link',el);
    field.select();
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copiado.');
    } catch {
      toast('Selecione e copie o link exibido.');
    }
  };
}

function storeForm(store, done) {
  const requestId = crypto.randomUUID();
  let selected = store ? { lat:store.lat, lng:store.lng } : null;
  let map;
  const el = modal(store ? 'Editar estabelecimento' : 'Cadastrar estabelecimento',
    '<form class="form-stack" id="store-form"><div class="fields-two"><label>Nome da loja<input name="name" required minlength="2" maxlength="80" value="' +
    esc(store?.name) + '"></label><label>Categoria<select name="category">' + categories.slice(1).map(([name]) =>
      '<option' + (name === store?.category ? ' selected' : '') + '>' + esc(name) + '</option>').join('') + '</select></label></div>' +
    '<label>E-mail do responsável<input name="owner_email" type="email" required maxlength="254" value="' + esc(store?.owner_email) +
    '" placeholder="E-mail usado para acessar a loja"></label><label>Descrição<textarea name="description" rows="2" maxlength="260">' +
    esc(store?.description) + '</textarea></label><label>Endereço de retirada<input name="address" required minlength="5" maxlength="240" value="' +
    esc(store?.address) + '"></label><div class="fields-three"><label>Taxa (R$)<input name="fee" type="number" step="0.01" min="0" max="1000" required value="' +
    (store ? store.fee / 100 : '5.90') + '"></label><label>Raio (km)<input name="delivery_radius" type="number" min="1" max="50" required value="' +
    (store?.delivery_radius ?? 8) + '"></label><label>Prazo (min)<input name="eta" type="number" min="5" max="180" required value="' +
    (store?.eta ?? 30) + '"></label></div><p class="map-help">Marque o ponto de retirada no mapa.</p><div class="map" id="store-map"></div>' +
    '<div class="map-actions"><button class="btn outline" type="button" data-gps>' + icon('location') +
    ' Usar GPS</button><span class="muted" id="store-point">Aguardando localização</span></div>' +
    '<details class="map-coordinates"><summary>Informar coordenadas</summary><div class="fields-two">' +
    '<label>Latitude<input id="store-lat" inputmode="decimal" placeholder="-19.9235"></label>' +
    '<label>Longitude<input id="store-lng" inputmode="decimal" placeholder="-43.9381"></label></div>' +
    '<button class="btn outline" type="button" data-set-coordinates>Usar coordenadas</button></details>' +
    '<label class="check"><input name="active" type="checkbox"' +
    (store?.active ? ' checked' : '') + '> Publicar no catálogo</label>' + formEnd('Salvar estabelecimento') + '</form>');
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
  bindSubmit($('#store-form',el), async data => {
    if (!selected) throw new Error('Selecione o ponto de retirada no mapa, use o GPS ou informe as coordenadas.');
    const fields = Object.fromEntries(data);
    const result = await api('provision', {
      ...fields, kind:'store', id:store?.id, request_id:requestId, fee:Math.round(Number(fields.fee)*100),
      delivery_radius:Number(fields.delivery_radius), eta:Number(fields.eta),
      active:data.has('active'), lat:selected.lat, lng:selected.lng
    });
    el.close();
    showRegistration(result,'loja','Estabelecimento salvo.');
    await done();
  });
}

function productForm(store, product, done) {
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

function courierForm(done, email = '') {
  const el = modal('Cadastrar entregador',
    '<form class="form-stack" id="courier-form"><label>E-mail do entregador<input name="email" type="email" required maxlength="254" value="' +
    esc(email) + '" placeholder="E-mail usado para acessar o app"></label>' + formEnd('Salvar entregador') + '</form>');
  bindSubmit($('#courier-form',el), async data => {
    const result = await api('provision',{ kind:'courier',email:data.get('email') });
    el.close();
    showRegistration(result,'entregador','Entregador cadastrado.');
    await done();
  });
}

function storeMarkup(store, role) {
  const admin = role === 'admin';
  const actions = '<button class="btn outline" data-open="' + esc(store.id) + '">' + (store.is_open ? 'Fechar para pedidos' : 'Abrir para pedidos') + '</button>' +
    (admin ? '<button class="btn outline" data-edit-store="' + esc(store.id) + '">Editar loja</button>' : '') +
    '<button class="btn primary" data-add-product="' + esc(store.id) + '">' + icon('plus') + ' Produto</button>';
  return '<article class="panel management-card"><div class="management-head"><div><span class="overline">' + esc(store.category) +
    '</span><h3>' + esc(store.name) + '</h3><p>' + esc(store.address) + (admin ? ' · ' + esc(store.owner_email) : '') + '</p></div><span class="status ' +
    (store.active && store.is_open ? 'status-delivered' : 'status-cancelled') + '">' +
    (store.active ? store.is_open ? 'Aberta' : 'Fechada' : 'Não publicada') + '</span></div>' +
    '<div class="order-actions">' + actions + '</div><div class="menu-admin">' + (store.products.length ? store.products.map(product =>
      '<div class="menu-admin-row">' + (product.image ? '<img src="' + esc(product.image) + '" alt="">' : '<span class="product-placeholder">' + icon('bag') + '</span>') +
      '<div><strong>' + esc(product.name) + '</strong><p>' + money(product.price) + ' · ' + (product.active ? 'Disponível' : 'Pausado') +
      '</p></div><button class="btn outline" data-edit-product="' + esc(product.id) + '" data-store="' + esc(store.id) + '">Editar</button></div>').join('') :
      '<p class="muted">Nenhum produto cadastrado.</p>') + '</div></article>';
}

function merchantActions(order) {
  return (order.status === 'placed' ? transitionButton(order,'preparing','Confirmar e preparar') : '') +
    (order.status === 'preparing' ? transitionButton(order,'ready','Pedido pronto · chamar motoboy') : '') +
    (['placed','preparing','ready'].includes(order.status) ? transitionButton(order,'cancelled','Cancelar','outline') : '');
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
        command('orders',{ view:config.role }),
        page === 'entregador' ? Promise.resolve([]) : command('managed_stores'),
        page === 'admin' ? command('couriers') : Promise.resolve([]),
        page === 'entregador' && online ? command('offers') : Promise.resolve([])
      ]);
      if (revision !== sequence || context.user !== user) return;
      const orderTitle = page === 'entregador' ? 'Minhas entregas' : 'Pedidos da operação';
      updateRegion('ops-orders','<div class="section-head"><h2>' + orderTitle + '</h2></div>' +
        (orders.length ? '<div class="order-grid">' + orders.map(order => orderCard(order,
          page === 'entregador' ? courierActions(order) : merchantActions(order),
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
            '<div class="cart-row"><div><strong>' + esc(courier.email) + '</strong><p>' + (courier.online ? 'Disponível' : 'Indisponível') +
            '</p></div><div class="order-actions"><button class="btn outline" data-edit-courier="' + esc(courier.email) +
            '">Acesso</button><button class="btn outline" data-disable="' + esc(courier.email) + '">Desabilitar</button></div></div>').join('') :
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
      '<section id="ops-orders"><p class="muted">Carregando pedidos…</p></section>';
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
    bindTransitions($('#ops-orders'),() => refresh(true),() => refresh(true));
    const done = () => refresh(true);
    body.addEventListener('click',async event => {
      const button = event.target.closest('button');
      if (!button || button.disabled) return;
      const { addStore,editStore,addProduct,editProduct,store,open,addCourier,editCourier,disable } = button.dataset;
      const byId = id => storeList.find(candidate => candidate.id === id);
      if (addStore !== undefined) storeForm(null,done);
      if (editStore) storeForm(byId(editStore),done);
      if (addProduct) productForm(byId(addProduct),null,done);
      if (editProduct) productForm(byId(store),byId(store).products.find(product => product.id === editProduct),done);
      if (addCourier !== undefined || editCourier) courierForm(done,editCourier);
      if (!open && !disable) return;
      if (disable && !window.confirm('Desabilitar este entregador?')) return;
      button.disabled = true;
      try {
        if (open) await command('set_open',{ store_id:open, open:!byId(open).is_open });
        if (disable) await command('set_courier',{ email:disable, enabled:false });
        await done();
      } catch (error) { toast(error.message); }
      finally { button.disabled = false; }
    });
    refresh(true);
    timer = setInterval(() => { if (!document.hidden) refresh(); },6000);
  }
  return { render };
}
