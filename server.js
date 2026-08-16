import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { search, SafeSearchType } from 'duck-duck-scrape';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { findOrCreateUser, getUserById, getMemories, addMemory, deleteMemories, logMessage, getRecentChat, SqliteSessionStore } from './database.js';
import { detectIntent, casualReply, solveCalculation, creativeReply, expandQuery, systemReply, memoryCommand, extractFacts } from './intent.js';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import pLimit from 'p-limit';

import { localGenerate, RESEARCH_SYSTEM, LOCAL_MODEL } from './local-ai.js';

dotenv.config();

// ---------------------------------------------------------------------------
// Optional Gemini synthesis. The client may send a Gemini API key with a
// request; when present (and valid) Gemini synthesizes the answer. The key is
// used for that request only — it is never logged or persisted. Any failure
// falls straight through to the local model.
// ---------------------------------------------------------------------------
const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_TIMEOUT_MS = 60000;

async function geminiGenerate({ apiKey, system = '', userPrompt, inlineParts = [], maxTokens = 1400 }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const payload = {
        contents: [{ role: 'user', parts: [...inlineParts, { text: userPrompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.4 },
    };
    if (system && system.trim()) payload.system_instruction = { parts: [{ text: system }] };
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
    if (!res.ok) {
        let detail = '';
        try { detail = (await res.json())?.error?.message || ''; } catch {}
        throw new Error(`Gemini API ${res.status}${detail ? ': ' + String(detail).slice(0, 160) : ''}`);
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map(p => p.text || '').join('').trim();
    if (!text) throw new Error('Gemini returned an empty response');
    return text;
}

// Split a data URL ("data:mime;base64,payload") for Gemini inline_data.
function splitDataUrl(dataUrl) {
    const m = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl || ''));
    if (!m) return null;
    return { mimeType: m[1], data: m[2] };
}

function clientKey(body) {
    return (typeof body?.geminiKey === 'string' && body.geminiKey.trim().length >= 20)
        ? body.geminiKey.trim().slice(0, 200)
        : '';
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' })); // image/audio attachments are posted as base64

// Gemini vision: analyze attached images when the client has a key saved.
// (The browser's local LFM vision model covers the keyless path.)
app.post('/api/vision', async (req, res) => {
    const apiKey = clientKey(req.body);
    if (!apiKey) return res.status(400).json({ error: 'A Gemini API key is required (＋ Tools → Gemini API key).' });
    const q = (typeof req.body?.question === 'string' && req.body.question.trim())
        ? req.body.question.trim().slice(0, 2000)
        : 'Describe this image in detail.';
    const inlineParts = (Array.isArray(req.body?.images) ? req.body.images : [])
        .map(splitDataUrl)
        .filter(p => p && /^image\//.test(p.mimeType))
        .slice(0, 4)
        .map(p => ({ inline_data: { mime_type: p.mimeType, data: p.data } }));
    if (inlineParts.length === 0) return res.status(400).json({ error: 'No valid image attachments supplied.' });
    try {
        const text = await geminiGenerate({
            apiKey,
            system: 'You are Auralis, a visual analysis assistant. Answer the user\'s question about the attached image(s) directly and precisely. If there are several images, cover each one (Image 1, Image 2 …). Plain language; markdown only when it helps.',
            userPrompt: q,
            inlineParts,
            maxTokens: 1200,
        });
        res.json({ text, model: GEMINI_MODEL });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// Gemini transcription: transcribe an attached audio file when a key is saved.
// (The browser's local Whisper model covers the keyless path.)
app.post('/api/transcribe', async (req, res) => {
    const apiKey = clientKey(req.body);
    if (!apiKey) return res.status(400).json({ error: 'A Gemini API key is required (＋ Tools → Gemini API key).' });
    const part = splitDataUrl(req.body?.audio);
    if (!part || !/^audio\//.test(part.mimeType)) return res.status(400).json({ error: 'No valid audio attachment supplied.' });
    try {
        const text = await geminiGenerate({
            apiKey,
            userPrompt: 'Transcribe this audio recording verbatim. Output ONLY the transcript text — no labels, no commentary, no quotes. If it contains no speech, output nothing.',
            inlineParts: [{ inline_data: { mime_type: part.mimeType, data: part.data } }],
            maxTokens: 2048,
        });
        res.json({ text, model: GEMINI_MODEL });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// ---------- Live page content fetcher (refreshes outdated info) ----------
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
const PAGE_FETCH_TIMEOUT_MS = 6000;
const PAGE_MAX_CHARS = 2500;

async function fetchPageText(url) {
    try {
        // Skip obviously-unfetchable or placeholder URLs.
        if (!url || /^(https?:)?\/\/(example\.com|localhost)/i.test(url)) return null;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), PAGE_FETCH_TIMEOUT_MS);
        const r = await fetch(url, {
            signal: ctrl.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            redirect: 'follow',
        });
        clearTimeout(timer);
        if (!r.ok) return null;
        const ct = r.headers.get('content-type') || '';
        if (!/text\/html|application\/xhtml|text\/plain|\*\/\*/.test(ct)) return null;
        const html = await r.text();
        if (!html || html.length < 200) return null;
        const { document } = parseHTML(html);
        const reader = new Readability(document);
        const article = reader.parse();
        let text;
        if (article && article.content) {
            text = turndown.turndown(article.content);
        } else {
            const body = document.body ? document.body.textContent : document.textContent || '';
            text = String(body).replace(/\s+/g, ' ').trim();
        }
        if (!text) return null;
        return text.slice(0, PAGE_MAX_CHARS);
    } catch {
        return null;
    }
}

async function enrichSources(searchResults, { limit: maxSources = 4 } = {}) {
    // Only enrich real web URLs; skip placeholders (example.com) entirely.
    const realIdxs = [];
    searchResults.forEach((s, i) => {
        if (s.url && !/^https?:\/\/(example\.com|localhost)/i.test(s.url) && i < maxSources) realIdxs.push(i);
    });
    if (realIdxs.length === 0) return searchResults;
    const limit = pLimit(3);
    const texts = await Promise.all(realIdxs.map(i => limit(() => fetchPageText(searchResults[i].url))));
    return searchResults.map((s, i) => {
        const slot = realIdxs.indexOf(i);
        return slot >= 0 ? { ...s, body: texts[slot] || s.snip || '' } : s;
    });
}

// Robust DuckDuckGo fallback: scrape the HTML endpoint directly with a real
// browser UA. The duck-duck-scrape npm package gets blocked ("anomaly
// detected") frequently, so this keeps live results flowing.
const DDG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function ddgHtmlSearch(query, { limit = 6 } = {}) {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        const r = await fetch('https://html.duckduckgo.com/html/', {
            method: 'POST',
            signal: ctrl.signal,
            headers: {
                'User-Agent': DDG_UA,
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9',
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ q: query, kl: 'us-en' }).toString(),
            redirect: 'follow',
        });
        clearTimeout(timer);
        if (!r.ok) return [];
        const html = await r.text();
        if (!html || html.length < 500) return [];
        const { document } = parseHTML(html);
        const out = [];
        const anchors = document.querySelectorAll('.result__a, a.result__url');
        const snips = document.querySelectorAll('.result__snippet');
        const seen = new Set();
        for (const a of anchors) {
            let href = a.getAttribute('href') || '';
            // DDG wraps links in a redirect; unwrap //duckduckgo.com/l/?uddg=...
            const m = href.match(/[?&]uddg=([^&]+)/);
            if (m) { try { href = decodeURIComponent(m[1]); } catch {} }
            if (!/^https?:\/\//.test(href)) continue;
            if (seen.has(href)) continue;
            seen.add(href);
            const idx = out.length;
            const snip = snips[idx] ? (snips[idx].textContent || '').replace(/\s+/g, ' ').trim() : '';
            out.push({ title: (a.textContent || '').replace(/\s+/g, ' ').trim(), url: href, snip });
            if (out.length >= limit) break;
        }
        return out;
    } catch {
        return [];
    }
}


app.use(session({
    secret: process.env.SESSION_SECRET || 'auralis-super-secret-key-123',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 days
    store: new SqliteSessionStore()
}));

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Passport Session Serialization
passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const user = await getUserById(id);
        done(null, user);
    } catch (err) {
        done(err, null);
    }
});

// Configure Google Strategy
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'missing_client_id',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'missing_client_secret',
    callbackURL: "/auth/google/callback"
  },
  async (accessToken, refreshToken, profile, done) => {
      try {
          const user = await findOrCreateUser(profile);
          return done(null, user);
      } catch (err) {
          return done(err, null);
      }
  }
));

// Auth Routes
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => {
    // Successful authentication, redirect home.
    res.redirect('/');
  }
);

app.get('/auth/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/');
    });
});

