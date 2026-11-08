import { $, esc, icon, empty, modal, money, command, toast, bindSubmit, sortCategories } from './shared.js';

const available = product => Math.max(0,product.stock_quantity-(product.stock_reserved ?? 0));
export function inventoryMarkup(stores) {
  const tracked = stores.map(store => ({store,products:store.products.filter(product => product.stock_quantity != null)}))
    .filter(entry => entry.products.length);
  if (!tracked.length) return '<section class="panel">' + empty('Estoque ainda vazio','Ative o controle de estoque no cadastro ou na edição de um produto.','bag') +
    '<a class="btn outline" href="#produtos">Ir para produtos</a></section>';
  return '<p class="muted inventory-intro">Pedidos em andamento comprometem unidades. A baixa no saldo acontece na entrega.</p>' +
    tracked.map(({store,products}) => {
      const groups = new Map();
      for (const product of products) {
        const label = product.category || 'Sem categoria';
        if (!groups.has(label)) groups.set(label,[]);
        groups.get(label).push(product);
      }
      const categories = sortCategories([...groups.keys()].filter(label => label !== 'Sem categoria'));
      if (groups.has('Sem categoria')) categories.push('Sem categoria');
      return '<section class="inventory-store"><h2>' + esc(store.name) + '</h2>' + categories.map(label =>
        '<div class="inventory-group"><h3>' + esc(label) + '</h3><div class="inventory-grid">' + groups.get(label).map(product => {
          const units = available(product);
          const severity = units === 0 ? 'empty' : units <= 5 ? 'low' : 'ok';
          const status = units === 0 ? 'Sem saldo disponível' : units <= 5 ? 'Estoque baixo' : 'Estoque em dia';
          return '<article class="panel inventory-card inventory-' + severity + '"><div class="inventory-card-head"><h4>' + esc(product.name) +
            '</h4><span class="inventory-status">' + status + '</span></div><dl><div><dt>Em estoque</dt><dd>' + product.stock_quantity +
            '</dd></div><div><dt>Em pedidos</dt><dd>' + (product.stock_reserved ?? 0) + '</dd></div><div><dt>Disponível</dt><dd>' + units +
            '</dd></div></dl><button type="button" class="btn outline" data-adjust-stock="' + esc(product.id) + '" data-store="' +
            esc(store.id) + '">Ajustar saldo</button></article>';
        }).join('') + '</div></div>').join('') + '</section>';
    }).join('');
}

export function adjustStockForm(store,product,done) {
  const el = modal('Ajustar saldo','<form class="form-stack" id="stock-adjust"><label>Quantidade física em estoque' +
    '<input name="stock_quantity" type="number" min="' + (product.stock_reserved ?? 0) + '" max="1000000" step="1" required value="' +
    product.stock_quantity + '"></label><p class="muted">Unidades comprometidas com pedidos em andamento: ' + (product.stock_reserved ?? 0) +
    '.</p><p class="form-error" data-form-error role="alert"></p><button class="btn primary wide" type="submit">Salvar saldo</button></form>',product.name);
  bindSubmit($('#stock-adjust',el),async fields => {
    await command('merchant_adjust_stock',{store_id:store.id,id:product.id,stock_quantity:Number(fields.get('stock_quantity')),stock_expected:product.stock_quantity});
    el.close();
    toast('Estoque atualizado.');
    await done();
  });
}

const dateLabel = value => value.split('-').reverse().join('/');
export function createMerchantAlerts(context) {
  let data;
  let pending;
  let actor;
  let panel;
  let timer;

  function badge() {
    const button = $('[data-merchant-alerts]');
    if (!button) return;
    const count = data?.count ?? 0;
    const label = $('[data-merchant-alert-count]',button);
    label.textContent = count > 99 ? '99+' : String(count);
    label.hidden = count === 0;
    button.setAttribute('aria-label',count ? 'Notificações (' + count + ' pendentes)' : 'Notificações');
  }

  function draw() {
    if (!panel?.isConnected || !$('#dialog').open || !data) return;
    panel.innerHTML = data.count ? '<div class="notice-list">' + data.invoices.map(invoice =>
      '<a class="notice-card" href="#faturas"><span class="notice-icon">' + icon('shield') + '</span><span class="notice-copy">' +
      '<span class="overline">Fatura pendente</span><strong>' + money(invoice.amount_cents) + ' · ' + esc(invoice.store_name) +
      '</strong><small>Fatura de ' + dateLabel(invoice.invoice_date) + '</small></span><span class="notice-unread"></span></a>').join('') +
      data.stock.map(item => '<a class="notice-card" href="#estoque"><span class="notice-icon">' + icon('bag') + '</span><span class="notice-copy">' +
        '<span class="overline">' + (item.available === 0 ? 'Sem saldo disponível' : 'Estoque baixo') + '</span><strong>' + esc(item.name) +
        '</strong><small>' + esc(item.store_name) + ' · ' + item.available + ' disponível(is)</small></span><span class="notice-unread"></span></a>').join('') +
      '</div>' : empty('Tudo em dia','Faturas pendentes e avisos de estoque aparecem aqui.','bell');
  }

  function refresh() {
    if (!actor || context.user?.id !== actor || pending) return pending;
    const current = actor;
    const request = command('merchant_alerts').then(result => {
      if (actor !== current || context.user?.id !== current) return;
      const changed = JSON.stringify(data) !== JSON.stringify(result);
      data = result;
      badge();
      if (changed) draw();
    }).catch(error => {
      if (!data && panel?.isConnected && $('#dialog').open) panel.textContent = error.message;
    }).finally(() => { if (pending === request) pending = null; });
    pending = request;
    return request;
  }

  function open() {
    const el = modal('Notificações','<div class="customer-notice-panel"><p class="muted">Carregando notificações…</p></div>');
    panel = $('.customer-notice-panel',el);
    panel.onclick = event => { if (event.target.closest('a')) el.close(); };
    draw();
    refresh();
  }

  function stop() {
    clearInterval(timer);
    actor = undefined;
    pending = undefined;
    data = undefined;
    panel = undefined;
  }

  function start() {
    if (actor !== context.user?.id) {
      stop();
      actor = context.user?.id;
      timer = setInterval(() => { if (!document.hidden) refresh(); },15000);
    }
    badge();
    refresh();
  }

  async function sync() { await pending; return refresh(); }

  return {start,stop,open,sync};
}
