const CACHE='stock-buddy-static-v086';
const BASE=self.registration.scope;
const ASSETS=['./','./index.html','./styles.css?v=0.75','./app.js?v=0.86','./manifest.webmanifest'].map(path=>new URL(path,BASE).href);
const STATIC_URLS=new Set(ASSETS);
const START_URLS=new Set([new URL('./',BASE).href,new URL('./index.html',BASE).href]);

async function validateShell(responses){
  for(let i=0;i<responses.length;i++){
    const response=responses[i];
    if(!response || !response.ok || response.type==='opaque' || response.redirected){
      throw new Error('Offline shell response invalid');
    }
    if(START_URLS.has(ASSETS[i])){
      const html=await response.clone().text();
      const scripts=[...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)];
      const appScripts=scripts.map(match=>new URL(match[1],ASSETS[i])).filter(url=>url.pathname===new URL('app.js',BASE).pathname);
      if(appScripts.length!==1 || appScripts[0].href!==new URL('app.js?v=0.86',BASE).href){
        throw new Error('Offline HTML version mismatch');
      }
    }
  }
  const js=await responses[3].clone().text();
  if(!/^const APP_VERSION=['"]0\.86['"];\s*$/m.test(js) || /<\s*(?:!doctype|html)\b/i.test(js)){
    throw new Error('Offline JavaScript version mismatch');
  }
}

function isPrivateRequest(request){
  const url=new URL(request.url);
  return url.hostname.endsWith('.workers.dev') ||
    /\/(?:quotes|history|trade|moomoo-analyze|sns-analyze)(?:\/|$)/i.test(url.pathname) ||
    request.headers.has('Authorization') || request.headers.has('X-Trade-Pin');
}
function isOwnedOldCache(name){
  return /^stock-buddy-v\d+$/.test(name) ||
    (name!==CACHE && /^stock-buddy-static-v\d+$/.test(name));
}
self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    // Validate the entire deployment before writing or deleting any cache.
    const responses=await Promise.all(ASSETS.map(async url=>{
      const response=await fetch(new Request(url,{cache:'no-store'}));
      // Drain each body before waiting for all fetches; keep the original for validation and caching.
      await response.clone().arrayBuffer();
      return response;
    }));
    await validateShell(responses);
    const cache=await caches.open(CACHE);
    for(let i=0;i<ASSETS.length;i++)await cache.put(ASSETS[i],responses[i]);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    await validateShell(await Promise.all(ASSETS.map(url=>cache.match(url))));
    await Promise.all((await caches.keys()).filter(isOwnedOldCache).map(name=>caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(isPrivateRequest(request)){
    // API failures must not read Cache Storage or fall back to HTML.
    event.respondWith(fetch(request,{cache:'no-store'}));
    return;
  }
  if(request.method!=='GET' || !STATIC_URLS.has(request.url)){
    // Unknown dynamic requests also bypass the browser HTTP cache.
    event.respondWith(fetch(request,{cache:'no-store'}));
    return;
  }
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    const cached=await cache.match(request);
    if(cached)return cached;
    try{return await fetch(request);}
    catch(error){
      if(request.mode==='navigate' && START_URLS.has(request.url)){
        const shell=await cache.match(new URL('./index.html',BASE).href);
        if(shell)return shell;
      }
      throw error;
    }
  })());
});
