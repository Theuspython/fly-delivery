import { $, main, esc, icon, money, api, command, modal, toast, bindSubmit,
  categories, sortCategories, fallbackImages, empty, orderCard, transitionButton, bindTransitions, payments, statuses } from './shared.js';
import { percentage } from './invoices.js';
import { searchCatalog } from './catalog-search.js';
import { mealGroups,resolveMealSelection,mealChoicesMarkup } from './meal-choices.js';
import { renderLiveMarkup } from './live-markup.js';

function stored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
const promotionBanner = rate => rate > 0 ?
  '<aside class="billing-notice"><strong>Dia promocional Fly Delivery</strong> · ' + percentage(rate) +
  ' de desconto em qualquer estabelecimento <span aria-hidden="true">😊</span></aside>' : '';
const unavailableCoupon = error => /^(Cupom inválido ou fora do horário de validade|O cupom não se aplica aos produtos deste carrinho)\./.test(error.message);
function cashCents(value) {
  const match = /^(\d{1,8})(?:[,.](\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2,'0'));
  return cents <= 2147483647 ? cents : null;
}
const imageFor = (store, product) => product?.image || fallbackImages[store.category] || '/assets/bowl.webp';
const storeCategories = store => sortCategories(store.categories ?? [store.category]);
const storePhoto = store => store.image || imageFor(store,store.products.find(product => product.image));
const weekdays = ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];
const hourLabel = time => Number(time.slice(0,2)) + 'h' + (time.slice(3) === '00' ? '' : time.slice(3));

function storeHoursLabel(today) {
  const day = weekdays[today?.weekday];
  if (!day) return '';
  const { opens,closes,overnight_until:overnight } = today;
  if (opens && opens === closes) return day + ' · 24 horas';
  const range = opens && closes ? hourLabel(opens) + '–' + hourLabel(closes) + (closes < opens ? ' (dia seguinte)' : '') : '';
  const carryover = overnight ? 'até ' + hourLabel(overnight) : '';
  return day + ' · ' + ([carryover,range].filter(Boolean).join(' e ') || 'fechado');
}

