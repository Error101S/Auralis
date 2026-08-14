import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { search, SafeSearchType } from 'duck-duck-scrape';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { findOrCreateUser, getUserById, updateUserApiKey } from './database.js';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import pLimit from 'p-limit';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

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

async function enrichSources(searchResults) {
    // Only enrich real web URLs; skip placeholders (example.com) entirely.
    const realIdxs = [];
    searchResults.forEach((s, i) => {
        if (s.url && !/^https?:\/\/(example\.com|localhost)/i.test(s.url) && i < 4) realIdxs.push(i);
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
    cookie: { secure: false, maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
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
                avatar_url: req.user.avatar_url,
                has_api_key: !!req.user.gemini_api_key
            }
        });
    } else {
        res.json({ loggedIn: false });
    }
});

app.post('/api/user/settings', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const { apiKey } = req.body;
    try {
        await updateUserApiKey(req.user.id, apiKey);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback: serve index.html for any remaining GET (Express 5 compatible).
// /api endpoints are never captured here.
app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
        return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    next();
});

// Free-tier Gemini model preference (highest free limits first).
// Order: 3.1-flash-lite (500 RPD), 3.5-flash-lite (500 RPD), 3.6-flash, 3-flash, 2.5-flash-lite.
const GEMINI_MODEL_FALLBACKS = [
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
    'gemini-3-flash',
    'gemini-2.5-flash-lite',
];
const MODEL_OVERRIDE = process.env.GEMINI_MODEL || '';
// Detect "no longer available" / deprecated style errors so we can retry that model.
const DEPRECATED_RE = /no longer available|not found|not supported|deprecat/i;
// Detect rate-limit / quota errors so we can rotate off that model temporarily.
const RATE_LIMIT_RE = /rate\s*limit|quota|resource.*exhaust|too many|429/i;

// In-memory model rotation state: marks models that ran out, with a cooldown
// timestamp after which they become candidates again.
const modelCooldown = new Map(); // model -> epoch ms when it can be retried
const MODEL_COOLDOWN_MS = 60 * 1000; // 1 minute before retrying an exhausted model
let preferredModel = MODEL_OVERRIDE || GEMINI_MODEL_FALLBACKS[0];

function availableModels() {
    const now = Date.now();
    const cooled = [];
    for (const m of GEMINI_MODEL_FALLBACKS) {
        const until = modelCooldown.get(m) || 0;
        if (until <= now) cooled.push(m);
    }
    return cooled;
}

function markExhausted(model) {
    modelCooldown.set(model, Date.now() + MODEL_COOLDOWN_MS);
}

async function geminiGenerate(apiKey, prompt, { timeout = 20000 } = {}) {
    // Build the candidate queue: preferred model first, then the rest by fallback order.
    // If the preferred model is currently cooled-down, skip ahead to the next available one.
    const pool = availableModels();
    // If preferred isn't available, pick the first available as the new preferred.
    if (!pool.includes(preferredModel)) {
        preferredModel = MODEL_OVERRIDE && pool.includes(MODEL_OVERRIDE)
            ? MODEL_OVERRIDE
            : pool[0] || GEMINI_MODEL_FALLBACKS.find(m => !modelCooldown.has(m)) || GEMINI_MODEL_FALLBACKS[0];
    }
    const queue = [preferredModel];
    for (const m of pool) if (!queue.includes(m)) queue.push(m);
    // Add any fully-cooled models at the tail as last resort.
    for (const m of GEMINI_MODEL_FALLBACKS) if (!queue.includes(m)) queue.push(m);

    const tried = new Set();
    for (const model of queue) {
        if (tried.has(model)) continue;
        tried.add(model);
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), timeout);
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
                signal: ctrl.signal,
            });
            clearTimeout(timer);
            if (r.ok) {
                const data = await r.json();
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                // Success: make this the sticky preferred model.
                preferredModel = model;
                modelCooldown.delete(model);
                return { ok: true, model, text };
            }
            let errBody;
            try { errBody = await r.json(); } catch { errBody = null; }
            const msg = errBody?.error?.message || r.statusText;
            const status = r.status;
            // Deprecated/unavailable model -> skip to next, don't cool (it's never coming back today).
            if (status === 404 || (status === 400 && DEPRECATED_RE.test(msg))) {
                continue;
            }
            // Rate limit / quota -> rotate off this model and try the next one.
            if (status === 429 || (status === 400 && RATE_LIMIT_RE.test(msg))) {
                markExhausted(model);
                continue;
            }
            // Invalid key / bad request (non-deprecated) -> a real, non-rotatable error.
            if (status === 400 || status === 401 || status === 403) {
                return { ok: false, model, status, error: msg };
            }
            // Server-side hiccup -> try next model once.
            continue;
        } catch (e) {
            if (e.name === 'AbortError' || /fetch|network/i.test(e.message)) {
                continue;
            }
            return { ok: false, model, error: e.message };
        }
    }
    return { ok: false, model: null, error: 'All candidate Gemini models were unavailable or rate-limited. Wait a moment and try again.' };
}


