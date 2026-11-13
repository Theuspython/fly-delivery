import { $,api,command,icon } from './shared.js';

export const pushSettingsMarkup = () => '<section class="push-settings" data-push-settings><h3>Notificações neste dispositivo</h3>' +
  '<p class="muted" data-push-status role="status">Verificando disponibilidade…</p>' +
  '<button type="button" class="btn outline" data-push-toggle hidden>' + icon('bell') + '<span>Ativar notificações</span></button></section>';

function installedApp() {
  return navigator.standalone === true || document.referrer.startsWith('android-app://') ||
    ['standalone','fullscreen','minimal-ui','window-controls-overlay'].some(mode=>matchMedia('(display-mode: '+mode+')').matches);
}

async function registration() {
  if (!navigator.serviceWorker) return null;
  return navigator.serviceWorker.getRegistration();
}

function subscriptionData(subscription) {
  const keys = subscription.toJSON().keys;
  return {endpoint:subscription.endpoint,p256dh:keys.p256dh,auth:keys.auth};
}

export async function disconnectPush() {
  const subscription = await (await registration())?.pushManager?.getSubscription();
  if (!subscription) return;
  try { await command('push_unsubscribe',{endpoint:subscription.endpoint}); }
  catch (error) {
    if (!await subscription.unsubscribe()) throw error;
  }
}

export async function bindPushSettings(root) {
  const button = $('[data-push-toggle]',root);
  const status = $('[data-push-status]',root);
  if (!installedApp()) {
    status.textContent = 'Instale o Fly Delivery e abra pelo ícone do app para ativar as notificações.';
    return;
  }
  if (!('Notification' in window) || !('PushManager' in window) || !navigator.serviceWorker) {
    status.textContent = 'As notificações push estão indisponíveis neste dispositivo.';
    return;
  }
  try {
    const [{publicKey},worker] = await Promise.all([api('push-config'),registration()]);
    if (!root.isConnected) return;
    if (!publicKey || !worker?.active) {
      status.textContent = 'As notificações estão indisponíveis agora. Reabra o app para tentar novamente.';
      return;
    }
    let subscription = await worker.pushManager.getSubscription();
    let active = subscription && (await command('push_subscription_status',{endpoint:subscription.endpoint})).active;
    const key = Uint8Array.from(atob(publicKey.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0));
    function update() {
      const blocked = Notification.permission === 'denied';
      button.hidden = blocked;
      $('span',button).textContent = active ? 'Desativar notificações' : 'Ativar notificações';
      status.textContent = blocked ? 'Permita notificações nas configurações do app ou do navegador.' :
        active ? 'Ativas para esta conta neste dispositivo.' : 'Receba avisos mesmo quando o app estiver fechado.';
    }
    update();
    button.onclick = async () => {
      button.disabled = true;
      try {
        if (active) {
          await command('push_unsubscribe',{endpoint:subscription.endpoint});
          active = false;
        } else {
          subscription ??= await worker.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
          await command('push_subscribe',subscriptionData(subscription));
          active = true;
        }
        update();
      } catch (error) {
        status.textContent = error.message || 'Não foi possível atualizar as notificações.';
      } finally {
        button.disabled = false;
        if (Notification.permission === 'denied') update();
      }
    };
  } catch (error) { status.textContent = error.message; }
}
