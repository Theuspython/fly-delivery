import webPush from 'web-push';

const pushHost = /^(fcm\.googleapis\.com|([a-z0-9-]+\.)+push\.apple\.com|updates\.push\.services\.mozilla\.com)$/;

export function pushEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\/[^/]+\/[^#\s]+$/.test(value)) return null;
  try {
    const url = new URL(value);
    return pushHost.test(url.host) && !url.username && !url.password && !url.hash ? url.href : null;
  } catch { return null; }
}

export function createPush({rpc, env = process.env, send = webPush.sendNotification}) {
  const publicKey = env.FD_PUSH_PUBLIC_KEY;
  const privateKey = env.FD_PUSH_PRIVATE_KEY;
  const secret = env.FD_PUSH_BRIDGE_TOKEN;
  const enabled = /^[\w-]{87}$/.test(publicKey ?? '') && /^[\w-]{43}$/.test(privateKey ?? '') && (secret?.length ?? 0) >= 48;
  const vapidDetails = {subject:'https://www.flydeliverypp.com.br',publicKey,privateKey};
  let running = false;

  async function deliver(job) {
    let result = 'failed';
    if (pushEndpoint(job.endpoint)) {
      const options = {
        TTL:Math.max(0,Math.min(86400,job.ttl)),
        urgency:job.path ? 'high' : 'normal',
        topic:job.tag.replaceAll('-',''),
        timeout:8000,
        vapidDetails
      };
      try {
        await send({endpoint:job.endpoint,keys:{p256dh:job.p256dh,auth:job.auth_secret}},
          JSON.stringify({title:job.title,body:job.body,tag:job.tag,path:job.path || (job.role==='merchant' ? '/loja/#pedidos' : '/cliente/')}),options);
        result = 'sent';
      } catch (error) {
        const status = error.statusCode;
        if (status === 404 || status === 410) result = 'expired';
        else if (!status || status === 429 || status >= 500) result = 'retry';
      }
    }
    return {id:job.id,lease:job.lease,result};
  }

  async function tick() {
    if (!enabled || running) return;
    running = true;
    try {
      for (let batch=0;batch<4;batch++) {
        const jobs = await rpc(secret,'claim',{});
        if (!jobs.length) break;
        const results = await Promise.all(jobs.map(deliver));
        await rpc(secret,'finish',results);
        if (jobs.length<25) break;
      }
    } catch (error) {
      console.error('Push queue maintenance failed:',error.status ?? error.name);
    } finally { running = false; }
  }

  return {enabled,publicKey:enabled ? publicKey : null,tick};
}
