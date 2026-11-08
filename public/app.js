import { $, main, esc, icon, api, command, modal, toast, bindSubmit, profileAvatar } from './shared.js';
import { setupInstall } from './install.js';
import { customer } from './customer.js';
import { operations } from './operations.js';
import { merchant } from './merchant.js';
import { compactProfilePhoto,validateProfilePhoto } from './profile-photo.js';

const page = location.pathname.split('/')[1] || 'cliente';
const titles = { cliente:'Cliente', loja:'Estabelecimento', admin:'Administração' };
let current = null;
const installer = setupInstall();
let app;
let profile;
let checkedSession = page === 'admin';

$('#manifest').href = '/' + page + '.webmanifest';

function brand() {
  return '<a class="brand" href="/' + page + '/" aria-label="Fly Delivery, início"><img src="/assets/icon.svg?v=motoboy" alt="" width="41" height="41"><span>fly<span class="brand-accent">delivery</span><small>PEÇA BEM. COMA FELIZ.</small></span></a>';
}
function header() {
  const clientReady = page === 'cliente' && profile;
  const workspace = page === 'cliente' ? '' : '<span class="workspace-label">' + esc(titles[page]) + '</span>';
  $('#top').innerHTML = '<div class="wrap topbar' + (page === 'loja' && !current ? ' merchant-guest-topbar' : '') + '">' +
    (clientReady ? '<div class="customer-quick-nav"><button class="icon-button customer-menu-button" data-customer-menu aria-label="Abrir menu do cliente" aria-controls="customer-navigation" aria-expanded="false">' + icon('menu') + '</button>' +
    '<a class="icon-button home-button" data-home href="#lojas" aria-label="Voltar à vitrine" title="Início">' + icon('home') + '</a></div>' : '') +
    (page === 'loja' && current?.role === 'merchant' ? '<button class="icon-button merchant-menu-button" data-merchant-menu aria-label="Abrir menu do estabelecimento" aria-controls="merchant-navigation" aria-expanded="false">' + icon('menu') + '</button>' : '') +
    (page === 'admin' ? '<button class="icon-button merchant-menu-button" data-admin-menu aria-label="Abrir menu da administração" aria-controls="admin-navigation" aria-expanded="false">' + icon('menu') + '</button>' : '') +
    brand() + workspace + '<nav class="top-actions" aria-label="Menu principal">' +
    (clientReady ? '<button type="button" class="icon-button notification-button" data-notifications aria-label="Notificações" aria-haspopup="dialog">' + icon('bell') +
    '<span class="notification-count" data-notification-count aria-hidden="true" hidden></span></button>' :
    page === 'loja' && current?.role === 'merchant' ? '<a class="icon-button home-button" data-merchant-home href="#pedidos" aria-label="Voltar aos pedidos em andamento" title="Pedidos em andamento">' + icon('home') + '</a>' :
    page !== 'cliente' || current ? '<button class="icon-button account-button" data-account aria-label="' +
    (current ? 'Minha conta' : 'Entrar') + '">' + icon('person') + '</button>' : '') +
    (clientReady ? '<a class="cart-button" href="#carrinho" aria-label="Carrinho">' + icon('bag') +
    '<span id="cart-count">0</span></a>' : '') + '</nav></div>' +
    '<div class="install-banner" data-install-container><button class="btn primary top-install" data-install>' + icon('install') + ' Instalar app</button></div>';
  installer.bind($('[data-install]',$('#top')));
  const customerMenu = $('[data-customer-menu]');
  if (customerMenu) customerMenu.onclick = () => app.openMenu();
  const menuButton = $('[data-merchant-menu]');
  if (menuButton) menuButton.onclick = () => app.openMenu();
  const adminMenu = $('[data-admin-menu]');
  if (adminMenu) adminMenu.onclick = () => app.openMenu();
  const homeButton = $('[data-home]');
  if (homeButton) homeButton.onclick = event => { event.preventDefault(); app.goHome(); };
  const notifications = $('[data-notifications]');
  if (notifications) notifications.onclick = () => app.openNotifications();
  const merchantHome = $('[data-merchant-home]');
  if (merchantHome) merchantHome.onclick = () => window.scrollTo(0,0);
  const button = $('[data-account]',$('#top'));
  if (button) button.onclick = () => current ? account() : auth();
  if (clientReady) app.updateHeader();
}

