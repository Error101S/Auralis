// local-ai.js — Auralis local inference via the LFM research model.
//
// Replaces the Gemini synthesizer. We run the open LFM 2.5 1.2B "Thinking"
// model (the reasoning tier from the Local-Browser-AI / Aether catalog) on this
// Node server using @huggingface/transformers (onnxruntime-node). No API keys,
// no external model calls. The 1.2B Thinking model is the research-grade one:
// it reasons through complex questions and cross-references source material.

import { pipeline, env, TextStreamer } from '@huggingface/transformers';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Pin the HF cache to the package-local cache so already-downloaded weights are
// reused instead of re-downloaded every boot.
const CACHE_DIR = process.env.LFM_CACHE_DIR
    || path.join(__dirname, 'node_modules', '@huggingface', 'transformers', '.cache');
env.allowLocalModels = false;
env.cacheDir = CACHE_DIR;

export const LOCAL_MODEL = {
    id: 'LiquidAI/LFM2.5-1.2B-Thinking-ONNX',
    revision: 'e7fe61974e3a167dff77c5722db9a1cb7b57140f',
    dtype: 'q4',
    name: 'auralis-local · LFM 2.5 1.2B Thinking',
    downloadBytes: 763_764_000,
    contextTokens: 32_768,
};
export const RESEARCH_SYSTEM = `You are Auralis, a web research assistant. The live web search has already been done for you and the gathered material is provided in the user's message — your job is to answer the user's question like a careful research analyst. Never describe the search, the sources section, or any tooling; the research happened silently.

Use the conversation context provided only to understand what the user is asking now — never cite it, and don't repeat earlier answers unless the user asks for a recap.

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
let generatorPromise = null;
let smallHost = null; // memoized memory check

// The 1.2B q4 model needs ~1.5 GB of RAM to load. Small hosts (Render's free
// tier is 512 MB) OOM and crash the process — which surfaces as 502s — so on
// them the server model is disabled and callers fall back to the built-in
// snippet synthesizers instead of dying.
function localModelSupported() {
    if (smallHost === null) {
        const mb = os.totalmem() / (1024 * 1024);
        smallHost = !process.env.LFM_FORCE && mb < 1600;
        if (smallHost) console.log(`Local model disabled: host has only ${Math.round(mb)} MB RAM (needs ~1600 MB). Using snippet synthesis.`);
    }
    return !smallHost;
}

// Lazily load (and keep) the pipeline as a singleton.
function loadPipeline() {
    if (!localModelSupported()) {
        return Promise.reject(new Error('Local model unavailable on this host (not enough RAM).'));
    }
    if (!generatorPromise) {
        generatorPromise = (async () => {
            const generator = await pipeline('text-generation', LOCAL_MODEL.id, {
                revision: LOCAL_MODEL.revision,
                device: process.env.LFM_DEVICE || 'cpu',
                dtype: LOCAL_MODEL.dtype,
            });
            return generator;
        })().catch((err) => {
            generatorPromise = null; // allow a retry next time
            throw err;
        });
    }
    return generatorPromise;
}

// The LFM ONNX pipeline returns generated_text either as a plain string or
// (when the repo ships a chat template) as a message array — take the last
// assistant message content in that case.
function extractGenerated(out) {
    const g = Array.isArray(out) && out[0] ? out[0].generated_text : (out && out.generated_text);
    if (typeof g === 'string') return g;
    if (Array.isArray(g)) {
        for (let i = g.length - 1; i >= 0; i--) {
            if (g[i] && g[i].role === 'assistant' && typeof g[i].content === 'string') return g[i].content;
        }
    }
    return '';
}

// The LFM "Thinking" models reason inside <think>…</think> before answering;
// the answer is everything after the closing tag.
export function splitThinking(text) {
    const str = String(text || '');
    const m = str.match(/<think>([\s\S]*?)(<\/think>|$)/i);
    if (!m) return { answer: str.trim(), reasoning: '', thinkingComplete: true };
    return {
        answer: str.slice(m.index + m[0].length).trim(),
        reasoning: m[1].trim(),
        thinkingComplete: /<\/think>/i.test(m[0]),
    };
}

/**
 * Run a single local inference turn.
 * @param {object} opts
 * @param {string} [opts.system]        System / instruction message.
 * @param {string} opts.userPrompt      User content (the actual request + material).
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{text: string, reasoning: string}>}
 */
export async function localGenerate({ system = '', userPrompt, maxTokens = 1400, timeoutMs = 300000, onToken = null } = {}) {
    const generator = await loadPipeline();
    const messages = [];
    if (system && system.trim()) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: userPrompt });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // Optional token streaming so the UI can show text as it is typed.
    const opts = {
        max_new_tokens: maxTokens,
        do_sample: false,
        signal: ctrl.signal,
    };
    if (onToken) {
        try {
            opts.streamer = new TextStreamer(generator.tokenizer, {
                skip_prompt: true,
                skip_special_tokens: true,
                callback_function: (tok) => { try { onToken(String(tok || '')); } catch {} },
            });
        } catch { /* older builds without streamer support fall back silently */ }
    }
    try {
        const out = await generator(messages, opts);
        const raw = extractGenerated(out);
        const parsed = splitThinking(raw);
        // Only a finished answer is shown. Raw <think> rambling is never
        // surfaced — callers fall back to their own (short) fallbacks when
        // the model exhausted its budget mid-thought.
        return {
            text: parsed.answer.trim(),
            reasoning: parsed.reasoning.trim(),
        };
    } finally {
        clearTimeout(timer);
    }
}