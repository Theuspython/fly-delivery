import { createHash } from 'node:crypto';
import { searchCatalog } from '../public/catalog-search.js';

export const catalogBatchSize = 15;

function cardStore(store) {
  const {id,name,description,category,categories,is_open,fee,eta,coupon_bps,rating_average,rating_count} = store;
  return {id,name,description,category,categories,is_open,fee,eta,coupon_bps,rating_average,rating_count,
    image:store.image || store.products.find(product => product.image)?.image};
}

export function catalogPage(stores, params) {
  const filter = params.get('filter') ?? 'all';
  const category = (params.get('category') || 'Todas').slice(0,80);
  const query = (params.get('query') ?? '').slice(0,100);
  const seed = (params.get('seed') ?? '').slice(0,80);
  const rawOffset = params.get('offset') ?? '0';
  const offset = /^\d{1,7}$/.test(rawOffset) ? Number(rawOffset) : 0;
  const shuffleRank = store => createHash('sha256').update(seed + ':' + store.id).digest('hex');
  const ordered = stores.map(store => ({store,rank:shuffleRank(store)}))
    .sort((a,b) => a.rank.localeCompare(b.rank)).map(entry => entry.store);
  const ranked = filter === 'best-sellers';
  let candidates = ordered;
  if (filter === 'coupons') candidates = ordered.filter(store => store.coupon_bps > 0);
  if (filter === 'free') candidates = ordered.filter(store => store.fee === 0);
  if (filter === 'rating') candidates = ordered.filter(store => store.rating_count > 0);
  const {type,results} = ranked ? {type:'products',results:bestSellers(ordered,category,query)} : searchCatalog(candidates,category,query);
  if (filter === 'coupons') results.sort((a,b) => b.store.coupon_bps - a.store.coupon_bps);
  if (filter === 'rating') results.sort((a,b) => b.store.rating_average - a.store.rating_average || b.store.rating_count - a.store.rating_count);
  const items = results.slice(offset,offset+catalogBatchSize).map(({store,product}) => {
    const card = {store:cardStore(store)};
    if (product) card.product = {id:product.id,name:product.name,image:product.image,price:product.price,
      sales_rank:product.sales_rank,has_sizes:Boolean(product.sizes?.length)};
    return card;
  });
  const version = createHash('sha256').update(JSON.stringify(results.map(({store,product}) => [store.id,product?.id]))).digest('hex');
  return {type,items,total:results.length,version,next:offset+items.length<results.length ? offset+items.length : null,
    has_stores:stores.length>0,promotion_bps:stores.find(store => store.promotion_bps>0)?.promotion_bps ?? 0};
}

function bestSellers(stores,category,query) {
  return stores.flatMap(store => store.products.filter(product => product.sales_rank>0).map(product => ({store,product})))
    .filter(({store,product}) => (category==='Todas' || !product.category || product.category===category) &&
      searchCatalog([{...store,products:[product]}],category,query).results.length)
    .sort((a,b) => a.product.sales_rank-b.product.sales_rank);
}
