import { $, main, esc, icon, api, command, modal, toast, bindSubmit } from './shared.js';
import { customer } from './customer.js';
import { operations } from './operations.js';

const page = location.pathname.split('/')[1] || 'cliente';
const titles = { cliente:'Cliente', loja:'Estabelecimento', entregador:'Entregador', admin:'Administração' };
let current = null;
let installEvent;
let app;
let profile;
let checkedSession = page !== 'cliente';

$('#manifest').href = '/' + page + '.webmanifest';

function brand() {
  return '<a class="brand" href="/' + page + '/" aria-label="Fly Delivery, início"><img src="/assets/icon.svg" alt="" width="41" height="41"><span>fly<span class="brand-accent">delivery</span><small>PEÇA BEM. COMA FELIZ.</small></span></a>';
}
function header() {
  const clientReady = page === 'cliente' && profile;
  const linksHtml = clientReady
    ? '<a href="#inicio">Início</a><a href="#lojas">Restaurantes</a><a href="#pedidos">Meus pedidos</a>'
    : '<span class="workspace-label">' + esc(titles[page]) + '</span>';
  $('#top').innerHTML = '<div class="wrap topbar">' + brand() + '<nav class="top-nav" aria-label="Menu principal">' + linksHtml +
    '</nav><div class="top-actions">' + (page !== 'cliente' || current ? '<button class="icon-button account-button" data-account aria-label="' +
    (current ? 'Minha conta' : 'Entrar') + '">' + icon('person') + '</button>' : '') +
    (clientReady ? '<a class="cart-button" href="#carrinho" aria-label="Carrinho">' + icon('bag') +
    '<span id="cart-count">0</span></a>' : '') + '</div></div>';
  const button = $('[data-account]');
  if (button) button.onclick = () => current ? account() : auth();
  if (clientReady) app.updateHeader();
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

const profileInputs = '<label>Nome completo<input name="name" autocomplete="name" minlength="3" maxlength="120" required></label>' +
  '<label>Celular com DDD<input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(31) 99999-9999" maxlength="24" required></label>';
const emailInput = '<label>E-mail<input name="email" type="email" autocomplete="email" required maxlength="254"></label>';
const passwordInput = mode => '<label>Senha<input name="password" type="password" autocomplete="' + mode +
  '" required minlength="8" maxlength="128"></label>';
const formError = '<p class="form-error" data-form-error role="alert"></p>';

function auth() {
  if (page === 'cliente') return customerAuth('login');
  const el = modal('Entre no Fly Delivery',
    '<form class="form-stack" id="auth-form">' + emailInput + passwordInput('current-password') + formError +
    '<button class="btn primary wide" type="submit">Entrar</button></form>',
    'Use o e-mail e a senha da sua conta.');
  bindSubmit($('#auth-form',el), async fields => {
    await api('login',Object.fromEntries(fields));
    await loadSession();
    el.close();
    renderApp();
  });
}

function customerAuth(mode = 'signup') {
  const signup = mode === 'signup';
  const complete = mode === 'complete';
  const title = complete ? 'Complete seu cadastro' : signup ? 'Crie sua conta' : 'Entre na sua conta';
  const intro = complete ? 'Informe seu nome e celular para começar a pedir.' :
    signup ? 'Preencha seus dados para escolher seus pratos e fazer o primeiro pedido.' : 'Use seu e-mail e senha para acessar a vitrine.';
  main.innerHTML = '<div class="wrap customer-auth"><div class="auth-visual"><span class="overline">FLY DELIVERY</span>' +
    '<h2>Seu próximo pedido está a um toque.</h2></div><section class="panel auth-panel"><span class="overline accent">BEM-VINDO AO FLY DELIVERY</span>' +
    '<h1>' + title + '</h1><p class="muted">' + intro + '</p><form class="form-stack" id="customer-auth-form">' +
    (signup || complete ? profileInputs : '') + (complete ? '' : emailInput + passwordInput(signup ? 'new-password' : 'current-password')) +
    (signup ? '<label>Confirme a senha<input name="confirmation" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label>' : '') +
    formError + '<button class="btn primary wide" type="submit">' + (complete ? 'Salvar e continuar' : signup ? 'Criar conta' : 'Entrar') + '</button></form>' +
    (complete ? '' : '<button class="text-button auth-switch" data-auth-switch>' + (signup ? 'Já tenho uma conta' : 'Criar uma conta') + '</button>') +
    '</section></div>';
  const switchMode = $('[data-auth-switch]');
  if (switchMode) switchMode.onclick = () => customerAuth(signup ? 'login' : 'signup');
  bindSubmit($('#customer-auth-form'),async fields => {
    const input = Object.fromEntries(fields);
    if (complete) {
      profile = await command('customer_profile',input);
    } else {
      if (signup && input.confirmation !== input.password) throw new Error('As senhas precisam ser iguais.');
      const result = await api(signup ? 'signup' : 'login',input);
      if (!result.signedIn) {
        customerAuth('login');
        $('[data-form-error]').textContent = 'Confira seu e-mail para confirmar o cadastro. Depois, entre com a sua senha.';
        return;
      }
      await loadSession();
    }
    renderApp();
  });
}

async function loadSession() {
  current = await command('session');
  if (page === 'cliente') profile = await command('customer_profile');
}

function renderApp() {
  if (page === 'cliente' && !profile) {
    app?.stop();
    app = null;
    header();
    if (checkedSession) customerAuth(current ? 'complete' : 'signup');
    else main.innerHTML = '<div class="wrap page"><p class="muted">Verificando sua sessão…</p></div>';
    return;
  }
  if (!app && page === 'cliente') app = customer(context);
  header();
  app.render();
}

function account() {
  const el = modal('Minha conta','<p class="dialog-copy">' + esc(current.email) + '</p>' +
    '<button class="btn outline" data-logout>Sair</button>');
  $('[data-logout]',el).onclick = async () => {
    try {
      if (current.role === 'courier') await command('presence', { online:false }).catch(() => {});
      await api('logout', {});
      current = null;
      profile = null;
      el.close();
      renderApp();
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
app = page === 'cliente' ? null : operations(page,context);
footer();
renderApp();
openActivation();

try {
  await loadSession();
} catch (error) {
  if (error.status !== 401) toast(error.message);
} finally {
  checkedSession = true;
  renderApp();
}

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installEvent = event;
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
window.addEventListener('hashchange', () => { app?.render(); openActivation(); });
window.addEventListener('offline', () => toast('Você está offline.'));
main.addEventListener('click', event => {
  if (event.target.closest('[data-signin]')) auth();
  if (event.target.closest('[data-switch-account]') && current) account();
});
