/* ============ Revanche — engine ============ */
'use strict';

/* ---------- tiny IndexedDB wrapper ---------- */
let db;
function openDB(){
  return new Promise((res,rej)=>{
    const r = indexedDB.open('revanche', 1);
    r.onupgradeneeded = e=>{
      const d = e.target.result;
      d.createObjectStore('cards',{keyPath:'id'});
      d.createObjectStore('state',{keyPath:'cardId'});
      d.createObjectStore('captures',{keyPath:'id',autoIncrement:true});
      d.createObjectStore('meta',{keyPath:'k'});
      d.createObjectStore('media',{keyPath:'path'});
    };
    r.onsuccess = ()=>{db=r.result;res()};
    r.onerror = ()=>rej(r.error);
  });
}
const tx = (store,mode='readonly')=>db.transaction(store,mode).objectStore(store);
const put = (store,val)=>new Promise((res,rej)=>{const q=tx(store,'readwrite').put(val);q.onsuccess=()=>res();q.onerror=()=>rej(q.error)});
const get = (store,key)=>new Promise((res,rej)=>{const q=tx(store).get(key);q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)});
const del = (store,key)=>new Promise((res,rej)=>{const q=tx(store,'readwrite').delete(key);q.onsuccess=()=>res();q.onerror=()=>rej(q.error)});
const all = (store)=>new Promise((res,rej)=>{const q=tx(store).getAll();q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)});
const metaGet = async(k,fallback)=>{const r=await get('meta',k);return r?r.v:fallback};
const metaSet = (k,v)=>put('meta',{k,v});

/* ---------- helpers ---------- */
const $ = id=>document.getElementById(id);
const todayStr = ()=>new Date().toISOString().slice(0,10);
const addDays = (iso,n)=>{const d=new Date(iso+'T12:00:00');d.setDate(d.getDate()+n);return d.toISOString().slice(0,10)};
const shuffle = a=>{for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a};
function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove('show'),2600)}
function go(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));$(id).classList.add('active');
  $('captureFab').style.display = id==='home'?'block':'none';
  if(id==='capture')renderCaptures();
  if(id==='library')renderLibrary();
  if(id==='data')renderData();
}
function confirmQuit(){ if(confirm('Quitter la session ?')){ go('home'); refreshHome(); } }

/* ---------- SRS ---------- */
const INTERVALS = [0,1,2,4,8,16,32,64];           // days by level
const OWNED_LVL = 5;
function applyGrade(st, g, latencyMs){
  // g: 0 raté, 1 presque, 2 nickel
  st.reps=(st.reps||0)+1;
  if(g===2){
    let inc = 1;
    if(latencyMs!=null && latencyMs<3000 && st.level>=1) inc = 2;   // fast retrieval bonus
    st.level = Math.min(7, (st.level||0)+inc);
    st.due = addDays(todayStr(), INTERVALS[Math.min(st.level,INTERVALS.length-1)]);
  }else if(g===1){
    st.due = addDays(todayStr(), st.level>=3?2:1);
  }else{
    st.lapses=(st.lapses||0)+1;
    st.level = Math.max(0,(st.level||0)-2);
    st.due = addDays(todayStr(),1);
  }
  st.lastGrade=g; st.lastSeen=todayStr();
  return st;
}

