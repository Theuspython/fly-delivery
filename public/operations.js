import { $, main, esc, icon, money, api, command, modal, toast, bindSubmit,
  categories, empty } from './shared.js';

const formEnd = label => '<p class="form-error" data-form-error role="alert"></p><button class="btn primary wide" type="submit">' + esc(label) + '</button>';

const weekdays = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];

function showCredentials(page,login,password) {
  const url = location.origin + '/' + page + '/';
  const el = modal('Acesso criado',
    '<div class="form-stack"><label>Login<input readonly value="' + esc(login) +
    '"></label><label>Senha inicial<input readonly id="operator-secret" value="' + esc(password) +
    '"></label><a class="text-button" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Abrir aplicativo</a>' +
    '<button class="btn primary" data-copy-access>Copiar acesso</button></div>',
    'Entregue estes dados em particular ao titular da conta.');
  const field = $('#operator-secret',el);
  const erase = () => {
    if (el.open && field.isConnected) return;
    field.value = '';
    el.removeEventListener('close',erase);
  };
  el.addEventListener('close',erase);
  $('[data-copy-access]',el).onclick = async () => {
    try {
      await navigator.clipboard.writeText([url,'Login: ' + login,'Senha: ' + field.value].join('\n'));
      toast('Acesso copiado.');
    } catch { toast('Copie os dados exibidos.'); }
  };
}

function registrationForm(kind,done,legacyStore) {
  const requestId = crypto.randomUUID();
  const title = legacyStore ? 'Criar acesso para ' + legacyStore.name : 'Cadastrar estabelecimento';
  const el = modal(title,'<form class="form-stack" id="operator-form">' +
    (!legacyStore ? '<label>Nome do estabelecimento<input name="name" required minlength="2" maxlength="80"></label>' +
      '<fieldset class="operator-categories"><legend>Categorias</legend>' + categories.slice(1).map(([name]) =>
      '<label class="check"><input type="checkbox" name="category" value="' + esc(name) + '"> ' + esc(name) + '</label>').join('') +
      '</fieldset>' : '') +
    '<label>Login<input name="login" autocomplete="off" autocapitalize="none" spellcheck="false" minlength="3" maxlength="40" required></label>' +
    '<label>Senha inicial<input type="password" name="password" autocomplete="new-password" minlength="8" maxlength="72" required></label>' +
    formEnd('Criar acesso') + '</form>');
  bindSubmit($('#operator-form',el),async fields => {
    const input = Object.fromEntries(fields);
    if (!legacyStore && !fields.getAll('category').length) throw new Error('Selecione pelo menos uma categoria.');
    await api('provision',{ kind,request_id:requestId,store_id:legacyStore?.id,
      name:input.name,categories:fields.getAll('category'),login:input.login,password:input.password });
    el.close();
    showCredentials('loja',input.login.trim().toLowerCase(),input.password);
    await done();
  });
}

