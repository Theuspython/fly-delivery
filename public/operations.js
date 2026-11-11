import { mountPromotionDays } from './promotions.js';
import { mountPlatformCoupons } from './platform-coupons.js';
import { percentage } from './invoices.js';
import { createCommissionDashboard } from './admin-dashboard.js';
import { mountHistoryCleanup } from './admin-history-cleanup.js';
import { createMealEditor } from './meal-choices.js';
import { normalize } from './catalog-search.js';
import { $, main, esc, icon, money, api, command, modal, toast, bindSubmit,
  categories, sortCategories, sortMenuCategories, empty } from './shared.js';

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

function editStoreForm(store,done) {
  const el=modal('Editar estabelecimento','<form class="form-stack" id="edit-store-form"><label>Nome do estabelecimento<input name="name" minlength="2" maxlength="80" required value="' + esc(store.name) + '"></label>' +
    '<fieldset class="operator-categories"><legend>Categorias</legend>' + categories.slice(1).map(([name]) =>
      '<label class="check"><input type="checkbox" name="category" value="' + esc(name) + '"' +
      ((store.categories ?? [store.category]).includes(name) ? ' checked' : '') + '> ' + esc(name) + '</label>').join('') + '</fieldset>' +
    (store.owner_login ? '<p class="muted">Login da loja: ' + esc(store.owner_login) + '</p>' : '') + formEnd('Salvar alterações') + '</form>');
  bindSubmit($('#edit-store-form',el),async fields => {
    const selected=fields.getAll('category');
    if (!selected.length) throw new Error('Selecione pelo menos uma categoria.');
    await command('admin_update_store',{id:store.id,name:fields.get('name'),categories:selected});
    el.close();toast('Estabelecimento atualizado.');await done();
  });
}

function suspensionForm(store,done) {
  const el=modal('Suspender estabelecimento','<form class="form-stack" id="suspend-store-form"><p><strong>' + esc(store.name) + '</strong> ficará oculto na vitrine e não receberá novos pedidos. A loja continuará acessando as faturas e os pedidos já recebidos.</p><label>Mensagem para o estabelecimento<textarea name="reason" rows="4" maxlength="500">Estabelecimento suspenso por pendência de pagamento da comissão Fly Delivery. Acesse Faturas Fly Delivery para regularizar ou fale com a administração.</textarea></label>' + formEnd('Confirmar suspensão') + '</form>');
  bindSubmit($('#suspend-store-form',el),async fields=>{
    await command('admin_set_suspension',{id:store.id,suspend:true,reason:fields.get('reason')});
    el.close();toast('Estabelecimento suspenso.');await done();
  });
}

function trustReleaseForm(store,done) {
  const el=modal('Liberar por confiança','<form class="form-stack" id="trust-release-form"><p><strong>' + esc(store.name) + '</strong> voltará à vitrine mesmo com ' + (store.suspension?.overdue_count ?? 0) + ' fatura(s) vencida(s), no total de <strong>' + money(store.suspension?.overdue_cents ?? 0) + '</strong>.</p><p class="muted">A dívida continua em aberto. Esta liberação vale para as faturas já vencidas; uma nova fatura que vencer sem pagamento poderá bloquear a loja novamente.</p>' + formEnd('Confirmar liberação de confiança') + '</form>');
  bindSubmit($('#trust-release-form',el),async()=>{
    await command('admin_set_suspension',{id:store.id,suspend:false,trust:true});
    el.close();toast('Estabelecimento liberado por confiança. A dívida continua em aberto.');await done();
  });
}

function deleteStoreForm(store,done) {
  const el=modal('Excluir estabelecimento','<form class="form-stack" id="delete-store-form"><p>Excluir <strong>' + esc(store.name) +
    '</strong> da operação?</p><p class="muted">A loja sairá da vitrine. Produtos e histórico de pedidos finalizados serão preservados.</p>' +
    '<p class="form-error" data-form-error role="alert"></p><div class="order-actions"><button type="button" class="btn outline" data-cancel-delete>Voltar</button>' +
    '<button type="submit" class="btn danger">Excluir estabelecimento</button></div></form>');
  $('[data-cancel-delete]',el).onclick=()=>el.close();
  bindSubmit($('#delete-store-form',el),async()=>{
    await command('admin_delete_store',{id:store.id});
    el.close();toast('Estabelecimento excluído.');await done();
  });
}

