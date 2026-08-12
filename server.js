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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

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
const GEMINI_MODEL_DEFAULT = process.env.GEMINI_MODEL || GEMINI_MODEL_FALLBACKS[0];
// Detect "no longer available" / model-deprecated style errors so we can retry.
const DEPRECATED_RE = /no longer available|not found|not supported|deprecat/i;

async function geminiGenerate(apiKey, prompt, { timeout = 20000 } = {}) {
    const tried = new Set();
    const queue = [GEMINI_MODEL_DEFAULT, ...GEMINI_MODEL_FALLBACKS.filter(m => m !== GEMINI_MODEL_DEFAULT)];
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
                return { ok: true, model, text };
            }
            let errBody;
            try { errBody = await r.json(); } catch { errBody = null; }
            const msg = errBody?.error?.message || r.statusText;
            // If the model is deprecated/unavailable, try the next one.
            if (r.status === 404 || (r.status === 400 && DEPRECATED_RE.test(msg))) {
                continue;
            }
            // Other errors (rate limit, invalid key, content filter) are real — bubble up.
            return { ok: false, model, status: r.status, error: msg };
        } catch (e) {
            // Network/abort — try next model once, but don't loop forever on net errors.
            if (e.name === 'AbortError' || /fetch|network/i.test(e.message)) {
                continue;
            }
            return { ok: false, model, error: e.message };
        }
    }
    return { ok: false, model: null, error: 'All candidate Gemini models were unavailable.' };
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
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_DEFAULT}:generateContent?key=${key}`, {
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

        // 2. Call Gemini API for synthesis
        let synthesizedText = "I couldn't generate a response.";
        
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
            const sourcesText = searchResults.map((s, i) => `[${i+1}] ${s.title}\nURL: ${s.url}\nSummary: ${s.snip}`).join('\n\n');
            const promptText = `You are Auralis, an advanced web research AI agent.\nThe user asked: "${query}"\n\nI ran a web search and pulled the following sources:\n${sourcesText}\n\nSynthesize a natural, conversational, and highly informative answer based on these sources. \nCite the sources inline using bracketed numbers like [1] or [2].\nDo NOT use rigid templates (like "Short answer" or "What the sources actually say"). Respond like a helpful, autonomous AI agent.\nIf applicable, suggest a follow-up or ask if they want you to dig deeper.`;

            try {
                const result = await geminiGenerate(apiKey, promptText);
                if (result.ok) {
                    synthesizedText = result.text || "No response generated.";
                } else {
                    synthesizedText = `⚠️ Gemini API Error: ${result.error || 'unknown error'}`;
                }
            } catch (err) {
                console.error("Gemini fetch error:", err);
                synthesizedText = `⚠️ Gemini API Error: ${err.message}`;
            }
        }

        // Return combined data to the frontend
        res.json({
            sources: searchResults,
            text: synthesizedText
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
