import { $, esc, icon, command, modal, toast, bindSubmit, empty } from './shared.js';
import { percentage } from './invoices.js';

const date = day => day.split('-').reverse().join('/');
const time = minutes => minutes === 1440 ? '24:00' :
  [Math.floor(minutes / 60), minutes % 60].map(part => String(part).padStart(2,'0')).join(':');
const toMinutes = value => Number(value.slice(0,2)) * 60 + Number(value.slice(3));

export async function mountPromotionDays(root) {
  root.innerHTML = '<p class="muted">Carregando dias promocionais…</p>';
  function render(data) {
    if (!root.isConnected) return;
    root.innerHTML = '<section class="panel commission-settings"><h2>Desconto da plataforma</h2>' +
      '<p>Na data escolhida, a taxa global vira desconto automático nos produtos. Os pedidos feitos nesse dia ficam sem comissão.</p>' +
      '<p class="muted">Taxa atual <strong>' + percentage(data.commission_bps) + '</strong> · Horário de Brasília</p>' +
      '<form class="form-stack" id="promotion-day-form"><label>Data da promoção<input type="date" name="day" value="' + esc(data.today) + '" required></label>' +
      '<p class="form-error" data-form-error role="alert"></p><button class="btn primary" type="submit">Ativar dia promocional</button></form></section>' +
      '<section class="panel"><h2>Dias cadastrados</h2>' + (data.days.length ?
        data.days.map(entry => '<div class="promotion-row"><div><strong>' + date(entry.day) + '</strong><p class="muted">' +
          (entry.enabled ? entry.day < data.today ? 'Encerrado' : 'Ativo' : 'Pausado') +
          '</p></div><button class="btn outline" data-promotion-day="' + esc(entry.day) + '" data-enabled="' + !entry.enabled + '">' +
          (entry.enabled ? 'Pausar' : 'Ativar') + '</button></div>').join('') :
        '<p class="muted">Nenhuma data cadastrada.</p>') + '</section>';
    async function save(day, enabled) {
      render(await command('admin_save_promotion_day',{ day,enabled }));
      toast(enabled ? 'Dia promocional ativado.' : 'Dia promocional pausado.');
    }
    bindSubmit($('#promotion-day-form',root),fields => save(fields.get('day'),true));
    root.onclick = async event => {
      const button = event.target.closest('[data-promotion-day]');
      if (!button || button.disabled) return;
      button.disabled = true;
      try { await save(button.dataset.promotionDay,button.dataset.enabled === 'true'); }
      catch (error) { toast(error.message); }
      finally { button.disabled = false; }
    };
  }
  try { render(await command('admin_promotion_days')); }
  catch (error) {
    if (!root.isConnected) return;
    root.innerHTML = '<p class="form-error" role="alert">' + esc(error.message) + '</p><button class="btn outline" type="button">Tentar novamente</button>';
    $('button',root).onclick = () => mountPromotionDays(root);
  }
}

export function couponsMarkup(stores, coupons) {
  if (!stores.length) return '<div class="panel">' + empty('Nenhuma loja vinculada','Os cupons ficam disponíveis após o cadastro da loja.','store') + '</div>';
  return '<p class="muted">Crie um código e compartilhe com seus clientes. As datas e os horários seguem o horário de Brasília.</p>' +
    stores.map(store => {
      const items = coupons.filter(coupon => coupon.store_id === store.id);
      return '<section class="panel"><div class="section-head"><h2>' + esc(store.name) + '</h2><button class="btn primary" data-new-coupon="' +
        esc(store.id) + '">' + icon('plus') + ' Novo cupom</button></div>' + (items.length ? items.map(coupon =>
          '<article class="promotion-row"><div><strong>' + esc(coupon.code) + ' · ' + percentage(coupon.rate_bps) + '</strong><p>' +
          date(coupon.day) + ' · ' + time(coupon.start_minute) + '–' + time(coupon.end_minute) +
          '</p><p class="muted">' + (coupon.product_ids ? coupon.product_ids.length + ' produto(s) selecionado(s)' : 'Todos os produtos') +
          ' · ' + (coupon.enabled ? 'Habilitado' : 'Pausado') + '</p></div><div class="order-actions"><button class="btn outline" data-edit-coupon="' +
          esc(coupon.id) + '">Editar</button><button class="btn outline" data-toggle-coupon="' + esc(coupon.id) + '">' +
          (coupon.enabled ? 'Pausar' : 'Ativar') + '</button></div></article>').join('') :
        '<p class="muted">Nenhum cupom cadastrado.</p>') + '</section>';
    }).join('');
}