export function storeSettings(store,done) {
  let image = store.image;
  let uploadedFile;
  const el = modal('Foto, horários e entrega',
    '<form class="form-stack" id="store-form"><div class="store-settings-summary"><section class="panel"><h3>Foto da loja</h3><label>Foto ou logo<input name="photo" type="file" accept="image/jpeg,image/png,image/webp"></label>' +
    (image ? '<label class="check"><input name="remove_photo" type="checkbox"> Remover foto atual</label>' : '') +
    '<p class="muted">JPG, PNG ou WebP, até 20 MB. A foto é salva com até 50 KB.</p></section>' +
    '<section class="panel"><h3>Entrega e publicação</h3><div class="fields-two"><label>Taxa de entrega (R$)<input name="fee" type="number" step="0.01" min="0" max="1000" required value="' +
    store.fee / 100 + '"></label><label>Prazo (min)<input name="eta" type="number" min="5" max="180" required value="' +
    store.eta + '"></label></div><label class="check"><input name="active" type="checkbox"' + (store.active || (!store.weekly_hours && !store.address) ? ' checked' : '') +
    '> Publicar no catálogo</label></section></div>' +
    '<fieldset class="operator-hours"><legend>Horário de funcionamento</legend><p class="muted">Marque os dias de atendimento. Os horários seguem o fuso de Brasília. Para atender 24 horas, use 00:00 nos dois campos.</p><div class="store-hours-grid">' +
    weekdays.map((day,index) => {
      const hours = store.weekly_hours?.[index];
      const enabled = Boolean(hours);
      return '<div class="operator-day"><label class="check"><input type="checkbox" name="day-' + index + '"' +
        (enabled ? ' checked' : '') + '> ' + day + '</label><label>Abertura<input aria-label="Abertura de ' + day +
        '" type="time" name="open-' + index + '" value="' + esc(hours?.open ?? '09:00') + '" required' + (enabled ? '' : ' disabled') +
        '></label><label>Fechamento<input aria-label="Fechamento de ' + day + '" type="time" name="close-' + index + '" value="' +
        esc(hours?.close ?? '18:00') + '" required' + (enabled ? '' : ' disabled') + '></label></div>';
    }).join('') + '</div></fieldset><div class="store-settings-save">' + formEnd('Salvar configurações') + '</div></form>',store.name);
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
      if (file.size > 20 * 1024 * 1024) throw new Error('A foto deve ter até 20 MB.');
      image = (await api('upload?store=' + encodeURIComponent(store.id),file)).url;
      uploadedFile = file;
    }
    await command('save_store_profile',{ id:store.id,
      fee:Math.round(Number(data.get('fee'))*100),eta:Number(data.get('eta')),
      active:data.has('active'),...(file?.size ? {image} : data.has('remove_photo') ? {image:null} : {}),
      weekly_hours:weekdays.map((_,index) => data.has('day-' + index) ?
        { open:data.get('open-' + index),close:data.get('close-' + index) } : null)
    });
    el.close();
    toast('Configurações salvas.');
    await done();
  });
}

const availableMenuCategories = store => sortMenuCategories([...(store.categories ?? [store.category]),...(store.menu_categories ?? [])],store.menu_category_order);

export function organizeMenuCategories(store,done) {
  const el = modal('Organizar categorias',
    '<form class="form-stack" id="menu-order-form"><p class="muted">Use Subir e Descer para definir a ordem das categorias no cardápio da loja.</p>' +
    '<ol class="menu-category-order">' + availableMenuCategories(store).map(label =>
      '<li data-order-category="' + esc(label) + '"><strong>' + esc(label) + '</strong><div>' +
      '<button class="btn outline" type="button" data-move-category="up" aria-label="Subir ' + esc(label) + '">Subir</button>' +
      '<button class="btn outline" type="button" data-move-category="down" aria-label="Descer ' + esc(label) + '">Descer</button></div></li>'
    ).join('') + '</ol><span class="sr-only" role="status" data-menu-order-status></span>' + formEnd('Salvar ordem') + '</form>',store.name);
  const form = $('#menu-order-form',el);
  const list = $('ol',form);
  function syncMoves() {
    for (const row of list.children) {
      $('[data-move-category=up]',row).disabled = !row.previousElementSibling;
      $('[data-move-category=down]',row).disabled = !row.nextElementSibling;
    }
  }
  list.onclick = event => {
    const button = event.target.closest('[data-move-category]');
    if (!button || button.disabled) return;
    const row = button.closest('li');
    if (button.dataset.moveCategory==='up') row.previousElementSibling.before(row);
    else row.nextElementSibling.after(row);
    syncMoves();
    (button.disabled ? $('button:not(:disabled)',row) : button)?.focus({preventScroll:true});
    $('[data-menu-order-status]',form).textContent = row.dataset.orderCategory + ' na posição ' + ([...list.children].indexOf(row)+1) + '.';
  };
  syncMoves();
  bindSubmit(form,async () => {
    const order = [...list.children].map(row=>row.dataset.orderCategory);
    list.inert = true;
    try { await command('save_menu_category_order',{store_id:store.id,order}); }
    finally { list.inert = false; }
    el.close();
    toast('Ordem do cardápio salva.');
    await done();
  });
}

