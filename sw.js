const CACHE_PREFIX='cnmi-inventory-';
const CACHE=CACHE_PREFIX+'v1.4.2';
const ASSETS=[
  './','./index.html','./label.html','./assets/app.css','./assets/app.js','./assets/qr-lite.js',
  './manifest.webmanifest','./icons/favicon-32.png','./icons/icon-192.png','./icons/icon-512.png',
  './icons/icon-maskable-192.png','./icons/icon-maskable-512.png','./icons/icon-180.png'
];
self.addEventListener('install',event=>{event.waitUntil((async()=>{const cache=await caches.open(CACHE);await Promise.allSettled(ASSETS.map(async url=>{const response=await fetch(new Request(url,{cache:'reload'}));if(response&&response.ok)await cache.put(url,response.clone())}));await self.skipWaiting()})())});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith(CACHE_PREFIX)&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',event=>{const request=event.request;if(request.method!=='GET')return;const url=new URL(request.url);if(url.origin!==self.location.origin)return;if(url.pathname.endsWith('/assets/config.js')||url.pathname.endsWith('assets/config.js'))return;
// หน้าพิมพ์ต้องโหลดตรงจากเครือข่าย เพื่อไม่ให้ Service Worker/แคชค้างระหว่าง Chrome สร้าง Print Preview
if(url.pathname.endsWith('/label.html')||url.pathname.endsWith('label.html'))return;
if(request.mode==='navigate'){event.respondWith(fetch(request).then(response=>{const isAppShell=url.pathname.endsWith('/')||url.pathname.endsWith('/index.html')||url.pathname.endsWith('index.html');if(isAppShell&&response&&response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put('./index.html',copy))}return response}).catch(async()=>await caches.match(request,{ignoreSearch:true})||await caches.match('./index.html')||Response.error()));return}event.respondWith(fetch(request).then(response=>{if(response&&response.ok&&response.type==='basic'){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy))}return response}).catch(async()=>await caches.match(request)||await caches.match(request,{ignoreSearch:true})||Response.error()))});
