import { $, main, esc, icon, money, api, command, empty, orderCard, transitionButton, bindTransitions, toast } from './shared.js';
import { invoicesMarkup, suspensionBanner } from './invoices.js';
import { productForm, storeSettings, storeMarkup } from './operations.js';

const sections = [
  ['faturas','Faturas Fly Delivery','shield'],
  ['pedidos','Pedidos em andamento','bag'],
  ['produtos','Cadastro de produtos','burger'],
  ['finalizados','Pedidos finalizados','check'],
  ['financeiro','Financeiro','grid'],
  ['perfil','Perfil da loja','store']
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
    address:true,progress:true,timeline:!active,compact:true,expanded:order.id === openOrderId
  })).join('') + '</div>';

function pagination(data) {
  if (data.pages <= 1) return '';
  return '<nav class="merchant-pagination" aria-label="Páginas"><button class="btn outline" data-page="' +
    (data.page-1) + '"' + (data.page === 0 ? ' disabled' : '') + '>Anterior</button><span>Página ' + (data.page+1) +
    ' de ' + data.pages + '</span><button class="btn outline" data-page="' + (data.page+1) + '"' +
    (data.page+1 >= data.pages ? ' disabled' : '') + '>Próxima</button></nav>';
}

function financeMarkup(data) {
  const summary = '<div class="finance-summary">' + [
    ['Pedidos entregues',String(data.count)],
    ['Vendas em produtos',money(data.products)],
    ['Taxas de entrega',money(data.delivery)],
    ['Total dos pedidos',money(data.total)]
  ].map(([label,value]) => '<article class="panel"><p>' + label + '</p><strong>' + value + '</strong></article>').join('') +
    '</div><p class="muted finance-note">Pedidos entregues entre ' + dateLabel(data.date_from) + ' e ' + dateLabel(data.date_to) +
    '. Valores registrados no pedido, com a entrega separada dos produtos.</p>';
  if (!data.count) return summary + '<div class="panel">' + empty('Nenhuma venda concluída','As vendas aparecerão após a confirmação da entrega.','grid') + '</div>';
  return summary + '<div class="panel"><h2>Vendas por dia</h2><div class="merchant-table-scroll"><table class="merchant-table">' +
    '<thead><tr><th>Dia</th><th>Pedidos</th><th>Produtos</th><th>Entrega</th><th>Total</th></tr></thead><tbody>' +
    data.days.map(day => '<tr><td>' + dateLabel(day.day) + '</td><td>' + day.amount + '</td><td>' +
      money(day.products) + '</td><td>' + money(day.delivery) + '</td><td>' + money(day.total) + '</td></tr>').join('') +
    '</tbody></table></div></div><div class="panel finance-ledger"><h2>Pedidos do período</h2><div class="merchant-table-scroll">' +
    '<table class="merchant-table"><thead><tr><th>Pedido</th><th>Cliente</th><th>Entregue em</th><th>Produtos</th><th>Entrega</th><th>Total</th></tr></thead><tbody>' +
    data.orders.map(order => '<tr><td>#' + esc(order.id.slice(0,8)) + '</td><td>' +
      esc(order.customer_name) + '</td><td>' + timestamp(order.completed_at) + '</td><td>' + money(order.subtotal) +
      '</td><td>' + money(order.fee) + '</td><td>' + money(order.subtotal+order.fee) + '</td></tr>').join('') +
    '</tbody></table></div>' + pagination(data) + '</div>';
}