// API Routes for User Management
app.get('/api/user', (req, res) => {
    if (req.isAuthenticated()) {
        res.json({
            loggedIn: true,
            user: {
                name: req.user.name,
                email: req.user.email,
                avatar_url: req.user.avatar_url
            }
        });
    } else {
        res.json({ loggedIn: false });
    }
});

app.post('/api/user/settings', async (req, res) => {
    // Retired: Gemini is no longer used; there is nothing meaningful to save.
    res.status(410).json({ error: 'No longer supported — Auralis now uses a local model.' });
});

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve Local-Browser-AI's @huggingface/transformers web bundle so the browser
// can also run the LFM research model locally (hybrid path; server-only path
// needs none of this).
app.use('/vendor/transformers', express.static(
    path.join(__dirname, 'node_modules', '@huggingface', 'transformers', 'dist'),
    {
        setHeaders: (res) => {
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
            res.setHeader('Cache-Control', 'public, max-age=3600');
        },
    }
));

// The transformers web bundle imports the bare specifiers "onnxruntime-common"
// and "onnxruntime-web/webgpu". Browsers can only resolve those through an
// import map (see public/index.html), and the map needs the actual files:
// serve the onnxruntime packages so /vendor/ort/*.mjs + .wasm resolve locally
// instead of failing with "Failed to resolve module specifier".
app.use('/vendor/ort', express.static(
    path.join(__dirname, 'node_modules', 'onnxruntime-web', 'dist'),
    {
        setHeaders: (res) => {
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
            res.setHeader('Cache-Control', 'public, max-age=3600');
        },
    }
));
app.use('/vendor/ort-common', express.static(
    path.join(__dirname, 'node_modules', 'onnxruntime-common', 'dist', 'esm'),
    {
        setHeaders: (res) => {
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
            res.setHeader('Cache-Control', 'public, max-age=3600');
        },
    }
));

