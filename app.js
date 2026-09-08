const APP_VERSION='0.3.0';
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

function save(){localStorage.setItem(STORAGE_KEY,JSON.stringify(data));}
function esc(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function deriveSignal(h){
  if(!h.avg||!h.price)return'wait';
  const pnl=(h.price-h.avg)/h.avg*100;
  if(pnl<=-15)return'escape';
  if(pnl>=25)return'take';
  if(pnl>=8)return'hold';
  return'wait';
}
function signalReason(h){
  if(!h.avg||!h.price)return'価格情報不足';
  const pct=(h.price-h.avg)/h.avg*100;
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
    const value=h.qty*h.price,cost=h.qty*h.avg,pnl=value-cost,pct=cost?pnl/cost*100:0;
    const el=document.createElement('article');el.className='card holding';
    el.innerHTML=`<div class="row"><div><div class="name">${esc(h.name)}</div><div class="sub">${esc(h.broker)}・${h.market==='US'?'米国':'日本'}・${esc(h.ticker)}</div></div><div><div class="price">${money(h.price,h.market)}</div><div class="sub ${pnl>=0?'positive':'negative'}">${pnl>=0?'+':''}${money(pnl,h.market)} (${pct>=0?'+':''}${pct.toFixed(1)}%)</div></div></div><div class="signal ${s[2]}">${s[0]} ${s[1]}</div><p class="bullet">${signalReason(h)}${h.note?`<br>メモ：${esc(h.note)}`:''}</p><div class="meta-grid"><div class="meta"><b>${h.qty}</b><span>保有数</span></div><div class="meta"><b>${money(h.avg,h.market)}</b><span>平均取得</span></div><div class="meta"><b>${money(value,h.market)}</b><span>評価額</span></div></div><div class="card-actions"><button class="mini-btn edit-holding" data-index="${i}">編集</button><button class="mini-btn delete delete-holding" data-index="${i}">削除</button></div>`;
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
  data.holdings.forEach(h=>{const value=h.qty*h.price,cost=h.qty*h.avg;if(h.market==='US'){usValue+=value;usCost+=cost}else{jpValue+=value;jpCost+=cost}});
  const total=document.querySelector('#totalValue');
  total.textContent=usValue?`${yen(jpValue)} + $${usValue.toLocaleString('en-US',{maximumFractionDigits:2})}`:yen(jpValue);
  const pnlJP=jpValue-jpCost,pctJP=jpCost?pnlJP/jpCost*100:0;
  const t=document.querySelector('#totalPnl');
  t.textContent=usValue?`日本株 ${pnlJP>=0?'+':''}${yen(pnlJP)} / 米国株 ${usValue-usCost>=0?'+':''}$${(usValue-usCost).toFixed(2)}`:`${pnlJP>=0?'+':''}${yen(pnlJP)}（${pctJP>=0?'+':''}${pctJP.toFixed(1)}%）`;
  t.className='pnl '+(pnlJP>=0?'positive':'negative');
  const sigs=data.holdings.map(deriveSignal);
  document.querySelector('#overallSignal').textContent=!sigs.length?'未判定':sigs.includes('escape')?'要確認':sigs.includes('take')?'利確確認':sigs.includes('hold')?'保有確認':'様子見';
}

function switchTab(id){document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id===id));document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===id));scrollTo({top:0,behavior:'smooth'});}
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));

const holdingDialog=document.querySelector('#holdingDialog');
document.querySelector('#addHoldingBtn').onclick=()=>{document.querySelector('#holdingForm').reset();document.querySelector('#holdingEditIndex').value='';document.querySelector('#holdingDialogTitle').textContent='保有株を追加';holdingDialog.showModal();};
function openHoldingEdit(i){const h=data.holdings[i];document.querySelector('#holdingEditIndex').value=i;document.querySelector('#holdingDialogTitle').textContent='保有株を編集';document.querySelector('#broker').value=h.broker;document.querySelector('#market').value=h.market||'JP';document.querySelector('#name').value=h.name;document.querySelector('#ticker').value=h.ticker;document.querySelector('#qty').value=h.qty;document.querySelector('#avg').value=h.avg;document.querySelector('#price').value=h.price;document.querySelector('#holdingNote').value=h.note||'';holdingDialog.showModal();}
function deleteHolding(i){if(confirm(`${data.holdings[i].name} を削除しますか？`)){data.holdings.splice(i,1);save();render();runStartupResearch();}}
document.querySelector('#holdingForm').addEventListener('submit',e=>{if(e.submitter?.value==='cancel')return;e.preventDefault();const h={broker:document.querySelector('#broker').value,market:document.querySelector('#market').value,name:document.querySelector('#name').value.trim(),ticker:document.querySelector('#ticker').value.trim().toUpperCase(),qty:+document.querySelector('#qty').value,avg:+document.querySelector('#avg').value,price:+document.querySelector('#price').value,note:document.querySelector('#holdingNote').value.trim(),updatedAt:new Date().toISOString()};const idx=document.querySelector('#holdingEditIndex').value;if(idx==='')data.holdings.push(h);else data.holdings[+idx]=h;save();render();holdingDialog.close();runStartupResearch();});

