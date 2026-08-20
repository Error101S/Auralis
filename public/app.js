/* ============================================================
   AURALIS — research AI app logic
   - Sends prompts to the real backend (/api/search): DuckDuckGo
     search + local LFM model synthesis, with source citations.
   - Hybrid: if the browser can run the LFM research model (WebGPU),
     synthesis happens locally in the browser; otherwise the backend
     runs the same local model.
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
const plusBtn = $('#plusBtn');
const plusMenu = $('#plusMenu');
const fileInput = $('#fileInput');
const attachRow = $('#attachRow');
const micChip = $('#micChip');
const modelPanel = $('#modelPanel');
const modelList = $('#modelList');
const toasts = $('#toasts');
const settingsWrap = $('#settingsWrap');
const settingsBtn = $('#settingsBtn');
const keyInput = $('#keyInput');
const keyStatus = $('#keyStatus');
const memoryList = $('#memoryList');
const memoryRefresh = $('#memoryRefresh');
const memoryClear = $('#memoryClear');
const authBtn = $('#authBtn');
const userBtn = $('#userBtn');
const authPrompt = $('#authPrompt');
const emptyAuthBtn = $('#emptyAuthBtn');
const askPanel = $('#askPanel');
const visionAsk = $('#visionAsk');

/* ---------- Auralis logo ("Aurora Aperture": interlocking hexagonal iris + spark) ---------- */
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
    <circle class="al-glow" cx="50" cy="50" r="45" fill="url(#alr${gid})"/>
    <path class="al-ring" d="M8 50 L29 14 L71 14 L92 50 L71 86 L29 86 Z" fill="none" stroke="url(#alg${gid})" stroke-width="3" stroke-linejoin="round" opacity="0.5"/>
    <path class="al-core" d="M50 18 L78 34 L78 66 L50 82 L22 66 L22 34 Z" fill="url(#alg${gid})"/>
    <path class="al-spark" d="M50 34 C52 42 58 48 66 50 C58 52 52 58 50 66 C48 58 42 52 34 50 C42 48 48 42 50 34 Z" fill="#ffffff" opacity="0.92"/>
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

/* ---------- Pending attachments (kept in memory only; summaries are stored) ---------- */
/* images: [{name, dataUrl, thumb}] · audios: [{name, file}] · docs: [{name, text}] */
const pending = { images: [], audios: [], docs: [] };
function hasPendingAttachments(){
  return pending.images.length + pending.audios.length + pending.docs.length > 0;
}
function takeAttachments(){
  const out = {
    images: pending.images.slice(),
    audios: pending.audios.slice(),
    docs: pending.docs.slice(),
    get empty(){ return !this.images.length && !this.audios.length && !this.docs.length; }
  };
  pending.images = []; pending.audios = []; pending.docs = [];
  renderAttachRow();
  return out;
}
function summarizeAttachments(atts){
  if (!atts) return [];
  const out = [];
  (atts.images||[]).forEach(i=>out.push({ type:'image', name:i.name, thumb:i.thumb }));
  (atts.audios||[]).forEach(a=>out.push({ type:'audio', name:a.name }));
  (atts.docs ||[]).forEach(d=>out.push({ type:'doc',   name:d.name }));
  return out;
}

/* ---------- Gemini API key (optional; stored only in this browser) ---------- */
const GEMINI_KEY_STORE = 'auralis.geminiKey';
const LOCAL_CHOSEN_KEY = 'auralis.localChosen';
function getGeminiKey(){ try { return (localStorage.getItem(GEMINI_KEY_STORE) || '').trim(); } catch { return ''; } }
function setGeminiKey(k){ try { localStorage.setItem(GEMINI_KEY_STORE, String(k||'').trim()); } catch {} }
function clearGeminiKey(){ try { localStorage.removeItem(GEMINI_KEY_STORE); } catch {} }
function localChosen(){ try { return localStorage.getItem(LOCAL_CHOSEN_KEY) === '1'; } catch { return false; } }
function markLocalChosen(){ try { localStorage.setItem(LOCAL_CHOSEN_KEY, '1'); } catch {} }

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
let renamingChatId = null;
function chatItemEl(c){
  const it = document.createElement('div');
  it.className = 'chat-item' + (c.id===state.currentChatId?' active':'') + (c.pinned?' pinned':'');
  it.dataset.id = c.id;
  if (renamingChatId === c.id){
    it.innerHTML = `<input class="ci-rename" type="text" value="${escapeHtml(c.title)}" maxlength="70" aria-label="Chat name">`;
    const input = it.querySelector('.ci-rename');
    requestAnimationFrame(()=>{
      input.focus();
      input.select();
    });
    const commit = ()=>{
      const v = input.value.trim();
      renamingChatId = null;
      if (v && v !== c.title){ c.title = v; c.updatedAt = Date.now(); }
      saveChats(); renderBoth();
    };
    input.addEventListener('keydown',(e)=>{
      e.stopPropagation();
      if (e.key==='Enter'){ e.preventDefault(); commit(); }
      if (e.key==='Escape'){ e.stopPropagation(); renamingChatId = null; renderBoth(); }
    });
    input.addEventListener('blur', commit);
    input.addEventListener('click',(e)=>e.stopPropagation());
    return it;
  }
  it.innerHTML = `
    ${c.pinned ? '<span class="ci-pinmark" title="Pinned">📌</span>' : ''}
    <span class="ci-title">${escapeHtml(c.title)}</span>
    <button class="ci-btn ci-pin" title="${c.pinned?'Unpin':'Pin'} chat">📌</button>
    <button class="ci-btn ci-ren" title="Rename chat">✎</button>
    <button class="ci-btn ci-del" title="Delete chat">✕</button>`;
  it.addEventListener('click',()=>openChat(c.id));
  it.querySelector('.ci-pin').addEventListener('click',(e)=>{
    e.stopPropagation();
    c.pinned = !c.pinned;
    saveChats(); renderSidebar();
  });
  it.querySelector('.ci-ren').addEventListener('click',(e)=>{
    e.stopPropagation();
    renamingChatId = c.id;
    renderSidebar();
  });
  it.querySelector('.ci-del').addEventListener('click',(e)=>deleteChat(c.id,e));
  return it;
}

function renderSidebar(){
  chatList.innerHTML = '';
  const sorted = [...state.chats].sort((a,b)=>b.updatedAt-a.updatedAt);
  const pinned = sorted.filter(c=>c.pinned);
  const rest = sorted.filter(c=>!c.pinned);
  const q = (chatSearch.value||'').toLowerCase().trim();
  const matches = (c)=> !q || c.title.toLowerCase().includes(q) || c.messages.some(m=>m.text.toLowerCase().includes(q));

  if (pinned.length){
    const sep = document.createElement('div');
    sep.className = 'date-sep pin-sep';
    sep.textContent = '📌 Pinned';
    chatList.appendChild(sep);
    pinned.filter(matches).forEach(c=>chatList.appendChild(chatItemEl(c)));
  }

  let lastKey = null;
  rest.filter(matches).forEach(c=>{
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
    chatList.appendChild(chatItemEl(c));
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
  el.dataset.id = m.id;
  let att = '';
  (m.attachments||[]).forEach(a=>{
    if (a.type==='image' && a.thumb) att += `<img class="att-thumb" src="${a.thumb}" alt="${escapeHtml(a.name)}" title="${escapeHtml(a.name)}">`;
    else if (a.type==='image') att += `<span class="att-chip">🖼 ${escapeHtml(a.name)}</span>`;
    else if (a.type==='audio') att += `<span class="att-chip">🎙 ${escapeHtml(a.name)}</span>`;
    else att += `<span class="att-chip">📄 ${escapeHtml(a.name)}</span>`;
  });
  el.innerHTML = `<div class="body"><div class="bubble">${att?`<div class="att-row">${att}</div>`:''}<div class="bubble-text">${escapeHtml(m.text)}</div></div>
    <div class="u-actions"><button class="act edit" title="Edit this prompt and rerun">✎ Edit</button></div></div>`;
  el.querySelector('.act.edit').addEventListener('click', ()=>editUserMessage(m));
  messages.appendChild(el);
}

/* ---------- Prompt editing: fix a sent prompt, rerun the answer ---------- */
function editUserMessage(m){
  if (isBusy()){ toast('Wait for the current answer to finish — or press Stop — before editing.'); return; }
  const el = messages.querySelector(`.msg.user[data-id="${m.id}"]`);
  if (!el || el.querySelector('.edit-box')) return;
  const bubble = el.querySelector('.bubble');
  const prevHTML = bubble.innerHTML;
  bubble.innerHTML = `<div class="edit-box">
    <textarea class="edit-area" rows="1"></textarea>
    <div class="edit-row">
      <button class="mp-btn edit-save">Save &amp; rerun</button>
      <button class="mp-btn subtle edit-cancel">Cancel</button>
    </div>
  </div>`;
  const area = bubble.querySelector('.edit-area');
  area.value = m.text;
  const fit = ()=>{ area.style.height='auto'; area.style.height = Math.min(220, area.scrollHeight) + 'px'; };
  fit();
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  area.addEventListener('input', fit);
  const cancel = ()=>{
    bubble.innerHTML = prevHTML;
    el.querySelector('.act.edit').addEventListener('click', ()=>editUserMessage(m));
  };
  bubble.querySelector('.edit-cancel').addEventListener('click',(e)=>{ e.stopPropagation(); cancel(); });
  bubble.querySelector('.edit-save').addEventListener('click',(e)=>{ e.stopPropagation(); rerunEdited(m, area.value); });
  area.addEventListener('keydown',(e)=>{
    if (e.key==='Enter' && !e.shiftKey){ e.preventDefault(); rerunEdited(m, area.value); }
    if (e.key==='Escape'){ e.stopPropagation(); cancel(); }
  });
}

async function rerunEdited(m, newText){
  newText = (newText||'').trim();
  const chat = currentChat();
  if (!chat || !newText){ if (!newText) toast('The prompt is empty — nothing to rerun.', 'error'); return; }
  const idx = chat.messages.findIndex(x=>x.id===m.id);
  if (idx < 0) return;
  m.text = newText;
  // Drop the old answer (and anything after it) so the edit becomes the
  // newest turn, then generate a fresh answer for the corrected prompt.
  chat.messages = chat.messages.slice(0, idx + 1);
  chat.updatedAt = Date.now();
  saveChats();
  renderBoth();
  setSending(true);
  await runPipeline(newText, { deep: state.settings.deep, web: state.settings.web });
  setSending(false);
  renderSidebar();
  if (!stopRequested) await drainQueue();
}

/* ---------- Toasts ---------- */
function toast(msg, kind){
  if (!toasts) return;
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  toasts.appendChild(el);
  setTimeout(()=>{ el.classList.add('out'); setTimeout(()=>el.remove(), 350); }, 4500);
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
  
  // Render finance widget if data is available
  if (m.financeData) {
    const financeCard = renderFinanceCard(m.financeData);
    if (financeCard) bubble.appendChild(financeCard);
  }
  
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
    if (userMsg && (userMsg.text||'').trim()) retry(userMsg.text, m.id);
    else toast('Nothing to retry — that turn was attachment-only.');
  });
  messages.appendChild(el);
}

