import { $, bindSubmit, command, esc, icon, modal, toast } from './shared.js';

const periods = [
  ['3m','Mais de 3 meses'], ['6m','Mais de 6 meses'], ['1y','Mais de 1 ano'],
  ['day','Dia específico'], ['range','Intervalo de datas']
];
const counts = new Intl.NumberFormat('pt-BR');
const dateLabel = value => value.split('-').reverse().join('/');
const countsMarkup = result => '<dl class="cleanup-counts">' + [
  ['Itens dos pedidos',result.items], ['Pedidos',result.orders], ['Faturas pagas',result.invoices]
].map(([label,count]) => '<div><dt>'+label+'</dt><dd>'+counts.format(count)+'</dd></div>').join('')+'</dl>';

function retainedMarkup(result) {
  const retained = result.retained ?? {};
  const reasons = [
    [retained.not_delivered,'pedido sem status de entregue','pedidos sem status de entregue'],
    [retained.outside_invoice_day,'pedido entregue em outra data','pedidos entregues em outra data'],
    [retained.without_paid_invoice,'pedido entregue sem fatura quitada','pedidos entregues sem fatura quitada'],
    [retained.outside_billed_orders,'pedido fora do fechamento da fatura','pedidos fora do fechamento da fatura'],
    [retained.pending_invoices,'fatura pendente no período','faturas pendentes no período']
  ].filter(([count])=>count>0);
  return reasons.length ? '<p><strong>Ficam fora da exclusão</strong></p><ul>' +
    reasons.map(([count,singular,plural])=>'<li>'+counts.format(count)+' '+(count===1 ? singular : plural)+'</li>').join('')+'</ul>' : '';
}

export function mountHistoryCleanup(root) {
  root.innerHTML = '<section class="panel history-cleanup"><div class="section-head"><h2>Selecionar período</h2></div>' +
    '<p class="muted">A limpeza remove faturas quitadas e os pedidos entregues que fazem parte delas. O histórico dos clientes e os relatórios passam a refletir os registros que permanecerem no sistema.</p>' +
    '<form class="form-stack" data-cleanup-form><label>Período<select name="period">' +
    periods.map(([value,label])=>'<option value="'+value+'">'+label+'</option>').join('')+'</select></label>' +
    '<div class="fields-two" data-cleanup-dates hidden><label data-cleanup-start>Data inicial<input type="date" name="from"></label>' +
    '<label data-cleanup-end>Data final<input type="date" name="to"></label></div>' +
    '<p class="muted" data-cleanup-hint></p><p class="form-error" data-form-error role="alert"></p>' +
    '<div class="order-actions"><button class="btn primary" type="submit">Consultar prévia</button></div></form></section>' +
    '<section class="panel history-cleanup" data-cleanup-result aria-live="polite" hidden></section>';

  const form = $('[data-cleanup-form]',root);
  const period = $('[name=period]',form);
  const from = $('[name=from]',form);
  const to = $('[name=to]',form);
  const output = $('[data-cleanup-result]',root);
  let revision = 0;

  function updatePeriod() {
    const custom = period.value==='day' || period.value==='range';
    const range = period.value==='range';
    $('[data-cleanup-dates]',form).hidden = !custom;
    $('[data-cleanup-end]',form).hidden = !range;
    $('[data-cleanup-start]',form).firstChild.nodeValue = range ? 'Data inicial' : 'Data da fatura';
    from.disabled = !custom;
    to.disabled = !range;
    from.required = custom;
    to.required = range;
    $('[data-cleanup-hint]',form).textContent = custom
      ? 'O filtro usa a data da fatura, que acompanha o dia da entrega, pelo horário de Brasília. As duas datas do intervalo estão incluídas.'
      : 'O filtro usa a data de pagamento da fatura, pelo horário de Brasília.';
    revision++;
    output.hidden = true;
    $('[data-form-error]',form).textContent = '';
  }
  form.addEventListener('change',updatePeriod);
  updatePeriod();

  bindSubmit(form,async fields=>{
    const request = ++revision;
    const input = Object.fromEntries(fields);
    if (input.to && input.from>input.to) throw new Error('A data final deve ser igual ou posterior à inicial.');
    output.hidden = true;
    let result;
    try {
      result = await command('admin_history_cleanup',{...input,phase:'preview'});
    } catch (error) {
      if (revision===request && root.isConnected) throw error;
      return;
    }
    if (revision!==request || !root.isConnected) return;
    const scope = result.paid_before
      ? 'Pagamentos anteriores a '+dateLabel(result.paid_before)
      : 'Faturas de '+dateLabel(result.from)+(result.from===result.to ? '' : ' a '+dateLabel(result.to));
    output.innerHTML = '<h2>Prévia da limpeza</h2><p class="muted">'+esc(scope)+'</p><p>Registros a excluir por inteiro</p>'+countsMarkup(result) +
      retainedMarkup(result) +
      (result.unmatched_invoices ? '<p class="form-error">'+counts.format(result.unmatched_invoices)+' fatura(s) ficaram fora da limpeza porque o total dos pedidos diverge do total faturado.</p>' : '') +
      (result.invoices ? '<div class="order-actions"><button class="btn outline danger-text" data-cleanup-confirm>'+icon('trash')+' Excluir registros</button></div>'
        : '<p class="muted">Nenhuma fatura quitada elegível neste período.</p>');
    output.hidden = false;

    const confirm = $('[data-cleanup-confirm]',output);
    if (!confirm) return;
    confirm.onclick = () => {
      const el = modal('Confirmar limpeza do histórico',
        '<p class="dialog-copy">A exclusão é permanente. Digite <strong>EXCLUIR</strong> para confirmar.</p>'+
        countsMarkup(result)+'<form class="form-stack" data-cleanup-execute>'+
        '<label>Confirmação<input name="confirmation" autocomplete="off" autocapitalize="characters" required autofocus></label>'+
        '<p class="form-error" data-form-error role="alert"></p><div class="order-actions">'+
        '<button class="btn outline" type="button" data-close>Voltar</button>'+
        '<button class="btn primary" type="submit" disabled>Excluir definitivamente</button></div></form>',scope);
      const execute = $('[data-cleanup-execute]',el);
      const confirmation = $('[name=confirmation]',execute);
      const button = $('button[type=submit]',execute);
      confirmation.oninput = () => { button.disabled = confirmation.value!=='EXCLUIR'; };
      bindSubmit(execute,async data=>{
        if (data.get('confirmation')!=='EXCLUIR') throw new Error('Digite EXCLUIR para confirmar.');
        if (revision!==request || !root.isConnected) throw new Error('Consulte uma nova prévia antes de excluir.');
        confirmation.readOnly = true;
        let removed;
        try {
          removed = await command('admin_history_cleanup',{...input,phase:'execute',token:result.token,confirmation:data.get('confirmation')});
        } finally {
          confirmation.readOnly = false;
        }
        if (execute.isConnected && el.open) el.close();
        if (revision===request && root.isConnected) {
          output.innerHTML = '<h2>Limpeza concluída</h2><p class="muted">'+esc(scope)+'</p><p>Registros excluídos por inteiro</p>'+countsMarkup(removed)+retainedMarkup(result);
        }
        toast('Histórico selecionado excluído.');
      });
    };
  });
}
