import { $, main, esc, icon, money, api, command, modal, toast, bindSubmit,
  categories, sortCategories, fallbackImages, empty, orderCard, transitionButton, bindTransitions, payments, statuses } from './shared.js';
import { searchCatalog } from './catalog-search.js';

function stored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
const imageFor = (store, product) => product?.image || fallbackImages[store.category] || '/assets/bowl.webp';
const storeCategories = store => sortCategories(store.categories ?? [store.category]);
const storePhoto = store => store.image || imageFor(store,store.products.find(product => product.image));

export function customer(context) {
  let stores = [];
  let loaded = false;
  let error;
  let loading;
  let category = 'Todas';
  let search = '';
  let menuStore = null;
  let menuCategory = 'Todas';
  const optionDrafts = new Map();
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
        if (event.target.closest('[data-account]')) { closeMenu(); context.openAccount(); return; }
        if (event.target === drawer || event.target.closest('[data-close-menu]') || event.target.closest('a')) closeMenu();
      });
      drawer.addEventListener('close',() => $('[data-customer-menu]')?.setAttribute('aria-expanded','false'));
    }
    drawer.innerHTML = '<div class="dialog-head"><div><span class="overline accent">FLY DELIVERY</span><h2 id="customer-menu-title">Cliente</h2></div>' +
      '<button class="icon-button" data-close-menu aria-label="Fechar menu">' + icon('close') + '</button></div>' +
      '<nav aria-label="Áreas do cliente">' + [['pedidos','Pedidos','bag'],['enderecos','Endereços','pin']].map(([key,label,symbol]) =>
        '<a href="#' + key + '"' + (route() === key ? ' aria-current="page"' : '') + '>' + icon(symbol) + label + '</a>').join('') + '<button type="button" data-account>' + icon('person') + ' Minha conta</button></nav>';
    drawer.showModal();
    $('[data-customer-menu]')?.setAttribute('aria-expanded','true');
  }

  function goHome() {
    closeMenu();
    category = 'Todas';
    search = '';
    if (route() !== 'lojas') location.hash = 'lojas';
    else {
      render();
      $('.catalog')?.scrollIntoView({ behavior:'smooth' });
    }
  }

  function updateHeader() {
    $('#cart-count').textContent = Object.values(cart.items).reduce((sum, amount) => sum + amount, 0);
  }

  async function loadCatalog() {
    if (loading) return loading;
    loading = api('catalog').then(list => {
      stores = list;
      for (const store of stores) for (const product of store.products) {
        if (optionDrafts.has(product.id)) optionDrafts.set(product.id,optionIds(product).filter(id=>(product.options ?? []).some(option=>option.id===id)));
      }
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

  function alignCategories(smooth = true,list = $('#categories')) {
    const selected = list?.querySelector('[aria-pressed=true]');
    if (!selected) return;
    const last = list.querySelector('.chip:last-child');
    list.style.setProperty('--category-tail',Math.max(0,list.clientWidth - last.offsetWidth - 15) + 'px');
    const left = selected.getBoundingClientRect().left - list.getBoundingClientRect().left + list.scrollLeft - 3;
    list.scrollTo({ left:selected === list.querySelector('.chip') ? 0 : Math.max(0,left),
      behavior:smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' });
  }
  const resizeCategories = () => { alignCategories(false); alignCategories(false,$('#menu-categories')); };
  window.addEventListener('resize',resizeCategories);

  function saveCart() {
    resetRequest();
    localStorage.setItem(cartKey, JSON.stringify(cart));
    updateHeader();
  }

  const optionIds = (product) => [...(optionDrafts.get(product.id) ?? [])].sort();
  const lineKey = (product,ids=[]) => product.id + (ids.length ? ':' + [...ids].sort().join(',') : '');
  function cartLine(store,key) {
    const [id,selection=''] = key.split(':');
    const product = store?.products.find(product=>product.id===id);
    if (!product) return null;
    const ids = selection ? selection.split(',') : [];
    const options = ids.map(id=>(product.options ?? []).find(option=>option.id===id));
    if (options.some(option=>!option)) return null;
    return {key,product,options,quantity:cart.items[key],price:product.price+options.reduce((sum,option)=>sum+option.price,0)};
  }
  function setItem(store, product, increment, ids = optionIds(product)) {
    const key = lineKey(product,ids);
    if (increment < 0 && (cart.store !== store.id || !cart.items[key])) return;
    if (cart.store && cart.store !== store.id) {
      if (!window.confirm('Você tem itens de outra loja. Deseja começar um novo carrinho?')) return;
      cart = { store:store.id, items:{} };
      address = null;
      usePrimary = true;
    }
    const quantity = (cart.items[key] ?? 0) + increment;
    if (quantity > 25) return toast('Você pode adicionar até 25 unidades por combinação.');
    if (quantity > 0) {
      if (!cart.items[key] && Object.keys(cart.items).length >= 30) return toast('Seu carrinho já tem 30 combinações de itens.');
      cart.store = store.id;
      cart.items[key] = quantity;
    } else delete cart.items[key];
    if (!Object.keys(cart.items).length) { cart.store = null; address = null; usePrimary = true; }
    saveCart();
    if (route().startsWith('loja/')) syncProductQuantities(store);
    else render();
    if (increment > 0 && route().startsWith('loja/')) toast(product.name + ' no carrinho.');
  }

  function categoryTags(store,banner = false) {
    return '<div' + (banner ? ' tabindex="0"' : '') + ' role="group" aria-label="Categorias do estabelecimento, deslize para ver mais" class="store-category-tags' + (banner ? ' store-category-tags-banner' : '') + '">' +
      storeCategories(store).map(label => '<span>' + esc(label) + '</span>').join('') + '</div>';
  }

  const productCategory = (store,product) => storeCategories(store).includes(product.category) ? product.category : null;
  const menuChoices = store => [
    ['Todas','grid'],
    ...storeCategories(store).map(label => [label,categories.find(([name])=>name===label)?.[1] || 'spark']),
    ...(store.products.some(product=>!productCategory(store,product)) ? [['uncategorized','spark']] : [])
  ];

  function storeCard(store, index, matchingProducts = []) {
    return '<a class="restaurant-card" href="#loja/' + esc(store.id) + '"><div class="restaurant-photo"><img src="' +
      esc(storePhoto(store)) + '" alt="" loading="' + (index === 0 ? 'eager' : 'lazy') +
      '">' + (!store.is_open ? '<span class="closed-tag">Fechado</span>' : '') +
      '</div><div class="restaurant-content">' + categoryTags(store) + '<div class="restaurant-heading"><h3>' + esc(store.name) + '</h3><span class="restaurant-arrow">' + icon('arrow') +
      '</span></div><p>' + esc(store.description) + '</p>' + (matchingProducts.length ? '<p class="search-matches">No cardápio: ' +
      matchingProducts.slice(0,2).map(product=>esc(product.name)).join(' · ') + (matchingProducts.length>2 ? '…' : '') + '</p>' : '') +
      '<div class="restaurant-meta"><span>' + icon('clock') + ' ' + store.eta +
      ' min</span><span>' + icon('bike') + ' ' + (store.fee ? money(store.fee) : 'Entrega grátis') + '</span></div></div></a>';
  }

  function catalogGrid() {
    const results = $('#results');
    const count = $('#results-count');
    if (!results) return;
    const matches = searchCatalog(stores,category,search);
    count.textContent = loaded ? matches.length + (matches.length === 1 ? ' estabelecimento' : ' estabelecimentos') : '';
    if (error) {
      results.innerHTML = empty('Catálogo indisponível', error, 'store') + '<button class="btn outline" id="retry">Tentar novamente</button>';
      $('#retry').onclick = async () => { await loadCatalog(); render(); };
    } else if (!loaded) results.innerHTML = '<p class="muted">Carregando estabelecimentos…</p>';
    else if (!matches.length) results.innerHTML = stores.length ? empty('Nenhum resultado','Experimente outro termo ou categoria.','search') : empty('Estabelecimentos em breve','As lojas cadastradas aparecerão aqui assim que forem publicadas.','store');
    else results.innerHTML = '<div class="restaurants">' + matches.map((match,index)=>storeCard(match.store,index,match.products)).join('') + '</div>';
  }

  function home(view) {
    main.innerHTML = '<div class="wrap home"><section class="hero" aria-labelledby="hero-title"><div class="hero-photo"></div>' +
      '<div class="hero-copy"><span class="hero-kicker"><span></span> DELIVERY DO SEU BAIRRO</span>' +
      '<h1 id="hero-title">A fome chama.<br><em>A gente leva.</em></h1><p>Descubra os melhores sabores da sua região e receba seus favoritos onde estiver.</p>' +
      '<a class="btn hero-cta" href="#lojas">Explorar estabelecimentos ' + icon('arrow') + '</a></div>' +
      '<div class="hero-stamp" aria-hidden="true">' + icon('bike') + '<span>DEU FOME?<br><strong>VAI DE FLY.</strong></span></div></section>' +
      '<section class="browse" aria-labelledby="categories-title"><div class="section-head"><div><span class="overline accent">BATEU AQUELA VONTADE?</span>' +
      '<h2 id="categories-title">O que vamos comer?</h2></div><label class="search-field">' + icon('search') +
      '<input id="search" type="search" maxlength="100" value="' + esc(search) + '" placeholder="Busque loja ou prato" aria-label="Busque loja ou prato"></label></div>' +
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
    if (menuStore !== store.id || !menuChoices(store).some(([label])=>label===menuCategory)) menuCategory = 'Todas';
    menuStore = store.id;
    main.innerHTML = '<div class="wrap page"><a class="back-link" href="#lojas">' + icon('back') + ' Estabelecimentos</a>' +
      '<section class="store-banner"><img src="' + esc(storePhoto(store)) +
      '" alt=""><div>' + categoryTags(store,true) + '<h1>' + esc(store.name) + '</h1><p>' + esc(store.description) +
      '</p><div class="restaurant-meta"><span>' + icon('clock') + ' ' + store.eta + ' min</span><span>' + icon('bike') + ' ' +
      (store.fee ? money(store.fee) : 'Entrega grátis') + '</span></div></div></section>' +
      (!store.is_open ? '<p class="pilot-label">Esta loja está fechada.</p>' : '') +
      '<div class="section-head menu-head"><h2>Cardápio</h2><a class="btn outline" href="#carrinho">' + icon('bag') + ' Ver carrinho</a></div>' +
      '<div id="menu-categories" class="chips" aria-label="Filtrar produtos por categoria">' + menuChoices(store).map(([label,symbol]) =>
        '<button class="chip" data-menu-category="' + esc(label) + '" aria-pressed="' + (label===menuCategory) + '">' +
        icon(symbol) + ' ' + esc(label==='uncategorized' ? 'Outros itens' : label) + '</button>').join('') + '</div>' +
      '<p id="menu-count" class="muted menu-count" aria-live="polite"></p><div class="products" id="menu-products"></div></div>';
    $('#menu-categories').onclick = event => {
      const button = event.target.closest('[data-menu-category]');
      if (!button) return;
      menuCategory = button.dataset.menuCategory;
      for (const chip of $('#menu-categories').children) chip.setAttribute('aria-pressed',String(chip===button));
      menuGrid(store);
      alignCategories(true,$('#menu-categories'));
    };
    $('#menu-products').onclick = event => {
      const button = event.target.closest('[data-product]');
      if (button) setItem(store,store.products.find(product => product.id === button.dataset.product),Number(button.dataset.menuDelta));
    };
    $('#menu-products').onchange = event => {
      const input = event.target.closest('[data-option]');
      if (!input) return;
      const card = input.closest('[data-menu-product]');
      optionDrafts.set(card.dataset.menuProduct,[...card.querySelectorAll('[data-option]:checked')].map(input=>input.dataset.option));
      syncProductQuantities(store);
    };
    menuGrid(store);
    alignCategories(false,$('#menu-categories'));
  }

  function menuGrid(store) {
    const products = store.products.filter(product => menuCategory==='Todas' ||
      (menuCategory==='uncategorized' ? !productCategory(store,product) : productCategory(store,product)===menuCategory));
    $('#menu-count').textContent = products.length + (products.length===1 ? ' produto' : ' produtos');
    $('#menu-products').innerHTML = products.length ? products.map(product =>
      '<article class="product" data-menu-product="' + esc(product.id) + '"><div class="product-content"><div><h3>' + esc(product.name) + '</h3><p>' + esc(product.description) + '</p><strong>' +
      money(product.price) + '</strong></div>' + (product.image ? '<img src="' + esc(product.image) + '" alt="" loading="lazy">' : '') +
      '</div>' + ((product.options ?? []).length ? '<details class="product-options"><summary>Opcionais <span>' + product.options.length + ' disponíveis</span></summary><div class="option-choices">' +
        product.options.map(option=>'<label><input type="checkbox" data-option="' + esc(option.id) + '"' + (optionIds(product).includes(option.id)?' checked':'') + '><span>' + esc(option.name) + '</span><strong>+ ' + money(option.price) + '</strong></label>').join('') +
        '</div></details>' : '') + '<p class="configured-price" data-configured-price aria-live="polite"></p><div class="product-quantity"><button class="icon-button" data-product="' + esc(product.id) + '" data-menu-delta="-1" aria-label="Diminuir ' + esc(product.name) + '">' +
      icon('minus') + '</button><span><output aria-label="Quantidade de ' + esc(product.name) + '" data-product-quantity>0</output> no carrinho</span>' +
      '<button class="icon-button add-product" data-product="' + esc(product.id) + '" data-menu-delta="1" aria-label="Adicionar ' + esc(product.name) + '">' +
      icon('plus') + '</button></div></article>').join('') :
      '<div class="panel menu-empty">' + empty(store.products.length ? 'Nenhum produto nesta categoria' : 'Cardápio em breve',
        store.products.length ? 'Escolha outra categoria para continuar.' : 'A loja está preparando os primeiros produtos.','store') + '</div>';
    syncProductQuantities(store);
  }

  function syncProductQuantities(store) {
    for (const card of document.querySelectorAll('[data-menu-product]')) {
      const product = store.products.find(product=>product.id===card.dataset.menuProduct);
      const ids = optionIds(product);
      const quantity = cart.store === store.id ? cart.items[lineKey(product,ids)] ?? 0 : 0;
      const extra = (product.options ?? []).filter(option=>ids.includes(option.id)).reduce((sum,option)=>sum+option.price,0);
      $('[data-configured-price]',card).textContent = ids.length ? 'Unidade com opcionais: ' + money(product.price+extra) : '';
      for (const input of card.querySelectorAll('[data-option]')) input.disabled = !store.is_open;
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
    const products = Object.keys(cart.items).map(key=>cartLine(store,key)).filter(Boolean);
    const subtotal = products.reduce((sum,line) => sum + line.price * line.quantity,0);
    const missing = Object.keys(cart.items).length > products.length;
    main.innerHTML = '<div class="wrap page"><a class="back-link" href="' + (store ? '#loja/' + esc(store.id) : '#lojas') + '">' +
      icon('back') + ' Continuar explorando</a><span class="overline accent">SEU PEDIDO</span><h1>Meu carrinho</h1>' +
      (!products.length ? '<div class="panel">' + empty('Seu carrinho está vazio', missing ? 'Os itens anteriores não estão mais disponíveis.' : 'Encontre algo gostoso no cardápio.') +
        (missing ? '<button class="btn outline" data-clear>Limpar carrinho</button>' : '') + '</div>' :
        '<div class="split"><section class="panel"><h2>' + esc(store.name) + '</h2><div class="cart-items">' + products.map(line =>
          '<div class="cart-row"><div><strong>' + esc(line.product.name) + '</strong>' +
          (line.options.length ? '<p class="cart-option-list">' + line.options.map(option=>'+ ' + esc(option.name) + ' (' + money(option.price) + ')').join('<br>') + '</p>' : '') +
          '<p>' + money(line.price) + ' por unidade · ' + money(line.price * line.quantity) + '</p></div>' +
          '<div class="stepper"><button class="icon-button" data-id="' + esc(line.key) + '" data-delta="-1" aria-label="Diminuir ' +
          esc(line.product.name) + '">' + icon('minus') + '</button><b>' + line.quantity + '</b><button class="icon-button" data-id="' +
          esc(line.key) + '" data-delta="1" aria-label="Aumentar ' + esc(line.product.name) + '">' + icon('plus') + '</button></div></div>').join('') +
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
      if (button) {
        const line = products.find(line=>line.key===button.dataset.id);
        setItem(store,line.product,Number(button.dataset.delta),line.options.map(option=>option.id));
      }
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
          payment:fields.get('payment'), fee:store.fee, items:products.map(line => ({
            id:line.product.id, quantity:line.quantity, price:line.product.price, options:line.options.map(option=>({id:option.id,price:option.price}))
          })) });
      } catch (err) {
        if (err.message.includes('mudaram') || err.message.includes('cardápio') || err.message.includes('opcionais')) {
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
  return { render, stop, updateHeader, openMenu, closeMenu, goHome };
}