export function storeSettings(store,done) {
  let image = store.image;
  let uploadedFile;
  const el = modal('Configurar estabelecimento',
    '<form class="form-stack" id="store-form"><label>Foto ou logo da loja<input name="photo" type="file" accept="image/jpeg,image/png,image/webp"></label>' +
    (image ? '<label class="check"><input name="remove_photo" type="checkbox"> Remover foto atual</label>' : '') +
    '<p class="muted">JPG, PNG ou WebP, até 3 MB.</p><label>Descrição da loja<textarea name="description" rows="2" maxlength="260">' +
    esc(store.description) + '</textarea></label><fieldset class="operator-hours"><legend>Horário de funcionamento</legend>' +
    weekdays.map((day,index) => {
      const hours = store.weekly_hours?.[index];
      const enabled = Boolean(hours);
      return '<div class="operator-day"><label class="check"><input type="checkbox" name="day-' + index + '"' +
        (enabled ? ' checked' : '') + '> ' + day + '</label><input aria-label="Abertura de ' + day +
        '" type="time" name="open-' + index + '" value="' + esc(hours?.open ?? '09:00') + '"' + (enabled ? '' : ' disabled') +
        '><input aria-label="Fechamento de ' + day + '" type="time" name="close-' + index + '" value="' +
        esc(hours?.close ?? '18:00') + '"' + (enabled ? '' : ' disabled') + '></div>';
    }).join('') + '<p class="muted">Selecione os dias abertos. O horário é de Brasília. Para 24 horas, use 00:00 nos dois campos.</p></fieldset>' +
    '<label>Endereço do estabelecimento<input name="address" autocomplete="street-address" required minlength="5" maxlength="240" value="' +
    esc(store.address) + '"></label><div class="fields-two"><label>Taxa de entrega (R$)<input name="fee" type="number" step="0.01" min="0" max="1000" required value="' +
    store.fee / 100 + '"></label><label>Prazo (min)<input name="eta" type="number" min="5" max="180" required value="' +
    store.eta + '"></label></div><p class="muted">O estabelecimento é responsável pela entrega com sua própria equipe.</p>' +
    '<label class="check"><input name="active" type="checkbox"' + (store.active || !store.address ? ' checked' : '') +
    '> Publicar no catálogo</label>' + formEnd('Salvar configurações') + '</form>');
  weekdays.forEach((_,index) => {
    const check = $('[name="day-' + index + '"]',el);
    check.onchange = () => {
      $('[name="open-' + index + '"]',el).disabled = !check.checked;
      $('[name="close-' + index + '"]',el).disabled = !check.checked;
    };
  });
  bindSubmit($('#store-form',el),async data => {
    const file = data.get('photo');
    if (file?.size && file !== uploadedFile) {
      if (file.size > 3 * 1024 * 1024) throw new Error('A foto deve ter até 3 MB.');
      image = (await api('upload?store=' + encodeURIComponent(store.id),file)).url;
      uploadedFile = file;
    }
    await command('save_store_profile',{ id:store.id,address:data.get('address'),description:data.get('description'),
      fee:Math.round(Number(data.get('fee'))*100),eta:Number(data.get('eta')),
      active:data.has('active'),image:data.has('remove_photo') && !file?.size ? null : image,
      weekly_hours:weekdays.map((_,index) => data.has('day-' + index) ?
        { open:data.get('open-' + index),close:data.get('close-' + index) } : null)
    });
    el.close();
    toast('Configurações salvas.');
    await done();
  });
}

export function productForm(store, product, done) {
  let photo = product?.image;
  let selectedFile;
  const el = modal(product ? 'Editar produto' : 'Adicionar produto',
    '<form class="form-stack" id="product-form"><label>Nome<input name="name" required minlength="2" maxlength="100" value="' +
    esc(product?.name) + '"></label><label>Descrição<textarea name="description" rows="3" maxlength="500">' + esc(product?.description) +
    '</textarea></label><label>Preço (R$)<input name="price" type="number" min="0.01" max="10000" step="0.01" required value="' +
    (product ? product.price / 100 : '') + '"></label><label>Foto do produto<input name="photo" type="file" accept="image/jpeg,image/png,image/webp"></label>' +
    (photo ? '<button class="text-button" type="button" data-remove-photo>Remover foto atual</button>' : '') +
    '<p class="muted">JPG, PNG ou WebP, até 3 MB.</p><label class="check"><input name="active" type="checkbox"' +
    (product?.active !== false ? ' checked' : '') + '> Disponível no cardápio</label>' + formEnd('Salvar produto') + '</form>');
  const remove = $('[data-remove-photo]',el);
  if (remove) remove.onclick = () => { photo = null; remove.textContent = 'Foto marcada para remoção'; remove.disabled = true; };
  bindSubmit($('#product-form',el), async data => {
    const file = data.get('photo');
    if (file?.size && file !== selectedFile) {
      if (file.size > 3 * 1024 * 1024) throw new Error('A foto deve ter até 3 MB.');
      photo = (await api('upload?store=' + encodeURIComponent(store.id),file)).url;
      selectedFile = file;
    }
    await command('save_product', { id:product?.id, store_id:store.id, name:data.get('name'), description:data.get('description'),
      price:Math.round(Number(data.get('price'))*100), active:data.has('active'), image:photo });
    el.close();
    toast('Produto salvo.');
    await done();
  });
}

