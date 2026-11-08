const cacheName = 'fly-delivery-shell-v36';
const shell = ['/styles.css', '/app.js', '/install.js', '/shared.js', '/customer.js', '/customer-notifications.js', '/catalog-search.js', '/operations.js', '/admin-dashboard.js', '/meal-choices.js', '/live-markup.js', '/profile-photo.js', '/merchant.js', '/invoices.js', '/promotions.js', '/assets/icon.svg?v=motoboy'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shell)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('fly-delivery-shell-') && key !== cacheName).map(key => caches.delete(key)))));
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