/* ---------- pack import ---------- */
async function importPack(pack, opts={}){
  if(!pack || !pack.id || !Array.isArray(pack.cards)) throw new Error('Pack invalide');
  const imported = await metaGet('packsImported',[]);
  if(imported.includes(pack.id) && !opts.force){ toast('Pack déjà importé : '+pack.id); return 0; }
  let n=0;
  for(const c of pack.cards){
    if(!c.id || !c.fr) continue;
    c.packId = pack.id;
    await put('cards', c);
    const existing = await get('state', c.id);
    if(!existing){
      await put('state', {cardId:c.id, level:0, due:todayStr(), reps:0, lapses:0,
        introduced: !!c.isPersonal,          // personal cards jump the queue
        order: n + (pack.order||0)});
    }
    n++;
  }
  if(pack.episode){
    await metaSet('episode', {packId:pack.id, ...pack.episode, date: pack.date||todayStr()});
  }
  if(!imported.includes(pack.id)) imported.push(pack.id);
  await metaSet('packsImported', imported);
  if(pack.baseUrl) await metaSet('packsBase', pack.baseUrl);
  // try caching audio in background (works when hosted/online; silently skips otherwise)
  cachePackAudio(pack).catch(()=>{});
  toast(`Pack « ${pack.title||pack.id} » : ${n} phrases`);
  return n;
}
async function cachePackAudio(pack){
  const base = pack.baseUrl || (await metaGet('packsBase','')) || '';
  for(const c of pack.cards){
    if(!c.audio) continue;
    const url = /^https?:/.test(c.audio) ? c.audio : base + c.audio;
    const have = await get('media', c.audio);
    if(have) continue;
    try{
      const r = await fetch(url);
      if(r.ok){ const b = await r.blob(); await put('media',{path:c.audio, blob:b}); }
    }catch(e){/* offline — next time */}
  }
}
async function importPasted(){
  try{ const n = await importPack(JSON.parse($('packPaste').value)); if(n)$('packPaste').value=''; }
  catch(e){ toast('JSON invalide : '+e.message); }
  renderData();
}
function importFile(inp){
  const f=inp.files[0]; if(!f)return;
  f.text().then(t=>importPack(JSON.parse(t))).then(renderData).catch(e=>toast('Erreur : '+e.message));
  inp.value='';
}
async function fetchRemotePacks(){
  try{
    const r = await fetch('packs/index.json?t='+Date.now());
    if(!r.ok) throw new Error('introuvable');
    const list = await r.json();                       // ["seed-001.json", ...]
    const imported = await metaGet('packsImported',[]);
    let added=0;
    for(const f of list){
      const id = f.replace(/\.json$/,'');
      if(imported.includes(id)) continue;
      const p = await (await fetch('packs/'+f)).json();
      added += await importPack(p);
    }
    toast(added? `${added} nouvelles phrases !` : 'Rien de nouveau');
  }catch(e){ toast('Pas de packs en ligne ici ('+e.message+')'); }
  renderData(); refreshHome();
}

/* ---------- audio ---------- */
const player = ()=>$('player');
async function playCardAudio(){
  const c = S.current; if(!c) return;
  await playAudioFor(c);
}
async function playAudioFor(c){
  $('noAudio') && $('noAudio').classList.add('hidden');
  if(c.audio){
    const m = await get('media', c.audio);
    if(m){ player().src = URL.createObjectURL(m.blob); player().play(); return; }
    const base = await metaGet('packsBase','');
    const url = /^https?:/.test(c.audio) ? c.audio : (base||'') + c.audio;
    try{ player().src = url; await player().play(); return; }catch(e){}
  }
  // NO device-TTS fallback, by design.
  if($('noAudio')) $('noAudio').classList.remove('hidden');
}

/* ---------- session ---------- */
const S = { queue:[], idx:0, phase:'', current:null, shownAt:0, done:0, revDone:0, newDone:0, epDone:false, sprintScore:0 };

async function buildQueues(){
  const cards = await all('cards');
  const states = await all('state');
  const stMap = Object.fromEntries(states.map(s=>[s.cardId,s]));
  const t = todayStr();
  const npd = await metaGet('newPerDay',12);
  const rev=[], review=[], fresh=[];
  for(const c of cards){
    const st = stMap[c.id]; if(!st) continue;
    if(c.isPersonal){ if(st.due<=t && st.level<8) rev.push(c); }
    else if(st.introduced){ if(st.due<=t) review.push(c); }
    else fresh.push(c);
  }
  fresh.sort((a,b)=>(stMap[a.id].order||0)-(stMap[b.id].order||0));
  const introducedToday = await metaGet('introducedOn_'+t, 0);
  const news = fresh.slice(0, Math.max(0, npd - introducedToday));
  return {rev, review:shuffle(review), news, stMap};
}