// SPA fallback: serve index.html for any remaining GET (Express 5 compatible).
// /api endpoints are never captured here.
app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
        return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    next();
});

// ---------------------------------------------------------------------------
// Local inference replaces Gemini. Auralis now synthesizes grounded answers
// with the open LFM 2.5 1.2B "Thinking" research model running locally in
// Node (see local-ai.js). No Gemini SDK, no API keys, no external model calls.
// ---------------------------------------------------------------------------


// Fallback search placeholder (kept only as the absolute last resort so the
// frontend still gets a clickable Sources list; NEVER injected into the
// local model prompt — see the no-results / system-query guards in /api/search).
const mockSources = (query) => {
    return [
        { title: 'Understanding ' + query, url: 'https://example.com/1', snip: 'An in-depth look at ' + query },
        { title: 'The future of ' + query, url: 'https://example.com/2', snip: 'Recent developments regarding ' + query },
        { title: query + ' Explained', url: 'https://example.com/3', snip: 'A simple explanation of ' + query }
    ];
};

// Conversation memory: earlier turns of this chat, supplied by the client.
// Used ONLY to understand follow-ups ("what about X?", "expand on the second
// point") — never as research material.
function conversationSection(history){
    if (!Array.isArray(history) || history.length === 0) return '';
    const turns = history
        .filter(m => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'model') && typeof m.text === 'string' && m.text.trim())
        .slice(-8)
        .map(m => '[' + (m.role === 'user' ? 'user' : 'assistant') + '] "' + m.text.trim().slice(0, 3000) + '"')
        .join('\n');
    if (!turns) return '';
    return 'CONVERSATION CONTEXT (earlier turns in this chat, oldest first — for understanding follow-ups and references like "it", "that", or "earlier" ONLY; not research material):\n' + turns + '\n\n';
}