const watchDialog=document.querySelector('#watchDialog');document.querySelector('#addWatchBtn').onclick=()=>{document.querySelector('#watchForm').reset();watchDialog.showModal();};
document.querySelector('#watchForm').addEventListener('submit',e=>{if(e.submitter?.value==='cancel')return;e.preventDefault();data.radar.push({market:document.querySelector('#watchMarket').value,name:document.querySelector('#watchName').value.trim(),ticker:document.querySelector('#watchTicker').value.trim().toUpperCase(),price:+document.querySelector('#watchPrice').value||0,reason:document.querySelector('#watchReason').value.trim(),addedAt:new Date().toISOString()});save();render();watchDialog.close();runStartupResearch();});

function buildResearchPrompt(){
  const holdings=data.holdings.map(h=>`- [保有] ${h.market} ${h.ticker} ${h.name} / ${h.broker} / 数量 ${h.qty} / 取得 ${h.avg} / 現在 ${h.price}${h.note?` / メモ: ${h.note}`:''}`).join('\n');
  const watch=data.radar.map(r=>`- [監視] ${r.market} ${r.ticker} ${r.name}${r.price?` / 現在 ${r.price}`:''}${r.reason?` / 理由: ${r.reason}`:''}`).join('\n');
  return `相棒STOCK 起動時調査。以下の銘柄について、現在時点の最新情報をWebで調査してください。株価・出来高/売買代金・適時開示/IR・決算・ニュース・地政学/政策・SNSの注目変化を確認し、情報の鮮度と資金流入を重視してください。煽り投稿は必ず一次情報で裏取りしてください。各銘柄を 🚀買い候補 / 🔥保有継続 / ⚪待ち / 💰利確検討 / 🚨売却警戒 の5段階で、根拠・否定材料・次に見る条件とともに簡潔に判定してください。\n\n${holdings||'- 保有株なし'}\n${watch||'- 監視株なし'}`;
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


// --- PayPay Securities screenshot importer (v0.3) ---
const paypayImportDialog=document.querySelector('#paypayImportDialog');
const paypayImages=document.querySelector('#paypayImages');
const paypayPreview=document.querySelector('#paypayPreview');
const runOcrBtn=document.querySelector('#runOcrBtn');
const ocrStatus=document.querySelector('#ocrStatus');
const ocrProgress=document.querySelector('#ocrProgress');
const ocrRawText=document.querySelector('#ocrRawText');
const reparseOcrBtn=document.querySelector('#reparseOcrBtn');
const importCandidates=document.querySelector('#importCandidates');
const applyImportBtn=document.querySelector('#applyImportBtn');
let importRows=[];

function normalizeOcrText(text=''){
  const fw='０１２３４５６７８９，．％＋－￥';
  const hw='0123456789,.%+-¥';
  let out=String(text).normalize('NFKC');
  for(let i=0;i<fw.length;i++)out=out.split(fw[i]).join(hw[i]);
  return out.replace(/[−–—]/g,'-').replace(/\r/g,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
}
function numFrom(s){
  if(s==null)return null;
  const m=String(s).replace(/[円¥,$株]/g,'').replace(/,/g,'').match(/[+-]?\d+(?:\.\d+)?/);
  return m?Number(m[0]):null;
}
function labeledNumber(block,labels){
  for(const label of labels){
    const escLabel=label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const re=new RegExp(escLabel+'\\s*[:：]?\\s*([+\\-]?\\s*[¥￥$]?\\s*[\\d,]+(?:\\.\\d+)?)','i');
    const m=block.match(re);if(m)return numFrom(m[1]);
  }
  return null;
}
function parsePayPayText(raw){
  const text=normalizeOcrText(raw);
  const lines=text.split('\n').map(x=>x.trim()).filter(Boolean);
  const rows=[]; const used=new Set();
  for(let i=0;i<lines.length;i++){
    const cm=lines[i].match(/(?:^|\s|[（(])([1-9]\d{3})(?:\s|$|[）)])/);
    if(!cm)continue;
    const ticker=cm[1]; if(used.has(ticker))continue;
    const start=Math.max(0,i-2), end=Math.min(lines.length,i+8);
    const block=lines.slice(start,end).join('\n');
    let name=lines[i].replace(cm[1],'').replace(/[()（）]/g,' ').replace(/(東証|日本株|PayPay証券|保有|詳細)/g,' ').replace(/\s+/g,' ').trim();
    if(!name || /^\d/.test(name)){
      const prev=lines.slice(Math.max(0,i-2),i).reverse().find(x=>/[一-龠ぁ-んァ-ヶA-Za-z]/.test(x) && !/(評価|損益|保有|円|株)/.test(x));
      if(prev)name=prev.replace(/\s+/g,' ').trim();
    }
    const qty=labeledNumber(block,['保有数量','保有数','数量','株数']);
    const value=labeledNumber(block,['評価額','時価評価額','評価金額','資産評価額']);
    const pnl=labeledNumber(block,['評価損益','損益']);
    let pct=labeledNumber(block,['損益率','評価損益率']);
    if(pct==null){const pm=block.match(/([+\-]?\d+(?:\.\d+)?)\s*%/);if(pm)pct=Number(pm[1]);}
    rows.push({ticker,name:name||ticker,qty,value,pnl,pct});used.add(ticker);
  }
  // Fallback: PayPay OCR may split ticker onto a separate line; create candidates from any 4-digit codes.
  if(!rows.length){
    const codes=[...text.matchAll(/\b([1-9]\d{3})\b/g)].map(m=>m[1]);
    [...new Set(codes)].slice(0,30).forEach(t=>rows.push({ticker:t,name:t,qty:null,value:null,pnl:null,pct:null}));
  }
  return rows;
}
function enrichImportRow(r){
  const existingIndex=data.holdings.findIndex(h=>h.broker==='PayPay証券' && String(h.ticker)===String(r.ticker));
  const old=existingIndex>=0?data.holdings[existingIndex]:null;
  let qty=r.qty ?? old?.qty ?? null;
  let avg=old?.avg ?? null;
  let price=old?.price ?? null;
  if(r.value!=null && qty>0)price=r.value/qty;
  if(r.value!=null && r.pnl!=null && qty>0)avg=(r.value-r.pnl)/qty;
  return {...r,existingIndex,qty,avg,price};
}
function renderImportCandidates(rows){
  importRows=rows.map(enrichImportRow);
  importCandidates.innerHTML='';
  if(!importRows.length){importCandidates.innerHTML='<div class="candidate candidate-error">銘柄コードを認識できませんでした。上の「読み取った文字」を開いて修正してから再解析してください。</div>';applyImportBtn.disabled=true;return;}
  importRows.forEach((r,i)=>{
    const ready=r.ticker && r.name && r.qty>0 && r.avg!=null && r.price!=null;
    const el=document.createElement('div');el.className='candidate';
    el.innerHTML=`<div class="candidate-head"><strong>${esc(r.name||r.ticker)}</strong><span class="candidate-status ${r.existingIndex>=0?'update':''}">${r.existingIndex>=0?'既存を更新':'新規候補'}</span></div><div class="candidate-grid"><label>銘柄コード<input data-f="ticker" data-i="${i}" value="${esc(r.ticker||'')}"></label><label>銘柄名<input data-f="name" data-i="${i}" value="${esc(r.name||'')}"></label><label>保有数<input data-f="qty" data-i="${i}" inputmode="decimal" value="${r.qty??''}"></label><label>評価額<input data-f="value" data-i="${i}" inputmode="decimal" value="${r.value??''}"></label><label>評価損益<input data-f="pnl" data-i="${i}" inputmode="decimal" value="${r.pnl??''}"></label><label>損益率 %<input data-f="pct" data-i="${i}" inputmode="decimal" value="${r.pct??''}"></label></div><div class="candidate-help ${ready?'':'candidate-error'}">${ready?'更新可能です。':'不足項目あり。既存銘柄なら評価額・損益だけでも更新できます。新規銘柄は保有数が必要です。'}</div>`;
    importCandidates.appendChild(el);
  });
  importCandidates.querySelectorAll('input').forEach(inp=>inp.addEventListener('input',()=>{
    const i=+inp.dataset.i,f=inp.dataset.f;importRows[i][f]=['qty','value','pnl','pct'].includes(f)?numFrom(inp.value):inp.value.trim();
    importRows[i]=enrichImportRow(importRows[i]);
  }));
  applyImportBtn.disabled=false;
}
function resetImporter(){
  paypayImages.value='';paypayPreview.innerHTML='';ocrRawText.value='';importCandidates.innerHTML='';importRows=[];ocrProgress.style.width='0%';ocrStatus.textContent='画像を選択してください';runOcrBtn.disabled=true;applyImportBtn.disabled=true;
}
document.querySelector('#paypayImportBtn').onclick=()=>{resetImporter();paypayImportDialog.showModal();};
paypayImages.addEventListener('change',()=>{
  paypayPreview.innerHTML='';const files=[...paypayImages.files];
  files.forEach((f,i)=>{const u=URL.createObjectURL(f),d=document.createElement('div');d.className='preview-item';d.innerHTML=`<img alt="スクショ${i+1}" src="${u}"><span>${i+1}枚目</span>`;paypayPreview.appendChild(d);});
  runOcrBtn.disabled=!files.length;ocrStatus.textContent=files.length?`${files.length}枚選択しました。解析できます。`:'画像を選択してください';
});
runOcrBtn.onclick=async()=>{
  const files=[...paypayImages.files];if(!files.length)return;
  if(!window.Tesseract){ocrStatus.textContent='OCRライブラリを読み込めませんでした。通信状態を確認してください。';return;}
  runOcrBtn.disabled=true;applyImportBtn.disabled=true;ocrRawText.value='';importCandidates.innerHTML='';
  const chunks=[];
  try{
    for(let i=0;i<files.length;i++){
      ocrStatus.textContent=`${i+1}/${files.length}枚目を読み取り中… 初回は日本語辞書の取得で少し時間がかかります`;
      const result=await Tesseract.recognize(files[i],'jpn+eng',{logger:m=>{if(m.status==='recognizing text'){const base=i/files.length,part=(m.progress||0)/files.length;ocrProgress.style.width=Math.round((base+part)*100)+'%';}}});
      chunks.push(result.data.text||'');
    }
    const raw=normalizeOcrText(chunks.join('\n\n--- 次のスクショ ---\n\n'));ocrRawText.value=raw;ocrProgress.style.width='100%';ocrStatus.textContent='文字の読み取り完了。内容を確認してください。';renderImportCandidates(parsePayPayText(raw));
  }catch(err){console.error(err);ocrStatus.textContent='画像解析に失敗しました。別のスクショで再試行するか、読み取った文字欄へ手入力してください。';}
  runOcrBtn.disabled=false;
};
reparseOcrBtn.onclick=()=>{renderImportCandidates(parsePayPayText(ocrRawText.value));ocrStatus.textContent='修正した文字から再解析しました。';};
applyImportBtn.onclick=()=>{
  let updated=0,added=0,skipped=0;
  importRows.forEach(raw=>{
    let r=enrichImportRow(raw); const idx=data.holdings.findIndex(h=>h.broker==='PayPay証券' && String(h.ticker)===String(r.ticker)); const old=idx>=0?data.holdings[idx]:null;
    const qty=r.qty??old?.qty; let price=r.price??old?.price,avg=r.avg??old?.avg;
    if(r.value!=null && qty>0)price=r.value/qty;
    if(r.value!=null && r.pnl!=null && qty>0)avg=(r.value-r.pnl)/qty;
    if(!r.ticker || !qty || avg==null || price==null){skipped++;return;}
    const h={broker:'PayPay証券',market:'JP',name:(r.name&&r.name!==r.ticker)?r.name:(old?.name||r.ticker),ticker:String(r.ticker),qty:+qty,avg:+avg,price:+price,note:old?.note||'PayPayスクショ更新',updatedAt:new Date().toISOString()};
    if(idx>=0){data.holdings[idx]={...old,...h};updated++;}else{data.holdings.push(h);added++;}
  });
  save();render();runStartupResearch();paypayImportDialog.close();alert(`PayPay一覧を反映しました\n更新 ${updated}件 / 新規 ${added}件${skipped?` / 保留 ${skipped}件`:''}`);
};

document.querySelector('#notifyBtn').onclick=async()=>{if(!('Notification'in window)){alert('このブラウザは通知に対応していません');return}const p=await Notification.requestPermission();if(p==='granted')new Notification('相棒 STOCK',{body:'起動時調査の通知テストです'});};
document.querySelector('#resetBtn').onclick=()=>{if(confirm('保有株・監視株を含む全データを初期化しますか？')){data=clone(seed);save();render();runStartupResearch();}};

if('serviceWorker'in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));}
render();runStartupResearch();
