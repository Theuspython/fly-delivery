import { $,api,command,icon,modal } from './shared.js';
import { bindOrderSound,canEnableOrderSound } from './order-sound.js';
import { appWorkerScope,isAndroid,isAppleMobile,isInstalledApp,registerAppWorker } from './install.js';

const pushControls = () => '<button type="button" class="btn primary" data-push-toggle hidden>' + icon('bell') +
  '<span>Ativar notificações</span></button><p class="muted" data-push-status role="status"></p>';
const soundControls = '<button type="button" class="btn primary" data-order-sound hidden>Ativar som</button>' +
  '<p class="muted" data-order-sound-status role="status"></p>';
export const pushSettingsMarkup = () => '<section class="push-settings" data-push-settings><h3>Notificações neste dispositivo</h3>' +
  pushControls() + '<div data-sound-controls hidden>' + soundControls + '</div></section>';

const canPush = () => (isInstalledApp() || (location.pathname === '/loja/' && !isAppleMobile())) &&
  'Notification' in window && 'PushManager' in window && !!navigator.serviceWorker;

async function readyWorker() {
  const worker = await registerAppWorker();
  if (worker.active?.state === 'activated') return worker;
  // The old root worker can remain active during migration. Wait for this registration specifically.
  return new Promise((resolve,reject)=>{
    const candidate = worker.installing ?? worker.waiting ?? worker.active;
    const cleanup = ()=>{
      clearTimeout(timer);
      candidate?.removeEventListener('statechange',check);
    };
    const check = ()=>{
      if (worker.active?.state === 'activated') { cleanup();resolve(worker); }
      else if (candidate?.state === 'redundant') { cleanup();reject(new Error('Não foi possível preparar as notificações. Reabra o app.')); }
    };
    const timer = setTimeout(()=>{
      cleanup();
      reject(new Error('O app ainda está preparando as notificações. Reabra e tente de novo.'));
    },8000);
    candidate?.addEventListener('statechange',check);
    check();
  });
}

async function legacySubscription() {
  if (appWorkerScope() === '/') return null;
  const legacy = await navigator.serviceWorker.getRegistration('/');
  return legacy?.scope === new URL('/',location.origin).href ? legacy.pushManager?.getSubscription() : null;
}

async function removeRegistration(subscription) {
  if (!subscription) return;
  try { await command('push_unsubscribe',{endpoint:subscription.endpoint}); }
  catch (error) {
    if (!await subscription.unsubscribe()) throw error;
  }
}

export async function pushActive() {
  if (!canPush() || Notification.permission !== 'granted') return false;
  const scope = appWorkerScope();
  const worker = await navigator.serviceWorker.getRegistration(scope);
  if (worker?.scope !== new URL(scope,location.origin).href) return false;
  const subscription = await worker.pushManager.getSubscription();
  return !!subscription && (await command('push_subscription_status',{endpoint:subscription.endpoint})).active;
}

export async function disconnectPush() {
  const worker = await navigator.serviceWorker?.getRegistration();
  const subscription = await worker?.pushManager?.getSubscription();
  const legacy = navigator.serviceWorker && await legacySubscription();
  await removeRegistration(subscription);
  if (legacy?.endpoint !== subscription?.endpoint) await removeRegistration(legacy);
}

function syncPermissionMessage(status) {
  status.textContent = isAndroid() ? 'Permita as notificações em Configurações › Apps › Fly Delivery › Notificações.' :
    'Permita as notificações em Ajustes › Notificações › Fly Delivery.';
}

