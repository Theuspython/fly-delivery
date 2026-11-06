import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/server.js';

let app, origin;
before(async () => {
  app = createApp();
  app.listen(0,'127.0.0.1');
  await once(app,'listening');
  origin = 'http://127.0.0.1:' + app.address().port;
});
after(() => new Promise(resolve => app.close(resolve)));

test('health and distinct PWA entry points', async () => {
  const health = await fetch(origin + '/health');
  assert.deepEqual(await health.json(),{ status:'ok' });
  for (const role of ['cliente','loja','admin']) {
    const entry = await fetch(origin + '/' + role + '/');
    assert.equal(entry.status,200);
    assert.match(entry.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    assert.match(await entry.text(),new RegExp('href="/' + role + '\\.webmanifest"'));
    const manifest = await (await fetch(origin + '/' + role + '.webmanifest')).json();
    assert.equal(manifest.start_url,'/' + role + '/');
    assert.equal(manifest.id,manifest.start_url);
    assert.equal(manifest.scope,manifest.start_url);
    assert.equal(manifest.display,'standalone');
  }
});

test('PWA assets work and retired courier/maps entry points are unavailable', async () => {
  for (const path of ['/assets/icon-192.png','/sw.js','/install.js']) {
    const response = await fetch(origin + path);
    assert.equal(response.status,200,path);
    assert.ok((await response.arrayBuffer()).byteLength > 100,path);
  }
  for (const path of ['/entregador','/entregador/','/entregador.webmanifest','/api/maps/browser-config']) {
    assert.equal((await fetch(origin + path)).status,410,path);
  }
  assert.equal((await fetch(origin + '/google-map.js')).status,404);
  const retiredLogin = await fetch(origin + '/api/login',{ method:'POST',
    headers:{ Origin:origin,'Content-Type':'application/json','X-FD-App':'entregador' },body:'{}' });
  assert.equal(retiredLogin.status,410);
  const courierProvision = await fetch(origin + '/api/provision',{ method:'POST',
    headers:{ Origin:origin,'Content-Type':'application/json','X-FD-App':'admin',Cookie:'fd_admin_access=fixture' },
    body:JSON.stringify({kind:'courier',login:'fixture',password:'fixture-password'}) });
  assert.equal(courierProvision.status,400);
});

test('unauthenticated and cross-origin mutations are rejected', async () => {
  for (const [source,status] of [['https://other.example',403],[origin,401]]) {
    const response = await fetch(origin + '/api/command', {
      method:'POST',headers:{ Origin:source,'Content-Type':'application/json' },
      body:JSON.stringify({ action:'orders',input:{} })
    });
    assert.equal(response.status,status);
    assert.equal(response.headers.get('cache-control'),'no-store');
  }
  const headers = { Origin:origin,'Content-Type':'application/json','X-FD-App':'loja' };
  const signup = await fetch(origin + '/api/signup',{
    method:'POST',headers,body:JSON.stringify({ email:'fixture@example.invalid',password:'example-password' })
  });
  assert.equal(signup.status,403);
  const invalidCpf = await fetch(origin + '/api/signup',{
    method:'POST',headers:{ ...headers,'X-FD-App':'cliente' },
    body:JSON.stringify({ cpf:'111.111.111-11',password:'example-password',name:'Cliente teste',phone:'31999999999' })
  });
  assert.equal(invalidCpf.status,400);
  assert.match((await invalidCpf.json()).error,/CPF válido/);
  const provision = await fetch(origin + '/api/provision',{ method:'POST',headers,body:'{}' });
  assert.equal(provision.status,401);
  const updates = await fetch(origin + '/api/order-updates');
  assert.equal(updates.status,401);
  const crossSiteUpdates = await fetch(origin + '/api/order-updates',{ headers:{ 'Sec-Fetch-Site':'cross-site' } });
  assert.equal(crossSiteUpdates.status,403);
  assert.equal((await fetch(origin + '/package.json')).status,404);
  const redirect = await fetch(origin + '/', { redirect:'manual' });
  assert.equal(redirect.headers.get('location'),'/cliente/');
});