export function productForm(store, product, done) {
  const allowedCategories = availableMenuCategories(store);
  const selectedCategory = allowedCategories.includes(product?.category) ? product.category : allowedCategories.length === 1 ? allowedCategories[0] : '';
  let photo = product?.image;
  let selectedFile;
  let mealEditor;
  const el = modal(product ? 'Editar produto' : 'Adicionar produto',
    '<form class="form-stack" id="product-form"><label>Nome<input name="name" required minlength="2" maxlength="100" value="' +
    esc(product?.name) + '"></label><label>Categoria<select name="category" required><option value="" disabled' + (!selectedCategory ? ' selected' : '') + '>Selecione a categoria</option>' +
    allowedCategories.map(label => '<option value="' + esc(label) + '"' + (selectedCategory===label ? ' selected' : '') + '>' + esc(label) + '</option>').join('') +
    '</select></label><button type="button" class="btn outline" data-create-category aria-expanded="false" aria-controls="custom-category-field">' +
    icon('plus') + ' Criar categoria para esta loja</button><div id="custom-category-field" hidden><label>Nome da nova categoria' +
    '<input name="new_category" maxlength="40" minlength="2" placeholder="Ex.: Sanduíches" disabled></label>' +
    '<p class="muted">A categoria fica disponível neste cardápio e nos próximos cadastros da loja.</p></div>' +
    '<label>Descrição<textarea name="description" rows="3" maxlength="500">' + esc(product?.description) +
    '</textarea></label><label data-base-price>Preço (R$)<input name="price" type="number" min="0.01" max="10000" step="0.01" required value="' +
    (product ? product.price / 100 : '') + '"></label>' +
    '<fieldset class="size-editor"><legend>Estoque</legend><label class="check"><input type="checkbox" name="tracks_stock"' +
    (product?.stock_quantity != null ? ' checked' : '') + '> Este item tem estoque definido</label>' +
    '<label data-stock-quantity>Quantidade física em estoque<input name="stock_quantity" type="number" min="0" max="1000000" step="1" required value="' +
    (product?.stock_quantity ?? '') + '"></label></fieldset>' +
    '<fieldset class="size-editor"><legend>Tamanhos do produto</legend><label class="check"><input type="checkbox" name="has_sizes"' + (product?.sizes?.length ? ' checked' : '') + '> O item possui tamanhos diferentes</label><div data-sizes-editor><p class="muted">Marque os tamanhos disponíveis e informe o preço de cada um.</p><div class="size-editor-grid">' +
    ['P','M','G'].map(name=>{ const size=product?.sizes?.find(size=>size.name===name); return '<div><label class="check"><input type="checkbox" data-size-enabled="' + name + '"' + (!product?.sizes?.length || size ? ' checked' : '') + '> ' + name + '</label><label>Preço ' + name + ' (R$)<input data-size-price="' + name + '" type="number" min="0.01" max="10000" step="0.01" required value="' + (size ? size.price/100 : '') + '"></label></div>'; }).join('') +
    '</div></div></fieldset><fieldset class="meal-editor" data-meal-editor></fieldset>' +
    '<fieldset class="optional-editor"><legend>Adicionais do produto</legend><label class="check"><input type="checkbox" name="has_options"' +
    ((product?.options ?? []).length ? ' checked' : '') + '> Este produto tem adicionais</label><div data-options-editor><p class="muted">O cliente pode escolher um ou mais adicionais. O valor é somado por unidade do produto.</p><div data-option-rows></div><button type="button" class="btn outline" data-add-option>Adicionar adicional</button></div></fieldset>' +
    '<label class="check"><input name="active" type="checkbox"' +
    (product?.active !== false ? ' checked' : '') + '> Disponível no cardápio</label>' +
    '<label>Foto do produto<input name="photo" type="file" accept="image/jpeg,image/png,image/webp"></label>' +
    (photo ? '<button class="text-button" type="button" data-remove-photo>Remover foto atual</button>' : '') +
    '<p class="muted">JPG, PNG ou WebP, até 20 MB. A foto é salva com até 50 KB.</p>' + formEnd('Salvar produto') + '</form>' +
    (product ? '<div class="order-actions"><button class="btn outline danger-text" type="button" data-delete-product>Excluir produto</button></div>' : ''));
  const sizesEnabled = $('[name=has_sizes]',el);
  const stockEnabled = $('[name=tracks_stock]',el);
  const stockField = $('[name=stock_quantity]',el);
  function toggleStock() {
    stockField.disabled = !stockEnabled.checked;
    $('[data-stock-quantity]',el).hidden = stockField.disabled;
  }
  stockEnabled.onchange = toggleStock;
  toggleStock();
  const sizesEditor = $('[data-sizes-editor]',el);
  const basePrice = $('[name=price]',el);
  function toggleSizes() {
    sizesEditor.hidden = !sizesEnabled.checked;
    $('[data-base-price]',el).hidden = sizesEnabled.checked;
    basePrice.disabled = sizesEnabled.checked;
    for (const input of sizesEditor.querySelectorAll('[data-size-enabled]')) {
      input.disabled = !sizesEnabled.checked;
      $('[data-size-price="' + input.dataset.sizeEnabled + '"]',el).disabled = !sizesEnabled.checked || !input.checked;
    }
    mealEditor?.sync();
  }
  sizesEnabled.onchange = toggleSizes;
  sizesEditor.onchange = toggleSizes;
  toggleSizes();
  const editor = $('[data-options-editor]',el);
  const rows = $('[data-option-rows]',el);
  const enabled = $('[name=has_options]',el);
  function optionRow(option = {}) {
    const row = document.createElement('div');
    row.className = 'optional-editor-row';
    row.dataset.optionId = option.id || crypto.randomUUID();
    row.innerHTML = '<label>Nome do adicional<input data-option-name required maxlength="80" value="' + esc(option.name) + '" placeholder="Ex. Ovo"></label>' +
      '<label>Valor (R$)<input data-option-price type="number" min="0" max="10000" step="0.01" required value="' + (option.price != null ? option.price/100 : '') + '" placeholder="0,00"></label>' +
      '<button type="button" class="icon-button" data-remove-option aria-label="Remover adicional">' + icon('close') + '</button>';
    rows.append(row);
  }
  function toggleOptions() {
    editor.hidden = !enabled.checked;
    for (const input of rows.querySelectorAll('input')) input.disabled = !enabled.checked;
  }
  for (const option of product?.options ?? []) optionRow(option);
  enabled.onchange = () => { if (enabled.checked && !rows.children.length) optionRow(); toggleOptions(); };
  $('[data-add-option]',el).onclick = () => { optionRow(); rows.lastElementChild.querySelector('input').focus(); };
  rows.onclick = event => event.target.closest('[data-remove-option]')?.closest('.optional-editor-row').remove();
  toggleOptions();
  const categorySelect = $('[name=category]',el);
  const categoryButton = $('[data-create-category]',el);
  const categoryField = $('#custom-category-field',el);
  const categoryName = $('[name=new_category]',el);
  const newCategory = () => categoryName.value.trim().replace(/\s+/g,' ');
  function productCategory() {
    if (categoryField.hidden) return categorySelect.value;
    const name = newCategory();
    return allowedCategories.find(label=>label.toLocaleLowerCase('pt-BR')===name.toLocaleLowerCase('pt-BR')) ?? name;
  }
  mealEditor=createMealEditor(el,product,()=>sizesEnabled.checked?[...sizesEditor.querySelectorAll('[data-size-enabled]:checked')].map(input=>input.dataset.sizeEnabled):['']);
  categoryButton.onclick = () => {
    const creating = categoryField.hidden;
    categoryField.hidden = !creating;
    categorySelect.disabled = creating;
    categoryName.required = creating;
    categoryName.disabled = !creating;
    categoryButton.setAttribute('aria-expanded',String(creating));
    categoryButton.innerHTML = creating ? 'Usar categoria existente' : icon('plus') + ' Criar categoria para esta loja';
    (creating ? categoryName : categorySelect).focus();
  };
  const remove = $('[data-remove-photo]',el);
  if (remove) remove.onclick = () => { photo = null; remove.textContent = 'Foto marcada para remoção'; remove.disabled = true; };
  if (product) $('[data-delete-product]',el).onclick = () => {
    const confirmation = modal('Excluir produto',
      '<form class="form-stack" id="delete-product-form"><p>Deseja excluir <strong>' + esc(product.name) + '</strong> do cardápio?</p>' +
      formEnd('Confirmar exclusão') + '</form>');
    bindSubmit($('#delete-product-form',confirmation),async () => {
      await command('delete_product',{store_id:store.id,id:product.id});
      confirmation.close();
      toast('Produto excluído.');
      await done();
    });
  };
  bindSubmit($('#product-form',el), async data => {
    const creatingCategory = !categoryField.hidden;
    const category = productCategory();
    if (creatingCategory) {
      if (category.length<2 || category.length>40 || ['todas','uncategorized'].includes(category.toLowerCase())) {
        throw new Error('Use de 2 a 40 caracteres e escolha um nome diferente de Todas.');
      }
    } else if (!allowedCategories.includes(category)) throw new Error('Selecione uma das categorias do estabelecimento.');
    const sizes = sizesEnabled.checked ? [...sizesEditor.querySelectorAll('[data-size-enabled]:checked')].map(input=>{
      const value=$('[data-size-price="' + input.dataset.sizeEnabled + '"]',el).value;
      return {name:input.dataset.sizeEnabled,price:value.trim() ? Math.round(Number(value)*100) : NaN};
    }) : [];
    if (sizesEnabled.checked && (!sizes.length || sizes.some(size=>!Number.isInteger(size.price) || size.price<1 || size.price>1000000))) throw new Error('Selecione pelo menos um tamanho e preencha os preços.');
    const options = enabled.checked ? [...rows.children].map(row=>({id:row.dataset.optionId,name:$('[data-option-name]',row).value.trim(),price:($('[data-option-price]',row).value.trim() ? Math.round(Number($('[data-option-price]',row).value)*100) : NaN)})) : [];
    if (enabled.checked && (!options.length || options.some(option=>!option.name || !Number.isInteger(option.price) || option.price<0 || option.price>1000000))) throw new Error('Preencha o nome e o valor de cada adicional.');
    const meal_choices=mealEditor.read();
    const previousStock = product?.stock_quantity ?? null;
    const stock = data.has('tracks_stock') && stockField.value !== '' ? Number(stockField.value) : null;
    if (data.has('tracks_stock') && (stock == null || !Number.isInteger(stock) || stock < 0 || stock > 1000000)) {
      throw new Error('Informe uma quantidade inteira de estoque entre 0 e 1.000.000.');
    }
    const stockChange = stock !== previousStock ? {stock_quantity:stock,stock_expected:previousStock} : {};
    const file = data.get('photo');
    if (file?.size && file !== selectedFile) {
      if (file.size > 20 * 1024 * 1024) throw new Error('A foto deve ter até 20 MB.');
      photo = (await api('upload?store=' + encodeURIComponent(store.id),file)).url;
      selectedFile = file;
    }
    const active = data.has('active');
    await command('save_product', { id:product?.id, store_id:store.id, name:data.get('name'),
      ...(creatingCategory ? {new_category:category} : {category}), description:data.get('description'),
      price:sizes.length ? Math.min(...sizes.map(size=>size.price)) : Math.round(Number(data.get('price'))*100),
      ...(!product || active !== product.active ? {active} : {}),
      ...(file?.size ? {image:photo} : remove?.disabled ? {image:null} : {}), options, sizes, meal_choices,...stockChange });
    el.close();
    toast('Produto salvo.');
    await done();
  });
}

