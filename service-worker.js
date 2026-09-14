const CACHE = 'chord-rider-pro-v2.8.4-srp-card-transport';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './parts.js',
  './beat-maker.js',
  './manifest.webmanifest',
  './assets/rider-and-bones-icon.png',
  './assets/rider-and-bones-left.gif',
  './assets/rider-and-bones-right.gif',
  './assets/rider-and-bones-left-still.png',
  './assets/rider-and-bones-right-still.png',
  './assets/baby-daw-generated-source.png',
  './assets/rider-bones-mode-sticker.png',
  './assets/baby-daw-head-chain-sticker.png',
  './song-rider/index.html',
  './song-rider/app.js'
];
self.addEventListener('install', e => e.waitUntil((async()=>{await caches.open(CACHE).then(c=>c.addAll(ASSETS));await self.skipWaiting();})()));
self.addEventListener('activate', e => e.waitUntil(Promise.all([self.clients.claim(), caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))])));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
      return r;
    }).catch(() => caches.match(e.request))
  );
});