// Persistent memory: facts the user has told Auralis across ALL chats, keyed
// by account (signed in) or a per-device anonymous id. Injected into prompts
// as trusted context (never cited, never treated as research material).
function memorySection(memories){
    if (!memories || memories.length === 0) return '';
    return 'USER MEMORY (things the user has told you across previous chats — trustworthy and personal when relevant to the question; never cite it, don\'t repeat what was already said verbatim, and don\'t invent more):\n' +
        memories.slice(0, 12).map(m => '- ' + m).join('\n') + '\n\n';
}

async function persistFacts(owner, text){
    if (!owner) return;
    try {
        const facts = extractFacts(text);
        for (const f of facts) await addMemory(owner, f);
    } catch (err) {
        console.error('memory persist failed:', err.message);
    }
}

// Simple intent + topic detection for the built-in (no-Gemini-key) synthesizer.
const INTENTS = [
    { re: /\bhow\s+(do|to|can|does)/i, key: 'howto' },
    { re: /\bvs?\.?|better|best|compare|difference\b/i, key: 'compare' },
    { re: /^why\b|\bwhy\s+(is|are|do|does)/i, key: 'why' },
    { re: /\bwhat\s+(is|are)|define|definition\b/i, key: 'whatis' },
    { re: /\bbest|recommend|should\s+i\s+(buy|use|get)|top\s+\d/i, key: 'recommend' },
    { re: /\bwill|future|when\s+(will|is)|in\s+(20\d\d|the\s+future)/i, key: 'future' },
];
function intentOf(q){ for (const it of INTENTS) if (it.re.test(q)) return it.key; return 'explain'; }

// Lightweight built-in synthesis used as a last-resort fallback when the local
// LFM model cannot be loaded. It builds a clean answer from the live search
// sources (if any) WITHOUT narrating tool internals or forcing research
// headings onto the reply.
function localSynthesize(query, sources){
    const subj = query.replace(/[?.!]+$/, '').trim();
    const intent = intentOf(query);
    if (sources.length === 0){
        return `I couldn't find live web results for *${subj}* right now, so I don't have enough to give you a grounded answer. Try rephrasing, or ask about something the web can verify.`;
    }
    const fallbacks = {
        howto: `To do "${subj}" reliably: (1) define the goal and constraints precisely, (2) compare 2–3 mainstream approaches, (3) try the best-documented one on a small sample first, (4) validate against primary sources — official docs, papers, or maintainers — and (5) iterate based on measured results rather than opinion.`,
        compare: `On "${subj}" there's rarely a single winner — the deciding factors are your use case, total cost over 3–5 years, and ecosystem maturity. Long-term maintenance and lock-in matter more than day-one features.`,
        why: `The causes of "${subj}" cluster into structural factors, recent catalysts, and amplifiers. The structural factors carry the most weight, which means change happens slowly rather than overnight.`,
        whatis: `"${subj}" — a well-documented topic: broad agreement on the core definition, some debate around the edges, and a history that explains why different communities frame it differently.`,
        recommend: `For "${subj}" there's a shortlist, not a single best pick: a value/quality leader, a higher-cost performance runner-up, and a budget option that beats its price. Match your budget and priorities, then confirm with hands-on reviews.`,
        future: `The trend behind "${subj}" points clearly in one direction, but the timeline depends on variables the sources can't yet measure — costs, regulation, adoption. Plan for the trend; don't bet the farm on the date.`,
        explain: `On "${subj}" the core facts are broadly agreed on; the differences are emphasis. The most reliable details come from technical and primary sources, while news and community coverage adds why-it-matters context.`,
    };
    let out = `${fallbacks[intent] || fallbacks.explain}\n\n`;
    out += `**Key points from the live sources:**\n\n`;
    sources.slice(0, 4).forEach((s, i) => {
        const lead = s.snip ? s.snip.slice(0, 160) : '';
        out += `- [${i + 1}] **${s.title}** — ${lead}${lead && lead.length < s.snip.length ? '…' : ''}\n`;
    });
    return out;
}

