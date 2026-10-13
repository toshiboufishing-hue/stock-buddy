const APP_VERSION='0.85';
const STORAGE_KEY='stockBuddyDataV02';
const seed={holdings:[],radar:[],portfolioHistory:[],snsHistory:[],moomooImports:[],tradeHistory:[],settings:{moomooBridgeUrl:''},research:{lastRun:null,lastSummary:null}};
const clone=o=>JSON.parse(JSON.stringify(o));
let data=loadData();
if(!Array.isArray(data.portfolioHistory))data.portfolioHistory=[];
if(!Array.isArray(data.snsHistory))data.snsHistory=[];
if(!Array.isArray(data.moomooImports))data.moomooImports=[];
if(!Array.isArray(data.tradeHistory))data.tradeHistory=[];
if(!data.settings||typeof data.settings!=='object')data.settings={moomooBridgeUrl:''};
(data.holdings||[]).forEach(h=>{if(!Array.isArray(h.history))h.history=[];});

function loadData(){
  const current=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');
  if(current)return current;
  const old=JSON.parse(localStorage.getItem('stockBuddyData')||'null');
  if(old){
    const sampleTickers=new Set(['JP-1001','JP-2002']);
    const migratedHoldings=(old.holdings||[]).filter(h=>!sampleTickers.has(h.ticker)).map(h=>({market:'JP',note:'',...h}));
    return {holdings:migratedHoldings,radar:[],research:{lastRun:null,lastSummary:'v0.1からデータ移行'}};
  }
  return clone(seed);
}

const yen=n=>'¥'+Number(n||0).toLocaleString('ja-JP',{maximumFractionDigits:2});
const money=(n,market)=>market==='US'?'$'+Number(n||0).toLocaleString('en-US',{maximumFractionDigits:2}):yen(n);
const currencyMoney=(n,currency='JPY')=>currency==='USD'?'$'+Number(n||0).toLocaleString('en-US',{maximumFractionDigits:2}):yen(n);
function defaultValuationCurrency(h){return h?.valuationCurrency||(h?.broker==='PayPay証券'?'JPY':((h?.market||'JP')==='US'?'USD':'JPY'));}
function marketQuoteCurrency(market='JP'){return market==='US'?'USD':'JPY';}
const signalMap={buy:['🚀','買い候補','buy'],hold:['🔥','保有継続','hold'],wait:['⚪','様子見','wait'],take:['💰','利確検討','take'],escape:['🚨','売却警戒','escape']};

const productTypeMap={
  auto:'自動判定',stock:'個別株',etf:'ETF',leveraged:'レバレッジETF（順方向）',inverse:'インバースETF（逆方向）',other:'その他'
};
function detectLeverage(name=''){
  const t=String(name).normalize('NFKC').toLowerCase();
  const m=t.match(/(?:ブル|bull|daily|デイリー)?\s*([23])\s*倍|([23])x/);
  if(m)return Number(m[1]||m[2]);
  if(/3倍|ブル3|3x/.test(t))return 3;
  if(/2倍|ブル2|2x/.test(t))return 2;
  return null;
}
function inferProductType(h={}){
  if(h.productType && h.productType!=='auto')return h.productType;
  if(Number(h.leverageFactor)>1)return'leveraged';
  const n=String(h.name||'').normalize('NFKC').toLowerCase();
  if(/インバース|ベア|bear|inverse/.test(n))return'inverse';
  if(/direxion|ブル[23]?倍|[23]倍etf|leveraged|レバレッジ/.test(n))return'leveraged';
  if(/\betf\b|上場投信|上場インデックス/.test(n))return'etf';
  return'stock';
}
function productInfo(h={}){
  const type=inferProductType(h),lev=(Number(h.leverageFactor)>1?Number(h.leverageFactor):detectLeverage(h.name||''));
  let label=productTypeMap[type]||'その他';
  if(type==='leveraged'&&lev)label+=`・${lev}倍`;
  let risk='通常の個別株として管理';
  if(type==='leveraged')risk=`${lev?lev+'倍の ':''}レバレッジETF。日次倍率商品のため長期では指数と単純比例しない点に注意`;
  else if(type==='inverse')risk='インバース系商品。方向性が逆で、長期保有では減価・乖離に注意';
  else if(type==='etf')risk='ETF。構成指数・経費率・連動対象を確認';
  return{type,label,leverage:lev,risk};
}
function refreshProductHint(){
  const el=document.querySelector('#productHint'); if(!el)return;
  const temp={productType:document.querySelector('#productType')?.value||'auto',name:document.querySelector('#name')?.value||''};
  const info=productInfo(temp); const course=document.querySelector('#accountCourse')?.value||'normal';
  const courseLabel=course==='challenge'?'PayPayチャレンジコース':course==='nisa'?'NISA':course==='other'?'その他コース':'通常';
  el.textContent=`コース：${courseLabel}｜商品：${info.label}｜${info.risk}`;
  el.className='product-hint '+((course==='challenge'||info.type==='leveraged'||info.type==='inverse')?'risk':'');
}


// 日本株コード → 銘柄名（無料・キー不要）
// JPXデータを日次更新している公開CSVを1回だけ取得し、端末内にもキャッシュする。
const COMPANY_MASTER_URL='https://te-chan.github.io/JP-CompanyCode/company_list.csv';
const COMPANY_MASTER_CACHE='stockBuddyCompanyMasterV1';
let companyMaster=null;
let companyMasterPromise=null;

function parseCsvLine(line){
  const out=[]; let cur=''; let quoted=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){
      if(quoted && line[i+1]==='"'){cur+='"';i++;}
      else quoted=!quoted;
    }else if(ch===',' && !quoted){out.push(cur);cur='';}
    else cur+=ch;
  }
  out.push(cur); return out;
}
function csvToCompanyMap(text){
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean);
  if(!lines.length)return{};
  const header=parseCsvLine(lines[0]).map(v=>v.trim().toLowerCase());
  const codeIndex=header.indexOf('code'),nameIndex=header.indexOf('name');
  if(codeIndex<0||nameIndex<0)return{};
  const map={};
  for(const line of lines.slice(1)){
    const cols=parseCsvLine(line),code=(cols[codeIndex]||'').trim().toUpperCase(),name=(cols[nameIndex]||'').trim();
    if(code&&name)map[code]=name;
  }
  return map;
}
async function loadCompanyMaster(){
  if(companyMaster)return companyMaster;
  if(companyMasterPromise)return companyMasterPromise;
  companyMasterPromise=(async()=>{
    try{
      const res=await fetch(COMPANY_MASTER_URL,{cache:'no-store'});
      if(!res.ok)throw new Error('company master fetch failed');
      const map=csvToCompanyMap(await res.text());
      if(!Object.keys(map).length)throw new Error('company master empty');
      companyMaster=map;
      try{localStorage.setItem(COMPANY_MASTER_CACHE,JSON.stringify({savedAt:Date.now(),map}));}catch(e){}
      return map;
    }catch(e){
      try{
        const cached=JSON.parse(localStorage.getItem(COMPANY_MASTER_CACHE)||'null');
        if(cached?.map){companyMaster=cached.map;return companyMaster;}
      }catch(_){}
      // 最低限、登録済み銘柄はネット不調時でも補完できる。
      companyMaster={'7011':'三菱重工業','5016':'JX金属'};
      return companyMaster;
    }
  })();
  return companyMasterPromise;
}
async function autofillCompanyName(tickerInput,nameInput,marketSelect){
  if((marketSelect?.value||'JP')!=='JP')return;
  const code=tickerInput.value.trim().normalize('NFKC').toUpperCase();
  if(!/^(?:\d{4}|\d{3}[A-Z])$/.test(code))return;
  tickerInput.value=code;
  const map=await loadCompanyMaster();
  const found=map[code];
  if(found)nameInput.value=found;
}
function setupCompanyLookup(tickerId,nameId,marketId){
  const ticker=document.querySelector(tickerId),name=document.querySelector(nameId),market=document.querySelector(marketId);
  if(!ticker||!name||!market)return;
  let timer;
  const run=()=>autofillCompanyName(ticker,name,market);
  ticker.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(run,350);});
  ticker.addEventListener('blur',run);
  market.addEventListener('change',run);
}




