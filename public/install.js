import { $,icon,modal,toast } from './shared.js';

const displayModes = ['standalone','fullscreen','minimal-ui','window-controls-overlay'];
export const isInstalledApp = () => navigator.standalone === true || /^android-app:\/\/br\.com\.flydeliverypp\.www\.twa(?:\/|$)/.test(document.referrer) ||
  displayModes.some(mode=>window.matchMedia('(display-mode: '+mode+')').matches);

export const isAppleMobile = () => /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const isAndroid = () => navigator.userAgentData?.platform === 'Android' || /Android/i.test(navigator.userAgent);

export function appWorkerScope(path = location.pathname) {
  // Chromium resolves Android notification delegation using the worker registration's scope.
  return isAndroid() && ['/cliente/','/loja/'].includes(path) ? path : '/';
}

let workerRegistration;
export function registerAppWorker() {
  return workerRegistration ??= navigator.serviceWorker.register('/sw.js',{scope:appWorkerScope()})
    .catch(error=>{ workerRegistration = null;throw error; });
}

export function setupInstall() {
  let pending;
  let busy=false;
  let installed=isInstalledApp();
  let suggestion;
  let suggestionTimer;
  const isSafari=()=>/Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent);

  function dismissSuggestion() {
    suggestion?.remove();
    suggestion = null;
  }

  function update() {
    if (installed) dismissSuggestion();
    const install = suggestion?.querySelector('[data-suggest-install]');
    if (install) install.disabled = busy;
    for (const button of document.querySelectorAll('[data-install]')) {
      button.hidden=installed;
      const container=button.closest('[data-install-container]');
      if (container) container.hidden=installed;
      button.innerHTML=icon('install') + ' ' + (installed ? 'App instalado' : busy ? 'Instalando…' : 'Instalar app');
      button.disabled=installed || busy;
    }
  }

  function instructions() {
    if (isAppleMobile()) {
      modal('Instalar no iPhone ou iPad',(isSafari() ? '' : '<p class="dialog-copy">Abra este endereço no Safari para instalar.</p>') +
        '<ol class="install-steps"><li>No Safari, toque em <strong>Compartilhar</strong> (quadrado com a seta para cima). Se necessário, abra primeiro o menu do Safari.</li>' +
        '<li>Selecione <strong>Adicionar à Tela de Início</strong>. Se não aparecer, procure em <strong>Editar Ações</strong>.</li>' +
        '<li>Se aparecer <strong>Abrir como App</strong>, deixe ativado e toque em <strong>Adicionar</strong>.</li></ol>');
      return;
    }
    if (isAndroid()) {
      modal('Instalar no Android','<ol class="install-steps"><li>Abra o Fly Delivery no Chrome.</li>' +
        '<li>Toque nos <strong>três pontos</strong> e escolha <strong>Instalar app</strong> ou <strong>Adicionar à tela inicial</strong>.</li>' +
        '<li>Confirme e abra o Fly Delivery pelo novo ícone.</li></ol>');
      return;
    }
    modal('Instalar Fly Delivery','<p class="dialog-copy">No menu do navegador, procure <strong>Instalar app</strong> ou <strong>Adicionar à tela inicial</strong>.</p>');
  }

  function suggest() {
    clearTimeout(suggestionTimer);
    dismissSuggestion();
    suggestionTimer = setTimeout(()=>{
      if (installed || isInstalledApp()) return;
      suggestion = document.createElement('aside');
      suggestion.className = 'app-install-suggestion';
      suggestion.setAttribute('aria-label','Instalar Fly Delivery');
      suggestion.innerHTML = '<img src="/assets/icon-192.png?v=motoboy" width="48" height="48" alt="">' +
        '<div><h2>Fly Delivery a um toque</h2><p>Instale o app e acompanhe seus pedidos pelo celular.</p></div>' +
        '<button class="icon-button" type="button" data-dismiss-install aria-label="Fechar sugestão">' + icon('close') + '</button>' +
        '<button class="btn primary wide" type="button" data-suggest-install>' + icon('install') + ' Instalar app</button>';
      $('[data-dismiss-install]',suggestion).onclick = dismissSuggestion;
      $('[data-suggest-install]',suggestion).onclick = ()=>{
        dismissSuggestion();
        void request();
      };
      document.body.append(suggestion);
    },5000);
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
        toast('App instalado. Abra pelo ícone na Tela de Início.');
      }
    } catch {
      toast('O navegador não liberou a instalação agora. Tente novamente quando estiver disponível.');
    } finally {busy=false;update();}
  }

  window.addEventListener('beforeinstallprompt',event=>{
    event.preventDefault();pending=event;
    // A new eligibility event also allows reinstalling after removal, without a saved flag.
    installed=isInstalledApp();
    update();
  });
  window.addEventListener('appinstalled',()=>{
    installed=true;pending=null;busy=false;update();
  });
  for (const mode of displayModes) window.matchMedia('(display-mode: '+mode+')')
    .addEventListener?.('change',()=>{installed=isInstalledApp();update();});
  if ('serviceWorker' in navigator) void registerAppWorker().catch(()=>{});

  return {suggest,bind(button){button.onclick=request;update();}};
}
