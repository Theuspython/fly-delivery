import { $, esc, icon, empty, modal, command, toast, bindSubmit } from './shared.js';
import { percentage } from './invoices.js';

const dateLabel = value => value.split('-').reverse().join('/');

export function mountPlatformCoupons(root) {
  let current;
  async function refresh() {
    try {
      const data = await command('admin_platform_coupons');
      if (!root.isConnected) return;
      current = data;
      draw(data);
    } catch (error) {
      if (root.isConnected) root.innerHTML = '<p class="form-error" role="alert">' + esc(error.message) + '</p>';
    }
  }

  function draw(data) {
    const max = data.commission_bps ?? 0;
    root.innerHTML = '<section class="panel"><div class="section-head"><div><h2>Cupons da plataforma</h2>' +
      '<p class="muted">Comissão atual <strong>' + percentage(data.commission_bps) + '</strong></p></div>' +
      '<button type="button" class="btn primary" data-new-platform-coupon' + (max ? '' : ' disabled') + '>' + icon('plus') + ' Novo cupom</button></div>' +
      '<p>O desconto nos produtos sai da comissão da plataforma. A validade termina no fim do dia escolhido, no horário de Brasília.</p>' +
      (!data.payments_ready ? '<p class="muted">Os cupons ficam disponíveis para uso quando a cobrança da plataforma estiver habilitada.</p>' : '') + '</section>' +
      (data.coupons.length ? '<div class="platform-coupon-list">' + data.coupons.map(coupon => {
        const status = !coupon.enabled ? 'Suspenso' : coupon.expires_on < data.today ? 'Expirado' :
          coupon.rate_bps > max ? 'Acima da comissão atual' : coupon.use_limit != null && coupon.use_count >= coupon.use_limit ? 'Limite atingido' :
          data.payments_ready ? 'Ativo' : 'Aguardando cobrança';
        return '<article class="panel platform-coupon-card"><div class="section-head"><div><h3>' + esc(coupon.code) + '</h3>' +
          '<p>' + percentage(coupon.rate_bps) + ' · ' + esc(coupon.store_name || 'Todas as lojas') + '</p></div><span class="status">' + status +
          '</span></div><p class="muted">Válido até ' + dateLabel(coupon.expires_on) + ' · ' + coupon.use_count + ' uso(s)' +
          (coupon.use_limit == null ? ' · Sem limite' : ' de ' + coupon.use_limit) + '</p><div class="order-actions">' +
          '<button type="button" class="btn outline" data-edit-platform-coupon="' + esc(coupon.id) + '">Editar</button>' +
          '<button type="button" class="btn outline" data-toggle-platform-coupon="' + esc(coupon.id) + '">' + (coupon.enabled ? 'Suspender' : 'Reativar') + '</button>' +
          '<button type="button" class="btn outline" data-delete-platform-coupon="' + esc(coupon.id) + '">Excluir</button></div></article>';
      }).join('') + '</div>' : '<div class="panel">' + empty('Nenhum cupom da plataforma','Crie um código para uma loja ou para todas.','tag') + '</div>');
  }

  function edit(coupon) {
    const max = (current.commission_bps ?? 0)/100;
    const missingStore = coupon?.store_id && !current.stores.some(store => store.id === coupon.store_id);
    const el = modal(coupon ? 'Editar cupom' : 'Criar cupom de desconto','<form class="form-stack" id="platform-coupon-form">' +
      '<label>Código<input name="code" autocomplete="off" autocapitalize="characters" minlength="3" maxlength="24" required value="' + esc(coupon?.code) +
      '"></label><label>Desconto (%)<input type="number" name="rate" min="0.01" max="' + max + '" step="0.01" required value="' +
      (coupon ? coupon.rate_bps/100 : '') + '"></label><label>Estabelecimento<select name="store_id"><option value="">Todas as lojas</option>' +
      (missingStore ? '<option value="' + esc(coupon.store_id) + '" selected>' + esc(coupon.store_name || 'Loja indisponível') + '</option>' : '') +
      current.stores.map(store => '<option value="' + esc(store.id) + '"' + (store.id === coupon?.store_id ? ' selected' : '') + '>' + esc(store.name) + '</option>').join('') +
      '</select></label><label>Data de expiração<input type="date" name="expires_on" required min="' + current.today + '" value="' +
      esc(coupon?.expires_on ?? current.today) + '"></label><label>Limite total de usos<input type="number" name="use_limit" min="1" max="1000000000" step="1" placeholder="Em branco para ilimitado" value="' +
      (coupon?.use_limit ?? '') + '"></label><p class="form-error" data-form-error role="alert"></p><button type="submit" class="btn primary wide">Salvar cupom</button></form>',
      'Desconto máximo de ' + percentage(current.commission_bps) + ' sobre os produtos.');
    bindSubmit($('#platform-coupon-form',el),async fields => {
      await command('admin_save_platform_coupon',{id:coupon?.id,code:fields.get('code').trim().toUpperCase(),rate_bps:Math.round(Number(fields.get('rate'))*100),
        store_id:fields.get('store_id') || null,expires_on:fields.get('expires_on'),use_limit:fields.get('use_limit') ? Number(fields.get('use_limit')) : null});
      el.close();toast('Cupom salvo.');await refresh();
    });
  }

  function remove(coupon) {
    const el = modal('Excluir cupom','<form class="form-stack" id="delete-platform-coupon"><p>O código <strong>' + esc(coupon.code) +
      '</strong> deixará de aceitar novos usos.</p><p class="form-error" data-form-error role="alert"></p><button type="submit" class="btn primary wide">Excluir cupom</button></form>');
    bindSubmit($('#delete-platform-coupon',el),async () => {
      await command('admin_delete_platform_coupon',{id:coupon.id});
      el.close();toast('Cupom excluído.');await refresh();
    });
  }

  root.onclick = async event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || !current) return;
    if (button.hasAttribute('data-new-platform-coupon')) return edit();
    const {editPlatformCoupon,togglePlatformCoupon,deletePlatformCoupon} = button.dataset;
    const coupon = current.coupons.find(item => item.id === (editPlatformCoupon || togglePlatformCoupon || deletePlatformCoupon));
    if (!coupon) return;
    if (editPlatformCoupon) return edit(coupon);
    if (deletePlatformCoupon) return remove(coupon);
    button.disabled = true;
    try {
      await command('admin_toggle_platform_coupon',{id:coupon.id,enabled:!coupon.enabled});
      toast(coupon.enabled ? 'Cupom suspenso.' : 'Cupom reativado.');
      await refresh();
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  };

  root.innerHTML = '<p class="muted">Carregando cupons…</p>';
  refresh();
}
