const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const cp=require('node:child_process');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'sw.js'),'utf8');
function harness(scope='https://example.test/stock-buddy/',overrides={},flowControl=false){
  const handlers={},stores=new Map(),calls=[],deleted=[];
  let activeBodies=0,completedBodies=0;
  const pending=[];
  function pump(){
    while(activeBodies<3 && pending.length){
      const {response,resolve}=pending.shift();activeBodies++;
      let consumed=false;
      const release=()=>{if(!consumed){consumed=true;activeBodies--;completedBodies++;pump();}};
      const wrap=r=>new Proxy(r,{get(target,key){
        if(key==='clone')return ()=>wrap(target.clone());
        if(key==='text'||key==='arrayBuffer')return async()=>{const body=await target[key]();release();return body;};
        const value=target[key];return typeof value==='function'?value.bind(target):value;
      }});
      resolve(wrap(response));
    }
  }
  let fail=false,skip=0,claim=0,reads=0;
  const key=r=>typeof r==='string'?r:r.url;
  const caches={
    async open(name){
      if(!stores.has(name))stores.set(name,new Map());
      const store=stores.get(name);
      return {
        async put(r,response){store.set(key(r),response.clone());},
        async match(r){reads++;return store.get(key(r))?.clone();}
      };
    },
    async keys(){return [...stores.keys()];},
    async delete(name){deleted.push(name);return stores.delete(name);}
  };
  async function network(request,options){
    calls.push({url:key(request),cache:options?.cache||request.cache});
    if(fail)throw new TypeError('offline');
    const url=new URL(key(request));
    const file=url.pathname.endsWith('/')?'index.html':url.pathname.split('/').at(-1);
    const body=Object.hasOwn(overrides,file)?overrides[file]:
      (['index.html','app.js','styles.css','manifest.webmanifest'].includes(file)?fs.readFileSync(path.join(root,file),'utf8'):'network');
    const response=new Response(body,{status:200});
    if(flowControl)return new Promise(resolve=>{pending.push({response,resolve});pump();});
    return response;
  }
  vm.runInNewContext(source,{
    URL,Request,Set,caches,fetch:network,
    self:{registration:{scope},addEventListener:(n,f)=>handlers[n]=f,
      skipWaiting:async()=>{skip++;},clients:{claim:async()=>{claim++;}}}
  });
  return {
    stores,calls,deleted,
    get flowState(){return {activeBodies,completedBodies,queued:pending.length};},
    set offline(v){fail=v;},get skip(){return skip;},get claim(){return claim;},get reads(){return reads;},
    async lifecycle(name){let promise;handlers[name]({waitUntil:p=>promise=p});await promise;},
    async request(url,options={}){
      const request=new Request(url,options);let response;
      handlers.fetch({request,respondWith:p=>response=p});
      return response===undefined?network(request):response;
    },
    async navigate(url){let response;handlers.fetch({request:{url,method:'GET',mode:'navigate',headers:new Headers()},respondWith:p=>response=p});return response;}
  };
}
test('JavaScript syntax, versions and storage contract without Git HEAD dependency',()=>{
  for(const file of ['sw.js','app.js'])cp.execFileSync(process.execPath,['--check',path.join(root,file)]);
  const after=fs.readFileSync(path.join(root,'app.js'),'utf8');
  assert.match(after,/const APP_VERSION='0\.86';/);
  assert.match(after,/const STORAGE_KEY='stockBuddyDataV02';/);
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  assert.match(html,/<script src="app\.js\?v=0\.86"><\/script>/);
  assert.ok(!/localStorage|indexedDB/.test(source));
});
test('only exact static allowlist is saved; root and Pages scopes boot offline',async()=>{
  for(const scope of ['https://example.test/','https://example.test/stock-buddy/']){
    const h=harness(scope);await h.lifecycle('install');await h.lifecycle('activate');
    const store=h.stores.get('stock-buddy-static-v086');assert.equal(store.size,5);
    assert.deepEqual([...store.keys()],['','index.html','styles.css?v=0.75','app.js?v=0.86','manifest.webmanifest'].map(p=>scope+p));
    await h.request(scope+'unknown.js');await h.request('https://external.test/company.csv');
    assert.equal(store.size,5);h.offline=true;
    for(const url of store.keys())assert.equal(await (await h.request(url)).text(),await store.get(url).clone().text());
    store.delete(scope);assert.equal(await (await h.navigate(scope)).text(),fs.readFileSync(path.join(root,'index.html'),'utf8'));
    await assert.rejects(h.request(scope+'unknown.js'));
  }
});
test('APIs and authentication never use cached responses or HTML, including failures',async()=>{
  const h=harness();await h.lifecycle('install');
  const urls=['quotes?symbol=X','history?symbol=X','trade','trade/order','moomoo-analyze','sns-analyze'].map(p=>'https://example.test/stock-buddy/'+p);
  urls.push('https://stock-buddy-ai.toshibou-fishing.workers.dev/anything');
  const store=h.stores.get('stock-buddy-static-v086');
  for(const url of urls)store.set(url,new Response('<html>stale private response</html>'));
  const cases=urls.map(url=>[url,{}]);
  // Header presence triggers exclusion; no real or mock credential value is needed.
  cases.push(['https://example.test/stock-buddy/index.html',{headers:{Authorization:''}}]);
  cases.push(['https://example.test/stock-buddy/app.js?v=0.86',{headers:{'X-Trade-Pin':''}}]);
  cases.push([urls[2]+'/order',{method:'POST',body:'mock'}]);
  for(const [url,options] of cases){
    const reads=h.reads,size=store.size;
    const response=await h.request(url,options);assert.ok(!(await response.text()).includes('stale private response'));
    assert.equal(h.calls.at(-1).cache,'no-store');assert.equal(h.reads,reads);assert.equal(store.size,size);
    h.offline=true;await assert.rejects(h.request(url,options));h.offline=false;
    assert.equal(h.reads,reads);
  }
});
test('successful activation deletes only owned old caches after shell completion',async()=>{
  const h=harness();
  for(const name of ['stock-buddy-v085','stock-buddy-v04','stock-buddy-static-v084','other-app-v1','stock-buddy-unrelated'])h.stores.set(name,new Map());
  await h.lifecycle('install');assert.equal(h.skip,1);assert.equal(h.deleted.length,0);
  await h.lifecycle('activate');assert.equal(h.claim,1);
  assert.deepEqual(h.deleted.sort(),['stock-buddy-static-v084','stock-buddy-v04','stock-buddy-v085']);
  assert.ok(h.stores.has('other-app-v1'));assert.ok(h.stores.has('stock-buddy-unrelated'));
});
test('failed install and incomplete activation keep old offline shell',async()=>{
  const h=harness();const old=new Map([['shell',new Response('old shell')]]);h.stores.set('stock-buddy-v085',old);
  h.offline=true;await assert.rejects(h.lifecycle('install'));assert.equal(h.skip,0);
  await assert.rejects(h.lifecycle('activate'));assert.equal(h.claim,0);
  assert.equal(h.stores.get('stock-buddy-v085'),old);assert.equal(h.deleted.length,0);
});
test('v0.85 HTML with v0.86 JavaScript rejects install without touching old caches',async()=>{
  const oldHtml=fs.readFileSync(path.join(root,'index.html'),'utf8').replaceAll('app.js?v=0.86','app.js?v=0.85');
  const h=harness(undefined,{'index.html':oldHtml});
  const old=new Map([['shell',new Response('old shell')]]);h.stores.set('stock-buddy-v085',old);
  await assert.rejects(h.lifecycle('install'),/HTML version mismatch/);
  assert.equal(h.skip,0);assert.equal(h.stores.get('stock-buddy-v085'),old);
  assert.equal(h.deleted.length,0);assert.ok(!h.stores.has('stock-buddy-static-v086'));
});
test('old JavaScript or HTML returned as JavaScript rejects install',async()=>{
  for(const js of ["const APP_VERSION='0.85';",'<html>error</html>']){
    const h=harness(undefined,{'app.js':js});h.stores.set('stock-buddy-v085',new Map());
    await assert.rejects(h.lifecycle('install'),/JavaScript version mismatch/);
    assert.equal(h.skip,0);assert.ok(h.stores.has('stock-buddy-v085'));assert.equal(h.deleted.length,0);
  }
});
test('unknown APIs, POST and cross-origin no-cors requests use no-store',async()=>{
  const h=harness();await h.lifecycle('install');
  for(const options of [{},{method:'POST',body:'mock'},{mode:'no-cors'}]){
    const reads=h.reads;
    await h.request('https://external.test/unknown-endpoint',options);
    assert.equal(h.calls.at(-1).cache,'no-store');assert.equal(h.reads,reads);
    h.offline=true;await assert.rejects(h.request('https://external.test/unknown-endpoint',options));h.offline=false;
  }
});
test('corrupt shell on activation leaves old and other caches intact',async()=>{
  const h=harness();await h.lifecycle('install');
  h.stores.set('stock-buddy-v085',new Map());h.stores.set('other-app',new Map());
  h.stores.get('stock-buddy-static-v086').set('https://example.test/stock-buddy/index.html',new Response('<script src="app.js?v=0.85"></script>'));
  await assert.rejects(h.lifecycle('activate'),/HTML version mismatch/);
  assert.equal(h.deleted.length,0);assert.equal(h.claim,0);
});
test('install drains response bodies so queued fetches can complete',async()=>{
  // Model the observed Edge behavior: only three unread responses can advance.
  const h=harness(undefined,{},true);
  let timer;
  try{
    await Promise.race([h.lifecycle('install'),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('Unread responses blocked queued fetches')),500);
    })]);
  }finally{clearTimeout(timer);}
  assert.equal(h.flowState.completedBodies,5);
  assert.equal(h.flowState.queued,0);
  assert.equal(h.skip,1);
  assert.equal(h.stores.get('stock-buddy-static-v086').size,5);
  await h.lifecycle('activate');assert.equal(h.claim,1);
});
