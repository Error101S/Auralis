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

// Fallback search mock if DuckDuckGo fails
const mockSources = (query) => {
    return [
        { title: 'Understanding ' + query, url: 'https://example.com/1', snip: 'An in-depth look at ' + query },
        { title: 'The future of ' + query, url: 'https://example.com/2', snip: 'Recent developments regarding ' + query },
        { title: query + ' Explained', url: 'https://example.com/3', snip: 'A simple explanation of ' + query }
    ];
};

app.post('/api/search', async (req, res) => {
    const { query } = req.body;
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
        
        // Use the logged-in user's API key if available, otherwise fallback to server's key
        let apiKey = process.env.GEMINI_API_KEY;
        if (req.isAuthenticated() && req.user.gemini_api_key) {
            apiKey = req.user.gemini_api_key;
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
                const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
                const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ role: 'user', parts: [{ text: promptText }] }]
                    })
                });
                
                if (response.ok) {
                    const data = await response.json();
                    synthesizedText = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response generated.";
                } else {
                    const err = await response.json();
                    synthesizedText = `⚠️ Gemini API Error: ${err.error?.message || response.statusText}`;
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
