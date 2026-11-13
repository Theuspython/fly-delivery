const cacheName = 'fly-delivery-shell-v56';
const shell = ['/styles.css', '/app.js', '/install.js', '/shared.js', '/customer.js', '/customer-notifications.js', '/catalog-search.js', '/operations.js', '/admin-dashboard.js', '/admin-history-cleanup.js', '/meal-choices.js', '/live-markup.js', '/profile-photo.js', '/merchant.js', '/inventory.js', '/invoices.js', '/promotions.js', '/platform-coupons.js', '/push-settings.js', '/admin-push.js', '/assets/icon.svg?v=motoboy'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shell)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('fly-delivery-shell-') && key !== cacheName).map(key => caches.delete(key)))));
});

function notificationUrl(path) {
  const url = new URL(typeof path === 'string' ? path : '/cliente/', self.location.origin);
  return url.origin === self.location.origin && ['/cliente/','/loja/'].includes(url.pathname) ? url : new URL('/cliente/',self.location.origin);
}

self.addEventListener('push', event => {
  let data;
  try { data = event.data?.json(); } catch { data = null; }
  const url = notificationUrl(data?.path);
  event.waitUntil(self.registration.showNotification(data?.title || 'Fly Delivery',{
    body:data?.body || 'Abra o Fly Delivery para conferir.',
    icon:'/assets/icon-192.png?v=motoboy',
    tag:data?.tag,
    data:{url:url.href}
  }));
});

self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async ()=>{
    const url = notificationUrl(event.notification.data?.url);
    const windows = await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const exact = windows.find(client=>client.url === url.href);
    if (exact) return exact.focus();
    const app = windows.find(client=>new URL(client.url).pathname === url.pathname);
    if (app && url.hash) {
      const opened = await app.navigate(url.href).catch(()=>null);
      if (opened) return opened.focus();
    } else if (app) return app.focus();
    return self.clients.openWindow(url.href);
  })());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => new Response(
      '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fly Delivery</title><link rel="stylesheet" href="/styles.css"><main class="wrap"><h1>Você está offline</h1><p>Reconecte-se para acessar o Fly Delivery.</p><a href="">Tentar novamente</a></main></html>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    )));
  } else if (shell.includes(url.pathname)) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
  }
});
