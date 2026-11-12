import { $,esc,icon } from './shared.js';

const descriptionLimit = 200;

export const mealGroups=(product,size='')=>(product.meal_choices??[]).filter(group=>Number(group.limits?.[size])>0);
export function resolveMealSelection(product,size='',selection=[]) {
  const fail=reason=>({valid:false,reason,selections:[],groups:[]});
  if(!Array.isArray(selection))return fail('Revise as escolhas de montagem no cardápio.');
  const groups=mealGroups(product,size),seen=new Set(),resolved=[],selections=[];
  for(const selected of selection){
    if(!selected||seen.has(selected.group_id)||!groups.some(group=>group.id===selected.group_id)||!Array.isArray(selected.option_ids))return fail('Revise as escolhas de montagem no cardápio.');
    seen.add(selected.group_id);
  }
  for(const group of groups){
    const ids=selection.find(selected=>selected.group_id===group.id)?.option_ids??[];
    const limit=Number(group.limits[size]);
    if(group.required&&!ids.length)return fail('Escolha uma opção em '+group.name+'.');
    if(ids.length>limit||new Set(ids).size!==ids.length)return fail('Escolha até '+limit+' opção/ões em '+group.name+'.');
    if(!ids.length)continue;
    const available=new Map(group.options.map(option=>[option.id,option]));
    const options=ids.map(id=>available.get(id));
    if(options.some(option=>!option))return fail('As escolhas de montagem mudaram. Volte ao cardápio.');
    selections.push({group_id:group.id,option_ids:[...ids].sort()});
    resolved.push({id:group.id,name:group.name,options});
  }
  selections.sort((a,b)=>a.group_id.localeCompare(b.group_id));
  return {valid:true,selections,groups:resolved};
}

export function mealChoicesMarkup(product,groups,size) {
  return groups.map(group=>{
    const limit=Number(group.limits[size]);
    const longList=group.options.length>9;
    const scrollable=longList||(group.options.length>1&&group.options.some(option=>option.description?.trim()));
    return '<fieldset class="meal-choices"><legend>'+esc(group.name)+'</legend><p class="muted">'+
      (group.required?'Obrigatório':'Opcional')+' · '+(limit===1?'Escolha 1':'Escolha até '+limit)+' · Sem acréscimo</p>'+
      (longList?'<p class="muted">Role a lista para ver as '+group.options.length+' opções.</p>':'')+
      '<div data-meal-group="'+esc(group.id)+'"'+(scrollable?' class="meal-options-scroll" tabindex="0" role="region" aria-label="Opções de '+esc(group.name)+'"':'')+'>'+
      group.options.map(option=>{
        const description=option.description?.trim();
        return '<label><input type="'+(limit===1?'radio':'checkbox')+'" name="meal-'+esc(product.id+'-'+group.id)+
          '" data-meal-option="'+esc(option.id)+'"><span class="meal-choice-text"><span>'+esc(option.name)+'</span>'+
          (description?'<em class="meal-choice-description">'+esc(description)+'</em>':'')+'</span></label>';
      }).join('')+'</div>'+
      (!group.required?'<button type="button" class="text-button" data-clear-meal="'+esc(group.id)+'" hidden>Limpar escolha</button>':'')+'</fieldset>';
  }).join('');
}

export function syncMealChoices(container,groups,size,selection,disabled) {
  const selections=new Map(selection.map(group=>[group.group_id,new Set(group.option_ids)]));
  for(const [index,group] of groups.entries()){
    const fieldset=container.children[index];
    const selected=selections.get(group.id);
    const limit=Number(group.limits[size]);
    const full=limit>1&&selected?.size>=limit;
    for(const input of fieldset.querySelectorAll('[data-meal-option]')){
      input.checked=selected?.has(input.dataset.mealOption)??false;
      input.disabled=disabled||(full&&!input.checked);
    }
    const clear=$('[data-clear-meal]',fieldset);
    if(clear){clear.hidden=!selected?.size;clear.disabled=disabled;}
  }
}