async function startSession(){
  const {rev, review, news} = await buildQueues();
  const ep = await metaGet('episode', null);
  const epDoneOn = await metaGet('episodeDoneOn','');
  S.queue = [...rev.map(c=>({c,phase:'REVANCHE'})),
             ...review.map(c=>({c,phase:'RÈGLEMENT DE COMPTES'})),
             ...news.map(c=>({c,phase:'SANG NEUF'}))];
  S.idx=0; S.done=0; S.revDone=0; S.newDone=0;
  S.pendingEpisode = (ep && epDoneOn!==todayStr()) ? ep : null;
  if(S.queue.length===0 && !S.pendingEpisode){ toast('Rien à régler aujourd\'hui. Capture quelque chose !'); return; }
  // episode goes after revanche cards, before the rest
  if(S.pendingEpisode && rev.length===0){ showEpisode(); return; }
  go('session'); showCard();
}
function showCard(){
  const item = S.queue[S.idx];
  if(!item){ // out of cards → episode if pending, else sprint
    if(S.pendingEpisode){ showEpisode(); return; }
    maybeSprint(); return;
  }
  // episode insertion point: after last REVANCHE card
  if(S.pendingEpisode && item.phase!=='REVANCHE'){ showEpisode(); return; }
  go('session');
  S.current = item.c; S.shownAt = Date.now();
  $('phaseTag').textContent = item.phase;
  $('sessCount').textContent = (S.idx+1)+' / '+S.queue.length;
  $('sessProg').style.width = (100*S.idx/S.queue.length)+'%';
  $('cardPrompt').textContent = item.c.en || '(traduis : '+item.c.fr+')';
  const org = $('captureOrigin');
  if(item.c.isPersonal && item.c.origin){ org.textContent='📍 '+item.c.origin; org.classList.remove('hidden'); }
  else org.classList.add('hidden');
  $('answerZone').classList.add('hidden');
  $('revealBtn').classList.remove('hidden');
}
function reveal(){
  S.latency = Date.now()-S.shownAt;
  $('revealBtn').classList.add('hidden');
  $('cardAnswer').textContent = S.current.fr;
  $('cardNote').textContent = S.current.note||'';
  $('answerZone').classList.remove('hidden');
  playAudioFor(S.current);
}
async function grade(g){
  const c = S.current;
  let st = await get('state', c.id);
  const wasNew = !st.introduced;
  st.introduced = true;
  st = applyGrade(st, g, g===2?S.latency:null);
  await put('state', st);
  if(wasNew && !c.isPersonal){
    const k='introducedOn_'+todayStr();
    await metaSet(k, (await metaGet(k,0))+1);
  }
  S.done++; if(c.isPersonal)S.revDone++; if(wasNew)S.newDone++;
  if(g===0 && S.idx < S.queue.length-1){           // requeue failed card later in session
    const item = S.queue[S.idx];
    S.queue.splice(Math.min(S.idx+4, S.queue.length), 0, item);
  }
  S.idx++;
  showCard();
}

/* ---------- episode (shadow) ---------- */
function showEpisode(){
  const ep = S.pendingEpisode;
  go('episode');
  $('epTitle').textContent = ep.title||'Épisode';
  const wrap = $('epLines'); wrap.innerHTML='';
  (ep.transcript||[]).forEach(l=>{
    const d=document.createElement('div'); d.className='ep-line';
    d.innerHTML = `<span class="spk">${l.speaker||''}</span><br>${l.fr}` + (l.en?`<span class="en">${l.en}</span>`:'');
    wrap.appendChild(d);
  });
  player().src = ep.mp3; player().load();
  $('epPlayBtn').textContent='▶ Lecture';
}
function epToggle(){
  const p=player();
  if(p.paused){ p.play(); $('epPlayBtn').textContent='⏸ Pause'; }
  else{ p.pause(); $('epPlayBtn').textContent='▶ Lecture'; }
}
function epSeek(s){ try{ player().currentTime = Math.max(0, player().currentTime+s); }catch(e){} }
async function epDone(){
  player().pause();
  await metaSet('episodeDoneOn', todayStr());
  S.pendingEpisode=null; S.epDone=true;
  if(S.idx < S.queue.length){ go('session'); showCard(); } else maybeSprint();
}

