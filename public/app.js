import { $, main, esc, icon, api, command, modal, toast, bindSubmit } from './shared.js';
import { customer } from './customer.js';
import { operations } from './operations.js';
import { merchant } from './merchant.js';

const page = location.pathname.split('/')[1] || 'cliente';
const titles = { cliente:'Cliente', loja:'Estabelecimento', admin:'Administração' };
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
  const workspace = page === 'cliente' ? '' : '<span class="workspace-label">' + esc(titles[page]) + '</span>';
  $('#top').innerHTML = '<div class="wrap topbar">' +
    (page === 'loja' ? '<button class="icon-button merchant-menu-button" data-merchant-menu aria-label="Abrir menu do estabelecimento" aria-controls="merchant-navigation" aria-expanded="false">' + icon('menu') + '</button>' : '') +
    brand() + workspace + '<nav class="top-actions" aria-label="Menu principal">' +
    (clientReady ? '<div class="customer-menu"><button class="icon-button" data-customer-menu aria-label="Abrir menu do cliente" aria-expanded="false" aria-controls="customer-navigation">' +
      icon('more') + '</button><nav id="customer-navigation" aria-label="Opções do cliente" hidden><a href="#pedidos">' + icon('bag') +
      ' Pedidos</a><a href="#enderecos">' + icon('pin') + ' Endereços</a></nav></div>' : '') +
    (page !== 'cliente' || current ? '<button class="icon-button account-button" data-account aria-label="' +
    (current ? 'Minha conta' : 'Entrar') + '">' + icon('person') + '</button>' : '') +
    (clientReady ? '<a class="cart-button" href="#carrinho" aria-label="Carrinho">' + icon('bag') +
    '<span id="cart-count">0</span></a>' : '') + '</nav></div>';
  const customerMenu = $('[data-customer-menu]');
  if (customerMenu) customerMenu.onclick = () => {
    const expanded = customerMenu.getAttribute('aria-expanded') !== 'true';
    customerMenu.setAttribute('aria-expanded',String(expanded));
    $('#customer-navigation').hidden = !expanded;
  };
  const menuButton = $('[data-merchant-menu]');
  if (menuButton) menuButton.onclick = () => app.openMenu();
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

const nameInput = '<label>Nome completo<input name="name" autocomplete="name" minlength="3" maxlength="120" required></label>';
const phoneInput = '<label>Celular com DDD<input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(31) 99999-9999" maxlength="15" required></label>';
const cpfInput = '<label>CPF<input name="cpf" inputmode="numeric" autocomplete="username" placeholder="000.000.000-00" maxlength="14" required></label>';

function formatCustomerFields(form) {
  const cpf = $('[name=cpf]',form);
  const phone = $('[name=phone]',form);
  if (cpf) cpf.addEventListener('input',() => {
    cpf.value = cpf.value.replace(/\D/g,'').slice(0,11)
      .replace(/^(\d{3})(?=\d)/,'$1.').replace(/^(\d{3}\.\d{3})(?=\d)/,'$1.')
      .replace(/^(\d{3}\.\d{3}\.\d{3})(?=\d)/,'$1-');
  });
  if (phone) phone.addEventListener('input',() => {
    const digits = phone.value.replace(/\D/g,'').slice(0,11);
    phone.value = digits.length <= 2 ? digits : digits.replace(/^(\d{2})(\d{4,5})(\d{4})$/,'($1) $2-$3')
      .replace(/^([0-9]{2})([0-9]+)$/,'($1) $2');
  });
}

const passwordInput = mode => '<label>Senha<input name="password" type="password" autocomplete="' + mode +
  '" required minlength="8" maxlength="128"></label>';
const formError = '<p class="form-error" data-form-error role="alert"></p>';

