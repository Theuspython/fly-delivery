import { $,api,command,icon } from './shared.js';
import { bindOrderSound } from './order-sound.js';
import { appWorkerScope,isAndroid,registerAppWorker } from './install.js';

export const pushSettingsMarkup = () => '<section class="push-settings" data-push-settings><h3>Notificações neste dispositivo</h3>' +
  '<p class="muted" data-push-status role="status">Verificando disponibilidade…</p>' +
  '<div class="push-settings-actions"><button type="button" class="btn primary" data-push-toggle hidden>' + icon('bell') +
  '<span>Ativar notificações</span></button><button type="button" class="btn outline" data-push-test hidden>Enviar teste para este aparelho</button>' +
  '<button type="button" class="btn outline" data-push-local-test hidden>Testar exibição no Android</button></div>' +
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
  if (iosNeedsInstallation() || !canPush() || Notification.permission !== 'granted') return false;
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
  const localTest = $('[data-push-local-test]',root);
  const android = isAndroid();
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

    // Retire only this account's old server entry. The other Fly Delivery app may still use the root registration.
    async function retireLegacy() {
      const legacy = await legacySubscription();
      if (legacy && legacy.endpoint !== subscription?.endpoint) {
        await command('push_unsubscribe',{endpoint:legacy.endpoint});
      }
    }

    function update() {
      const blocked = Notification.permission === 'denied';
      button.hidden = blocked;
      button.classList.toggle('primary',!active);
      button.classList.toggle('outline',active);
      test.hidden = blocked || !active;
      localTest.hidden = !android || Notification.permission !== 'granted';
      $('span',button).textContent = active ? 'Desativar notificações' : 'Ativar notificações';
      status.textContent = blocked ? (android ? 'No Android, abra Configurações › Apps › Fly Delivery › Notificações e permita os avisos. Se estiver no navegador, confira as permissões do Chrome.' :
        'Permita as notificações nas configurações do aparelho ou do navegador e reabra o app.') :
        active ? 'Inscrição de notificações ativa neste aparelho.' :
        android ? 'Ative neste aparelho para receber os avisos de pedidos.' : 'Receba avisos de pedidos mesmo com o app fechado.';
      onChange(active && !blocked);
    }
    update();

    button.onclick = async () => {
      button.disabled = test.disabled = localTest.disabled = true;
      testStatus.hidden = true;
      try {
        if (active) {
          await retireLegacy();
          await command('push_unsubscribe',{endpoint:subscription.endpoint});
          active = false;
        } else {
          // Call subscribe directly from the tap, as required by Safari.
          subscription ??= await worker.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
          const {keys} = subscription.toJSON();
          await command('push_subscribe',{endpoint:subscription.endpoint,p256dh:keys.p256dh,auth:keys.auth});
          active = true;
          await retireLegacy();
        }
        update();
      } catch (error) {
        update();
        if (Notification.permission !== 'denied') status.textContent = error.name === 'NotAllowedError' ? 'Toque em Ativar notificações e escolha Permitir.' :
          error.name === 'AbortError' ? 'O navegador não conseguiu inscrever este aparelho. Verifique a conexão e tente de novo.' :
          error.message || 'Não foi possível atualizar as notificações.';
      } finally {
        button.disabled = test.disabled = false;
      }
    };

    localTest.onclick = async () => {
      localTest.disabled = true;
      testStatus.hidden = false;
      try {
        await worker.showNotification('Teste local do Fly Delivery',{
          body:'Este aviso foi gerado no próprio aparelho.',
          icon:'/assets/icon-192.png?v=motoboy',
          data:{url:location.origin+appWorkerScope()}
        });
        testStatus.textContent = 'Confira se o aviso apareceu na central de notificações. Se não apareceu, confira as permissões e as categorias de notificação nas configurações do Android.';
      } catch {
        testStatus.textContent = 'O Android não conseguiu exibir o aviso. Confira a permissão de notificações do aplicativo.';
      } finally { localTest.disabled = false; }
    };

    test.onclick = async () => {
      button.disabled = test.disabled = localTest.disabled = true;
      testStatus.hidden = false;
      testStatus.textContent = 'Preparando o teste…';
      try {
        const endpoint = subscription.endpoint;
        let {id,state} = await command('push_test',{endpoint});
        if (state === 'pending') testStatus.textContent = 'Teste agendado. Você já pode bloquear a tela para conferir.';
        for (let attempt=0;state==='pending' && attempt<8 && root.isConnected;attempt++) {
          await new Promise(resolve=>setTimeout(resolve,3000));
          if (!root.isConnected || !root.closest('dialog')?.open) return;
          ({state} = await command('push_test_status',{endpoint,id}));
        }
        if (state === 'skipped' || (android && state === 'inactive')) {
          if (await subscription.unsubscribe().catch(()=>false)) subscription = null;
          else subscription = await worker.pushManager.getSubscription();
        }
        if (state === 'inactive' || state === 'skipped') {
          active = false;
          update();
        }
        testStatus.textContent = testResults[state] || 'O teste ainda está na fila. Confira a central de notificações em instantes.';
      } catch (error) {
        testStatus.textContent = error.message || 'Não foi possível enviar o teste.';
      } finally { button.disabled = test.disabled = localTest.disabled = false; }
    };
  } catch (error) { status.textContent = error.message; }
}
