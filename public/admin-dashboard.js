import { $, esc, icon, money, command, empty } from './shared.js';

const periods=[['7d','Últimos 7 dias'],['15d','Últimos 15 dias'],['30d','Últimos 30 dias'],['3m','Últimos 3 meses'],['day','Data específica'],['range','Intervalo de datas']];
const date=value=>value.split('-').reverse().join('/');
const label=(value,bucket)=>bucket==='month'?value.slice(0,7).split('-').reverse().join('/'):date(value);
const numeric=value=>Number.isFinite(Number(value))?Number(value):0;
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());

export function commissionChart(series,bucket) {
  const width=720,left=82,right=24,top=22,bottom=220;
  const highest=Math.max(0,...series.map(point=>numeric(point.commission_cents)));
  const step=Math.max(100,Math.ceil(highest/400)*100);
  const maximum=step*4;
  const x=index=>series.length===1?(left+width-right)/2:left+index*(width-left-right)/Math.max(1,series.length-1);
  const y=value=>bottom-numeric(value)*(bottom-top)/maximum;
  const points=series.map((point,index)=>[x(index),y(point.commission_cents)]);
  const line=points.map(([x,y],index)=>(index?'L':'M')+x.toFixed(2)+','+y.toFixed(2)).join(' ');
  const ticks=[...new Set(Array.from({length:Math.min(5,series.length)},(_,i)=>Math.round(i*(series.length-1)/Math.max(1,Math.min(5,series.length)-1))))];
  const short=value=>new Intl.NumberFormat('pt-BR',{notation:'compact',maximumFractionDigits:1}).format(value/100);
  return '<svg class="commission-chart" viewBox="0 0 720 260" role="group" aria-label="Gráfico de comissões. Selecione um ponto para ver os valores. Os dados também estão na tabela de evolução.">' +
    '<defs><linearGradient id="commission-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f65324" stop-opacity=".25"/><stop offset="100%" stop-color="#f65324" stop-opacity=".01"/></linearGradient></defs>' +
    Array.from({length:5},(_,i)=>{const value=i*step;return '<g aria-hidden="true"><line x1="'+left+'" x2="'+(width-right)+'" y1="'+y(value)+'" y2="'+y(value)+'" class="dashboard-gridline"/><text x="'+(left-12)+'" y="'+(y(value)+4)+'" text-anchor="end">R$ '+short(value)+'</text></g>';}).join('') +
    (points.length?'<path d="'+line+' L'+points.at(-1)[0]+','+bottom+' L'+points[0][0]+','+bottom+' Z" fill="url(#commission-fill)"/><path d="'+line+'" fill="none" stroke="#c93913" stroke-width="3" stroke-linejoin="round"/>':'') +
    series.map((point,index)=>'<g class="dashboard-point" data-chart-point="'+index+'" role="button" tabindex="'+(index===0?'0':'-1')+'" aria-label="'+esc(label(point.date,bucket)+': '+money(point.commission_cents)+', '+point.orders+' pedidos')+'"><title>'+esc(label(point.date,bucket)+' · '+money(point.commission_cents))+'</title><circle cx="'+x(index)+'" cy="'+y(point.commission_cents)+'" r="12" fill="transparent"/><circle class="dashboard-dot" cx="'+x(index)+'" cy="'+y(point.commission_cents)+'" r="3.5"/></g>').join('') +
    ticks.map(index=>'<text aria-hidden="true" x="'+x(index)+'" y="247" text-anchor="middle">'+esc(bucket==='month'?label(series[index].date,bucket):series[index].date.slice(5).split('-').reverse().join('/'))+'</text>').join('')+'</svg>';
}