// v0.59: 市場データの鮮度管理（自動株価取得の受け皿）
function isoNow(){return new Date().toISOString();}
// v0.85: quoteUpdatedAt is the market quote time, not the HTTP retrieval time.
// Legacy moomoo entries and screenshot imports have no verified exchange timestamp.
function quoteMeta(h={}){
  const source=h.quoteSource||'manual';
  const failed=h.quoteStatus==='failed';
  const isMoomoo=source==='moomoo';
  const capturedAt=isMoomoo?h.quoteCapturedAt||null:null;
  const verified=isMoomoo?h.quoteTimeVerified===true:true;
  const at=verified?(h.quoteUpdatedAt||h.updatedAt||(Array.isArray(h.history)&&h.history.length?h.history[h.history.length-1].at:null)):null;
  const ageMs=at?Date.now()-Date.parse(at):NaN;
  const ageMin=ageMs/60000;
  let level='yellow',label='手入力';
  if(failed){level='red';label='取得失敗';}
  else if(!verified || (isMoomoo&&!Number.isFinite(ageMs))){label='時刻未確認';}
  else if(isMoomoo&&h.market==='US'&&!usRegularMarketState().isOpen){label='時間外・休場';}
  else if(source!=='manual'&&Number.isFinite(ageMin)&&ageMin>=-1&&ageMin<=5){level='green';label='更新5分以内';}
  else if(source!=='manual'&&Number.isFinite(ageMin)&&ageMin>=-1&&ageMin<=30){label='遅延';}
  else if(source!=='manual'){level='red';label='古い';}
  else if(source==='manual'&&ageMin>1440){level='red';label='手入力・古い';}
  return {at,source,level,label,ageMin,capturedAt};
}
function formatQuoteTime(iso){
  if(!iso)return'時刻なし';
  const d=new Date(iso);if(Number.isNaN(d.getTime()))return'時刻不明';
  return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function quoteSourceLabel(source){return ({manual:'手入力',market:'市場データ',moomoo:'moomoo',tachibana:'立花API',finnhub:'Finnhub'})[source]||String(source||'データ');}
function applyMarketQuote(ticker,market,quote={}){
  const h=data.holdings.find(x=>String(x.ticker).toUpperCase()===String(ticker).toUpperCase() && (x.market||'JP')===(market||'JP'));
  if(!h)return false;
  const price=Number(quote.price);
  if(!(price>=0) || !(h.qty>=0))return false;
  h.quotePrice=price;
  h.quoteCurrency=quote.currency||marketQuoteCurrency(market);
  // 市場株価と証券会社の評価額は別物。通貨が同じ場合だけ評価額を自動更新する。
  if(defaultValuationCurrency(h)===h.quoteCurrency)h.value=price*(+h.qty||0);
  h.quoteUpdatedAt=quote.at||isoNow();
  h.quoteSource=quote.source||'market';
  h.quoteStatus='ok';
  h.updatedAt=h.quoteUpdatedAt;
  appendHoldingHistory(h);appendPortfolioHistory();save();render();return true;
}
function markQuoteFailed(ticker,market){
  const h=data.holdings.find(x=>String(x.ticker).toUpperCase()===String(ticker).toUpperCase() && (x.market||'JP')===(market||'JP'));
  if(!h)return false;h.quoteStatus='failed';save();render();return true;
}
window.StockBuddyMarket={applyMarketQuote,markQuoteFailed};

// v0.81: authenticated read-only Worker relay. PIN is kept in memory only.
const MOOMOO_WORKER='https://stock-buddy-ai.toshibou-fishing.workers.dev';
let moomooReadPin='';
function normalizeBridgeUrl(raw=''){
  let u=String(raw||'').trim().replace(/\/+$/,'');
  if(!u)return '';
  if(!/\/quotes(?:\?|$)/i.test(u))u+='/quotes';
  return u;
}
function savedMoomooBridgeUrl(){return normalizeBridgeUrl(data.settings?.moomooBridgeUrl||'');}
function isLocalApp(){return location.hostname==='127.0.0.1'||location.hostname==='localhost';}
function getMoomooReadPin(){
  const typed=String(document.querySelector('#tradePin')?.value||'').trim();
  if(typed){moomooReadPin=typed;return typed;}
  if(moomooReadPin)return moomooReadPin;
  const entered=window.prompt('moomoo接続用PIN（Cloudflare TRADE_PIN）を入力してください。保存されません。');
  if(!entered)throw new Error('PIN入力をキャンセルしました');
  moomooReadPin=entered.trim();return moomooReadPin;
}
async function moomooReadFetch(path){
  const pin=getMoomooReadPin();
  const res=await fetch(MOOMOO_WORKER+path,{cache:'no-store',headers:{'X-Trade-Pin':pin}});
  const payload=await res.json().catch(()=>({}));
  if(res.status===401){moomooReadPin='';throw new Error('認証エラー：PINまたはWorker設定を確認してください');}
  if(!res.ok||payload?.ok===false)throw new Error(payload?.error||`moomoo relay HTTP ${res.status}`);
  return payload;
}
async function refreshMoomooLocalQuotes(){
  const usTickers=[...new Set([...(data.holdings||[]),...(data.radar||[])].map(x=>normalizeTicker(x.ticker)).filter(t=>isUsStyleTicker(t)))];
  if(!usTickers.length)return {ok:true,quotes:[],holdingsUpdated:0,radarUpdated:0};
  const payload=await moomooReadFetch('/quotes');
  if(!Array.isArray(payload.quotes))throw new Error('moomoo quotes response error');
  const wanted=new Set(usTickers);
  const quotes=payload.quotes.filter(q=>wanted.has(normalizeTicker(q.ticker||String(q.code||'').replace(/^US\./i,'')))).map(q=>({
    ticker:normalizeTicker(q.ticker||String(q.code||'').replace(/^US\./i,'')),
    name:q.name||'',market:'US',price:Number(q.price),currency:q.currency||'USD',
    changePercent:Number(q.changePercent),leverage:paypayCourseInfo(q.ticker)?.leverage||1,
    direction:paypayCourseInfo(q.ticker)?.direction||'normal',productType:'',confidence:100,
    quoteTimeUtc:q.quoteTimeUtc||null,updateTime:q.updateTime||null
  }));
  const applied=applyMoomooQuotes(quotes,payload.capturedAt||isoNow(),{source:'opend'});
  applied.bridge={source:'worker'};return applied;
}
window.StockBuddyMoomoo={refresh:refreshMoomooLocalQuotes};
async function showMoomooPriceHistory(ticker){
  const status=document.querySelector('#moomooPriceHistoryStatus');
  const chart=document.querySelector('#moomooPriceHistoryChart');
  if(!status||!chart)return;
  const symbol=normalizeTicker(ticker).replace(/^US\./,'');
  if(!['SPXL','AMZU'].includes(symbol)){
    status.textContent='現在、moomoo過去株価はSPXL・AMZUのみ対応しています。';chart.innerHTML='';return;
  }
  status.textContent='🟡 moomoo過去株価を取得中…';chart.innerHTML='';
  try{
    const payload=await moomooReadFetch('/history?symbol='+encodeURIComponent(symbol));
    const bars=Array.isArray(payload.bars)?payload.bars:[];
    const points=bars.filter(b=>Number.isFinite(Number(b.close))&&/^\d{4}-\d{2}-\d{2}$/.test(b.date||'')).map(b=>({at:b.date+'T12:00:00',close:Number(b.close)}));
    if(!points.length)throw new Error('株価履歴がありません');
    renderLineChart(chart,points,[{key:'close'}]);
    const ind=payload.indicators||{};
    const fmt=n=>Number.isFinite(Number(n))?Number(n).toFixed(2):'—';
    status.textContent=`${symbol}：${points.length}営業日 / 終値 $${fmt(points.at(-1).close)} / 5日平均 $${fmt(ind.sma5)} / 20日平均 $${fmt(ind.sma20)}（moomoo・調整後株価）`;
  }catch(e){status.textContent='🔴 '+String(e?.message||e).slice(0,160);}
}

function historyPoint(value, market='JP'){
  return {at:new Date().toISOString(),value:+value||0,market};
}
function appendHoldingHistory(h){
  if(!Array.isArray(h.history))h.history=[];
  const value=holdingValue(h),last=h.history[h.history.length-1];
  if(!last || +last.value!==+value)h.history.push(historyPoint(value,h.market||'JP'));
  if(h.history.length>500)h.history=h.history.slice(-500);
}
function portfolioSnapshot(){
  let jp=0,us=0;
  data.holdings.forEach(h=>{const v=holdingValue(h);if(h.market==='US'&&h.broker!=='PayPay証券')us+=v;else jp+=v;});
  return {at:new Date().toISOString(),jp,us};
}
function appendPortfolioHistory(){
  if(!Array.isArray(data.portfolioHistory))data.portfolioHistory=[];
if(!Array.isArray(data.snsHistory))data.snsHistory=[];
  const point=portfolioSnapshot(),last=data.portfolioHistory[data.portfolioHistory.length-1];
  if(!last || +last.jp!==+point.jp || +last.us!==+point.us)data.portfolioHistory.push(point);
  if(data.portfolioHistory.length>500)data.portfolioHistory=data.portfolioHistory.slice(-500);
}
function ensureInitialHistory(){
  let changed=false;
  data.holdings.forEach(h=>{if(!Array.isArray(h.history))h.history=[];if(!h.history.length){h.history.push(historyPoint(holdingValue(h),h.market||'JP'));changed=true;}});
  if(!Array.isArray(data.portfolioHistory))data.portfolioHistory=[];
if(!Array.isArray(data.snsHistory))data.snsHistory=[];
  if(!data.portfolioHistory.length && data.holdings.length){data.portfolioHistory.push(portfolioSnapshot());changed=true;}
  if(changed)save();
}
function chartDate(iso){const d=new Date(iso);return `${d.getMonth()+1}/${d.getDate()}`;}
function renderLineChart(el,points,seriesDefs){
  if(!el)return;
  if(!points.length){el.innerHTML='';return;}
  const W=640,H=220,pad={l:44,r:16,t:16,b:30};
  const vals=[];seriesDefs.forEach(sd=>points.forEach(p=>{const v=+p[sd.key];if(Number.isFinite(v))vals.push(v);}));
  if(!vals.length){el.innerHTML='';return;}
  let min=Math.min(...vals),max=Math.max(...vals); if(min===max){min=Math.max(0,min*.95);max=max*1.05+1;}
  const span=max-min||1, n=Math.max(points.length-1,1);
  const x=i=>pad.l+(W-pad.l-pad.r)*(i/n), y=v=>pad.t+(H-pad.t-pad.b)*(1-(v-min)/span);
  const grid=[0,.25,.5,.75,1].map(t=>{const yy=pad.t+(H-pad.t-pad.b)*t;const val=max-span*t;return `<line x1="${pad.l}" y1="${yy}" x2="${W-pad.r}" y2="${yy}" class="chart-grid"/><text x="${pad.l-6}" y="${yy+4}" class="chart-label" text-anchor="end">${Math.round(val).toLocaleString()}</text>`}).join('');
  const lines=seriesDefs.map((sd,si)=>{const pts=points.map((p,i)=>`${x(i)},${y(+p[sd.key]||0)}`).join(' ');return `<polyline points="${pts}" class="chart-line chart-line-${si}" fill="none"/><circle cx="${x(points.length-1)}" cy="${y(+points[points.length-1][sd.key]||0)}" r="4" class="chart-dot chart-dot-${si}"/>`;}).join('');
  const first=chartDate(points[0].at),last=chartDate(points[points.length-1].at);
  el.innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="評価額推移グラフ">${grid}${lines}<text x="${pad.l}" y="${H-7}" class="chart-label">${first}</text><text x="${W-pad.r}" y="${H-7}" class="chart-label" text-anchor="end">${last}</text></svg>`;
}
function renderPortfolioHistory(){
  const points=data.portfolioHistory||[],chart=document.querySelector('#portfolioChart'),empty=document.querySelector('#portfolioHistoryEmpty'),count=document.querySelector('#portfolioHistoryCount');
  if(count)count.textContent=`${points.length}点`;
  if(empty)empty.hidden=points.length>0;
  const hasUS=points.some(p=>+p.us>0);
  renderLineChart(chart,points,hasUS?[{key:'jp'},{key:'us'}]:[{key:'jp'}]);
}
function openHoldingHistory(i){
  const h=data.holdings[i];if(!h)return;
  document.querySelector('#historyTitle').textContent=`${h.name}（${h.ticker}）`;
  const points=h.history||[],empty=document.querySelector('#holdingHistoryEmpty');empty.hidden=points.length>0;
  const current=holdingValue(h),first=points.length?+points[0].value:current,change=current-first,pct=first?change/first*100:0;
  document.querySelector('#holdingHistoryMeta').innerHTML=`<span>現在 <b>${currencyMoney(current,defaultValuationCurrency(h))}</b></span><span>記録開始比 <b class="${change>=0?'positive':'negative'}">${change>=0?'+':''}${currencyMoney(change,defaultValuationCurrency(h))} (${pct>=0?'+':''}${pct.toFixed(1)}%)</b></span><span>${points.length}点</span>`;
  renderLineChart(document.querySelector('#holdingHistoryChart'),points.map(p=>({at:p.at,value:p.value})),[{key:'value'}]);
  const moomooStatus=document.querySelector('#moomooPriceHistoryStatus');
  if(moomooStatus)moomooStatus.textContent='';
  const moomooChart=document.querySelector('#moomooPriceHistoryChart');
  if(moomooChart)moomooChart.innerHTML='';
  const moomooBtn=document.querySelector('#loadMoomooPriceHistory');
  if(moomooBtn){moomooBtn.hidden=!['SPXL','AMZU'].includes(normalizeTicker(h.ticker).replace(/^US\./,''));moomooBtn.onclick=()=>showMoomooPriceHistory(h.ticker);}
  document.querySelector('#historyDialog').showModal();
}

function save(){localStorage.setItem(STORAGE_KEY,JSON.stringify(data));}
function esc(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function holdingValue(h){return Number.isFinite(+h.value)?+h.value:(+h.qty||0)*(+h.price||0);}
function holdingCost(h){return Number.isFinite(+h.costBasis)?+h.costBasis:((+h.qty||0)*(+h.avg||0)||null);}
function deriveSignal(h){
  const value=holdingValue(h),cost=holdingCost(h);
  if(!cost)return'wait';
  const pnl=(value-cost)/cost*100;
  if(pnl<=-15)return'escape';
  if(pnl>=25)return'take';
  if(pnl>=8)return'hold';
  return'wait';
}
function signalReason(h){
  const value=holdingValue(h),cost=holdingCost(h);
  if(!cost)return'取得総額未登録。最新情報を優先して確認';
  const pct=(value-cost)/cost*100;
  if(pct<=-15)return'取得単価から15%以上下落。材料確認を優先';
  if(pct>=25)return'取得単価から25%以上上昇。利確条件を再確認';
  if(pct>=8)return'含み益圏。材料が崩れていないか確認';
  return'損益だけでは強い判断材料なし。最新情報待ち';
}
function render(){renderHoldings();renderRadar();renderTotals();renderPortfolioHistory();renderSnsHistory();}
function holdingPriority(h){
  // 将来の外部AI結果が入ったら最優先で使用。現状はローカル損益判定を安全な暫定値として使う。
  if(h.aiImportant===true)return 1000+(Number(h.aiPriority)||0);
  const sig=deriveSignal(h);
  return ({escape:900,take:700,buy:600,hold:400,wait:100})[sig]||0;
}
function directionInfo(h,signal){
  // aiDirection: up/down/volatile/flat を外部AI連携時に保存できる設計。
  const d=h.aiDirection;
  if(d==='up')return['⬆️','上昇方向','up'];
  if(d==='down')return['⬇️','下落方向','down'];
  if(d==='volatile')return['↕️','乱高下警戒','volatile'];
  if(d==='flat')return['➡️','方向不明','flat'];
  // 無料ローカル版では未来予測を捏造しない。現在の損益状態を矢印で直感表示する。
  if(signal==='escape')return['⬇️','下落警戒','down'];
  if(signal==='take'||signal==='hold')return['⬆️','上昇中','up'];
  return['➡️','方向不明','flat'];
}
function renderHoldings(){
  const list=document.querySelector('#holdingsList');list.innerHTML='';
  if(!data.holdings.length){list.innerHTML='<article class="card empty-card"><strong>まだ保有株がありません</strong>「＋追加」から実際の保有銘柄を登録すると、次回起動時から自動で調査対象になります。</article>';return;}
  const ordered=data.holdings.map((h,i)=>({h,i,priority:holdingPriority(h)})).sort((a,b)=>b.priority-a.priority||a.i-b.i);
  ordered.forEach(({h,i,priority})=>{
    const signal=deriveSignal(h),s=signalMap[signal];
    const value=holdingValue(h),cost=holdingCost(h),pnl=cost!=null?value-cost:null,pct=cost?pnl/cost*100:null;
    const important=h.aiImportant===true||signal==='escape';
    const dir=directionInfo(h,signal);
    const el=document.createElement('article');el.className=`card holding compact-holding ${important?'important-holding':''}`;el.dataset.index=i;
    const pinfo=productInfo(h);
    const reason=signalReason(h);
    const qm=quoteMeta(h);
    el.innerHTML=`${important?'<div class="priority-banner">🚨 最重要・強制トップ</div>':''}<div class="compact-top"><div class="holding-main"><div class="name">${esc(h.name)}</div><div class="sub">${esc(h.broker)}・${h.market==='US'?'米国':'日本'}・${esc(h.ticker)}${Number.isFinite(+h.quotePrice)?`・現在値 ${currencyMoney(+h.quotePrice,h.quoteCurrency||marketQuoteCurrency(h.market))}`:''}</div></div><div class="holding-money"><div class="price">${currencyMoney(value,defaultValuationCurrency(h))}</div><div class="sub ${pnl==null?'':(pnl>=0?'positive':'negative')}">${pnl==null?'損益未登録':`${pnl>=0?'+':''}${currencyMoney(pnl,defaultValuationCurrency(h))} (${pct>=0?'+':''}${pct.toFixed(1)}%)`}</div></div></div><div class="quote-freshness ${qm.level}"><span class="fresh-dot"></span><b>${qm.label}</b><span>${formatQuoteTime(qm.at)}</span><small>${quoteSourceLabel(qm.source)}${qm.capturedAt?'・受信 '+formatQuoteTime(qm.capturedAt):''}</small></div>${Number.isFinite(+h.referenceMovePct)&&Number.isFinite(+h.estimatedDailyMovePct)?`<div class="challenge-reference">📊 ${esc(h.underlyingLabel||h.referenceName||'原資産')} ${+h.referenceMovePct>=0?'+':''}${(+h.referenceMovePct).toFixed(2)}% → <b>${esc(h.ticker)} 日次目安 ${+h.estimatedDailyMovePct>=0?'+':''}${(+h.estimatedDailyMovePct).toFixed(2)}%</b><small>moomoo ${formatQuoteTime(h.referenceUpdatedAt)}・単純倍率目安</small></div>`:''}<div class="compact-status"><span class="direction ${dir[2]}"><b>${dir[0]}</b> ${dir[1]}</span><span class="signal ${s[2]}">${s[0]} ${s[1]}</span></div><div class="ai-comment ${important?'critical':''}"><span class="ai-label">AIコメント</span><strong>${esc(reason)}</strong></div><div class="compact-foot"><div class="product-tags">${h.accountCourse==='challenge'?`<span class="product-tag special">${esc(h.accountCourseLabel||'PayPayチャレンジ')}</span>`:''}<span class="product-tag ${['leveraged','inverse'].includes(pinfo.type)?'special':''}">${esc(pinfo.label)}</span></div><div class="card-actions"><button class="mini-btn history-holding" data-index="${i}">📈</button><button class="mini-btn edit-holding" data-index="${i}">編集</button><button class="mini-btn delete delete-holding" data-index="${i}">削除</button></div></div>`;
    list.appendChild(el);
  });
  document.querySelectorAll('.history-holding').forEach(b=>b.onclick=e=>{e.stopPropagation();openHoldingHistory(+b.dataset.index)});
  document.querySelectorAll('.holding').forEach(card=>card.onclick=e=>{if(e.target.closest('button'))return;openHoldingHistory(+card.dataset.index)});
  document.querySelectorAll('.edit-holding').forEach(b=>b.onclick=()=>openHoldingEdit(+b.dataset.index));
  document.querySelectorAll('.delete-holding').forEach(b=>b.onclick=()=>deleteHolding(+b.dataset.index));
}
function renderRadar(){
  const list=document.querySelector('#radarList');list.innerHTML='';
  if(!data.radar.length){list.innerHTML='<article class="card empty-card"><strong>監視銘柄はまだありません</strong>「ちょっと気になる」を先に入れておく場所。起動時調査の対象に含まれます。</article>';return;}
  data.radar.forEach((r,i)=>{const el=document.createElement('article');el.className='card radar-item';el.innerHTML=`<div class="row"><div><div class="name">${esc(r.name)}</div><div class="sub">${r.market==='US'?'米国':'日本'}・${esc(r.ticker)}</div></div><div class="price">${r.price?money(r.price,r.market):'—'}</div></div><div class="signal wait">👀 監視中</div><p class="bullet">${r.reason?esc(r.reason):'理由未入力。最新材料・出来高・注目度を確認対象にします。'}</p><div class="card-actions"><button class="mini-btn delete delete-watch" data-index="${i}">削除</button></div>`;list.appendChild(el)});
  document.querySelectorAll('.delete-watch').forEach(b=>b.onclick=()=>{if(confirm('この監視銘柄を削除しますか？')){data.radar.splice(+b.dataset.index,1);save();render();runStartupResearch();}});
}
function renderTotals(){
  let jpyValue=0,jpyCost=0,usdValue=0,usdCost=0,jpyCostKnown=true,usdCostKnown=true;
  data.holdings.forEach(h=>{const value=holdingValue(h),cost=holdingCost(h),cur=defaultValuationCurrency(h);if(cur==='USD'){usdValue+=value;if(cost==null)usdCostKnown=false;else usdCost+=cost}else{jpyValue+=value;if(cost==null)jpyCostKnown=false;else jpyCost+=cost}});
  const total=document.querySelector('#totalValue');
  total.textContent=usdValue?`${yen(jpyValue)} + $${usdValue.toLocaleString('en-US',{maximumFractionDigits:2})}`:yen(jpyValue);
  const pnlJPY=jpyCostKnown?jpyValue-jpyCost:null,pctJPY=(jpyCostKnown&&jpyCost)?pnlJPY/jpyCost*100:null;
  const t=document.querySelector('#totalPnl');
  t.textContent=usdValue?`円評価 ${pnlJPY==null?'損益未登録':`${pnlJPY>=0?'+':''}${yen(pnlJPY)}`} / USD評価 ${usdCostKnown?`${usdValue-usdCost>=0?'+':''}$${(usdValue-usdCost).toFixed(2)}`:'損益未登録'}`:(pnlJPY==null?'損益未登録':`${pnlJPY>=0?'+':''}${yen(pnlJPY)}（${pctJPY==null?'—':`${pctJPY>=0?'+':''}${pctJPY.toFixed(1)}%`}）`);
  t.className='pnl '+(pnlJPY==null?'':(pnlJPY>=0?'positive':'negative'));
  const sigs=data.holdings.map(deriveSignal);
  document.querySelector('#overallSignal').textContent=!sigs.length?'未判定':sigs.includes('escape')?'要確認':sigs.includes('take')?'利確確認':sigs.includes('hold')?'保有確認':'様子見';
}

function switchTab(id){document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id===id));document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===id));scrollTo({top:0,behavior:'smooth'});}
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));
setupCompanyLookup('#ticker','#name','#market');
setupCompanyLookup('#watchTicker','#watchName','#watchMarket');
document.querySelector('#name')?.addEventListener('input',refreshProductHint);
document.querySelector('#productType')?.addEventListener('change',refreshProductHint);
document.querySelector('#accountCourse')?.addEventListener('change',refreshProductHint);

const holdingDialog=document.querySelector('#holdingDialog');
document.querySelector('#addHoldingBtn').onclick=()=>{document.querySelector('#holdingForm').reset();document.querySelector('#holdingEditIndex').value='';document.querySelector('#holdingDialogTitle').textContent='保有株を追加';document.querySelector('#productType').value='auto';document.querySelector('#accountCourse').value='normal';document.querySelector('#valuationCurrency').value='JPY';refreshProductHint();holdingDialog.showModal();};
function openHoldingEdit(i){const h=data.holdings[i];document.querySelector('#holdingEditIndex').value=i;document.querySelector('#holdingDialogTitle').textContent='保有株を編集';document.querySelector('#broker').value=h.broker;document.querySelector('#market').value=h.market||'JP';document.querySelector('#name').value=h.name;document.querySelector('#ticker').value=h.ticker;document.querySelector('#qty').value=h.qty;document.querySelector('#holdingValue').value=holdingValue(h);const editCost=holdingCost(h);document.querySelector('#holdingPnl').value=editCost==null?'':holdingValue(h)-editCost;document.querySelector('#valuationCurrency').value=defaultValuationCurrency(h);document.querySelector('#holdingNote').value=h.note||'';let pt=h.productType||'auto';let course=h.accountCourse||'normal';if(pt==='challenge'){course='challenge';pt='auto';}document.querySelector('#productType').value=pt;document.querySelector('#accountCourse').value=course;refreshProductHint();holdingDialog.showModal();}
function deleteHolding(i){if(confirm(`${data.holdings[i].name} を削除しますか？`)){data.holdings.splice(i,1);appendPortfolioHistory();save();render();runStartupResearch();}}
document.querySelector('#cancelHolding').onclick=()=>holdingDialog.close();
document.querySelector('#closeHistory').onclick=()=>document.querySelector('#historyDialog').close();
document.querySelector('#saveHolding').onclick=()=>{
  const form=document.querySelector('#holdingForm');
  if(!form.reportValidity()) return;
  const idx=document.querySelector('#holdingEditIndex').value;
  const prev=idx===''?{}:data.holdings[+idx];
  const value=+document.querySelector('#holdingValue').value;
  const pnl=parseQuickNumber(document.querySelector('#holdingPnl').value);
  if(pnl==null){alert('評価損益を数字で入力してください。マイナスは「-」でも「－」でもOKです。');return;}
  const costBasis=value-pnl;
  if(costBasis<0){alert('評価損益の値を確認してください。取得総額がマイナスになっています。');return;}
  const h={...prev,broker:document.querySelector('#broker').value,market:document.querySelector('#market').value,name:document.querySelector('#name').value.trim(),ticker:document.querySelector('#ticker').value.trim().toUpperCase(),accountCourse:document.querySelector('#accountCourse').value,productType:document.querySelector('#productType').value,qty:+document.querySelector('#qty').value,value,costBasis,valuationCurrency:document.querySelector('#valuationCurrency').value,note:document.querySelector('#holdingNote').value.trim(),updatedAt:new Date().toISOString(),quoteUpdatedAt:new Date().toISOString(),quoteSource:'manual',quoteStatus:'ok'};
  delete h.avg; delete h.price;
  appendHoldingHistory(h);
  if(idx==='') data.holdings.push(h); else data.holdings[+idx]=h;
  appendPortfolioHistory();
  save(); render(); holdingDialog.close(); runStartupResearch();
};
document.querySelector('#holdingForm').addEventListener('submit',e=>e.preventDefault());

const watchDialog=document.querySelector('#watchDialog');document.querySelector('#addWatchBtn').onclick=()=>{document.querySelector('#watchForm').reset();watchDialog.showModal();};
document.querySelector('#watchForm').addEventListener('submit',e=>{if(e.submitter?.value==='cancel')return;e.preventDefault();data.radar.push({market:document.querySelector('#watchMarket').value,name:document.querySelector('#watchName').value.trim(),ticker:document.querySelector('#watchTicker').value.trim().toUpperCase(),price:+document.querySelector('#watchPrice').value||0,reason:document.querySelector('#watchReason').value.trim(),addedAt:new Date().toISOString()});save();render();watchDialog.close();runStartupResearch();});

function buildResearchPrompt(){
  const holdings=data.holdings.map(h=>{const p=productInfo(h);return `- [保有] ${h.market} ${h.ticker} ${h.name} / ${h.broker} / コース:${h.accountCourse==='challenge'?'PayPayチャレンジ':h.accountCourse==='nisa'?'NISA':'通常'} / 商品:${p.label} / 数量 ${h.qty} / 評価額 ${holdingValue(h)} ${defaultValuationCurrency(h)} / 市場株価通貨:${marketQuoteCurrency(h.market)} / データ時刻:${formatQuoteTime(quoteMeta(h).at)} / データ状態:${quoteMeta(h).label}${h.note?` / メモ: ${h.note}`:''}`}).join('\n');
  const watch=data.radar.map(r=>`- [監視] ${r.market} ${r.ticker} ${r.name}${r.price?` / 現在 ${r.price}`:''}${r.reason?` / 理由: ${r.reason}`:''}`).join('\n');
  return `相棒STOCK 起動時調査。以下の銘柄について、現在時点の最新情報をWebで調査してください。株価・出来高/売買代金・適時開示/IR・決算・ニュース・地政学/政策・SNSの注目変化を確認し、情報の鮮度と資金流入を重視してください。煽り投稿は必ず一次情報で裏取りしてください。レバレッジETF・インバースETF・PayPayチャレンジコースは普通株と同じロジックで評価せず、日次倍率・ボラティリティ・長期保有時の乖離/減価・対象指数/原資産を別途確認してください。各銘柄を 🚀買い候補 / 🔥保有継続 / ⚪待ち / 💰利確検討 / 🚨売却警戒 の5段階で、根拠・否定材料・次に見る条件とともに簡潔に判定してください。\n\n${holdings||'- 保有株なし'}\n${watch||'- 監視株なし'}`;
}
async function shareResearchPrompt(){
  const text=buildResearchPrompt();
  try{if(navigator.share){await navigator.share({title:'相棒STOCK AI調査',text});return;}await navigator.clipboard.writeText(text);alert('AI調査文をコピーしました');}catch(err){if(err?.name!=='AbortError'){prompt('この調査文をコピーしてAIに渡してください',text);}}
}

let researchTimer=null;
function runStartupResearch(){
  if(researchTimer)clearInterval(researchTimer);
  const status=document.querySelector('#researchStatus'),detail=document.querySelector('#researchDetail'),progress=document.querySelector('#researchProgress'),badge=document.querySelector('#researchBadge');
  const targets=[...data.holdings.map(x=>({type:'保有',...x})),...data.radar.map(x=>({type:'監視',...x}))];
  let step=0;
  const stages=targets.length?[
    ['登録銘柄を確認中',15],
    [`調査対象 ${targets.length}銘柄を整理中`,35],
    ['前回からの変化を確認する準備中',55],
    ['損益・警戒ラインを仮判定中',75],
    ['外部AI調査用の指示文を生成中',90],
    ['起動時チェック完了',100]
  ]:[['登録銘柄を確認中',40],['調査対象なし',100]];
  badge.className='tag wait';badge.textContent='調査中';status.textContent='AI調査スタート';progress.style.width='3%';detail.textContent='起動を検知しました';
  const tick=()=>{const [msg,pct]=stages[step];detail.textContent=msg;progress.style.width=pct+'%';step++;if(step>=stages.length){clearInterval(researchTimer);researchTimer=null;const now=new Date();data.research={lastRun:now.toISOString(),lastSummary:targets.length?`${targets.length}銘柄の調査準備完了`:'登録銘柄なし'};save();status.textContent=targets.length?`${targets.length}銘柄をチェック対象に設定`:'銘柄登録待ち';badge.className='tag ok';badge.textContent='完了';detail.textContent=targets.length?'無料モード：損益チェック＋外部AI調査文の生成まで完了。ニュース/IRの自動取得は次段階。':'保有株または監視銘柄を追加すると起動時調査が動きます。';}};
  tick();researchTimer=setInterval(tick,320);
}

document.querySelector('#rerunResearchBtn').onclick=runStartupResearch;
document.querySelector('#shareResearchBtn').onclick=shareResearchPrompt;


// v0.67: moomooスクショから株価をAI読込
const MOOMOO_AI_ENDPOINT='https://stock-buddy-ai.toshibou-fishing.workers.dev/moomoo-analyze';
let moomooImageFile=null;
let moomooImageUrl=null;
const moomooImageInput=document.querySelector('#moomooImageInput');
const selectMoomooImageBtn=document.querySelector('#selectMoomooImageBtn');
const analyzeMoomooImageBtn=document.querySelector('#analyzeMoomooImageBtn');
const moomooImagePreview=document.querySelector('#moomooImagePreview');
const moomooImportStatus=document.querySelector('#moomooImportStatus');
const moomooImportResult=document.querySelector('#moomooImportResult');

function resetMoomooPreview(){
  if(moomooImageUrl){URL.revokeObjectURL(moomooImageUrl);moomooImageUrl=null;}
  moomooImageFile=null;
  moomooImageInput.value='';
  moomooImagePreview.className='sns-image-preview empty';
  moomooImagePreview.innerHTML='<span>まだ画像が選ばれていません</span>';
  analyzeMoomooImageBtn.disabled=true;
  moomooImportStatus.textContent='スクショを選ぶ → 株価をAI読込、だけでOKです。';
}
function normalizeTicker(t=''){return String(t).trim().toUpperCase().replace(/[^0-9A-Z.\-]/g,'');}
const PAYPAY_COURSE_TICKERS={
  SPXL:{leverage:3,direction:'bull',course:'challenge',courseLabel:'チャレンジコース',underlying:'S&P500'},
  SPXS:{leverage:3,direction:'bear',course:'challenge',courseLabel:'逆チャレンジコース',underlying:'S&P500'},
  TQQQ:{leverage:3,direction:'bull',course:'challenge',courseLabel:'テクノロジーチャレンジコース',underlying:'NASDAQ100'},
  SQQQ:{leverage:3,direction:'bear',course:'challenge',courseLabel:'テクノロジー逆チャレンジコース',underlying:'NASDAQ100'},
  SOXL:{leverage:3,direction:'bull',course:'challenge',courseLabel:'半導体チャレンジコース',underlying:'半導体指数'},
  SOXS:{leverage:3,direction:'bear',course:'challenge',courseLabel:'半導体逆チャレンジコース',underlying:'半導体指数'},
  AAPU:{leverage:2,direction:'bull',course:'challenge',courseLabel:'Appleチャレンジコース',underlying:'Apple'},
  AAPD:{leverage:1,direction:'bear',course:'challenge',courseLabel:'Apple逆連動コース',underlying:'Apple'},
  AMZU:{leverage:2,direction:'bull',course:'challenge',courseLabel:'Amazonチャレンジコース',underlying:'Amazon'},
  AMZD:{leverage:1,direction:'bear',course:'challenge',courseLabel:'Amazon逆連動コース',underlying:'Amazon'},
  GGLL:{leverage:2,direction:'bull',course:'challenge',courseLabel:'Googleチャレンジコース',underlying:'Alphabet'},
  GGLS:{leverage:1,direction:'bear',course:'challenge',courseLabel:'Google逆連動コース',underlying:'Alphabet'},
  MSFU:{leverage:2,direction:'bull',course:'challenge',courseLabel:'マイクロソフトチャレンジコース',underlying:'Microsoft'},
  MSFD:{leverage:1,direction:'bear',course:'challenge',courseLabel:'マイクロソフト逆連動コース',underlying:'Microsoft'},
  NVDU:{leverage:2,direction:'bull',course:'challenge',courseLabel:'エヌビディアチャレンジコース',underlying:'NVIDIA'},
  NVDD:{leverage:1,direction:'bear',course:'challenge',courseLabel:'エヌビディア逆連動コース',underlying:'NVIDIA'},
  TSLL:{leverage:2,direction:'bull',course:'challenge',courseLabel:'テスラチャレンジコース',underlying:'Tesla'},
  TSLS:{leverage:1,direction:'bear',course:'challenge',courseLabel:'テスラ逆連動コース',underlying:'Tesla'}
};
const KNOWN_LEVERAGED_TICKERS=PAYPAY_COURSE_TICKERS;
// moomoo側で原資産だけ表示されていても、PayPayチャレンジ保有へ結び付ける。
// ここでは「現在価格」を推定せず、原資産の日次騰落率×倍率の目安だけを保存する。
const UNDERLYING_TO_PAYPAY_CHALLENGE={
  '.SPX':[{ticker:'SPXL',leverage:3,direction:'bull',underlying:'S&P500'},{ticker:'SPXS',leverage:3,direction:'bear',underlying:'S&P500'}],
  'SPX': [{ticker:'SPXL',leverage:3,direction:'bull',underlying:'S&P500'},{ticker:'SPXS',leverage:3,direction:'bear',underlying:'S&P500'}],
  'AMZN':[{ticker:'AMZU',leverage:2,direction:'bull',underlying:'Amazon'},{ticker:'AMZD',leverage:1,direction:'bear',underlying:'Amazon'}],
  'AAPL':[{ticker:'AAPU',leverage:2,direction:'bull',underlying:'Apple'},{ticker:'AAPD',leverage:1,direction:'bear',underlying:'Apple'}],
  'GOOGL':[{ticker:'GGLL',leverage:2,direction:'bull',underlying:'Alphabet'},{ticker:'GGLS',leverage:1,direction:'bear',underlying:'Alphabet'}],
  'GOOG':[{ticker:'GGLL',leverage:2,direction:'bull',underlying:'Alphabet'},{ticker:'GGLS',leverage:1,direction:'bear',underlying:'Alphabet'}],
  'MSFT':[{ticker:'MSFU',leverage:2,direction:'bull',underlying:'Microsoft'},{ticker:'MSFD',leverage:1,direction:'bear',underlying:'Microsoft'}],
  'NVDA':[{ticker:'NVDU',leverage:2,direction:'bull',underlying:'NVIDIA'},{ticker:'NVDD',leverage:1,direction:'bear',underlying:'NVIDIA'}],
  'TSLA':[{ticker:'TSLL',leverage:2,direction:'bull',underlying:'Tesla'},{ticker:'TSLS',leverage:1,direction:'bear',underlying:'Tesla'}]
};
function challengeLinksForUnderlying(ticker=''){
  return UNDERLYING_TO_PAYPAY_CHALLENGE[normalizeTicker(ticker)]||[];
}
function paypayCourseInfo(ticker=''){return PAYPAY_COURSE_TICKERS[normalizeTicker(ticker)]||null;}
function isUsStyleTicker(t=''){const x=normalizeTicker(t);return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(x)&&!/^\d{4}$/.test(x);}
function holdingMatchForQuote(q){
  const exact=data.holdings.find(x=>normalizeTicker(x.ticker)===q.ticker && (x.market||'JP')===q.market);
  if(exact)return exact;
  // 旧データでPayPay米国ETFが「日本」扱いになっていた場合も、ティッカー一致を優先して救済する。
  if(q.market==='US'&&isUsStyleTicker(q.ticker)){
    return data.holdings.find(x=>normalizeTicker(x.ticker)===q.ticker && (x.broker==='PayPay証券'||isUsStyleTicker(x.ticker)));
  }
  return null;
}
function radarMatchForQuote(q){
  return data.radar.find(x=>normalizeTicker(x.ticker)===q.ticker && ((x.market||'JP')===q.market || (q.market==='US'&&isUsStyleTicker(q.ticker))));
}
function leverageFromQuote(q={}){
  const ticker=normalizeTicker(q.ticker);
  const known=KNOWN_LEVERAGED_TICKERS[ticker];
  const fromAi=Number(q.leverage);
  const fromName=detectLeverage(q.name||'');
  const leverage=Math.max(1,Math.min(5,(fromAi>1?fromAi:(fromName||known?.leverage||1))));
  let direction=String(q.direction||'normal').toLowerCase();
  if(known?.direction)direction=known.direction;
  if(leverage>1 && direction==='normal')direction='bull';
  return {leverage,direction};
}
// Only UTC/offset-qualified exchange timestamps may be used for freshness.
function verifiedQuoteTimeUtc(value){
  if(typeof value!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim()))return null;
  const ms=Date.parse(value);
  return Number.isFinite(ms)&&ms<=Date.now()+60000?new Date(ms).toISOString():null;
}
function normalizeMoomooQuote(q={}){
  const market=String(q.market||'').toUpperCase()==='JP'?'JP':'US';
  const price=Number(q.price);
  const changePercent=Number(q.changePercent);
  const lev=leverageFromQuote(q);
  return {
    ticker:normalizeTicker(q.ticker),name:String(q.name||'').trim(),market,
    price:Number.isFinite(price)?price:null,currency:q.currency||(market==='JP'?'JPY':'USD'),
    changePercent:Number.isFinite(changePercent)?changePercent:null,
    leverage:lev.leverage,direction:lev.direction,
    productType:lev.leverage>1?'leveraged':String(q.productType||'').toLowerCase(),confidence:Math.max(0,Math.min(100,Number(q.confidence)||0)),
    quoteTimeUtc:verifiedQuoteTimeUtc(q.quoteTimeUtc),updateTime:String(q.updateTime||'')
  };
}
function fixMoomooPercentScale(quotes=[]){
  const vals=quotes.map(q=>q.changePercent).filter(v=>Number.isFinite(v)&&v!==0);
  if(!vals.length)return quotes;
  const scaled=vals.filter(v=>Math.abs(v)>=50).length;
  // Workers AIが 3.00% を300として返すケースを、画像単位で判定して補正。
  if(scaled/vals.length>=0.6){
    quotes.forEach(q=>{if(Number.isFinite(q.changePercent))q.changePercent=q.changePercent/100;});
  }
  return quotes;
}
function applyMoomooQuotes(rawQuotes,capturedAt,options={}){
  const quotes=fixMoomooPercentScale((Array.isArray(rawQuotes)?rawQuotes:[]).map(normalizeMoomooQuote).filter(q=>q.ticker&&q.price!=null&&q.price>=0));
  let holdingsUpdated=0,radarUpdated=0;
  const results=[];
  const at=capturedAt||isoNow();
  quotes.forEach(q=>{
    let matched=false;
    const mappedHoldings=[];
    const h=holdingMatchForQuote(q);
    if(h){
      // moomooの米国ティッカーで一致した旧PayPayデータは市場区分だけ自動補正する。
      if(q.market==='US'&&isUsStyleTicker(q.ticker))h.market='US';
      h.quotePrice=q.price;h.quoteCurrency=q.currency||marketQuoteCurrency(q.market);
      // A screenshot's capture time is NOT an exchange quote time.
      const marketAt=options.source==='opend'?q.quoteTimeUtc:null;
      h.quoteUpdatedAt=marketAt;h.quoteCapturedAt=at;h.quoteTimeVerified=!!marketAt;
      h.quoteSource='moomoo';h.quoteStatus='ok';h.updatedAt=at;
      const pc=paypayCourseInfo(q.ticker);
      if(pc){
        h.leverageFactor=pc.leverage;
        h.productType=pc.direction==='bear'?'inverse':(pc.leverage>1?'leveraged':'inverse');
        if(h.broker==='PayPay証券'){
          h.accountCourse='challenge';
          h.accountCourseLabel=pc.courseLabel;
          h.underlyingLabel=pc.underlying;
        }
      }else if(q.leverage>1){
        h.leverageFactor=q.leverage;
        if((h.productType||'auto')==='auto')h.productType='leveraged';
      }
      if(defaultValuationCurrency(h)===h.quoteCurrency)h.value=q.price*(+h.qty||0);
      appendHoldingHistory(h);holdingsUpdated++;matched=true;
    }
    const r=radarMatchForQuote(q);
    if(r){
      r.price=q.price;r.updatedAt=at;r.quoteCapturedAt=at;
      r.quoteUpdatedAt=options.source==='opend'?q.quoteTimeUtc:null;
      r.quoteTimeVerified=!!r.quoteUpdatedAt;
      radarUpdated++;matched=true;
    }

    // 原資産（例 .SPX / AMZN）しかスクショに無い場合、対応するPayPayチャレンジ保有へ日次騰落目安を反映。
    // SPXL/AMZUの「現在価格」は原資産価格から算出できないため、価格は上書きしない。
    if(Number.isFinite(q.changePercent)){
      challengeLinksForUnderlying(q.ticker).forEach(link=>{
        const target=data.holdings.find(x=>normalizeTicker(x.ticker)===link.ticker && (x.broker==='PayPay証券'||paypayCourseInfo(x.ticker)));
        if(!target)return;
        const pc=paypayCourseInfo(link.ticker);
        const sign=link.direction==='bear'?-1:1;
        const estimated=q.changePercent*link.leverage*sign;
        target.market='US';
        target.leverageFactor=link.leverage;
        target.productType=link.direction==='bear'?'inverse':'leveraged';
        target.accountCourse='challenge';
        target.accountCourseLabel=pc?.courseLabel||'チャレンジコース';
        target.underlyingLabel=link.underlying;
        target.referenceTicker=q.ticker;
        target.referenceName=q.name||link.underlying;
        target.referenceMovePct=q.changePercent;
        target.estimatedDailyMovePct=estimated;
        target.referenceUpdatedAt=options.source==='opend'?(q.quoteTimeUtc||null):null;
        target.referenceCapturedAt=at;
        target.referenceSource='moomoo';
        target.updatedAt=at;
        mappedHoldings.push({ticker:link.ticker,estimatedMovePct:estimated,underlying:link.underlying});
        holdingsUpdated++;matched=true;
      });
    }

    const baseMove=(q.changePercent!=null&&(q.leverage>1||q.direction==='bear'))?(q.changePercent/q.leverage)*(q.direction==='bear'?-1:1):null;
    results.push({...q,matched,baseMove,mappedHoldings});
  });
  if(holdingsUpdated)appendPortfolioHistory();
  data.moomooImports.unshift({createdAt:at,quotes:results.map(q=>({ticker:q.ticker,price:q.price,market:q.market,leverage:q.leverage,mappedHoldings:q.mappedHoldings}))});
  data.moomooImports=data.moomooImports.slice(0,30);
  save();render();
  return {quotes:results,holdingsUpdated,radarUpdated};
}
function renderMoomooResult(applied){
  if(!moomooImportResult)return;
  if(!applied.quotes.length){moomooImportResult.innerHTML='<div class="candidate candidate-error">銘柄と現在値を読み取れませんでした。</div>';return;}
  moomooImportResult.innerHTML=applied.quotes.map(q=>{
    const pc=paypayCourseInfo(q.ticker);
    const lev=q.leverage>1?`<span class="product-tag special">${q.direction==='bear'?'ベア':'ブル'}${q.leverage}倍</span>`:'';
    const course=pc?`<span class="product-tag special">PayPay ${esc(pc.courseLabel)}</span>`:'';
    const move=q.changePercent==null?'':` / 騰落 ${q.changePercent>=0?'+':''}${q.changePercent.toFixed(2)}%`;
    const base=q.baseMove==null?'':`<br><small>日次${q.leverage}倍商品の目安：${esc(pc?.underlying||'原指数')}の値動き換算 約${q.baseMove>=0?'+':''}${q.baseMove.toFixed(2)}%（単純換算・乖離あり）</small>`;
    const mapped=(q.mappedHoldings||[]).map(m=>`<br><small>✅ PayPay ${esc(m.ticker)}へ連動：${esc(m.underlying)} ${q.changePercent>=0?'+':''}${q.changePercent.toFixed(2)}% → ${esc(m.ticker)}日次目安 ${m.estimatedMovePct>=0?'+':''}${m.estimatedMovePct.toFixed(2)}%</small>`).join('');
    const status=q.mappedHoldings?.length?'✅ チャレンジコース原資産として反映':(q.matched?'✅ 登録銘柄へ反映':'⚪ 未登録銘柄');
    return `<article class="card"><div class="row"><div><strong>${esc(q.name||q.ticker)}</strong><div class="sub">${esc(q.market)}・${esc(q.ticker)} ${lev} ${course}</div></div><div class="price">${currencyMoney(q.price,q.currency)}</div></div><p class="bullet">${status}${move}${base}${mapped}</p></article>`;
  }).join('');
}
if(selectMoomooImageBtn)selectMoomooImageBtn.onclick=()=>moomooImageInput.click();
if(moomooImageInput)moomooImageInput.onchange=()=>{
  const file=moomooImageInput.files?.[0];
  if(!file)return resetMoomooPreview();
  if(!file.type.startsWith('image/')){alert('画像ファイルを選んでください');return resetMoomooPreview();}
  if(file.size>8*1024*1024){alert('画像が大きすぎます。8MB以下のスクショを選んでください。');return resetMoomooPreview();}
  if(moomooImageUrl)URL.revokeObjectURL(moomooImageUrl);
  moomooImageFile=file;moomooImageUrl=URL.createObjectURL(file);
  moomooImagePreview.className='sns-image-preview';
  moomooImagePreview.innerHTML=`<img src="${moomooImageUrl}" alt="選択したmoomooスクリーンショット"><button type="button" id="clearMoomooImageBtn" class="sns-clear-btn">×</button><div class="sns-image-meta">${Math.max(1,Math.round(file.size/1024))}KB</div>`;
  document.querySelector('#clearMoomooImageBtn').onclick=resetMoomooPreview;
  analyzeMoomooImageBtn.disabled=false;
  moomooImportStatus.textContent='✅ 画像OK。「株価をAI読込」を押してください。';
};
if(analyzeMoomooImageBtn)analyzeMoomooImageBtn.onclick=async()=>{
  if(!moomooImageFile)return;
  analyzeMoomooImageBtn.disabled=true;analyzeMoomooImageBtn.textContent='⏳ AI読込中…';
  moomooImportStatus.textContent='🟡 moomoo画面から銘柄・現在値・ブル倍率を読み取り中…';
  try{
    const image=await fileToDataUrl(moomooImageFile);
    const known=[...data.holdings.map(h=>`${h.market} ${h.ticker} ${h.name}`),...data.radar.map(r=>`${r.market} ${r.ticker} ${r.name}`)].slice(0,40).join(' / ');
    const res=await fetch(MOOMOO_AI_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image,known})});
    const raw=await res.text();let payload=null;try{payload=raw?JSON.parse(raw):null;}catch(_){payload=null;}
    if(!res.ok||payload?.ok===false)throw new Error(payload?.error||raw||`HTTP ${res.status}`);
    if(!payload||!Array.isArray(payload.quotes))throw new Error('株価データ形式を確認できません');
    const applied=applyMoomooQuotes(payload.quotes,payload.capturedAt||payload.checkedAt);
    renderMoomooResult(applied);
    moomooImportStatus.textContent=`✅ ${applied.quotes.length}銘柄読取 / 保有株 ${applied.holdingsUpdated}件更新 / レーダー ${applied.radarUpdated}件更新`;
  }catch(err){moomooImportStatus.textContent=`🔴 読込失敗：${String(err?.message||err).slice(0,500)}`;}
  finally{analyzeMoomooImageBtn.disabled=!moomooImageFile;analyzeMoomooImageBtn.textContent='📈 株価をAI読込';}
};

// v0.64: Cloudflare Workers AI へSNSスクショを直接送信
const SNS_AI_ENDPOINT='https://stock-buddy-ai.toshibou-fishing.workers.dev/sns-analyze';
let snsImageFile=null;
let snsImageUrl=null;
const snsImageInput=document.querySelector('#snsImageInput');
const selectSnsImageBtn=document.querySelector('#selectSnsImageBtn');
const analyzeSnsImageBtn=document.querySelector('#analyzeSnsImageBtn');
const snsImagePreview=document.querySelector('#snsImagePreview');
const snsShareStatus=document.querySelector('#snsShareStatus');

function resetSnsPreview(){
  if(snsImageUrl){URL.revokeObjectURL(snsImageUrl);snsImageUrl=null;}
  snsImageFile=null;
  snsImageInput.value='';
  snsImagePreview.className='sns-image-preview empty';
  snsImagePreview.innerHTML='<span>まだ画像が選ばれていません</span>';
  analyzeSnsImageBtn.disabled=true;
  snsShareStatus.textContent='スクショを選ぶ → AI判定する、だけでOKです。';
}
function fileToDataUrl(file){
  return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error||new Error('画像読込失敗'));r.readAsDataURL(file);});
}
function aiTextFromResponse(payload){
  const r=payload?.result;
  if(typeof r==='string')return r;
  if(typeof r?.response==='string')return r.response;
  if(typeof r?.content==='string')return r.content;
  if(typeof r?.choices?.[0]?.message?.content==='string')return r.choices[0].message.content;
  return '';
}
function saveDirectSnsResult(text){
  const item=parseSnsAiResult(text);
  data.snsHistory.unshift(item);data.snsHistory=data.snsHistory.slice(0,100);save();render();
  const sig=signalMap[item.signal]||signalMap.wait;
  document.querySelector('#snsResult').innerHTML=`<article class="card analysis-card"><h3>🤖 Workers AI判定</h3><div class="signal ${sig[2]}">${sig[0]} ${sig[1]}</div><p class="bullet"><b>${esc(item.name||'銘柄未特定')}</b>${item.ticker?`（${esc(item.ticker)}）`:''}・確度 ${item.confidence}%<br>${esc(item.summary||'要約なし')}</p><p class="sub">判定時刻 ${formatQuoteTime(item.createdAt)} / SNS画像の内容を解析。投稿内容そのものは事実確認済みとは限りません。</p></article>`;
  snsShareStatus.innerHTML=item.ticker?'✅ AI判定完了。履歴へ保存しました。下の履歴からレーダーへ追加できます。':'🟡 AI判定完了。履歴へ保存しましたが、銘柄コードは特定できませんでした。';
}
selectSnsImageBtn.onclick=()=>snsImageInput.click();
snsImageInput.onchange=()=>{
  const file=snsImageInput.files?.[0];
  if(!file)return resetSnsPreview();
  if(!file.type.startsWith('image/')){alert('画像ファイルを選んでください');return resetSnsPreview();}
  if(file.size>8*1024*1024){alert('画像が大きすぎます。8MB以下のスクショを選んでください。');return resetSnsPreview();}
  if(snsImageUrl)URL.revokeObjectURL(snsImageUrl);
  snsImageFile=file;snsImageUrl=URL.createObjectURL(file);
  snsImagePreview.className='sns-image-preview';
  snsImagePreview.innerHTML=`<img src="${snsImageUrl}" alt="選択したSNSスクリーンショット"><button type="button" id="clearSnsImageBtn" class="sns-clear-btn">×</button><div class="sns-image-meta">${Math.max(1,Math.round(file.size/1024))}KB</div>`;
  document.querySelector('#clearSnsImageBtn').onclick=resetSnsPreview;
  analyzeSnsImageBtn.disabled=false;
  snsShareStatus.textContent='✅ 画像OK。「AI判定する」を押せば、そのままWorkers AIへ送ります。';
};
analyzeSnsImageBtn.onclick=async()=>{
  if(!snsImageFile)return;
  const hint=document.querySelector('#snsHint').value.trim();
  const known=[...data.holdings.map(h=>`${h.market} ${h.ticker} ${h.name}`),...data.radar.map(r=>`${r.market} ${r.ticker} ${r.name}`)].slice(0,30).join(' / ');
  analyzeSnsImageBtn.disabled=true;analyzeSnsImageBtn.textContent='⏳ AI判定中…';
  snsShareStatus.textContent='🟡 Workers AIがスクショを解析中です…';
  try{
    const image=await fileToDataUrl(snsImageFile);
    const res=await fetch(SNS_AI_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image,hint,known})});
    const raw=await res.text();
    let payload=null;
    try{payload=raw?JSON.parse(raw):null;}catch(_){payload=null;}
    if(!res.ok||payload?.ok===false){
      const detail=payload?.error||raw||`HTTP ${res.status}`;
      throw new Error(`Worker ${res.status}: ${String(detail).slice(0,1200)}`);
    }
    if(!payload)throw new Error(`Worker ${res.status}: JSONではない応答: ${String(raw).slice(0,1200)}`);
    const text=aiTextFromResponse(payload);
    if(!text)throw new Error(`AI応答形式を確認できません: ${JSON.stringify(payload).slice(0,1200)}`);
    saveDirectSnsResult(text);
  }catch(err){
    snsShareStatus.textContent=`🔴 AI取得失敗：${String(err?.message||err)} / ${new Date().toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})}`;
  }finally{
    analyzeSnsImageBtn.disabled=!snsImageFile;analyzeSnsImageBtn.textContent='🤖 AI判定する';
  }
};

document.querySelector('#analyzeSnsBtn').onclick=()=>{const text=document.querySelector('#snsText').value.trim();if(!text){document.querySelector('#snsResult').innerHTML='';return}const kws=['共同','提携','量産','受注','承認','上方修正','黒字','AI','半導体','防衛','特許','TOB','増配','自社株買い'];const risk=['必ず','10倍','絶対','爆上げ','急騰確実','今すぐ','買わないと','億れる'];const material=kws.filter(k=>text.includes(k));const hype=risk.filter(k=>text.includes(k));const score=Math.max(20,Math.min(92,52+material.length*9-hype.length*13));const verdict=score>=75?'一次情報の裏取り優先':score>=55?'候補として監視':'煽り・根拠不足に注意';document.querySelector('#snsResult').innerHTML=`<article class="card analysis-card"><h3>🔎 簡易判定：${score}/100</h3><div class="signal ${score>=75?'buy':score<55?'escape':'hold'}">${verdict}</div><p class="bullet">材料語 ${material.length}件 / 煽り表現 ${hype.length}件。<br>これは文章だけの一次スクリーニングです。実際の売買判断ではIR・開示・株価・出来高で裏取りが必要です。</p></article>`;};


// --- PayPay Securities quick updater (v0.4) ---
const paypayQuickDialog=document.querySelector('#paypayQuickDialog');
const paypayQuickRows=document.querySelector('#paypayQuickRows');
const applyPaypayQuickBtn=document.querySelector('#applyPaypayQuickBtn');
let paypayQuickData=[];
function parseQuickNumber(v){
  const normalized=String(v??'').normalize('NFKC');
  const cleaned=normalized.replace(/[円¥,$株\s]/g,'').replace(/,/g,'').replace(/[−–—]/g,'-');
  if(cleaned==='')return null;
  const n=Number(cleaned);return Number.isFinite(n)?n:null;
}
function openPaypayQuick(){
  const rows=data.holdings.map((h,index)=>({h,index})).filter(x=>x.h.broker==='PayPay証券');
  paypayQuickRows.innerHTML='';paypayQuickData=[];
  if(!rows.length){
    paypayQuickRows.innerHTML='<div class="candidate candidate-error">PayPay証券の保有株がまだありません。先に「＋追加」から1回だけ登録してください。</div>';
    applyPaypayQuickBtn.disabled=true;paypayQuickDialog.showModal();return;
  }
  rows.forEach(({h,index},i)=>{
    const currentValue=holdingValue(h),currentCost=holdingCost(h),currentPnl=currentCost==null?null:currentValue-currentCost;
    paypayQuickData.push({index,value:null,pnl:null});
    const el=document.createElement('div');el.className='candidate';
    el.innerHTML=`<div class="candidate-head"><strong>${esc(h.name)}</strong><span class="candidate-status update">${esc(h.ticker)}</span></div><div class="candidate-grid"><label>評価額<input data-i="${i}" data-f="value" inputmode="decimal" placeholder="例：124725"></label><label>評価損益<input data-i="${i}" data-f="pnl" inputmode="decimal" placeholder="例：-14860"></label></div><div class="candidate-help">現在の登録：評価額 ${currencyMoney(currentValue,defaultValuationCurrency(h))} / 損益 ${currentPnl==null?'未登録':`${currentPnl>=0?'+':''}${currencyMoney(currentPnl,defaultValuationCurrency(h))}`}<br>※ 空欄の銘柄は更新しません。</div>`;
    paypayQuickRows.appendChild(el);
  });
  paypayQuickRows.querySelectorAll('input').forEach(inp=>inp.addEventListener('input',()=>{paypayQuickData[+inp.dataset.i][inp.dataset.f]=parseQuickNumber(inp.value);}));
  applyPaypayQuickBtn.disabled=false;paypayQuickDialog.showModal();
}
document.querySelector('#paypayQuickBtn').onclick=openPaypayQuick;
applyPaypayQuickBtn.onclick=()=>{
  let updated=0,skipped=0;
  paypayQuickData.forEach(r=>{
    if(r.value==null && r.pnl==null)return;
    if(r.value==null || r.pnl==null){skipped++;return;}
    const h=data.holdings[r.index];
    if(!h || !(h.qty>0) || r.value<0){skipped++;return;}
    const cost=r.value-r.pnl;
    if(cost<0){skipped++;return;}
    h.value=r.value;
    h.costBasis=cost;
    delete h.price; delete h.avg;
    h.updatedAt=new Date().toISOString();
    h.quoteUpdatedAt=h.updatedAt;
    h.quoteSource='manual';
    h.quoteStatus='ok';
    h.note=h.note||'PayPay簡単更新';
    appendHoldingHistory(h);
    updated++;
  });
  if(updated)appendPortfolioHistory();
  save();render();runStartupResearch();paypayQuickDialog.close();
  alert(`PayPay簡単更新：${updated}件${skipped?` / 入力不足・異常値 ${skipped}件`:''}`);
};

document.querySelector('#notifyBtn').onclick=async()=>{if(!('Notification'in window)){alert('このブラウザは通知に対応していません');return}const p=await Notification.requestPermission();if(p==='granted')new Notification('相棒 STOCK',{body:'起動時調査の通知テストです'});};
// v0.72: 端末間バックアップ / 復元
function backupPayload(){
  return {app:'相棒 STOCK',version:APP_VERSION,exportedAt:new Date().toISOString(),storageKey:STORAGE_KEY,data:clone(data)};
}
function downloadBackup(){
  const payload=backupPayload();
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  const d=new Date(),stamp=`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}-${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}`;
  a.href=url;a.download=`stock-buddy-backup-${stamp}.json`;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  const st=document.querySelector('#backupStatus');if(st)st.textContent=`✅ バックアップを書き出しました（${data.holdings?.length||0}保有 / ${data.radar?.length||0}監視）`;
}
async function copyBackup(){
  const text=JSON.stringify(backupPayload());
  const st=document.querySelector('#backupStatus');
  try{
    if(navigator.clipboard&&window.isSecureContext){
      await navigator.clipboard.writeText(text);
    }else{
      const ta=document.createElement('textarea');
      ta.value=text;ta.setAttribute('readonly','');ta.style.position='fixed';ta.style.opacity='0';
      document.body.appendChild(ta);ta.select();ta.setSelectionRange(0,ta.value.length);
      if(!document.execCommand('copy'))throw new Error('コピーに失敗しました');
      ta.remove();
    }
    if(st)st.textContent=`✅ バックアップをコピーしました（${data.holdings?.length||0}保有 / ${data.radar?.length||0}監視）`;
  }catch(e){
    if(st)st.textContent='🔴 コピーできませんでした。ブラウザのクリップボード許可を確認してください。';
    alert('バックアップをコピーできませんでした。');
  }
}
function validBackupData(x){return x&&typeof x==='object'&&Array.isArray(x.holdings)&&Array.isArray(x.radar);}
async function importBackupFile(file){
  const st=document.querySelector('#backupStatus');
  try{
    const parsed=JSON.parse(await file.text());
    const incoming=parsed?.data??parsed;
    if(!validBackupData(incoming))throw new Error('相棒STOCKのバックアップ形式ではありません');
    const h=incoming.holdings.length,r=incoming.radar.length;
    if(!confirm(`このバックアップを読み込みますか？\n保有株 ${h}件 / 監視 ${r}件\n\nこの端末の現在データは置き換わります。`))return;
    data={...clone(seed),...incoming};
    if(!Array.isArray(data.portfolioHistory))data.portfolioHistory=[];
    if(!Array.isArray(data.snsHistory))data.snsHistory=[];
    if(!Array.isArray(data.moomooImports))data.moomooImports=[];
    if(!Array.isArray(data.tradeHistory))data.tradeHistory=[];
    if(!data.settings||typeof data.settings!=='object')data.settings={moomooBridgeUrl:''};
    (data.holdings||[]).forEach(x=>{if(!Array.isArray(x.history))x.history=[];});
    save();render();runStartupResearch();
    if(st)st.textContent=`✅ 復元完了：保有株 ${h}件 / 監視 ${r}件`;
    setTimeout(async()=>{try{await refreshMoomooLocalQuotes();}catch(_){}},500);
  }catch(e){if(st)st.textContent=`🔴 読み込み失敗：${e?.message||e}`;alert(`バックアップを読み込めませんでした。\n${e?.message||e}`);}
}
const exportBackupBtn=document.querySelector('#exportBackupBtn');
const copyBackupBtn=document.querySelector('#copyBackupBtn');
const importBackupBtn=document.querySelector('#importBackupBtn');
const backupFileInput=document.querySelector('#backupFileInput');
if(exportBackupBtn)exportBackupBtn.onclick=downloadBackup;
if(copyBackupBtn)copyBackupBtn.onclick=copyBackup;
if(importBackupBtn)importBackupBtn.onclick=()=>backupFileInput?.click();
if(backupFileInput)backupFileInput.onchange=async()=>{const f=backupFileInput.files?.[0];if(f)await importBackupFile(f);backupFileInput.value='';};


// v0.74: moomoo Bridge接続先の自動取得・手動フォールバック
const moomooBridgeUrlInput=document.querySelector('#moomooBridgeUrl');
const saveMoomooBridgeBtn=document.querySelector('#saveMoomooBridgeBtn');
const testMoomooBridgeBtn=document.querySelector('#testMoomooBridgeBtn');
const moomooBridgeStatus=document.querySelector('#moomooBridgeStatus');
const moomooRealtimeTag=document.querySelector('#moomooRealtimeTag');
function setMoomooBridgeUi(kind,msg){
  if(moomooBridgeStatus)moomooBridgeStatus.textContent=msg;
  if(moomooRealtimeTag){
    moomooRealtimeTag.className=`tag ${kind==='ok'?'ok':'warn'}`;
    moomooRealtimeTag.textContent=kind==='ok'?'moomoo OpenD接続中':kind==='fail'?'接続失敗':'接続テスト待ち';
  }
}
if(moomooBridgeUrlInput)moomooBridgeUrlInput.value=savedMoomooBridgeUrl();
if(saveMoomooBridgeBtn)saveMoomooBridgeBtn.onclick=()=>{
  const u=normalizeBridgeUrl(moomooBridgeUrlInput?.value||'');
  if(!/^https?:\/\//i.test(u)){setMoomooBridgeUi('fail','🔴 http:// または https:// から始まるURLを入力してください。');return;}
  data.settings=data.settings||{};
  data.settings.moomooBridgeUrl=u; save();
  if(moomooBridgeUrlInput)moomooBridgeUrlInput.value=u;
  setMoomooBridgeUi('wait','🟡 URLを保存しました。次に「接続テスト＆更新」を押してください。');
};
if(testMoomooBridgeBtn)testMoomooBridgeBtn.onclick=async()=>{
  testMoomooBridgeBtn.disabled=true;
  setMoomooBridgeUi('wait','🟡 moomoo OpenDから実株価を取得中…');
  try{
    if(moomooBridgeUrlInput){
      const u=normalizeBridgeUrl(moomooBridgeUrlInput.value);
      if(u){data.settings=data.settings||{};data.settings.moomooBridgeUrl=u;save();}
    }
    const applied=await refreshMoomooLocalQuotes();
    const via='認証付きWorker';
    setMoomooBridgeUi('ok',`🟢 接続成功（${via}）：${applied.quotes.length}銘柄取得 / 保有株 ${applied.holdingsUpdated}件更新`);
  }catch(e){
    setMoomooBridgeUi('fail',`🔴 接続失敗：${String(e?.message||e).slice(0,180)}`);
  }finally{testMoomooBridgeBtn.disabled=false;}
};



// v0.82: Local-only paper decisions. NEVER call /trade/order or any broker order endpoint.
let currentTradeProposal=null;
function tradeEls(){return {ticker:document.querySelector('#tradeTicker'),account:document.querySelector('#tradeAccount'),orders:document.querySelector('#tradeOrders'),proposal:document.querySelector('#tradeProposal'),tag:document.querySelector('#tradeModeTag')}}
function fillTradeTickers(){
  const e=tradeEls(),old=e.ticker?.value;if(!e.ticker)return;
  const defaults=[{ticker:'SPXL',name:'Direxion Daily S&P 500 Bull 3X'},{ticker:'AMZU',name:'Direxion Daily AMZN Bull 2X'}];
  const rows=[...defaults,...(data.holdings||[]),...(data.radar||[])];
  const seen=new Set();e.ticker.innerHTML='';
  rows.forEach(x=>{const raw=String(x.ticker||x.code||'').toUpperCase().replace(/^US\./,'');const t=normalizeTicker(raw);
    if(!t||seen.has(t))return;if(!defaults.some(d=>d.ticker===t)&&String(x.market||'JP').toUpperCase()!=='US')return;
    seen.add(t);const o=document.createElement('option');o.value=t;o.textContent=`${t} ${x.name||''}`;e.ticker.appendChild(o);
  });if(old&&seen.has(old))e.ticker.value=old;
}
function refreshTradePanel(){
  fillTradeTickers();const e=tradeEls();if(!e.account)return;
  const paper=(data.tradeHistory||[]).filter(x=>x.mode==='LOCAL_PAPER_V082');
  const reviewed=paper.filter(x=>Number.isFinite(Number(x.reviewPrice))&&Number(x.reviewPrice)>0);
  const gains=reviewed.map(x=>(x.side==='BUY'?1:-1)*(Number(x.reviewPrice)-Number(x.price))*Number(x.qty));
  const wins=gains.filter(v=>v>0).length;
  e.tag.className='tag ok';e.tag.textContent='LOCAL PAPER・発注なし';
  e.account.innerHTML=`<b>仮想承認 ${paper.length}件 / 検証済 ${reviewed.length}件</b><span>検証勝率：${reviewed.length?(wins/reviewed.length*100).toFixed(1)+'%':'未集計'} / 仮想損益合計：${reviewed.length?'$'+gains.reduce((a,b)=>a+b,0).toFixed(2):'未集計'}</span><div class="sub">端末内にのみ保存。売買成立や実現損益を表すものではありません。旧moomooデモ履歴は変更しません。</div>`;
  e.orders.innerHTML=paper.length?paper.slice().reverse().slice(0,40).map(x=>{
    const reviewed=Number(x.reviewPrice)>0;const pnl=reviewed?(x.side==='BUY'?1:-1)*(Number(x.reviewPrice)-Number(x.price))*Number(x.qty):null;
    return `<div class="trade-order"><b>${esc(x.ticker)} ${esc(x.side)}・${Number(x.qty)}株 @ $${Number(x.price).toFixed(2)}</b><span>${esc(new Date(x.approvedAt).toLocaleString('ja-JP'))} / ${reviewed?'仮想損益 $'+pnl.toFixed(2):'未検証'}</span><div class="sub">${esc(x.reason||'')}</div><label>検証時の株価 ($)<input type="number" class="paper-review-price" data-paper-id="${esc(x.id)}" min="0.01" step="0.01" value="${reviewed?Number(x.reviewPrice):''}" placeholder="後日確認した価格を入力"></label><button class="small-btn paper-review-btn" data-paper-id="${esc(x.id)}">検証価格を記録</button></div>`;
  }).join(''):'<div class="sub">仮想承認の履歴はまだありません。</div>';
  e.orders.querySelectorAll('.paper-review-btn').forEach(btn=>btn.addEventListener('click',()=>{
    const id=btn.dataset.paperId;const item=(data.tradeHistory||[]).find(x=>x.id===id&&x.mode==='LOCAL_PAPER_V082');
    const input=Array.from(e.orders.querySelectorAll('.paper-review-price')).find(el=>el.dataset.paperId===id);
    const price=Number(input?.value);if(!item||!Number.isFinite(price)||price<=0){alert('正の検証価格を入力してください。');return;}
    item.reviewPrice=price;item.reviewedAt=new Date().toISOString();save();refreshTradePanel();
  }));
}
// v0.84: NYSE regular-session calendar (Eastern Time, including DST).
// Source: https://www.nyse.com/markets/hours-calendars (2026-2028 published schedule).
// Calendar is intentionally finite: unsupported years and unexpected closures fail closed.
// This is a regular-session estimate, NOT an exchange-provided real-time market status.
const NYSE_HOLIDAYS={
  2026:['01-01','01-19','02-16','04-03','05-25','06-19','07-03','09-07','11-26','12-25'],
  2027:['01-01','01-18','02-15','03-26','05-31','06-18','07-05','09-06','11-25','12-24'],
  2028:['01-17','02-21','04-14','05-29','06-19','07-04','09-04','11-23','12-25']
};
const NYSE_EARLY_CLOSE={
  2026:['11-27','12-24'],
  2027:['11-26'],
  2028:['07-03','11-24']
};
const NYSE_TIME_FORMATTER=new Intl.DateTimeFormat('en-US',{
  timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',
  weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'
});
function usRegularMarketState(nowMs=Date.now()){
  if(!Number.isFinite(nowMs))return {isOpen:false,status:'unknown',label:'時刻を確認できません',et:'不明'};
  const parts=Object.fromEntries(NYSE_TIME_FORMATTER.formatToParts(new Date(nowMs)).map(x=>[x.type,x.value]));
  const year=Number(parts.year),dayKey=`${parts.month}-${parts.day}`;
  const et=`${parts.year}-${dayKey} ${parts.hour}:${parts.minute} ET`;
  const base={et,isOpen:false,sessionClose:'16:00 ET'};
  if(!Object.hasOwn(NYSE_HOLIDAYS,year))return {...base,status:'unknown',label:'取引所カレンダー未対応（要確認）'};
  if(parts.weekday==='Sat'||parts.weekday==='Sun')return {...base,status:'weekend',label:'米国市場は週末休場'};
  if(NYSE_HOLIDAYS[year].includes(dayKey))return {...base,status:'holiday',label:'米国市場は祝日休場'};
  const early=NYSE_EARLY_CLOSE[year].includes(dayKey);
  const close=early?13*60:16*60;
  const minute=Number(parts.hour)*60+Number(parts.minute);
  const sessionClose=early?'13:00 ET':'16:00 ET';
  if(minute<9*60+30)return {...base,status:'premarket',label:'米国市場は通常取引開始前',sessionClose};
  if(minute>=close)return {...base,status:'afterhours',label:early?'米国市場は短縮取引終了後':'米国市場は通常取引終了後',sessionClose};
  return {...base,isOpen:true,status:'open',label:early?'米国市場は通常取引中（短縮日）':'米国市場は通常取引中',sessionClose};
}
function assessTradeQuoteTime(quoteTimeUtc,market,nowMs=Date.now()){
  const verifiedTime=verifiedQuoteTimeUtc(quoteTimeUtc);
  const quoteMs=verifiedTime?Date.parse(verifiedTime):NaN;
  const ageMs=nowMs-quoteMs;
  const valid=Number.isFinite(quoteMs)&&Number.isFinite(ageMs)&&ageMs>=-60000;
  const ageLabel=valid?(ageMs<60000?'1分未満':Math.floor(ageMs/60000)+'分前'):'時刻不明・未来時刻';
  if(!market.isOpen)return {fresh:false,ageLabel,reason:`${market.label}のため、仮想承認を保留します。最終取引価格は分析参考値です。`};
  if(!valid)return {fresh:false,ageLabel,reason:'株価の更新時刻を検証できないため、仮想承認を保留します。'};
  if(ageMs>=15*60*1000)return {fresh:false,ageLabel,reason:'開場中ですが株価の更新から15分以上経過しているため、仮想承認を保留します。'};
  return {fresh:true,ageLabel,reason:''};
}
// v0.83: deterministic technical indicators from authenticated historical closes.
function technicalIndicators(bars){
  const ordered=(Array.isArray(bars)?bars:[]).filter(b=>/^\d{4}-\d{2}-\d{2}$/.test(b.date||'')&&Number.isFinite(+b.close)&&+b.close>0).sort((a,b)=>a.date.localeCompare(b.date));
  const unique=ordered.filter((b,i)=>i===ordered.length-1||b.date!==ordered[i+1].date);
  const closes=unique.map(b=>+b.close), n=closes.length;
  if(n<35)return {ok:false,count:n,reason:'MACD計算には35営業日以上の履歴が必要です'};
  const avg=k=>closes.slice(-k).reduce((a,b)=>a+b,0)/k;
  const ema=(arr,period)=>{const alpha=2/(period+1);let v=arr[0];return arr.map((x,i)=>{v=i===0?x:v+alpha*(x-v);return v;});};
  const fast=ema(closes,12),slow=ema(closes,26),macdSeries=fast.map((x,i)=>x-slow[i]),signalSeries=ema(macdSeries,9);
  let gain=0,loss=0;for(let i=n-14;i<n;i++){const d=closes[i]-closes[i-1];gain+=Math.max(0,d);loss+=Math.max(0,-d);}
  const rsi=loss===0?(gain===0?50:100):100-100/(1+gain/loss);
  return {ok:true,count:n,lastDate:unique[n-1].date,last:closes[n-1],sma5:avg(5),sma20:avg(20),rsi,macd:macdSeries[n-1],signal:signalSeries[n-1],histogram:macdSeries[n-1]-signalSeries[n-1]};
}
function technicalAssessment(ind){
  if(!ind.ok)return {bias:'WAIT',score:0,notes:[ind.reason]};
  const notes=[];let score=0;
  if(ind.sma5>ind.sma20){score++;notes.push('5日線が20日線より上（短期上向き）');}else{score--;notes.push('5日線が20日線以下（短期弱含み）');}
  if(ind.last>ind.sma20){score++;notes.push('終値が20日線より上');}else{score--;notes.push('終値が20日線以下');}
  if(ind.histogram>0){score++;notes.push('MACDがシグナルを上回る');}else{score--;notes.push('MACDがシグナル以下');}
  if(ind.rsi>=70){score--;notes.push('RSI70以上・過熱に注意');}
  else if(ind.rsi<=30){notes.push('RSI30以下・売られすぎ圏（反転保証なし）');}
  else notes.push('RSIは中立圏');
  return {bias:score>=3?'BUY':score<=-3?'SELL':'WAIT',score,notes};
}
let tradeQuoteRequest=0;
async function makeTradeProposal(){
  const e=tradeEls(),ticker=normalizeTicker(e.ticker?.value||'');
  if(!ticker){e.proposal.textContent='米国銘柄がありません。';return;}
  const request=++tradeQuoteRequest;
  currentTradeProposal=null;
  e.proposal.className='trade-proposal';
  e.proposal.textContent=`${ticker} のmoomoo株価を取得中…`;
  let quote=null,quoteCapturedAt=null,quoteError='',historyError='',technical={ok:false,reason:'株価履歴未取得'},techView={bias:'WAIT',score:0,notes:[]};
  try{
    // v0.82.1: use the authenticated read-only Worker relay, not the removed direct Bridge URL helper.
    const payload=await moomooReadFetch('/quotes');
    if(!payload?.ok||!Array.isArray(payload.quotes))throw new Error(payload?.error||'株価データ形式エラー');
    quoteCapturedAt=payload.capturedAt||null;
    quote=payload.quotes.find(q=>normalizeTicker(q.ticker||String(q.code||'').replace(/^US\./i,''))===ticker)||null;
    if(!quote)throw new Error(`${ticker} の価格が応答にありません`);
  }catch(err){quoteError=String(err?.message||err);}
  try{
    const hist=await moomooReadFetch('/history?symbol='+encodeURIComponent(ticker));
    technical=technicalIndicators(hist?.bars);
    techView=technicalAssessment(technical);
  }catch(err){historyError=String(err?.message||err);technical={ok:false,reason:'履歴取得失敗：'+historyError};techView=technicalAssessment(technical);}
  if(request!==tradeQuoteRequest||e.ticker?.value!==ticker)return;
  const price=Number(quote?.price);
  const hasPrice=Number.isFinite(price)&&price>0;
  const h=(data.holdings||[]).find(x=>String(x.market||'JP').toUpperCase()==='US'&&normalizeTicker(String(x.ticker||'').replace(/^US\./i,''))===ticker);
  const prev=Number(quote?.prevClose);
  const dailyPct=hasPrice&&Number.isFinite(prev)&&prev>0?(price/prev-1)*100:NaN;
  const quoteAt=verifiedQuoteTimeUtc(quote?.quoteTimeUtc);
  const market=usRegularMarketState();
  const freshness=assessTradeQuoteTime(quoteAt,market);
  const fresh=freshness.fresh;
  const sig=h?deriveSignal(h):'wait';
  let side='WAIT',assessment='様子見',reason='';
  if(!hasPrice){reason=`価格を取得できません：${quoteError||'データなし'}`;}
  else if(!technical.ok){reason=`テクニカル分析不可：${technical.reason}。根拠不足のため承認候補を出しません。`;}
  else if(!Number.isFinite(dailyPct)){reason='前日終値が不明のため承認候補を出しません。';}
  else if(technical.bias==='BUY' && sig!=='escape' && sig!=='take'){
    assessment='テクニカル買い候補';side='BUY';reason=`移動平均・MACDが上向きで、RSIを含めた試作スコア ${techView.score}。将来の上昇を保証しません。`;
  }else if(technical.bias==='SELL' && h){
    assessment='テクニカル売却候補';side='SELL';reason=`移動平均・MACDが弱含みで、試作スコア ${techView.score}。保有株のリスク確認用です。`;
  }else if(h&&(sig==='escape'||sig==='take')){
    assessment='保有株の売却確認';side='SELL';reason=`保有株の${sig==='escape'?'損失警戒':'利確確認'}条件に該当。テクニカルと併せて確認してください。`;
  }else{
    assessment='様子見';reason=`テクニカル試作スコア ${techView.score}。買い・売りの根拠が一致していません。`;
  }
  // Daily history may be older than the live quote. Never treat a historical close as live execution price.
  if(technical.ok && quoteAt && technical.lastDate){
    const quoteDate=new Date(quoteAt);
    const histDate=technical.lastDate;
    if(Number.isFinite(quoteDate.getTime()) && (quoteDate.getTime()-Date.parse(histDate+'T23:59:59Z'))>5*86400000){
      side='WAIT';reason+=' 日足履歴が古いため判断を保留します。';
    }
  }
  if(!fresh){side='WAIT';reason+=' '+freshness.reason;}
  const riskPct=2;
  const estimatedRisk=hasPrice?price*riskPct/100:NaN;
  const techSummary=technical.ok?`<div class="sub"><b>テクニカル分析（${technical.count}営業日・最終 ${esc(technical.lastDate)}）</b><br>5日平均 $${technical.sma5.toFixed(2)} / 20日平均 $${technical.sma20.toFixed(2)}<br>RSI(14) ${technical.rsi.toFixed(1)} / MACD ${technical.macd.toFixed(3)} / シグナル ${technical.signal.toFixed(3)}<br>試作スコア ${techView.score}：${techView.notes.map(esc).join('・')}</div>`:`<div class="sub">テクニカル分析不可：${esc(technical.reason)}</div>`;
  const analysis=`<div class="sub">判定：<b>${esc(assessment)}</b>（履歴データによるルール判定・AI予測ではありません）</div>`+techSummary+
    `<div class="sub">前日終値：${Number.isFinite(prev)&&prev>0?'$'+prev.toFixed(2):'不明'} / 前日比：${Number.isFinite(dailyPct)?(dailyPct>=0?'+':'')+dailyPct.toFixed(2)+'%':'不明'}</div>`+
    `<div class="sub">参考リスク：現在値から2%の値幅は1株あたり約${Number.isFinite(estimatedRisk)?'$'+estimatedRisk.toFixed(2):'不明'}（損失上限の保証ではありません）</div>`;
  currentTradeProposal={ticker,side,qty:1,price:hasPrice?price:null,reason,technical:technical.ok?technical:null,technicalScore:techView.score,quoteTimeUtc:quoteAt,createdAt:new Date().toISOString()};
  e.proposal.className='trade-proposal';
  e.proposal.innerHTML=`<div class="trade-proposal-side ${side.toLowerCase()}">${side}</div><b>${esc(ticker)} ${hasPrice?`@ $${price.toFixed(2)}`:'価格未取得'}</b><p>${esc(reason)}</p>${analysis}<div class="sub"><b>米国市場：${esc(market.label)}</b>（${esc(market.et)} / 通常取引終了 ${esc(market.sessionClose)}）<br>取得元：${quote?'moomoo OpenD':'取得失敗'} / 株価更新：${quoteAt?esc(formatQuoteTime(quoteAt)):'時刻未確認'} / 受信：${quoteCapturedAt?esc(formatQuoteTime(quoteCapturedAt)):'不明'}<br>株価の経過：${esc(freshness.ageLabel)} / 鮮度：${fresh?'更新15分以内（時刻上の判定・リアルタイム保証なし）':esc(market.isOpen?'更新遅延・時刻未確認':'時間外・休場')}<br>※市場状態はNYSE公表カレンダーからの推定。臨時休場・データ遅延の保証はありません。</div>${side!=='WAIT'?`<label>数量<input id="tradeQty" type="number" min="1" max="10" step="1" value="1"></label><label>指値<input id="tradePrice" type="number" min="0.01" step="0.01" value="${price.toFixed(2)}"></label><button id="approveDemoOrderBtn" class="primary full-btn">✅ 提案を承認して仮想記録</button>`:'<div class="sub">今回は発注しません。</div>'}<div class="trade-lock">🔒 アプリ内のみで記録 / moomooへの注文送信なし / ルール判定（AI予測ではありません）</div>`;
  document.querySelector('#approveDemoOrderBtn')?.addEventListener('click',placeApprovedDemoOrder);
}

async function placeApprovedDemoOrder(){
  if(!currentTradeProposal||currentTradeProposal.side==='WAIT')return;
  const qty=Number(document.querySelector('#tradeQty')?.value),price=Number(document.querySelector('#tradePrice')?.value);
  if(!Number.isInteger(qty)||qty<1||qty>10||!Number.isFinite(price)||price<=0){alert('数量は1～10株、参考価格は正の数値にしてください。');return;}
  // Recheck session and freshness at the moment of approval; no real orders are sent.
  const market=usRegularMarketState();
  const freshness=assessTradeQuoteTime(currentTradeProposal.quoteTimeUtc,market);
  if(!freshness.fresh){alert(freshness.reason+' 再分析してください。');return;}
  if(!confirm(`アプリ内に仮想売買判断を記録します。\n${currentTradeProposal.ticker} ${currentTradeProposal.side}\n${qty}株 @ $${price.toFixed(2)}\n\n実際の注文・約定は一切発生しません。`))return;
  const record={...currentTradeProposal,qty,price,id:`paper-${Date.now()}-${Math.random().toString(36).slice(2,10)}`,approvedAt:new Date().toISOString(),mode:'LOCAL_PAPER_V082',status:'HYPOTHETICAL_NOT_EXECUTED'};
  data.tradeHistory=data.tradeHistory||[];data.tradeHistory.push(record);
  try{save();}catch(err){data.tradeHistory.pop();alert('端末への保存に失敗しました：'+err.message);return;}
  currentTradeProposal=null;const e=tradeEls();if(e.proposal)e.proposal.textContent='仮想判断を保存しました。次の提案は「提案を作る」から取得してください。';
  refreshTradePanel();alert('✅ 仮想判断を端末に保存しました。moomooへ注文は送っていません。');
}
document.querySelector('#refreshTradeBtn')?.addEventListener('click',refreshTradePanel);
document.querySelector('#makeTradeProposalBtn')?.addEventListener('click',makeTradeProposal);
document.querySelector('[data-tab="trade"]')?.addEventListener('click',()=>setTimeout(refreshTradePanel,50));
fillTradeTickers();
document.querySelector('#resetBtn').onclick=()=>{if(confirm('保有株・監視株を含む全データを初期化しますか？')){data=clone(seed);save();render();runStartupResearch();}};

ensureInitialHistory();

if('serviceWorker'in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));}


// v0.62: AI判定結果の取り込み・履歴・レーダー連携
function fieldFromAi(text,key){
  const m=String(text||'').match(new RegExp('^'+key+'\\s*[:：]\\s*(.*)$','mi'));
  return m?m[1].trim():'';
}
function parseSnsAiResult(text){
  const name=fieldFromAi(text,'STOCK_NAME');
  const ticker=fieldFromAi(text,'TICKER').toUpperCase().replace(/[^0-9A-Z.\-]/g,'');
  const market=(fieldFromAi(text,'MARKET').toUpperCase()==='US'?'US':'JP');
  const confidence=Math.max(0,Math.min(100,parseInt(fieldFromAi(text,'CONFIDENCE'),10)||0));
  const rawSignal=fieldFromAi(text,'SIGNAL').toLowerCase();
  const signal=['buy','hold','wait','take','escape'].includes(rawSignal)?rawSignal:'wait';
  const summary=fieldFromAi(text,'SUMMARY')||String(text).replace(/\s+/g,' ').trim().slice(0,180);
  return{name,ticker,market,confidence,signal,summary,raw:String(text).trim(),createdAt:new Date().toISOString()};
}
function renderSnsHistory(){
  const list=document.querySelector('#snsHistory');if(!list)return;list.innerHTML='';
  const items=(data.snsHistory||[]).slice().sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
  if(!items.length){list.innerHTML='<article class="card empty-card"><strong>判定履歴はまだありません</strong>SNSスクショをAI判定すると、ここへ自動保存されます。</article>';return;}
  items.forEach(item=>{
    const actualIndex=data.snsHistory.indexOf(item), sig=signalMap[item.signal]||signalMap.wait;
    const el=document.createElement('article');el.className='card sns-history-item';
    el.innerHTML=`<div class="row"><div><div class="name">${esc(item.name||'銘柄未特定')}</div><div class="sub">${esc(item.market||'JP')}・${esc(item.ticker||'コード不明')}・確度 ${Number(item.confidence||0)}%</div></div><div class="sns-history-time">${formatQuoteTime(item.createdAt)}</div></div><div class="signal ${sig[2]}">${sig[0]} ${sig[1]}</div><p class="bullet">${esc(item.summary||'要約なし')}</p><div class="card-actions">${item.ticker?`<button class="mini-btn sns-to-radar" data-index="${actualIndex}">🔎 レーダーへ</button>`:''}<button class="mini-btn delete sns-delete" data-index="${actualIndex}">削除</button></div>`;
    list.appendChild(el);
  });
  document.querySelectorAll('.sns-to-radar').forEach(b=>b.onclick=()=>{
    const x=data.snsHistory[+b.dataset.index];if(!x||!x.ticker)return;
    const exists=data.radar.some(r=>r.market===x.market&&String(r.ticker).toUpperCase()===x.ticker);
    if(exists){alert('この銘柄はすでにレーダー登録済みです。');return;}
    data.radar.push({market:x.market,name:x.name||x.ticker,ticker:x.ticker,price:0,reason:`SNS AI判定：${x.summary}`,addedAt:new Date().toISOString(),snsSignal:x.signal,snsConfidence:x.confidence});
    save();render();alert('レーダーへ追加しました。');
  });
  document.querySelectorAll('.sns-delete').forEach(b=>b.onclick=()=>{if(confirm('このSNS判定履歴を削除しますか？')){data.snsHistory.splice(+b.dataset.index,1);save();render();}});
}

render();runStartupResearch();


// v0.71: PCでOpenDブリッジが動いている時だけ自動更新。スマホ等では静かにスキップ。
setTimeout(async()=>{
  try{
    const applied=await refreshMoomooLocalQuotes();
    if(applied?.quotes?.length){
      console.log(`moomoo bridge: ${applied.quotes.length} quotes updated`);
      const via='認証付きWorker';
      setMoomooBridgeUi('ok',`🟢 自動接続成功（${via}）：${applied.quotes.length}銘柄取得`);
    }
  }catch(e){
    console.log('moomoo bridge unavailable:',e?.message||e);
    setMoomooBridgeUi('fail',`🔴 自動接続失敗：${String(e?.message||e).slice(0,180)}`);
  }
},1200);

