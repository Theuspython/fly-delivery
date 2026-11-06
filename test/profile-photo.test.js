import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {test} from 'node:test';

test('profile images upload privately, keep ownership and use each app session for authorized downloads',async()=>{
  const buyer='10000000-0000-4000-8000-000000000001';
  const oldPhoto=buyer+'/20000000-0000-4000-8000-000000000002.jpg';
  const jpeg=Buffer.from('ffd8ffe000104a4649460001','hex');
  let profile={name:'Cliente Teste',phone:'31999990000',photo:oldPhoto};
  let failSave=false;
  const requests=[];
  const upstream=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const bytes=Buffer.concat(chunks);
    const body=req.headers['content-type']==='application/json'&&bytes.length?JSON.parse(bytes):null;
    requests.push({path:req.url,method:req.method,authorization:req.headers.authorization,body,bytes});
    const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    if(req.url==='/rest/v1/rpc/fd_api'){
      if(body.action==='session')return json(200,{id:buyer,role:req.headers.authorization==='Bearer merchant-with-order'?'merchant':'customer'});
      if(body.action==='customer_profile')return json(200,profile);
      if(body.action==='save_customer_photo'){
        if(failSave)return json(409,{code:'P0001',message:'FD: Não foi possível salvar a foto.'});
        profile={...profile,photo:body.input.path};return json(200,profile);
      }
    }
    if(req.url.startsWith('/storage/v1/object/authenticated/')){
      if(req.headers.authorization==='Bearer merchant-without-order')return json(403,{message:'denied'});
      res.writeHead(200,{'Content-Type':'image/jpeg'});return res.end(jpeg);
    }
    if(req.url.startsWith('/storage/v1/object/'))return json(200,{});
    json(404,{});
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  Object.assign(process.env,{SUPABASE_URL:'http://127.0.0.1:'+upstream.address().port,SUPABASE_PUBLISHABLE_KEY:'fixture-publishable'});
  const {createApp}=await import('../src/server.js');
  const app=createApp();app.listen(0,'127.0.0.1');await once(app,'listening');
  const origin='http://127.0.0.1:'+app.address().port;
  const upload=(bytes=jpeg,type='image/jpeg',scope='cliente',cookie='fd_cliente_access=buyer-token')=>fetch(origin+'/api/upload-profile',{
    method:'POST',headers:{Origin:origin,'Content-Type':type,'X-FD-App':scope,Cookie:cookie},body:bytes
  });
  try{
    assert.equal((await upload(jpeg,'image/jpeg','cliente','')).status,401);
    assert.equal((await upload(jpeg,'image/jpeg','loja','fd_loja_access=merchant-with-order')).status,401);
    assert.equal((await upload(jpeg,'image/jpeg','cliente','fd_cliente_access=merchant-with-order')).status,403);
    assert.equal((await upload(Buffer.from('<svg/>'),'image/png')).status,400);
    assert.equal((await upload(jpeg,'text/html')).status,400);
    assert.equal((await upload(Buffer.alloc(3*1024*1024+1),'image/jpeg')).status,413);
    requests.length=0;
    const response=await upload();assert.equal(response.status,201);
    const updated=await response.json();
    assert.match(updated.photo,new RegExp('^'+buyer+'/[0-9a-f-]{36}\\.jpg$'));
    const object=requests.find(x=>x.path.startsWith('/storage/v1/object/fly-delivery-profiles/'));
    assert.deepEqual(object.bytes,jpeg);assert.equal(object.authorization,'Bearer buyer-token');
    assert.deepEqual(requests.find(x=>x.method==='DELETE').body,{prefixes:[oldPhoto]});
    const path='/api/profile-photo?scope=loja&path='+encodeURIComponent(updated.photo);
    const cookies='fd_cliente_access=buyer-token; fd_loja_access=merchant-with-order';
    const image=await fetch(origin+path,{headers:{Cookie:cookies}});
    assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),jpeg);
    assert.equal(image.headers.get('cache-control'),'private, no-store');
    assert.equal(requests.at(-1).authorization,'Bearer merchant-with-order');
    assert.equal((await fetch(origin+path)).status,401);
    assert.equal((await fetch(origin+path,{headers:{Cookie:'fd_loja_access=merchant-without-order'}})).status,404);
    assert.equal((await fetch(origin+path,{headers:{Cookie:cookies,'Sec-Fetch-Site':'cross-site'}})).status,403);
    assert.equal((await fetch(origin+'/api/profile-photo?scope=cliente&path=../other.jpg',{headers:{Cookie:cookies}})).status,400);
    const own=await fetch(origin+path.replace('scope=loja','scope=cliente'),{headers:{Cookie:cookies}});
    assert.equal(own.status,200);assert.equal(requests.at(-1).authorization,'Bearer buyer-token');
    failSave=true;requests.length=0;
    assert.equal((await upload()).status,409);
    assert.equal(profile.photo,updated.photo);
    const failedObject=requests.find(x=>x.path.startsWith('/storage/v1/object/fly-delivery-profiles/')).path.split('/fly-delivery-profiles/')[1];
    assert.deepEqual(requests.at(-1).body,{prefixes:[failedObject]});
    const menu=await fetch(origin+'/api/upload?store='+buyer,{method:'POST',
      headers:{Origin:origin,'Content-Type':'image/jpeg','X-FD-App':'loja',Cookie:'fd_loja_access=merchant-with-order'},body:jpeg});
    assert.equal(menu.status,201);assert.match((await menu.json()).url,/\/object\/public\/fly-delivery-menu\//);
  }finally{await Promise.all([new Promise(r=>app.close(r)),new Promise(r=>upstream.close(r))]);}
});