function renderBoth(){ renderSidebar(); renderMessages(); toggleSendBtn(); }

/* ---------- Auth UI ---------- */
async function checkAuthStatus(){
  try {
    const res = await fetch('/api/user');
    if (!res.ok) return;
    const data = await res.json();
    if (data.loggedIn) {
      authBtn.hidden = true;
      userBtn.hidden = false;
      if (authPrompt) authPrompt.hidden = true;
    } else {
      authBtn.hidden = false;
      userBtn.hidden = true;
      if (authPrompt) authPrompt.hidden = false;
    }
  } catch (err) {
    console.error('Failed to check auth status:', err);
  }
}

if (authBtn) {
  authBtn.addEventListener('click', () => {
    window.location.href = '/auth/google';
  });
}

if (emptyAuthBtn) {
  emptyAuthBtn.addEventListener('click', () => {
    window.location.href = '/auth/google';
  });
}

if (userBtn) {
  userBtn.addEventListener('click', () => {
    // Show user menu or go to settings
    openSettings('about');
  });
}

/* ---------- Memory Tab ---------- */
async function loadMemories(){
  if (!memoryList) return;
  try {
    const res = await fetch('/api/user');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.loggedIn) {
      memoryList.innerHTML = '<div class="memory-empty">Sign in to view and manage your memories.</div>';
      return;
    }
    // Fetch memories from server
    const memRes = await fetch('/api/memories');
    if (!memRes.ok) {
      memoryList.innerHTML = '<div class="memory-empty">Failed to load memories.</div>';
      return;
    }
    const memories = await memRes.json();
    if (!memories || memories.length === 0) {
      memoryList.innerHTML = '<div class="memory-empty">No memories saved yet. Tell Auralis things like "remember that I use Linux" and it will remember them.</div>';
      return;
    }
    memoryList.innerHTML = memories.map((m, i) => `
      <div class="memory-item">
        <span class="memory-text">${escapeHtml(m)}</span>
        <button class="memory-delete" data-index="${i}">✕</button>
      </div>
    `).join('');
    memoryList.querySelectorAll('.memory-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.index);
        await deleteMemory(idx);
        loadMemories();
      });
    });
  } catch (err) {
    console.error('Failed to load memories:', err);
    memoryList.innerHTML = '<div class="memory-empty">Failed to load memories.</div>';
  }
}

async function deleteMemory(index){
  try {
    await fetch('/api/memories', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index })
    });
    toast('Memory deleted');
  } catch (err) {
    console.error('Failed to delete memory:', err);
    toast('Failed to delete memory', 'error');
  }
}

if (memoryRefresh) {
  memoryRefresh.addEventListener('click', loadMemories);
}
if (memoryClear) {
  memoryClear.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to clear all memories?')) return;
    try {
      await fetch('/api/memories', { method: 'DELETE' });
      toast('All memories cleared');
      loadMemories();
    } catch (err) {
      console.error('Failed to clear memories:', err);
      toast('Failed to clear memories', 'error');
    }
  });
}

