import { $,api,command,icon } from './shared.js';
import { bindOrderSound } from './order-sound.js';

export const pushSettingsMarkup = () => '<section class="push-settings" data-push-settings><h3>Notificações neste dispositivo</h3>' +
  '<p class="muted" data-push-status role="status">Verificando disponibilidade…</p>' +
  '<div class="push-settings-actions"><button type="button" class="btn primary" data-push-toggle hidden>' + icon('bell') +
  '<span>Ativar notificações</span></button><button type="button" class="btn outline" data-push-test hidden>Enviar teste para este aparelho</button></div>' +
  '<p class="muted" data-push-test-status role="status" hidden></p>' +
  '<div class="push-settings-actions"><button type="button" class="btn outline" data-order-sound hidden></button></div>' +
  '<p class="muted" data-order-sound-status role="status"></p></section>';

function iosNeedsInstallation() {
  const appleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return appleMobile && navigator.standalone !== true && !matchMedia('(display-mode: standalone)').matches &&
    !matchMedia('(display-mode: fullscreen)').matches;
}

const canPush = () => 'Notification' in window && 'PushManager' in window && !!navigator.serviceWorker;

function readyWorker() {
  return new Promise((resolve,reject)=>{
    const timer = setTimeout(()=>reject(new Error('O app ainda está preparando as notificações. Reabra e tente de novo.')),8000);
    navigator.serviceWorker.ready.then(worker=>{clearTimeout(timer);resolve(worker);},error=>{clearTimeout(timer);reject(error);});
  });
}

export async function pushActive() {
  if (iosNeedsInstallation() || !canPush() || Notification.permission !== 'granted') return false;
  const worker = await navigator.serviceWorker.getRegistration();
  const subscription = await worker?.pushManager?.getSubscription();
  return !!subscription && (await command('push_subscription_status',{endpoint:subscription.endpoint})).active;
}

export async function disconnectPush() {
  const worker = await navigator.serviceWorker?.getRegistration();
  const subscription = await worker?.pushManager?.getSubscription();
  if (!subscription) return;
  try { await command('push_unsubscribe',{endpoint:subscription.endpoint}); }
  catch (error) {
    if (!await subscription.unsubscribe()) throw error;
  }
}

const testResults = {
  sent:'O serviço de notificações aceitou o teste. Confira a central de notificações do aparelho.',
  skipped:'O aparelho perdeu a inscrição. Ative as notificações para testar de novo.',
  failed:'O serviço de notificações não aceitou o teste. Desative e ative as notificações para tentar de novo.',
  inactive:'O aparelho perdeu a inscrição. Ative as notificações para tentar de novo.'
};

export async function bindPushSettings(root,onChange = ()=>{}) {
  bindOrderSound(root);
  const button = $('[data-push-toggle]',root);
  const test = $('[data-push-test]',root);
  const status = $('[data-push-status]',root);
  const testStatus = $('[data-push-test-status]',root);
  if (iosNeedsInstallation()) {
    status.textContent = 'No iPhone ou iPad, adicione o Fly Delivery à Tela de Início e abra pelo ícone instalado.';
    return;
  }
  if (!canPush()) {
    status.textContent = 'Este navegador não oferece notificações push para o Fly Delivery.';
    return;
  }
  try {
    const [{publicKey},worker] = await Promise.all([api('push-config'),readyWorker()]);
    if (!root.isConnected) return;
    if (!publicKey) throw new Error('O envio está indisponível no momento. Tente novamente mais tarde.');
    let subscription = await worker.pushManager.getSubscription();
    let active = !!subscription && (await command('push_subscription_status',{endpoint:subscription.endpoint})).active;
    const key = Uint8Array.from(atob(publicKey.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0));

    function update() {
      const blocked = Notification.permission === 'denied';
      button.hidden = blocked;
      button.classList.toggle('primary',!active);
      button.classList.toggle('outline',active);
      test.hidden = blocked || !active;
      $('span',button).textContent = active ? 'Desativar notificações' : 'Ativar notificações';
      status.textContent = blocked ? 'Permita as notificações nas configurações do aparelho ou do navegador e reabra o app.' :
        active ? 'Notificações ativas para esta conta neste aparelho.' : 'Receba avisos de pedidos mesmo com o app fechado.';
      onChange(active && !blocked);
    }
    update();

    button.onclick = async () => {
      button.disabled = test.disabled = true;
      testStatus.hidden = true;
      try {
        if (active) {
          await command('push_unsubscribe',{endpoint:subscription.endpoint});
          active = false;
        } else {
          // Call subscribe directly from the tap, as required by Safari.
          subscription ??= await worker.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
          const {keys} = subscription.toJSON();
          await command('push_subscribe',{endpoint:subscription.endpoint,p256dh:keys.p256dh,auth:keys.auth});
          active = true;
        }
        update();
      } catch (error) {
        if (Notification.permission === 'denied') update();
        else status.textContent = error.name === 'NotAllowedError' ? 'Toque em Ativar notificações e escolha Permitir.' :
          error.name === 'AbortError' ? 'O navegador não conseguiu inscrever este aparelho. Verifique a conexão e tente de novo.' :
          error.message || 'Não foi possível atualizar as notificações.';
      } finally {
        button.disabled = test.disabled = false;
      }
    };

    test.onclick = async () => {
      button.disabled = test.disabled = true;
      testStatus.hidden = false;
      testStatus.textContent = 'Preparando o teste…';
      try {
        const endpoint = subscription.endpoint;
        let {id,state} = await command('push_test',{endpoint});
        if (state === 'pending') testStatus.textContent = 'Teste agendado. Você já pode bloquear a tela para conferir.';
        for (let attempt=0;state==='pending' && attempt<8 && root.isConnected;attempt++) {
          await new Promise(resolve=>setTimeout(resolve,3000));
          if (!root.isConnected) return;
          ({state} = await command('push_test_status',{endpoint,id}));
        }
        if (state === 'skipped') {
          await subscription.unsubscribe().catch(()=>false);
          subscription = null;
        }
        if (state === 'inactive' || state === 'skipped') {
          active = false;
          update();
        }
        testStatus.textContent = testResults[state] || 'O teste ainda está na fila. Confira a central de notificações em instantes.';
      } catch (error) {
        testStatus.textContent = error.message || 'Não foi possível enviar o teste.';
      } finally { button.disabled = test.disabled = false; }
    };
  } catch (error) { status.textContent = error.message; }
}
