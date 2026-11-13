import { $,api,bindSubmit,command,esc,modal,toast } from './shared.js';

const audiences = {customer:'Clientes',merchant:'Estabelecimentos',all:'Clientes e estabelecimentos'};
const dateTime = new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short',timeZone:'America/Sao_Paulo'});
const status = item => item.cancelled_at ? 'Cancelada' : item.expired_at ? 'Expirada' : !item.queued_at ? 'Agendada' :
  item.pending ? 'Enviando' : item.sent ? 'Processada' : item.failed ? 'Falhou' : 'Sem destinatários ativos';

export function mountAdminPush(root) {
  root.innerHTML = '<section class="panel push-panel"><h2>Nova notificação</h2>' +
    '<form class="form-stack" data-push-form><label>Título<input name="title" maxlength="70" required placeholder="Ex. Hoje tem desconto"></label>' +
    '<label>Mensagem<textarea name="body" rows="3" maxlength="240" required placeholder="Escreva o aviso que aparecerá no celular"></textarea></label>' +
    '<div class="fields-two"><label>Destinatários<select name="audience">' + Object.entries(audiences).map(([key,label])=>
      '<option value="'+key+'">'+label+'</option>').join('')+'</select></label>' +
    '<label>Quando enviar<select name="mode"><option value="now">Enviar agora</option><option value="scheduled">Agendar</option></select></label></div>' +
    '<div data-push-schedule hidden><label>Data e hora de Brasília<input name="local_date" type="datetime-local" step="60"></label>' +
    '<label class="check"><input type="checkbox" name="daily"> Repetir todos os dias neste horário</label></div>' +
    '<p class="muted">Recebem os dispositivos que ativaram as notificações para as contas selecionadas.</p>' +
    '<p class="form-error" data-form-error role="alert"></p><button class="btn primary" type="submit" disabled>Enviar agora</button></form></section>' +
    '<section class="panel push-panel"><div class="section-head"><h2>Agendamentos e envios recentes</h2>' +
    '<button class="btn outline" type="button" data-push-refresh>Atualizar</button></div><div data-push-history aria-live="polite"></div></section>';
  const form = $('[data-push-form]',root);
  const list = $('[data-push-history]',root);
  const schedule = $('[data-push-schedule]',form);
  const submit = $('button[type=submit]',form);
  let draft;
  let items = [];
  let revision = 0;

  function changeMode() {
    const scheduled = form.elements.mode.value==='scheduled';
    schedule.hidden = !scheduled;
    form.elements.local_date.required = scheduled;
    submit.textContent = scheduled ? 'Agendar notificação' : 'Enviar agora';
  }
  form.elements.mode.onchange = changeMode;
  changeMode();
  async function load() {
    const version = ++revision;
    try {
      const result = await command('push_history');
      if (!root.isConnected || version!==revision) return;
      items = result;
      list.innerHTML = items.length ? items.map(item =>
        '<article class="push-history-row"><div><h3>'+esc(item.title)+'</h3><p>'+esc(item.body)+'</p>' +
        '<p class="muted">'+dateTime.format(new Date(item.scheduled_at))+' · '+audiences[item.audience]+(item.daily?' · Diária':'')+'</p>' +
        (item.queued_at&&!item.expired_at?'<p class="muted">'+item.sent+' aceito(s) pelo serviço push · '+item.failed+' falha(s) · '+
          item.skipped+' indisponível(is)'+(item.pending?' · '+item.pending+' em fila':'')+'</p>':'')+'</div>' +
        '<div class="push-history-actions"><span class="status">'+status(item)+'</span>' +
        (!item.queued_at&&!item.cancelled_at?'<button type="button" class="btn outline danger-text" data-push-cancel="'+esc(item.id)+'">Cancelar</button>':'') +
        '</div></article>').join('') : '<p class="muted">Nenhuma notificação cadastrada.</p>';
    } catch(error) {
      if (root.isConnected && version===revision) list.textContent = error.message;
    }
  }
  $('[data-push-refresh]',root).onclick = load;
  list.onclick = event=>{
    const button = event.target.closest('[data-push-cancel]');
    const item = items.find(entry=>entry.id===button?.dataset.pushCancel);
    if (!item) return;
    const dialog = modal('Cancelar agendamento','<form class="form-stack"><p>'+esc(item.title)+'</p>'+
      (item.daily?'<p>Os próximos envios diários serão cancelados.</p>':'')+
      '<p class="form-error" data-form-error role="alert"></p><button class="btn danger" type="submit">Cancelar agendamento</button></form>');
    bindSubmit($('form',dialog),async ()=>{
      await command('push_cancel',{id:item.id});
      dialog.close();
      await load();
    });
  };
  bindSubmit(form,fields=>{
    const mode = fields.get('mode');
    const data = {title:fields.get('title').trim(),body:fields.get('body').trim(),audience:fields.get('audience'),mode,
      local_date:mode==='scheduled' ? fields.get('local_date') : null,daily:mode==='scheduled' && fields.has('daily')};
    if (!data.title || !data.body) throw new Error('Preencha o título e a mensagem.');
    const key = JSON.stringify(data);
    if (draft?.key!==key) draft = {key,id:crypto.randomUUID()};
    const requestId = draft.id;
    const dialog = modal(mode==='now'?'Enviar notificação agora':'Confirmar agendamento','<form class="form-stack">'+
      '<div class="push-preview"><strong>'+esc(data.title)+'</strong><p>'+esc(data.body)+'</p><small>'+audiences[data.audience]+'</small></div>'+
      (mode==='scheduled'?'<p>'+esc(data.local_date.split('T')[0].split('-').reverse().join('/')+' às '+data.local_date.split('T')[1])+
        ' · Horário de Brasília'+(data.daily?' · Repete diariamente':'')+'</p>':'')+
      '<p class="form-error" data-form-error role="alert"></p><button class="btn primary" type="submit">'+
      (mode==='now'?'Confirmar envio':'Confirmar agendamento')+'</button></form>');
    bindSubmit($('form',dialog),async ()=>{
      await command('push_schedule',{...data,request_id:requestId});
      dialog.close();
      draft = null;
      form.reset();
      changeMode();
      toast(mode==='now'?'Notificação adicionada à fila.':'Notificação agendada.');
      await load();
    });
  });
  api('push-config').then(({publicKey})=>{
    if (!root.isConnected) return;
    submit.disabled = !publicKey;
    if (!publicKey) $('[data-form-error]',form).textContent = 'O envio de notificações está indisponível.';
  }).catch(error=>{if (root.isConnected) $('[data-form-error]',form).textContent = error.message;});
  load();
}
