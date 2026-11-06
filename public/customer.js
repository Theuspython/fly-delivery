import { $, main, esc, icon, money, api, command, modal, toast, bindSubmit,
  categories, fallbackImages, empty, orderCard, transitionButton, bindTransitions, payments, statuses } from './shared.js';

function stored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
const normalize = value => value.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
const imageFor = (store, product) => product?.image || fallbackImages[store.category] || '/assets/bowl.webp';
const storeCategories = store => store.categories ?? [store.category];
const storePhoto = store => store.image || imageFor(store,store.products.find(product => product.image));

export function customer(context) {
  let stores = [];
  let loaded = false;
  let error;
  let loading;
  let category = 'Todas';
  let search = '';
  const cartKey = 'fd-cart:' + context.user.id;
  const requestKey = 'fd-request:' + context.user.id;
  let cart = stored(cartKey, { store:null, items:{} });
  let address = null;
  let primaryAddress = null;
  let addressLoaded = false;
  let addressError;
  let addressLoading;
  let usePrimary = true;
  let active = true;
  let payment = 'pix_delivery';
  let requestId = stored(requestKey, null);
  let ordersTimer;
  let orderStream;
  let previousView;
  let drawer;
  let openOrderId = null;
  const route = () => location.hash.slice(1) || 'inicio';

  function closeMenu() {
    if (drawer?.open) drawer.close();
  }

  function openMenu() {
    if (!drawer) {
      drawer = document.createElement('dialog');
      drawer.id = 'customer-navigation';
      drawer.className = 'merchant-drawer';
      drawer.setAttribute('aria-labelledby','customer-menu-title');
      document.body.append(drawer);
      drawer.addEventListener('click',event => {
        if (event.target === drawer || event.target.closest('[data-close-menu]') || event.target.closest('a')) closeMenu();
      });
      drawer.addEventListener('close',() => $('[data-customer-menu]')?.setAttribute('aria-expanded','false'));
    }
    drawer.innerHTML = '<div class="dialog-head"><div><span class="overline accent">FLY DELIVERY</span><h2 id="customer-menu-title">Cliente</h2></div>' +
      '<button class="icon-button" data-close-menu aria-label="Fechar menu">' + icon('close') + '</button></div>' +
      '<nav aria-label="Áreas do cliente">' + [['pedidos','Pedidos','bag'],['enderecos','Endereços','pin']].map(([key,label,symbol]) =>
        '<a href="#' + key + '"' + (route() === key ? ' aria-current="page"' : '') + '>' + icon(symbol) + label + '</a>').join('') + '</nav>';
    drawer.showModal();
    $('[data-customer-menu]')?.setAttribute('aria-expanded','true');
  }

  function updateHeader() {
    $('#cart-count').textContent = Object.values(cart.items).reduce((sum, amount) => sum + amount, 0);
  }

  async function loadCatalog() {
    if (loading) return loading;
    loading = api('catalog').then(list => {
      stores = list;
      error = null;
      loaded = true;
    }).catch(err => { error = err.message; }).finally(() => { loading = null; });
    return loading;
  }

  async function loadPrimaryAddress() {
    if (addressLoading) return addressLoading;
    addressLoading = command('customer_address').then(value => {
      if (!active) return;
      primaryAddress = value;
      addressError = null;
    }).catch(error => { if (active) addressError = error.message; }).finally(() => {
      addressLoaded = true;
      addressLoading = null;
    });
    return addressLoading;
  }

  const deliveryAddress = () => usePrimary ? primaryAddress : address;
  function resetRequest() {
    requestId = null;
    localStorage.removeItem(requestKey);
  }

  function alignCategories(smooth = true) {
    const list = $('#categories');
    const selected = list?.querySelector('[aria-pressed=true]');
    if (!selected) return;
    const last = list.querySelector('.chip:last-child');
    list.style.setProperty('--category-tail',Math.max(0,list.clientWidth - last.offsetWidth - 15) + 'px');
    const left = selected.getBoundingClientRect().left - list.getBoundingClientRect().left + list.scrollLeft - 3;
    list.scrollTo({ left:category === 'Todas' ? 0 : Math.max(0,left),
      behavior:smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' });
  }
  const resizeCategories = () => alignCategories(false);
  window.addEventListener('resize',resizeCategories);

  function saveCart() {
    resetRequest();
    localStorage.setItem(cartKey, JSON.stringify(cart));
    updateHeader();
  }

  function setItem(store, product, increment) {
    if (increment < 0 && (cart.store !== store.id || !cart.items[product.id])) return;
    if (cart.store && cart.store !== store.id) {
      if (!window.confirm('Você tem itens de outra loja. Deseja começar um novo carrinho?')) return;
      cart = { store:store.id, items:{} };
      address = null;
      usePrimary = true;
    }
    const quantity = (cart.items[product.id] ?? 0) + increment;
    if (quantity > 25) return toast('Você pode adicionar até 25 unidades por item.');
    if (quantity > 0) {
      if (!cart.items[product.id] && Object.keys(cart.items).length >= 30) return toast('Seu carrinho já tem 30 tipos de item.');
      cart.store = store.id;
      cart.items[product.id] = quantity;
    } else delete cart.items[product.id];
    if (!Object.keys(cart.items).length) { cart.store = null; address = null; usePrimary = true; }
    saveCart();
    if (route().startsWith('loja/')) syncProductQuantities(store);
    else render();
    if (increment > 0 && route().startsWith('loja/')) toast(product.name + ' no carrinho.');
  }

  function storeCard(store, index) {
    return '<a class="restaurant-card" href="#loja/' + esc(store.id) + '"><div class="restaurant-photo"><img src="' +
      esc(storePhoto(store)) + '" alt="" loading="' + (index === 0 ? 'eager' : 'lazy') +
      '"><span class="photo-tag">' + esc(storeCategories(store).join(' · ')) + '</span>' + (!store.is_open ? '<span class="closed-tag">Fechado</span>' : '') +
      '</div><div class="restaurant-content"><div><h3>' + esc(store.name) + '</h3><span class="restaurant-arrow">' + icon('arrow') +
      '</span></div><p>' + esc(store.description) + '</p><div class="restaurant-meta"><span>' + icon('clock') + ' ' + store.eta +
      ' min</span><span>' + icon('bike') + ' ' + (store.fee ? money(store.fee) : 'Entrega grátis') + '</span></div></div></a>';
  }

  function catalogGrid() {
    const results = $('#results');
    const count = $('#results-count');
    if (!results) return;
    const matches = stores.filter(store => (category === 'Todas' || storeCategories(store).includes(category)) &&
      normalize([store.name,...storeCategories(store),...store.products.map(p => p.name)].join(' ')).includes(normalize(search.trim())));
    count.textContent = loaded ? matches.length + (matches.length === 1 ? ' estabelecimento' : ' estabelecimentos') : '';
    if (error) {
      results.innerHTML = empty('Catálogo indisponível', error, 'store') + '<button class="btn outline" id="retry">Tentar novamente</button>';
      $('#retry').onclick = async () => { await loadCatalog(); render(); };
    } else if (!loaded) results.innerHTML = '<p class="muted">Carregando estabelecimentos…</p>';
    else if (!matches.length) results.innerHTML = stores.length ? empty('Nenhum resultado','Experimente outro termo ou categoria.','search') : empty('Estabelecimentos em breve','As lojas cadastradas aparecerão aqui assim que forem publicadas.','store');
    else results.innerHTML = '<div class="restaurants">' + matches.map(storeCard).join('') + '</div>';
  }

  function home(view) {
    main.innerHTML = '<div class="wrap home"><section class="hero" aria-labelledby="hero-title"><div class="hero-photo"></div>' +
      '<div class="hero-copy"><span class="hero-kicker"><span></span> DELIVERY DO SEU BAIRRO</span>' +
      '<h1 id="hero-title">A fome chama.<br><em>A gente leva.</em></h1><p>Descubra os melhores sabores da sua região e receba seus favoritos onde estiver.</p>' +
      '<a class="btn hero-cta" href="#lojas">Explorar estabelecimentos ' + icon('arrow') + '</a></div>' +
      '<div class="hero-stamp" aria-hidden="true">' + icon('bike') + '<span>DEU FOME?<br><strong>VAI DE FLY.</strong></span></div></section>' +
      '<section class="browse" aria-labelledby="categories-title"><div class="section-head"><div><span class="overline accent">BATEU AQUELA VONTADE?</span>' +
      '<h2 id="categories-title">O que vamos comer?</h2></div><label class="search-field">' + icon('search') +
      '<input id="search" type="search" value="' + esc(search) + '" placeholder="Busque loja ou prato" aria-label="Busque loja ou prato"></label></div>' +
      '<div id="categories" class="chips" aria-label="Filtrar categoria">' + categories.map(([label, symbol]) =>
        '<button class="chip" data-category="' + esc(label) + '" aria-pressed="' + (label === category) + '">' + icon(symbol) + ' ' +
        esc(label) + '</button>').join('') + '</div></section>' +
      '<section id="restaurants" class="catalog" aria-labelledby="catalog-title"><div class="section-head"><div><span class="overline accent">VITRINE FLY</span>' +
      '<h2 id="catalog-title">Estabelecimentos</h2></div><span class="muted" id="results-count"></span></div>' +
      '<div id="results"></div></section></div>';
    $('.hero-cta').onclick = event => {
      if (route() !== 'lojas') return;
      event.preventDefault();
      $('.catalog').scrollIntoView({ behavior:'smooth' });
    };
    $('#search').oninput = event => { search = event.target.value; catalogGrid(); };
    $('#categories').onclick = event => {
      const button = event.target.closest('[data-category]');
      if (!button) return;
      category = button.dataset.category;
      for (const chip of $('#categories').children) chip.setAttribute('aria-pressed', chip === button);
      catalogGrid();
      alignCategories();
    };
    catalogGrid();
    alignCategories(false);
    if (view === 'lojas' && previousView !== view) requestAnimationFrame(() => $('.catalog')?.scrollIntoView({ behavior:'smooth' }));
  }

  function storeView(store) {
    main.innerHTML = '<div class="wrap page"><a class="back-link" href="#lojas">' + icon('back') + ' Estabelecimentos</a>' +
      '<section class="store-banner"><img src="' + esc(storePhoto(store)) +
      '" alt=""><div><span class="photo-tag">' + esc(storeCategories(store).join(' · ')) + '</span><h1>' + esc(store.name) + '</h1><p>' + esc(store.description) +
      '</p><div class="restaurant-meta"><span>' + icon('clock') + ' ' + store.eta + ' min</span><span>' + icon('bike') + ' ' +
      (store.fee ? money(store.fee) : 'Entrega grátis') + '</span></div></div></section>' +
      (!store.is_open ? '<p class="pilot-label">Esta loja está fechada.</p>' : '') +
      '<div class="section-head menu-head"><h2>Cardápio</h2><a class="btn outline" href="#carrinho">' + icon('bag') + ' Ver carrinho</a></div>' +
      '<div class="products">' + (store.products.length ? store.products.map(product =>
        '<article class="product" data-menu-product="' + esc(product.id) + '"><div class="product-content"><div><h3>' + esc(product.name) + '</h3><p>' + esc(product.description) + '</p><strong>' +
        money(product.price) + '</strong></div>' + (product.image ? '<img src="' + esc(product.image) + '" alt="" loading="lazy">' : '') +
        '</div><div class="product-quantity"><button class="icon-button" data-product="' + esc(product.id) + '" data-menu-delta="-1" aria-label="Diminuir ' + esc(product.name) + '">' +
        icon('minus') + '</button><span><output aria-label="Quantidade de ' + esc(product.name) + '" data-product-quantity>0</output> no carrinho</span>' +
        '<button class="icon-button add-product" data-product="' + esc(product.id) + '" data-menu-delta="1" aria-label="Adicionar ' + esc(product.name) + '">' +
        icon('plus') + '</button></div></article>').join('') :
        empty('Cardápio em breve','A loja está preparando os primeiros produtos.','store')) + '</div></div>';
    $('.products').onclick = event => {
      const button = event.target.closest('[data-product]');
      if (button) setItem(store,store.products.find(product => product.id === button.dataset.product),Number(button.dataset.menuDelta));
    };
    syncProductQuantities(store);
  }

  function syncProductQuantities(store) {
    for (const card of document.querySelectorAll('[data-menu-product]')) {
      const quantity = cart.store === store.id ? cart.items[card.dataset.menuProduct] ?? 0 : 0;
      $('[data-product-quantity]',card).textContent = quantity;
      $('[data-menu-delta="-1"]',card).disabled = quantity === 0;
      $('[data-menu-delta="1"]',card).disabled = !store.is_open || quantity >= 25;
    }
  }

  function addressDialog(asPrimary = false) {
    if (!asPrimary && (route() !== 'carrinho' || !cart.store || !Object.keys(cart.items).length)) return;
    const current = asPrimary ? primaryAddress : address;
    const el = modal(asPrimary ? 'Endereço principal' : 'Endereço desta entrega',
      '<form class="form-stack" id="address-form"><label>Rua<input name="street" autocomplete="address-line1" minlength="2" maxlength="120" required value="' +
      esc(current?.street) + '" placeholder="Nome da rua"></label><div class="address-fields"><label>Número<input name="number" maxlength="20" required value="' +
      esc(current?.number) + '" placeholder="Ex. 110 ou S/N"></label><label>Bairro<input name="neighborhood" autocomplete="address-level3" minlength="2" maxlength="80" required value="' +
      esc(current?.neighborhood) + '" placeholder="Nome do bairro"></label></div>' +
      (asPrimary ? '<p class="muted">Este endereço ficará salvo na sua conta para os próximos pedidos.</p>' :
        '<label class="check"><input type="checkbox" name="save_primary"> Salvar como endereço principal</label>') +
      '<p class="form-error" data-form-error role="alert"></p><button class="btn primary wide" type="submit">' +
      (asPrimary ? 'Salvar endereço principal' : 'Usar nesta entrega') + '</button></form>');
    bindSubmit($('#address-form',el), async fields => {
      const value = Object.fromEntries(['street','number','neighborhood'].map(key => [key,String(fields.get(key) ?? '').trim()]));
      if (value.street.length < 2 || !value.number || value.neighborhood.length < 2) throw new Error('Preencha rua, número e bairro.');
      value.text = value.street + ', ' + value.number + ' - ' + value.neighborhood;
      const savePrimary = asPrimary || fields.has('save_primary');
      if (savePrimary) {
        await addressLoading;
        if (!active) return;
        const saved = await command('save_customer_address',value);
        if (!active) return;
        primaryAddress = saved;
        addressLoaded = true;
        addressError = null;
      }
      if (route() === 'carrinho') {
        usePrimary = savePrimary;
        if (!savePrimary) address = value;
      }
      resetRequest();
      el.close();
      render();
      if (savePrimary) toast('Endereço principal salvo.');
    });
  }

  function addressView() {
    main.innerHTML = '<div class="wrap page customer-address-page"><a class="back-link" href="#lojas">' + icon('back') +
      ' Voltar à vitrine</a><span class="overline accent">SUA CONTA</span><h1>Endereços</h1><section class="panel">' +
      (!addressLoaded ? '<p class="muted">Carregando endereço…</p>' : addressError ?
        '<p class="form-error" role="alert">' + esc(addressError) + '</p><button class="btn outline" data-retry-address>Tentar novamente</button>' :
        '<div class="section-head"><h2>Endereço principal</h2>' + icon('pin') + '</div>' + (primaryAddress ?
        '<p class="saved-address">' + esc(primaryAddress.street) + ', ' + esc(primaryAddress.number) + '<br>' + esc(primaryAddress.neighborhood) + '</p>' :
        '<p class="muted saved-address">Cadastre rua, número e bairro para usar nos próximos pedidos.</p>') +
        '<button class="btn primary" data-save-address>' + (primaryAddress ? 'Editar endereço' : 'Cadastrar endereço') + '</button>') + '</section></div>';
    if ($('[data-save-address]')) $('[data-save-address]').onclick = () => addressDialog(true);
    if ($('[data-retry-address]')) $('[data-retry-address]').onclick = async () => { await loadPrimaryAddress(); render(); };
  }

  function deliveryAddressMarkup() {
    const chosen = deliveryAddress();
    return '<fieldset class="delivery-address-options"><legend>Endereço de entrega</legend>' +
      (primaryAddress ? '<label><input type="radio" name="delivery_address" value="primary"' + (usePrimary ? ' checked' : '') +
        '><span><strong>Endereço principal</strong><small>' + esc(primaryAddress.text) + '</small></span></label>' : '') +
      '<label><input type="radio" name="delivery_address" value="new"' + (!usePrimary || !primaryAddress ? ' checked' : '') +
      '><span><strong>' + (primaryAddress ? 'Outro endereço' : 'Digitar endereço') + '</strong><small>Rua, número e bairro desta entrega</small></span></label></fieldset>' +
      (!addressLoaded ? '<p class="muted">Buscando endereço principal…</p>' : addressError ?
        '<p class="form-error" role="alert">Não foi possível carregar seu endereço salvo. Você pode digitar outro.</p><button type="button" class="text-button" data-retry-address>Tentar novamente</button>' : '') +
      '<button type="button" class="address-summary" data-address>' + icon('pin') + '<span>' +
      esc(chosen?.text || 'Informar rua, número e bairro') + '</span>' + icon('arrow') + '</button>';
  }

  function cartView() {
    const store = stores.find(candidate => candidate.id === cart.store);
    const products = store?.products.filter(product => cart.items[product.id]) ?? [];
    const subtotal = products.reduce((sum,p) => sum + p.price * cart.items[p.id],0);
    const missing = Object.keys(cart.items).length > products.length;
    main.innerHTML = '<div class="wrap page"><a class="back-link" href="' + (store ? '#loja/' + esc(store.id) : '#lojas') + '">' +
      icon('back') + ' Continuar explorando</a><span class="overline accent">SEU PEDIDO</span><h1>Meu carrinho</h1>' +
      (!products.length ? '<div class="panel">' + empty('Seu carrinho está vazio', missing ? 'Os itens anteriores não estão mais disponíveis.' : 'Encontre algo gostoso no cardápio.') +
        (missing ? '<button class="btn outline" data-clear>Limpar carrinho</button>' : '') + '</div>' :
        '<div class="split"><section class="panel"><h2>' + esc(store.name) + '</h2><div class="cart-items">' + products.map(product =>
          '<div class="cart-row"><div><strong>' + esc(product.name) + '</strong><p>' + money(product.price) + ' por unidade</p></div>' +
          '<div class="stepper"><button class="icon-button" data-id="' + esc(product.id) + '" data-delta="-1" aria-label="Diminuir ' +
          esc(product.name) + '">' + icon('minus') + '</button><b>' + cart.items[product.id] + '</b><button class="icon-button" data-id="' +
          esc(product.id) + '" data-delta="1" aria-label="Aumentar ' + esc(product.name) + '">' + icon('plus') + '</button></div></div>').join('') +
          '</div>' + (missing ? '<p class="pilot-label">Itens indisponíveis serão removidos deste pedido.</p>' : '') + '</section>' +
          '<section class="panel"><h2>Entrega e pagamento</h2>' + deliveryAddressMarkup() + '<form class="form-stack" id="checkout">' +
          '<label>Forma de pagamento<select name="payment">' + Object.entries(payments).map(([key,value]) =>
            '<option value="' + key + '"' + (key === payment ? ' selected' : '') + '>' + value + '</option>').join('') + '</select></label>' +
          '<p class="muted">O pagamento é combinado com a loja e realizado na entrega.</p>' +
          '<div class="total-line"><span>Produtos</span><strong>' + money(subtotal) + '</strong></div>' +
          '<div class="total-line"><span>Entrega</span><strong>' + money(store.fee) + '</strong></div>' +
          '<div class="total-line total"><span>Total</span><strong>' + money(subtotal + store.fee) + '</strong></div>' +
          '<p class="form-error" data-form-error role="alert"></p>' +
          '<button class="btn primary wide" type="submit"' + (!store.is_open ? ' disabled' : '') + '>' +
          (store.is_open ? 'Confirmar pedido' : 'Loja fechada') + '</button></form></section></div>') + '</div>';
    if ($('[data-clear]')) $('[data-clear]').onclick = () => { cart = { store:null,items:{} }; saveCart(); render(); };
    if (!products.length) return;
    $('.cart-items').onclick = event => {
      const button = event.target.closest('[data-delta]');
      if (button) setItem(store,products.find(product => product.id === button.dataset.id),Number(button.dataset.delta));
    };
    $('[data-address]').onclick = () => addressDialog(usePrimary && Boolean(primaryAddress));
    for (const input of document.querySelectorAll('[name=delivery_address]')) input.onchange = () => {
      usePrimary = input.value === 'primary';
      resetRequest();
      render();
      if (!usePrimary && !address) addressDialog();
    };
    if ($('[data-retry-address]')) $('[data-retry-address]').onclick = async () => { await loadPrimaryAddress(); render(); };
    $('select[name=payment]').onchange = event => {
      payment = event.target.value;
    };
    bindSubmit($('#checkout'), async fields => {
      const chosen = deliveryAddress();
      if (!chosen) return addressDialog();
      if (!context.user) return context.signIn();
      requestId ??= crypto.randomUUID();
      localStorage.setItem(requestKey,JSON.stringify(requestId));
      try {
        await command('place', { store_id:store.id, request_id:requestId, address:chosen.text,
          payment:fields.get('payment'), fee:store.fee, items:products.map(product => ({
            id:product.id, quantity:cart.items[product.id], price:product.price
          })) });
      } catch (err) {
        if (err.message.includes('mudaram') || err.message.includes('cardápio')) {
          await loadCatalog();
          render();
          toast(err.message);
          return;
        }
        throw err;
      }
      cart = { store:null,items:{} };
      address = null;
      usePrimary = true;
      saveCart();
      location.hash = 'pedidos';
      toast('Pedido enviado à loja.');
    });
  }

  function orderView() {
    main.innerHTML = '<div class="wrap page"><span class="overline accent">ACOMPANHAMENTO</span><h1>Meus pedidos</h1><div id="order-list">' +
      (context.user ? '<p class="muted">Carregando pedidos…</p>' :
        '<div class="panel">' + empty('Acompanhe seus pedidos','Entre para ver os pedidos em andamento e o histórico.') +
        '<button class="btn primary" data-signin>Entrar</button></div>') + '</div></div>';
    if (!context.user) return;
    const list = $('#order-list');
    let reading = false;
    let queued = false;
    let statusByOrder;
    async function refreshOrders() {
      if (reading) { queued = true; return; }
      reading = true;
      try {
        const orders = await command('orders',{ view:'customer' });
        if (!list.isConnected) return;
        if (statusByOrder) {
          const changed = orders.find(order => statusByOrder.has(order.id) && statusByOrder.get(order.id) !== order.status);
          if (changed) toast(changed.store + ' · ' + statuses[changed.status]);
        }
        statusByOrder = new Map(orders.map(order => [order.id,order.status]));
        if (openOrderId && !orders.some(order => order.id === openOrderId)) openOrderId = null;
        const markup = orders.length ? '<div class="order-grid customer-order-grid">' + orders.map(order => orderCard(order,
          order.status === 'placed' ? transitionButton(order,'cancelled','Cancelar pedido','outline') : '',{ address:true,timeline:true,progress:true,compact:true,customerView:true,expanded:order.id === openOrderId })).join('') +
          '</div>' : '<div class="panel">' + empty('Nenhum pedido ainda','Explore os cardápios para começar.') + '</div>';
        if (list.innerHTML !== markup) list.innerHTML = markup;
      } catch (err) {
        if (list.isConnected && !list.querySelector('.order-grid')) list.innerHTML = empty('Pedidos indisponíveis',err.message);
      } finally {
        reading = false;
        if (queued && list.isConnected) { queued = false; refreshOrders(); }
      }
    }
    list.addEventListener('click',event => {
      const toggle = event.target.closest('[data-toggle-order]');
      if (!toggle) return;
      openOrderId = openOrderId === toggle.dataset.toggleOrder ? null : toggle.dataset.toggleOrder;
      for (const button of list.querySelectorAll('[data-toggle-order]')) {
        const expanded = button.dataset.toggleOrder === openOrderId;
        button.setAttribute('aria-expanded',String(expanded));
        button.textContent = expanded ? 'Recolher' : 'Visualizar';
        button.setAttribute('aria-label',(expanded ? 'Recolher' : 'Visualizar') + ' pedido #' + button.dataset.toggleOrder.slice(0,8));
        document.getElementById(button.getAttribute('aria-controls')).hidden = !expanded;
      }
    });
    bindTransitions(list,refreshOrders);
    refreshOrders();
    orderStream = new EventSource('/api/order-updates');
    orderStream.addEventListener('orders',refreshOrders);
    ordersTimer = setInterval(async () => {
      await refreshOrders();
      if (list.isConnected && orderStream.readyState === EventSource.CLOSED) {
        orderStream = new EventSource('/api/order-updates');
        orderStream.addEventListener('orders',refreshOrders);
      }
    },15000);
  }

  function render() {
    if (!active) return;
    clearInterval(ordersTimer);
    orderStream?.close();
    const view = route();
    if (view !== previousView) openOrderId = null;
    if (view === 'pedidos') orderView();
    else if (view === 'enderecos') addressView();
    else if (view === 'carrinho' && loaded) cartView();
    else if (view.startsWith('loja/') && loaded) {
      const store = stores.find(candidate => candidate.id === view.slice(5));
      if (store) storeView(store);
      else main.innerHTML = '<div class="wrap page"><a class="back-link" href="#lojas">' + icon('back') +
        ' Estabelecimentos</a>' + empty('Loja indisponível','Confira as outras lojas da região.','store') + '</div>';
    } else home(view);
    if (previousView !== view && view !== 'lojas') window.scrollTo(0,0);
    previousView = view;
    updateHeader();
  }

  loadCatalog().then(() => render());
  loadPrimaryAddress().then(() => {
    if (active && !$('#dialog').open && ['carrinho','enderecos'].includes(route())) render();
  });
  async function refreshCatalog() {
    const view = route();
    if (!active || ['pedidos','enderecos'].includes(view) || $('#dialog').open) return;
    const before = JSON.stringify(stores);
    const hadError = Boolean(error);
    await loadCatalog();
    if (route() === view && !$('#dialog').open && (before !== JSON.stringify(stores) || hadError !== Boolean(error))) render();
  }
  window.addEventListener('hashchange',refreshCatalog);
  window.addEventListener('focus',refreshCatalog);
  function stop() {
    active = false;
    closeMenu();
    drawer?.remove();
    drawer = null;
    clearInterval(ordersTimer);
    orderStream?.close();
    window.removeEventListener('resize',resizeCategories);
    window.removeEventListener('hashchange',refreshCatalog);
    window.removeEventListener('focus',refreshCatalog);
  }
  return { render, stop, updateHeader, openMenu, closeMenu };
}
