// Retired. Song Rider Pro is served by the suite-wide /service-worker.js.
// Older builds registered this file for the /song-rider/ scope; this version removes itself
// and its caches so those phones stop serving stale code.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k.startsWith('song-rider-pro') || k.includes('-srp')).map(k => caches.delete(k)));
  await self.registration.unregister();
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(c => c.navigate(c.url));
})()));
