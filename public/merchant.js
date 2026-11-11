import { $, main, esc, icon, money, api, command, empty, orderCard, transitionButton, bindTransitions, toast } from './shared.js';
import { invoicesMarkup, suspensionBanner } from './invoices.js';
import { productForm, storeSettings, storeMarkup, organizeMenuCategories, organizeMenuProducts,
  merchantProductRows, selectMerchantProductCategory } from './operations.js';
import { couponsMarkup, couponForm } from './promotions.js';
import { renderLiveMarkup } from './live-markup.js';
import { inventoryMarkup, adjustStockForm, createMerchantAlerts } from './inventory.js';

const sections = [
  ['faturas','Faturas Fly Delivery','shield'],
  ['pedidos','Pedidos em andamento','bag'],
  ['produtos','Cadastro de produtos','burger'],
  ['estoque','Estoque','bag'],
  ['financeiro','Financeiro','grid'],
  ['cupons','Cupons de desconto','tag'],
  ['perfil','Configurações do estabelecimento','store']
];
const labels = Object.fromEntries(sections.map(([key,label]) => [key,label]));
const dateLabel = value => value.split('-').reverse().join('/');
const timestamp = value => new Intl.DateTimeFormat('pt-BR',{
  dateStyle:'short',timeStyle:'short',timeZone:'America/Sao_Paulo'
}).format(new Date(value));
const today = () => {
  const parts = new Intl.DateTimeFormat('en-US',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts();
  const values = Object.fromEntries(parts.map(part => [part.type,part.value]));
  return values.year + '-' + values.month + '-' + values.day;
};
const actions = order =>
  (order.status === 'placed' ? transitionButton(order,'preparing','Aceitar · iniciar produção') : '') +
  (['preparing','ready','assigned'].includes(order.status) ? transitionButton(order,'picked_up','Pronto · saiu para entrega') : '') +
  (order.status === 'picked_up' ? transitionButton(order,'delivered','Confirmar entrega') : '') +
  (['placed','preparing','ready','assigned'].includes(order.status) ? transitionButton(order,'cancelled','Cancelar','outline') : '');
const queueStage = order => ['ready','assigned'].includes(order.status) ? 'preparing' : order.status;
const queueLabels = {placed:'Novos',preparing:'Em produção',picked_up:'Em entrega'};
const cards = (orders,active = false,openOrderId = null) => '<div class="order-grid merchant-order-grid">' + orders.map(order =>
  orderCard(order,active ? actions(order) : '',{
    address:true,hideAddress:order.status==='placed'||order.address_hidden,progress:true,timeline:!active,compact:true,expanded:order.id === openOrderId
  })).join('') + '</div>';

function storeSettingsMarkup(store) {
  const storeId = esc(store.id);
  const status = store.active ? store.accepting_now ? 'Aberta agora' : 'Fechada agora' : 'Não publicada';
  const options = [
    ['settings','camera','Foto, horários e entrega'],
    ['organize-categories','grid','Organizar categorias'],
    ['organize-products','sort','Ordem dos produtos no cardápio']
  ];
  return '<article class="panel merchant-profile"><div class="merchant-profile-header">' +
    '<div class="merchant-profile-identity">' +
    (store.image ? '<img class="merchant-profile-photo" src="' + esc(store.image) + '" alt="">' :
      '<span class="merchant-profile-photo product-placeholder">' + icon('store') + '</span>') +
    '<div><h2>' + esc(store.name) + '</h2><span class="status ' +
    (store.accepting_now ? 'status-delivered' : 'status-cancelled') + '">' + status + '</span></div></div>' +
    (store.active || store.weekly_hours ? '<button type="button" class="btn outline" data-open="' + storeId +
      '">' + (store.is_open ? 'Pausar pedidos' : 'Ativar pedidos') + '</button>' : '') + '</div>' +
    '<div class="merchant-settings-options">' + options.map(([action,symbol,label]) =>
      '<button type="button" class="merchant-settings-option" data-' + action + '="' + storeId + '">' +
      '<span class="merchant-settings-icon">' + icon(symbol) + '</span><strong>' + label + '</strong>' + icon('arrow') + '</button>'
    ).join('') + '</div></article>';
}

function pagination(data) {
  if (data.pages <= 1) return '';
  return '<nav class="merchant-pagination" aria-label="Páginas"><button class="btn outline" data-page="' +
    (data.page-1) + '"' + (data.page === 0 ? ' disabled' : '') + '>Anterior</button><span>Página ' + (data.page+1) +
    ' de ' + data.pages + '</span><button class="btn outline" data-page="' + (data.page+1) + '"' +
    (data.page+1 >= data.pages ? ' disabled' : '') + '>Próxima</button></nav>';
}

function financeDiscounts(order) {
  const discounts = [];
  if (order.coupon_discount_cents > 0) {
    const label = order.coupon_source === 'platform' ? 'Cupom Fly Delivery' : 'Cupom da loja';
    discounts.push([label,order.coupon_discount_cents,order.coupon_code]);
  }
  if (order.platform_discount_cents > 0) discounts.push(['Dia promocional Fly Delivery',order.platform_discount_cents]);
  return discounts.length ? discounts.map(([label,amount,code]) => '<div class="finance-order-discount"><strong>−' + money(amount) +
    '</strong><small>' + label + (code ? ' · '+esc(code) : '') + '</small></div>').join('') : '—';
}

function financeMarkup(data) {
  const summary = '<div class="finance-summary">' + [
    ['Pedidos entregues',String(data.count)],
    ['Produtos após descontos',money(data.products)],
    ['Taxas de entrega',money(data.delivery)],
    ['Total dos pedidos',money(data.total)],
    ['Comissão Fly Delivery',money(data.platform)],
    ['Líquido após comissão',money(data.net)]
  ].map(([label,value]) => '<article class="panel"><p>' + label + '</p><strong>' + value + '</strong></article>').join('') +
    '</div><p class="muted finance-note">Pedidos entregues entre ' + dateLabel(data.date_from) + ' e ' + dateLabel(data.date_to) +
    '. O total já inclui os descontos e a entrega. O líquido é o total menos a comissão registrada na venda, independentemente do pagamento das faturas.</p>';
  if (!data.count) return summary + '<div class="panel">' + empty('Nenhuma venda concluída','As vendas aparecerão após a confirmação da entrega.','grid') + '</div>';
  return summary + '<div class="panel"><h2>Vendas por dia</h2><div class="merchant-table-scroll"><table class="merchant-table">' +
    '<thead><tr><th>Dia</th><th>Pedidos</th><th>Produtos</th><th>Entrega</th><th>Total</th><th>Comissão Fly Delivery</th><th>Líquido</th></tr></thead><tbody>' +
    data.days.map(day => '<tr><td>' + dateLabel(day.day) + '</td><td>' + day.amount + '</td><td>' +
      money(day.products) + '</td><td>' + money(day.delivery) + '</td><td>' + money(day.total) + '</td><td>' + money(day.platform) + '</td><td>' + money(day.net) + '</td></tr>').join('') +
    '</tbody></table></div></div><div class="panel finance-ledger"><h2>Pedidos do período</h2><div class="merchant-table-scroll">' +
    '<table class="merchant-table"><thead><tr><th>Pedido</th><th>Cliente</th><th>Entregue em</th><th>Produtos antes dos descontos</th><th>Descontos ao cliente</th><th>Entrega</th><th>Total pago pelo cliente</th><th>Comissão Fly Delivery</th><th>Líquido</th></tr></thead><tbody>' +
    data.orders.map(order => '<tr><td>#' + esc(order.id.slice(0,8)) + '</td><td>' +
      esc(order.customer_name) + '</td><td>' + timestamp(order.completed_at) + '</td><td>' + money(order.gross_subtotal ?? order.subtotal) +
      '</td><td>' + financeDiscounts(order) + '</td><td>' + money(order.fee) + '</td><td>' + money(order.subtotal+order.fee) +
      '</td><td>' + money(order.platform) + '</td><td>' + money(order.net) + '</td></tr>').join('') +
    '</tbody></table></div>' + pagination(data) + '</div>';
}

export function merchant(context) {
  const alerts = createMerchantAlerts(context);
  let timer;
  let sequence = 0;
  let busy = false;
  let stores = [];
  let coupons = [];
  let openOrderId = null;
  let queueFilter = 'placed';
  let activeOrders = [];
  let queueIdentity = null;
  const productFilters = new Map();
  const pendingAvailability = new Set();
  let page = 0;
  let previousSection;
  let owner;
  let rangeMode = 'day';
  let fromDate = today();
  let toDate = fromDate;
  let drawer;
  let returning = false;
  const returnFields = Object.fromEntries(new URLSearchParams(location.search));
  const paymentReturn = 'invoice_return' in returnFields;
  if (paymentReturn) history.replaceState(null,'',location.pathname + '#faturas');
  const section = () => location.hash==='#finalizados'?'financeiro':labels[location.hash.slice(1)] ? location.hash.slice(1) : 'pedidos';

  function closeMenu() { if (drawer?.open) drawer.close(); }

  async function verifyReturn() {
    if (!paymentReturn || returning || context.user?.role !== 'merchant') return;
    returning = true;
    try {
      if (returnFields.transaction_nsu && (returnFields.slug || returnFields.invoice_slug) && returnFields.order_nsu) {
        const result = await api('billing/verify',returnFields);
        toast(result.paid ? 'Pagamento confirmado. Obrigado!' : 'Pagamento ainda não confirmado. Aguarde e atualize as faturas.');
        if (result.paid) alerts.sync();
      }
      await refresh(true);
    } catch(error) { toast(error.message); }
  }

  function openMenu() {
    if (!drawer) {
      drawer = document.createElement('dialog');
      drawer.id = 'merchant-navigation';
      drawer.className = 'merchant-drawer';
      drawer.setAttribute('aria-labelledby','merchant-menu-title');
      document.body.append(drawer);
      drawer.addEventListener('click',event => {
        if (event.target.closest('[data-account]')) { closeMenu(); context.openAccount(); return; }
        if (event.target === drawer || event.target.closest('[data-close-menu]') || event.target.closest('a')) drawer.close();
      });
      drawer.addEventListener('close',() => $('[data-merchant-menu]')?.setAttribute('aria-expanded','false'));
    }
    drawer.innerHTML = '<div class="dialog-head"><div><span class="overline accent">FLY DELIVERY</span><h2 id="merchant-menu-title">Estabelecimento</h2></div>' +
      '<button class="icon-button" data-close-menu aria-label="Fechar menu">' + icon('close') + '</button></div>' +
      '<nav aria-label="Áreas do estabelecimento">' + sections.map(([key,label,symbol]) =>
        '<a href="#' + key + '"' + (key === 'faturas' ? ' class="merchant-invoices-link"' : '') +
        (section() === key ? ' aria-current="page"' : '') + '>' + icon(symbol) + label + '</a>').join('') +
      (context.user?.role === 'merchant' ? '<button type="button" class="merchant-account-link" data-account>' + icon('person') + ' Minha conta</button>' : '') + '</nav>';
    drawer.showModal();
    $('[data-merchant-menu]')?.setAttribute('aria-expanded','true');
  }

  function queueMarkup() {
    const visible = activeOrders.filter(order => queueStage(order) === queueFilter);
    if (openOrderId && !visible.some(order => order.id === openOrderId)) openOrderId = null;
    return '<div class="merchant-queue-summary" role="group" aria-label="Filtrar pedidos por status">' +
      Object.entries(queueLabels).map(([status,label]) => '<button type="button" class="order-stage-' + status + '" data-queue-filter="' + status +
        '" aria-pressed="' + (queueFilter === status) + '">' + label + ' <b>' +
        activeOrders.filter(order => queueStage(order) === status).length + '</b></button>').join('') + '</div>' +
      (visible.length ? cards(visible,true,openOrderId) : '<div class="panel">' + empty(
        activeOrders.length ? 'Nenhum pedido neste status' : 'Nenhum pedido em andamento',
        activeOrders.length ? 'Escolha outro status para ver os demais pedidos.' :
          'Os novos pedidos chegam aqui. As vendas concluídas ficam no Financeiro.') + '</div>');
  }

  async function refresh(force = false) {
    if (context.user?.role !== 'merchant' || (busy && !force)) return;
    const currentSection = section();
    const user = context.user;
    const revision = ++sequence;
    busy = true;
    const result = $('#merchant-results');
    try {
      const billingStatus = await command('billing_settings');
      if (revision !== sequence || context.user !== user || currentSection !== section()) return;
      const banner = $('#merchant-billing-banner');
      if (banner) renderLiveMarkup(banner,suspensionBanner(billingStatus.stores));
      let markup;
      if (currentSection === 'faturas') {
        const data = await command('merchant_invoices',{page});
        markup = invoicesMarkup(data) + pagination(data);
      } else if (currentSection === 'pedidos') {
        const [orders,identity] = await Promise.all([
          command('merchant_active_orders'),
          queueIdentity ?? command('merchant_store_identity').catch(() => null)
        ]);
        if (revision !== sequence || context.user !== user || currentSection !== section()) return;
        activeOrders = orders;
        queueIdentity = identity;
        renderLiveMarkup($('#merchant-store-identity'),(identity ?? billingStatus.stores ?? []).map(shop =>
          '<span class="merchant-store-identity">' + (shop.image ? '<img class="menu-admin-photo" src="' + esc(shop.image) + '" alt="">' :
            '<span class="product-placeholder">' + icon('store') + '</span>') + '<strong>' + esc(shop.name) + '</strong></span>'
        ).join(''));
        markup = queueMarkup();
      } else if (currentSection === 'financeiro') {
        const data = await command('merchant_finance',{ date_from:fromDate,date_to:toDate,page });
        markup = financeMarkup(data);
      } else if (currentSection === 'estoque') {
        stores = await command('managed_stores');
        markup = inventoryMarkup(stores);
      } else if (currentSection === 'cupons') {
        const [managed, saved] = await Promise.all([command('managed_stores'),command('merchant_coupons')]);
        if (revision !== sequence || context.user !== user || currentSection !== section()) return;
        stores = managed;
        coupons = saved;
        markup = couponsMarkup(stores,coupons);
      } else {
        const managed = await command('managed_stores');
        if (revision !== sequence || context.user !== user || currentSection !== section()) return;
        stores = managed;
        markup = stores.length ? '<div class="management-grid ' +
          (currentSection === 'produtos' ? 'merchant-product-grid' : 'merchant-settings-grid') + '">' + stores.map(store =>
          currentSection === 'produtos' ? storeMarkup(store,'merchant',productFilters.get(store.id)) :
            storeSettingsMarkup(store)
        ).join('') + '</div>' : '<div class="panel">' + empty('Nenhuma loja vinculada','A administração pode criar o acesso ao estabelecimento.','store') + '</div>';
      }
      if (revision !== sequence || context.user !== user || currentSection !== section() || !result?.isConnected) return;
      renderLiveMarkup(result,markup);
      $('#merchant-error').textContent = '';
    } catch (error) {
      if (revision === sequence && $('#merchant-error')) $('#merchant-error').textContent = error.message;
    } finally {
      if (revision === sequence) busy = false;
    }
  }

  function render() {
    clearInterval(timer);
    sequence++;
    busy = false;
    if (owner !== context.user?.id) {
      owner = context.user?.id;
      page = 0;
      previousSection = null;
      stores = [];
      coupons = [];
      openOrderId = null;
      queueFilter = 'placed';
      activeOrders = [];
      productFilters.clear();
    }
    const currentSection = section();
    if (currentSection === 'pedidos') queueIdentity = null;
    if (previousSection !== currentSection) { page = 0; openOrderId = null; }
    previousSection = currentSection;
    const showStore = currentSection === 'pedidos' && context.user?.role === 'merchant';
    main.innerHTML = '<div class="wrap page merchant-workspace"><div class="section-head"><div>' +
      (showStore ? '<div id="merchant-store-identity"></div>' : '<span class="overline accent">ESTABELECIMENTO</span>') +
      '<h1>' + labels[currentSection] + '</h1></div></div><div id="merchant-body"></div></div>';
    const body = $('#merchant-body');
    if (context.user?.role !== 'merchant') {
      alerts.stop();
      body.innerHTML = '<div class="panel">' + empty(context.user ? 'Acesso restrito' : 'Entre para continuar',
        'Use o login e a senha do estabelecimento.','store') + '<button class="btn primary" ' +
        (context.user ? 'data-switch-account>Trocar de conta' : 'data-signin>Entrar') + '</button></div>';
      return;
    }
    alerts.start();
    let controls = '';
    if (currentSection === 'financeiro') {
      controls = '<form class="merchant-date-filter form-stack" id="finance-filter"><label>Período<select name="mode"><option value="day"' +
        (rangeMode === 'day' ? ' selected' : '') + '>Dia específico</option><option value="range"' +
        (rangeMode === 'range' ? ' selected' : '') + '>Intervalo de datas</option></select></label><label><span data-start-label>' +
        (rangeMode === 'day' ? 'Dia' : 'Data inicial') + '</span><input type="date" name="date_from" value="' + esc(fromDate) +
        '" required></label><label data-range-end' + (rangeMode === 'day' ? ' hidden' : '') +
        '>Data final<input type="date" name="date_to" value="' + esc(toDate) + '"></label><button class="btn primary" type="submit">Filtrar</button></form>' +
        '<p class="muted">Datas de entrega no horário de Brasília.</p>';
    }
    body.innerHTML = '<div id="merchant-billing-banner"></div>' + controls + '<p class="form-error" id="merchant-error" role="alert"></p>' +
      '<div id="merchant-results"><p class="muted">Carregando…</p></div>';
    if (currentSection === 'financeiro') {
      const form = $('#finance-filter');
      $('[name=mode]',form).onchange = event => {
        const range = event.target.value === 'range';
        $('[data-start-label]',form).textContent = range ? 'Data inicial' : 'Dia';
        $('[data-range-end]',form).hidden = !range;
        $('[name=date_to]',form).required = range;
      };
      form.onsubmit = async event => {
        event.preventDefault();
        const fields = new FormData(form);
        const mode = fields.get('mode');
        const from = fields.get('date_from');
        const to = mode === 'day' ? from : fields.get('date_to');
        if (!from || !to || to < from) {
          $('#merchant-error').textContent = 'Confira as datas do período.';
          return;
        }
        rangeMode = mode;
        fromDate = from;
        toDate = to;
        page = 0;
        const button = $('button[type=submit]',form);
        button.disabled = true;
        try { await refresh(true); } finally { button.disabled = false; }
      };
    }
    const result = $('#merchant-results');
    function filterProducts(shop,panel,changes) {
      const filters = {...productFilters.get(shop.id),...changes};
      productFilters.set(shop.id,filters);
      renderLiveMarkup($('[data-product-list]',panel),merchantProductRows(shop,filters));
    }
    if (currentSection === 'produtos') {
      result.oninput = event => {
        const input = event.target.closest('[data-product-search]');
        if (!input) return;
        const panel = input.closest('[data-product-shop]');
        const shop = stores.find(item => item.id === panel.dataset.productShop);
        if (shop) filterProducts(shop,panel,{query:input.value});
      };
      result.addEventListener('focusout',event => {
        const details = event.target.closest('.merchant-category-filter[open]');
        if (details && !details.contains(event.relatedTarget)) details.open = false;
      });
      result.addEventListener('keydown',event => {
        const details = event.target.closest('.merchant-category-filter[open]');
        if (event.key !== 'Escape' || !details) return;
        event.preventDefault();
        details.open = false;
        $('summary',details).focus();
      });
    }
    result.addEventListener('click',event => {
      const filter = event.target.closest('[data-queue-filter]');
      if (filter) {
        queueFilter = filter.dataset.queueFilter;
        openOrderId = null;
        renderLiveMarkup(result,queueMarkup());
        $('[data-queue-filter="' + queueFilter + '"]',result).focus();
        return;
      }
      const toggle = event.target.closest('[data-toggle-order]');
      if (!toggle) return;
      openOrderId = openOrderId === toggle.dataset.toggleOrder ? null : toggle.dataset.toggleOrder;
      for (const button of result.querySelectorAll('[data-toggle-order]')) {
        const expanded = button.dataset.toggleOrder === openOrderId;
        button.setAttribute('aria-expanded',String(expanded));
        button.textContent = expanded ? 'Recolher' : 'Visualizar';
        button.setAttribute('aria-label',(expanded ? 'Recolher' : 'Visualizar') + ' pedido #' + button.dataset.toggleOrder.slice(0,8));
        document.getElementById(button.getAttribute('aria-controls')).hidden = !expanded;
      }
    });
    if (currentSection === 'pedidos') bindTransitions(result,async ({id,status}) => {
      const showAccepted = status==='preparing' && section()==='pedidos' && context.user?.id===owner;
      if (showAccepted) { queueFilter='preparing'; openOrderId=id; }
      await refresh(true);
      if (status === 'delivered' || status === 'cancelled') alerts.sync();
      if (showAccepted && result.isConnected) {
        const detail=$('#merchant-order-' + id);
        detail?.closest('.order-card')?.scrollIntoView?.({behavior:'smooth',block:'nearest'});
        detail?.closest('.order-card')?.querySelector('[data-toggle-order]')?.focus({preventScroll:true});
      }
    },() => refresh(true));
    else result.onclick = async event => {
      const button = event.target.closest('button');
      if (!button || button.disabled) return;
      if ('productCategory' in button.dataset) {
        const panel = button.closest('[data-product-shop]');
        const shop = stores.find(item => item.id === panel.dataset.productShop);
        const category = button.dataset.productCategory;
        selectMerchantProductCategory(button.closest('details'),category);
        if (shop) filterProducts(shop,panel,{category});
        return;
      }
      if (button.dataset.newCoupon || button.dataset.editCoupon || button.dataset.toggleCoupon) {
        const coupon = coupons.find(item => item.id === (button.dataset.editCoupon || button.dataset.toggleCoupon));
        const shop = stores.find(item => item.id === (button.dataset.newCoupon || coupon?.store_id));
        if (!shop) return;
        if (!button.dataset.toggleCoupon) return couponForm(shop,coupon,() => refresh(true));
        button.disabled = true;
        try {
          await command('merchant_toggle_coupon',{ id:coupon.id,store_id:shop.id,enabled:!coupon.enabled });
          await refresh(true);
          toast(coupon.enabled ? 'Cupom pausado.' : 'Cupom ativado.');
        } catch (error) { toast(error.message); }
        finally { button.disabled = false; }
        return;
      }
      if (button.dataset.payInvoice) {
        const tab = window.open('about:blank','_blank');
        if (tab) tab.opener = null;
        button.disabled = true;
        try {
          const payment = await api('billing/checkout',{id:button.dataset.payInvoice});
          if (tab && !tab.closed) tab.location.replace(payment.checkoutUrl);
          else location.assign(payment.checkoutUrl);
        } catch(error) { if (tab) tab.close(); toast(error.message); }
        finally { if (button.isConnected) button.disabled = false; }
        return;
      }
      const store = stores.find(item => item.id === (button.dataset.settings || button.dataset.open || button.dataset.addProduct ||
        button.dataset.organizeCategories || button.dataset.organizeProducts || button.dataset.store));
      const refreshInventory = async () => { await refresh(true); alerts.sync(); };
      if (button.dataset.toggleProduct) {
        const id = button.dataset.toggleProduct;
        const product = store?.products.find(item => item.id === id);
        if (!product || pendingAvailability.has(id)) return;
        const panel = button.closest('[data-product-shop]');
        pendingAvailability.add(id);
        button.disabled = true;
        try {
          const saved = await command('set_product_availability',{store_id:store.id,id,active:!product.active});
          const currentStore = stores.find(item => item.id === store.id);
          const currentProduct = currentStore?.products.find(item => item.id === id);
          if (currentProduct) currentProduct.active = saved.active;
          if (currentProduct && panel.isConnected) filterProducts(currentStore,panel,{});
          else if (section() === 'produtos' && context.user?.id === owner) await refresh(true);
          toast(saved.active ? 'Produto disponível no cardápio.' : 'Produto indisponível no cardápio.');
        } catch (error) { toast(error.message); }
        finally { pendingAvailability.delete(id); button.disabled = false; }
        return;
      }
      if (button.dataset.adjustStock) {
        const product = store?.products.find(item => item.id === button.dataset.adjustStock);
        if (product) adjustStockForm(store,product,refreshInventory);
        return;
      }
      if (button.dataset.settings) storeSettings(store,() => refresh(true));
      if (button.dataset.organizeCategories) organizeMenuCategories(store,() => refresh(true));
      if (button.dataset.organizeProducts) organizeMenuProducts(store,() => refresh(true));
      if (button.dataset.addProduct) productForm(store,null,refreshInventory);
      if (button.dataset.editProduct) productForm(store,store.products.find(item => item.id === button.dataset.editProduct),refreshInventory);
      if (button.dataset.page !== undefined) {
        page = Number(button.dataset.page);
        openOrderId = null;
        await refresh(true);
        main.focus();
      }
      if (button.dataset.open) {
        button.disabled = true;
        try {
          await command('set_open',{store_id:store.id,open:!store.is_open});
          await refresh(true);
        } catch (error) { toast(error.message); } finally { button.disabled = false; }
      }
    };
    refresh(true);
    verifyReturn();
    if (['pedidos','faturas','estoque'].includes(currentSection)) timer = setInterval(() => { if (!document.hidden) refresh(); },6000);
  }
  function stop() { clearInterval(timer); sequence++; busy = false; closeMenu(); alerts.stop(); }
  return { render,openMenu,closeMenu,stop,openAlerts:alerts.open };
}
