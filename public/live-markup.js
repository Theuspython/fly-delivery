// Compare generated markup, not HTML serialized by the browser (e.g. hidden="").
// Reuse keyed cards and their decoded images when live data changes.
const rendered=new WeakMap();
const key=node=>node.nodeType===1?(node.getAttribute('data-order-id')||node.id||node.getAttribute('data-queue-filter')||
  node.getAttribute('data-product-shop')||node.getAttribute('data-managed-product')||''):'';
const compatible=(a,b)=>a?.nodeType===b.nodeType&&a.nodeName===b.nodeName;

function patch(current,next) {
  if(current.isEqualNode(next))return;
  if(current.nodeType!==1){current.nodeValue=next.nodeValue;return;}
  const pending=current.hasAttribute('data-pending-transition');
  const failed=current.getAttribute('data-failed-photo');
  const keepFallback=failed&&current.classList.contains('profile-avatar')&&next.querySelector('img')?.getAttribute('src')===failed;
  for(const attribute of [...current.attributes]){
    if(pending&&['disabled','data-pending-transition'].includes(attribute.name))continue;
    if(keepFallback&&attribute.name==='data-failed-photo')continue;
    if(!next.hasAttribute(attribute.name))current.removeAttribute(attribute.name);
  }
  for(const attribute of next.attributes){
    if(pending&&attribute.name==='disabled')continue;
    if(current.getAttribute(attribute.name)!==attribute.value)current.setAttribute(attribute.name,attribute.value);
  }
  if(keepFallback){const initials=next.getAttribute('data-initials')||'C';if(current.textContent!==initials)current.textContent=initials;return;}
  patchChildren(current,next);
}
function patchChildren(parent,next) {
  const keyed=new Map([...parent.childNodes].filter(node=>key(node)).map(node=>[key(node),node]));
  let cursor=parent.firstChild;
  for(const desired of [...next.childNodes]){
    const identity=key(desired);
    let node=identity?keyed.get(identity):(!key(cursor??{})&&compatible(cursor,desired)?cursor:null);
    if(!compatible(node,desired))node=null;
    if(!node){node=desired.cloneNode(true);parent.insertBefore(node,cursor);}
    else{if(node!==cursor)parent.insertBefore(node,cursor);patch(node,desired);}
    cursor=node.nextSibling;
  }
  while(cursor){const next=cursor.nextSibling;cursor.remove();cursor=next;}
}
export function renderLiveMarkup(root,markup) {
  if(rendered.get(root)===markup)return false;
  const template=document.createElement('template');template.innerHTML=markup;
  patchChildren(root,template.content);
  rendered.set(root,markup);return true;
}
