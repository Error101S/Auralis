import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize SQLite database connection
const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Could not connect to database', err);
    } else {
        console.log('Connected to SQLite database');
    }
});

// Create tables if they don't exist
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            google_id TEXT UNIQUE,
            name TEXT,
            email TEXT,
            avatar_url TEXT,
            gemini_api_key TEXT
        )
    `);
    db.run(`
        CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL,
            fact TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(owner, fact)
        )
    `);
});

// Helper function to find or create a user by Google ID
export const findOrCreateUser = (profile) => {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM users WHERE google_id = ?', [profile.id], (err, row) => {
            if (err) return reject(err);
            if (row) {
                return resolve(row);
            } else {
                // User doesn't exist, create them
                const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
                const avatarUrl = profile.photos && profile.photos[0] ? profile.photos[0].value : null;
                
                db.run(
                    'INSERT INTO users (google_id, name, email, avatar_url) VALUES (?, ?, ?, ?)',
                    [profile.id, profile.displayName, email, avatarUrl],
                    function(err) {
                        if (err) return reject(err);
                        db.get('SELECT * FROM users WHERE id = ?', [this.lastID], (err, newRow) => {
                            if (err) return reject(err);
                            resolve(newRow);
                        });
                    }
                );
            }
        });
    });
};

export const getUserById = (id) => {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM users WHERE id = ?', [id], (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
};

export const updateUserApiKey = (id, apiKey) => {
    return new Promise((resolve, reject) => {
        db.run('UPDATE users SET gemini_api_key = ? WHERE id = ?', [apiKey, id], function(err) {
            if (err) return reject(err);
            resolve(this.changes);
        });
    });
};

// ---------- Persistent memory (facts the user told us across chats) ----------

export const getMemories = (owner) => {
    return new Promise((resolve, reject) => {
        db.all('SELECT fact FROM memories WHERE owner = ? ORDER BY updated_at DESC, id DESC LIMIT 24', [owner], (err, rows) => {
            if (err) return reject(err);
            resolve((rows || []).map(r => r.fact));
        });
    });
};

export const addMemory = (owner, fact) => {
    return new Promise((resolve, reject) => {
        const clean = String(fact).trim();
        if (!owner || !clean) return resolve(false);
        db.run(
            'INSERT INTO memories (owner, fact) VALUES (?, ?) ON CONFLICT(owner, fact) DO UPDATE SET updated_at = CURRENT_TIMESTAMP',
            [owner, clean],
            function(err) {
                if (err) return reject(err);
                // Keep the per-owner set bounded (30 most recent).
                db.run(
                    'DELETE FROM memories WHERE owner = ? AND id NOT IN (SELECT id FROM memories WHERE owner = ? ORDER BY updated_at DESC, id DESC LIMIT 29)',
                    [owner, owner],
                    (err2) => {
                        if (err2) return reject(err2);
                        resolve(true);
                    }
                );
            }
        );
    });
};

export const deleteMemories = (owner, keyword) => {
    return new Promise((resolve, reject) => {
        db.run('DELETE FROM memories WHERE owner = ? AND fact LIKE ?', [owner, '%' + String(keyword) + '%'], function(err) {
            if (err) return reject(err);
            resolve(this.changes || 0);
        });
    });
};

export default db;