export function couponForm(store, coupon, done) {
  const today = new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo',dateStyle:'short'}).format(new Date());
  const el = modal(coupon ? 'Editar cupom' : 'Novo cupom',
    '<form class="form-stack" id="coupon-form"><label>Código do cupom<input name="code" required minlength="3" maxlength="24" pattern="[A-Za-z0-9_\\-]{3,24}" autocapitalize="characters" placeholder="Ex.: FLY10" value="' + esc(coupon?.code ?? '') +
    '"></label><label>Desconto (%)<input name="rate" type="number" required min="0.01" max="100" step="0.01" value="' + (coupon ? coupon.rate_bps / 100 : '') +
    '"></label><label>Data<input name="day" type="date" required value="' + esc(coupon?.day ?? today) + '"></label>' +
    '<div class="coupon-fields"><label>Começa às<input name="start" type="time" required value="' + time(coupon?.start_minute ?? 0) +
    '"></label><label>Termina às<input name="end" type="time" value="' + (coupon?.end_minute < 1440 ? time(coupon.end_minute) : '') + '"></label></div>' +
    '<p class="muted">Deixe o horário final em branco para valer até a meia-noite.</p>' +
    '<label>Produtos<select name="scope"><option value="all">Todos os produtos</option><option value="selected"' +
    (coupon?.product_ids ? ' selected' : '') + '>Produtos selecionados</option></select></label>' +
    '<fieldset class="coupon-products" data-coupon-products><legend>Escolha os produtos</legend>' +
    (store.products.length ? store.products.map(product =>
      '<label><input type="checkbox" name="product" value="' + esc(product.id) + '"' +
      (coupon?.product_ids?.includes(product.id) ? ' checked' : '') + '> ' + esc(product.name) + '</label>').join('') :
      '<p class="muted">Cadastre produtos para selecionar itens.</p>') + '</fieldset>' +
    '<label class="coupon-checkbox"><input type="checkbox" name="enabled"' + (coupon?.enabled !== false ? ' checked' : '') +
    '> Cupom habilitado</label><p class="form-error" data-form-error role="alert"></p><button class="btn primary" type="submit">Salvar cupom</button></form>',
    store.name);
  const form = $('#coupon-form',el);
  const scope = $('[name=scope]',form);
  const selected = $('[data-coupon-products]',form);
  scope.onchange = () => { selected.hidden = selected.disabled = scope.value === 'all'; };
  scope.onchange();
  bindSubmit(form,async fields => {
    const product_ids = fields.get('scope') === 'selected' ? fields.getAll('product') : null;
    if (product_ids?.length === 0) throw new Error('Selecione pelo menos um produto.');
    const start_minute = toMinutes(fields.get('start'));
    const end_minute = toMinutes(fields.get('end')) || 1440;
    if (end_minute <= start_minute) throw new Error('O horário final deve ser posterior ao inicial.');
    await command('merchant_save_coupon',{ id:coupon?.id,store_id:store.id,code:fields.get('code').toUpperCase(),
      rate_bps:Math.round(Number(fields.get('rate')) * 100),day:fields.get('day'),start_minute,end_minute,product_ids,enabled:fields.has('enabled') });
    if (form.isConnected) el.close();
    await done();
    toast('Cupom salvo.');
  });
}