export function createMealEditor(el,product,getSizes) {
  const root=$('[data-meal-editor]',el);
  root.innerHTML='<legend>Acompanhamentos</legend><label class="check"><input type="checkbox" data-has-meal'+(product?.meal_choices?.length?' checked':'')+'> O cliente pode escolher os acompanhamentos</label><div data-meal-groups-editor><p class="muted">Crie grupos como molhos, saladas ou guarnições. Todas as escolhas são gratuitas. Para cada tamanho, marque se o grupo aparece e quantas opções podem ser escolhidas, até o total disponível no grupo.</p><div data-meal-groups></div><button type="button" class="btn outline" data-add-meal-group>Adicionar grupo de escolhas</button></div>';
  const enabled=$('[data-has-meal]',root),rows=$('[data-meal-groups]',root);
  function addOption(group,option={}){
    const row=document.createElement('div');row.className='meal-editor-option';row.dataset.mealOptionId=option.id||crypto.randomUUID();
    const descriptionId='meal-description-'+esc(group.dataset.mealGroupId+'-'+row.dataset.mealOptionId);
    const description=option.description?.trim()??'';
    row.innerHTML='<input data-meal-option-name aria-label="Nome da escolha gratuita" required maxlength="60" placeholder="Ex.: arroz branco" value="'+esc(option.name)+'">'+
      '<button type="button" class="icon-button" data-toggle-meal-description aria-label="Descrição da escolha" title="Descrição da escolha" aria-expanded="false" aria-controls="'+descriptionId+'"'+
      (description?' data-has-description':'')+'>'+icon('pencil')+'<span>Descrição</span></button>'+
      '<button type="button" class="icon-button" data-remove-meal-option aria-label="Remover escolha">'+icon('close')+'</button>'+
      '<label class="meal-editor-description" id="'+descriptionId+'" hidden><span>Descrição <small class="muted">(opcional)</small></span>'+
      '<textarea data-meal-description rows="2" maxlength="'+descriptionLimit+'" placeholder="Ex.: Carne de boi temperada com alho e ervas">'+esc(description)+'</textarea></label>';
    $('[data-meal-option-rows]',group).append(row);
  }
  function addGroup(group){
    const fresh=!group;
    group??={id:crypto.randomUUID(),name:'',required:true,limits:Object.fromEntries(getSizes().map(size=>[size,1])),options:[]};
    const row=document.createElement('section');row.className='meal-editor-group';row.dataset.mealGroupId=group.id;
    row.innerHTML='<div class="meal-editor-head"><label>Nome do grupo<input data-meal-group-name required minlength="2" maxlength="60" placeholder="Ex.: Tipo de carne" value="'+esc(group.name)+'"></label><button type="button" class="icon-button" data-remove-meal-group aria-label="Remover grupo">'+icon('close')+'</button></div><label class="check"><input type="checkbox" data-meal-required'+(group.required?' checked':'')+'> Escolha obrigatória</label><div class="meal-editor-limits">'+['','P','M','G'].map(size=>'<div data-meal-rule="'+size+'"><label class="check"><input type="checkbox" data-meal-rule-enabled'+(group.limits[size]?' checked':'')+'> '+(size?'Tamanho '+size:'Tamanho único')+'</label><label>Máximo de escolhas<input type="number" data-meal-rule-limit min="1" required value="'+(group.limits[size]||1)+'"></label></div>').join('')+'</div><p class="muted">Opções disponíveis neste grupo</p><div data-meal-option-rows></div><button type="button" class="text-button" data-add-meal-option>Adicionar escolha gratuita</button>';
    rows.append(row);
    for(const option of group.options)addOption(row,option);
    if(fresh)addOption(row);
  }
  function sync(){
    const active=enabled.checked,sizes=getSizes();
    $('[data-meal-groups-editor]',root).hidden=!active;
    for(const input of root.querySelectorAll('input,button,textarea'))input.disabled=!active;
    enabled.disabled=false;
    for(const row of rows.children){
      const optionCount=$('[data-meal-option-rows]',row).children.length;
      const maximum=Math.max(1,optionCount);
      for(const rule of row.querySelectorAll('[data-meal-rule]')){
        const available=sizes.includes(rule.dataset.mealRule);
        const enabledRule=$('[data-meal-rule-enabled]',rule),limit=$('[data-meal-rule-limit]',rule);
        rule.hidden=!available;
        enabledRule.disabled=!active||!available;
        if(Number(limit.max)>maximum&&limit.valueAsNumber>maximum)limit.value=String(maximum);
        limit.max=String(maximum);
        limit.disabled=!active||!available||!enabledRule.checked;
      }
    }
    $('[data-add-meal-group]',root).disabled=!active||rows.children.length>=8;
  }
  for(const group of product?.meal_choices??[])addGroup(group);
  enabled.onchange=()=>{if(enabled.checked&&!rows.children.length)addGroup();sync();};
  root.addEventListener('change',sync);
  root.addEventListener('input',event=>{
    const field=event.target.closest('[data-meal-description]');
    if(field)$('[data-toggle-meal-description]',field.closest('[data-meal-option-id]'))
      .toggleAttribute('data-has-description',Boolean(field.value.trim()));
  });
  root.onclick=event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    const group=button.closest('[data-meal-group-id]');
    if(button.hasAttribute('data-add-meal-group')){addGroup();sync();rows.lastElementChild.querySelector('input').focus();}
    if(button.hasAttribute('data-remove-meal-group')){group.remove();sync();}
    if(button.hasAttribute('data-add-meal-option')){addOption(group);sync();$('[data-meal-option-rows]',group).lastElementChild.querySelector('input').focus();}
    if(button.hasAttribute('data-remove-meal-option')){button.closest('[data-meal-option-id]').remove();sync();}
    if(button.hasAttribute('data-toggle-meal-description')){
      const field=$('[data-meal-description]',button.closest('[data-meal-option-id]'));
      const label=field.parentElement;
      label.hidden=!label.hidden;
      button.setAttribute('aria-expanded',String(!label.hidden));
      if(!label.hidden)field.focus();
    }
  };
  function read(){
    if(!enabled.checked)return [];
    if(!rows.children.length)throw new Error('Adicione pelo menos um grupo de montagem.');
    return [...rows.children].map(row=>{
      const name=$('[data-meal-group-name]',row).value.trim();
      const options=[...$('[data-meal-option-rows]',row).children].map(option=>{
        const description=$('[data-meal-description]',option).value.trim();
        if(description.length>descriptionLimit)throw new Error('Use até '+descriptionLimit+' caracteres na descrição do acompanhamento.');
        return {id:option.dataset.mealOptionId,name:$('[data-meal-option-name]',option).value.trim(),...(description?{description}:{})};
      });
      const limits=Object.fromEntries([...row.querySelectorAll('[data-meal-rule]')].filter(rule=>!rule.hidden&&$('[data-meal-rule-enabled]',rule).checked).map(rule=>[rule.dataset.mealRule,Number($('[data-meal-rule-limit]',rule).value)]));
      if(name.length<2||!options.length||options.some(option=>!option.name)||new Set(options.map(option=>option.name.toLowerCase())).size!==options.length||!Object.keys(limits).length||Object.values(limits).some(limit=>!Number.isInteger(limit)||limit<1||limit>options.length))throw new Error('Revise o grupo '+(name||'de montagem')+': informe as opções, os tamanhos e os limites de escolhas.');
      return {id:row.dataset.mealGroupId,name,required:$('[data-meal-required]',row).checked,limits,options};
    });
  }
  sync();return {sync,read};
}
