import { $, main, esc, icon, api, command, modal, toast, bindSubmit } from './shared.js';
import { customer } from './customer.js';
import { operations } from './operations.js';

const page = location.pathname.split('/')[1] || 'cliente';
const titles = { cliente:'Cliente', loja:'Estabelecimento', entregador:'Entregador', admin:'Administração' };
let current = null;
let installEvent;
let app;

$('#manifest').href = '/' + page + '.webmanifest';

function brand() {
  return '<a class="brand" href="/' + page + '/" aria-label="Fly Delivery, início"><img src="/assets/icon.svg" alt="" width="41" height="41"><span>fly<span class="brand-accent">delivery</span><small>PEÇA BEM. COMA FELIZ.</small></span></a>';
}
function header() {
  const linksHtml = page === 'cliente'
    ? '<a href="#inicio">Início</a><a href="#lojas">Restaurantes</a><a href="#pedidos">Meus pedidos</a>'
    : '<span class="workspace-label">' + esc(titles[page]) + '</span>';
  $('#top').innerHTML = '<div class="wrap topbar">' + brand() + '<nav class="top-nav" aria-label="Menu principal">' + linksHtml +
    '</nav><div class="top-actions">' + (page === 'cliente' ? '<button class="location-button" data-location aria-label="Definir endereço de entrega">' + icon('pin') +
      '<span><small>ENTREGAR EM</small><b id="top-address">Informe seu endereço</b></span>' + icon('chevron') + '</button>' : '') +
    '<button class="icon-button account-button" data-account aria-label="' + (current ? 'Minha conta' : 'Entrar') + '">' +
    icon('person') + '</button>' + (page === 'cliente' ? '<a class="cart-button" href="#carrinho" aria-label="Carrinho">' + icon('bag') +
    '<span id="cart-count">0</span></a>' : '') + '</div></div>';
  $('[data-account]').onclick = () => current ? account() : auth();
  if (page === 'cliente') {
    $('[data-location]').onclick = () => app.addressDialog();
    app?.updateHeader();
  }
}

function footer() {
  $('#footer').innerHTML = '<div class="wrap footer-inner"><div>' + brand() +
    '<p>' + (page === 'cliente' ? 'Seu próximo pedido está a um toque.' : esc(titles[page])) + '</p></div>' +
    '<button class="footer-install" data-install>' + icon('install') + ' Instalar app</button></div>';
  $('[data-install]').onclick = async () => {
    if (installEvent) {
      await installEvent.prompt();
      installEvent = null;
    } else {
      modal('Instalar Fly Delivery', '<p class="dialog-copy">Abra o menu do navegador e selecione <strong>Instalar app</strong> ou <strong>Adicionar à Tela de Início</strong>. No iPhone, use o botão Compartilhar do Safari.</p>');
    }
  };
}

function auth(mode = 'login') {
  const signup = mode === 'signup' && page === 'cliente';
  const el = modal(signup ? 'Crie sua conta' : 'Entre no Fly Delivery',
    '<form class="form-stack" id="auth-form"><label>E-mail<input name="email" type="email" autocomplete="email" required maxlength="254"></label>' +
    '<label>Senha<input name="password" type="password" autocomplete="' + (signup ? 'new-password' : 'current-password') +
    '" required minlength="8" maxlength="128"></label><p class="form-error" data-form-error role="alert"></p>' +
    '<button class="btn primary wide" type="submit">' + (signup ? 'Criar conta' : 'Entrar') + '</button></form>' +
    (page === 'cliente' ? '<button class="text-button auth-switch" data-auth-switch>' +
      (signup ? 'Já tenho uma conta' : 'Criar uma conta') + '</button>' : ''),
    signup ? 'Confirme seu e-mail para começar a pedir.' : 'Use o e-mail e a senha da sua conta.');
  const switchMode = $('[data-auth-switch]',el);
  if (switchMode) switchMode.onclick = () => auth(signup ? 'login' : 'signup');
  bindSubmit($('#auth-form',el), async fields => {
    const result = await api(signup ? 'signup' : 'login', Object.fromEntries(fields));
    if (!result.signedIn) {
      modal('Confira seu e-mail', '<p class="dialog-copy">Se o cadastro estiver disponível, você receberá um link de confirmação. Depois de confirmar, volte ao Fly Delivery e entre.</p><button class="btn primary" data-signin>Voltar para entrar</button>');
      $('[data-signin]').onclick = () => auth();
      return;
    }
    current = await command('session');
    el.close();
    header();
    app.render();
    toast('Você entrou no Fly Delivery.');
  });
}

function account() {
  const el = modal('Minha conta','<p class="dialog-copy">' + esc(current.email) + '</p>' +
    '<button class="btn outline" data-logout>Sair</button>');
  $('[data-logout]',el).onclick = async () => {
    try {
      if (current.role === 'courier') await command('presence', { online:false }).catch(() => {});
      await api('logout', {});
      current = null;
      el.close();
      header();
      app.render();
    } catch (error) { toast(error.message); }
  };
}

function openActivation() {
  if (page !== 'loja' && page !== 'entregador') return;
  const prefix = '#ativar=';
  if (!location.hash.startsWith(prefix)) return;
  const token = location.hash.slice(prefix.length);
  history.replaceState(null,'',location.pathname + location.search);
  const el = modal('Defina sua senha',
    '<form class="form-stack" id="activation-form"><label>Nova senha<input name="password" type="password" autocomplete="new-password" minlength="10" maxlength="72" required></label>' +
    '<label>Confirme a senha<input name="confirmation" type="password" autocomplete="new-password" minlength="10" maxlength="72" required></label>' +
    '<p class="form-error" data-form-error role="alert"></p><button class="btn primary wide" type="submit">Ativar meu acesso</button></form>',
    'Use pelo menos 10 caracteres, incluindo letras e números.');
  bindSubmit($('#activation-form',el),async data => {
    if (data.get('password') !== data.get('confirmation')) throw new Error('As senhas precisam ser iguais.');
    await api('activate',{ token,password:data.get('password') });
    modal('Acesso ativado','<p class="dialog-copy">Entre com o seu e-mail e a senha que você acabou de criar.</p>' +
      '<button class="btn primary" data-activation-login>Entrar</button>');
    $('[data-activation-login]').onclick = () => auth();
  });
}

const context = { get user() { return current; }, signIn:auth };
app = page === 'cliente' ? customer(context) : operations(page,context);
header();
footer();
app.render();
openActivation();

try {
  current = await command('session');
  header();
  app.render();
} catch (error) {
  if (error.status !== 401) toast(error.message);
}

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installEvent = event;
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
window.addEventListener('hashchange', () => { app.render(); openActivation(); });
window.addEventListener('offline', () => toast('Você está offline.'));
main.addEventListener('click', event => {
  if (event.target.closest('[data-signin]')) auth();
  if (event.target.closest('[data-switch-account]') && current) account();
});
