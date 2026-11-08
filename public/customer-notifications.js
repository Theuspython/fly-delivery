import { $, esc, icon, command, modal, empty } from './shared.js';
import { percentage } from './invoices.js';

const dateLabel = day => day.split('-').reverse().join('/');

function noticeCard(item) {
  const isCoupon = item.kind === 'coupon';
  const href = isCoupon ? '#loja/' + item.store_id : '#historico/' + item.id;
  const products = item.products ?? [];
  const scope = item.product_count
    ? products.join(', ') + (item.product_count > products.length ? ' e mais ' + (item.product_count-products.length) : '')
    : 'Cardápio inteiro';
  const body = isCoupon
    ? '<span class="notice-coupon-code">' + esc(item.code) + '</span><small>' + percentage(item.rate_bps) + ' de desconto · ' +
      esc(scope) + '</small><small>' + esc(dateLabel(item.day)) + '</small>'
    : '<small>Conte como foi sua experiência · Pedido #' + esc(item.id.slice(0,8)) + '</small>';
  return '<a class="notice-card" href="' + esc(href) + '"' +
    (isCoupon && item.unread ? ' data-coupon-id="' + esc(item.id) + '" data-notice-id="' + esc(item.notice_id) + '"' : '') +
    '><span class="notice-icon notice-icon-' + (isCoupon ? 'coupon' : 'review') + '">' + icon(isCoupon ? 'tag' : 'star') +
    '</span><span class="notice-copy"><span class="overline">' + (isCoupon ? 'Cupom disponível' : 'Avaliação pendente') +
    '</span><strong>' + esc(item.store_name) + '</strong>' + body + '</span>' +
    (item.unread ? '<span class="notice-unread" aria-label="Pendente"></span>' : '') + '</a>';
}

export function customerNotifications() {
  let latest;
  let request;
  let stopped = false;
  let panel;
  let items = [];
  let page = 0;
  let hasMore = false;
  let opening = 0;
  let waitingForPanel = false;

  function updateBadge() {
    const button = $('[data-notifications]');
    if (!button) return;
    const badge = $('[data-notification-count]',button);
    const amount = latest?.unread ?? 0;
    badge.hidden = amount === 0;
    badge.textContent = amount > 99 ? '99+' : String(amount);
    button.setAttribute('aria-label',amount ? 'Notificações (' + amount + ' pendentes)' : 'Notificações');
  }

  function draw() {
    if (!panel?.isConnected || !$('#dialog').open) return;
    panel.innerHTML = items.length ? '<div class="notice-list">' + items.map(noticeCard).join('') + '</div>' :
      empty('Tudo em dia','Cupons disponíveis e pedidos para avaliar aparecem aqui.','bell');
    if (hasMore) {
      panel.insertAdjacentHTML('beforeend','<button class="btn outline wide" type="button" data-more-notices>Ver mais</button>');
      $('[data-more-notices]',panel).onclick = loadMore;
    }
  }

  async function loadMore(event) {
    const button = event.currentTarget;
    const version = opening;
    const next = page + 1;
    button.disabled = true;
    try {
      const data = await command('customer_notifications',{page:next});
      if (stopped || version !== opening || !button.isConnected) return;
      const seen = new Set(items.map(item => item.kind + ':' + item.id));
      items.push(...data.items.filter(item => !seen.has(item.kind + ':' + item.id)));
      hasMore = data.has_more;
      page = next;
      draw();
      ($('[data-more-notices]',panel) ?? $('.notice-card:last-child',panel))?.focus({preventScroll:true});
    } catch {
      button.textContent = 'Tentar novamente';
    } finally { button.disabled = false; }
  }

  function refresh() {
    if (stopped || request) return request;
    request = command('customer_notifications').then(data => {
      if (stopped) return;
      const changed = JSON.stringify(latest) !== JSON.stringify(data);
      latest = data;
      updateBadge();
      if (changed || waitingForPanel) {
        waitingForPanel = false;
        opening++;
        items = [...data.items];
        page = 0;
        hasMore = data.has_more;
        draw();
      }
    }).catch(() => {
      if (stopped || !waitingForPanel || !panel?.isConnected || !$('#dialog').open) return;
      panel.innerHTML = '<p class="muted">Não foi possível carregar as notificações.</p><button class="btn outline" type="button">Tentar novamente</button>';
      $('button',panel).onclick = refresh;
    }).finally(() => { request = null; });
    return request;
  }

  function open() {
    const dialog = modal('Notificações','<div class="customer-notice-panel"><p class="muted">Carregando notificações…</p></div>');
    panel = $('.customer-notice-panel',dialog);
    opening++;
    waitingForPanel = true;
    panel.onclick = async event => {
      const link = event.target.closest('.notice-card');
      if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      dialog.close();
      if (!link.dataset.couponId) return;
      try {
        await command('customer_read_coupon_notice',{coupon_id:link.dataset.couponId,notice_id:link.dataset.noticeId});
        sync();
      } catch { /* The coupon stays pending until the read can be saved. */ }
    };
    refresh();
  }

  async function sync() {
    await request;
    return refresh();
  }

  const poll = setInterval(() => { if (!document.hidden) refresh(); },15000);
  const refreshOnFocus = () => { if (!document.hidden) refresh(); };
  window.addEventListener('focus',refreshOnFocus);
  refresh();
  return {open,sync,updateBadge,stop() {
    stopped = true;
    clearInterval(poll);
    window.removeEventListener('focus',refreshOnFocus);
  }};
}
