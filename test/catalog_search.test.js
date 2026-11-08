import assert from 'node:assert/strict';
import test from 'node:test';
import { searchCatalog } from '../public/catalog-search.js';

const shops=[
  {id:'elias',name:'Elias Lanches',categories:['Hambúrguer','Açaí'],products:[
    {name:'Duplo artesanal',category:'Hambúrguer',description:'Carne, bacon e cheddar',options:[{name:'Ovo'}]},
    {name:'Bacon da casa',category:'Hambúrguer',description:'Especial de lanches'},
    {name:'Açaí banana',category:'Açaí',description:'Frutas frescas'}
  ]},
  {id:'pizza',name:'Forno Central',categories:['Pizza'],products:[
    {name:'Pizza calabresa',category:'Pizza',description:'Massa fina'},
    {name:'Pizza especial',category:'Pizza',description:'Queijo e bacon'}
  ]},
  {id:'baco',name:'Baco Petiscos',categories:['Porções'],products:[{name:'Batata',category:'Porções'}]}
];

test('a store name returns stores and an ingredient returns matching products',()=>{
  for (const query of ['elias','lanches','Elias Lanches','eliaz']) {
    const result=searchCatalog(shops,'Todas',query);
    assert.equal(result.type,'stores',query);
    assert.deepEqual(result.results.map(match=>match.store.id),['elias']);
  }
  const result=searchCatalog(shops,'Todas','bacon');
  assert.equal(result.type,'products');
  assert.deepEqual(result.results.map(match=>match.product.name),['Duplo artesanal','Bacon da casa','Pizza especial']);
});

test('product search matches accents, word order, descriptions, options and small typos',()=>{
  for(const query of ['acai','artesanal duplo','elias cheddar','artesnal','calabreza','ovo']) {
    const result=searchCatalog(shops,'Todas',query);
    assert.equal(result.type,'products',query);
    assert.ok(result.results.length,query);
  }
  assert.equal(searchCatalog(shops,'Todas','calabreza').results[0].product.name,'Pizza calabresa');
  assert.equal(searchCatalog(shops,'Todas','acai').results[0].product.name,'Açaí banana');
  assert.deepEqual(searchCatalog(shops,'Açaí','bacon').results,[]);
  assert.deepEqual(searchCatalog(shops,'Pizza','cheddar').results,[]);
  assert.deepEqual(searchCatalog(shops,'Todas','astronauta inexistente').results,[]);
});

test('open stores come before closed stores in the showcase and in matching results',()=>{
  const stores=[
    {id:'closed',name:'Forno Fechado',is_open:false,categories:['Pizza'],products:[{name:'Pizza Margherita'}]},
    {id:'open',name:'Forno Aberto',is_open:true,categories:['Pizza'],products:[{name:'Pizza Margherita'}]}
  ];
  for(const query of ['', 'forno','margherita']) for(const category of ['Todas','Pizza']) {
    assert.deepEqual(searchCatalog(stores,category,query).results.map(match=>match.store.id),['open','closed']);
  }
  assert.deepEqual(stores.map(store=>store.id),['closed','open']);
});
