import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogPage } from '../src/catalog.js';

const stores=Array.from({length:17},(_,index)=>({
  id:'store-'+index,name:index===0?'Elias Lanches':'Loja '+index,category:'Hambúrguer',categories:['Hambúrguer'],
  is_open:index<15,fee:0,products:Array.from({length:2},(_,item)=>({
    id:index+'-'+item,name:'Lanche '+index+'-'+item,description:'Bacon',image:'/product-'+index+'.webp',
    price:2500,sales_rank:index<10?index*2+item+1:null,sizes:[{name:'P',price:2500}]
  }))
}));
const page=(options={})=>catalogPage(stores,new URLSearchParams({seed:'customer-session',...options}));

test('catalogue sends fifteen card summaries per batch in a stable order',()=>{
  const first=page(),next=page({offset:15});
  assert.equal(first.items.length,15);
  assert.equal(first.next,15);
  assert.ok(first.items.every(({store})=>store.is_open&&store.image&&!('products' in store)));
  assert.equal(next.items.length,2);
  assert.equal(next.next,null);
  assert.equal(first.version,next.version);
  assert.equal(new Set([...first.items,...next.items].map(item=>item.store.id)).size,17);
});

test('dish search and ranking send only the current product batch and keep store-name matches separate',()=>{
  const search=page({query:'bacon'});
  assert.equal(search.type,'products');
  assert.equal(search.total,34);
  assert.equal(search.items.length,15);
  assert.ok(search.items.every(({product})=>product.has_sizes&&!('sizes' in product)));
  assert.equal(page({query:'elias'}).type,'stores');
  const ranked=page({filter:'best-sellers',offset:15});
  assert.deepEqual(ranked.items.map(({product})=>product.sales_rank),[16,17,18,19,20]);
  assert.equal(ranked.next,null);
});