export function merchant(context) {
  let timer;
  let sequence = 0;
  let busy = false;
  let stores = [];
  let historyStatus = 'delivered';
  let openOrderId = null;
  let queueFilter = 'placed';
  let activeOrders = [];
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
  const section = () => labels[location.hash.slice(1)] ? location.hash.slice(1) : 'pedidos';

  function closeMenu() { if (drawer?.open) drawer.close(); }

  async function verifyReturn() {
    if (!paymentReturn || returning || context.user?.role !== 'merchant') return;
    returning = true;
    try {
      if (returnFields.transaction_nsu && (returnFields.slug || returnFields.invoice_slug) && returnFields.order_nsu) {
        const result = await api('billing/verify',returnFields);
        toast(result.paid ? 'Pagamento confirmado. Obrigado!' : 'Pagamento ainda não confirmado. Aguarde e atualize as faturas.');
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
        if (event.target === drawer || event.target.closest('[data-close-menu]') || event.target.closest('a')) drawer.close();
      });
      drawer.addEventListener('close',() => $('[data-merchant-menu]')?.setAttribute('aria-expanded','false'));
    }
    drawer.innerHTML = '<div class="dialog-head"><div><span class="overline accent">FLY DELIVERY</span><h2 id="merchant-menu-title">Estabelecimento</h2></div>' +
      '<button class="icon-button" data-close-menu aria-label="Fechar menu">' + icon('close') + '</button></div>' +
      '<nav aria-label="Áreas do estabelecimento">' + sections.map(([key,label,symbol]) =>
        '<a href="#' + key + '"' + (section() === key ? ' aria-current="page"' : '') + '>' + icon(symbol) + label + '</a>').join('') + '</nav>';
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
          'Os novos pedidos chegam aqui. Pedidos entregues ficam em Pedidos finalizados.') + '</div>');
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
      if (banner) banner.innerHTML = suspensionBanner(billingStatus.stores);
      let markup;
      if (currentSection === 'faturas') {
        const data = await command('merchant_invoices',{page});
        markup = invoicesMarkup(data) + pagination(data);
      } else if (currentSection === 'pedidos') {
        const orders = await command('merchant_active_orders');
        if (revision !== sequence || context.user !== user || currentSection !== section()) return;
        activeOrders = orders;
        markup = queueMarkup();
      } else if (currentSection === 'finalizados') {
        const data = await command('merchant_history',{ status:historyStatus,page });
        if (revision !== sequence || context.user !== user || currentSection !== section()) return;
        if (openOrderId && !data.orders.some(order => order.id === openOrderId)) openOrderId = null;
        markup = data.count ? cards(data.orders,false,openOrderId) + pagination(data) : '<div class="panel">' +
          empty('Nenhum pedido neste filtro','Os pedidos saem da tela inicial quando são entregues ou cancelados.') + '</div>';
      } else if (currentSection === 'financeiro') {
        const data = await command('merchant_finance',{ date_from:fromDate,date_to:toDate,page });
        markup = financeMarkup(data);
      } else {
        stores = await command('managed_stores');
        markup = stores.length ? '<div class="management-grid">' + stores.map(store =>
          currentSection === 'produtos' ? storeMarkup(store,'merchant',true) :
            '<article class="panel merchant-profile">' +
            (store.image ? '<img src="' + esc(store.image) + '" alt="Foto de ' + esc(store.name) + '">' : '') +
            '<h2>' + esc(store.name) + '</h2><p>' + esc(store.categories.join(' · ')) +
            '</p><p class="muted">' + esc(store.address || 'Configure o endereço para publicar a loja.') + '</p>' +
            '<div class="order-actions"><button class="btn primary" data-settings="' + esc(store.id) +
            '">Foto, horários e entrega</button>' + (store.address ? '<button class="btn outline" data-open="' + esc(store.id) +
            '">' + (store.is_open ? 'Pausar pedidos' : 'Ativar pedidos') + '</button>' : '') + '</div></article>'
        ).join('') + '</div>' : '<div class="panel">' + empty('Nenhuma loja vinculada','A administração pode criar o acesso ao estabelecimento.','store') + '</div>';
      }
      if (revision !== sequence || context.user !== user || currentSection !== section() || !result?.isConnected) return;
      if (result.innerHTML !== markup) result.innerHTML = markup;
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
      openOrderId = null;
      queueFilter = 'placed';
      activeOrders = [];
    }
    const currentSection = section();
    if (previousSection !== currentSection) { page = 0; openOrderId = null; }
    previousSection = currentSection;
    main.innerHTML = '<div class="wrap page merchant-workspace"><div class="section-head"><div><span class="overline accent">ESTABELECIMENTO</span>' +
      '<h1>' + labels[currentSection] + '</h1></div></div><div id="merchant-body"></div></div>';
    const body = $('#merchant-body');
    if (context.user?.role !== 'merchant') {
      body.innerHTML = '<div class="panel">' + empty(context.user ? 'Acesso restrito' : 'Entre para continuar',
        'Use o login e a senha do estabelecimento.','store') + '<button class="btn primary" ' +
        (context.user ? 'data-switch-account>Trocar de conta' : 'data-signin>Entrar') + '</button></div>';
      return;
    }
    let controls = '';
    if (currentSection === 'finalizados') {
      controls = '<label class="merchant-history-filter">Mostrar<select id="history-status">' +
        [['delivered','Entregues'],['cancelled','Cancelados'],['all','Todos finalizados']].map(([value,label]) =>
          '<option value="' + value + '"' + (value === historyStatus ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></label>';
    }
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
    if (currentSection === 'finalizados') $('#history-status').onchange = async event => {
      historyStatus = event.target.value;
      page = 0;
      openOrderId = null;
      await refresh(true);
    };
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
    result.addEventListener('click',event => {
      const filter = event.target.closest('[data-queue-filter]');
      if (filter) {
        queueFilter = filter.dataset.queueFilter;
        openOrderId = null;
        result.innerHTML = queueMarkup();
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
    if (currentSection === 'pedidos') bindTransitions(result,() => refresh(true),() => refresh(true));
    else result.onclick = async event => {
      const button = event.target.closest('button');
      if (!button || button.disabled) return;
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
      const store = stores.find(item => item.id === (button.dataset.settings || button.dataset.open || button.dataset.addProduct || button.dataset.store));
      if (button.dataset.settings) storeSettings(store,() => refresh(true));
      if (button.dataset.addProduct) productForm(store,null,() => refresh(true));
      if (button.dataset.editProduct) productForm(store,store.products.find(item => item.id === button.dataset.editProduct),() => refresh(true));
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
    if (['pedidos','faturas'].includes(currentSection)) timer = setInterval(() => { if (!document.hidden) refresh(); },6000);
  }
  return { render,openMenu,closeMenu };
}
