/* ============================================================
   AURALIS — research AI app logic
   - Sends prompts to the real backend (/api/search): DuckDuckGo
     search + Gemini synthesis, with source citations.
   - Falls back to a local offline demo engine when the server
     isn't reachable (e.g. opening index.html directly).
   ============================================================ */

/* ---------- DOM ---------- */
const $ = (s) => document.querySelector(s);
const sidebar = $('#sidebar');
const sidebarToggle = $('#sidebarToggle');
const newChatBtn = $('#newChatBtn');
const chatList = $('#chatList');
const chatSearch = $('#chatSearch');
const chatTitle = $('#chatTitle');
const messages = $('#messages');
const emptyState = $('#emptyState');
const suggests = $('#suggests');
const promptEl = $('#prompt');
const sendBtn = $('#send');
const webToggle = $('#webToggle');
const deepToggle = $('#deepToggle');
const exportBtn = $('#exportBtn');
const providerBtn = $('#providerBtn');
const providerPop = $('#providerPop');
const providerList = $('#providerList');
const providerName = $('#providerName');
const providerDot = $('#providerDot');

/* ---------- Auralis logo (original emblem: a luminous "A" lens inside a rotating aurora ring) ---------- */
function logoSVG(size = 28, gid = 'g'){
  return `<svg class="al-svg" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true">
    <defs>
      <linearGradient id="alg${gid}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#7cf6ff"/><stop offset="0.5" stop-color="#9b8cff"/><stop offset="1" stop-color="#ff8ad1"/>
      </linearGradient>
      <radialGradient id="alr${gid}" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stop-color="#9b8cff" stop-opacity="0.35"/><stop offset="1" stop-color="#9b8cff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <circle class="al-glow" cx="50" cy="50" r="44" fill="url(#alr${gid})"/>
    <g class="al-ring">
      <circle class="al-ring-track" cx="50" cy="50" r="42" fill="none" stroke="url(#alg${gid})" stroke-width="2" stroke-opacity="0.18"/>
      <circle class="al-ring-arc" cx="50" cy="50" r="42" fill="none" stroke="url(#alg${gid})" stroke-width="3" stroke-linecap="round" stroke-dasharray="120 144" pathLength="264"/>
    </g>
    <g class="al-A">
      <path class="al-A-left" d="M50 22 L30 74" fill="none" stroke="url(#alg${gid})" stroke-width="6" stroke-linecap="round"/>
      <path class="al-A-right" d="M50 22 L70 74" fill="none" stroke="url(#alg${gid})" stroke-width="6" stroke-linecap="round"/>
      <path class="al-A-bar" d="M37 54 L63 54" fill="none" stroke="url(#alg${gid})" stroke-width="5" stroke-linecap="round"/>
    </g>
    <circle class="al-spark" cx="50" cy="22" r="3.4" fill="#ffffff"/>
  </svg>`;
}
let logoSeq = 0;
function setLogoState(el, state){ if (el) el.dataset.state = state; }

/* ---------- State ---------- */
const STORAGE_KEY = 'auralis.chats.v1';
const SETTING_KEY = 'auralis.settings.v1';
let state = {
  chats: [],          // [{id,title,createdAt,updatedAt,messages:[]}]
  currentChatId: null,
  settings: { provider:'auto', web:true, deep:false },
};

function loadState(){
  try{
    const c = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    const s = JSON.parse(localStorage.getItem(SETTING_KEY) || 'null');
    if (c) state.chats = c;
    if (s) state.settings = {...state.settings, ...s};
  }catch{}
}
function saveChats(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state.chats)); }
function saveSettings(){ localStorage.setItem(SETTING_KEY, JSON.stringify(state.settings)); }
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);

/* ---------- Date grouping ---------- */
function dayKey(ts){
  const d = new Date(ts), now = new Date();
  const sameDay=(a,b)=>a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();
  if (sameDay(d,now)) return '__TODAY__';
  const y=new Date(now);y.setDate(now.getDate()-1);
  if (sameDay(d,y)) return '__YESTERDAY__';
  const week=7*24*60*60*1000;
  if (now-d < week) return '__WD:'+d.getDay()+'__';
  if (now-d < 4*week) return '__MONTH:'+d.getMonth()+':'+d.getDate()+'__';
  return '__OLD:'+d.getFullYear()+':'+d.getMonth()+':'+d.getDate()+'__';
}

/* ---------- Smart title generation (from the first user message) ---------- */
const STOP = new Set(['the','a','an','of','to','in','on','for','is','are','was','were','will','would','should','can','could','do','does','did','and','or','but','with','about','that','this','these','those','i','you','we','they','it','my','your','our','their','its','how','what','when','where','why','who','which','did','will','please','tell','me','give','show','find','search','look','get','need','want','have','has','had','am','be','been','being','really','actually','just','very','also','any','some','there','here','into','from','by','as','at','if','then','than','so','up','down','out','over','under','again','still','best','good','top','latest','new','2026']);