const productOrders = [
  ['name','Nome (A–Z)'],
  ['price_asc','Menor para maior preço'],
  ['price_desc','Maior para menor preço']
];

export function organizeMenuProducts(store,done) {
  const el = modal('Ordem dos produtos',
    '<form class="form-stack" id="product-order-form"><p class="muted">A ordem vale dentro de cada categoria do cardápio. Para produtos com tamanhos, vale o menor preço cadastrado.</p>' +
    '<fieldset class="size-editor"><legend>Como exibir os produtos</legend>' + productOrders.map(([value,label]) =>
      '<label class="check"><input type="radio" name="order" value="' + value + '"' +
      (value === (store.menu_product_order ?? 'name') ? ' checked' : '') + ' required> ' + label + '</label>'
    ).join('') + '</fieldset>' + formEnd('Salvar ordem') + '</form>',store.name);
  bindSubmit($('#product-order-form',el),async data => {
    await command('save_menu_product_order',{store_id:store.id,order:data.get('order')});
    el.close();
    toast('Ordem dos produtos salva.');
    await done();
  });
}

const productCategoryLabel = value => value === '' ? 'Todas as categorias' : value === 'uncategorized' ? 'Sem categoria' : value;

export function merchantProductRows(store,{query='',category=''} = {}) {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  const products = store.products.filter(product => {
    if (category && (product.category || 'uncategorized') !== category) return false;
    const keywords = normalize([product.name,product.description,product.category].join(' '));
    return terms.every(term => keywords.includes(term));
  });
  if (!products.length) return '<p class="muted">' + (store.products.length ?
    'Nenhum produto encontrado com esses filtros.' : 'Nenhum produto cadastrado.') + '</p>';
  return products.map(product => {
    const name = esc(product.name);
    const status = product.active ? 'Disponível' : 'Indisponível';
    const id = esc(product.id);
    const storeId = esc(store.id);
    return '<div class="menu-admin-row" data-managed-product="' + id + '">' +
      (product.image ? '<img class="menu-admin-photo" src="' + esc(product.image) + '" alt="" loading="lazy">' :
        '<span class="product-placeholder">' + icon('bag') + '</span>') +
      '<div class="menu-admin-info"><strong>' + name + '</strong><p>' + (product.sizes?.length ?
        product.sizes.map(size=>esc(size.name) + ': ' + money(size.price)).join(' · ') : money(product.price)) +
      ' · ' + esc(product.category || 'Categoria pendente') + '</p></div>' +
      '<div class="menu-admin-actions"><button type="button" class="icon-button" data-edit-product="' + id + '" data-store="' + storeId +
      '" aria-label="Editar ' + name + '" title="Editar produto">' + icon('pencil') + '</button>' +
      '<button type="button" class="btn menu-availability" data-toggle-product="' + id + '" data-store="' + storeId +
      '" aria-pressed="' + Boolean(product.active) + '" aria-label="' + status + ' · ' + name + '">' + status + '</button></div></div>';
  }).join('');
}