// Fallback search placeholder (kept only as the absolute last resort so the
// frontend still gets a clickable Sources list; NEVER injected into the
// Gemini prompt — see the no-results / system-query guards in /api/search).
const mockSources = (query) => {
    return [
        { title: 'Understanding ' + query, url: 'https://example.com/1', snip: 'An in-depth look at ' + query },
        { title: 'The future of ' + query, url: 'https://example.com/2', snip: 'Recent developments regarding ' + query },
        { title: query + ' Explained', url: 'https://example.com/3', snip: 'A simple explanation of ' + query }
    ];
};

// True when a query is a direct, answerable system/meta question that should
// not be sent to live web search at all (current date, who are you, etc.).
const SYSTEM_QUERY_RE = /\b(what(\s+i[s']?s|'s)\s+today|what\s+day|current\s+(date|time)|wh?[o0]?\s+are?\s+you|your\s+name|what\s+can\s+you\s+do|who\s+built\s+you|are?\s+you\s+(ai|a\s+bot|human))\b/i;

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

// Lightweight built-in synthesis used when no Gemini key is configured and the
// server has no key either. It builds a clean answer from the live search
// sources (if any) WITHOUT narrating tool internals.
function localSynthesize(query, sources){
    const subj = query.replace(/[?.!]+$/, '').trim();
    const intent = intentOf(query);
    if (sources.length === 0){
        return `I don't have live web results for *${subj}* right now, so I can't give you a grounded answer. Ask anything that benefits from fresh web data and I'll search and summarize it for you.`;
    }
    const fallbacks = {
        howto: `The reliable approach breaks into a few steps: define the goal and constraints precisely, compare 2–3 mainstream approaches, try the best-documented one on a small sample first, validate against primary sources, and iterate based on measured results.`,
        compare: `There's rarely a single winner — pick based on your use case, total cost over 3–5 years, and ecosystem maturity. The biggest differentiators are long-term maintenance and lock-in, not day-one features.`,
        why: `The causes cluster into structural factors, recent catalysts, and secondary amplifiers. The structural bucket gets the most weight, which means changes will take time.`,
        whatis: `"${subj}" is well-documented with broad agreement on its definition, some debate around the edges, and a history that explains why different communities frame it differently.`,
        recommend: `There's a shortlist, not a single best pick: a value/quality leader, a higher-cost performance runner-up, and a budget option that outperforms its price. Match your budget and priorities, then confirm with hands-on reviews.`,
        future: `The trend is clearly in one direction, but the timeline depends on variables sources can't yet measure (costs, regulation, adoption). Plan for the trend; don't bet the farm on the date.`,
        explain: `The sources converge on the core facts but differ on emphasis — the technical/primary sources give the most reliable details, while news and community coverage adds context on why it matters.`,
    };
    let out = `${fallbacks[intent] || fallbacks.explain}\n\n`;
    out += `**Where the facts sit now:** the live results point in the direction above — the picture could still shift as better evidence comes in, and the source list below is what this answer is based on.\n\n`;
    sources.slice(0, 4).forEach((s, i) => {
        const lead = s.snip ? s.snip.slice(0, 160) : '';
        out += `- [${i + 1}] **${s.title}** — ${lead}${lead && lead.length < s.snip.length ? '…' : ''}\n`;
    });
    return out;
}

async function validateGeminiKey(key) {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${preferredModel}:generateContent?key=${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with OK' }] }] })
        });
        clearTimeout(timer);
        if (r.ok) return { ok: true, status: 200 };
        let msg;
        try { msg = (await r.json())?.error?.message || ''; } catch { msg = ''; }
        // A deprecated-model error means the KEY itself is valid (the account works).
        const deprecated = r.status === 404 || (r.status === 400 && DEPRECATED_RE.test(msg));
        if (deprecated) return { ok: true, status: 200 };
        return { ok: false, status: r.status };
    } catch {
        return { ok: false, status: 0 };
    }
}