function footer() {
  $('#footer').innerHTML = '<div class="wrap footer-inner">' + brand() + '</div>';
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
  if (page === 'loja') {
    if (!checkedSession) return;
    if ($('#dialog').open) $('#dialog').close();
    if (!$('#merchant-login-form')) merchantAuth();
    $('#merchant-login').focus();
    return;
  }
  const el = modal('Acesso administrativo',
    '<form class="form-stack" id="auth-form"><label>Login<input name="login" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="254" required></label>' +
    '<label>Senha<input name="password" type="password" autocomplete="current-password" required></label>' + formError +
    '<button class="btn primary wide" type="submit">Entrar</button></form>', 'Use o login e a senha configurados no Railway.');
  bindOperatorLogin($('#auth-form',el),el);
}

function bindOperatorLogin(form,dialog) {
  bindSubmit(form, async fields => {
    await api('login',Object.fromEntries(fields));
    await loadSession();
    dialog?.close();
    renderApp();
  });
}

function merchantAuth() {
  main.innerHTML = '<div class="wrap merchant-auth"><div class="auth-visual merchant-auth-visual">' +
    '<span class="hero-kicker"><span></span> FLY DELIVERY PARA LOJAS</span>' +
    '<p class="merchant-auth-title">Sua loja no<br> Fly Delivery.</p>' +
    '<p>Acompanhe pedidos, atualize seu cardápio e consulte suas vendas.</p></div>' +
    '<section class="panel auth-panel merchant-auth-panel" aria-labelledby="merchant-auth-title">' +
    '<span class="merchant-auth-mark" aria-hidden="true">' + icon('store') + '</span>' +
    '<span class="overline accent">ÁREA DO ESTABELECIMENTO</span><h1 id="merchant-auth-title">Entre na sua loja</h1>' +
    '<p class="muted">Use o login e a senha fornecidos pela administração.</p>' +
    '<form class="form-stack" id="merchant-login-form">' +
    '<label for="merchant-login">Login<input id="merchant-login" name="login" type="text" placeholder="Digite seu login" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="254" required></label>' +
    '<div class="merchant-auth-password"><label for="merchant-password">Senha</label><div>' +
    '<input id="merchant-password" name="password" type="password" placeholder="Digite sua senha" autocomplete="current-password" minlength="8" maxlength="128" required>' +
    '<button type="button" class="text-button" data-password-toggle aria-controls="merchant-password">Mostrar<span class="sr-only"> senha</span></button></div></div>' +
    formError + '<button class="btn primary wide" type="submit">Acessar minha loja ' + icon('arrow') + '</button></form></section></div>';
  const password = $('#merchant-password');
  const toggle = $('[data-password-toggle]');
  toggle.onclick = () => {
    const reveal = password.type === 'password';
    password.type = reveal ? 'text' : 'password';
    toggle.firstChild.textContent = reveal ? 'Ocultar' : 'Mostrar';
  };
  bindOperatorLogin($('#merchant-login-form'));
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
  if (page === 'loja' && !current) {
    app.closeMenu();
    header();
    if (checkedSession) merchantAuth();
    else main.innerHTML = '<div class="wrap page"><p class="muted" role="status">Verificando sua sessão…</p></div>';
    return;
  }
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
  const customerPhoto = page === 'cliente' && profile;
  const el = modal('Minha conta',(customerPhoto ? '<div class="account-profile"><div data-profile-preview>' +
    profileAvatar(profile.photo,name,'cliente',true) + '</div><div><h3>' + esc(name) + '</h3><p class="muted">' +
    esc(profile.phone) + '</p></div></div><form id="profile-photo-form" class="form-stack"><label>Foto de perfil<input name="photo" type="file" accept="image/jpeg,image/png,image/webp" required></label>' +
    '<p class="muted">JPG, PNG ou WebP, até 20 MB. Compactamos a foto antes de enviar. Ela aparece nos pedidos recebidos pelos estabelecimentos.</p><p class="muted" data-photo-status role="status"></p>' +
    '<p class="form-error" data-form-error role="alert"></p><button class="btn primary wide" type="submit">Salvar foto</button></form>' :
    '<p class="dialog-copy">' + esc(name) + '</p>') + '<div class="order-actions">' +
    (canChangePassword ? '<button class="btn primary" data-change-password>Alterar senha</button>' : '') +
    '<button class="btn outline" data-logout>Sair</button></div>');
  if (customerPhoto) {
    const actor = current.id;
    const form = $('#profile-photo-form',el);
    const input=$('[name=photo]',form),save=$('button[type=submit]',form),error=$('[data-form-error]',form),status=$('[data-photo-status]',form);
    let previewUrl,source,prepared,preparing,revision=0,closed=false;
    const sizeLabel=bytes=>bytes>=1024*1024?new Intl.NumberFormat('pt-BR',{maximumFractionDigits:1}).format(bytes/(1024*1024))+' MB':Math.max(1,Math.round(bytes/1024))+' KB';
    el.addEventListener('close',() => { closed=true;revision++;if (previewUrl) URL.revokeObjectURL(previewUrl); },{ once:true });
    function prepare(file) {
      if(source===file&&prepared)return Promise.resolve(prepared);
      if(source===file&&preparing)return preparing;
      const request=++revision;source=file;prepared=null;save.disabled=true;error.textContent='';status.textContent='Compactando sua foto…';
      preparing=compactProfilePhoto(file).then(compact=>{
        if(closed||request!==revision)return compact;
        prepared=compact;
        if(previewUrl)URL.revokeObjectURL(previewUrl);
        previewUrl=URL.createObjectURL(compact);
        $('[data-profile-preview]',el).innerHTML='<span class="profile-avatar profile-avatar-large"><img src="'+esc(previewUrl)+'" alt="Prévia da foto compactada"></span>';
        status.textContent='Foto pronta: '+sizeLabel(compact.size)+' (original: '+sizeLabel(file.size)+').';
        return compact;
      }).catch(err=>{if(!closed&&request===revision){error.textContent=err.message;status.textContent='';}throw err;})
        .finally(()=>{if(!closed&&request===revision){preparing=null;save.disabled=false;}});
      return preparing;
    }
    input.onchange=event=>{prepare(event.target.files[0]).catch(()=>{});};
    bindSubmit(form,async () => {
      const file=input.files[0];validateProfilePhoto(file);
      const compact=await prepare(file);
      if(closed||!form.isConnected||current?.id!==actor)return;
      input.disabled=true;save.disabled=true;save.textContent='Enviando foto…';
      try {
        const updated=await api('upload-profile',compact);
        if (current?.id !== actor) return;
        profile = updated;
        if (!closed&&form.isConnected&&el.open) account();
        toast('Foto de perfil salva.');
      } finally {input.disabled=false;save.textContent='Salvar foto';}
    });
  }
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

const context = { get user() { return current; }, signIn:auth, openAccount:account };
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

window.addEventListener('hashchange', () => {
  app?.closeMenu?.();
  if (page !== 'loja' || current) app?.render();
  openActivation();
});
window.addEventListener('offline', () => toast('Você está offline.'));
main.addEventListener('click', event => {
  if (event.target.closest('[data-signin]')) auth();
  if (event.target.closest('[data-switch-account]') && current) account();
});

document.addEventListener('error',event => {
  if (event.target.tagName !== 'IMG') return;
  const avatar = event.target.closest('.profile-avatar');
  if (avatar) { avatar.dataset.failedPhoto=event.target.getAttribute('src');avatar.textContent = avatar.dataset.initials || 'C'; }
},true);