export function selectMerchantProductCategory(details,category) {
  $('[data-category-label]',details).textContent = productCategoryLabel(category);
  for (const option of details.querySelectorAll('[data-product-category]')) {
    option.setAttribute('aria-pressed',String(option.dataset.productCategory === category));
  }
  details.open = false;
  $('summary',details).focus();
}

function productListControls(store,{query='',category=''} = {}) {
  const labels = sortMenuCategories([...availableMenuCategories(store),...store.products.map(product=>product.category)],store.menu_category_order);
  if (store.products.some(product=>!product.category)) labels.push('uncategorized');
  return '<div class="merchant-product-tools"><div class="merchant-product-toolbar">' +
    '<button type="button" class="btn primary" data-add-product="' + esc(store.id) + '">' + icon('plus') + ' Adicionar produto</button>' +
    '<details class="showcase-filters merchant-category-filter"><summary class="btn outline">' + icon('filter') +
    '<span data-category-label>' + esc(productCategoryLabel(category)) + '</span>' + icon('chevron') + '</summary>' +
    '<div class="showcase-filter-options" role="group" aria-label="Filtrar por categoria">' + ['',...labels].map(label =>
      '<button type="button" data-product-category="' + esc(label) + '" aria-pressed="' + (label===category) + '">' +
      esc(productCategoryLabel(label)) + '</button>').join('') + '</div></details></div>' +
    '<label class="search-field">' + icon('search') + '<input type="search" data-product-search maxlength="100" value="' + esc(query) +
    '" aria-label="Buscar produtos" placeholder="Buscar produto"></label></div>';
}

