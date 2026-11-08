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
  const candidates=stores.filter(store=>category==='Todas'||(store.categories??[store.category]).includes(category));
  const byAvailabilityAndScore=(a,b)=>Number(Boolean(b.store.is_open))-Number(Boolean(a.store.is_open))||b.score-a.score;
  const names=candidates.map(store=>({store,score:tokens.length ? score(store.name,tokens) : 1}));
  const exactScore=tokens.length*4;
  const exactNames=names.filter(match=>!tokens.length||match.score===exactScore);
  if (!tokens.length || exactNames.length) return {type:'stores',results:exactNames.sort(byAvailabilityAndScore)};

  const products=[];
  for (const {store,score:nameScore} of names) {
    for (const product of store.products) {
      if (category!=='Todas' && product.category && product.category!==category) continue;
      const text=[product.name,product.description,...(product.options??[]).map(option=>option.name)].filter(Boolean).join(' ');
      const itemScore=score(text,tokens)||(!nameScore?score(store.name+' '+text,tokens):0);
      if (itemScore) products.push({store,product,score:itemScore});
    }
  }
  const exactProducts=products.filter(match=>match.score===exactScore);
  if (exactProducts.length) return {type:'products',results:exactProducts.sort(byAvailabilityAndScore)};
  const similarNames=names.filter(match=>match.score>0);
  if (similarNames.length) return {type:'stores',results:similarNames.sort(byAvailabilityAndScore)};
  return {type:'products',results:products.sort(byAvailabilityAndScore)};
}