export function storeMarkup(store, role, productsOnly = false) {
  const labels = esc((store.categories ?? [store.category]).join(' · '));
  if (role === 'admin') {
    return '<article class="panel management-card"><span class="overline">' + labels + '</span><h3>' + esc(store.name) +
      '</h3><p>' + (store.owner_login ? 'Login: ' + esc(store.owner_login) : 'Acesso a configurar') + '</p>' +
      (!store.owner_login ? '<div class="order-actions"><button class="btn outline" data-link-store="' + esc(store.id) +
        '">Criar login</button></div>' : '') + '</article>';
  }
  const actions = (productsOnly ? '' : '<button class="btn outline" data-settings="' + esc(store.id) + '">Foto e horários</button>' +
    (store.address ? '<button class="btn outline" data-open="' + esc(store.id) + '">' + (store.is_open ? 'Pausar pedidos' : 'Ativar pedidos') + '</button>' : '')) +
    '<button class="btn primary" data-add-product="' + esc(store.id) + '">' + icon('plus') + ' Produto</button>';
  return '<article class="panel management-card"><div class="management-head"><div><span class="overline">' + labels +
    '</span><h3>' + esc(store.name) + '</h3><p>' + esc(store.address || 'Configure o endereço e os horários para publicar.') + '</p></div><span class="status ' +
    (store.accepting_now ? 'status-delivered' : 'status-cancelled') + '">' +
    (store.active ? store.accepting_now ? 'Aberta agora' : 'Fechada agora' : 'Não publicada') + '</span></div>' +
    '<div class="order-actions">' + actions + '</div><div class="menu-admin">' + (store.products.length ? store.products.map(product =>
      '<div class="menu-admin-row">' + (product.image ? '<img src="' + esc(product.image) + '" alt="">' : '<span class="product-placeholder">' + icon('bag') + '</span>') +
      '<div><strong>' + esc(product.name) + '</strong><p>' + money(product.price) + ' · ' + (product.active ? 'Disponível' : 'Pausado') +
      '</p></div><button class="btn outline" data-edit-product="' + esc(product.id) + '" data-store="' + esc(store.id) + '">Editar</button></div>').join('') :
      '<p class="muted">Nenhum produto cadastrado.</p>') + '</div></article>';
}

export function operations(page, context) {
  let timer;
  let sequence = 0;
  let storeList = [];
  let refreshing = false;

  async function refresh(force = false) {
    if ((refreshing && !force) || context.user?.role !== 'admin') return;
    const user = context.user;
    const revision = ++sequence;
    refreshing = true;
    try {
      const stores = await command('managed_stores');
      if (revision !== sequence || context.user !== user) return;
      storeList = stores;
      const region = $('#ops-stores');
      if (!region) return;
      const markup = '<div class="section-head"><h2>Estabelecimentos</h2><button class="btn primary" data-add-store>' +
        icon('plus') + ' Novo estabelecimento</button></div>' + (stores.length ? '<div class="management-grid">' +
        stores.map(store => storeMarkup(store,'admin')).join('') + '</div>' : '<div class="panel">' +
        empty('Nenhuma loja cadastrada','Cadastre o primeiro estabelecimento.','store') + '</div>');
      if (region.innerHTML !== markup) region.innerHTML = markup;
      $('#ops-error').textContent = '';
    } catch (error) {
      if (revision === sequence && $('#ops-error')) $('#ops-error').textContent = error.message;
    } finally {
      if (revision === sequence) refreshing = false;
    }
  }

  function render() {
    clearInterval(timer);
    sequence++;
    refreshing = false;
    const user = context.user;
    main.innerHTML = '<div class="wrap page ops"><div class="ops-heading"><div class="ops-mark">' + icon('shield') +
      '</div><div><span class="overline accent">GESTÃO FLY DELIVERY</span><h1>Administração</h1>' +
      '<p>Cadastre estabelecimentos e crie o login e a senha de cada loja.</p></div></div><div id="ops-body"></div></div>';
    const body = $('#ops-body');
    if (user?.role !== 'admin') {
      body.innerHTML = '<div class="panel">' + empty(user ? 'Acesso restrito' : 'Entre para continuar',
        user ? 'Seu perfil não tem acesso a esta área.' : 'Use o login e a senha da administração.','shield') +
        (user ? '<button class="btn outline" data-switch-account>Trocar de conta</button>' : '<button class="btn primary" data-signin>Entrar</button>') + '</div>';
      return;
    }
    body.innerHTML = '<p class="form-error" id="ops-error" role="alert"></p><section id="ops-stores"><p class="muted">Carregando estabelecimentos…</p></section>';
    body.addEventListener('click',event => {
      const button = event.target.closest('button');
      if (!button || button.disabled) return;
      if (button.hasAttribute('data-add-store') || button.dataset.linkStore) {
        registrationForm('store',() => refresh(true),storeList.find(store => store.id === button.dataset.linkStore));
      }
    });
    refresh(true);
    timer = setInterval(() => { if (!document.hidden) refresh(); },6000);
  }
  return { render };
}
