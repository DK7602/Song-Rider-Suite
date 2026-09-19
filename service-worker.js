const CACHE = 'song-rider-suite-v3.3.37-phantom-chord-fix';
const ASSETS = [
  './','./index.html','./styles.css','./app.js','./parts.js','./beat-maker.js',
  './crp-layout-lock.css','./suite-shell-lock.css','./branding-shell.css','./suite-header.css',
  './vocal-autotune-worklet.js','./manifest.webmanifest',
  './assets/chord-rider-pro-wordmark-hq2.png','./assets/baby-daw-button-hq.png','./assets/suite-header-new.png',
  './assets/apple-touch-icon.png','./assets/icon-192.png','./assets/rider-and-bones-icon.png',
  './assets/crp-rider-bones-sticker.png','./assets/srp-rider-bones-sticker.png',
  './assets/rider-and-bones-left.gif','./assets/rider-and-bones-right.gif',
  './assets/rider-and-bones-left-still.png','./assets/rider-and-bones-right-still.png',
  './assets/baby-daw-generated-source.png','./assets/rider-bones-mode-sticker.png','./assets/baby-daw-head-chain-sticker.png',
  './song-rider/index.html','./song-rider/app.js','./song-rider/styles.css',
  './song-rider/branding-shell.css','./song-rider/suite-header.css','./song-rider/suite-shell-lock.css'
];
async function cacheAvailable(cache,url){
  try{const req=new Request(new URL(url,self.registration.scope).href,{cache:'reload'});const res=await fetch(req);if(res?.ok)await cache.put(req,res.clone());}catch{}
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
      const hit=await cache.match(event.request,{ignoreSearch:true});if(hit)return hit;
      if(event.request.mode==='navigate'){
        const rootIndex=new Request(new URL('./index.html',self.registration.scope).href),fallback=await cache.match(rootIndex,{ignoreSearch:true});if(fallback)return fallback;
      }
      return Response.error();
    }
  })());
});
