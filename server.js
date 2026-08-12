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
                'User-Agent': 'AuralisBot/1.0 (+research; +https://auralis.app)',
                'Accept': 'text/html,application/xhtml+xml',
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

// Set up sessions
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


// Fallback search mock if DuckDuckGo fails
const mockSources = (query) => {
    return [
        { title: 'Understanding ' + query, url: 'https://example.com/1', snip: 'An in-depth look at ' + query },
        { title: 'The future of ' + query, url: 'https://example.com/2', snip: 'Recent developments regarding ' + query },
        { title: query + ' Explained', url: 'https://example.com/3', snip: 'A simple explanation of ' + query }
    ];
};

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
        // 1. Perform web search using duck-duck-scrape
        let searchResults = [];
        try {
            const results = await search(query, { safeSearch: SafeSearchType.MODERATE });
            // Take top 5 results
            searchResults = results.results.slice(0, 5).map(r => ({
                title: r.title,
                url: r.url,
                snip: r.description
            }));
            
            if (searchResults.length === 0) {
                searchResults = mockSources(query);
            }
        } catch (searchErr) {
            console.error('Search failed, using mock data:', searchErr.message);
            searchResults = mockSources(query);
        }

        // 1b. Fetch live page content so Gemini answers from CURRENT data,
        // not stale training-data knowledge. This fixes outdated answers.
        searchResults = await enrichSources(searchResults);

        // 2. Call Gemini API for synthesis
        let synthesizedText = "I couldn't generate a response.";
        let modelUsed = '';
        
        // Use the client's saved key if provided, else the logged-in user's key, else the server's key
        let apiKey = apiKeyFromBody;
        if (!apiKey && req.isAuthenticated() && req.user.gemini_api_key) {
            apiKey = req.user.gemini_api_key;
        }
        if (!apiKey && process.env.GEMINI_API_KEY) {
            apiKey = process.env.GEMINI_API_KEY;
        }
        
        if (!apiKey) {
            if (req.isAuthenticated()) {
                synthesizedText = "⚠️ You haven't set your Gemini API Key. Please click 'Settings' to add one.";
            } else {
                synthesizedText = "⚠️ Backend Error: GEMINI_API_KEY is not set in the server's .env file, and you are not logged in.";
            }
        } else {
            const today = new Date().toISOString().slice(0, 10);
            const sourcesText = searchResults.map((s, i) => {
                const body = (s.body && s.body.length > 60)
                    ? `\nKey content (live, fetched just now):\n${s.body}`
                    : `\nSnippet: ${s.snip || '(no snippet)'}`;
                return `[${i+1}] ${s.title}\nURL: ${s.url}${body}`;
            }).join('\n\n');
            const promptText = `You are Auralis, a brilliant research assistant. Today is ${today}. You have already consulted trusted web sources behind the scenes — your job is simply to answer, not to describe how you found the information.

User's question: "${query}"

REFERENCE MATERIAL (do NOT mention this section, its existence, or that you "searched" / "checked sources" / "ran web_search" / "looked things up" — the lookup already happened silently):
${sourcesText}

OUTPUT RULES:
1. GREETINGS & SMALL TALK EXCEPTION: If the user's question is a simple greeting (e.g., "Hi", "Hello"), small talk, or basic chatter, respond warmly, naturally, and concisely in 1–2 sentences like Gemini, ChatGPT, or Claude. DO NOT treat greetings as a research topic, do not output citations \`[1]\`, and do not analyze the term "Hello".
2. Answer directly and conversationally, as if you simply know the answer. The user must never see signs of a tool, a search step, or source meta-analysis.
3. For research queries, cite inline with bracketed numbers like [1] or [2] matching the reference numbers, woven naturally into the sentence. Never list source domains, list "Sources used", describe what each source said, narrate "according to these sites/sources", or give a meta-analysis of the references.
4. Ground facts, dates, prices, versions, and any time-sensitive details ONLY in the reference material. Do not lean on outside memory for such details. If the references genuinely don't cover it, give the best honest answer you can and keep moving — avoid long "I couldn't verify" digressions.
5. If references disagree, just present the more reliable/recent picture concisely; only flag a conflict if it changes the practical takeaway.
6. Be specific, genuinely informative, and pleasant. End research answers with a brief, natural follow-up question or an offer to go deeper — no heading like "Follow-up", no preamble, no sign-off.
7. Never produce internal-use phrases: "I ran", "I searched", "web_search", "search results", "the sources I found", "based on my research", "after analysing/analyzing the sources", "let me", "I looked it up", "here's what I found", "Summary", or any breakdown-by-source structure.`;

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
