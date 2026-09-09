const APP_VERSION='0.62.0';
const STORAGE_KEY='stockBuddyDataV02';
const seed={holdings:[],radar:[],portfolioHistory:[],research:{lastRun:null,lastSummary:null}};
const clone=o=>JSON.parse(JSON.stringify(o));
let data=loadData();
if(!Array.isArray(data.portfolioHistory))data.portfolioHistory=[];
if(!Array.isArray(data.snsHistory))data.snsHistory=[];
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
  const n=String(h.name||'').normalize('NFKC').toLowerCase();
  if(/インバース|ベア|bear|inverse/.test(n))return'inverse';
  if(/direxion|ブル[23]?倍|[23]倍etf|leveraged|レバレッジ/.test(n))return'leveraged';
  if(/\betf\b|上場投信|上場インデックス/.test(n))return'etf';
  return'stock';
}
function productInfo(h={}){
  const type=inferProductType(h),lev=detectLeverage(h.name||'');
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
function quoteMeta(h={}){
  const at=h.quoteUpdatedAt||h.updatedAt||(Array.isArray(h.history)&&h.history.length?h.history[h.history.length-1].at:null);
  const source=h.quoteSource||'manual';
  const failed=h.quoteStatus==='failed';
  const ageMs=at?Date.now()-new Date(at).getTime():Infinity;
  const ageMin=ageMs/60000;
  let level='yellow',label='手入力';
  if(failed){level='red';label='取得失敗';}
  else if(source!=='manual' && ageMin<=5){level='green';label='最新';}
  else if(source!=='manual' && ageMin<=30){level='yellow';label='遅延';}
  else if(source!=='manual' && ageMin>30){level='red';label='古い';}
  else if(source==='manual' && ageMin>1440){level='red';label='手入力・古い';}
  return {at,source,level,label,ageMin};
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
  h.price=price;
  h.value=price*(+h.qty||0);
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
  document.querySelector('#holdingHistoryMeta').innerHTML=`<span>現在 <b>${money(current,h.market)}</b></span><span>記録開始比 <b class="${change>=0?'positive':'negative'}">${change>=0?'+':''}${money(change,h.market)} (${pct>=0?'+':''}${pct.toFixed(1)}%)</b></span><span>${points.length}点</span>`;
  renderLineChart(document.querySelector('#holdingHistoryChart'),points.map(p=>({at:p.at,value:p.value})),[{key:'value'}]);
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
    el.innerHTML=`${important?'<div class="priority-banner">🚨 最重要・強制トップ</div>':''}<div class="compact-top"><div class="holding-main"><div class="name">${esc(h.name)}</div><div class="sub">${esc(h.broker)}・${h.market==='US'?'米国':'日本'}・${esc(h.ticker)}</div></div><div class="holding-money"><div class="price">${money(value,h.market)}</div><div class="sub ${pnl==null?'':(pnl>=0?'positive':'negative')}">${pnl==null?'損益未登録':`${pnl>=0?'+':''}${money(pnl,h.market)} (${pct>=0?'+':''}${pct.toFixed(1)}%)`}</div></div></div><div class="quote-freshness ${qm.level}"><span class="fresh-dot"></span><b>${qm.label}</b><span>${formatQuoteTime(qm.at)}</span><small>${quoteSourceLabel(qm.source)}</small></div><div class="compact-status"><span class="direction ${dir[2]}"><b>${dir[0]}</b> ${dir[1]}</span><span class="signal ${s[2]}">${s[0]} ${s[1]}</span></div><div class="ai-comment ${important?'critical':''}"><span class="ai-label">AIコメント</span><strong>${esc(reason)}</strong></div><div class="compact-foot"><div class="product-tags">${h.accountCourse==='challenge'?'<span class="product-tag special">PayPayチャレンジ</span>':''}<span class="product-tag ${['leveraged','inverse'].includes(pinfo.type)?'special':''}">${esc(pinfo.label)}</span></div><div class="card-actions"><button class="mini-btn history-holding" data-index="${i}">📈</button><button class="mini-btn edit-holding" data-index="${i}">編集</button><button class="mini-btn delete delete-holding" data-index="${i}">削除</button></div></div>`;
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
  let jpValue=0,jpCost=0,usValue=0,usCost=0;
  let jpCostKnown=true,usCostKnown=true; data.holdings.forEach(h=>{const value=holdingValue(h),cost=holdingCost(h);if(h.market==='US'){usValue+=value;if(cost==null)usCostKnown=false;else usCost+=cost}else{jpValue+=value;if(cost==null)jpCostKnown=false;else jpCost+=cost}});
  const total=document.querySelector('#totalValue');
  total.textContent=usValue?`${yen(jpValue)} + $${usValue.toLocaleString('en-US',{maximumFractionDigits:2})}`:yen(jpValue);
  const pnlJP=jpCostKnown?jpValue-jpCost:null,pctJP=(jpCostKnown&&jpCost)?pnlJP/jpCost*100:null;
  const t=document.querySelector('#totalPnl');
  t.textContent=usValue?`日本株 ${pnlJP==null?'損益未登録':`${pnlJP>=0?'+':''}${yen(pnlJP)}`} / 米国株 ${usCostKnown?`${usValue-usCost>=0?'+':''}$${(usValue-usCost).toFixed(2)}`:'損益未登録'}`:(pnlJP==null?'損益未登録':`${pnlJP>=0?'+':''}${yen(pnlJP)}（${pctJP>=0?'+':''}${pctJP.toFixed(1)}%）`);
  t.className='pnl '+(pnlJP==null?'':(pnlJP>=0?'positive':'negative'));
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
document.querySelector('#addHoldingBtn').onclick=()=>{document.querySelector('#holdingForm').reset();document.querySelector('#holdingEditIndex').value='';document.querySelector('#holdingDialogTitle').textContent='保有株を追加';document.querySelector('#productType').value='auto';document.querySelector('#accountCourse').value='normal';refreshProductHint();holdingDialog.showModal();};
function openHoldingEdit(i){const h=data.holdings[i];document.querySelector('#holdingEditIndex').value=i;document.querySelector('#holdingDialogTitle').textContent='保有株を編集';document.querySelector('#broker').value=h.broker;document.querySelector('#market').value=h.market||'JP';document.querySelector('#name').value=h.name;document.querySelector('#ticker').value=h.ticker;document.querySelector('#qty').value=h.qty;document.querySelector('#holdingValue').value=holdingValue(h);const editCost=holdingCost(h);document.querySelector('#holdingPnl').value=editCost==null?'':holdingValue(h)-editCost;document.querySelector('#holdingNote').value=h.note||'';let pt=h.productType||'auto';let course=h.accountCourse||'normal';if(pt==='challenge'){course='challenge';pt='auto';}document.querySelector('#productType').value=pt;document.querySelector('#accountCourse').value=course;refreshProductHint();holdingDialog.showModal();}
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
  const h={...prev,broker:document.querySelector('#broker').value,market:document.querySelector('#market').value,name:document.querySelector('#name').value.trim(),ticker:document.querySelector('#ticker').value.trim().toUpperCase(),accountCourse:document.querySelector('#accountCourse').value,productType:document.querySelector('#productType').value,qty:+document.querySelector('#qty').value,value,costBasis,note:document.querySelector('#holdingNote').value.trim(),updatedAt:new Date().toISOString(),quoteUpdatedAt:new Date().toISOString(),quoteSource:'manual',quoteStatus:'ok'};
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
  const holdings=data.holdings.map(h=>{const p=productInfo(h);return `- [保有] ${h.market} ${h.ticker} ${h.name} / ${h.broker} / コース:${h.accountCourse==='challenge'?'PayPayチャレンジ':h.accountCourse==='nisa'?'NISA':'通常'} / 商品:${p.label} / 数量 ${h.qty} / 評価額 ${holdingValue(h)} / データ時刻:${formatQuoteTime(quoteMeta(h).at)} / データ状態:${quoteMeta(h).label}${h.note?` / メモ: ${h.note}`:''}`}).join('\n');
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


// v0.61: Androidで確実に使えるSNSスクショ判定導線
// Web Share APIの画像+文章同時共有には依存しない。
let snsImageFile=null;
let snsImageUrl=null;
const snsImageInput=document.querySelector('#snsImageInput');
const selectSnsImageBtn=document.querySelector('#selectSnsImageBtn');
const shareSnsImageBtn=document.querySelector('#shareSnsImageBtn');
const openChatGptBtn=document.querySelector('#openChatGptBtn');
const snsImagePreview=document.querySelector('#snsImagePreview');
const snsShareStatus=document.querySelector('#snsShareStatus');

function resetSnsPreview(){
  if(snsImageUrl){URL.revokeObjectURL(snsImageUrl);snsImageUrl=null;}
  snsImageFile=null;
  snsImageInput.value='';
  snsImagePreview.className='sns-image-preview empty';
  snsImagePreview.innerHTML='<span>まだ画像が選ばれていません</span>';
  shareSnsImageBtn.disabled=true;
  openChatGptBtn.disabled=true;
  snsShareStatus.textContent='スクショを選ぶ → 判定指示をコピー → ChatGPTで同じ画像を添付、の順ならAndroidでも確実です。';
}
function buildSnsImagePrompt(){
  const hint=document.querySelector('#snsHint').value.trim();
  const known=[...data.holdings.map(h=>`${h.market} ${h.ticker} ${h.name}`),...data.radar.map(r=>`${r.market} ${r.ticker} ${r.name}`)].slice(0,30).join(' / ');
  return `【相棒STOCK SNSスクショ判定】\nこのあと添付する画像はSNS投稿のスクリーンショットです。画像内の文字・投稿内容・銘柄を読み取り、煽りに流されず裏取り前提で分析してください。\n\n必須:\n1. 推定銘柄名・証券コード（不明なら候補を最大3つ）\n2. 推定確度 0〜100% と、その根拠\n3. 投稿が主張する材料・カタリスト\n4. 「絶対上がる」「10倍」等の煽り/誘導表現と危険度\n5. 投稿日時や価格など、画像から読める鮮度情報\n6. 最新のIR・適時開示・会社発表・信頼できるニュースで裏取り。確認できない主張は未確認と明記\n7. 出来高/売買代金/直近値動きが確認できれば、資金流入が初動・拡散中・過熱のどこか判定\n8. 最終判定を 🚀買い候補 / 🔥監視強化 / ⚪待ち / 💰利確警戒 / 🚨危険 の5段階から1つ\n9. 「今すぐ見るべき次の条件」を1〜3個\n10. 回答の最後に必ず次の形式を1行ずつ付ける（不明は空欄）:\nSTOCK_NAME: 銘柄名\nTICKER: 証券コード\nMARKET: JP または US\nCONFIDENCE: 0〜100\nSIGNAL: buy / hold / wait / take / escape\nSUMMARY: 100文字以内の要約\n\n重要: 投稿者の断定を事実扱いしない。銘柄特定に自信がなければ無理に1社へ決めない。株価やニュースには取得時刻/確認時刻を付ける。\n${hint?`補足: ${hint}\n`:''}${known?`相棒STOCK登録銘柄（参考のみ）: ${known}\n`:''}`;
}
async function copySnsPrompt(){
  const text=buildSnsImagePrompt();
  try{
    await navigator.clipboard.writeText(text);
    snsShareStatus.innerHTML='✅ 判定指示をコピーしました。次に <b>ChatGPTを開く</b> → このスクショを添付 → 貼り付けして送信。';
  }catch(err){
    const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();
    const ok=document.execCommand('copy');ta.remove();
    snsShareStatus.innerHTML=ok?'✅ 判定指示をコピーしました。次にChatGPTでスクショを添付してください。':'⚠️ コピーできませんでした。下の文字判定欄へ貼り付ける方法を使ってください。';
  }
}
selectSnsImageBtn.onclick=()=>snsImageInput.click();
snsImageInput.onchange=()=>{
  const file=snsImageInput.files?.[0];
  if(!file)return resetSnsPreview();
  if(!file.type.startsWith('image/')){alert('画像ファイルを選んでください');return resetSnsPreview();}
  if(file.size>15*1024*1024){alert('画像が大きすぎます。15MB以下のスクショを選んでください。');return resetSnsPreview();}
  if(snsImageUrl)URL.revokeObjectURL(snsImageUrl);
  snsImageFile=file;snsImageUrl=URL.createObjectURL(file);
  snsImagePreview.className='sns-image-preview';
  snsImagePreview.innerHTML=`<img src="${snsImageUrl}" alt="選択したSNSスクリーンショット"><button type="button" id="clearSnsImageBtn" class="sns-clear-btn">×</button><div class="sns-image-meta">${Math.max(1,Math.round(file.size/1024))}KB</div>`;
  document.querySelector('#clearSnsImageBtn').onclick=resetSnsPreview;
  shareSnsImageBtn.disabled=false;
  openChatGptBtn.disabled=false;
  snsShareStatus.innerHTML='✅ 画像OK。まず <b>判定指示をコピー</b> してください。画像は端末に残っているので、ChatGPT側で同じスクショを添付します。';
};
shareSnsImageBtn.onclick=copySnsPrompt;
openChatGptBtn.onclick=()=>{
  window.open('https://chatgpt.com/','_blank','noopener,noreferrer');
  snsShareStatus.innerHTML='🤖 ChatGPTを開きました。<b>＋</b> からこのスクショを添付して、コピー済みの判定指示を貼り付けて送信してください。';
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
    el.innerHTML=`<div class="candidate-head"><strong>${esc(h.name)}</strong><span class="candidate-status update">${esc(h.ticker)}</span></div><div class="candidate-grid"><label>評価額<input data-i="${i}" data-f="value" inputmode="decimal" placeholder="例：124725"></label><label>評価損益<input data-i="${i}" data-f="pnl" inputmode="decimal" placeholder="例：-14860"></label></div><div class="candidate-help">現在の登録：評価額 ${money(currentValue,h.market)} / 損益 ${currentPnl==null?'未登録':`${currentPnl>=0?'+':''}${money(currentPnl,h.market)}`}<br>※ 空欄の銘柄は更新しません。</div>`;
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
  if(!items.length){list.innerHTML='<article class="card empty-card"><strong>判定履歴はまだありません</strong>ChatGPTの判定結果を貼り付けて取り込むと、ここへ残ります。</article>';return;}
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
const importSnsAiBtn=document.querySelector('#importSnsAiBtn');
if(importSnsAiBtn)importSnsAiBtn.onclick=()=>{
  const box=document.querySelector('#snsAiResult'),status=document.querySelector('#snsImportStatus');
  const text=box.value.trim();if(!text){status.textContent='⚠️ ChatGPTの判定結果を貼り付けてください。';return;}
  const item=parseSnsAiResult(text);data.snsHistory.unshift(item);data.snsHistory=data.snsHistory.slice(0,100);save();render();box.value='';
  status.innerHTML=item.ticker?`✅ ${esc(item.name||item.ticker)}（${esc(item.ticker)}）を保存しました。下の履歴からレーダー登録できます。`:'🟡 判定結果は保存しましたが、銘柄コードを自動抽出できませんでした。';
};

render();runStartupResearch();
