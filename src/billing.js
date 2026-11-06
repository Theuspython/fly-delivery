// InfinitePay protocol matches Flycar Novo; invoice identifiers are Delivery-only.
const API='https://api.checkout.infinitepay.io';
const PREFIX='flydelivery-daily-';
const failure=(message,status=502)=>Object.assign(new Error(message),{status});
export const validInvoiceId=id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export function checkoutUrlFrom(data){
  try{
    const url=new URL(data?.url||data?.checkout_url||data?.checkoutUrl||data?.link||data?.data?.url);
    if(url.protocol==='https:'&&(url.hostname==='infinitepay.io'||url.hostname.endsWith('.infinitepay.io')))return url.href;
  }catch{}
  throw failure('A InfinitePay não retornou um link de pagamento válido.');
}
export function paymentFields(body){
  const nsu=String(body?.order_nsu||body?.orderNsu||'');
  const transaction=String(body?.transaction_nsu||body?.transactionNsu||'');
  const slug=String(body?.invoice_slug||body?.slug||'');
  const id=nsu.startsWith(PREFIX)?nsu.slice(PREFIX.length):'';
  if(!validInvoiceId(id)||!transaction||transaction.length>150||!slug||slug.length>150)throw failure('Dados de pagamento incompletos.',400);
  return {id,nsu,transaction,slug};
}
export function createBilling({rpc,fetchImpl=fetch,env=process.env}){
  const ready=()=>Boolean(env.INFINITEPAY_API_KEY&&env.INFINITEPAY_API_KEY!=='PREENCHER'&&env.INFINITEPAY_HANDLE&&env.INFINITEPAY_HANDLE!=='PREENCHER'&&/^https:\/\/[^/]+$/.test(env.APP_ORIGIN||'')&&env.FD_BILLING_BRIDGE_TOKEN);
  const backend=(action,input={})=>rpc(action,input);
  async function provider(path,body){
    if(!ready())throw failure('O pagamento aguarda a configuração InfinitePay pela plataforma.',503);
    let response,data;
    try{response=await fetchImpl(API+path,{method:'POST',headers:{'Content-Type':'application/json','X-Api-Key':env.INFINITEPAY_API_KEY},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});data=await response.json();}
    catch{throw failure('Não foi possível consultar a InfinitePay. Tente novamente.');}
    if(!response.ok||!data||typeof data!=='object')throw failure('A InfinitePay não aceitou a solicitação. Tente novamente.');
    return data;
  }
  async function tick(){if(env.FD_BILLING_BRIDGE_TOKEN)await backend('tick',{payments_ready:ready()});}
  async function checkout(actor,id){
    if(!validInvoiceId(id))throw failure('Fatura inválida.',400);
    if(!ready())throw failure('O pagamento aguarda a configuração InfinitePay pela plataforma.',503);
    const row=await backend('acquire',{id,actor});
    if(row.checkout_url)return {checkoutUrl:checkoutUrlFrom({url:row.checkout_url})};
    try{
      const origin=env.APP_ORIGIN;
      const data=await provider('/links',{
        order_nsu:PREFIX+id,redirect_url:origin+'/loja/?invoice_return=1',
        webhook:{url:origin+'/api/infinitepay/webhook',events:['paid','settled','refunded','canceled']},
        items:[{quantity:1,price:Number(row.amount_cents),description:'Comissão Fly Delivery - '+row.invoice_date}],
        options:{single_payment:true,payment_methods_enabled:['pix']}
      });
      const checkoutUrl=checkoutUrlFrom(data);
      await backend('save_link',{id,lock_id:row.checkout_lock_id,url:checkoutUrl});
      return {checkoutUrl};
    }catch(error){await backend('release',{id,lock_id:row.checkout_lock_id}).catch(()=>{});throw error;}
  }
  async function confirm(body,actor){
    const fields=paymentFields(body);
    const invoice=await backend('get',{id:fields.id,...(actor?{actor}:{})});
    if(invoice.status==='paid')return {paid:true};
    if(invoice.status!=='pending'||!invoice.checkout_url)throw failure('Fatura não aguardando pagamento.',409);
    const result=await provider('/payment_check',{handle:env.INFINITEPAY_HANDLE.replace(/^\$/,'').trim(),order_nsu:fields.nsu,transaction_nsu:fields.transaction,slug:fields.slug});
    if(result.paid!==true||result.success===false)return {paid:false};
    if(!Number.isSafeInteger(Number(result.amount))||Number(result.amount)!==Number(invoice.amount_cents))throw failure('O valor do pagamento diverge da fatura.',422);
    await backend('paid',{id:fields.id,amount:Number(result.amount),transaction:fields.transaction,slug:fields.slug});
    return {paid:true};
  }
  async function webhook(payload){
    const event=String(payload?.event||payload?.type||'').toLowerCase();
    if(event&&!['paid','settled'].includes(event))return {ignored:true};
    const body=payload?.data&&typeof payload.data==='object'?payload.data:payload;
    try{paymentFields(body);}catch{return {ignored:true};}
    try{return await confirm(body);}catch(error){if([404,409].includes(error.status))return {ignored:true};throw error;}
  }
  return {ready,tick,checkout,confirm,webhook};
}
