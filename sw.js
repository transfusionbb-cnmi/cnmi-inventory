/* CNMI Staff Planner PWA service worker — V428 */
const CACHE_PREFIX = 'cnmi-staff-planner-pwa-';
const CACHE_NAME = `${CACHE_PREFIX}v428`;
const APP_SHELL = [
  './', './index.html', './site.webmanifest', './style.css', './app.js',
  './pwa-install-v303.css', './pwa-install-v303.js',
  './patch-v217-partial-sell-shift-segments.js',
  './patch-v221-duty-date-slot-edit-month-ui.js',
  './patch-v234-ot-admin-ch4-hr-cycle.js',
  './patch-v315-interaction-preload.js',
  './patch-v316-egress-preload.js',
  './patch-v316-navigation-preload.js',
  './patch-v316-route-loader.js',
  './patch-v318-hr-carry-year-month-filter.js',
  './patch-v319-fiscal-year-unlock.js',
  './patch-v321-daily-role-options.js',
  './patch-v322-daily-baseline-compare.js',
  './patch-v323-popup-job-stability.js',
  './patch-v331-ch4-daily-detail-staff-order.js',
  './patch-v332-calendar-activity-time-location.js',
  './patch-v427-mobile-calendar-popup-font-fix.js',
  './patch-v333-physician-direct-leave.js',
  './patch-v335-daily-position-save-route-lock.js',
  './patch-v336-continuous-balance-staff-color.js',
  './patch-v337-daily-position-single-save-publish.js',
  './patch-v338-partial-trade-current-balance-fix.js',
  './patch-v339-thai-balance-label-holiday-carry.js',
  './patch-v340-baseline-duty-holiday-columns.js',
  './patch-v346-ot-carry-in-summary.js',
  './patch-v360-carry-rate-mobile-summary-fix.js',
  './patch-v366-continuous-ot-carry.js',
  './patch-v368-authoritative-continuous-ot-carry.js',
  './patch-v369-ot-menu-inventory-app-launch.js',
  './patch-v370-ot-mobile-fit.js',
  './patch-v372-position-admin-authoritative-mobile-jump.js',
  './patch-v373-position-stat-colors-compact-offdays.js',
  './patch-v374-outing-column-and-position-display-restore.js',
  './patch-v377-staff-duty-tracking-and-menu-number-fix.js',
  './patch-v378-daily-position-details-staff-color-clean.js',
  './patch-v379-daily-position-configured-order.js',
  './patch-v380-compact-ot-detail-text.js',
  './patch-v381-daily-position-slot-metadata-source.js',
  './patch-v396-training-integrated.js',
  './patch-v347-ot-claim-details-money.js',
  './patch-v348-ot-trade-rate-tabs-popup.js',
  './patch-v326-donor-helper-unit-dropdown.js',
  './patch-v327-donor-helper-internal-booking.js',
  './donor-helper-v327.css',
  './donor-helper.html',
  './donor-helper-public-v327.js',
  './donor-helper-public-v327.css',
  './patch-v227-manual-as-blood-bank-zone.js',
  './patch-v313-app-count-filter-pwa-trade-fix.js',
  './patch-v314-admin-ot-calendar-ch4-fix.js',
  './patch-v275-admin-manual-ui-corrections.js',
  './patch-v278-slot-stats-holiday-balance-navigation-fix.js',
  './patch-v292-schedule-image-export.js',
  './patch-v297-position-month-image-export-slot-details.js',
  './patch-v305-mobile-app-scroll-and-position-description.js',
  './patch-v311-mobile-popup-daily-summary-fix.js',
  './android-chrome-192x192.png', './android-chrome-512x512.png',
  './maskable-icon-192x192.png', './maskable-icon-512x512.png',
  './apple-touch-icon.png', './favicon-32x32.png', './favicon-16x16.png'
];
self.addEventListener('install', event => {
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE_NAME);
    /* Cache files independently: one missing legacy file must not block the new PWA version. */
    await Promise.allSettled(APP_SHELL.map(async url=>{
      const request=new Request(url,{cache:'reload'});
      const response=await fetch(request);
      if(response?.ok) await cache.put(request,response.clone());
    }));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request=event.request;
  if(request.method!=='GET') return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin) return;
  if(url.pathname.endsWith('/config.js')||url.pathname.endsWith('config.js')) return;
  if(request.mode==='navigate'){
    const isHelperPage=url.pathname.endsWith('/donor-helper.html')||url.pathname.endsWith('donor-helper.html');
    const fallback=isHelperPage?'./donor-helper.html':'./index.html';
    event.respondWith(fetch(request).then(response=>{
      if(response?.ok){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(fallback,copy));}
      return response;
    }).catch(async()=>await caches.match(request,{ignoreSearch:true})||await caches.match(fallback,{ignoreSearch:true})||Response.error()));
    return;
  }
  const cacheableDestinations=new Set(['script','style','image','font','manifest']);
  if(!cacheableDestinations.has(request.destination)) return;
  event.respondWith(fetch(request).then(response=>{
    if(response?.ok&&response.type==='basic'){const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(request,copy));}
    return response;
  }).catch(async()=>await caches.match(request)||await caches.match(request,{ignoreSearch:true})||Response.error()));
});