/* ---------- Image Search ---------- */
async function searchImages(query){
  try {
    const res = await fetch(`/api/images?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error('Image search failed');
    const data = await res.json();
    return data.images || [];
  } catch (err) {
    console.error('Image search error:', err);
    return [];
  }
}

/* ---------- Finance Widget ---------- */
function renderFinanceCard(data){
  if (!data || !data.price) return null;
  const el = document.createElement('div');
  el.className = 'finance-card';
  
  const changeColor = data.change > 0 ? '#00c853' : (data.change < 0 ? '#ff1744' : '#ffffff');
  const changeIcon = data.change > 0 ? '▲' : (data.change < 0 ? '▼' : '−');
  const changeSign = data.change > 0 ? '+' : '';
  
  let extraRows = '';
  if (data.marketCap) {
    extraRows += `<div class="fc-row"><span class="fc-label">Market Cap</span><span class="fc-value">$${data.marketCap.toLocaleString()} ${data.marketCapUnit || ''}</span></div>`;
  }
  if (data.high && data.low) {
    extraRows += `<div class="fc-row"><span class="fc-label">Day Range</span><span class="fc-value">$${data.low.toLocaleString()} - $${data.high.toLocaleString()}</span></div>`;
  }
  if (data.volume) {
    extraRows += `<div class="fc-row"><span class="fc-label">Volume</span><span class="fc-value">${data.volume.toLocaleString()} ${data.volumeUnit || ''}</span></div>`;
  }
  
  el.innerHTML = `
    <div class="fc-header">
      <div class="fc-company">
        <span class="fc-name">${escapeHtml(data.company || 'Company')}</span>
        ${data.ticker ? `<span class="fc-ticker">${escapeHtml(data.ticker)}</span>` : ''}
      </div>
      <div class="fc-price">$${data.price.toLocaleString()}</div>
    </div>
    <div class="fc-change" style="color: ${changeColor}">
      ${changeIcon} ${changeSign}${data.change?.toFixed(2) || '0.00'} (${data.changePercent ? changeSign + data.changePercent.toFixed(2) + '%' : '0.00%'})
    </div>
    ${extraRows ? `<div class="fc-extra">${extraRows}</div>` : ''}
  `;
  return el;
}

/* ---------- markdown-lite ---------- */
function escapeHtml(s){return (s==null?'':String(s)).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function renderMarkdown(text){
  let t = escapeHtml(text);
  t = t.replace(/```([\s\S]*?)```/g, (_,c)=>`<pre style="background:rgba(0,0,0,.35);padding:10px;border-radius:8px;overflow:auto;margin:8px 0;font-family:'JetBrains Mono';font-size:12px"><code>${c.replace(/^\n/,'')}</code></pre>`);
  t = t.replace(/`([^`\n]+)`/g,'<code>$1</code>');
  // Pipe tables: a run of consecutive lines starting and ending with "|".
  t = t.replace(/(?:^|\n)((?:\|[^\n]*\|)(?:\n\|[^\n]*\|)+)/g,(block)=>{
    const lines = block.trim().split(/\n/);
    const cells = (line)=>line.replace(/^\s*\|/,'').replace(/\|\s*$/,'').split('|').map(c=>c.trim());
    const sep = lines.length > 1 && /^[\s:\-|]+$/.test(lines[1]);
    const rows = sep ? { head: cells(lines[0]), body: lines.slice(2).map(cells) }
                     : { head: null, body: lines.map(cells) };
    let h = '<table>';
    if (rows.head) h += `<thead><tr>${rows.head.map(c=>`<th>${c||'&nbsp;'}</th>`).join('')}</tr></thead>`;
    h += '<tbody>';
    for (const row of rows.body) h += `<tr>${row.map(c=>`<td>${c||'&nbsp;'}</td>`).join('')}</tr>`;
    h += '</tbody></table>';
    return `\n\n${h}\n\n`;
  });
  // Blockquote: consecutive "> " lines (matched post-escape as "&gt;").
  t = t.replace(/(?:^|\n)((?:&gt;\s?[^\n]*)(?:\n&gt;\s?[^\n]*)*)/g,(block)=>{
    const q = block.replace(/^&gt;\s?/gm,'').trim();
    return `\n\n<blockquote>${q}</blockquote>\n\n`;
  });
  // Horizontal rule: a standalone line of ---- *** ___.
  t = t.replace(/(?:^|\n)([-*_]{3,})\s*(?=\n|$)/g,'\n\n<hr>\n\n');
  t = t.replace(/^#### (.+)$/gm,(_,h)=>`\n\n<h4>${h}</h4>\n\n`);
  t = t.replace(/^### (.+)$/gm,(_,h)=>`\n\n<h3>${h}</h3>\n\n`);
  t = t.replace(/^## (.+)$/gm,(_,h)=>`\n\n<h2>${h}</h2>\n\n`);
  t = t.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  // Images wrapped in links: [![alt](img)](url) → one clickable image.
  t = t.replace(/\[!\[([^\]]*)\]\(([^)\s]+)\)\]\(([^)\s]+)\)/g,(m,alt,img,url)=>{
    let i = img.trim(); if (/^\/\//.test(i)) i = 'https:' + i;
    let u = url.trim(); if (/^\/\//.test(u)) u = 'https:' + u;
    if (!/^https?:\/\//i.test(i) || !/^https?:\/\//i.test(u)) return m;
    return `<a href="${u}" target="_blank" rel="noreferrer" class="md-img-link"><img class="md-img" src="${i}" alt="${alt}" loading="lazy"></a>`;
  });
  // Images ![alt](url) — clickable, protocol-relative URLs normalized.
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g,(m,alt,url)=>{
    let u = url.trim();
    if (/^\/\//.test(u)) u = 'https:' + u;
    if (!/^https?:\/\//i.test(u)) return m;
    return `<a href="${u}" target="_blank" rel="noreferrer" class="md-img-link"><img class="md-img" src="${u}" alt="${alt}" loading="lazy"></a>`;
  });
  // Markdown links [text](url) — including protocol-relative ones.
  t = t.replace(/\[([^\]]+)\]\(((?:https?:)?\/\/[^)\s]+)\)/g,(m,txt,url)=>{
    let u = url.trim();
    if (/^\/\//.test(u)) u = 'https:' + u;
    return `<a href="${u}" target="_blank" rel="noreferrer">${txt}</a>`;
  });
  // Bare URLs become clickable links.
  t = t.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g,(m,pre,u)=>`${pre}<a href="${u}" target="_blank" rel="noreferrer">${u}</a>`);
  // _italics_ (only as standalone emphasis, not inside words).
  t = t.replace(/(^|[\s(])_([^_]{1,120}?)_(?=$|[\s.,!?);:])/g,'$1<em>$2</em>');
  t = t.replace(/(?:^|\n)((?:[-*] .+(?:\n|$))+)/g,(block)=>{
    const items = block.trim().split(/\n/).map(l=>l.replace(/^[-*] /,'')).map(i=>`<li>${i}</li>`).join('');
    return `\n\n<ul>${items}</ul>\n\n`;
  });
  t = t.replace(/(?:^|\n)((?:\d+\. .+(?:\n|$))+)/g,(block)=>{
    const items = block.trim().split(/\n/).map(l=>l.replace(/^\d+\. /,'')).map(i=>`<li>${i}</li>`).join('');
    return `\n\n<ol>${items}</ol>\n\n`;
  });
  t = t.replace(/^\s*\n+/,'').replace(/\n+\s*$/,'');
  t = t.split(/\n{2,}/).filter(Boolean).map(p=>{
    if (/^\s*<(h[1-6]|ul|ol|pre|table|blockquote|hr)/.test(p)) return p;
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
  if (!sources || sources.length === 0) return;
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
/* Resolves with the text actually shown (partial, if stopped mid-stream). */
function streamIntoMessage(el, answerText, speed=14, avatar=null){
  return new Promise(resolve=>{
    const answer = el.querySelector('.answer');
    if (answer) answer.innerHTML='';
    if (avatar) setLogoState(avatar, 'talking');
    let i=0;
    const chunk = Math.max(2, Math.round(answerText.length/120));
    const tick = ()=>{
      if (stopRequested){
        if (answer) answer.innerHTML = renderMarkdown(answerText.slice(0,i));
        if (avatar) setLogoState(avatar, 'idle');
        resolve(answerText.slice(0,i));
        return;
      }
      i += chunk;
      if (answer) { answer.innerHTML = renderMarkdown(answerText.slice(0,i) + (i<answerText.length? '▍':'')); }
      messages.scrollTop = messages.scrollHeight;
      if (i < answerText.length) setTimeout(tick, speed);
      else { if (answer) answer.innerHTML = renderMarkdown(answerText); if (avatar) setLogoState(avatar, 'idle'); resolve(answerText); }
    };
    tick();
  });
}

/* ---------- Web search pipeline simulation ---------- */
let stopRequested = false;
let turnAbort = null; // AbortController for the in-flight turn's network work
function setSending(v){
  sendBtn.classList.toggle('stop', v);
  sendBtn.disabled = false;
  promptEl.disabled = false;
  updateQueueBadge();
}
/* Stop the active turn: cancels network requests, unblocks the composer
   immediately, and keeps whatever text already streamed into the answer. */
function stopTurn(){
  stopRequested = true;
  if (turnAbort){ try { turnAbort.abort(); } catch {} }
  if (isBusy()) setSending(false);
}
function toggleSendBtn(){ sendBtn.disabled = !promptEl.value.trim() && !hasPendingAttachments() && !sendBtn.classList.contains('stop'); }

/* ---------- Prompt queue (submit while streaming) ----------
   If the user submits while Auralis is still generating, the message goes
   into a queue; as soon as the active stream finishes it auto-fires. */
const promptQueue = [];
function isBusy(){ return sendBtn.classList.contains('stop'); }
function queueCount(){ return promptQueue.length; }

function enqueuePrompt(text, attachments){
  promptQueue.push({ text, attachments });
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
    if (stopRequested) break;
    const next = promptQueue.shift();
    updateQueueBadge();
    // Reset the stop flag so a previously-aborted stream doesn't kill the queued one.
    stopRequested = false;
    setSending(true);
    await runPipelineDeferred(next.text, next.attachments);
    setSending(false);
    renderSidebar();
    if (stopRequested) break;
  }
}
function runPipelineDeferred(text, attachments){ return runPipeline(text, { deep: state.settings.deep, web: state.settings.web, attachments }); }

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

/* ---------- Real backend search (/api/search) ---------- */
function hostOf(u){ try { return new URL(u).hostname.replace(/^www\./,''); } catch { return u; } }
/* Conversation memory: the last few finished turns of the current chat, sent
   with each request so the AI understands follow-ups ("and what about X?").
   The in-flight user question (last 'user' entry) is excluded — it is sent
   separately as the query. */
function chatHistory(){
  const chat = currentChat();
  if (!chat) return [];
  const out = [];
  for (const m of chat.messages){
    if (m.role === 'user') out.push({ role:'user', text:m.text });
    else if (m.role === 'ai' && m.text && m.text.trim()) out.push({ role:'assistant', text:m.text });
  }
  if (out.length && out[out.length-1].role === 'user') out.pop();
  return out.slice(-12);
}
/* Persistent memory id: a stable per-device token so the server can attach
   facts ("remember that X") to this user across ALL chats, even without an
   account. Sent with every request. */
function memoryId(){
  let id = localStorage.getItem('auralis.memoryId');
  if (!id){
    id = 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,10);
    localStorage.setItem('auralis.memoryId', id);
  }
  return id;
}
/* Per-browser chat log: survives server redeploys, so "what did we talk
   about in our previous chat?" still works even when the server DB was
   wiped. Sent with every request; recall lists these if present. */
const CHATLOG_KEY = 'auralis.chatlog';
function localChatLog(){
  try{
    const arr = JSON.parse(localStorage.getItem(CHATLOG_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter(t => typeof t === 'string' && t.trim()).slice(-12) : [];
  }catch{ return []; }
}
function rememberLocalChat(q){
  try{
    const arr = localChatLog();
    const clean = String(q || '').replace(/\s+/g,' ').trim().slice(0,200);
    if (!clean) return;
    if (arr[arr.length-1] === clean) return;
    arr.push(clean);
    localStorage.setItem(CHATLOG_KEY, JSON.stringify(arr.slice(-20)));
  }catch{}
}
async function apiSearch(query, { browser = false, web = true, deep = false, attachment = null, signal = null, onLog = null, onDelta = null } = {}){
  rememberLocalChat(query);
  const doFetch = (ctrl) => fetch('/api/search', {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({
      query,
      browserSynthesis: !!browser,
      web: !!web,
      deep: !!deep,
      stream: true, // NDJSON progress: what he's searching, reading, writing
      geminiKey: getGeminiKey(),
      instructions: getInstructions(),
      attachment: attachment && attachment.text ? { name: attachment.name, text: attachment.text } : null,
      history: chatHistory(),
      memoryId: memoryId(),
      localChatLog: localChatLog()
    }),
    signal: ctrl.signal,
  });
  try {
    const ctrl = new AbortController();
    // Server-side synthesis runs the local LFM model on CPU and can take a few
    // minutes on long research prompts; the Stop button aborts early.
    const timer = setTimeout(()=>ctrl.abort(), 240000);
    const onOuterAbort = ()=>ctrl.abort();
    if (signal){
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    let res;
    try {
      res = await doFetch(ctrl);
      // Free-tier hosts (Render) spin down when idle: the first request after
      // sleep 502s while the instance boots. Wait and try once more.
      if ((res.status === 502 || res.status === 503) && !ctrl.signal.aborted){
        if (onLog) onLog('Server was asleep — waking it up…');
        await sleep(8000);
        if (ctrl.signal.aborted) return null;
        res = await doFetch(ctrl);
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
    if (!res.ok) return null;
    // NDJSON stream: {"t":"log","msg":...} lines, then {"t":"result",...}
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('ndjson') && res.body){
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', result = null;
      while (true){
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0){
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.t === 'log'){ if (onLog) onLog(ev.msg); }
            else if (ev.t === 'delta'){ if (onDelta) onDelta(ev.v); }
            else if (ev.t === 'result') result = ev;
          } catch {}
        }
      }
      return result;
    }
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

/* ---------- Gemini attachment helpers (used when a key is saved) ---------- */
async function geminiVision(question, dataUrls){
  const res = await fetch('/api/vision', {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ question, images: dataUrls, geminiKey: getGeminiKey() }),
  });
  const j = await res.json().catch(()=>({}));
  if (!res.ok || !j.text) throw new Error(j.error || 'Gemini vision failed');
  return j.text;
}
async function geminiTranscribe(file){
  const audio = await readAsDataURL(file);
  const res = await fetch('/api/transcribe', {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ audio, geminiKey: getGeminiKey() }),
  });
  const j = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(j.error || 'Gemini transcription failed');
  return j.text || '';
}

/* ---------- Local engine status (no API keys — models are local) ---------- */
function updateProviderStatus(){
  // The old sidebar provider row is gone; this now only refreshes the model
  // manager panel so download progress stays live while it's open.
  if (modelPanel && !modelPanel.hidden) renderModelList();
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
/* Offline messages still get classified, so "hi" isn't answered with a
   research dump even without the backend. Mirrors intent.js in miniature. */
const OFF_CASUAL = new Set([
  'hi','hello','hey','yo','sup','howdy','hiya','hey there','hello there','hi there',
  'good morning','good afternoon','good evening','morning','evening',
  'thanks','thank you','thx','ty','thanks a lot','thank you very much','appreciate it',
  'no problem','no worries','np','anytime','youre welcome','sure thing',
  'ok','okay','k','got it','gotcha','alright','sure','yeah','yes','no','fine','right','cool','nice',
  'awesome','great','perfect','sweet','wow','nice one','good to know','lol','lmao','haha','hahaha','hehe',
  'bye','goodbye','good night','goodnight','see you','see ya','see you later','cya','later','peace','take care','gtg',
  'how are you','how r u','hru','hows it going','how is it going','whats up','what is up','wassup',
  'whats new','how have you been','what are you up to','wyd','howd your day','hows your day',
  'ok thanks','okay thanks','thanks anyway','sounds good','fair enough','you too','have a good day','have a nice day',
  'yes please','go ahead','continue','keep going','more','tell me more','what else','again','anyway',
]);
function offNorm(q){
  return q.toLowerCase().replace(/'/g,'').replace(/\s+/g,' ').trim().replace(/[?!.,:;]+$/,'');
}
function offlineDetect(q){
  const n = offNorm(q);
  if (OFF_CASUAL.has(n) || /^(hi|hey|hello|yo|sup|howdy|hiya)( there| everyone| guys| friend)?$/.test(n)) return 'casual';
  if (/\b(joke|poem|haiku|sonnet|lyrics|story about|tell me a|write me|make me|write a|create a|translate|rewrite|paraphrase|brainstorm)\b/.test(n)) return 'creative';
  if (/([\d.]+)\s*(?:percent|%)\s*of\s*([\d.]+)/i.test(n)) return 'calc';
  if (/(-?[\d.]+)\s*([+x×*\-/^])\s*(-?[\d.]+)/i.test(n)) return 'calc';
  return 'research';
}
function offlineReply(q, intent){
  const n = offNorm(q);
  if (intent === 'casual'){
    if (/^(bye|goodbye|good night|goodnight|see you|cya|later|peace|take care|gtg)/.test(n)) return "Goodbye! Come back whenever you need the web researched.";
    if (/^(thanks|thank|thx|ty|appreciate)/.test(n) || /^(no problem|no worries|anytime|yw|youre welcome)/.test(n)) return "You're welcome! Happy to help — ask me anything else.";
    if (/^(hi|hey|hello|yo|howdy|hiya)|^(good )?(morning|afternoon|evening|day)/.test(n)) return "Hey there! I'm Auralis, your web research assistant. Give me a question and I'll dig into the web for a grounded answer.";
    if (/^(how (are|is|s|r)|hru|whats up|what is up|wassup|sup|whats new|how have you been|hows your day|wyd)/.test(n)) return "Doing great — ready to dig. What should I research for you?";
    return "Happy to help! What would you like me to research?";
  }
  if (intent === 'calc'){
    const pct = n.match(/([\d.]+)\s*(?:percent|%)\s*of\s*([\d.]+)/i);
    if (pct) return `${pct[1]}% of ${pct[2]} = ${Math.round(parseFloat(pct[1])/100*parseFloat(pct[2])*1e4)/1e4}`;
    const m = n.match(/(-?[\d.]+)\s*([+x×*\-/^])\s*(-?[\d.]+)/);
    if (m){
      const a = parseFloat(m[1]), b = parseFloat(m[3]);
      let r;
      switch (m[2].replace('x','*').replace('×','*')){
        case '+': r = a+b; break;
        case '-': r = a-b; break;
        case '*': r = a*b; break;
        case '/': r = a/b; break;
        case '^': r = Math.pow(a,b); break;
      }
      return `${m[1]} ${m[2]} ${m[3]} = ${Math.round(r*1e4)/1e4}`;
    }
    return "I can handle simple math offline (like \"25*37\") — conversions and calendar math need the live server.";
  }
  if (/\bjoke/.test(n)) return "Here's one: why did the database break up with the spreadsheet? Too many unresolved relationships.";
  if (/\b(poem|haiku|sonnet)/.test(n)) return "A small one:\n\nAnswers hide in pages,\nlit by a patient, bright search —\nknowledge comes to light.";
  if (/\b(story about|write me|make me|tell me a)/.test(n)) return "I can write original fiction when I'm connected to my local model — right now I'm offline. Start the server (`npm start`) and try again.";
  return "That kind of creation needs my local model — connect to the server (`npm start`) and I'll make it happen.";
}
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
  if (kb){
    out += `${kb.short}\n\n`;
    out += `**Key points:**\n\n${kb.bullets.map(b=>'- '+b).join('\n')}\n\n`;
    out += `**Keep in mind:** ${kb.caveat}\n\n`;
  } else {
    const fallbacks = {
      howto:`For "${subj}", the reliable approach breaks into five steps: (1) define the goal and constraints precisely, (2) compare 2-3 mainstream approaches against each other, (3) pick the most documented option and try it on a small sample first, (4) validate against primary sources — official docs, papers, or maintainers — not just forums, and (5) iterate based on measured results rather than opinion.\n\n`,
      compare:`On "${subj}", there's no single winner — the sources converge on a framework: pick based on (1) your use case, (2) cost over 3-5 years, and (3) ecosystem maturity. The biggest differentiators are long-term maintenance and lock-in, not day-one features.\n\n`,
      why:`On "${subj}", the causes cluster into three buckets: structural factors (long-standing design or policy), recent catalysts (last few years of data or decisions), and secondary amplifiers that make the first two worse. The most-cited sources put the most weight on the structural bucket — which also means changes will take time.\n\n`,
      whatis:`"${subj}" is a well-documented concept with broad agreement on its definition across the sources, some controversy around the edges, and a history that explains why it's framed differently in different communities. The technical sources are the most precise; the general-audience ones add context.\n\n`,
      recommend:`For "${subj}", the sources agree there's a shortlist, not a single best pick: a value/quality leader, a higher-cost performance runner-up, and a budget option that outperforms its price. Match your budget and priorities, then verify with hands-on reviews.\n\n`,
      future:`On "${subj}", the sources split between "sooner than most think" and "later than vendors claim". The honest consensus: the trend line is clearly in one direction, but the timeline depends on variables the sources can't yet measure (costs, regulation, adoption). Plan for the trend; don't bet the farm on the date.\n\n`,
      explain:`On "${subj}", the sources converge on the core facts but differ on emphasis: the technical/primary sources give the most reliable details, while the news and community sources add context on why it matters. The key nuance most summaries miss is that the answer depends on your specific use case — define that first.\n\n`,
    };
    out += (fallbacks[intent]||fallbacks.explain) + `\n`;
    out += `**Key points from the sources:**\n\n`;
    sources.slice(0,3).forEach((s,i)=>{
      out += `- [${s.displayUrl}](${s.url}) — ${s.snippet || `covers "${subj}" directly.`}\n`;
    });
    out += `\n`;
  }
  out += `Everything above is drawn from the sources listed below — open them to verify details or go deeper on any point.`;
  return out;
}

/* ---------- The pipeline runner ---------- */
/* Thinking indicator: the headline always reads "Thinking"; every internal
   step is recorded in an expandable details log so the user can see exactly
   what Auralis is doing (and what it found on the web). */
function makeStage(bubble){
  const el = document.createElement('div');
  el.className = 'stage';
  el.innerHTML = `
    <div class="stage-head">
      <span class="stage-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="stage-text">Thinking</span>
      <button class="stage-toggle" type="button" aria-expanded="false">
        <svg class="chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m6 9 6 6 6-6"/></svg>
        <span>details</span>
      </button>
    </div>
    <div class="stage-log"></div>`;
  const log = el.querySelector('.stage-log');
  const toggle = el.querySelector('.stage-toggle');
  toggle.addEventListener('click',(e)=>{
    e.stopPropagation();
    const open = el.classList.toggle('open');
    toggle.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  bubble.appendChild(el);
  return {
    el,
    step(text){
      if (!log.isConnected) return;
      const item = document.createElement('div');
      item.className = 'log-item';
      item.textContent = text;
      log.appendChild(item);
      while (log.children.length > 40) log.removeChild(log.firstChild);
      log.scrollTop = log.scrollHeight;
    },
    // One continuously-updating line for the live token feed while typing.
    live(text){
      if (!log.isConnected) return;
      let item = log.querySelector('.log-item.live');
      if (!item){
        item = document.createElement('div');
        item.className = 'log-item live';
        log.appendChild(item);
      }
      item.textContent = text;
      log.scrollTop = log.scrollHeight;
    }
  };
}

/* Shared synthesis: server research (or browser-local model) for a text
   query. Returns { sources, text, provider } or null when unavailable. */
async function fetchAnswer(userText, opts){
  // With a Gemini key, server-side Gemini synthesizes; otherwise the browser
  // model (when downloaded) reasons over the sources locally.
  const hasKey = !!getGeminiKey();
  const browserReady = !!(window.LocalAI && window.LocalAI.isReady());
  const callOpts = {
    browser: browserReady && !hasKey,
    web: opts.web !== false,
    deep: !!opts.deep,
    attachment: opts.attachment || null,
    signal: opts.signal || null,
    onLog: opts.onLog || null,
    onDelta: opts.onDelta || null
  };
  let api = await apiSearch(userText, callOpts);
  if (api && Array.isArray(api.sources)){
    if (browserReady && api.mode === 'browser' && api.text == null){
      // Server returned enriched sources (browser mode). Reason over them
      // locally in the browser with the LFM research model.
      let localText = null;
      try {
        if (opts.onLog) opts.onLog('Your browser model is writing the answer…');
        localText = await window.LocalAI.answer(userText, api.sources, opts.attachment, chatHistory(), getInstructions(), opts.onDelta || null);
      }
      catch { localText = null; }
      if (stopRequested) return null;
      if (localText && localText.text){
        return { sources: normalizeSources(api.sources), text: localText.text, provider: 'auralis-local (browser)' };
      }
      // Browser synthesis failed — fall back to the server's local model.
      const srv = await apiSearch(userText, Object.assign({}, callOpts, { browser:false }));
      if (srv && srv.text) return { sources: normalizeSources(srv.sources || []), text: srv.text, provider: 'auralis-local (server)' };
    } else if (api.text){
      return { sources: normalizeSources(api.sources), text: api.text, provider: hasKey ? 'gemini-2.0-flash' : 'auralis-local (server)' };
    }
  }
  return null;
}

/* Ask before pulling the 770 MB vision model: download / Gemini / cancel. */
let visionAskResolve = null;
function askVisionDownload(){
  return new Promise(resolve=>{
    visionAskResolve = resolve;
    visionAsk.hidden = false;
  });
}
function settleVisionAsk(v){
  if (!visionAskResolve) return;
  const r = visionAskResolve;
  visionAskResolve = null;
  visionAsk.hidden = true;
  r(v);
}

async function runPipeline(userText, opts){
  const chat = currentChat();
  let m;
  if (!opts.replace) {
    m = { id:uid(), role:'ai', text:'', sources:[], provider:'' };
    chat.messages.push(m);
    chat.updatedAt = Date.now();
    saveChats();
    renderMessages();
  } else {
    m = opts.replace;
    m.text=''; m.sources=[]; m.provider='';
    saveChats();
    renderMessages();
    await sleep(50);
  }
  const el = messages.querySelector(`.msg.ai[data-id="${m.id}"]`);
  if (!el){ return; }
  const bubble = el.querySelector('.bubble');
  const aiAvatar = el.querySelector('.avatar-ai');
  setLogoState(aiAvatar, 'thinking');

  const stage = makeStage(bubble);

  stopRequested = false;
  // Abort controller for this turn: Stop cancels network work immediately and
  // frees the composer without waiting for a long model generation.
  turnAbort = new AbortController();
  const signal = turnAbort.signal;
  let sources = [], text = null, provider = '';

  // Live typing surface. Model tokens arrive through onDelta; tokens before a
  // closing </think> stream into the details log, and the answer itself types
  // live into the bubble. When the turn finishes, the final render skips the
  // typewriter effect if we've already watched it being typed.
  const live = { el: null, buf: '', lastLog: 0 };
  const deltaSink = (chunk)=>{
    if (stopRequested || typeof chunk !== 'string' || !chunk) return;
    live.buf += chunk;
    const cut = live.buf.toLowerCase().indexOf('</think>');
    if (cut >= 0){
      const answerPart = live.buf.slice(cut + 8);
      if (!live.el){
        stage.el.remove();
        bubble.innerHTML = '';
        live.el = document.createElement('div');
        live.el.className = 'answer';
        bubble.appendChild(live.el);
        setLogoState(aiAvatar, 'talking');
      }
      live.el.innerHTML = renderMarkdown(answerPart) + '▍';
      messages.scrollTop = messages.scrollHeight;
    } else {
      const now = Date.now();
      if (now - live.lastLog > 90){
        live.lastLog = now;
        const tail = live.buf.slice(-200).replace(/\s+/g, ' ');
        stage.live('💭 ' + (tail.length >= 200 ? '…' : '') + tail);
      }
    }
  };

  try {
    const att = opts.attachments || {};
    const hadQuestion = !!(userText||'').trim();

    // 1) Voice notes: transcribe attached audio — Gemini when a key is saved,
    //    otherwise the local Whisper model.
    let transcript = '';
    if (att.audios && att.audios.length){
      const hasKey = !!getGeminiKey();
      for (const a of att.audios){
        stage.step(`Transcribing ${a.name} (${hasKey ? 'Gemini' : 'Whisper, on-device'})…`);
        let t = '';
        if (hasKey){
          try { t = await geminiTranscribe(a.file); } catch { t = ''; }
        }
        if (!t && window.LocalAI){
          const r = await window.LocalAI.transcribeFile(a.file);
          t = r.text || '';
        }
        transcript += (transcript ? '\n' : '') + t;
      }
      if (transcript.trim()) stage.step(`Heard: “${transcript.trim().slice(0, 120)}${transcript.trim().length > 120 ? '…' : ''}”`);
      else throw new Error('No speech detected in the attached audio.');
    }

    // 2) Images: Gemini vision when a key is saved (no download needed),
    //    otherwise the local vision model (LFM 2.5 VL, WebGPU) — asking
    //    before its ~770 MB download.
    let visionText = '';
    let visionBy = '';
    if (att.images && att.images.length){
      const hasKey = !!getGeminiKey();
      const vq = hadQuestion ? userText.trim() : 'Describe this image in detail.';
      if (hasKey){
        stage.step(`Analyzing image${att.images.length>1?'s':''} with Gemini…`);
        try {
          visionText = await geminiVision(vq, att.images.map(i=>i.dataUrl));
          if (visionText) visionBy = 'gemini';
        } catch { visionText = ''; }
      }
      if (!visionText){
        if (!(window.LocalAI && window.LocalAI.canAttempt())){
          throw new Error('The local vision model needs WebGPU (Chrome / Edge / Brave). For image analysis without any download, save a Gemini API key via ＋ Tools → Gemini API key.');
        }
        const vs = window.LocalAI.status().vision || { state: 'idle' };
        if (vs.state !== 'ready'){
          const choice = await askVisionDownload();
          if (choice === 'gemini'){
            openSettings('keys');
            throw new Error('Image analysis paused — save a Gemini key, then send the image again.');
          }
          if (choice === 'cancel') throw new Error('Image analysis cancelled.');
          window.LocalAI.setOptIn('vision', true);
          stage.step(vs.state === 'downloading'
            ? `Vision model already downloading — ${vs.percent || 0}%…`
            : 'Downloading the vision model (LFM 2.5 VL, ~770 MB, one time)…');
          openModelPanel();
          await window.LocalAI.download('vision');
        }
        for (const img of att.images){
          stage.step(`Analyzing ${img.name} (vision model, on-device)…`);
          const desc = await window.LocalAI.describeImage(img.dataUrl, vq);
          if (desc && desc.trim()){
            visionText += (visionText ? '\n\n' : '') + (att.images.length > 1 ? `**${img.name}** — ${desc}` : desc);
            if (!visionBy) visionBy = 'local';
          }
        }
      }
    }

    // 3) Build the query + attachment context for the research model.
    let attachment = null;
    if (att.docs && att.docs.length){
      const joined = att.docs.map(d => `# ${d.name}\n${d.text || ''}`).join('\n\n').slice(0, 12000);
      attachment = { name: att.docs.map(d=>d.name).join(', '), text: joined };
      stage.step(`Attached ${att.docs.length} document${att.docs.length>1?'s':''} (${att.docs.map(d=>d.name).join(', ')})`);
    }
    if (transcript){
      attachment = attachment || { name: 'voice note', text: '' };
      attachment.text = (attachment.text ? attachment.text + '\n\n' : '') + 'Voice note transcript:\n' + transcript;
    }
    if (visionText){
      attachment = attachment || { name: 'image analysis', text: '' };
      attachment.text = (attachment.text ? attachment.text + '\n\n' : '') +
        (visionBy === 'gemini' ? 'Gemini analysis of the attached image(s):\n' : 'Local vision model analysis of the attached image(s):\n') + visionText;
    }
    let query = userText.trim();
    if (!query && transcript) query = 'Summarize and respond to this voice note.';
    if (!query && attachment) query = 'Summarize the attached file.';

    // 4) Answer. Image-only turns (no question, or web off) are answered
    //    directly by the vision engine; everything else goes through research.
    if (visionText && (!hadQuestion || opts.web === false)){
      text = visionText;
      provider = visionBy === 'gemini' ? 'gemini-vision' : 'local-vision';
    } else {
      if (opts.web !== false) stage.step(`Searching the live web for “${query.slice(0, 90)}”…`);
      else stage.step('Web search is off — answering from knowledge' + (attachment ? ' + attachments' : '') + '…');
      const got = await fetchAnswer(query, Object.assign({}, opts, {
        attachment, signal,
        onLog: (msg)=>stage.step(msg),
        onDelta: deltaSink
      }));
      if (stopRequested) throw new DOMException('stopped', 'AbortError');
      if (got){
        sources = got.sources; text = got.text; provider = got.provider;
        if (sources.length){
          stage.step(`Collected ${sources.length} source${sources.length>1?'s':''}:`);
          sources.slice(0, 10).forEach(s => stage.step(`· ${s.title.slice(0, 70)} — ${s.displayUrl}`));
        } else {
          stage.step('No live results came back — answering without web citations.');
        }
      }
    }

    // 5) Offline fallback (no server reachable).
    if (!text){
      stage.step('Server unreachable — using the offline engine.');
      const oi = offlineDetect(query || userText);
      if (oi === 'research'){
        sources = makeSources(query || userText, opts.deep);
        text = synthesize(query || userText, opts.deep, 'offline-demo', sources);
      } else {
        sources = [];
        text = offlineReply(query || userText, oi);
      }
      provider = 'offline-demo';
    }
  } catch (err){
    if (err && (err.name === 'AbortError' || /aborted|AbortError/i.test(err.message || ''))){
      stopRequested = true;
    } else {
      sources = [];
      text = '⚠️ ' + (err && err.message ? err.message : 'Something went wrong while processing this turn.');
      provider = 'error';
    }
  } finally {
    if (turnAbort && turnAbort.signal === signal) turnAbort = null;
  }

  if (stopRequested){ stage.el.remove(); finish(m, chat, '_(stopped)_'); return; }
  stage.el.remove();

  m.sources = sources;
  m.text = text;
  m.provider = provider;

  const watchedItType = !!live.el && live.buf.toLowerCase().includes('</think>');
  bubble.innerHTML='';
  const answer = document.createElement('div');answer.className='answer';
  bubble.appendChild(answer);
  renderSourcesInto(bubble, sources);
  // Copy / Retry actions come from renderAI's actions row (outside the
  // bubble), so nothing extra is appended here.

  if (watchedItType){
    // The answer already typed itself live — just show the final render.
    answer.innerHTML = renderMarkdown(m.text);
    setLogoState(aiAvatar, 'idle');
    saveChats();
  } else {
    const shown = await streamIntoMessage(el, m.text, 10, aiAvatar);
    if (stopRequested && shown && shown !== m.text){ m.text = shown; saveChats(); }
    setLogoState(aiAvatar, 'idle');
    saveChats();
  }
}

function finish(m, chat, text){ m.text = text; m.sources=[]; saveChats(); renderMessages(); }

/* ---------- Send / retry ---------- */
async function send(text){
  text = (text??'').trim();
  if (!text && !hasPendingAttachments()) return;
  const atts = text ? (hasPendingAttachments() ? takeAttachments() : { images:[], audios:[], docs:[] }) : takeAttachments();
  const attSummary = summarizeAttachments(atts);
  let chat = currentChat();
  if (!chat){ newChat(); chat = currentChat(); }

  // /model — report the local inference engines (no API keys)
  if (/^\/model(\s.*)?$/i.test(text)){
    const LA = window.LocalAI;
    const st = LA ? LA.status() : {};
    const line = (k, label) => {
      const s = st[k] || { state:'idle' };
      const map = { ready:'✓ downloaded & ready', downloading:`downloading ${s.percent||0}%`, loading:'warming up…', error:'error — '+(s.error||''), idle:'not downloaded' };
      return `- **${label}** — ${map[s.state]||s.state}${s.state==='idle'&&LA&&LA.optedIn(k)?' (auto-loads on visit)':''}`;
    };
    addReplies(chat, text, `**Auralis models** (no API keys required — Gemini is optional)\n\n- **Gemini API key** — ${getGeminiKey() ? 'set ✓ (Gemini synthesizes answers; manage it via ＋ Tools → Gemini API key)' : 'not set (the local model handles everything; add one via ＋ Tools → Gemini API key)'}\n${line('text','Research · LFM 2.5 1.2B Thinking')}\n${line('vision','Vision · LFM 2.5 VL 450M — understands attached images')}\n${line('stt','Speech-to-text · Whisper — transcribes attached audio')}\n\nDownload or manage local models via the **＋ Tools → Local models** panel. Without any download, the server's local model covers research answers.`);
    return;
  }

  // /clear — wipe the current chat
  if (/^\/clear(\s.*)?$/i.test(text)){
    chat.messages = [];
    chat.title = 'New research';
    chatTitle.textContent = chat.title;
    chat.updatedAt = Date.now();
    localStorage.removeItem(CHATLOG_KEY);
    saveChats();
    renderBoth();
    addReplies(chat, text, `Chat cleared. What would you like to research?`);
    return;
  }
  // /help — list all commands
  if (/^\/help(\s.*)?$/i.test(text)){
    const lines = COMMANDS.map(c => `- \`${c.name}\` — ${c.desc}`).join('\n');
    addReplies(chat, text, `**Auralis commands**\n\n${lines}\n\nTip: type \`/\` in the prompt box and a menu pops up with arrow-key navigation. Use the **＋** button for web/deep toggles, file attachments (images use the local Vision model, audio gets transcribed), voice dictation, and local model downloads.`);
    return;
  }

  chat.messages.push({ id:uid(), role:'user', text, attachments: attSummary });

  // Gemini-key gate: chatting without a key asks (once per session) whether to
  // use a local model instead. The message is never lost — every choice (or a
  // dismissal) lets it continue, via the server's local model if no key is set.
  await maybeAskAboutKey();

  const firstUser = chat.messages.filter(m=>m.role==='user').length===1;
  if (chat.title==='New research' && firstUser){
    chat.title = titleFrom(text || (attSummary[0] ? attSummary[0].name : '') || 'Attachment');
    chatTitle.textContent = chat.title;
  }
  chat.updatedAt = Date.now();
  saveChats();
  renderBoth();

  promptEl.value='';promptEl.style.height='auto';
  toggleSendBtn();

  const turnText = text || '';
  // If Auralis is already streaming, queue this message instead of blocking
  // or discarding it. It auto-fires when the active stream finishes.
  if (isBusy()){
    enqueuePrompt(turnText, atts);
    return;
  }
  setSending(true);
  await runPipeline(turnText, { deep: state.settings.deep, web: state.settings.web, attachments: atts });
  setSending(false);
  renderSidebar();
  // Auto-fire any prompts that were queued while this one ran.
  if (!stopRequested) await drainQueue();
}

async function retry(text, replaceId){
  const chat = currentChat();
  const m = chat.messages.find(x=>x.id===replaceId);
  if (!m) return;
  stopRequested=false; setSending(true);
  await runPipeline(text, { deep: state.settings.deep, web: state.settings.web, replace:m });
  setSending(false);
  renderSidebar();
  // Auto-fire any prompts that were queued while this retry ran.
  if (!stopRequested) await drainQueue();
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
  if (e.key==='Escape'){ stopTurn(); }
}, { passive:false });

sendBtn.addEventListener('click',()=>{
  if (sendBtn.classList.contains('stop')){ stopTurn(); return; }
  send(promptEl.value);
});

const _qBadge = document.getElementById('queueBadge');
if (_qBadge){ _qBadge.style.cursor = 'pointer'; _qBadge.addEventListener('click', clearQueue); }

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
checkAuthStatus();
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

/* ---------- Slash command menu ---------- */
const cmdMenu = document.getElementById('cmdMenu');

const CLEAR_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></svg>`;
const MODEL_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 3 7l9 5 9-5-9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/></svg>`;
const HELP_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.1 9a2.9 2.9 0 1 1 5.8 0c0 2-2.9 2-2.9 4"/><path d="M12 17h.01"/></svg>`;

const COMMANDS = [
  { name:'/clear',          icon: CLEAR_ICON,  hint:'',          desc:'Clear the current chat history' },
  { name:'/model',          icon: MODEL_ICON,  hint:'',          desc:'Show which model Auralis is running locally' },
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
    if (e.key==='ArrowDown'){ e.preventDefault(); e.stopImmediatePropagation(); moveCmd(1); return; }
    if (e.key==='ArrowUp'){ e.preventDefault(); e.stopImmediatePropagation(); moveCmd(-1); return; }
    if (e.key==='Enter' && !e.shiftKey){
      const items = cmdMenu.querySelectorAll('.cmd-menu-item');
      if (items.length){
        e.preventDefault(); e.stopImmediatePropagation();
        const list = COMMANDS.filter(c =>
          !promptEl.value.trim().toLowerCase() ||
          c.name.toLowerCase().includes(promptEl.value.trim().toLowerCase()) ||
          c.desc.toLowerCase().includes(promptEl.value.trim().toLowerCase()));
        pickCmd(list[cmdActiveIdx] || COMMANDS[cmdActiveIdx]);
        return;
      }
    }
    if (e.key==='Escape'){ e.preventDefault(); e.stopImmediatePropagation(); cmdMenu.hidden = true; cmdMenu.innerHTML=''; return; }
  }
}, { capture:true });

/* ============================================================
   ＋ TOOLS MENU · ATTACHMENTS · VOICE · LOCAL MODEL MANAGER
   ============================================================ */

/* ---------- Plus (tools) menu ---------- */
const PLUS_ICONS = {
  web:   `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/></svg>`,
  deep:  `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4h16v16H4z"/><path d="M4 9h16M9 4v16"/></svg>`,
  attach:`<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`,
  voice: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`,
  model: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 3 7l9 5 9-5-9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/></svg>`,
  key:   `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.8 12.2 8.7-8.7M16 4l3 3M13 7l3 3"/></svg>`
};

function plusItems(){
  const hasKey = !!getGeminiKey();
  return [
    { key:'web',   icon:PLUS_ICONS.web,   name:'Web search',   desc:'Search the live web for grounded, cited answers', toggle:state.settings.web },
    { key:'deep',  icon:PLUS_ICONS.deep,  name:'Deep research',desc:'More results + full page content for deeper reports', toggle:state.settings.deep },
    { key:'attach',icon:PLUS_ICONS.attach,name:'Attach file',  desc:'Images (local Vision model) · audio (transcribed) · PDF & text docs' },
    { key:'voice', icon:PLUS_ICONS.voice, name:'Voice input',  desc:'Dictate with your microphone — no download needed' },
    { key:'key',   icon:PLUS_ICONS.key,   name:'Gemini API key', desc: hasKey ? 'Set — open to change or remove it' : 'Not set — chat works without one via the local model', toggle:hasKey },
    { key:'model', icon:PLUS_ICONS.model, name:'Local models', desc:'Download the research / vision / speech models on your terms' },
  ];
}

function renderPlusMenu(){
  const items = plusItems();
  plusMenu.innerHTML = `<div class="cmd-menu-head">Tools</div>` +
    items.map((it,i)=>`
    <div class="cmd-menu-item" data-idx="${i}">
      <span class="cmd-menu-ico">${it.icon}</span>
      <span class="cmd-menu-body"><span class="cmd-menu-name">${escapeHtml(it.name)}</span><span class="cmd-menu-desc">${escapeHtml(it.desc)}</span></span>
      ${it.toggle === true || it.toggle === false ? `<span class="pm-check ${it.toggle?'on':''}">${it.toggle?'✓':''}</span>` : ''}
    </div>`).join('');
  plusMenu.querySelectorAll('.cmd-menu-item').forEach(el=>{
    // stopPropagation: pickPlusItem clears the menu (detaching this node) and
    // may open a panel — the document-level closers must not see this event.
    el.addEventListener('mousedown',(e)=>{ e.preventDefault(); e.stopPropagation(); pickPlusItem(items[Number(el.dataset.idx)]); });
  });
}
function hidePlusMenu(){ plusMenu.hidden = true; plusMenu.innerHTML=''; }
function pickPlusItem(it){
  hidePlusMenu();
  if (!it) return;
  if (it.key === 'web')  { state.settings.web  = !state.settings.web;  saveSettings(); renderPlusMenuLater(); }
  if (it.key === 'deep') { state.settings.deep = !state.settings.deep; saveSettings(); renderPlusMenuLater(); }
  if (it.key === 'attach'){ fileInput.click(); }
  if (it.key === 'voice'){ toggleDictation(); }
  if (it.key === 'key'){ openSettings('keys'); }
  if (it.key === 'model'){ openModelPanel(); }
}
function renderPlusMenuLater(){ setTimeout(()=>{ renderPlusMenu(); plusMenu.hidden=false; }, 10); }

plusBtn.addEventListener('click',()=>{
  if (plusMenu.hidden){ renderPlusMenu(); plusMenu.hidden = false; }
  else hidePlusMenu();
});
document.addEventListener('mousedown',(e)=>{
  if (!plusMenu.hidden && !plusMenu.contains(e.target) && !plusBtn.contains(e.target)) hidePlusMenu();
});

/* ---------- Attachments ---------- */
function readAsDataURL(file){
  return new Promise((res,rej)=>{
    const r = new FileReader();
    r.onload = ()=>res(r.result);
    r.onerror = ()=>rej(new Error('Could not read '+file.name));
    r.readAsDataURL(file);
  });
}
function fileToThumb(file){
  return new Promise(res=>{
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = ()=>{
      const s = 128;
      const scale = Math.min(s/img.naturalWidth, s/img.naturalHeight, 1);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth*scale));
      c.height = Math.max(1, Math.round(img.naturalHeight*scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      try { res(c.toDataURL('image/jpeg', 0.8)); } catch { res(''); }
    };
    img.onerror = ()=>{ URL.revokeObjectURL(url); res(''); };
    img.src = url;
  });
}

/* PDF text extraction — pdf.js loads lazily from the CDN only when a PDF
   is actually attached (the same on-demand pattern Local-Browser-AI uses). */
let _pdfjs = null;
function pdfjs(){
  return _pdfjs || (_pdfjs = import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs').then(m=>{
    m.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
    return m;
  }));
}
async function extractPdfText(file){
  const m = await pdfjs();
  const buf = await file.arrayBuffer();
  const pdf = await m.getDocument({ data: buf }).promise;
  let out = '';
  const max = Math.min(pdf.numPages, 20);
  for (let i=1; i<=max; i++){
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    out += tc.items.map(it=>it.str).join(' ') + '\n';
  }
  return out.trim();
}

async function attachFiles(list){
  for (const f of Array.from(list || [])){
    try {
      if (f.type.startsWith('image/')){
        const dataUrl = await readAsDataURL(f);
        const thumb = await fileToThumb(f);
        pending.images.push({ name:f.name || 'image', dataUrl, thumb });
      } else if (f.type.startsWith('audio/')){
        pending.audios.push({ name:f.name || 'audio', file:f });
      } else if (/\.pdf$/i.test(f.name)){
        const text = await extractPdfText(f);
        if (!text) throw new Error('no extractable text (scanned PDF?)');
        pending.docs.push({ name:f.name, text });
      } else if (/\.(txt|md|markdown|csv|json|log)$/i.test(f.name) || f.type.startsWith('text/') || /json/.test(f.type)){
        const text = await f.text();
        pending.docs.push({ name:f.name, text: text.slice(0, 60000) });
      } else {
        toast(`Unsupported file: ${f.name} — try images, audio, PDF, or txt/md/csv/json`, 'error');
      }
    } catch (err){
      toast(`Could not read ${f.name}: ${err.message || err}`, 'error');
    }
  }
  renderAttachRow();
  toggleSendBtn();
}
fileInput.addEventListener('change',()=>{
  if (fileInput.files && fileInput.files.length) attachFiles(fileInput.files);
  fileInput.value = '';
});

function renderAttachRow(){
  const all = [
    ...pending.images.map((a,i)=>({ kind:'images', i, html:`<img class="att-thumb" src="${a.thumb||a.dataUrl}" alt=""><span class="att-name">${escapeHtml(a.name)}</span>` })),
    ...pending.audios.map((a,i)=>({ kind:'audios', i, html:`<span class="att-chip">🎙 ${escapeHtml(a.name)}</span>` })),
    ...pending.docs.map((a,i)=>({ kind:'docs', i, html:`<span class="att-chip">📄 ${escapeHtml(a.name)}</span>` })),
  ];
  attachRow.hidden = all.length === 0;
  attachRow.innerHTML = all.map(a=>`
    <div class="attach-pill" data-kind="${a.kind}" data-i="${a.i}">
      ${a.html}
      <button class="att-x" title="Remove">✕</button>
    </div>`).join('');
  attachRow.querySelectorAll('.attach-pill').forEach(p=>{
    p.querySelector('.att-x').addEventListener('click',(e)=>{
      e.stopPropagation();
      pending[p.dataset.kind].splice(Number(p.dataset.i),1);
      renderAttachRow();
      toggleSendBtn();
    });
  });
}

/* Paste images straight into the prompt, and drop files onto the composer.
   Very long text pastes become a document attachment instead of flooding the
   prompt box. */
const PASTE_ATTACH_THRESHOLD = 1500;
promptEl.addEventListener('paste',(e)=>{
  const files = e.clipboardData && e.clipboardData.files;
  if (files && files.length){ e.preventDefault(); attachFiles(files); return; }
  const text = e.clipboardData && e.clipboardData.getData('text/plain');
  if (text && text.length > PASTE_ATTACH_THRESHOLD){
    e.preventDefault();
    const n = pending.docs.filter(d => /^Pasted text/.test(d.name)).length + 1;
    const name = n > 1 ? `Pasted text ${n}` : 'Pasted text';
    pending.docs.push({ name, text: text.slice(0, 60000) });
    renderAttachRow();
    toggleSendBtn();
    toast(`Long paste (${Math.round(text.length/100)/10}k chars) attached as “${name}” — ask anything about it.`);
  }
});
const composerInner = document.querySelector('.composer-inner');
if (composerInner){
  ['dragover','dragenter'].forEach(ev=>composerInner.addEventListener(ev,(e)=>{ e.preventDefault(); composerInner.classList.add('drag'); }));
  ['dragleave','drop'].forEach(ev=>composerInner.addEventListener(ev,(e)=>{ e.preventDefault(); composerInner.classList.remove('drag'); }));
  composerInner.addEventListener('drop',(e)=>{
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) attachFiles(files);
  });
}

/* ---------- Voice dictation (Web Speech API — no download) ---------- */
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, dictating = false, dictBase = '';

function toggleDictation(){
  if (!SpeechRec){
    toast('Voice input needs the Web Speech API — try Chrome or Edge. You can still attach an audio file to have it transcribed locally.', 'error');
    return;
  }
  if (dictating){ stopDictation(); return; }
  recog = new SpeechRec();
  recog.continuous = true;
  recog.interimResults = true;
  recog.lang = navigator.language || 'en-US';
  dictBase = promptEl.value ? promptEl.value.replace(/\s+$/,'') + ' ' : '';
  recog.onresult = (e)=>{
    let interim = '', fin = '';
    for (let i = e.resultIndex; i < e.results.length; i++){
      const r = e.results[i];
      if (r.isFinal) fin += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (fin){
      dictBase += fin + ' ';
      promptEl.value = dictBase;
    } else {
      promptEl.value = dictBase + interim;
    }
    toggleSendBtn();
    autosize();
  };
  recog.onerror = (e)=>{
    if (e.error === 'not-allowed') toast('Microphone access was blocked — allow it in the browser address bar.', 'error');
    stopDictation();
  };
  recog.onend = ()=>{ if (dictating) stopDictation(); };
  try { recog.start(); dictating = true; }
  catch { dictating = false; }
  micChip.classList.toggle('recording', dictating);
  micChip.querySelector('span').textContent = dictating ? 'Listening — tap to stop' : 'Voice';
  promptEl.focus();
}
function stopDictation(){
  dictating = false;
  try { recog && recog.stop(); } catch {}
  micChip.classList.remove('recording');
  micChip.querySelector('span').textContent = 'Voice';
  toggleSendBtn();
  autosize();
}
micChip.addEventListener('click', toggleDictation);

/* ---------- Local model manager panel ---------- */
function openModelPanel(){ modelPanel.hidden = false; renderModelList(); }
function closeModelPanel(){ modelPanel.hidden = true; }
document.getElementById('modelPanelClose').addEventListener('click', closeModelPanel);
document.addEventListener('mousedown',(e)=>{
  // Ignore the mousedown that opened the panel from the ＋ menu (it bubbles
  // up here and would otherwise close the panel immediately).
  if (!modelPanel.hidden && !modelPanel.contains(e.target) && !plusMenu.contains(e.target) && !plusBtn.contains(e.target)) closeModelPanel();
});

function statusLine(s){
  switch (s.state){
    case 'ready':       return { txt:'✓ Downloaded — running locally', cls:'ok' };
    case 'downloading': return { txt:`Downloading… ${s.percent||0}%`, cls:'dl' };
    case 'loading':     return { txt:'Warming up on the GPU…', cls:'dl' };
    case 'error':       return { txt:'Error — ' + (s.error || 'failed to load'), cls:'err' };
    default:            return { txt:'Not downloaded' + (window.LocalAI && window.LocalAI.optedIn ? (window.LocalAI.optedIn(s._kind) ? ' · auto-loads on visit' : '') : ''), cls:'' };
  }
}

function renderModelList(){
  if (!window.LocalAI){ modelList.innerHTML = '<div class="mp-empty">Local models unavailable.</div>'; return; }
  const defs = window.LocalAI.models();
  const st = window.LocalAI.status();
  const kinds = ['text','vision','stt'];
  const keyNote = getGeminiKey()
    ? `<div class="mp-keynote">🔑 Gemini key active — Gemini handles vision & transcription for attachments too. Local models are the keyless fallback.</div>`
    : '';
  modelList.innerHTML = keyNote + kinds.map(k=>{
    const d = defs[k], s = Object.assign({ _kind:k }, st[k] || { state:'idle', percent:0 });
    const sl = statusLine(s);
    const busy = s.state === 'downloading' || s.state === 'loading';
    const gpuNote = d.needsWebGPU && !window.LocalAI.canAttempt() ? `<div class="mp-gpu">⚠️ needs WebGPU (Chrome / Edge / Brave)</div>` : '';
    const bar = s.state === 'downloading' ? `<div class="mp-bar"><div class="mp-fill" style="width:${s.percent||0}%"></div></div>` : '';
    const btn = busy ? `<button class="mp-btn" disabled>…</button>`
      : s.state === 'ready' ? `<button class="mp-btn subtle" data-unload="${k}">Unload</button>`
      : `<button class="mp-btn" data-dl="${k}">Download</button>`;
    return `<div class="mp-item">
      <div class="mp-row">
        <div class="mp-info">
          <div class="mp-label">${escapeHtml(d.label)} <span class="mp-size">${d.sizeText}</span></div>
          <div class="mp-blurb">${escapeHtml(d.blurb)}</div>
          <div class="mp-status ${sl.cls}">${sl.txt}</div>
          ${gpuNote}${bar}
        </div>
        ${btn}
      </div>
    </div>`;
  }).join('');
  modelList.querySelectorAll('[data-dl]').forEach(b=>{
    b.addEventListener('click',()=>{
      const k = b.dataset.dl;
      window.LocalAI.setOptIn(k, true);
      window.LocalAI.download(k).then(()=>{
        toast(k === 'text' ? 'Research model ready — Auralis will now answer in your browser.' :
              k === 'vision' ? 'Vision model ready — attach an image and ask about it.' :
                               'Speech-to-text ready — attach an audio file to transcribe it.');
      }).catch(err=>{
        toast('Model download failed: ' + (err && err.message || err), 'error');
      });
      renderModelList();
    });
  });
  modelList.querySelectorAll('[data-unload]').forEach(b=>{
    b.addEventListener('click',()=>{
      window.LocalAI.unload(b.dataset.unload);
      renderModelList();
      updateProviderStatus();
    });
  });
}

/* ---------- Settings (tabbed): API keys · Instructions · Appearance · About ---------- */
const INSTRUCTIONS_KEY = 'auralis.instructions';
const THEME_KEY = 'auralis.theme';
function getInstructions(){ try { return localStorage.getItem(INSTRUCTIONS_KEY) || ''; } catch { return ''; } }

function updateKeyStatus(){
  const k = getGeminiKey();
  keyStatus.textContent = k
    ? `Current key: ${k.slice(0, 6)}…${k.slice(-4)} — Gemini synthesizes your answers`
    : 'No key saved — the local model handles answers.';
  keyStatus.classList.toggle('set', !!k);
}

function openSettings(tab){
  settingsWrap.hidden = false;
  updateKeyStatus();
  const instr = getInstructions();
  const instrBox = document.getElementById('instructionsInput');
  if (instrBox && instrBox.value !== instr) instrBox.value = instr;
  if (tab) activateSettingsTab(tab);
  else { const active = settingsWrap.querySelector('.set-tab.active'); if (active) activateSettingsTab(active.dataset.tab); }
  // Load memories if memory tab is opened
  if (tab === 'memory' || (!tab && settingsWrap.querySelector('.set-tab.active')?.dataset.tab === 'memory')) {
    loadMemories();
  }
}
function closeSettings(){ settingsWrap.hidden = true; }
function activateSettingsTab(tab){
  settingsWrap.querySelectorAll('.set-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  settingsWrap.querySelectorAll('.set-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === tab));
}
settingsBtn.addEventListener('click', ()=>openSettings());
document.getElementById('settingsClose').addEventListener('click', closeSettings);
settingsWrap.addEventListener('mousedown',(e)=>{ if (e.target === settingsWrap) closeSettings(); });
settingsWrap.querySelectorAll('.set-tab').forEach(b=>{
  b.addEventListener('click', ()=>{
    activateSettingsTab(b.dataset.tab);
    if (b.dataset.tab === 'memory') loadMemories();
  });
});
document.addEventListener('keydown',(e)=>{
  if (e.key === 'Escape' && !settingsWrap.hidden){ e.stopPropagation(); closeSettings(); }
});

function saveGeminiKeyFromInput(){
  const v = keyInput.value.trim();
  if (v.length < 20){ toast('That doesn\'t look like a Gemini API key (they usually start with "AIza…").', 'error'); return; }
  setGeminiKey(v);
  updateKeyStatus();
  toast('Gemini API key saved — Auralis will use Gemini from the next message.');
}
function removeGeminiKeyFromInput(){
  clearGeminiKey();
  keyInput.value = '';
  updateKeyStatus();
  toast('Gemini API key removed — the local model takes over again.');
}
document.getElementById('keySave').addEventListener('click', saveGeminiKeyFromInput);
document.getElementById('keyRemove').addEventListener('click', removeGeminiKeyFromInput);
keyInput.addEventListener('keydown',(e)=>{
  if (e.key === 'Enter'){ e.preventDefault(); saveGeminiKeyFromInput(); }
});
keyInput.addEventListener('input', ()=>{ if (!keyInput.value.trim()) updateKeyStatus(); });

document.getElementById('instructionsSave').addEventListener('click', ()=>{
  const box = document.getElementById('instructionsInput');
  const v = (box.value || '').trim().slice(0, 2000);
  try { localStorage.setItem(INSTRUCTIONS_KEY, v); } catch {}
  toast(v ? 'Custom instructions saved — they apply from the next message. ✨' : 'Instructions cleared.');
});
document.getElementById('instructionsClear').addEventListener('click', ()=>{
  document.getElementById('instructionsInput').value = '';
  try { localStorage.removeItem(INSTRUCTIONS_KEY); } catch {}
  toast('Instructions cleared.');
});

/* ---------- Theme: dark · light · system ---------- */
const themeMedia = window.matchMedia('(prefers-color-scheme: light)');
function getTheme(){ try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch { return 'dark'; } }
function applyTheme(t){
  const light = t === 'light' || (t === 'system' && themeMedia.matches);
  document.body.classList.toggle('light', light);
}
function setTheme(t){
  try { localStorage.setItem(THEME_KEY, t); } catch {}
  applyTheme(t);
  settingsWrap.querySelectorAll('input[name="theme"]').forEach(r => { r.checked = r.value === t; });
}
settingsWrap.querySelectorAll('input[name="theme"]').forEach(r=>{
  r.addEventListener('change', ()=>setTheme(r.value));
});
themeMedia.addEventListener('change', ()=>{ if (getTheme() === 'system') applyTheme('system'); });

/* ---------- No-key gate: chat without a Gemini key → ask to use local ---------- */
let askResolve = null;
function askUseLocalModel(){
  return new Promise(resolve=>{
    askResolve = resolve;
    askPanel.hidden = false;
  });
}
function settleAsk(v){
  if (!askResolve) return;
  const r = askResolve;
  askResolve = null;
  askPanel.hidden = true;
  r(v);
}
document.getElementById('askKey').addEventListener('click', ()=>settleAsk('key'));
document.getElementById('askLocal').addEventListener('click', ()=>settleAsk('local'));
document.getElementById('askClose').addEventListener('click', ()=>settleAsk('dismiss'));
document.getElementById('visionAskDl').addEventListener('click', ()=>settleVisionAsk('download'));
document.getElementById('visionAskGemini').addEventListener('click', ()=>settleVisionAsk('gemini'));
document.getElementById('visionAskClose').addEventListener('click', ()=>settleVisionAsk('cancel'));
document.addEventListener('keydown',(e)=>{
  if (e.key === 'Escape' && !askPanel.hidden) settleAsk('dismiss');
});
/* Show the ask once per browser session until the user picks a side:
   enter a key, or explicitly choose the local model. */
function shouldAskAboutKey(){
  if (getGeminiKey() || localChosen()) return false;
  try { if (sessionStorage.getItem('auralis.keyAsked') === '1') return false; } catch {}
  return true;
}
async function maybeAskAboutKey(){
  if (!shouldAskAboutKey()) return;
  try { sessionStorage.setItem('auralis.keyAsked', '1'); } catch {}
  const choice = await askUseLocalModel();
  if (choice === 'key'){
    openSettings('keys'); // takes effect from the next message
  } else if (choice === 'local'){
    markLocalChosen();
    openModelPanel();
  }
  // 'dismiss' → keep going with the server's local model, asked again next session
}


/* ---------- Startup animation ---------- */
/* Plays the full sequence every visit — the logo draw, the wordmark, the
   loading bar — and cannot be skipped (only reduced-motion users bypass it). */
function playBoot(){
  const bootEl = document.getElementById('boot');
  if (!bootEl) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches){
    bootEl.remove();
    document.body.classList.add('ready');
    return;
  }
  document.body.classList.add('booting');
  setTimeout(()=>{
    bootEl.classList.add('out');
    document.body.classList.remove('booting');
    document.body.classList.add('ready');
    setTimeout(()=>bootEl.remove(), 750);
  }, 2200);
}

function boot(){
  playBoot();
  loadState();
  // Theme + custom instructions from Settings
  applyTheme(getTheme());
  setTheme(getTheme()); // sync the radio buttons
  const instrBox = document.getElementById('instructionsInput');
  if (instrBox) instrBox.value = getInstructions();
  // Warm up any local models the user previously opted into (cached after
  // the first download). Nothing downloads until the user asks via the
  // ＋ Tools → Local models panel; the server model covers the rest.
  if (window.LocalAI){
    window.LocalAI.warmup();
    window.LocalAI.onStatus(()=>{ updateProviderStatus(); });
  }
  updateProviderStatus();
  // Web/Deep toggles live in the ＋ Tools menu now (persisted in settings).
  // Voice dictation shortcut chip (also available inside the ＋ menu).
  if (SpeechRec) micChip.classList.remove('hidden');
  if (state.chats.length===0){
    state.chats.push({ id:uid(), title:'New research', createdAt:Date.now(), updatedAt:Date.now(), messages:[] });
  }
  if (!state.currentChatId) state.currentChatId = state.chats[0].id;
  renderBoth();
}
boot();
