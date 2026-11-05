import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';

test('admin login accepts a Railway username and keeps the configured credentials on the server', async () => {
  const requests = [];
  const upstream = createServer(async (req,res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path:req.url, authorization:req.headers.authorization, body:JSON.parse(body) });
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ access_token:'test-access',refresh_token:'test-refresh',expires_in:3600 }));
  });
  upstream.listen(0,'127.0.0.1');
  await once(upstream,'listening');
  Object.assign(process.env,{
    SUPABASE_URL:'http://127.0.0.1:' + upstream.address().port,
    SUPABASE_PUBLISHABLE_KEY:'test-publishable',
    FD_ADMIN_BRIDGE_TOKEN:'test-bridge',
    FLY_DELIVERY_ADMIN_LOGIN:'Matheus',
    FLY_DELIVERY_ADMIN_PASSWORD:'test-secret'
  });
  const { createApp } = await import('../src/server.js');
  const app = createApp();
  app.listen(0,'127.0.0.1');
  await once(app,'listening');
  const origin = 'http://127.0.0.1:' + app.address().port;
  const login = (login,password) => fetch(origin + '/api/login',{
    method:'POST',headers:{ Origin:origin,'Content-Type':'application/json','X-FD-App':'admin' },
    body:JSON.stringify({ login,password })
  });
  try {
    const wrong = await login('Matheus','wrong-secret');
    assert.equal(wrong.status,401);
    assert.deepEqual(requests,[]);

    const correct = await login('Matheus','test-secret');
    assert.equal(correct.status,200);
    assert.deepEqual(await correct.json(),{ signedIn:true });
    assert.ok(correct.headers.getSetCookie().some(cookie => cookie.startsWith('fd_admin_access=test-access')));
    assert.deepEqual(requests,[{
      path:'/functions/v1/fd-onboarding',authorization:'Bearer test-bridge',
      body:{ action:'admin_login',input:{} }
    }]);
  } finally {
    await Promise.all([new Promise(resolve => app.close(resolve)),new Promise(resolve => upstream.close(resolve))]);
  }
});
