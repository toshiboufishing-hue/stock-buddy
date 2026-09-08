const APP_VERSION='0.56.0';
const STORAGE_KEY='stockBuddyDataV02';
const seed={holdings:[],radar:[],research:{lastRun:null,lastSummary:null}};
const clone=o=>JSON.parse(JSON.stringify(o));
let data=loadData();

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
function render(){renderHoldings();renderRadar();renderTotals();}
function renderHoldings(){
  const list=document.querySelector('#holdingsList');list.innerHTML='';
  if(!data.holdings.length){list.innerHTML='<article class="card empty-card"><strong>まだ保有株がありません</strong>「＋追加」から実際の保有銘柄を登録すると、次回起動時から自動で調査対象になります。</article>';return;}
  data.holdings.forEach((h,i)=>{
    const signal=deriveSignal(h),s=signalMap[signal];
    const value=holdingValue(h),cost=holdingCost(h),pnl=cost!=null?value-cost:null,pct=cost?pnl/cost*100:null;
    const el=document.createElement('article');el.className='card holding';
    const pinfo=productInfo(h);
    el.innerHTML=`<div class="row"><div><div class="name">${esc(h.name)}</div><div class="sub">${esc(h.broker)}・${h.market==='US'?'米国':'日本'}・${esc(h.ticker)}</div><div class="product-tags">${h.accountCourse==='challenge'?'<span class="product-tag special">PayPayチャレンジ</span>':''}<span class="product-tag ${['leveraged','inverse'].includes(pinfo.type)?'special':''}">${esc(pinfo.label)}</span></div></div><div><div class="price">${money(value,h.market)}</div><div class="sub ${pnl==null?'':(pnl>=0?'positive':'negative')}">${pnl==null?'損益未登録':`${pnl>=0?'+':''}${money(pnl,h.market)} (${pct>=0?'+':''}${pct.toFixed(1)}%)`}</div></div></div><div class="signal ${s[2]}">${s[0]} ${s[1]}</div><p class="bullet">${signalReason(h)}<br><span class="risk-note">商品特性：${esc(pinfo.risk)}</span>${h.note?`<br>メモ：${esc(h.note)}`:''}</p><div class="meta-grid"><div class="meta"><b>${h.qty}</b><span>保有数</span></div><div class="meta"><b>${money(value,h.market)}</b><span>評価額</span></div><div class="meta"><b>${h.qty>0?money(value/h.qty,h.market):'—'}</b><span>評価単価</span></div></div><div class="card-actions"><button class="mini-btn edit-holding" data-index="${i}">編集</button><button class="mini-btn delete delete-holding" data-index="${i}">削除</button></div>`;
    list.appendChild(el);
  });
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
function deleteHolding(i){if(confirm(`${data.holdings[i].name} を削除しますか？`)){data.holdings.splice(i,1);save();render();runStartupResearch();}}
document.querySelector('#cancelHolding').onclick=()=>holdingDialog.close();
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
  const h={...prev,broker:document.querySelector('#broker').value,market:document.querySelector('#market').value,name:document.querySelector('#name').value.trim(),ticker:document.querySelector('#ticker').value.trim().toUpperCase(),accountCourse:document.querySelector('#accountCourse').value,productType:document.querySelector('#productType').value,qty:+document.querySelector('#qty').value,value,costBasis,note:document.querySelector('#holdingNote').value.trim(),updatedAt:new Date().toISOString()};
  delete h.avg; delete h.price;
  if(idx==='') data.holdings.push(h); else data.holdings[+idx]=h;
  save(); render(); holdingDialog.close(); runStartupResearch();
};
document.querySelector('#holdingForm').addEventListener('submit',e=>e.preventDefault());

const watchDialog=document.querySelector('#watchDialog');document.querySelector('#addWatchBtn').onclick=()=>{document.querySelector('#watchForm').reset();watchDialog.showModal();};
document.querySelector('#watchForm').addEventListener('submit',e=>{if(e.submitter?.value==='cancel')return;e.preventDefault();data.radar.push({market:document.querySelector('#watchMarket').value,name:document.querySelector('#watchName').value.trim(),ticker:document.querySelector('#watchTicker').value.trim().toUpperCase(),price:+document.querySelector('#watchPrice').value||0,reason:document.querySelector('#watchReason').value.trim(),addedAt:new Date().toISOString()});save();render();watchDialog.close();runStartupResearch();});

function buildResearchPrompt(){
  const holdings=data.holdings.map(h=>{const p=productInfo(h);return `- [保有] ${h.market} ${h.ticker} ${h.name} / ${h.broker} / コース:${h.accountCourse==='challenge'?'PayPayチャレンジ':h.accountCourse==='nisa'?'NISA':'通常'} / 商品:${p.label} / 数量 ${h.qty} / 評価額 ${holdingValue(h)}${h.note?` / メモ: ${h.note}`:''}`}).join('\n');
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
    h.note=h.note||'PayPay簡単更新';
    updated++;
  });
  save();render();runStartupResearch();paypayQuickDialog.close();
  alert(`PayPay簡単更新：${updated}件${skipped?` / 入力不足・異常値 ${skipped}件`:''}`);
};

document.querySelector('#notifyBtn').onclick=async()=>{if(!('Notification'in window)){alert('このブラウザは通知に対応していません');return}const p=await Notification.requestPermission();if(p==='granted')new Notification('相棒 STOCK',{body:'起動時調査の通知テストです'});};
document.querySelector('#resetBtn').onclick=()=>{if(confirm('保有株・監視株を含む全データを初期化しますか？')){data=clone(seed);save();render();runStartupResearch();}};

if('serviceWorker'in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));}
render();runStartupResearch();