function resultsMarkup(data) {
  const summary=data.summary;
  const cards=[['Vendas com comissão',money(summary.sales_cents),'Base em produtos, sem taxa de entrega','bag'],['Pedidos com comissão',summary.orders,'Por data da comissão','check'],['Estabelecimentos',summary.stores,'Com vendas no período','store']];
  const maxStore=Math.max(1,...data.top_stores.map(store=>numeric(store.commission_cents)));
  const share=value=>summary.commission_cents?new Intl.NumberFormat('pt-BR',{maximumFractionDigits:1}).format(value*100/summary.commission_cents)+'%':'0%';
  return '<section class="dashboard-metrics" aria-label="Resumo das comissões"><article class="dashboard-total"><span class="dashboard-metric-icon">'+icon('grid')+'</span><p>Comissões Fly Delivery</p><strong>'+money(summary.commission_cents)+'</strong><small>'+date(data.date_from)+' a '+date(data.date_to)+'</small></article>'+cards.map(([name,value,copy,symbol])=>'<article class="panel dashboard-metric"><span class="dashboard-metric-icon">'+icon(symbol)+'</span><p>'+name+'</p><strong>'+esc(value)+'</strong><small>'+copy+'</small></article>').join('')+'</section>' +
    '<div class="dashboard-charts"><section class="panel dashboard-trend"><div class="section-head"><div><span class="overline accent">EVOLUÇÃO</span><h2>Suas comissões ao longo do tempo</h2></div><span class="dashboard-legend"><i></i> Comissão</span></div>'+commissionChart(data.series,data.bucket)+'<p class="dashboard-inspector" data-chart-detail aria-live="polite">Toque ou selecione um ponto para ver os valores.</p></section>' +
    '<section class="panel dashboard-ranking"><span class="overline accent">DESTAQUES DO PERÍODO</span><h2>Por estabelecimento</h2>'+(data.top_stores.length?'<ol>'+data.top_stores.map((store,index)=>'<li><div><span class="dashboard-rank">'+(index+1)+'</span><strong title="'+esc(store.store_name)+'">'+esc(store.store_name)+'</strong><b>'+money(store.commission_cents)+'</b></div><div class="dashboard-bar"><span style="width:'+Math.max(0,Math.min(100,numeric(store.commission_cents)*100/maxStore))+'%"></span></div><small>'+share(store.commission_cents)+' das comissões</small></li>').join('')+'</ol>':empty('Aguardando vendas','As comissões dos estabelecimentos aparecerão aqui.','store'))+'</section></div>' +
    '<section class="panel dashboard-report"><div class="section-head"><div><span class="overline accent">RELATÓRIO</span><h2>Comissões por estabelecimento</h2></div><span class="muted">'+summary.stores+' estabelecimento(s)</span></div>'+(data.stores.length?'<div class="merchant-table-scroll"><table class="merchant-table"><caption class="sr-only">Comissões por estabelecimento no período selecionado</caption><thead><tr><th scope="col">Estabelecimento</th><th scope="col">Pedidos</th><th scope="col">Vendas em produtos</th><th scope="col">Comissão Fly Delivery</th><th scope="col">Participação</th></tr></thead><tbody>'+data.stores.map(store=>'<tr><th scope="row">'+esc(store.store_name)+'</th><td>'+store.orders+'</td><td>'+money(store.sales_cents)+'</td><td><strong>'+money(store.commission_cents)+'</strong></td><td>'+share(store.commission_cents)+'</td></tr>').join('')+'</tbody></table></div>':'<p class="muted">Nenhuma venda com comissão neste período.</p>') +
    (data.pages>1?'<nav class="merchant-pagination" aria-label="Páginas dos estabelecimentos"><button class="btn outline" data-dashboard-page="'+(data.page-1)+'"'+(data.page===0?' disabled':'')+'>Anterior</button><span>Página '+(data.page+1)+' de '+data.pages+'</span><button class="btn outline" data-dashboard-page="'+(data.page+1)+'"'+(data.page+1>=data.pages?' disabled':'')+'>Próxima</button></nav>':'')+'</section>' +
    '<details class="panel dashboard-daily"><summary>Ver evolução '+(data.bucket==='month'?'mensal':'diária')+' em tabela</summary><div class="merchant-table-scroll"><table class="merchant-table"><thead><tr><th scope="col">'+(data.bucket==='month'?'Mês':'Dia')+'</th><th scope="col">Pedidos</th><th scope="col">Vendas em produtos</th><th scope="col">Comissão Fly Delivery</th></tr></thead><tbody>'+data.series.map(point=>'<tr><th scope="row">'+label(point.date,data.bucket)+'</th><td>'+point.orders+'</td><td>'+money(point.sales_cents)+'</td><td>'+money(point.commission_cents)+'</td></tr>').join('')+'</tbody></table></div></details>';
}

