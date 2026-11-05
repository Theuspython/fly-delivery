import { $, main, esc, icon, api, command, modal, toast, bindSubmit } from './shared.js';
import { customer } from './customer.js';
import { operations } from './operations.js';

const page = location.pathname.split('/')[1] || 'cliente';
const titles = { cliente:'Cliente', loja:'Estabelecimento', entregador:'Entregador', admin:'Administração' };
const links = [
  ['cliente','Cliente','bag'], ['loja','Estabelecimento','store'],
  ['entregador','Entregador','bike'], ['admin','Administração','shield']
];
let current = null;
let installEvent;
let app;

$('#manifest').href = '/' + page + '.webmanifest';

function brand() {
  return '<a class="brand" href="/cliente/" aria-label="Fly Delivery, início"><img src="/assets/icon.svg" alt="" width="41" height="41"><span>fly<span class="brand-accent">delivery</span><small>PEÇA BEM. COMA FELIZ.</small></span></a>';
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
    '<p>Seu próximo pedido está a um toque.</p></div><nav aria-label="Acessos Fly Delivery">' +
    links.map(([route,title,symbol]) => '<a href="/' + route + '/">' + icon(symbol) + ' ' + esc(title) + '</a>').join('') +
    '<button class="footer-install" data-install>' + icon('install') + ' Instalar app</button></nav></div>';
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
  const signup = mode === 'signup';
  const el = modal(signup ? 'Crie sua conta' : 'Entre no Fly Delivery',
    '<form class="form-stack" id="auth-form"><label>E-mail<input name="email" type="email" autocomplete="email" required maxlength="254"></label>' +
    '<label>Senha<input name="password" type="password" autocomplete="' + (signup ? 'new-password' : 'current-password') +
    '" required minlength="8" maxlength="128"></label><p class="form-error" data-form-error role="alert"></p>' +
    '<button class="btn primary wide" type="submit">' + (signup ? 'Criar conta' : 'Entrar') + '</button></form>' +
    '<button class="text-button auth-switch" data-auth-switch>' + (signup ? 'Já tenho uma conta' : 'Criar uma conta') + '</button>',
    signup ? 'Confirme seu e-mail para acessar os aplicativos.' : 'Use o e-mail e a senha da sua conta.');
  $('[data-auth-switch]',el).onclick = () => auth(signup ? 'login' : 'signup');
  bindSubmit($('#auth-form',el), async fields => {
    const result = await api(mode, Object.fromEntries(fields));
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
    '<div class="account-links">' + links.map(([route,title,symbol]) => '<a href="/' + route + '/">' + icon(symbol) + ' ' + esc(title) + '</a>').join('') +
    '</div><button class="btn outline" data-logout>Sair</button>');
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

const context = { get user() { return current; }, signIn:auth };
app = page === 'cliente' ? customer(context) : operations(page,context);
header();
footer();
app.render();

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
window.addEventListener('hashchange', () => app.render());
window.addEventListener('offline', () => toast('Você está offline.'));
main.addEventListener('click', event => {
  if (event.target.closest('[data-signin]')) auth();
});