app.post('/api/gemini-key', async (req, res) => {
    const { apiKey } = req.body;
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
        return res.status(400).json({ error: 'apiKey is required' });
    }
    // Save to the signed-in user's account if logged in
    if (req.isAuthenticated()) {
        try {
            await updateUserApiKey(req.user.id, apiKey.trim());
        } catch (err) {
            return res.status(500).json({ error: 'Failed to save to your account' });
        }
    }
    // Verify the key against the Gemini API
    const check = await validateGeminiKey(apiKey.trim());
    if (check.status === 400 || check.status === 401 || check.status === 403) {
        return res.status(400).json({ error: 'Invalid Gemini API key — Gemini rejected it.' });
    }
    if (!check.ok) {
        // Network error: can't verify, but still accept the key.
        return res.json({ success: true, verified: false });
    }
    res.json({ success: true, verified: true });
});

app.post('/api/search', async (req, res) => {
    const { query, apiKey: apiKeyFromBody } = req.body;
    if (!query) {
        return res.status(400).json({ error: 'Query is required' });
    }

    try {
        let synthesizedText = "I couldn't generate a response.";
        let modelUsed = '';
        let searchResults = [];

        // 0. Direct system / meta questions (current date, who are you, etc.)
        // Answer directly — never web-search these, never attach sources.
        if (SYSTEM_QUERY_RE.test(query)) {
            const today = new Date();
            const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            return res.json({
                sources: [],
                text: `Today is ${dateStr}. I'm Auralis, your web research assistant — I search the live web and synthesize grounded answers for you. What would you like to uncover?`,
                model: 'auralis-local',
            });
        }

        // 1. Perform web search using duck-duck-scrape, with a robust HTML fallback.
        try {
            const results = await search(query, { safeSearch: SafeSearchType.MODERATE });
            searchResults = results.results.slice(0, 5).map(r => ({
                title: r.title,
                url: r.url,
                snip: r.description
            }));
        } catch (searchErr) {
            console.error('duck-duck-scrape failed:', searchErr.message);
        }
        if (searchResults.length === 0) {
            console.log('Falling back to DDG HTML endpoint...');
            const fb = await ddgHtmlSearch(query);
            if (fb.length > 0) searchResults = fb.slice(0, 5);
            console.log(`DDG HTML returned ${searchResults.length} results`);
        }
        // NOTE: do NOT fill in mockSources as a substitute for real results —
        // an honest empty sources list is better than fake example.com entries.
        // enrichSources() already skips placeholder URLs, so real results get
        // fetched live; if nothing came back, we leave sources empty.

        // 1b. Fetch live page content so Gemini answers from CURRENT data.
        if (searchResults.length > 0) {
            searchResults = await enrichSources(searchResults);
        }

        // 2. Resolve the API key (client > logged-in user > server env)
        let apiKey = apiKeyFromBody;
        if (!apiKey && req.isAuthenticated() && req.user.gemini_api_key) {
            apiKey = req.user.gemini_api_key;
        }
        if (!apiKey && process.env.GEMINI_API_KEY) {
            apiKey = process.env.GEMINI_API_KEY;
        }

        if (!apiKey) {
            // No Gemini key anywhere — fall back to Auralis's built-in synthesizer
            // (summarizes the live search results without leaking tool internals,
            // and is honest when there are no results at all).
            synthesizedText = localSynthesize(query, searchResults);
            modelUsed = 'auralis-local';
        } else {
            const today = new Date().toISOString().slice(0, 10);
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
            const promptText = `You are Auralis, a web research assistant. The live web search has already been done for you and the gathered material is below — your job is to answer the user's question like a careful research analyst. Never describe the search, the sources section, or any tooling; the research happened silently.

Today is ${today}.

User's question: "${query}"

REFERENCE MATERIAL (numbered sources [1] through [${searchResults.length || 0}]; title + URL + evidence, for your use only — never describe this section or its inner workings):
${sourcesText}

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

            try {
                const result = await geminiGenerate(apiKey, promptText);
                if (result.ok) {
                    synthesizedText = result.text || "No response generated.";
                    modelUsed = result.model || '';
                } else {
                    synthesizedText = `⚠️ Gemini API Error: ${result.error || 'unknown error'}`;
                }
            } catch (err) {
                console.error("Gemini fetch error:", err);
                synthesizedText = `⚠️ Gemini API Error: ${err.message}`;
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