export function createCommissionDashboard(context) {
  let period='7d',from=today(),to=from,page=0;
  let root,timer,sequence=0,data,signature,loading=false;
  function controls() {
    for (const button of root.querySelectorAll('[data-dashboard-period]')) button.setAttribute('aria-pressed',String(button.dataset.dashboardPeriod===period));
    const custom=['day','range'].includes(period);
    $('#dashboard-date-form',root).hidden=!custom;
    $('[data-dashboard-end]',root).hidden=period!=='range';
    $('[name=date_to]',root).required=period==='range';
    $('[data-dashboard-start-label]',root).textContent=period==='day'?'Dia':'Data inicial';
  }
  async function refresh(force=false) {
    if (!root?.isConnected || context.user?.role!=='admin' || (loading&&!force)) return;
    const target=root,user=context.user,revision=++sequence;
    loading=true; target.setAttribute('aria-busy','true');
    const button=$('[data-dashboard-refresh]',target);button.disabled=true;
    try {
      const result=await command('admin_commission_dashboard',{period,date_from:from,date_to:to,page});
      if (revision!==sequence || !target.isConnected || context.user!==user || root!==target) return;
      data=result;
      const next=JSON.stringify(result);
      if (signature!==next) { $('#dashboard-results',target).innerHTML=resultsMarkup(result); signature=next; }
      $('#dashboard-period-label',target).textContent=date(result.date_from)+' a '+date(result.date_to)+' · Horário de Brasília';
      $('#dashboard-error',target).textContent='';
    } catch(error) {
      if (revision===sequence && target.isConnected && root===target) $('#dashboard-error',target).textContent=error.message;
    } finally {
      if (revision===sequence) { loading=false;target.setAttribute('aria-busy','false');button.disabled=false; }
    }
  }
  function pointDetail(point) {
    const index=Number(point?.dataset.chartPoint);
    if (!data || !Number.isInteger(index) || !data.series[index]) return;
    for (const element of root.querySelectorAll('[data-chart-point]')) {
      element.classList.toggle('selected',element===point);
      element.setAttribute('tabindex',element===point?'0':'-1');
    }
    const row=data.series[index];
    $('[data-chart-detail]',root).textContent=label(row.date,data.bucket)+' · '+money(row.commission_cents)+' em comissões · '+row.orders+' pedido(s)';
  }
  const onFocus=()=>refresh();
  function stop() { sequence++;clearInterval(timer);window.removeEventListener('focus',onFocus);root=null;loading=false; }
  function mount(container) {
    stop();
    root=container;signature=null;data=null;
    root.innerHTML='<section class="dashboard"><div class="dashboard-intro"><div><p>Veja o resultado das vendas em toda a plataforma.</p><p id="dashboard-period-label" class="muted">Últimos 7 dias · Horário de Brasília</p></div><button class="btn outline" data-dashboard-refresh>'+icon('clock')+' Atualizar</button></div>' +
      '<div class="dashboard-periods" role="group" aria-label="Período do dashboard">'+periods.map(([key,name])=>'<button class="chip" data-dashboard-period="'+key+'" aria-pressed="'+(period===key)+'">'+name+'</button>').join('')+'</div>' +
      '<form id="dashboard-date-form" class="form-stack dashboard-date-form" hidden><label><span data-dashboard-start-label>Data inicial</span><input type="date" name="date_from" value="'+esc(from)+'" required></label><label data-dashboard-end>Data final<input type="date" name="date_to" value="'+esc(to)+'"></label><button type="submit" class="btn primary">Aplicar período</button></form>' +
      '<p id="dashboard-error" class="form-error" role="alert"></p><div id="dashboard-results"><div class="panel"><p class="muted">Carregando suas comissões…</p></div></div>' +
      '<p class="muted dashboard-method">As comissões dos novos pedidos entram no relatório na data do aceite. A base inclui produtos, tamanhos e opcionais, sem a taxa de entrega. Os valores representam as comissões geradas no período.</p></section>';
    controls();
    root.onclick=event=>{
      const button=event.target.closest('button');
      if (button && !button.disabled) {
        if (button.dataset.dashboardPeriod) {
          period=button.dataset.dashboardPeriod;page=0;controls();
          if (!['day','range'].includes(period)) refresh(true);
        }
        if (button.dataset.dashboardPage!==undefined) {page=Number(button.dataset.dashboardPage);refresh(true);}
        if (button.hasAttribute('data-dashboard-refresh')) refresh(true);
      }
      const point=event.target.closest('[data-chart-point]');if(point)pointDetail(point);
    };
    root.addEventListener('focusin',event=>{const point=event.target.closest('[data-chart-point]');if(point)pointDetail(point);});
    root.addEventListener('pointerover',event=>{const point=event.target.closest('[data-chart-point]');if(point)pointDetail(point);});
    root.addEventListener('keydown',event=>{
      const point=event.target.closest('[data-chart-point]');if(!point)return;
      if(['Enter',' '].includes(event.key)){event.preventDefault();pointDetail(point);}
      if(['ArrowLeft','ArrowRight'].includes(event.key)){
        event.preventDefault();const index=Number(point.dataset.chartPoint)+(event.key==='ArrowLeft'?-1:1);
        root.querySelector('[data-chart-point="'+index+'"]')?.focus();
      }
    });
    $('#dashboard-date-form',root).onsubmit=event=>{
      event.preventDefault();
      const form=event.currentTarget;
      const start=$('[name=date_from]',form).value,end=period==='day'?start:$('[name=date_to]',form).value;
      if(!start||!end||end<start){$('#dashboard-error',root).textContent='Confira as datas do período.';return;}
      from=start;to=end;page=0;refresh(true);
    };
    refresh(true);timer=setInterval(()=>{if(!document.hidden)refresh();},30000);
    window.addEventListener('focus',onFocus);
  }
  return {mount,stop};
}
