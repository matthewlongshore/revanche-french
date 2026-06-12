/* Revanche service worker — offline app shell + runtime audio cache */
const SHELL = 'revanche-shell-v9';
const RUNTIME = 'revanche-runtime-v2';
const SHELL_FILES = ['./','index.html','app.js','manifest.json','icon-180.png','icon-512.png'];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(SHELL).then(c=>c.addAll(SHELL_FILES)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(
    keys.filter(k=>k!==SHELL&&k!==RUNTIME).map(k=>caches.delete(k))
  )).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', e=>{
  const url = new URL(e.request.url);
  // never cache the pack index — that's how new packs are discovered
  if(url.pathname.endsWith('packs/index.json')) return;
  // audio (mp3/m4a, incl. cross-origin podcast) → cache-first runtime
  if(/\.(mp3|m4a|wav|ogg)(\?|$)/.test(url.pathname) || url.hostname.includes('acast')){
    e.respondWith(
      caches.open(RUNTIME).then(async c=>{
        const hit = await c.match(e.request, {ignoreVary:true});
        if(hit) return hit;
        const resp = await fetch(e.request.clone(), {mode: url.origin===location.origin?'cors':'no-cors'});
        if(resp && (resp.ok || resp.type==='opaque')) c.put(e.request, resp.clone());
        return resp;
      }).catch(()=>fetch(e.request))
    );
    return;
  }
  // packs + shell → cache-first, refresh in background
  e.respondWith(
    caches.match(e.request).then(hit=>{
      const refresh = fetch(e.request).then(resp=>{
        if(resp.ok) caches.open(url.pathname.includes('/packs/')?RUNTIME:SHELL)
          .then(c=>c.put(e.request,resp.clone()));
        return resp;
      }).catch(()=>hit);
      return hit || refresh;
    })
  );
});