export function customer(context) {
  let stores = [];
  const storeRanks = new Map();
  let loaded = false;
  let error;
  let loading;
  let category = 'Todas';
  let search = '';
  let menuStore = null;
  let menuCategory = 'Todas';
  const optionDrafts = new Map();
  const sizeDrafts = new Map();
  const mealDrafts = new Map();
  let note = '';
  let couponCode = '';
  let couponDraft = '';
  let checkoutPending = false;
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
  let cashAmount = '';
  let requestId = stored(requestKey, null);
  let ordersTimer;
  let orderStream;
  let previousView;
  let showcasePosition;
  let drawer;
  let floatingCart;
  let openOrderId = null;
  let stopHistory;
  const route = () => location.hash.slice(1) || 'inicio';
  const isShowcase = view => view === 'inicio' || view === 'lojas';
  const nativeScrollRestoration = history.scrollRestoration;
  if (nativeScrollRestoration) history.scrollRestoration = 'manual';
  const header = $('#top');
  function measureHeader() {
    main.style.setProperty('--customer-header-height', (header?.offsetHeight ?? 0) + 'px');
  }
  const headerObserver = header && typeof ResizeObserver === 'function' ? new ResizeObserver(measureHeader) : null;
  headerObserver?.observe(header);

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
      '<nav aria-label="Áreas do cliente">' + [['pedidos','Pedidos ativos','bag'],['historico','Histórico de pedidos','clock'],['enderecos','Endereços','pin']].map(([key,label,symbol]) =>
        '<a href="#' + key + '"' + (route() === key ? ' aria-current="page"' : '') + '>' + icon(symbol) + label + '</a>').join('') + '<button type="button" data-account>' + icon('person') + ' Minha conta</button></nav>';
    drawer.showModal();
    $('[data-customer-menu]')?.setAttribute('aria-expanded','true');
  }

  function goHome() {
    closeMenu();
    if (route().startsWith('loja/') && showcasePosition) {
      location.hash = 'lojas';
      return;
    }
    showcasePosition = null;
    category = 'Todas';
    search = '';
    if (route() !== 'lojas') location.hash = 'lojas';
    else {
      render();
      $('.catalog')?.scrollIntoView({ behavior:'smooth' });
    }
  }

  function showcaseCard(view) {
    return [...document.querySelectorAll('#results .restaurant-card')].find(card => card.hash === '#' + view);
  }

  function updateHeader() {
    measureHeader();
    $('#cart-count').textContent = Object.values(cart.items).reduce((sum, amount) => sum + amount, 0);
    updateFloatingCart();
  }

  function updateFloatingCart() {
    const store=stores.find(store=>store.id===cart.store);
    const lines=Object.keys(cart.items).map(key=>cartLine(store,key)).filter(Boolean);
    const show=active&&loaded&&route()!=='carrinho'&&lines.length>0;
    document.body.classList.toggle('has-floating-cart',show);
    if(!show){if(floatingCart)floatingCart.hidden=true;return;}
    if(!floatingCart){
      floatingCart=document.createElement('a');floatingCart.className='floating-cart';floatingCart.id='floating-cart';floatingCart.href='#carrinho';
      floatingCart.innerHTML='<span class="floating-cart-icon" aria-hidden="true">🛒<b data-floating-badge></b></span><span class="floating-cart-copy"><strong>Ver carrinho</strong><small data-floating-count></small></span><strong data-floating-total></strong>';
      document.body.append(floatingCart);
    }
    const quantity=lines.reduce((sum,line)=>sum+line.quantity,0),total=lines.reduce((sum,line)=>sum+line.price*line.quantity,0)+store.fee;
    floatingCart.hidden=false;
    $('[data-floating-badge]',floatingCart).textContent=quantity;
    $('[data-floating-count]',floatingCart).textContent=quantity+(quantity===1?' item':' itens')+' · Entrega incluída';
    $('[data-floating-total]',floatingCart).textContent=money(total);
    floatingCart.setAttribute('aria-label','Abrir carrinho com '+quantity+(quantity===1?' item':' itens')+'. Total com entrega: '+money(total));
  }

  async function loadCatalog() {
    if (loading) return loading;
    loading = api('catalog').then(list => {
      for (const store of list) if (!storeRanks.has(store.id)) storeRanks.set(store.id,Math.random());
      stores = list.sort((a,b) => storeRanks.get(a.id) - storeRanks.get(b.id));
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
  const resizeCategories = () => { measureHeader(); alignCategories(false); alignCategories(false,$('#menu-categories')); };
  window.addEventListener('resize',resizeCategories);

  function saveCart() {
    resetRequest();
    if (!cart.store) couponCode = couponDraft = cashAmount = '';
    localStorage.setItem(cartKey, JSON.stringify(cart));
    updateHeader();
  }

  const optionIds = (product) => [...(optionDrafts.get(product.id) ?? [])].sort();
  const productSize = product => (product.sizes ?? []).find(size=>size.name===sizeDrafts.get(product.id)) ?? product.sizes?.[0];
  const mealSelection=(product,size=productSize(product)?.name??'')=>mealDrafts.get(product.id+':'+size)??[];
  const lineKey = (product,ids=[],size='',meals=[]) => product.id + (ids.length || size || meals.length ? ':' + [...ids].sort().join(',') : '') + (size || meals.length ? ':' + size : '') + (meals.length?':'+encodeURIComponent(JSON.stringify(meals)):'');
  function cartLine(store,key) {
    const [id,selection='',sizeName='',mealPart=''] = key.split(':');
    const product = store?.products.find(product=>product.id===id);
    if (!product) return null;
    const size = (product.sizes ?? []).find(size=>size.name===sizeName);
    if ((product.sizes?.length && !size) || (sizeName && !size)) return null;
    const basePrice = size?.price ?? product.price;
    const ids = selection ? selection.split(',') : [];
    const options = ids.map(id=>(product.options ?? []).find(option=>option.id===id));
    if (options.some(option=>!option)) return null;
    let meals;try{meals=resolveMealSelection(product,sizeName,mealPart?JSON.parse(decodeURIComponent(mealPart)):[]);}catch{return null;}
    if(!meals.valid)return null;
    return {key,product,options,mealSelections:meals.selections,mealGroups:meals.groups,size: size?.name ?? '',basePrice,quantity:cart.items[key],price:basePrice+options.reduce((sum,option)=>sum+option.price,0)};
  }
  function setItem(store, product, increment, ids = optionIds(product), size = productSize(product)?.name ?? '', selection = mealSelection(product,size)) {
    if (checkoutPending) return;
    const meals=resolveMealSelection(product,size,selection);
    if(!meals.valid){toast(meals.reason);return;}
    const key = lineKey(product,ids,size,meals.selections);
    if (increment < 0 && (cart.store !== store.id || !cart.items[key])) return;
    if (cart.store && cart.store !== store.id) {
      if (!window.confirm('Você tem itens de outra loja. Deseja começar um novo carrinho?')) return;
      cart = { store:store.id, items:{} };
      couponCode = couponDraft = cashAmount = '';
      note = '';
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
    if (!Object.keys(cart.items).length) { cart.store = null; address = null; note = ''; usePrimary = true; }
    saveCart();
    if (route().startsWith('loja/')) syncProductQuantities(store);
    else render();
    if (increment > 0 && route().startsWith('loja/')) toast(product.name + ' no carrinho.');
  }

  function categoryTags(store,banner = false) {
    return '<div' + (banner ? ' tabindex="0"' : '') + ' role="group" aria-label="Categorias do estabelecimento, deslize para ver mais" class="store-category-tags' + (banner ? ' store-category-tags-banner' : '') + '">' +
      storeCategories(store).map(label => '<span>' + esc(label) + '</span>').join('') + '</div>';
  }

  const menuCategoryLabel = label => label === 'uncategorized' ? 'Itens sem categoria' : label;
  function menuChoices(store) {
    const labels = storeCategories(store);
    return [
      ['Todas','grid'],
      ...labels.map(label => [label,categories.find(([name])=>name===label)?.[1] || 'spark']),
      ...(store.products.some(product => !labels.includes(product.category)) ? [['uncategorized','spark']] : [])
    ];
  }

  function storeCard(store, index, matchingProducts = []) {
    return '<a class="restaurant-card" href="#loja/' + esc(store.id) + '"><div class="restaurant-photo"><img src="' +
      esc(storePhoto(store)) + '" alt="" loading="' + (index === 0 ? 'eager' : 'lazy') +
      '"><span class="' + (store.is_open ? 'open-tag' : 'closed-tag') + '">' + (store.is_open ? 'Aberto' : 'Fechado') + '</span>' +
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

  function home() {
    main.innerHTML = '<div class="wrap home"><section class="hero" aria-labelledby="hero-title"><div class="hero-photo"></div>' +
      '<div class="hero-copy"><span class="hero-kicker"><span></span> DELIVERY DO SEU BAIRRO</span>' +
      '<h1 id="hero-title">A fome chama.<br><em>A gente leva.</em></h1><p>Descubra os melhores sabores da sua região e receba seus favoritos onde estiver.</p>' +
      '<a class="btn hero-cta" href="#lojas">Explorar estabelecimentos ' + icon('arrow') + '</a></div>' +
      '<div class="hero-stamp" aria-hidden="true">' + icon('bike') + '<span>DEU FOME?<br><strong>VAI DE FLY.</strong></span></div></section>' +
      '<section class="browse" aria-labelledby="categories-title"><div class="section-head"><div><span class="overline accent">BATEU AQUELA VONTADE?</span>' +
      '<h2 id="categories-title">O que vamos comer?</h2></div><label class="search-field">' + icon('search') +
      '<input id="search" type="search" maxlength="100" value="' + esc(search) + '" placeholder="Busque loja ou prato" aria-label="Busque loja ou prato"></label></div>' +
      '</section><div class="menu-category-bar showcase-category-bar"><div id="categories" class="chips" aria-label="Filtrar categoria">' + categories.map(([label, symbol]) =>
        '<button class="chip" data-category="' + esc(label) + '" aria-pressed="' + (label === category) + '">' + icon(symbol) + ' ' +
        esc(label) + '</button>').join('') + '</div></div>' +
      '<section id="restaurants" class="catalog" aria-labelledby="catalog-title"><div class="section-head"><div><span class="overline accent">VITRINE FLY</span>' +
      '<h2 id="catalog-title">Estabelecimentos</h2></div><span class="muted" id="results-count"></span></div>' +
      promotionBanner(stores.find(store => store.promotion_bps > 0)?.promotion_bps) +
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
      const pastResults = $('#results').getBoundingClientRect().top < $('.showcase-category-bar').getBoundingClientRect().bottom;
      category = button.dataset.category;
      for (const chip of $('#categories').children) chip.setAttribute('aria-pressed', chip === button);
      catalogGrid();
      alignCategories();
      if (pastResults) $('.catalog').scrollIntoView({ block:'start' });
    };
    catalogGrid();
    alignCategories(false);
  }

  function storeView(store) {
    if (menuStore !== store.id || !menuChoices(store).some(([label])=>label===menuCategory)) menuCategory = 'Todas';
    menuStore = store.id;
    const hours = storeHoursLabel(store.today_hours);
    main.innerHTML = '<div class="wrap page"><a class="back-link" href="#lojas">' + icon('back') + ' Estabelecimentos</a>' +
      '<section class="store-banner"><img src="' + esc(storePhoto(store)) +
      '" alt=""><div>' + categoryTags(store,true) + '<h1>' + esc(store.name) + '</h1><p>' + esc(store.description) +
      '</p><div class="restaurant-meta"><span>' + icon('clock') + ' ' + store.eta + ' min</span><span>' + icon('bike') + ' ' +
      (store.fee ? money(store.fee) : 'Entrega grátis') + '</span>' +
      (hours ? '<span class="store-today-hours">' + icon('calendar') + ' ' + esc(hours) + '</span>' : '') + '</div></div></section>' +
      (!store.is_open ? '<p class="pilot-label">Esta loja está fechada.</p>' : '') +
      promotionBanner(store.promotion_bps) +
      '<div class="section-head menu-head"><h2>Cardápio</h2><a class="btn outline" href="#carrinho">' + icon('bag') + ' Ver carrinho</a></div>' +
      '<div class="menu-category-bar"><div id="menu-categories" class="chips" aria-label="Filtrar produtos por categoria">' + menuChoices(store).map(([label,symbol]) =>
        '<button class="chip" data-menu-category="' + esc(label) + '" aria-pressed="' + (label===menuCategory) + '">' +
        icon(symbol) + ' ' + esc(menuCategoryLabel(label)) + '</button>').join('') + '</div></div>' +
      '<p id="menu-count" class="muted menu-count" aria-live="polite"></p><div id="menu-products"></div></div>';
    $('#menu-categories').onclick = event => {
      const button = event.target.closest('[data-menu-category]');
      if (!button) return;
      const pastFirstProducts = $('#menu-products').getBoundingClientRect().top < $('.menu-category-bar').getBoundingClientRect().bottom;
      menuCategory = button.dataset.menuCategory;
      for (const chip of $('#menu-categories').children) chip.setAttribute('aria-pressed',String(chip===button));
      menuGrid(store);
      alignCategories(true,$('#menu-categories'));
      if (pastFirstProducts) $('.menu-head').scrollIntoView?.({ block:'start' });
    };
    $('#menu-products').onclick = event => {
      const clear=event.target.closest('[data-clear-meal]');
      if(clear){const card=clear.closest('[data-menu-product]'),product=store.products.find(p=>p.id===card.dataset.menuProduct),size=productSize(product)?.name??'';mealDrafts.set(product.id+':'+size,mealSelection(product,size).filter(group=>group.group_id!==clear.dataset.clearMeal));syncProductQuantities(store);return;}
      const button = event.target.closest('[data-product]');
      if (button) setItem(store,store.products.find(product => product.id === button.dataset.product),Number(button.dataset.menuDelta));
    };
    $('#menu-products').onchange = event => {
      const input = event.target.closest('[data-option],[data-size],[data-meal-option]');
      if (!input) return;
      const card = input.closest('[data-menu-product]');
      if (input.hasAttribute('data-size')) sizeDrafts.set(card.dataset.menuProduct,input.value);
      else if(input.hasAttribute('data-option')) optionDrafts.set(card.dataset.menuProduct,[...card.querySelectorAll('[data-option]:checked')].map(input=>input.dataset.option));
      else {
        const product=store.products.find(p=>p.id===card.dataset.menuProduct),size=productSize(product)?.name??'';
        mealDrafts.set(product.id+':'+size,mealGroups(product,size).map(group=>({group_id:group.id,option_ids:[...card.querySelectorAll('[data-meal-option]:checked')].filter(input=>input.dataset.mealGroup===group.id).map(input=>input.dataset.mealOption)})).filter(group=>group.option_ids.length));
      }
      syncProductQuantities(store);
    };
    menuGrid(store);
    alignCategories(false,$('#menu-categories'));
  }

  function menuGrid(store) {
    const groups = new Map(menuChoices(store).slice(1).map(([label,symbol]) => [label,{ label,symbol,products:[] }]));
    for (const product of store.products) {
      const group = groups.get(product.category) ?? groups.get('uncategorized');
      group.products.push(product);
    }
    const showAll = menuCategory === 'Todas';
    const visible = [...groups.values()].filter(group => group.products.length && (showAll || group.label === menuCategory));
    const count = visible.reduce((sum,group) => sum + group.products.length,0);
    $('#menu-count').textContent = count + (count === 1 ? ' produto' : ' produtos');
    $('#menu-products').innerHTML = visible.length ? visible.map(group => {
      const headingTag = showAll ? 'h4' : 'h3';
      const grid = '<div class="products">' + group.products.map(product => menuProductMarkup(product,headingTag)).join('') + '</div>';
      return showAll ? '<section class="menu-group"><h3>' + icon(group.symbol) + ' ' + esc(menuCategoryLabel(group.label)) + '</h3>' + grid + '</section>' : grid;
    }).join('') : '<div class="panel menu-empty">' + empty(store.products.length ? 'Nenhum produto nesta categoria' : 'Cardápio em breve',
      store.products.length ? 'Escolha outra categoria para continuar.' : 'A loja está preparando os primeiros produtos.','store') + '</div>';
    syncProductQuantities(store);
  }

  function menuProductMarkup(product,headingTag) {
    return '<article class="product" data-menu-product="' + esc(product.id) + '"><div class="product-content"><div><' + headingTag + '>' + esc(product.name) + '</' + headingTag + '><p>' + esc(product.description) + '</p><strong>' +
      ((product.sizes ?? []).length ? 'A partir de ' : '') + money(product.price) + '</strong></div>' + (product.image ? '<img src="' + esc(product.image) + '" alt="" loading="lazy">' : '') +
      '</div>' + ((product.sizes ?? []).length ? '<fieldset class="product-sizes"><legend>Escolha o tamanho</legend><div>' + product.sizes.map(size=>
        '<label><input type="radio" name="size-' + esc(product.id) + '" data-size value="' + esc(size.name) + '"' + (productSize(product)?.name===size.name ? ' checked' : '') + '><span><b>' + esc(size.name) + '</b><small>' + money(size.price) + '</small></span></label>').join('') + '</div></fieldset>' : '') +
      '<div data-meal-choices></div>' + ((product.options ?? []).length ? '<details class="product-options"><summary>Opcionais <span>' + product.options.length + ' disponíveis</span></summary><div class="option-choices">' +
        product.options.map(option=>'<label><input type="checkbox" data-option="' + esc(option.id) + '"' + (optionIds(product).includes(option.id)?' checked':'') + '><span>' + esc(option.name) + '</span><strong>+ ' + money(option.price) + '</strong></label>').join('') +
        '</div></details>' : '') + '<p class="configured-price" data-configured-price aria-live="polite"></p><div class="product-quantity"><button class="icon-button" data-product="' + esc(product.id) + '" data-menu-delta="-1" aria-label="Diminuir ' + esc(product.name) + '">' +
      icon('minus') + '</button><span><output aria-label="Quantidade de ' + esc(product.name) + '" data-product-quantity>0</output> no carrinho</span>' +
      '<button class="icon-button add-product" data-product="' + esc(product.id) + '" data-menu-delta="1" aria-label="Adicionar ' + esc(product.name) + '">' +
      icon('plus') + '</button></div></article>';
  }

  function syncProductQuantities(store) {
    for (const card of document.querySelectorAll('[data-menu-product]')) {
      const product = store.products.find(product=>product.id===card.dataset.menuProduct);
      const ids = optionIds(product);
      const size = productSize(product);
      const meals=resolveMealSelection(product,size?.name??'',mealSelection(product));
      const mealContainer=$('[data-meal-choices]',card),mealMarkup=mealChoicesMarkup(product,size?.name??'',mealSelection(product));
      if(mealContainer.innerHTML!==mealMarkup){
        const focused=document.activeElement?.dataset.mealOption;mealContainer.innerHTML=mealMarkup;
        if(focused)mealContainer.querySelector('[data-meal-option="'+focused+'"]')?.focus({preventScroll:true});
      }
      const basePrice = size?.price ?? product.price;
      const quantity = meals.valid && cart.store === store.id ? cart.items[lineKey(product,ids,size?.name,meals.selections)] ?? 0 : 0;
      const extra = (product.options ?? []).filter(option=>ids.includes(option.id)).reduce((sum,option)=>sum+option.price,0);
      $('[data-configured-price]',card).textContent = size || ids.length ? (size ? 'Tamanho ' + size.name + (ids.length ? ' com opcionais' : '') + ': ' : 'Unidade com opcionais: ') + money(basePrice+extra) : '';
      for (const input of card.querySelectorAll('[data-option],[data-size]')) input.disabled = !store.is_open;
      if(!store.is_open)for(const input of card.querySelectorAll('[data-meal-option],[data-clear-meal]'))input.disabled=true;
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
          '<div class="cart-row"><div><strong>' + esc(line.product.name) + (line.size ? ' · Tamanho ' + esc(line.size) : '') + '</strong>' +
          (line.options.length ? '<p class="cart-option-list">' + line.options.map(option=>'+ ' + esc(option.name) + ' (' + money(option.price) + ')').join('<br>') + '</p>' : '') +
          (line.mealGroups.length?'<p class="meal-summary">'+line.mealGroups.map(group=>'<span><b>'+esc(group.name)+':</b> '+group.options.map(option=>esc(option.name)).join(', ')+'</span>').join('')+'<small>Montagem sem acréscimo</small></p>':'') +
          '<p>' + money(line.price) + ' por unidade · ' + money(line.price * line.quantity) + '</p></div>' +
          '<div class="stepper"><button class="icon-button" data-id="' + esc(line.key) + '" data-delta="-1" aria-label="Diminuir ' +
          esc(line.product.name) + '">' + icon('minus') + '</button><b>' + line.quantity + '</b><button class="icon-button" data-id="' +
          esc(line.key) + '" data-delta="1" aria-label="Aumentar ' + esc(line.product.name) + '">' + icon('plus') + '</button></div></div>').join('') +
          '</div>' + (missing ? '<p class="pilot-label">Itens indisponíveis serão removidos deste pedido.</p>' : '') + '</section>' +
          '<section class="panel"><h2>Entrega e pagamento</h2>' + deliveryAddressMarkup() + '<form class="form-stack" id="checkout">' +
          '<label>Forma de pagamento<select name="payment">' + Object.entries(payments).map(([key,value]) =>
            '<option value="' + key + '"' + (key === payment ? ' selected' : '') + '>' + value + '</option>').join('') + '</select></label>' +
          '<div class="cash-payment" data-cash-payment hidden><label>Troco para quanto?<input name="cash_amount" inputmode="decimal" autocomplete="off" maxlength="11" value="' +
          esc(cashAmount) + '" placeholder="Ex.: 50,00" aria-describedby="cash-payment-help"></label>' +
          '<small id="cash-payment-help" class="muted">Informe quanto vai entregar em dinheiro. Se for pagar o valor exato, digite o total do pedido.</small></div>' +
          '<label>Observação para o estabelecimento <span class="muted">(opcional)</span><textarea name="note" rows="3" maxlength="500" placeholder="Ex.: retirar a cebola">' + esc(note) + '</textarea></label>' +
          '<div class="checkout-coupon"><label>Cupom da loja<input name="coupon" maxlength="24" autocapitalize="characters" autocomplete="off" value="' +
          esc(couponDraft) + '" placeholder="Digite o código"></label><button type="button" class="btn outline" data-apply-coupon>Aplicar</button></div>' +
          '<p class="muted checkout-coupon-status" data-quote-status aria-live="polite"></p>' +
          '<p class="muted">O pagamento é combinado com a loja e realizado na entrega.</p>' +
          '<div class="total-line"><span>Produtos</span><strong>' + money(subtotal) + '</strong></div>' +
          '<div class="checkout-discounts" data-discounts></div><div class="total-line"><span>Entrega</span><strong>' + money(store.fee) + '</strong></div>' +
          '<div class="total-line total"><span>Total</span><strong data-checkout-total>—</strong></div>' +
          '<p class="form-error" data-form-error role="alert"></p>' +
          '<button class="btn primary wide" type="submit" disabled>' +
          (store.is_open ? 'Confirmar pedido' : 'Loja fechada') + '</button></form></section></div>') + '</div>';
    if ($('[data-clear]')) $('[data-clear]').onclick = () => { cart = { store:null,items:{} }; note = ''; saveCart(); render(); };
    if (!products.length) return;
    $('.cart-items').onclick = event => {
      const button = event.target.closest('[data-delta]');
      if (button) {
        const line = products.find(line=>line.key===button.dataset.id);
        setItem(store,line.product,Number(button.dataset.delta),line.options.map(option=>option.id),line.size,line.mealSelections);
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
    $('[name=note]').oninput = event => { note = event.target.value; resetRequest(); };
    const cashPayment = $('[data-cash-payment]');
    const cashInput = $('[name=cash_amount]',cashPayment);
    const paymentInput = $('select[name=payment]');
    function updateCashField() {
      const payingCash = payment === 'cash_delivery';
      cashPayment.hidden = cashInput.disabled = !payingCash;
      cashInput.required = payingCash;
    }
    updateCashField();
    cashInput.oninput = () => { cashAmount = cashInput.value; resetRequest(); };
    paymentInput.onchange = event => {
      payment = event.target.value;
      resetRequest();
      updateCashField();
    };
    const checkout = $('#checkout');
    const couponInput = $('[name=coupon]',checkout);
    const apply = $('[data-apply-coupon]',checkout);
    const confirm = $('[type=submit]',checkout);
    const quoteStatus = $('[data-quote-status]',checkout);
    const discounts = $('[data-discounts]',checkout);
    const total = $('[data-checkout-total]',checkout);
    const pricingInput = { store_id:store.id,fee:store.fee,items:products.map(line => ({
      id:line.product.id,quantity:line.quantity,price:line.basePrice,size:line.size || null,
      options:line.options.map(option => ({ id:option.id,price:option.price })),meal_choices:line.mealSelections
    })) };
    let quote;
    let revision = 0;

    function invalidateQuote(message) {
      revision++;
      quote = null;
      confirm.disabled = true;
      discounts.innerHTML = '';
      total.textContent = '—';
      quoteStatus.textContent = message;
      quoteStatus.classList.remove('coupon-accepted');
    }

    function showCouponNotice(sequence) {
      const current = () => active && checkout.isConnected && route() === 'carrinho' && sequence === revision;
      if (!current()) return;
      const dialog = $('#dialog');
      if (dialog.open) {
        dialog.addEventListener('close', () => showCouponNotice(sequence), { once:true });
        return;
      }
      quoteStatus.textContent = '';
      modal('Cupom indisponível',
        '<button class="btn primary wide" type="button" data-close autofocus>OK</button>',
        'Este cupom não está mais disponível para este pedido. Você pode continuar com a sua compra sem ele.');
      dialog.addEventListener('close', () => {
        if (!current()) return;
        couponCode = couponDraft = couponInput.value = '';
        resetRequest();
        refreshQuote();
      }, { once:true });
    }

    async function refreshQuote() {
      invalidateQuote('Calculando total…');
      if (couponDraft.trim().toUpperCase() !== couponCode) { quoteStatus.textContent = 'Clique em Aplicar para atualizar o total.'; return; }
      if (!store.is_open) { quoteStatus.textContent = ''; return; }
      const sequence = revision;
      try {
        const result = await command('quote_order',{ ...pricingInput,coupon_code:couponCode });
        if (!checkout.isConnected || sequence !== revision) return;
        quote = result;
        discounts.innerHTML = discountLine('Cupom ' + esc(result.coupon_code),result.coupon_discount_cents) +
          discountLine('Promoção Fly Delivery',result.platform_discount_cents);
        total.textContent = money(result.total);
        quoteStatus.textContent = result.coupon_code ? 'Cupom liberado' : '';
        quoteStatus.classList.toggle('coupon-accepted',Boolean(result.coupon_code));
        confirm.disabled = checkoutPending;
      } catch (error) {
        if (!checkout.isConnected || sequence !== revision) return;
        if (couponCode && unavailableCoupon(error)) showCouponNotice(sequence);
        else quoteStatus.textContent = error.message;
      }
    }

    function discountLine(label, value) {
      return value > 0 ? '<div class="total-line"><span>' + label + '</span><strong>− ' + money(value) + '</strong></div>' : '';
    }

    couponInput.oninput = () => {
      couponDraft = couponInput.value;
      if (!couponDraft.trim()) {
        if (couponCode) resetRequest();
        couponCode = '';
        refreshQuote();
        return;
      }
      invalidateQuote('Clique em Aplicar para atualizar o total.');
    };
    apply.onclick = () => {
      if (checkoutPending) return;
      const nextCode = couponInput.value.trim().toUpperCase();
      if (nextCode !== couponCode) resetRequest();
      couponCode = couponDraft = couponInput.value = nextCode;
      $('[data-form-error]',checkout).textContent = '';
      refreshQuote();
    };
    couponInput.onkeydown = event => {
      if (event.key === 'Enter') { event.preventDefault(); apply.click(); }
    };
    bindSubmit(checkout, async fields => {
      if (!quote || checkoutPending) return;
      const method = fields.get('payment');
      const tendered = method === 'cash_delivery' ? cashCents(fields.get('cash_amount') ?? '') : null;
      if (method === 'cash_delivery' && (tendered === null || tendered < quote.total)) {
        cashInput.focus();
        throw new Error('Informe um valor em dinheiro igual ou maior que o total de ' + money(quote.total) + '.');
      }
      const chosen = deliveryAddress();
      if (!chosen) return addressDialog();
      if (!context.user) return context.signIn();
      requestId ??= crypto.randomUUID();
      localStorage.setItem(requestKey,JSON.stringify(requestId));
      checkoutPending = couponInput.disabled = apply.disabled = true;
      paymentInput.disabled = cashInput.readOnly = true;
      try {
        await command('place',{ ...pricingInput,coupon_code:couponCode,quote,request_id:requestId,
          address:chosen.text,payment:method,cash_tendered_cents:tendered,note:fields.get('note') });
      } catch (err) {
        if (/mudaram|cupom|cardápio|opcionais|escolhas/i.test(err.message)) {
          invalidateQuote('');
          resetRequest();
          await loadCatalog();
          render();
          if (!unavailableCoupon(err)) toast(err.message);
          return;
        }
        throw err;
      } finally {
        checkoutPending = couponInput.disabled = apply.disabled = false;
        paymentInput.disabled = cashInput.readOnly = false;
      }
      cart = { store:null,items:{} };
      note = '';
      address = null;
      usePrimary = true;
      saveCart();
      location.hash = 'pedidos';
      toast('Pedido enviado à loja.');
    });
    refreshQuote();
  }

  function orderView() {
    main.innerHTML = '<div class="wrap page"><span class="overline accent">ACOMPANHAMENTO</span><h1>Pedidos ativos</h1><div id="order-list">' +
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
        const data = await command('customer_active_orders');
        const orders = data.orders;
        if (!list.isConnected) return;
        if (statusByOrder) {
          const changed = orders.find(order => statusByOrder.has(order.id) && statusByOrder.get(order.id) !== order.status);
          if (changed) toast(changed.store + ' · ' + statuses[changed.status]);
          else if ([...statusByOrder.keys()].some(id=>!orders.some(order=>order.id===id))) toast('Pedido atualizado. Confira o Histórico de pedidos.');
        }
        statusByOrder = new Map(orders.map(order => [order.id,order.status]));
        if (openOrderId && !orders.some(order => order.id === openOrderId)) openOrderId = null;
        const markup = orders.length ? '<div class="order-grid customer-order-grid">' + orders.map(order => orderCard(order,
          order.status === 'placed' ? transitionButton(order,'cancelled','Cancelar pedido','outline') : '',{ address:true,timeline:true,progress:true,compact:true,customerView:true,expanded:order.id === openOrderId })).join('') +
          '</div>' : '<div class="panel">' + empty('Nenhum pedido ativo','Explore os cardápios para fazer um novo pedido.') + '</div>';
        renderLiveMarkup(list,markup);
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

  function orderHistoryView() {
    main.innerHTML = '<div class="wrap page customer-history-page"><span class="overline accent">SEUS PEDIDOS</span><h1>Histórico de pedidos</h1>' +
      '<p class="muted history-hint">Entregues e cancelados. Deslize para baixo para ver mais pedidos.</p>' +
      '<p class="muted history-count" aria-live="polite"></p><div id="order-list" class="history-scroll" role="region" aria-label="Histórico de pedidos" tabindex="0">' +
      '<div class="order-grid customer-order-grid history-grid"></div><div class="history-more"><p class="muted" data-history-message role="status">Carregando pedidos…</p>' +
      '<button class="btn outline" data-history-more hidden>Carregar mais pedidos</button></div></div></div>';
    if (!context.user) return;
    const list = $('#order-list');
    const grid = $('.history-grid',list);
    const more = $('[data-history-more]',list);
    const message = $('[data-history-message]',list);
    let orders = [];
    let page = -1;
    let pages = 1;
    let count = 0;
    let reading = false;
    let queued = false;
    let firstSignature;
    let disposed = false;
    const connected = () => !disposed && list.isConnected;

    function measure() {
      if (!connected()) return;
      const cards = [...grid.children].slice(0,4);
      if (!cards.length) return;
      const gap = parseFloat(window.getComputedStyle(grid).rowGap) || 12;
      const height = cards.reduce((sum,card) => {
        const style = window.getComputedStyle(card);
        return sum + $('.compact-order-head',card).getBoundingClientRect().height +
          ['paddingTop','paddingBottom','borderTopWidth','borderBottomWidth'].reduce((n,key) => n+(parseFloat(style[key])||0),0);
      },gap*(cards.length-1));
      if (height>0) list.style.setProperty('--history-height',Math.ceil(height)+'px');
    }
    const resizeHistory = () => list.classList.toggle('history-unclamped',Boolean(openOrderId) || (pages <= 1 && orders.length <= 4));
    function draw() {
      if (openOrderId && !orders.some(order=>order.id===openOrderId)) openOrderId=null;
      resizeHistory();
      const markup = orders.map(order=>orderCard(order,'',{address:true,timeline:true,progress:true,compact:true,customerView:true,expanded:order.id===openOrderId})).join('');
      renderLiveMarkup(grid,markup);
      $('.history-count').textContent = orders.length ? orders.length+' de '+count+' pedidos' : '';
      message.textContent = count ? (page+1<pages ? 'Role para carregar os próximos pedidos.' : 'Você chegou ao fim do histórico.') : 'Nenhum pedido no histórico. Pedidos entregues ou cancelados aparecerão aqui.';
      more.hidden=page+1>=pages;
      more.textContent='Carregar mais pedidos';
      requestAnimationFrame(measure);
    }
    async function load(append = false) {
      if (!connected()) return;
      if (reading) { if (!append) queued=true; return; }
      if (append && page+1>=pages) return;
      reading=true;
      more.disabled=true;
      list.setAttribute('aria-busy','true');
      try {
        const data=await command('customer_order_history',{page:append?page+1:0,page_size:4});
        if (!connected()) return;
        const signature=JSON.stringify({orders:data.orders,count:data.count});
        if (!append && firstSignature===signature) return;
        const reset=!append && firstSignature!==undefined;
        if (append) {
          const seen=new Set(orders.map(order=>order.id));
          orders.push(...data.orders.filter(order=>!seen.has(order.id)));
        } else { orders=data.orders; firstSignature=signature; }
        page=data.page; pages=data.pages; count=data.count;
        draw();
        if (reset) list.scrollTop=0;
      } catch(error) {
        if (connected()) { message.textContent=error.message; more.textContent='Tentar novamente'; more.hidden=false; }
      } finally {
        reading=false;
        if (connected()) { more.disabled=false; list.setAttribute('aria-busy','false'); }
        if (queued && connected()) { queued=false; load(); }
      }
    }
    list.addEventListener('scroll',()=>{
      if (list.scrollTop>0 && list.scrollTop+list.clientHeight>=list.scrollHeight-64) load(true);
    },{passive:true});
    more.onclick=()=>load(page>=0);
    grid.addEventListener('click',event=>{
      const button=event.target.closest('[data-toggle-order]');
      if (!button) return;
      openOrderId=openOrderId===button.dataset.toggleOrder?null:button.dataset.toggleOrder;
      resizeHistory();
      for (const toggle of grid.querySelectorAll('[data-toggle-order]')) {
        const expanded=toggle.dataset.toggleOrder===openOrderId;
        toggle.setAttribute('aria-expanded',String(expanded));
        toggle.textContent=expanded?'Recolher':'Visualizar';
        toggle.setAttribute('aria-label',(expanded?'Recolher':'Visualizar')+' pedido #'+toggle.dataset.toggleOrder.slice(0,8));
        document.getElementById(toggle.getAttribute('aria-controls')).hidden=!expanded;
      }
      button.closest('.order-card').scrollIntoView({ block:openOrderId ? 'start' : 'nearest' });
    });
    window.addEventListener('resize',measure);
    document.fonts?.ready.then(measure);
    stopHistory=()=>{disposed=true;window.removeEventListener('resize',measure);};
    load();
    orderStream=new EventSource('/api/order-updates');
    const refresh=()=>load();
    orderStream.addEventListener('orders',refresh);
    ordersTimer=setInterval(()=>{
      load();
      if (connected() && orderStream.readyState===EventSource.CLOSED) {
        orderStream=new EventSource('/api/order-updates');
        orderStream.addEventListener('orders',refresh);
      }
    },15000);
  }

  function render() {
    if (!active) return;
    clearInterval(ordersTimer);
    orderStream?.close();
    stopHistory?.(); stopHistory=null;
    const view = route();
    const changedView = view !== previousView;
    if (changedView) {
      openOrderId = null;
      if (isShowcase(previousView) && view.startsWith('loja/')) {
        showcasePosition = { view,top:window.scrollY,cardTop:showcaseCard(view)?.getBoundingClientRect().top };
      }
    }
    if (view === 'pedidos') orderView();
    else if (view === 'historico') orderHistoryView();
    else if (view === 'enderecos') addressView();
    else if (view === 'carrinho' && loaded) cartView();
    else if (view.startsWith('loja/') && loaded) {
      const store = stores.find(candidate => candidate.id === view.slice(5));
      if (store) storeView(store);
      else main.innerHTML = '<div class="wrap page"><a class="back-link" href="#lojas">' + icon('back') +
        ' Estabelecimentos</a>' + empty('Loja indisponível','Confira as outras lojas da região.','store') + '</div>';
    } else home();
    previousView = view;
    updateHeader();
    if (!changedView) return;
    if (isShowcase(view) && showcasePosition) {
      const position = showcasePosition;
      showcasePosition = null;
      requestAnimationFrame(() => {
        if (!active || route() !== view) return;
        const card = showcaseCard(position.view);
        const top = card && Number.isFinite(position.cardTop)
          ? window.scrollY + card.getBoundingClientRect().top - position.cardTop : position.top;
        window.scrollTo({ top,behavior:'instant' });
      });
    } else if (view === 'lojas') {
      requestAnimationFrame(() => {
        if (active && route() === view) $('.catalog')?.scrollIntoView({ behavior:'smooth' });
      });
    } else window.scrollTo(0,0);
  }

  loadCatalog().then(() => render());
  loadPrimaryAddress().then(() => {
    if (active && !$('#dialog').open && ['carrinho','enderecos'].includes(route())) render();
  });
  async function refreshCatalog() {
    const view = route();
    if (!active || checkoutPending || ['pedidos','historico','enderecos'].includes(view) || $('#dialog').open) return;
    const before = JSON.stringify(stores);
    const hadError = Boolean(error);
    await loadCatalog();
    if (!checkoutPending && route() === view && !$('#dialog').open && (before !== JSON.stringify(stores) || hadError !== Boolean(error))) render();
  }
  window.addEventListener('hashchange',refreshCatalog);
  window.addEventListener('focus',refreshCatalog);
  const catalogTimer = setInterval(() => { if (!document.hidden) refreshCatalog(); },10000);
  function stop() {
    active = false;
    if (nativeScrollRestoration) history.scrollRestoration = nativeScrollRestoration;
    headerObserver?.disconnect();
    main.style.removeProperty('--customer-header-height');
    floatingCart?.remove();floatingCart=null;
    document.body.classList.remove('has-floating-cart');
    stopHistory?.(); stopHistory=null;
    clearInterval(catalogTimer);
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