function auth() {
  if (page === 'cliente') return customerAuth('login');
  const admin = page === 'admin';
  const loginField = '<label>Login<input name="login" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="254" required></label>';
  const secretField = admin ? '<label>Senha<input name="password" type="password" autocomplete="current-password" required></label>' :
    passwordInput('current-password');
  const el = modal(admin ? 'Acesso administrativo' : 'Entre no Fly Delivery',
    '<form class="form-stack" id="auth-form">' + loginField + secretField + formError +
    '<button class="btn primary wide" type="submit">Entrar</button></form>',
    admin ? 'Use o login e a senha configurados no Railway.' : 'Use o login e a senha fornecidos pela administração.');
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
    signup ? 'Cadastre-se para fazer seu primeiro pedido.' : 'Use seu CPF e sua senha.';
  main.innerHTML = '<div class="wrap customer-auth"><div class="auth-visual"><span class="overline">FLY DELIVERY</span>' +
    '<h2>Seu próximo pedido está a um toque.</h2></div><section class="panel auth-panel"><span class="overline accent">BEM-VINDO AO FLY DELIVERY</span>' +
    '<h1>' + title + '</h1><p class="muted">' + intro + '</p><form class="form-stack" id="customer-auth-form">' +
    (complete ? nameInput + phoneInput : (signup ? nameInput : '') + cpfInput +
      (signup ? phoneInput : '') + passwordInput(signup ? 'new-password' : 'current-password')) +
    formError + '<button class="btn primary wide" type="submit">' + (complete ? 'Salvar e continuar' : signup ? 'Criar conta' : 'Entrar') + '</button></form>' +
    (complete ? '' : '<button class="text-button auth-switch" data-auth-switch>' + (signup ? 'Já tenho uma conta' : 'Criar uma conta') + '</button>') +
    '</section></div>';
  const switchMode = $('[data-auth-switch]');
  if (switchMode) switchMode.onclick = () => customerAuth(signup ? 'login' : 'signup');
  const form = $('#customer-auth-form');
  formatCustomerFields(form);
  bindSubmit(form,async fields => {
    const input = Object.fromEntries(fields);
    if (complete) {
      profile = await command('customer_profile',input);
    } else {
      await api(signup ? 'signup' : 'login',input);
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

function changePassword() {
  const el = modal('Alterar senha','<form class="form-stack" id="change-password">' +
    '<label>Senha atual<input name="current_password" type="password" autocomplete="current-password" required></label>' +
    '<label>Nova senha<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="72" required></label>' +
    '<label>Confirme a nova senha<input name="confirmation" type="password" autocomplete="new-password" minlength="8" maxlength="72" required></label>' +
    formError + '<button class="btn primary wide" type="submit">Salvar nova senha</button></form>');
  bindSubmit($('#change-password',el),async fields => {
    if (fields.get('password') !== fields.get('confirmation')) throw new Error('As senhas precisam ser iguais.');
    await api('change-password',Object.fromEntries(fields));
    current = null;
    el.close();
    renderApp();
    toast('Senha alterada. Entre com a nova senha.');
  });
}

function account() {
  const canChangePassword = page === 'loja' && current.role === 'merchant' && current.operator_login;
  const name = page === 'cliente' && profile ? profile.name : page === 'admin' ? 'Administrador' :
    current.operator_login || current.email;
  const el = modal('Minha conta','<p class="dialog-copy">' + esc(name) + '</p><div class="order-actions">' +
    (canChangePassword ? '<button class="btn primary" data-change-password>Alterar senha</button>' : '') +
    '<button class="btn outline" data-logout>Sair</button></div>');
  if (canChangePassword) $('[data-change-password]',el).onclick = changePassword;
  $('[data-logout]',el).onclick = async () => {
    try {
      await api('logout', {});
      current = null;
      profile = null;
      el.close();
      renderApp();
    } catch (error) { toast(error.message); }
  };
}

function openActivation() {
  if (page !== 'loja') return;
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
    modal('Acesso ativado','<p class="dialog-copy">Entre com o identificador do seu acesso anterior e a senha que você acabou de criar.</p>' +
      '<button class="btn primary" data-activation-login>Entrar</button>');
    $('[data-activation-login]').onclick = () => auth();
  });
}

const context = { get user() { return current; }, signIn:auth };
app = page === 'cliente' ? null : page === 'loja' ? merchant(context) : operations(page,context);
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
function closeCustomerMenu() {
  $('[data-customer-menu]')?.setAttribute('aria-expanded','false');
  if ($('#customer-navigation')) $('#customer-navigation').hidden = true;
}
document.addEventListener('click',event => {
  if (!event.target.closest('.customer-menu') || event.target.closest('#customer-navigation a')) closeCustomerMenu();
});
document.addEventListener('keydown',event => {
  if (event.key === 'Escape' && $('[data-customer-menu]')?.getAttribute('aria-expanded') === 'true') {
    closeCustomerMenu();
    $('[data-customer-menu]').focus();
  }
});
window.addEventListener('hashchange', () => { closeCustomerMenu(); app?.render(); openActivation(); });
window.addEventListener('offline', () => toast('Você está offline.'));
main.addEventListener('click', event => {
  if (event.target.closest('[data-signin]')) auth();
  if (event.target.closest('[data-switch-account]') && current) account();
});