export function storeMarkup(store, role, filters) {
  const labels = esc(sortCategories(store.categories ?? [store.category]).join(' · '));
  if (role === 'admin') {
    return '<article class="panel management-card"><span class="overline">' + labels + '</span><h3>' + esc(store.name) +
      '</h3>' + (store.suspension?.suspended || store.suspension?.trusted ? '<p class="' + (store.suspension.suspended ? 'management-suspended' : 'management-trusted') + '">' + esc(store.suspension.reason) + '</p>' : '') + '<p>' + (store.owner_login ? 'Login: ' + esc(store.owner_login) : 'Acesso a configurar') + '</p>' +
      '<div class="order-actions"><button class="btn outline" data-admin-edit="' + esc(store.id) + '">Editar</button>' +
      '<button class="btn outline danger-text" data-admin-delete="' + esc(store.id) + '">Excluir</button>' +
      '<button class="btn outline" ' + (store.suspension?.suspended ? 'data-admin-resume' : 'data-admin-suspend') + '="' + esc(store.id) + '">' + (store.suspension?.suspended ? store.suspension.overdue_count ? 'Liberar por confiança' : 'Reativar' : 'Suspender') + '</button>' +
      (!store.owner_login ? '<button class="btn outline" data-link-store="' + esc(store.id) + '">Criar login</button>' : '') + '</div></article>';
  }
  return '<article class="panel management-card" data-product-shop="' + esc(store.id) + '"><div class="management-head"><div><span class="overline">' + labels +
    '</span><h3>' + esc(store.name) + '</h3></div><span class="status ' +
    (store.accepting_now ? 'status-delivered' : 'status-cancelled') + '">' +
    (store.active ? store.accepting_now ? 'Aberta agora' : 'Fechada agora' : 'Não publicada') + '</span></div>' +
    productListControls(store,filters) +
    '<div class="menu-admin" data-product-list aria-live="polite">' + merchantProductRows(store,filters) + '</div></article>';
}