/* ---------- sprint ---------- */
const SP = { pool:[], i:0, t:120, timer:null, score:0, combo:0, best:0, solo:false, shownAt:0 };
async function maybeSprint(){
  const pool = await sprintPool();
  if(pool.length>=8){ SP.solo=false; openSprint(pool); }
  else showRecap();
}
async function startSprintOnly(){
  const pool = await sprintPool();
  if(pool.length<8){ toast('Pas encore assez de phrases solides (il en faut 8+)'); return; }
  SP.solo=true; openSprint(pool);
}
async function sprintPool(){
  const cards = await all('cards'); const states = await all('state');
  const stMap = Object.fromEntries(states.map(s=>[s.cardId,s]));
  let pool = cards.filter(c=>stMap[c.id] && stMap[c.id].introduced && stMap[c.id].level>=3);
  if(pool.length<8) pool = cards.filter(c=>stMap[c.id] && stMap[c.id].introduced && stMap[c.id].level>=2);
  return shuffle(pool);
}
function openSprint(pool){
  SP.pool=pool; SP.i=0; SP.t=120; SP.score=0; SP.combo=0;
  go('sprint');
  $('sprintTimer').textContent='2:00';
  $('sprintScore').textContent='';
  $('sprintPrompt').textContent='Prêt ?';
  $('sprintStartBtn').classList.remove('hidden');
  $('sprintRevealBtn').classList.add('hidden');
  $('sprintAnswerZone').classList.add('hidden');
}
function sprintStart(){
  $('sprintStartBtn').classList.add('hidden');
  SP.timer = setInterval(()=>{
    SP.t--;
    $('sprintTimer').textContent = Math.floor(SP.t/60)+':'+String(SP.t%60).padStart(2,'0');
    if(SP.t<=0) sprintEnd();
  },1000);
  sprintNext();
}
function sprintNext(){
  if(SP.i>=SP.pool.length) SP.i=0;
  SP.cur = SP.pool[SP.i++]; SP.shownAt=Date.now();
  $('sprintPrompt').textContent = SP.cur.en||SP.cur.fr;
  $('sprintRevealBtn').classList.remove('hidden');
  $('sprintAnswerZone').classList.add('hidden');
}
function sprintReveal(){
  SP.lat = Date.now()-SP.shownAt;
  $('sprintAnswer').textContent = SP.cur.fr;
  $('sprintRevealBtn').classList.add('hidden');
  $('sprintAnswerZone').classList.remove('hidden');
}
async function sprintGrade(ok){
  if(ok){
    SP.combo++;
    const speedPts = Math.max(0, 8 - Math.floor(SP.lat/1000));
    SP.score += 10 + speedPts + Math.min(SP.combo,10);
    $('sprintScore').innerHTML = SP.score+' pts <span class="combo">'+(SP.combo>=3?'×'+SP.combo+' combo !':'')+'</span>';
  }else{
    SP.combo=0;
    $('sprintScore').textContent = SP.score+' pts';
    const st = await get('state', SP.cur.id);          // a sprint fail is a real signal
    if(st){ st.due=addDays(todayStr(),1); await put('state',st); }
  }
  sprintNext();
}
async function sprintEnd(){
  clearInterval(SP.timer);
  const best = await metaGet('bestSprint',0);
  if(SP.score>best){ await metaSet('bestSprint',SP.score); toast('🏆 NOUVEAU RECORD !'); }
  if(SP.solo){ go('home'); refreshHome(); toast('Sprint : '+SP.score+' pts'); }
  else showRecap();
}

/* ---------- recap ---------- */
async function showRecap(){
  go('recap');
  $('recapNum').textContent = S.done;
  const owned = await countOwned();
  $('recapDetail').innerHTML =
    (S.revDone?`⚔️ ${S.revDone} revanche${S.revDone>1?'s':''} réglée${S.revDone>1?'s':''}<br>`:'')+
    (S.epDone?`🎧 épisode shadowé<br>`:'')+
    (S.newDone?`✨ ${S.newDone} nouvelles phrases<br>`:'')+
    (SP.score&&!SP.solo?`⚡ sprint : ${SP.score} pts<br>`:'')+
    `👑 ${owned} phrases possédées au total`;
  const sessions = await metaGet('sessions',0); await metaSet('sessions',sessions+1);
  SP.score=0; S.epDone=false;
}

