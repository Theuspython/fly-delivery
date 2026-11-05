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
  for (const role of ['cliente','loja','entregador','admin']) {
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

test('Google Maps loader, pin and worker are served from the same origin', async () => {
  for (const path of ['/google-map.js','/assets/map-pin.svg','/assets/icon-192.png','/sw.js']) {
    const response = await fetch(origin + path);
    assert.equal(response.status,200,path);
    assert.ok((await response.arrayBuffer()).byteLength > 100,path);
  }
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
  const provision = await fetch(origin + '/api/provision',{ method:'POST',headers,body:'{}' });
  assert.equal(provision.status,401);
  assert.equal((await fetch(origin + '/package.json')).status,404);
  const redirect = await fetch(origin + '/', { redirect:'manual' });
  assert.equal(redirect.headers.get('location'),'/cliente/');
});
