export const $ = (selector, root = document) => root.querySelector(selector);
export const main = $('#main');
export const dialog = $('#dialog');
export const categories = [
  ['Todas','grid'], ['Hambúrguer','burger'], ['Pizza','pizza'], ['Japonesa','sushi'],
  ['Brasileira','bowl'], ['Açaí','cup'], ['Telecerveja','beer'], ['Marmitex','bowl'], ['Outros','spark']
];
export const money = value => new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL' }).format(value / 100);
export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
})[char]);
export const statuses = {
  placed:'Pedido recebido', preparing:'Pedido em produção', ready:'Pronto · confirmar saída',
  assigned:'Pronto · confirmar saída', picked_up:'Saiu para entrega', delivered:'Entregue', cancelled:'Cancelado'
};
export const payments = { pix_delivery:'Pix na entrega', card_delivery:'Cartão na entrega', cash_delivery:'Dinheiro na entrega' };
export const fallbackImages = {
  Hambúrguer:'/assets/burger.webp', Pizza:'/assets/pizza.webp', Japonesa:'/assets/sushi.webp',
  Brasileira:'/assets/bowl.webp', Açaí:'/assets/bowl.webp', Telecerveja:'/assets/icon.svg', Marmitex:'/assets/bowl.webp'
};
const icons = {
  pin:'<path d="M20 10c0 5-8 11-8 11s-8-6-8-11a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  search:'<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  bag:'<path d="M5 8h14l1 13H4L5 8Z"/><path d="M9 10V6a3 3 0 0 1 6 0v4"/>',
  home:'<path d="m3 10 9-7 9 7v11h-6v-7H9v7H3V10Z"/>',
  person:'<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2"/>',
  arrow:'<path d="M4 12h15m-6-6 6 6-6 6"/>',
  back:'<path d="M20 12H5m6-6-6 6 6 6"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bike:'<circle cx="5" cy="17" r="3"/><circle cx="19" cy="17" r="3"/><path d="m5 17 5-8 4 8h5l-4-11h3M9 9H6"/>',
  grid:'<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  burger:'<path d="M4 10a8 6 0 0 1 16 0H4Zm0 4h16M4 18h16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/>',
  pizza:'<path d="M12 21 3 7a16 16 0 0 1 18 0L12 21ZM5 10a13 13 0 0 1 14 0m-8 2h.01m3 3h.01"/>',
  sushi:'<ellipse cx="12" cy="7" rx="8" ry="3.5"/><path d="M4 7v10c0 2 3.6 3.5 8 3.5s8-1.5 8-3.5V7m-9 0h2"/>',
  bowl:'<path d="M3 11h18a9 9 0 0 1-18 0Zm5 9h8M7 6l2 2m3-4v4m5-2-2 2"/>',
  beer:'<path d="M5 8h11v12H5V8Zm11 2h2a3 3 0 0 1 0 6h-2M8 11v6m5-6v6"/><path d="M5 8a3 3 0 0 1 0-6 3 3 0 0 1 5-1 3 3 0 0 1 5 2 3 3 0 0 1 1 5"/>',
  cup:'<path d="M6 8h12l-2 13H8L6 8Zm-2 0h16m-8 0 2-5h4"/>',
  spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  minus:'<path d="M5 12h14"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  chevron:'<path d="m8 10 4 4 4-4"/>',
  store:'<path d="M4 10v10h16V10M3 10l2-6h14l2 6a3 3 0 0 1-5 2 3 3 0 0 1-4 0 3 3 0 0 1-4 0 3 3 0 0 1-5-2Zm7 10v-5h4v5"/>',
  shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  location:'<circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  install:'<path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4"/>',
  more:'<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  menu:'<path d="M5 7h14M5 12h14M5 17h14"/>'
};
export const icon = name => '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (icons[name] ?? icons.spark) + '</svg>';

let refresh;
export async function api(path, data, retry = true) {
  const upload = data instanceof File;
  const response = await fetch('/api/' + path, data === undefined ? {} : {
    method:'POST', headers:{ 'Content-Type':upload ? data.type : 'application/json', 'X-FD-App':location.pathname.split('/')[1] || 'cliente' },
    body:upload ? data : JSON.stringify(data)
  });
  if (response.status === 401 && retry && (path === 'command' || path === 'provision' || path === 'change-password' || path === 'upload-profile' || path.startsWith('upload?'))) {
    refresh ??= api('refresh', {}, false).finally(() => { refresh = null; });
    await refresh;
    return api(path, data, false);
  }
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error ?? 'Algo deu errado.'), { status:response.status });
  return result;
}
export const command = (action, input = {}) => api('command', { action, input });

let notice;
export function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(notice);
  notice = setTimeout(() => el.classList.remove('visible'), 4200);
}

export function modal(title, body, description = '') {
  if (dialog.open) dialog.close();
  dialog.innerHTML = '<div class="dialog-head"><div><h2 id="dialog-title">' + esc(title) + '</h2>' +
    (description ? '<p>' + esc(description) + '</p>' : '') + '</div><button class="icon-button" data-close aria-label="Fechar">' + icon('close') + '</button></div>' + body;
  dialog.showModal();
  return dialog;
}
dialog.addEventListener('click', event => {
  if (event.target.closest('[data-close]') || event.target === dialog) dialog.close();
});

export function bindSubmit(form, fn) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('button[type="submit"]', form);
    if (button.disabled) return;
    button.disabled = true;
    const error = $('[data-form-error]', form);
    if (error) error.textContent = '';
    try {
      await fn(new FormData(form));
    } catch (err) {
      if (error) error.textContent = err.message;
      else toast(err.message);
    } finally {
      button.disabled = false;
    }
  });
}