/* ---------- capture ---------- */
let rec=null, recChunks=[];
async function toggleRec(){
  const btn=$('recBtn');
  if(rec && rec.state==='recording'){ rec.stop(); return; }
  try{
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    const mime = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' :
                 MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    rec = new MediaRecorder(stream, mime?{mimeType:mime}:{});
    recChunks=[];
    rec.ondataavailable = e=>recChunks.push(e.data);
    rec.onstop = async ()=>{
      stream.getTracks().forEach(t=>t.stop());
      const blob = new Blob(recChunks,{type:rec.mimeType});
      await put('captures',{text:'', audio:blob, mime:rec.mimeType, date:new Date().toISOString()});
      btn.classList.remove('recording'); $('recState').textContent='enregistré ✓';
      renderCaptures(); refreshHome();
    };
    rec.start();
    btn.classList.add('recording'); $('recState').textContent='… appuie pour arrêter';
  }catch(e){ toast('Micro refusé : '+e.message); }
}
async function saveTextCapture(){
  const t=$('capText').value.trim(); if(!t)return;
  await put('captures',{text:t, audio:null, date:new Date().toISOString()});
  $('capText').value=''; renderCaptures(); refreshHome();
}
async function renderCaptures(){
  const caps = await all('captures');
  $('capCount').textContent = caps.length?('('+caps.length+')'):'';
  const w=$('capList'); w.innerHTML = caps.length?'':'<p class="dim small">Rien en attente. C\'est que tu parles bien.</p>';
  caps.sort((a,b)=>b.id-a.id).forEach(c=>{
    const d=document.createElement('div'); d.className='capture-item';
    const date = new Date(c.date).toLocaleDateString('fr-FR',{day:'numeric',month:'short'});
    d.innerHTML=`<div style="flex:1">${c.text?c.text:'🎙 audio'}<div class="dim small">${date}</div></div>`;
    if(c.audio){ const b=document.createElement('button');b.textContent='▶';b.style.padding='8px 12px';
      b.onclick=()=>{player().src=URL.createObjectURL(c.audio);player().play()}; d.appendChild(b); }
    const x=document.createElement('button');x.textContent='✕';x.style.padding='8px 12px';
    x.onclick=async()=>{await del('captures',c.id);renderCaptures();refreshHome()}; d.appendChild(x);
    $('capList').appendChild(d);
  });
}
async function exportCaptures(){
  const caps = await all('captures');
  if(!caps.length){ toast('Rien à envoyer'); return; }
  const lines = caps.map(c=>`- [${c.date.slice(0,10)}] ${c.text||'(voir audio joint)'}`).join('\n');
  const msg = `Salut Claude — voici mes captures Revanche à transformer en cartes :\n${lines}\n\nFais-en un pack JSON avec audio, s'il te plaît.`;
  const files = caps.filter(c=>c.audio).map((c,i)=>{
    const ext = (c.mime||'').includes('mp4')?'m4a':'webm';
    return new File([c.audio], `capture-${c.date.slice(0,10)}-${i+1}.${ext}`, {type:c.mime||'audio/webm'});
  });
  if(navigator.canShare && files.length && navigator.canShare({files})){
    try{ await navigator.share({text:msg, files}); toast('Partagé !'); return; }catch(e){}
  }
  // fallback: clipboard + individual downloads
  try{ await navigator.clipboard.writeText(msg); toast('Texte copié — colle-le à Claude'+(files.length?' (audios téléchargés)':'')); }catch(e){}
  files.forEach(f=>{ const a=document.createElement('a');a.href=URL.createObjectURL(f);a.download=f.name;a.click(); });
}

