// Accent-insensitive matching, with small typo tolerance for longer search words.
export const normalize = value => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
const words = value => normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [];
function distance(a,b) {
  let row=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++) {
    const next=[i];
    for(let j=1;j<=b.length;j++) next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1));
    row=next;
  }
  return row[b.length];
}
function score(text,tokens) {
  const value=normalize(text), candidates=words(text);
  let total=0;
  for(const token of tokens) {
    if(value.includes(token)){total+=4;continue;}
    const tolerance=token.length>=7?2:token.length>=4?1:0;
    if(!tolerance || !candidates.some(word=>Math.abs(word.length-token.length)<=tolerance && distance(word,token)<=tolerance)) return 0;
    total+=1;
  }
  return total;
}
export function searchCatalog(stores,category,query) {
  const tokens=words(String(query).slice(0,100));
  return stores.filter(store=>category==='Todas'||(store.categories??[store.category]).includes(category)).map(store=>{
    if(!tokens.length)return {store,products:[],score:1};
    const identity=[store.name,...(store.categories??[store.category])].join(' ');
    const direct=score(identity,tokens);
    const products=store.products.map(product=>{
      const text=product.name+' '+(product.description??'')+' '+(product.options??[]).map(option=>option.name).join(' ');
      return {product,score:score(text,tokens)||(!direct?score(identity+' '+text,tokens):0)};
    }).filter(match=>match.score>0).sort((a,b)=>b.score-a.score);
    return {store,products:products.map(match=>match.product),score:direct?direct+10:Math.max(0,...products.map(match=>match.score))};
  }).filter(match=>match.score>0).sort((a,b)=>Number(Boolean(b.store.is_open))-Number(Boolean(a.store.is_open))||b.score-a.score);
}