async function bindPushControl(root,{activationOnly = false,onChange = ()=>{}} = {}) {
  const button = $('[data-push-toggle]',root);
  const status = $('[data-push-status]',root);
  if (!canPush()) {
    status.textContent = 'Abra o Fly Delivery pelo ícone instalado para ativar notificações.';
    return;
  }
  if (Notification.permission === 'denied') {
    syncPermissionMessage(status);
    return;
  }
  status.textContent = 'Preparando as notificações…';
  try {
    const [{publicKey},worker] = await Promise.all([api('push-config'),readyWorker()]);
    if (!root.isConnected) return;
    if (!publicKey) throw new Error('O envio está indisponível no momento. Tente novamente mais tarde.');
    let subscription = await worker.pushManager.getSubscription();
    let active = !!subscription && (await command('push_subscription_status',{endpoint:subscription.endpoint})).active;
    const key = Uint8Array.from(atob(publicKey.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0));

    // Retire only this account's old server entry. Another Fly Delivery app may still use the root registration.
    async function retireLegacy() {
      const legacy = await legacySubscription();
      if (legacy && legacy.endpoint !== subscription?.endpoint) {
        await command('push_unsubscribe',{endpoint:legacy.endpoint});
      }
    }

    function update() {
      const blocked = Notification.permission === 'denied';
      button.hidden = blocked || (activationOnly && active);
      button.classList.toggle('primary',!active);
      button.classList.toggle('outline',active);
      $('span',button).textContent = active ? 'Desativar notificações' : 'Ativar notificações';
      if (blocked) syncPermissionMessage(status);
      else status.textContent = active && !activationOnly ? 'Notificações ativas neste aparelho.' : '';
    }
    update();
    onChange(active);

    button.onclick = async () => {
      button.disabled = true;
      try {
        if (active) {
          await retireLegacy();
          await command('push_unsubscribe',{endpoint:subscription.endpoint});
          active = false;
        } else {
          // Safari requires the subscription request to start in the tap handler.
          subscription ??= await worker.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
          const {keys} = subscription.toJSON();
          await command('push_subscribe',{endpoint:subscription.endpoint,p256dh:keys.p256dh,auth:keys.auth});
          active = true;
          await retireLegacy().catch(()=>{});
        }
        update();
        onChange(active);
      } catch (error) {
        update();
        if (Notification.permission !== 'denied') status.textContent = error.name === 'NotAllowedError' ?
          'Toque em Ativar notificações e escolha Permitir.' : error.name === 'AbortError' ?
            'Verifique a conexão e tente ativar novamente.' : error.message || 'Não foi possível ativar as notificações.';
      } finally { button.disabled = false; }
    };
  } catch (error) { status.textContent = error.message; }
}

export function bindPushSettings(root,onChange = ()=>{}) {
  const sound = $('[data-sound-controls]',root);
  const merchant = location.pathname === '/loja/';
  sound.hidden = !merchant;
  bindOrderSound(sound);
  return bindPushControl(root,{onChange:active=>{sound.hidden = !merchant && !active;onChange(active);}});
}

function permissionCard(title,iconName,description,controls) {
  return '<section class="permission-card"><span class="permission-icon">' + icon(iconName) + '</span>' +
    '<h2 aria-hidden="true">' + title + '</h2><p class="permission-copy">' + description + '</p>' + controls + '</section>';
}

export async function promptCustomerPermissions(isCurrent) {
  if (!canPush() || Notification.permission === 'denied') return;
  const active = await pushActive().catch(()=>false);
  const dialog = $('#dialog');
  if (!isCurrent() || dialog.open) return;

  function showSound(root) {
    if (!isCurrent() || (root && (!root.isConnected || !dialog.open))) return;
    if (!canEnableOrderSound()) {
      if (root) dialog.close();
      return;
    }
    const sound = modal('Ative também o som',permissionCard('Ative também o som','volume',
      'Ouça um toque quando seu pedido mudar de etapa.',soundControls));
    const card = $('.permission-card',sound);
    bindOrderSound(card,{activationOnly:true,onEnabled:()=>{if (card.isConnected) dialog.close();}});
    $('[data-order-sound]',card).focus();
  }

  if (active) return showSound();
  const notification = modal('Ative as notificações',permissionCard('Ative as notificações','bell',
    'Acompanhe seu pedido mesmo com o app fechado.',pushControls()));
  const root = $('.permission-card',notification);
  await bindPushControl(root,{activationOnly:true,onChange:enabled=>{if (enabled) showSound(root);}});
  const button = $('[data-push-toggle]',root);
  if (root.isConnected && dialog.open && !button.hidden) button.focus();
}