app.post('/api/search', async (req, res) => {
    const { query, history, memoryId } = req.body;
    if (!query || typeof query !== 'string' || !query.trim()) {
        return res.status(400).json({ error: 'Query is required' });
    }
    const trimmed = query.trim();

    try {
        // Hybrid routing: when the client signals it will synthesize the answer
        // locally (with the LFM model running in the browser via WebGPU), we
        // skip server-side synthesis and return enriched sources (+ page content)
        // so the browser can reason over them. Otherwise the server synthesizes
        // with the local LFM model (see local-ai.js).
        const browserSynthesis = req.body?.browserSynthesis === true;

        // Client options: web=false skips the live search entirely (answer from
        // model knowledge + any attachment), deep=true widens the search and
        // fetches full content for more sources.
        const web = req.body?.web !== false;
        const deep = req.body?.deep === true;

        // Attachment context sent by the client (transcript, extracted
        // document text, or a local vision-model analysis of an image).
        const attachment = (req.body?.attachment && typeof req.body.attachment.text === 'string')
            ? { name: String(req.body.attachment.name || 'attachment').slice(0, 200), text: req.body.attachment.text.slice(0, 12000) }
            : null;

        // Optional Gemini key from the client (request-scoped, never stored).
        const geminiKey = (typeof req.body?.geminiKey === 'string' && req.body.geminiKey.trim().length >= 20)
            ? req.body.geminiKey.trim().slice(0, 200)
            : '';

        // Persistent memory owner: account when signed in, otherwise the
        // per-device anonymous id the client sends (or the session as a
        // last resort so memory commands still work).
        const memoryOwner = req.isAuthenticated()
            ? 'user:' + req.user.id
            : (typeof memoryId === 'string' && memoryId.length >= 8 && memoryId.length <= 64 ? 'anon:' + memoryId : (req.sessionID ? 'sess:' + req.sessionID : null));

        // 0a. Explicit memory commands — handled directly, never searched.
        const memCmd = memoryCommand(trimmed);
        if (memCmd) {
            if (!memoryOwner) {
                return res.json({ sources: [], text: "I can't keep memories for you right now — sign in or reload the page and try again.", model: 'auralis-local' });
            }
            if (memCmd.cmd === 'store') {
                await addMemory(memoryOwner, memCmd.fact);
                return res.json({ sources: [], text: `Got it — I'll remember: "${memCmd.fact}"`, model: 'auralis-local' });
            }
            if (memCmd.cmd === 'forget') {
                const n = await deleteMemories(memoryOwner, memCmd.keyword);
                return res.json({ sources: [], text: n > 0 ? `Forgot ${n} ${n === 1 ? 'memory' : 'memories'} matching that.` : `I don't have any memories matching that.`, model: 'auralis-local' });
            }
            const mems = await getMemories(memoryOwner);
            // Prefer the per-browser log the client sent (it survives deploys);
            // fall back to the server chat log.
            const localTopics = Array.isArray(req.body.localChatLog)
                ? req.body.localChatLog
                      .filter(t => typeof t === 'string' && t.trim() && t.trim() !== trimmed)
                      .map(t => '- ' + t.trim().slice(0, 160))
                : [];
            const recentTopics = localTopics.length
                ? localTopics
                : (await getRecentChat(memoryOwner, 10)).filter(r => r.role === 'user').map(r => '- ' + r.text);
            let text = '';
            if (mems.length) {
                text += 'Here\'s what I remember:\n\n' + mems.map(m => '- ' + m).join('\n') + '\n\n';
            }
            if (recentTopics.length) {
                text += 'What we talked about recently:\n\n' + recentTopics.join('\n');
            } else if (!text) {
                text = 'I don\'t have any memories saved yet. Tell me things like "remember that I use Linux" and I\'ll keep them across chats.';
            }
            return res.json({ sources: [], text, model: 'auralis-local' });
        }

        // Keep a per-user chat log so "what did we talk about" can be answered.

        await logMessage(memoryOwner, 'user', trimmed);

        // Capture personal facts the user just stated (best-effort, async-safe).
        await persistFacts(memoryOwner, trimmed);

        // Load what we already know about this user across chats.
        let memories = [];
        try {
            memories = memoryOwner ? await getMemories(memoryOwner) : [];
        } catch (err) {
            console.error('memory load failed:', err.message);
        }
        const memSection = memorySection(memories);

        const today = new Date().toISOString().slice(0, 10);
        const convSection = conversationSection(history);

        // 0. Direct system / meta questions (current date, who are you, etc.)
        // Answer directly — never web-search these, never attach sources.
        const sysText = systemReply(trimmed);
        if (sysText) {
            return res.json({ sources: [], text: sysText, model: 'auralis-local' });
        }

        // 1. Intent detection — decide whether this message needs the web at all.
        const intent = detectIntent(trimmed, history);

        // 1a. Casual chatter (hello, thanks, cool…): conversational reply,
        // no search, no sources, no research framing. (Never triggered when
        // the user attached material — that always goes to the model.)
        if (intent === 'casual' && !attachment) {
            return res.json({ sources: [], text: casualReply(trimmed), model: 'auralis-local' });
        }

        // 1b. Calculations: solved locally, never searched.
        if (intent === 'calculation') {
            const solved = solveCalculation(trimmed);
            if (solved) {
                return res.json({ sources: [], text: solved, model: 'auralis-local' });
            }
            // Solver said no (odd phrasing) — fall through to research.
        }

        // 1c. Creative requests: never search. Gemini writes it when a key was
        // sent; otherwise the local LFM model writes it; a built-in response
        // (honest about its limits) is the fallback.
        if (intent === 'creative') {
            const promptText = `You are Auralis, a creative writing assistant. The user wants something created, not researched.\n\nToday is ${today}.\n\n${convSection}${memSection}User's request: "${trimmed}"\n\nWrite exactly what they asked for, in the format, length, and tone they requested. Just deliver the creative work — no citations, no sources, no research framing, no explanations of what you did, no follow-up questions.`;
            if (geminiKey) {
                try {
                    const gText = await geminiGenerate({ apiKey: geminiKey, userPrompt: promptText, maxTokens: 2000 });
                    return res.json({ sources: [], text: gText, model: GEMINI_MODEL });
                } catch (err) {
                    console.error('Gemini (creative) failed, using local model:', err.message);
                }
            }
            try {
                const result = await localGenerate({ userPrompt: promptText });
                if (result.text) {
                    return res.json({ sources: [], text: result.text, model: LOCAL_MODEL.name });
                }
            } catch (err) {
                console.error('Local model error (creative):', err.message);
            }
            return res.json({ sources: [], text: creativeReply(trimmed), model: 'auralis-local' });
        }

        // (No separate "knowledge" branch any more: simple factual questions flow
        // into the grounded research pipeline below, which searches the live web
        // and synthesizes a cited answer with the local LFM research model.)

        // 2. Research path: current events, research requests, knowledge
        // without a key, and follow-ups. Perform web search using
        // duck-duck-scrape, with a robust HTML fallback. Short follow-ups get
        // their earlier context glued on so the search finds the right pages.
        // When the user switched the web off (＋ Tools), skip searching and let
        // the model answer from its own knowledge (+ any attachment).
        const searchQuery = expandQuery(trimmed, history);
        let synthesizedText = "I couldn't generate a response.";
        let modelUsed = '';
        let searchResults = [];
        if (web) {
            try {
                const results = await search(searchQuery, { safeSearch: SafeSearchType.MODERATE });
                searchResults = results.results.slice(0, deep ? 8 : 5).map(r => ({
                    title: r.title,
                    url: r.url,
                    snip: r.description
                }));
            } catch (searchErr) {
                console.error('duck-duck-scrape failed:', searchErr.message);
            }
            if (searchResults.length === 0) {
                console.log('Falling back to DDG HTML endpoint...');
                const fb = await ddgHtmlSearch(searchQuery, { limit: deep ? 8 : 6 });
                if (fb.length > 0) searchResults = fb.slice(0, deep ? 8 : 5);
                console.log(`DDG HTML returned ${searchResults.length} results`);
            }
            // NOTE: do NOT fill in mockSources as a substitute for real results —
            // an honest empty sources list is better than fake example.com entries.

            // 2b. Fetch live page content so answers come from CURRENT data.
            // Deep mode fetches full content for more sources.
            if (searchResults.length > 0) {
                searchResults = await enrichSources(searchResults, { limit: deep ? 6 : 4 });
            }
        }

        // 3. Hybrid synthesis. Browser-first: if the client is running the LFM
        // model locally (WebGPU), hand it the enriched sources (with page text)
        // and let it reason over them in the browser. Otherwise the server
        // synthesizes with the local LFM research model below.
        if (browserSynthesis) {
            return res.json({ sources: searchResults, text: null, mode: 'browser', model: LOCAL_MODEL.name });
        }

        // Server path — synthesize with the local LFM research model (no Gemini).
        {
            // Only include REAL sources in the prompt. Never inject placeholders.
            // Each entry visibly marks whether it carries full page content
            // (strong grounding) or only a search snippet (weak grounding), so
            // the model weighs evidence and cites honestly.
            const sourcesText = searchResults.length > 0
                ? searchResults.map((s, i) => {
                    const hasBody = s.body && s.body.length > 60;
                    const body = hasBody
                        ? `Full page content available:\n${s.body}`
                        : `Search snippet only (no full content): ${s.snip || '(no snippet available)'}`;
                    return `[${i+1}] ${s.title}\nURL: ${s.url}\n${body}`;
                  }).join('\n\n')
                : '(No live web results were returned by the search provider for this query.)';
            // Attachment material (document text, voice-note transcript, or a
            // local vision-model analysis of an attached image). Trusted as
            // primary user-supplied material — never cited like a web source.
            const attachSection = attachment
                ? `ATTACHED MATERIAL "${attachment.name}" (supplied by the user — trustworthy primary material about their question; use it freely, but do not cite it like a numbered web source):\n${attachment.text}\n\n`
                : '';
            const noWebNote = !web
                ? `WEB SEARCH IS SWITCHED OFF for this turn — answer from your own knowledge${attachment ? ' together with the attached material' : ''}. Do not invent citations and do not reference numbered sources.\n\n`
                : '';
            const promptText = `You are Auralis, a web research assistant. The live web search has already been done for you and the gathered material is below — your job is to answer the user's question like a careful research analyst. Never describe the search, the sources section, or any tooling; the research happened silently.

Today is ${today}.

User's question: "${trimmed}"

${convSection}${memSection}${noWebNote}${attachSection}REFERENCE MATERIAL (numbered sources [1] through [${searchResults.length || 0}]; title + URL + evidence, for your use only — never describe this section or its inner workings):
${sourcesText}

Use the conversation context above (if any) only to understand what the user is asking now — never cite it, and don't repeat earlier answers unless the user asks for a recap.

ANSWER QUALITY RULES — follow every rule that applies:

1. ANSWER DIRECTLY. Lead with the most useful information. Do not restate the question, do not open with "Based on my research", "According to the sources", or "Here's what I found", and do not pad with filler or throat-clearing.

2. SYNTHESIZE, DON'T SUMMARIZE. Combine evidence from multiple sources into one coherent explanation. Do not walk through sources one at a time. Identify relationships: causes, effects, context, significance, and what the facts imply together. Prioritize the strongest, most relevant evidence over weaker or tangential material.

3. STRUCTURE TO THE QUESTION — pick the format the question calls for:
   - Simple/factual questions: answer in a short paragraph, then the supporting context.
   - "Why" questions: explain the important causes and how they interact.
   - "How"/process questions: clear steps in logical order.
   - Comparisons: a markdown table when useful (pipe syntax), followed by the key differences and the practical takeaway in prose.
   - Current/recent events: lead with the current picture, then the background; say which parts are current vs. older context.
   - Historical questions: chronological through-line with what mattered and why.
   - Opinion/decision questions: present the evidence on each side, uncertainty, and a balanced judgment — don't pretend there is one objectively right answer.
   - Complex research requests: organize into clear sections with "###" headings and synthesize into a coherent report.
   Use only "###" headings, **bold**, "- " bullets, "1. " numbered steps, and "|" pipe tables. Do not force every answer into the same structure.

4. MATCH LENGTH TO DEPTH. Simple question → a few sentences. Moderate research question → a short, well-organized answer. Complex research request → a detailed, organized report. Never inflate a simple answer.

5. CITE PRECISELY. Place citations like [1] or [2,3] immediately after the claim they support, woven into the sentence — never dump all citations at the end without context. Cite only sources that genuinely support the claim; when several sources substantiate an important claim, cite the relevant ones. Never cite a source for something it does not say, and never cite a source that is not in the numbered list. If sources disagree, say so plainly and indicate which position is better supported, more recent, or more authoritative. When a claim is grounded in only a snippet (weak) versus full content, discount accordingly.

6. SEPARATE FACT FROM INTERPRETATION. Present directly supported facts plainly, with citations. Frame reasonable inference as analysis ("This suggests…", "The pattern points to…"), not as established fact. Flag genuinely uncertain or disputed material as uncertain. Never invent facts, statistics, quotes, or predictions.

7. WEIGH SOURCE QUALITY. Prefer authoritative sources — government, academic and peer-reviewed material, official documentation, company filings, primary documents, and established news organizations — over blogs, forums, and aggregators. When the material contains conflicting quality, rely on the stronger sources and say why when it matters.

8. BE HONEST ABOUT GAPS. If the material does not adequately answer the question, say so directly and explain what information is missing or what would be needed to answer fully. Do not fabricate to fill the gap; do not pad with genericities.

9. NATURAL LANGUAGE. Write like a knowledgeable analyst — direct, specific, and natural. Avoid AI filler ("It's important to note…", "In conclusion…", "This is a complex topic…", "As an AI…", "According to sources…"). Do NOT end every answer with an offer or a follow-up question. Only ask a follow-up if the user's question genuinely requires clarification or has materially different valid interpretations.

10. NO COPYING. Express everything in your own words. Never reproduce long passages from any source.

GREETINGS & SMALL TALK EXCEPTION: If the user's question is a simple greeting, small talk, or basic chatter (not a research request), respond warmly and concisely in 1–2 sentences. No citations, no analysis of the term itself, no research framing.`;

            // Synthesis: Gemini when the client sent a key, otherwise the
            // local LFM research model. Both see the exact same prompt; any
            // Gemini failure falls through to the local model.
            let synthesized = false;
            if (geminiKey) {
                try {
                    synthesizedText = await geminiGenerate({ apiKey: geminiKey, system: RESEARCH_SYSTEM, userPrompt: promptText });
                    modelUsed = GEMINI_MODEL;
                    synthesized = true;
                } catch (err) {
                    console.error('Gemini synthesis failed, using local model:', err.message);
                }
            }
            if (!synthesized) {
                try {
                    const result = await localGenerate({ userPrompt: promptText });
                    if (result.text) {
                        synthesizedText = result.text || "No response generated.";
                        modelUsed = LOCAL_MODEL.name;
                    } else {
                        synthesizedText = localSynthesize(trimmed, searchResults);
                        modelUsed = 'auralis-local';
                    }
                } catch (err) {
                    console.error('Local model error (research):', err.message);
                    synthesizedText = localSynthesize(trimmed, searchResults);
                    modelUsed = 'auralis-local';
                }
            }
        }

        // Return combined data to the frontend (strip body before sending)
        const sourcesForClient = searchResults.map(({ body, ...rest }) => rest);
        res.json({
            sources: sourcesForClient,
            text: synthesizedText,
            model: modelUsed,
        });
        
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`ResearchBot backend running at http://localhost:${PORT}`);
});