export function empty(title, copy, symbol = 'bag') {
  return '<div class="empty"><div class="empty-icon">' + icon(symbol) + '</div><h3>' + esc(title) + '</h3><p>' + esc(copy) + '</p></div>';
}

export function profileAvatar(photo, name, scope = 'cliente', large = false) {
  const valid = typeof photo === 'string' && /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/.test(photo);
  const parts = (String(name || '').trim() || 'Cliente').split(/\s+/);
  const initials = (parts[0][0] + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase();
  return '<span class="profile-avatar' + (large ? ' profile-avatar-large' : '') + '" aria-hidden="true" data-initials="' + esc(initials) + '">' +
    (valid ? '<img src="/api/profile-photo?scope=' + (scope === 'loja' ? 'loja' : 'cliente') + '&amp;path=' +
      encodeURIComponent(photo) + '" alt="" loading="lazy">' : esc(initials)) + '</span>';
}

export function orderCard(order, actions = '', options = {}) {
  const details = '<p>' + (order.items ?? []).map(item => item.quantity + '× ' + esc(item.name)).join(' · ') + '</p>' +
    (options.address ? '<p>' + icon('pin') + ' ' + esc(order.address) + '</p>' : '') +
    '<p>' + esc(payments[order.payment]) + '</p>';
  const customer = options.customer ? '<p class="order-customer"><strong>' + esc(order.customer_name || 'Cliente') + '</strong></p>' : '';
  const stages = ['placed','preparing','picked_up','delivered'];
  const stageLabels = ['Recebido','Em produção','Saiu para entrega','Entregue'];
  const currentStage = stages.indexOf(['ready','assigned'].includes(order.status) ? 'preparing' : order.status);
  const progress = options.progress && order.status !== 'cancelled'
    ? '<ol class="order-progress" aria-label="Etapas do pedido">' + stages.map((stage,index) =>
      '<li class="' + (index < currentStage ? 'done' : index === currentStage ? 'current' : 'waiting') + '"' +
      (index === currentStage ? ' aria-current="step"' : '') + '><span>' + (index < currentStage ? icon('check') : index+1) +
      '</span>' + stageLabels[index] + '</li>').join('') + '</ol>' : '';
  const timeline = options.timeline && order.events?.length
    ? '<ol class="order-timeline" aria-label="Andamento do pedido">' + order.events.map(event =>
      '<li><span>' + esc(statuses[event.status]) + '</span><time datetime="' + esc(event.created_at) + '">' +
      new Intl.DateTimeFormat('pt-BR',{hour:'2-digit',minute:'2-digit'}).format(new Date(event.created_at)) + '</time></li>').join('') + '</ol>'
    : '';
  const body = progress + '<div class="order-body">' + details +
    '<strong>' + money(order.subtotal + order.fee) +
    '</strong></div>' + timeline + (actions ? '<div class="order-actions">' + actions + '</div>' : '');
  if (options.compact) {
    const detailsId = (options.customerView ? 'customer-order-' : 'merchant-order-') + order.id;
    const expanded = Boolean(options.expanded);
    return '<article class="order-card compact-order order-stage-' + esc(order.status) + '"><div class="compact-order-head">' +
      '<div class="compact-order-identity">' + (options.customerView ? '' : profileAvatar(order.customer_photo,order.customer_name,'loja')) + '<div><span class="overline">Pedido #' + esc(order.id.slice(0,8)) + '</span><h3>' +
      esc(options.customerView ? order.store : order.customer_name || 'Cliente') + '</h3></div></div><div class="compact-order-controls"><span class="status status-' +
      esc(order.status) + '">' + esc(statuses[order.status]) + '</span>' +
      '<button class="btn outline" data-toggle-order="' + esc(order.id) + '" aria-controls="' + esc(detailsId) +
      '" aria-expanded="' + expanded + '" aria-label="' + (expanded ? 'Recolher' : 'Visualizar') + ' pedido #' +
      esc(order.id.slice(0,8)) + '">' + (expanded ? 'Recolher' : 'Visualizar') + '</button></div></div>' +
      '<div class="compact-order-details" id="' + esc(detailsId) + '"' + (expanded ? '' : ' hidden') + '>' + body + '</div></article>';
  }
  return '<article class="order-card' + (options.progress ? ' order-stage-' + esc(order.status) : '') + '"><div class="order-head"><div><span class="overline">#' + esc(order.id.slice(0,8)) +
    '</span><h3>' + esc(order.store) + '</h3></div><span class="status status-' + esc(order.status) + '">' +
    esc(statuses[order.status]) + '</span></div>' + customer + body + '</article>';
}

export const transitionButton = (order, status, label, className = 'primary') =>
  '<button class="btn ' + className + '" data-transition="' + esc(status) + '" data-id="' + esc(order.id) + '">' + esc(label) + '</button>';

export function bindTransitions(root, onSuccess, onError = () => {}) {
  root.onclick = async event => {
    const button = event.target.closest('[data-transition]');
    if (!button || button.disabled) return;
    if (button.dataset.transition === 'cancelled' && !window.confirm('Cancelar este pedido?')) return;
    button.disabled = true;
    try {
      await command('transition', { id:button.dataset.id, status:button.dataset.transition });
      await onSuccess();
    } catch (error) {
      toast(error.message);
      onError();
    } finally {
      button.disabled = false;
    }
  };
}
