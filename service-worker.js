const CACHE = 'song-rider-suite-v3.4.1';
// Precached so the whole suite opens offline. Everything else is cached the first time it loads.
const ASSETS = [
  './','./index.html','./manifest.webmanifest',
  './app.js','./parts.js','./beat-maker.js','./scale-rider.js','./skins.js','./vocal-autotune-worklet.js',
  './styles.css','./scale-rider.css','./crp-layout-lock.css','./suite-shell-lock.css','./branding-shell.css','./suite-header.css','./skins.css','./suite-brand.css','./suite-compact.css',
  './assets/brand/icon-chord-rider-pro-256.webp','./assets/brand/icon-baby-daw-256.webp','./assets/brand/icon-song-rider-pro-256.webp',
  './vendor/soundfont-player.js','./vendor/html2canvas.min.js','./vendor/jspdf.umd.min.js',
  './assets/rider-blood-light-pattern.jpg','./assets/light-diamond-pattern.jpg','./assets/studio-pastel-pattern.jpg','./assets/rider-dark-gold-pattern.jpg','./assets/rider-og-pattern.jpg','./assets/rider-blood-pattern.jpg','./assets/rider-light-og-pattern.jpg','./assets/rider-blood-light-og-pattern.jpg','./assets/sapphire-paisley-dark.jpg','./assets/sapphire-paisley-light.jpg',
  './assets/suite-header-new.webp','./assets/chord-rider-pro-wordmark-hq2.webp','./assets/baby-daw-button-hq.webp','./assets/baby-daw-button-hq-rider-blood-light-active.webp',
  './assets/crp-rider-bones-sticker.webp','./assets/srp-rider-bones-sticker.webp','./assets/rider-bones-mode-sticker.webp','./assets/baby-daw-head-chain-sticker.webp',
  './assets/apple-touch-icon.png','./assets/icon-192.png','./assets/rider-and-bones-icon.png',
  './assets/rider-and-bones-left.gif','./assets/rider-and-bones-right.gif','./assets/rider-and-bones-left-still.png','./assets/rider-and-bones-right-still.png','./assets/baby-daw-generated-source.png',
  './song-rider/index.html','./song-rider/app.js','./song-rider/manifest.webmanifest',
  './song-rider/song-rider-pro-wordmark-hq.webp','./song-rider/song-rider-pro-wordmark-blood.webp','./song-rider/horse-parked.png','./song-rider/Horserunsleft.gif','./song-rider/Horserunsright.gif',
  './song-rider/pdf.mjs','./song-rider/pdf.worker.mjs','./song-rider/lame.min.js'
];
// Cloudflare serves /x/index.html as a redirect to /x/. Browsers refuse a redirected
// response for a page navigation, so store a plain copy instead.
function plain(res){return res&&res.redirected?new Response(res.body,{status:res.status,statusText:res.statusText,headers:res.headers}):res;}
async function cacheAvailable(cache,url){
  try{const req=new Request(new URL(url,self.registration.scope).href,{cache:'reload'});const res=await fetch(req);if(res?.ok)await cache.put(req,plain(res));}catch{}
}
self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(CACHE);await Promise.allSettled(ASSETS.map(url=>cacheAvailable(cache,url)));await self.skipWaiting();})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{const keys=await caches.keys();await Promise.all(keys.filter(k=>k.startsWith('song-rider-suite-')&&k!==CACHE).map(k=>caches.delete(k)));await self.clients.claim();})()));
function isCoreText(url,request){return request.mode==='navigate'||/\.(?:html|css|js|webmanifest)$/i.test(url.pathname);}
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);if(url.origin!==self.location.origin||url.pathname.includes('/api/'))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE),core=isCoreText(url,event.request);
    try{
      // Keep the Suite shell/code version-matched after CRP <-> SRP navigation.
      const res=core?await fetch(event.request,{cache:'no-store'}):await fetch(event.request);
      if(res?.ok)await cache.put(event.request,res.clone()).catch(()=>{});
      return res;
    }catch{
      const dir=url.pathname.endsWith('/index.html')?url.origin+url.pathname.slice(0,-'index.html'.length):null;
      const hit=await cache.match(event.request,{ignoreSearch:true})||(dir&&await cache.match(dir,{ignoreSearch:true}));if(hit)return plain(hit);
      if(event.request.mode==='navigate'){
        const rootIndex=new Request(new URL('./index.html',self.registration.scope).href),fallback=await cache.match(rootIndex,{ignoreSearch:true});if(fallback)return plain(fallback);
      }
      return Response.error();
    }
  })());
});