export function operations(page, context) {
  const dashboard=createCommissionDashboard(context);
  let timer,searchTimer,drawer;
  let sequence = 0,clientPage = 0;
  let storeList = [],refreshing = false,search = '';
  const links=[['estabelecimentos','Estabelecimentos','store'],['clientes','Clientes','person'],['dashboard','Dashboard','grid'],['promocoes','Dias promocionais','calendar'],['cupons','Criar cupom de desconto','tag'],['limpeza','Limpeza de histórico','trash']];
  const currentLink=()=>links.find(([key])=>key===location.hash.slice(1))??links[0];
  const section=()=>currentLink()[0];
  function closeMenu(){if(drawer?.open)drawer.close();}
  function openMenu(){
    if(!drawer){drawer=document.createElement('dialog');drawer.id='admin-navigation';drawer.className='merchant-drawer';drawer.setAttribute('aria-labelledby','admin-menu-title');document.body.append(drawer);
      drawer.onclick=event=>{if(event.target===drawer||event.target.closest('[data-close-menu],a'))closeMenu();};
      drawer.addEventListener('close',()=> $('[data-admin-menu]')?.setAttribute('aria-expanded','false'));
    }
    drawer.innerHTML='<div class="dialog-head"><div><span class="overline accent">FLY DELIVERY</span><h2 id="admin-menu-title">Administração</h2></div><button class="icon-button" data-close-menu aria-label="Fechar menu">'+icon('close')+'</button></div><nav aria-label="Áreas da administração">'+links.map(([key,label,symbol])=>'<a href="#'+key+'"'+(key===section()?' aria-current="page"':'')+'>'+icon(symbol)+label+'</a>').join('')+'</nav>';
    drawer.showModal();$('[data-admin-menu]')?.setAttribute('aria-expanded','true');
  }
  async function refresh(force=false){
    if((refreshing&&!force)||context.user?.role!=='admin')return;
    const user=context.user,currentSection=section(),revision=++sequence;refreshing=true;
    try{
      if(currentSection==='clientes'){
        const data=await command('admin_customers',{page:clientPage,search});
        if(revision!==sequence||context.user!==user||section()!==currentSection)return;
        $('#ops-stores').innerHTML='<p class="muted">'+data.count+' cliente(s) cadastrado(s)</p>'+(data.customers.length?'<div class="panel merchant-table-scroll"><table class="merchant-table"><thead><tr><th>Cliente</th><th>Celular</th><th>Conta</th></tr></thead><tbody>'+data.customers.map(client=>'<tr><td>'+esc(client.name)+'</td><td>'+esc(client.phone)+'</td><td>'+(client.enabled?'Ativa':'Inativa')+'</td></tr>').join('')+'</tbody></table></div>':'<div class="panel">'+empty('Nenhum cliente encontrado','Os clientes aparecem aqui após concluir o cadastro.','person')+'</div>')+(data.pages>1?'<nav class="merchant-pagination"><button class="btn outline" data-client-page="'+(data.page-1)+'"'+(!data.page?' disabled':'')+'>Anterior</button><span>Página '+(data.page+1)+' de '+data.pages+'</span><button class="btn outline" data-client-page="'+(data.page+1)+'"'+(data.page+1>=data.pages?' disabled':'')+'>Próxima</button></nav>':'');
      }else{
        const [stores,config]=await Promise.all([command('managed_stores'),command('billing_settings')]);
        if(revision!==sequence||context.user!==user||section()!==currentSection)return;
        storeList=stores;
        const markup='<div class="section-head"><h2>Estabelecimentos</h2><button class="btn primary" data-add-store>'+icon('plus')+' Novo estabelecimento</button></div>'+(stores.length?'<div class="management-grid">'+stores.map(store=>storeMarkup(store,'admin')).join('')+'</div>':'<div class="panel">'+empty('Nenhuma loja cadastrada','Cadastre o primeiro estabelecimento.','store')+'</div>');
        if($('#ops-stores').innerHTML!==markup)$('#ops-stores').innerHTML=markup;
        $('#commission-current').textContent='Taxa global atual: '+percentage(config.commission_bps);
        $('#commission-ready').textContent=config.payments_ready?'InfinitePay habilitada. Faturas vencem ao meio-dia seguinte.':'InfinitePay aguardando configuração no Railway. A cobrança só começa quando o pagamento estiver habilitado.';
        const field=$('#commission-form [name=percentage]');
        if(!field.dataset.loaded){field.value=config.commission_bps==null?'':config.commission_bps/100;field.dataset.loaded='true';}
      }
      $('#ops-error').textContent='';
    }catch(error){if(revision===sequence&&$('#ops-error'))$('#ops-error').textContent=error.message;}
    finally{if(revision===sequence)refreshing=false;}
  }
  function render(){
    dashboard.stop();
    clearInterval(timer);clearTimeout(searchTimer);sequence++;refreshing=false;
    const user=context.user;
    main.innerHTML='<div class="wrap page ops"><div class="ops-heading"><div class="ops-mark">'+icon('shield')+'</div><div><span class="overline accent">GESTÃO FLY DELIVERY</span><h1>'+currentLink()[1]+'</h1></div></div><div id="ops-body"></div></div>';
    const body=$('#ops-body');
    if(user?.role!=='admin'){closeMenu();body.innerHTML='<div class="panel">'+empty(user?'Acesso restrito':'Entre para continuar',user?'Seu perfil não tem acesso a esta área.':'Use o login e a senha da administração.','shield')+(user?'<button class="btn outline" data-switch-account>Trocar de conta</button>':'<button class="btn primary" data-signin>Entrar</button>')+'</div>';return;}
    if(section()==='dashboard'){dashboard.mount(body);return;}
    if(section()==='promocoes'){mountPromotionDays(body);return;}
    if(section()==='cupons'){mountPlatformCoupons(body);return;}
    if(section()==='limpeza'){mountHistoryCleanup(body);return;}
    body.innerHTML=(section()==='clientes'?'<label class="search-field admin-client-search">'+icon('search')+'<input id="client-search" type="search" maxlength="100" placeholder="Buscar cliente ou celular" value="'+esc(search)+'"></label>':'<section class="panel commission-settings"><h2>Comissão da plataforma</h2><p id="commission-current" class="muted">Carregando taxa…</p><form id="commission-form" class="form-stack"><label>Porcentagem sobre as vendas (%)<input type="number" name="percentage" min="0" max="100" step="0.01" required placeholder="Ex.: 10"></label><p class="muted">A confirmação aplica a taxa aos próximos pedidos entregues de todos os estabelecimentos. Comissões já registradas permanecem iguais. A entrega não entra na base de cálculo.</p>'+formEnd('Confirmar taxa global')+'</form><p id="commission-ready" class="muted"></p></section>')+'<p class="form-error" id="ops-error" role="alert"></p><section id="ops-stores"><p class="muted">Carregando…</p></section>';
    if($('#client-search'))$('#client-search').oninput=event=>{search=event.target.value;clientPage=0;clearTimeout(searchTimer);searchTimer=setTimeout(()=>refresh(true),250);};
    if($('#commission-form'))bindSubmit($('#commission-form'),async fields=>{
      const value=Number(fields.get('percentage'));
      if(!Number.isFinite(value)||value<0||value>100)throw new Error('Informe uma porcentagem entre 0 e 100.');
      await command('admin_set_commission',{commission_bps:Math.round(value*100)});
      toast('Taxa global atualizada para todos os estabelecimentos.');await refresh(true);
    });
    body.onclick=async event=>{
      const button=event.target.closest('button');if(!button||button.disabled)return;
      if(button.dataset.adminEdit)editStoreForm(storeList.find(store=>store.id===button.dataset.adminEdit),()=>refresh(true));
      if(button.dataset.adminDelete)deleteStoreForm(storeList.find(store=>store.id===button.dataset.adminDelete),()=>refresh(true));
      if(button.dataset.adminSuspend)suspensionForm(storeList.find(store=>store.id===button.dataset.adminSuspend),()=>refresh(true));
      if(button.dataset.adminResume){const store=storeList.find(store=>store.id===button.dataset.adminResume);if(store.suspension?.overdue_count){trustReleaseForm(store,()=>refresh(true));return;}button.disabled=true;try{await command('admin_set_suspension',{id:button.dataset.adminResume,suspend:false});await refresh(true);toast('Estabelecimento reativado.');}catch(error){toast(error.message);}finally{button.disabled=false;}}
      if(button.dataset.clientPage!==undefined){clientPage=Number(button.dataset.clientPage);await refresh(true);}
      if(button.hasAttribute('data-add-store')||button.dataset.linkStore)registrationForm('store',()=>refresh(true),storeList.find(store=>store.id===button.dataset.linkStore));
    };
    refresh(true);timer=setInterval(()=>{if(!document.hidden)refresh();},6000);
  }
  return {render,openMenu,closeMenu};
}