/* ---------- library ---------- */
async function renderLibrary(){
  const cards = await all('cards'); const states = await all('state');
  const stMap = Object.fromEntries(states.map(s=>[s.cardId,s]));
  const q = ($('libSearch').value||'').toLowerCase();
  const list = cards.filter(c=>!q || (c.fr+' '+(c.en||'')+' '+(c.scene||'')).toLowerCase().includes(q));
  $('libCount').textContent = cards.length+' phrases';
  const w=$('libList'); w.innerHTML='';
  list.sort((a,b)=>(stMap[b.id]?.level||0)-(stMap[a.id]?.level||0)).slice(0,200).forEach(c=>{
    const st=stMap[c.id]||{level:0};
    const d=document.createElement('div'); d.className='lib-card';
    const lvl = st.level>=OWNED_LVL?'<span class="lvl owned">👑 possédée</span>':'<span class="lvl">niv. '+st.level+'</span>';
    const trophy = c.isPersonal? `<button class="trophy-btn" title="Utilisée en vrai !" onclick="claimTrophy('${c.id}',event)">${st.trophy?'🏆':'🎯'}</button>`:'';
    d.innerHTML = `<div style="display:flex;justify-content:space-between;gap:8px"><div><div class="fr">${c.fr}</div><div class="en">${c.en||''}</div>${lvl} <span class="dim small">${c.scene||''}</span></div>${trophy}</div>`;
    w.appendChild(d);
  });
}
async function claimTrophy(id,ev){
  ev.stopPropagation();
  const st = await get('state',id);
  st.trophy=true; st.level=8; st.due=addDays(todayStr(),365);
  await put('state',st);
  toast('🏆 REVANCHE ACCOMPLIE. Utilisée en vrai !');
  renderLibrary(); refreshHome();
}

/* ---------- home / data ---------- */
async function countOwned(){
  const states = await all('state');
  return states.filter(s=>s.level>=OWNED_LVL).length;
}
async function refreshHome(){
  const cards = await all('cards'); const states = await all('state');
  const stMap = Object.fromEntries(states.map(s=>[s.cardId,s]));
  const t=todayStr();
  let due=0, rev=0;
  for(const c of cards){
    const st=stMap[c.id]; if(!st)continue;
    if(c.isPersonal && st.due<=t && st.level<8) rev++;
    else if(st.introduced && st.due<=t) due++;
  }
  $('stOwned').textContent = states.filter(s=>s.level>=OWNED_LVL).length;
  $('stDue').textContent = due;
  $('stRev').textContent = rev;
  $('bestSprint').textContent = (await metaGet('bestSprint',0))||'—';
  const caps = await all('captures');
  $('capSummary').textContent = caps.length? caps.length+' moment(s) à venger' : 'Rien en attente';
  const scenes = [...new Set(cards.map(c=>c.scene).filter(Boolean))];
  $('libSummary').textContent = cards.length+' phrases · '+scenes.length+' scènes';
}
async function renderData(){
  const imported = await metaGet('packsImported',[]);
  const cards = await all('cards');
  $('npdNow').textContent = await metaGet('newPerDay',12);
  $('dataInfo').textContent = `${imported.length} packs importés · ${cards.length} phrases · v1`;
}
async function setNewPerDay(n){ await metaSet('newPerDay',n); $('npdNow').textContent=n; toast(n+' nouvelles par jour'); }

/* ---------- backup ---------- */
async function exportBackup(){
  const data = { cards:await all('cards'), state:await all('state'), meta:await all('meta'),
                 captures:(await all('captures')).map(c=>({text:c.text,date:c.date})) };
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'}));
  a.download='revanche-backup-'+todayStr()+'.json'; a.click();
}
async function restoreBackup(inp){
  const f=inp.files[0]; if(!f)return;
  try{
    const data = JSON.parse(await f.text());
    for(const c of data.cards||[]) await put('cards',c);
    for(const s of data.state||[]) await put('state',s);
    for(const m of data.meta||[]) await put('meta',m);
    toast('Restauré !'); refreshHome();
  }catch(e){ toast('Erreur : '+e.message); }
  inp.value='';
}

/* ---------- boot ---------- */
(async function(){
  await openDB();
  await refreshHome();
  // auto-check for new packs (silent) when online & hosted
  if(navigator.onLine){ fetch('packs/index.json',{method:'HEAD'}).then(r=>{ if(r.ok) fetchRemotePacks(); }).catch(()=>{}); }
  if('serviceWorker' in navigator){ navigator.serviceWorker.register('sw.js').catch(()=>{}); }
})();
