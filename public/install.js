import { $,icon,modal,toast } from './shared.js';

export function setupInstall() {
  let pending;
  let busy=false;
  const mode=window.matchMedia('(display-mode: standalone)');
  let installed=mode.matches || navigator.standalone===true;
  const isIOS=()=>/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);
  const isSafari=()=>/Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent);

  function update() {
    for (const button of document.querySelectorAll('[data-install]')) {
      button.hidden=installed;
      const container=button.closest('[data-install-container]');
      if (container) container.hidden=installed;
      button.innerHTML=icon('install') + ' ' + (installed ? 'App instalado' : busy ? 'Instalando…' : 'Instalar app');
      button.disabled=installed || busy;
    }
    const ready=$('[data-native-install]');
    if (ready) {
      ready.disabled=!pending || busy || installed;
      ready.textContent=installed ? 'App instalado' : pending ? 'Instalar agora' : 'Aguardando o navegador…';
    }
  }

  function instructions() {
    if (isIOS()) {
      modal('Instalar no iPhone ou iPad',(isSafari() ? '' : '<p class="dialog-copy">Abra este endereço no Safari para instalar.</p>') +
        '<ol class="install-steps"><li>No Safari, toque em <strong>Compartilhar</strong> (quadrado com a seta para cima). Se necessário, abra primeiro o menu do Safari.</li>' +
        '<li>Selecione <strong>Adicionar à Tela de Início</strong>. Se não aparecer, procure em <strong>Editar Ações</strong>.</li>' +
        '<li>Se aparecer <strong>Abrir como App</strong>, deixe ativado e toque em <strong>Adicionar</strong>.</li></ol>');
      return;
    }
    const supportsPrompt='onbeforeinstallprompt' in window;
    const el=modal('Instalar Fly Delivery',supportsPrompt ?
      '<p class="dialog-copy">O navegador ainda não disponibilizou a instalação deste app. Assim que liberar, você poderá confirmar abaixo.</p>' +
      '<button class="btn primary wide" data-native-install disabled>Aguardando o navegador…</button>' +
      '<p class="muted install-note">Se o app já estiver instalado, abra pelo ícone na Tela de Início. A disponibilidade da instalação é controlada pelo navegador.</p>' :
      '<p class="dialog-copy">Este navegador não oferece a confirmação automática de instalação. No menu do navegador, procure <strong>Instalar app</strong> ou <strong>Adicionar à Tela de Início</strong>. No Android, você também pode abrir este endereço no Chrome.</p>');
    const button=$('[data-native-install]',el);
    if (button) button.onclick=request;
    update();
  }

  async function request() {
    if (busy || installed) return;
    if (!pending) return instructions();
    const event=pending;
    pending=null;
    busy=true;
    update();
    try {
      // Keep prompt() within the click gesture; capture happens before any login request.
      const result=await event.prompt();
      const choice=event.userChoice ? await event.userChoice : result;
      if (choice?.outcome==='accepted') {
        installed=true;
        if ($('[data-native-install]')) $('#dialog').close();
        toast('App instalado. Abra pelo ícone na Tela de Início.');
      }
    } catch {
      toast('O navegador não liberou a instalação agora. Tente novamente quando estiver disponível.');
    } finally {busy=false;update();}
  }

  window.addEventListener('beforeinstallprompt',event=>{
    event.preventDefault();pending=event;
    // A new eligibility event also allows reinstalling after removal, without a saved flag.
    installed=mode.matches || navigator.standalone===true;
    update();
  });
  window.addEventListener('appinstalled',()=>{
    installed=true;pending=null;busy=false;update();
    if ($('[data-native-install]')) $('#dialog').close();
  });
  mode.addEventListener?.('change',()=>{installed=mode.matches || navigator.standalone===true;update();});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});

  return {bind(button){button.onclick=request;update();}};
}
