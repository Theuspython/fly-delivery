import assert from 'node:assert/strict';
import test from 'node:test';
import { searchCatalog } from '../public/catalog-search.js';
const shops=[
 {id:'burger',name:'Brasa da Praça',categories:['Hambúrguer','Açaí'],products:[{name:'Duplo artesanal',description:'Carne e cheddar',options:[{name:'Ovo'}]},{name:'Açaí banana',description:'Frutas frescas'}]},
 {id:'pizza',name:'Forno Central',categories:['Pizza'],products:[{name:'Pizza calabresa',description:'Massa fina'}]}
];
test('catalog search matches accents, word order, product details and small typos',()=>{
 for(const query of ['praca','acaí','artesanal duplo','brasa cheddar','artesnal','calabreza','Forno Central','ovo']) assert.ok(searchCatalog(shops,'Todas',query).length,query);
 assert.equal(searchCatalog(shops,'Todas','calabreza')[0].products[0].name,'Pizza calabresa');
 assert.equal(searchCatalog(shops,'Todas','acai')[0].products[0].name,'Açaí banana');
 assert.deepEqual(searchCatalog(shops,'Pizza','cheddar'),[]);
 assert.deepEqual(searchCatalog(shops,'Todas','astronauta inexistente'),[]);
 assert.equal(searchCatalog(shops,'Todas','').length,2);
 assert.equal(searchCatalog(shops,'Todas','pizza')[0].store.id,'pizza');
});
