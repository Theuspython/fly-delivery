import test from 'node:test';
import assert from 'node:assert/strict';
import {createBilling,checkoutUrlFrom,paymentFields} from '../src/billing.js';
const id='10000000-0000-4000-8000-000000000001';
const env={INFINITEPAY_API_KEY:'fixture-secret-key',INFINITEPAY_HANDLE:'$same-account',APP_ORIGIN:'https://delivery.example',FD_BILLING_BRIDGE_TOKEN:'fixture-bridge'};
function fixture(result={success:true,paid:true,amount:1500,paid_amount:1700}){
 const calls=[],provider=[];let paid=false;
 const billing=createBilling({env,rpc:async(action,input)=>{
  calls.push({action,input});
  if(action==='acquire')return {id,amount_cents:1500,invoice_date:'2026-11-06',checkout_lock_id:'lock'};
  if(action==='get')return {id,status:paid?'paid':'pending',amount_cents:1500,checkout_url:'https://checkout.infinitepay.io/sale'};
  if(action==='paid')paid=true;
  return {};
 },fetchImpl:async(url,init)=>{provider.push({url,headers:init.headers,body:JSON.parse(init.body)});return Response.json(url.endsWith('/links')?{url:'https://checkout.infinitepay.io/sale'}:result);}});
 return {billing,calls,provider};
}
test('Delivery checkout uses separate invoice identity, same InfinitePay protocol and BRL cents',async()=>{
 const {billing,calls,provider}=fixture();
 assert.deepEqual(await billing.checkout('owner',id),{checkoutUrl:'https://checkout.infinitepay.io/sale'});
 assert.equal(provider[0].body.order_nsu,'flydelivery-daily-'+id);
 assert.equal(provider[0].body.items[0].price,1500);
 assert.equal(provider[0].headers['X-Api-Key'],env.INFINITEPAY_API_KEY);
 assert.equal(provider[0].body.webhook.url,'https://delivery.example/api/infinitepay/webhook');
 assert.equal(provider[0].body.redirect_url,'https://delivery.example/loja/?invoice_return=1');
 assert.deepEqual(provider[0].body.options,{single_payment:true,payment_methods_enabled:['pix']});
 assert.deepEqual(calls[0],{action:'acquire',input:{id,actor:'owner'}});
 assert.equal(calls[1].action,'save_link');
});
test('Payment is confirmed with provider amount, not the larger paid_amount; repeats are idempotent',async()=>{
 const {billing,calls,provider}=fixture();const body={order_nsu:'flydelivery-daily-'+id,transaction_nsu:'transaction',slug:'sale'};
 assert.deepEqual(await billing.confirm(body,'owner'),{paid:true});
 assert.equal(provider[0].body.handle,'same-account');
 assert.equal(calls.find(c=>c.action==='paid').input.amount,1500);
 assert.deepEqual(await billing.confirm(body,'owner'),{paid:true});assert.equal(provider.length,1);
});
test('Unpaid responses, wrong amounts and unrelated Flycar webhooks cannot settle an invoice',async()=>{
 for(const response of [{paid:false,amount:1500},{paid:true,amount:1499}]){
  const {billing,calls}=fixture(response);const body={order_nsu:'flydelivery-daily-'+id,transaction_nsu:'transaction',invoice_slug:'sale'};
  if(response.paid)await assert.rejects(billing.confirm(body),error=>error.status===422);
  else assert.deepEqual(await billing.confirm(body),{paid:false});
  assert.equal(calls.some(c=>c.action==='paid'),false);
 }
 const {billing,calls}=fixture();assert.deepEqual(await billing.webhook({order_nsu:'flycar-daily-'+id,transaction_nsu:'x',slug:'s'}),{ignored:true});assert.equal(calls.length,0);
 assert.deepEqual(await billing.webhook({event:'refunded',data:{}}),{ignored:true});
});
test('Malformed redirects and configuration errors release locks and cannot expose secrets',async()=>{
 for(const url of ['javascript:alert(1)','http://checkout.infinitepay.io/s','https://infinitepay.io.attacker.example/s'])assert.throws(()=>checkoutUrlFrom({url}));
 assert.throws(()=>paymentFields({order_nsu:'flydelivery-daily-'+id}));
 const empty=createBilling({env:{},rpc:async()=>assert.fail('No RPC before configuration')});await assert.rejects(empty.checkout('owner',id),e=>e.status===503);
 const calls=[];const billing=createBilling({env,rpc:async(action,input)=>{calls.push(action);return {id,amount_cents:1500,invoice_date:'2026-11-06',checkout_lock_id:'lock'};},fetchImpl:async()=>Response.json({url:'https://attacker.example'})});
 await assert.rejects(billing.checkout('owner',id));assert.deepEqual(calls,['acquire','release']);
});