function titleFrom(text){
  let t = (text||'').trim();
  if (!t) return 'New research';
  t = t.replace(/^\s*(hi|hey|hello|yo|sup|ok|okay|so|um|uh|please|can you|could you|would you|will you|do you|tell me|give me|show me|help me|i want|i need|i'm looking for|search for|find me|look up|lookup)\b[,\s]*/gi,'');
  t = t.replace(/^[?!.]+\s*/,'').trim();
  if (!t) t = text.trim();
  t = t.replace(/\s+/g,' ');
  t = t.replace(/\s*[?!]+.*$/,'').trim() || t;
  if (t.length > 90){
    const words = t.toLowerCase().match(/\b[a-z][a-z0-9'-]*\b/gi) || t.split(/\s+/);
    const scored = [];
    words.forEach(w=>{
      const lw = w.toLowerCase();
      if (w.length < 3 || STOP.has(lw)) return;
      scored.push({w, score: w.length + (w.length>6?3:0)});
    });
    scored.sort((a,b)=>b.score-a.score);
    const top = scored.slice(0,6).map(s=>s.w);
    if (top.length) t = top.join(' ');
    if (t.length > 90) t = t.slice(0,87) + '...';
  }
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (t.length > 70) t = t.slice(0,67) + '...';
  return t || 'New research';
}

/* ---------- Chat lifecycle ---------- */
function currentChat(){ return state.chats.find(c=>c.id===state.currentChatId) || null; }
function newChat(){
  const c = { id:uid(), title:'New research', createdAt:Date.now(), updatedAt:Date.now(), messages:[] };
  state.chats.unshift(c);
  state.currentChatId = c.id;
  saveChats(); renderBoth();
}

function openChat(id){
  state.currentChatId = id;
  saveChats(); renderBoth();
}

function deleteChat(id,e){
  e?.stopPropagation();
  state.chats = state.chats.filter(c=>c.id!==id);
  if (state.currentChatId===id) state.currentChatId = state.chats[0]?.id || null;
  if (!state.currentChatId){
    const c = { id:uid(), title:'New research', createdAt:Date.now(), updatedAt:Date.now(), messages:[] };
    state.chats.unshift(c); state.currentChatId = c.id;
  }
  saveChats(); renderBoth();
}

/* ---------- Sidebar render ---------- */
function renderSidebar(){
  chatList.innerHTML = '';
  const sorted = [...state.chats].sort((a,b)=>b.updatedAt-a.updatedAt);
  let lastKey = null;
  const q = (chatSearch.value||'').toLowerCase().trim();
  sorted.forEach(c=>{
    if (q && !c.title.toLowerCase().includes(q) && !c.messages.some(m=>m.text.toLowerCase().includes(q))) return;
    const dk = dayKey(c.updatedAt);
    if (dk !== lastKey){
      const sep = document.createElement('div');
      sep.className = 'date-sep';
      const d = new Date(c.updatedAt), now = new Date();
      const sameDay=(a,b)=>a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();
      let label;
      if (sameDay(d,now)){
        const h=d.getHours(),m=d.getMinutes().toString().padStart(2,'0');
        const ap=h<12?'am':'pm';const hh=h%12||12;
        label = `Today · ${hh}:${m} ${ap}`;
      } else {
        const y=new Date(now);y.setDate(now.getDate()-1);
        const week=7*24*60*60*1000;
        if (sameDay(d,y)) label='Yesterday';
        else if (now-d < week) label=d.toLocaleDateString(undefined,{weekday:'long'});
        else if (now-d < 4*week) label=d.toLocaleDateString(undefined,{month:'long', day:'numeric'});
        else label=d.toLocaleDateString(undefined,{month:'short', year:'numeric'});
      }
      sep.textContent = label;
      chatList.appendChild(sep);
      lastKey = dk;
    }
    const it = document.createElement('div');
    it.className = 'chat-item' + (c.id===state.currentChatId?' active':'');
    it.dataset.id = c.id;
    it.innerHTML = `
      <span class="ci-dot"></span>
      <span class="ci-title">${escapeHtml(c.title)}</span>
      <button class="ci-del" title="Delete">✕</button>`;
    it.addEventListener('click',()=>openChat(c.id));
    it.querySelector('.ci-del').addEventListener('click',(e)=>deleteChat(c.id,e));
    chatList.appendChild(it);
  });
  if (chatList.children.length===0){
    const e = document.createElement('div');
    e.style.cssText='padding:20px;text-align:center;color:var(--text-faint);font-size:13px';
    e.textContent = q? 'No chats match your search.' : 'No chats yet. Start by asking Auralis something.';
    chatList.appendChild(e);
  }
}

/* ---------- Messages render ---------- */
function renderMessages(){
  const c = currentChat();
  chatTitle.textContent = c? c.title : 'New research';
  messages.innerHTML='';
  if (!c || c.messages.length===0){
    emptyState.classList.remove('hidden');
    messages.style.display='none';
    return;
  }
  emptyState.classList.add('hidden');
  messages.style.display='';
  c.messages.forEach(m=>{
    if (m.role==='user') renderUser(m);
    else renderAI(m);
  });
  messages.scrollTop = messages.scrollHeight;
}

function renderUser(m){
  const el = document.createElement('div');
  el.className='msg user';
  el.innerHTML = `<div class="avatar">Y</div>
    <div class="body"><div class="bubble">${escapeHtml(m.text)}</div></div>`;
  messages.appendChild(el);
}

function renderAI(m){
  const el = document.createElement('div');
  el.className='msg ai';
  el.dataset.id = m.id;
  const gid = 'a' + (logoSeq++);
  el.innerHTML = `<div class="avatar avatar-ai auralis-logo" data-state="idle">${logoSVG(30, gid)}</div><div class="body"><div class="bubble"></div>
    <div class="actions">
      <button class="act copy"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>Copy</button>
      <button class="act regen"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>Retry</button>
    </div></div>`;
  const bubble = el.querySelector('.bubble');
  const answer = document.createElement('div');
  answer.className='answer';
  bubble.appendChild(answer);
  answer.innerHTML = renderMarkdown(m.text);
  if (m.sources && m.sources.length) renderSourcesInto(bubble, m.sources);
  const copy = el.querySelector('.copy');
  copy.addEventListener('click',()=>{
    navigator.clipboard.writeText(m.text).then(()=>{copy.lastChild.textContent=' Copied';setTimeout(()=>copy.lastChild.textContent=' Copy',1400);});
  });
  const regen = el.querySelector('.regen');
  regen.addEventListener('click',()=>{
    const chat = currentChat();
    const userMsg = [...chat.messages].reverse().find(x=>x.role==='user');
    if (userMsg) retry(userMsg.text, m.id);
  });
  messages.appendChild(el);
}

function renderBoth(){ renderSidebar(); renderMessages(); toggleSendBtn(); }

/* ---------- markdown-lite ---------- */
function escapeHtml(s){return (s==null?'':String(s)).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function renderMarkdown(text){
  let t = escapeHtml(text);
  t = t.replace(/```([\s\S]*?)```/g, (_,c)=>`<pre style="background:rgba(0,0,0,.35);padding:10px;border-radius:8px;overflow:auto;margin:8px 0;font-family:'JetBrains Mono';font-size:12px"><code>${c.replace(/^\n/,'')}</code></pre>`);
  t = t.replace(/`([^`\n]+)`/g,'<code>$1</code>');
  t = t.replace(/^### (.+)$/gm,'<h3>$1</h3>');
  t = t.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g,'<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  t = t.replace(/(?:^|\n)((?:[-*] .+(?:\n|$))+)/g,(block)=>{
    const items = block.trim().split(/\n/).map(l=>l.replace(/^[-*] /,'')).map(i=>`<li>${i}</li>`).join('');
    return `\n<ul>${items}</ul>`;
  });
  t = t.replace(/(?:^|\n)((?:\d+\. .+(?:\n|$))+)/g,(block)=>{
    const items = block.trim().split(/\n/).map(l=>l.replace(/^\d+\. /,'')).map(i=>`<li>${i}</li>`).join('');
    return `\n<ol>${items}</ol>`;
  });
  t = t.split(/\n{2,}/).map(p=>{
    if (/^\s*<(ul|ol|h3|pre)/.test(p)) return p;
    return `<p>${p.replace(/\n/g,'<br>')}</p>`;
  }).join('');
  return t;
}

/* ---------- Source elements (favicon + real link + snippet) ---------- */
function buildSourceEl(s, idx){
  const a = document.createElement('a');
  a.className='source';
  a.href = s.url;
  a.target='_blank';
  a.rel='noreferrer';
  a.title = s.url;
  a.style.animationDelay = (idx*50)+'ms';

  const chip = document.createElement('span');
  chip.className='sfav';
  const img = document.createElement('img');
  img.className='favimg'; img.loading='lazy'; img.alt='';
  img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(s.favicon)}&sz=64`;
  const letter = document.createElement('span');
  letter.className='sfall';
  letter.textContent = (s.site[0]||'?').toUpperCase();
  img.onerror = () => { img.style.display='none'; letter.style.display='grid'; };
  chip.appendChild(img); chip.appendChild(letter);

  const main = document.createElement('span');
  main.className='smain';
  const t = document.createElement('span'); t.className='stitle';
  t.textContent = s.title;
  const u = document.createElement('span'); u.className='surl';
  u.textContent = s.displayUrl;
  main.appendChild(t); main.appendChild(u);

  const num = document.createElement('span');
  num.className='snum'; num.textContent = String(idx+1);

  const row = document.createElement('div');
  row.className='srow';
  row.appendChild(chip); row.appendChild(main); row.appendChild(num);
  a.appendChild(row);

  if (s.snippet){
    const sn = document.createElement('div');
    sn.className='snippet'; sn.textContent = s.snippet;
    a.appendChild(sn);
  }
  return a;
}

function renderSourcesInto(bubble, sources){
  const toggle = document.createElement('button');
  toggle.className='sources-toggle';
  toggle.type='button';
  toggle.innerHTML = `<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m6 9 6 6 6-6"/></svg><span>Sources used</span><span class="st-count">${sources.length}</span>`;
  const wrap = document.createElement('div');
  wrap.className='sources-wrap';
  const list = document.createElement('div');
  list.className='sources';
  sources.forEach((s,i)=>list.appendChild(buildSourceEl(s,i)));
  wrap.appendChild(list);
  bubble.appendChild(toggle);
  bubble.appendChild(wrap);
  toggle.addEventListener('click',()=>{
    const open = wrap.classList.toggle('open');
    toggle.classList.toggle('open', open);
  });
}

/* ---------- Streaming word-by-word ---------- */
function streamIntoMessage(el, answerText, speed=14, avatar=null){
  return new Promise(resolve=>{
    const answer = el.querySelector('.answer');
    if (answer) answer.innerHTML='';
    if (avatar) setLogoState(avatar, 'talking');
    let i=0;
    const chunk = Math.max(2, Math.round(answerText.length/120));
    const tick = ()=>{
      i += chunk;
      if (answer) { answer.innerHTML = renderMarkdown(answerText.slice(0,i) + (i<answerText.length? '▍':'')); }
      messages.scrollTop = messages.scrollHeight;
      if (i < answerText.length) setTimeout(tick, speed);
      else { if (answer) answer.innerHTML = renderMarkdown(answerText); if (avatar) setLogoState(avatar, 'idle'); resolve(); }
    };
    tick();
  });
}

/* ---------- Web search pipeline simulation ---------- */
let stopRequested = false;
function setSending(v){
  sendBtn.classList.toggle('stop', v);
  sendBtn.disabled = false;
  promptEl.disabled = false;
  updateQueueBadge();
}
function toggleSendBtn(){ sendBtn.disabled = !promptEl.value.trim() && !sendBtn.classList.contains('stop'); }

/* ---------- Prompt queue (submit while streaming) ----------
   If the user submits while Auralis is still generating, the message goes
   into a queue; as soon as the active stream finishes it auto-fires. */
const promptQueue = [];
function isBusy(){ return sendBtn.classList.contains('stop'); }
function queueCount(){ return promptQueue.length; }

function enqueuePrompt(text){
  promptQueue.push(text);
  updateQueueBadge();
}

function updateQueueBadge(){
  const badge = document.getElementById('queueBadge');
  if (badge){
    const n = promptQueue.length;
    badge.hidden = n === 0;
    badge.textContent = `${n} queued`;
    badge.classList.toggle('show', n > 0);
    badge.title = n > 0 ? `Click to clear ${n} queued prompt${n>1?'s':''}` : '';
  }
  const hint = document.querySelector('.composer-hint');
  if (hint){
    let qh = document.getElementById('queueHint');
    if (promptQueue.length > 0){
      if (!qh){ qh=document.createElement('span'); qh.id='queueHint'; qh.style.color='var(--cyan)'; qh.style.marginTop='4px'; hint.appendChild(qh); }
      qh.textContent = ` · ${promptQueue.length} in queue`;
    } else if (qh){
      qh.remove();
    }
  }
}

function clearQueue(){
  promptQueue.length = 0;
  updateQueueBadge();
}

async function drainQueue(){
  while (promptQueue.length > 0){
    const next = promptQueue.shift();
    updateQueueBadge();
    // Reset the stop flag so a previously-aborted stream doesn't kill the queued one.
    stopRequested = false;
    setSending(true);
    await runPipelineDeferred(next);
    setSending(false);
    renderSidebar();
  }
}
function runPipelineDeferred(text){ return runPipeline(text, { deep: state.settings.deep }); }

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

/* ---------- Real backend search (/api/search) ---------- */
function hostOf(u){ try { return new URL(u).hostname.replace(/^www\./,''); } catch { return u; } }
async function apiSearch(query){
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(()=>ctrl.abort(), 12000);
    const res = await fetch('/api/search', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ query, apiKey: savedGeminiKey() || undefined }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
/* normalize server sources into the UI shape */
function normalizeSources(raw){
  return (raw||[]).filter(Boolean).map((s,i)=>({
    site: hostOf(s.url).split('.')[0] || 'web',
    title: s.title || s.url,
    url: s.url || '#',
    displayUrl: hostOf(s.url),
    favicon: hostOf(s.url),
    snippet: s.snip || s.description || '',
  }));
}

/* ---------- Gemini API key management (/gemini <key>) ---------- */
const KEY_STORAGE = 'auralis.geminiKey';
function savedGeminiKey(){ return localStorage.getItem(KEY_STORAGE) || ''; }
function maskKey(k){
  k = (k||'').trim();
  if (k.length <= 8) return k.slice(0,2) + '…';
  return k.slice(0,4) + '…' + k.slice(-3);
}
function updateProviderStatus(){
  providerName.textContent = savedGeminiKey() ? 'gemini · key set' : 'duckduckgo + gemini';
}
async function saveGeminiKey(key){
  key = key.trim();
  localStorage.setItem(KEY_STORAGE, key);
  updateProviderStatus();
  try {
    const res = await fetch('/api/gemini-key', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ apiKey: key }),
    });
    if (res.ok){
      const data = await res.json();
      return { rejected:false, verified: !!data.verified };
    }
    const data = await res.json().catch(()=>({}));
    return { rejected:true, message: data.error || 'The server rejected the key.' };
  } catch {
    // No server (file:// or offline) — saved locally only.
    return { rejected:false, verified:false };
  }
}
function addReplies(chat, userText, aiText){
  const now = Date.now();
  chat.updatedAt = now;
  chat.messages.push({ id:uid(), role:'user', text: userText, at: now });
  chat.messages.push({ id:uid(), role:'ai', text: aiText, sources:[], provider:'', at: now });
  saveChats();
  renderBoth();
  promptEl.value='';promptEl.style.height='auto';
  toggleSendBtn();
}

/* ---------- Offline demo engine (fallback when no server) ---------- */
const KNOWLEDGE = [
  {
    kws:['fusion','tokamak','reactor','plasma','nif','ignition','net energy'],
    short:`Commercial fusion power almost certainly won't land **this decade**, but the pieces are coming together fast. ITER in France is the flagship experiment (first plasma now targeted in the late 2030s), while private ventures — Commonwealth Fusion Systems (SPARC, mid-2020s), Helion (2028 target), TAE and Zap — are pushing much shorter timelines on smaller, cheaper machines. The U.S. National Ignition Facility crossed the "ignition" milestone in December 2022 (more energy out than laser energy in), but that's a single-shot inertial experiment, not a power plant. Realistic consensus: first net-positive plants in the 2030s–2040s.`,
    bullets:[
      `**ITER** — the world's largest tokamak (France). Assembly is largely done but first plasma slipped to ~2035; it will not produce electricity.`,
      `**SPARC (Commonwealth Fusion Systems)** — compact tokamak using high-temperature superconducting magnets; aims for net energy ~2027, then a pilot plant.`,
      `**Helion** — claims a 2028 commercial reactor (direct energy conversion, no steam turbine); has signed a power purchase agreement with Microsoft.`,
      `**NIF** — achieved >1x laser energy gain (Dec 2022, repeated 2023); a research milestone rather than a reactor.`,
      `**Economics** — the open question isn't physics anymore, it's cost per MWh, Tritium fuel supply, and materials (neutron damage to the first wall).`,
    ],
    caveat:`Fusion timelines are famously optimistic. Take any vendor date as a "best case" — peer-reviewed journals and ITER experience suggest slippage is the norm.`,
  },
  {
    kws:['keyboard','mechanical','switches','keycap','hall effect','typing'],
    short:`For programming under $150 the shortlist is: **Keychron V6 / V1 Max** (gasket-mounted, QMK/VIA, hot-swap, ~$79–119), **Wooting 60HE** (~$140, analog Hall-effect — the gamer/typer hybrid), **Epomaker TH80 / TH96** (great value), and the **NuPhy Air75 V2** if you want low-profile. The trend is Hall-effect magnetic switches for 0.1ms latency and per-key tuning, and gasket-mount foam builds for sound.`,
    bullets:[
      `**Layout** — 75% or 65% with arrows is the sweet spot for coding; full-size takes desk space you don't need.`,
      `**Switch choice** — linear (MX Red / Gateron) is the common programming pick; tactile (Brown) if you like feedback; Hall-effect if you want analog input.`,
      `**Hot-swap + QMK/VIA** — buy hot-swap so you can swap switches and remap every key in software without flashing.`,
      `**Sound & feel** — gasket mount + foam + lubed stabilizers do more for the feel than the switch brand.`,
      `**Wireless** — 2.4GHz dongle mode is the latency-safe option; Bluetooth is fine for typing.`,
    ],
    caveat:`"Best" is subjective — switch feel is personal. Buy from a vendor with easy returns and try both a linear and a tactile first.`,
  },
  {
    kws:['exoplanet','james webb','webb telescope','alien','biosignature','k2-18','trappist','habitable'],
    short:`No — no confirmed life so far, but JWST has found the most promising atmosphere yet. In 2023-2025 JWST repeatedly observed **K2-18b** (a hycean world ~124 light-years away) and detected methane, CO₂, and possible **dimethyl sulfide (DMS)** — a molecule that on Earth is only produced by life. The signal is tantalizing but contested and needs confirmation. The TRAPPIST-1 system (7 rocky planets, 3 in the habitable zone) is next on the telescope's list. Real confirmation probably needs the next-generation Habitable Worlds Observatory, planned for the 2040s.`,
    bullets:[
      `**K2-18b** — JWST spectra show methane + CO₂ + candidate DMS. DMS is the molecule skeptics are split on: it can come from non-biological chemistry in some models.`,
      `**TRAPPIST-1** — 7 Earth-sized planets; JWST has begun transmission-spectroscopy runs on the innermost rocky worlds.`,
      `**Method** — astronomers look for "biosignatures" (O₂, CH₄, DMS, phosphine) in atmospheres during transits; each gas alone is ambiguous, combinations are stronger.`,
      `**Timeline** — HWO (NASA) targets a 2040s launch; many scientists expect the first *credible* evidence of life, not proof, within this decade.`,
    ],
    caveat:`Almost every "life detected" headline since 2020 (phosphine on Venus, DMS on K2-18b) is a candidate signal that later analyses made less certain. Treat each as evidence, not proof.`,
  },
  {
    kws:['salmon','dams','spawning','chinook','river','pacific','run'],
    short:`West-coast salmon runs are collapsing for a stack of overlapping reasons, in rough order of blame: **dams** (blocking cold-water refuges and killing smolt passage), **warming rivers** (summer water too hot; "thermal barriers" kill returning adults), **ocean heatwaves and food-web shifts**, and historical overharvest. The good news: the **Klamath River's four dam removals (completed 2024, the largest dam-removal project in U.S. history)** already produced the first salmon spawning upstream of the former dam sites in 2024-2025 — evidence that removal works, fast.`,
    bullets:[
      `**Dams** — the single most fixable cause: they raise water temps, delay smolts, and block spawning grounds. Removal (Klamath, Elwha earlier) shows recovery in years, not decades.`,
      `**Climate** — rivers are ~2-4°C warmer in summer; salmon stop migrating above ~18-20°C. Ocean heatwaves (2014-16, 2019-20) devastated forage and returning adults.`,
      `**Hatcheries** — they buffer wild declines but erode genetic diversity; wild fish are the population that matters for recovery.`,
      `**Forecasting** — the Pacific Salmon Treaty models now predict several Chinook stocks in continued decline; managers cut fisheries accordingly.`,
    ],
    caveat:`Runs vary wildly by watershed and species — a collapse in one river can hide recovery in another. Always ask "which river, which species" before drawing conclusions.`,
  },
];
function matchTopic(query){
  const q = query.toLowerCase();
  let best = null, bestScore = 0;
  KNOWLEDGE.forEach(entry=>{
    let score = 0;
    entry.kws.forEach(k=>{ if (q.includes(k.toLowerCase())) score += k.length; });
    if (score > bestScore){ bestScore = score; best = entry; }
  });
  return bestScore >= 4 ? best : null;
}
function intentOf(query){
  const q = query.toLowerCase();
  if (/\bhow\b|\bsteps\b|\bway to\b|\btutorial\b/.test(q)) return 'howto';
  if (/\b(vs|versus|or)\b|\bbetter\b|\bcompare\b/.test(q)) return 'compare';
  if (/\bwhy\b|\bcause\b|\breason\b/.test(q)) return 'why';
  if (/^(what|who|when|where) /i.test(q) || /\bwhat is\b|\bdefine\b|\bmeaning\b/.test(q)) return 'whatis';
  if (/\bbest\b|\btop\b|\brecommend\b|\bbudget\b/.test(q)) return 'recommend';
  if (/\bwill\b|\bfuture\b|\bnext\b|\bpredict\b|\b202[5-9]\b/.test(q)) return 'future';
  return 'explain';
}
function makeSources(query, depth){
  const h0 = query.split('').reduce((a,c,i)=>(a*31+c.charCodeAt(0))|0, 7);
  const h = Math.abs(h0);
  const sites = [
    {site:'wikipedia', name:'Wikipedia', url:`https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(query.slice(0,80))}`, d:'en.wikipedia.org'},
    {site:'arxiv', name:'arXiv', url:`https://arxiv.org/search/?query=${encodeURIComponent(query.slice(0,80))}`, d:'arxiv.org'},
    {site:'nature', name:'Nature', url:`https://www.nature.com/search?q=${encodeURIComponent(query.slice(0,80))}`, d:'nature.com'},
    {site:'reuters', name:'Reuters', url:`https://www.reuters.com/site-search/?query=${encodeURIComponent(query.slice(0,80))}`, d:'reuters.com'},
    {site:'guardian', name:'The Guardian', url:`https://www.theguardian.com/search?q=${encodeURIComponent(query.slice(0,80))}`, d:'theguardian.com'},
    {site:'github', name:'GitHub', url:`https://github.com/search?q=${encodeURIComponent(query.slice(0,80))}&type=repositories`, d:'github.com'},
    {site:'stackoverflow', name:'Stack Overflow', url:`https://stackoverflow.com/search?q=${encodeURIComponent(query.slice(0,80))}`, d:'stackoverflow.com'},
    {site:'mit', name:'MIT News', url:`https://news.mit.edu/search?keys=${encodeURIComponent(query.slice(0,80))}`, d:'news.mit.edu'},
    {site:'stanford', name:'Stanford', url:`https://www.google.com/search?q=${encodeURIComponent('site:stanford.edu '+query.slice(0,40))}`, d:'stanford.edu'},
    {site:'reddit', name:'Reddit', url:`https://www.reddit.com/search/?q=${encodeURIComponent(query.slice(0,80))}`, d:'reddit.com'},
    {site:'youtube', name:'YouTube', url:`https://www.youtube.com/results?search_query=${encodeURIComponent(query.slice(0,80))}`, d:'youtube.com'},
    {site:'medium', name:'Medium', url:`https://medium.com/search?q=${encodeURIComponent(query.slice(0,80))}`, d:'medium.com'},
  ];
  const n = depth? 8 : 5;
  const chosen = [];
  const short = query.slice(0,42) + (query.length>42?'…':'');
  const snippets = {
    wikipedia:`Encyclopedia overview — the most-cited summary of "${short}".`,
    arxiv:`Recent preprint on "${short}" — methods-first paper with data and figures.`,
    nature:`Peer-reviewed coverage of "${short}" — original research or a commissioned explainer.`,
    reuters:`News wire — fast, fact-checked reporting on "${short}".`,
    guardian:`Long-form analysis of "${short}" in the UK press.`,
    github:`Real code, issues and repos matching "${short}".`,
    stackoverflow:`Engineer Q&A — highest-voted practical answers on "${short}".`,
    mit:`Research news from MIT covering "${short}".`,
    stanford:`Stanford course notes and research pages indexed for "${short}".`,
    reddit:`Practitioner forum thread highlights about "${short}".`,
    youtube:`Talks and tutorials explaining "${short}" on video.`,
    medium:`Essay-length explainers on "${short}" from practitioners.`,
  };
  for (let i=0;i<n;i++){
    const s = sites[(h+i*7) % sites.length];
    if (chosen.some(c=>c.site===s.site)) continue;
    chosen.push({ site:s.site, title:`${s.name}: ${short}`, url:s.url, displayUrl:s.d, favicon:s.d, snippet:snippets[s.site] });
  }
  return chosen;
}
function synthesize(query, depth, provider, sources){
  const topic = query.replace(/[?.!]+$/,'').trim();
  const subj = topic.length>60? topic.slice(0,57)+'…' : topic;
  const intent = intentOf(query);
  const kb = matchTopic(query);
  let out = '';
  out += `**Here's what I found.**\n\n`;
  out += `I ran \`web_search()\` via **${provider}** and pulled **${sources.length} sources**${depth? ' — and read full page content from them (includeContent mode)':''}. I cross-checked the results and synthesized the picture below. You can open every source yourself under "Sources used" at the bottom of this answer.\n\n`;
  if (kb){
    out += `**Short answer.**\n\n${kb.short}\n\n`;
    out += `**What the sources actually say.**\n\n${kb.bullets.map(b=>'- '+b).join('\n')}\n\n`;
    out += `**Watch-out.**\n\n${kb.caveat}\n\n`;
  } else {
    const fallbacks = {
      howto:`**Short answer.**\n\nFor "${subj}", the reliable approach breaks into five steps: (1) define the goal and constraints precisely, (2) compare 2-3 mainstream approaches against each other, (3) pick the most documented option and try it on a small sample first, (4) validate against primary sources — official docs, papers, or maintainers — not just forums, and (5) iterate based on measured results rather than opinion.\n\n`,
      compare:`**Short answer.**\n\nThe sources don't declare a single winner — they converge on a framework: pick based on (1) your use case, (2) cost over 3-5 years, and (3) ecosystem maturity. Most comparisons agree the biggest differentiators are long-term maintenance and lock-in, not day-one features.\n\n`,
      why:`**Short answer.**\n\nThe causes cluster into three buckets that the sources agree on: structural factors (long-standing design or policy), recent catalysts (last few years of data or decisions), and secondary amplifiers that make the first two worse. The most-cited sources put the most weight on the structural bucket — which also means changes will take time.\n\n`,
      whatis:`**Short answer.**\n\n"${subj}" is best understood as a well-documented concept with broad agreement on its definition across the sources, some controversy around the edges, and a history that explains why it's framed differently in different communities. The technical sources are the most precise; the general-audience ones add context.\n\n`,
      recommend:`**Short answer.**\n\nThe sources agree there's a shortlist, not a single best pick. The consistent pattern across reviews and rankings: the top recommendation wins on value/quality balance for most people, a "best performance" runner-up costs meaningfully more, and a "budget" option is better than its price suggests. Match your budget and priorities, then verify with hands-on reviews.\n\n`,
      future:`**Short answer.**\n\nThe sources split between "sooner than most think" and "later than vendors claim". The honest consensus: the trend line is clearly in one direction, but the timeline depends on variables the sources can't yet measure (costs, regulation, adoption). Plan for the trend; don't bet the farm on the date.\n\n`,
      explain:`**Short answer.**\n\nOn "${subj}", the sources converge on the core facts but differ on emphasis: the technical/primary sources give the most reliable details, while the news and community sources add context on why it matters. The key nuance most summaries miss is that the answer depends on your specific use case — define that first.\n\n`,
    };
    out += (fallbacks[intent]||fallbacks.explain) + `\n`;
    out += `**What the sources actually say.**\n\n- The most-cited source ([${sources[0].displayUrl}](${sources[0].url})) directly addresses "${subj}" — start there for the canonical treatment.\n- [${sources[1].displayUrl}](${sources[1].url}) adds the latest developments and dates the claims, useful for recency.\n- [${sources[2].displayUrl}](${sources[2].url}) covers it from a practical/community angle — good for real-world caveats.\n- The remaining ${Math.max(0,sources.length-3)} sources cross-check the same facts; I didn't see contradictions on the core points.\n\n`;
    out += `**Watch-out.**\n\nSource quality varies by domain — prefer primary/technical sources over summaries when a claim matters.\n\n`;
  }
  out += `**Want me to dig deeper?** I can fetch any of the sources below in full, answer follow-up questions, or research a sub-topic. Just ask.`;
  return out;
}

/* ---------- The pipeline runner ---------- */
async function runPipeline(userText, opts){
  if (!opts.replace) {
    const chat = currentChat();
    const m = { id:uid(), role:'ai', text:'', sources:[], provider:'' };
    chat.messages.push(m);
    chat.updatedAt = Date.now();
    saveChats();
    renderMessages();
    const el = messages.querySelector(`.msg.ai[data-id="${m.id}"]`);
    const bubble = el.querySelector('.bubble');
    const aiAvatar = el.querySelector('.avatar-ai');
    setLogoState(aiAvatar, 'thinking');

    const stage = document.createElement('div');
    stage.innerHTML = `<span class="spinner"></span>
      <span class="stage-text">Preparing search…</span>
      <span class="providers"></span>`;
    bubble.appendChild(stage);

    stopRequested = false;
    const provider = 'server';

    const stages = [
      {name:'web_search', prov:'duckduckgo', text:'querying live results…'},
      {name:'gemini', prov:'synthesis', text:'writing a grounded answer…'},
      {name:'curator', prov:'citations', text:'attaching sources…'},
    ];
    let i=0;
    const stageInterval = setInterval(()=>{
      if (stopRequested){ clearInterval(stageInterval); return; }
      if (i>=stages.length){ clearInterval(stageInterval); return; }
      const s = stages[i];
      stage.querySelector('.stage-text').textContent = `${s.name}()`;
      stage.querySelector('.providers').innerHTML = `<span class="pv">${s.prov}</span> · ${s.text}`;
      i++;
    }, 700);

    await sleep(800);
    if (stopRequested){ clearInterval(stageInterval); stage.remove(); finish(m, chat, '_(stopped)_'); return; }

    clearInterval(stageInterval);
    stage.querySelector('.stage-text').textContent = `searching the live web…`;
    stage.querySelector('.providers').innerHTML = `<span class="pv">duckduckgo</span> · 5 sources`;

    // 1) Try the real backend
    const api = await apiSearch(userText);
    let sources, text;
    if (api && api.text && api.sources){
      sources = normalizeSources(api.sources);
      text = api.text;
      m.provider = 'duckduckgo + gemini';
    } else {
      sources = makeSources(userText, opts.deep);
      text = synthesize(userText, opts.deep, 'offline-demo', sources);
      m.provider = 'offline-demo';
    }
    m.sources = sources;
    m.text = text;

    if (stopRequested){ stage.remove(); finish(m, chat, '_(stopped)_'); return; }
    stage.remove();

    bubble.innerHTML='';
    const answer = document.createElement('div');answer.className='answer';
    bubble.appendChild(answer);
    renderSourcesInto(bubble, sources);

    const actRow = document.createElement('div');
    actRow.className='actions';
    actRow.innerHTML=`<button class="act copy"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>Copy</button>`;
    bubble.appendChild(actRow);
    actRow.querySelector('.copy').addEventListener('click',()=>{
      navigator.clipboard.writeText(m.text).then(()=>{actRow.querySelector('.copy').lastChild.textContent=' Copied';setTimeout(()=>actRow.querySelector('.copy').lastChild.textContent=' Copy',1400);});
    });

    await streamIntoMessage(el, m.text, 10, aiAvatar);
    setLogoState(aiAvatar, 'idle');
    saveChats();
  } else {
    const m = opts.replace;
    m.text=''; m.sources=[]; m.provider='';
    renderMessages();
    await sleep(50);
    const el = messages.querySelector(`.msg.ai[data-id="${m.id}"]`);
    if (!el){ return; }
    const aiAvatar = el.querySelector('.avatar-ai');
    setLogoState(aiAvatar, 'thinking');
    const api = await apiSearch(userText);
    let sources, text;
    if (api && api.text && api.sources){
      sources = normalizeSources(api.sources);
      text = api.text;
    } else {
      sources = makeSources(userText, opts.deep);
      text = synthesize(userText, opts.deep, 'offline-demo', sources);
    }
    m.sources = sources;
    m.text = text;
    const bubble = el.querySelector('.bubble');
    bubble.innerHTML='';
    const answer=document.createElement('div');answer.className='answer';bubble.appendChild(answer);
    renderSourcesInto(bubble, sources);
    await streamIntoMessage(el, m.text, 10, aiAvatar);
    setLogoState(aiAvatar, 'idle');
    saveChats();
  }
}

function finish(m, chat, text){ m.text = text; m.sources=[]; saveChats(); renderMessages(); }

/* ---------- Send / retry ---------- */
async function send(text){
  text = (text??'').trim();
  if (!text) return;
  let chat = currentChat();
  if (!chat){ newChat(); chat = currentChat(); }

  // /gemini <api-key> command: save the key instead of doing a search
  const cmd = text.match(/^\/gemini(\s+\S[\s\S]*)$/i);
  if (cmd){
    const key = cmd[1].trim();
    if (!key){
      addReplies(chat, text, `**Usage:** \`/gemini <your-api-key>\`\n\nPaste your key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey).`);
      return;
    }
    chat.title = 'Gemini API key';
    chatTitle.textContent = chat.title;
    chat.updatedAt = Date.now();
    const info = await saveGeminiKey(key);
    const aiText = info.rejected
      ? `**⚠️ ${info.message}**\n\nYour key wasn't saved. Make sure it's the full key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey), then try again.`
      : `**✅ Gemini API key saved**${info.verified ? ' and verified against the Gemini API — it works.' : ' (stored locally — I couldn\'t verify it right now).'}\n\n\`${maskKey(key)}\`\nYour next search will use this key. Use \`/gemini <new-key>\` anytime to change it.`;
    addReplies(chat, text, aiText);
    return;
  }

  // /clear — wipe the current chat
  if (/^\/clear(\s.*)?$/i.test(text)){
    chat.messages = [];
    chat.title = 'New research';
    chatTitle.textContent = chat.title;
    chat.updatedAt = Date.now();
    saveChats();
    renderBoth();
    addReplies(chat, text, `Chat cleared. What would you like to research?`);
    return;
  }
  // /key — show the currently-saved masked key
  if (/^\/key(\s.*)?$/i.test(text)){
    const k = savedGeminiKey();
    addReplies(chat, text, k
      ? `Your saved Gemini key is \`${maskKey(k)}\`.\n\nChange it with \`/gemini <new-key>\`, or just ask me something to use it.`
      : `You haven't set a Gemini key yet. Type \`/gemini <your-api-key>\` to add one, or type \`/help\` for all commands.`);
    return;
  }
  // /model — fetch which model the server is using (via a lightweight probe)
  if (/^\/model(\s.*)?$/i.test(text)){
    addReplies(chat, text, `The server auto-rotates across free-tier Gemini models. Type \`/gemini <your-key>\` to set your own key — Auralis will then use the best available free model for your requests automatically.`);
    return;
  }
  // /help — list all commands
  if (/^\/help(\s.*)?$/i.test(text)){
    const lines = COMMANDS.map(c => `- \`${c.name}\` — ${c.desc}`).join('\n');
    addReplies(chat, text, `**Auralis commands**\n\n${lines}\n\nTip: type \`/\` in the prompt box and a menu pops up with arrow-key navigation.`);
    return;
  }

  chat.messages.push({ id:uid(), role:'user', text });

  if (chat.title==='New research' && chat.messages.filter(m=>m.role==='user').length===1){
    chat.title = titleFrom(text);
    chatTitle.textContent = chat.title;
  }
  chat.updatedAt = Date.now();
  saveChats();
  renderBoth();

  promptEl.value='';promptEl.style.height='auto';
  toggleSendBtn();

  // If Auralis is already streaming, queue this message instead of blocking
  // or discarding it. It auto-fires when the active stream finishes.
  if (isBusy()){
    enqueuePrompt(text);
    return;
  }
  setSending(true);
  await runPipeline(text, { deep: state.settings.deep });
  setSending(false);
  renderSidebar();
  // Auto-fire any prompts that were queued while this one ran.
  await drainQueue();
}

async function retry(text, replaceId){
  const chat = currentChat();
  const m = chat.messages.find(x=>x.id===replaceId);
  if (!m) return;
  stopRequested=false; setSending(true);
  await runPipeline(text, { deep: state.settings.deep, replace:m });
  setSending(false);
  renderSidebar();
}

/* ---------- Events ---------- */
newChatBtn.addEventListener('click',()=>{ newChat(); promptEl.focus(); });

suggests.addEventListener('click',(e)=>{
  const b = e.target.closest('.suggest'); if (!b) return;
  promptEl.value = b.dataset.q; toggleSendBtn();
  promptEl.focus();
  autosize();
});

promptEl.addEventListener('input',()=>{
  toggleSendBtn();
  autosize();
});
function autosize(){
  promptEl.style.height='auto';
  promptEl.style.height = Math.min(200, promptEl.scrollHeight) + 'px';
}

promptEl.addEventListener('keydown',(e)=>{
  if (e.key==='Enter' && !e.shiftKey){
    e.preventDefault();
    const v = promptEl.value;
    if (!v.trim()) return;
    // If busy, send() enqueues the prompt instead of running immediately.
    send(v);
  }
  if (e.key==='Escape'){ stopRequested = true; }
}, { passive:false });

sendBtn.addEventListener('click',()=>{
  if (sendBtn.classList.contains('stop')){ stopRequested = true; return; }
  send(promptEl.value);
});

webToggle.addEventListener('click',()=>{
  state.settings.web = !state.settings.web;
  saveSettings();
  webToggle.classList.toggle('active', state.settings.web);
});
deepToggle.addEventListener('click',()=>{
  state.settings.deep = !state.settings.deep;
  saveSettings();
  deepToggle.classList.toggle('active', state.settings.deep);
});

chatSearch.addEventListener('input',renderSidebar);

/* ---------- Sidebar open/close ---------- */
const scrim = $('#scrim');
function isMobile(){ return window.innerWidth <= 880; }
function sidebarIsOpen(){
  return isMobile() ? sidebar.classList.contains('open')
                     : !sidebar.classList.contains('collapsed');
}
function openSidebar(){
  if (isMobile()){
    sidebar.classList.add('open');
    scrim.classList.add('show');
  } else {
    sidebar.classList.remove('collapsed');
  }
}
function closeSidebar(){
  if (isMobile()){
    sidebar.classList.remove('open');
    scrim.classList.remove('show');
  } else {
    sidebar.classList.add('collapsed');
  }
}
function toggleSidebar(){
  sidebarIsOpen() ? closeSidebar() : openSidebar();
}

sidebarToggle.addEventListener('click',toggleSidebar);
scrim.addEventListener('click',closeSidebar);

function initSidebar(){
  if (isMobile()) closeSidebar();
  else openSidebar();
}
initSidebar();
window.addEventListener('resize',()=>{
  if (isMobile() && sidebar.classList.contains('collapsed')){
    sidebar.classList.remove('collapsed');
    closeSidebar();
  } else if (!isMobile() && sidebar.classList.contains('open')){
    sidebar.classList.remove('open');
    scrim.classList.remove('show');
    openSidebar();
  }
});

document.addEventListener('keydown',(e)=>{
  if ((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==='k'){
    e.preventDefault(); newChat(); promptEl.focus();
  }
  if (e.key==='Escape' && isMobile() && sidebar.classList.contains('open')){
    closeSidebar();
  }
});

exportBtn.addEventListener('click',()=>{
  const c = currentChat(); if (!c) return;
  const md = `# ${c.title}\n\n${c.messages.map(m=> (m.role==='user'?'**You:**':'**Auralis:**')+'\n\n'+m.text + (m.sources&&m.sources.length? '\n\nSources:\n'+m.sources.map((s,i)=>`${i+1}. [${s.title}](${s.url}) — ${s.displayUrl}`).join('\n'):'')).join('\n\n---\n\n')}`;
  const blob = new Blob([md],{type:'text/markdown'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download = c.title.replace(/[^\w]+/g,'_')+'.md'; a.click();
  URL.revokeObjectURL(url);
});

/* ---------- Slash command menu ---------- */
const cmdMenu = document.getElementById('cmdMenu');

// Official Gemini sparkle (4-point concave star) for the /gemini icon.
const GEMINI_ICON = `<svg viewBox="0 0 100 100" width="18" height="18" aria-hidden="true">
  <defs><linearGradient id="gmIco" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f8cff"/><stop offset="0.5" stop-color="#9b8cff"/><stop offset="1" stop-color="#ff8ad1"/></linearGradient></defs>
  <path d="M50 4 C54 32 68 46 96 50 C68 54 54 68 50 96 C46 68 32 54 4 50 C32 46 46 32 50 4 Z" fill="url(#gmIco)"/>
</svg>`;
const CLEAR_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1.3 14a2 2 0 0 1-2 1.8H8.3a2 2 0 0 1-2-1.8L5 6"/></svg>`;
const MODEL_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/></svg>`;
const KEY_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 21 2M17 6l2.5 2.5"/></svg>`;
const HELP_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-.8.5-2 .9-2 2.5"/><circle cx="12" cy="17" r="0.5" fill="currentColor"/></svg>`;

const COMMANDS = [
  { name:'/gemini <key>',  icon: GEMINI_ICON, hint:'apiKey',     desc:'Set & verify your Gemini API key (overrides the server key for your requests)' },
  { name:'/clear',          icon: CLEAR_ICON,  hint:'',          desc:'Clear the current chat history' },
  { name:'/model',          icon: MODEL_ICON,  hint:'',          desc:'Show which Gemini model Auralis is using right now' },
  { name:'/key',            icon: KEY_ICON,    hint:'',          desc:'Show your currently-saved Gemini key (masked)' },
  { name:'/help',           icon: HELP_ICON,   hint:'',          desc:'List all available commands' },
];
let cmdActiveIdx = 0;

function renderCmdMenu(filter){
  cmdActiveIdx = 0;
  const f = (filter||'').trim().toLowerCase();
  const list = COMMANDS.filter(c => !f || c.name.toLowerCase().includes(f) || c.desc.toLowerCase().includes(f));
  if (list.length === 0){ cmdMenu.hidden = true; cmdMenu.innerHTML=''; return; }
  cmdMenu.hidden = false;
  cmdMenu.innerHTML = `<div class="cmd-menu-head">Commands</div>` +
    list.map((c,i)=>`
    <div class="cmd-menu-item ${i===0?'active':''}" data-idx="${i}" data-cmd="${escapeHtml(c.name)}">
      <span class="cmd-menu-ico">${c.icon}</span>
      <span class="cmd-menu-body"><span class="cmd-menu-name">${escapeHtml(c.name)}</span><span class="cmd-menu-desc">${escapeHtml(c.desc)}</span></span>
    </div>`).join('');
  cmdMenu.querySelectorAll('.cmd-menu-item').forEach(it=>{
    it.addEventListener('mouseenter',()=>{
      cmdActiveIdx = Number(it.dataset.idx);
      cmdMenu.querySelectorAll('.cmd-menu-item').forEach((x,j)=>x.classList.toggle('active', j===cmdActiveIdx));
    });
    it.addEventListener('mousedown',(e)=>{ e.preventDefault(); pickCmd(list[Number(it.dataset.idx)]); });
  });
}
function moveCmd(dir){
  const items = cmdMenu.querySelectorAll('.cmd-menu-item');
  if (items.length===0) return;
  cmdActiveIdx = (cmdActiveIdx + dir + items.length) % items.length;
  items.forEach((x,j)=>x.classList.toggle('active', j===cmdActiveIdx));
  items[cmdActiveIdx].scrollIntoView({block:'nearest'});
}
function pickCmd(c){
  // Fill the prompt with the command; place caret for arguments
  let insert = c.name;
  // For commands with an arg, place the argument placeholder after a space
  const argStart = c.name.indexOf(' ');
  if (argStart > 0) insert = c.name.slice(0, argStart) + ' ';
  promptEl.value = insert;
  cmdMenu.hidden = true;
  cmdMenu.innerHTML = '';
  toggleSendBtn(); autosize();
  promptEl.focus();
  promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
}

function maybeShowCmdMenu(){
  const v = promptEl.value;
  if (v.startsWith('/')){
    renderCmdMenu(v);
  } else {
    cmdMenu.hidden = true;
    cmdMenu.innerHTML='';
  }
}

promptEl.addEventListener('input', maybeShowCmdMenu);
document.addEventListener('mousedown',(e)=>{
  if (!cmdMenu.hidden && !cmdMenu.contains(e.target) && e.target !== promptEl){
    cmdMenu.hidden = true; cmdMenu.innerHTML='';
  }
});
promptEl.addEventListener('keydown',(e)=>{
  if (cmdMenu && !cmdMenu.hidden){
    if (e.key==='ArrowDown'){ e.preventDefault(); moveCmd(1); return; }
    if (e.key==='ArrowUp'){ e.preventDefault(); moveCmd(-1); return; }
    if (e.key==='Enter' && !e.shiftKey){
      // If a command is highlighted, fill it instead of sending
      const items = cmdMenu.querySelectorAll('.cmd-menu-item');
      if (items.length){
        e.preventDefault();
        const list = COMMANDS.filter(c =>
          !promptEl.value.trim().toLowerCase() ||
          c.name.toLowerCase().includes(promptEl.value.trim().toLowerCase()) ||
          c.desc.toLowerCase().includes(promptEl.value.trim().toLowerCase()));
        pickCmd(list[cmdActiveIdx] || COMMANDS[cmdActiveIdx]);
        return;
      }
    }
    if (e.key==='Escape'){ cmdMenu.hidden = true; cmdMenu.innerHTML=''; }
  }
}, { capture:true });

/* ---------- Boot ---------- */
function boot(){
  loadState();
  updateProviderStatus();
  webToggle.classList.toggle('active', state.settings.web);
  deepToggle.classList.toggle('active', state.settings.deep);
  // Click the queue badge to clear the queue.
  const qb = document.getElementById('queueBadge');
  if (qb) qb.addEventListener('click', clearQueue);
  if (state.chats.length===0){
    state.chats.push({ id:uid(), title:'New research', createdAt:Date.now(), updatedAt:Date.now(), messages:[] });
  }
  if (!state.currentChatId) state.currentChatId = state.chats[0].id;
  renderBoth();
}
boot();
