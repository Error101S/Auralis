// Intent detection for Auralis: decides, BEFORE any web search, what kind of
// message the user sent — casual chatter, a calculation, a creative request, a
// simple knowledge question, a current/breaking-news question, or real
// research. Kept deliberately generic: no app-specific or topic-specific hacks.
//
// Pure logic, no I/O, no dependencies — so it can be unit-tested standalone.

function norm(q) {
    return String(q || '')
        .toLowerCase()
        .replace(/'/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[?!.,:;]+/, '')
        .replace(/[?!.,:;]+$/, '');
}

/* ---------- System / meta questions ---------- */

const SYSTEM_RE = /\b(what(\s+i[s']?s|'s)\s+today|what\s+day|current\s+(date|time)|wh?[o0]?\s+are?\s+you|your\s+name|what\s+can\s+you\s+do|who\s+built\s+you|are?\s+you\s+(ai|a\s+bot|human))\b/i;

export function systemReply(query) {
    if (!SYSTEM_RE.test(query)) return null;
    const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    return `Today is ${dateStr}. I'm Auralis, your web research assistant — I search the live web and synthesize grounded answers for you. What would you like to uncover?`;
}

/* ---------- Casual chatter ---------- */

const CASUAL_PHRASES = new Set([
    'hi', 'hello', 'hey', 'yo', 'sup', 'howdy', 'hiya', 'hey there', 'hello there', 'hi there',
    'greetings', 'hello again', 'hey again', 'welcome back', 'long time no see',
    'good morning', 'good afternoon', 'good evening', 'good day', 'morning', 'mornin', 'evening', 'evenin',
    'thanks', 'thank you', 'thank u', 'thx', 'ty', 'thanks a lot', 'thank you very much', 'thanks so much',
    'much appreciated', 'appreciate it', 'appreciate that', 'thanks anyway', 'thank you anyway',
    'ok thanks', 'okay thanks', 'alright thanks', 'thanks for your help', 'thanks for the help',
    'thank you for your help', 'thanks for everything', 'appreciate your help', 'that was helpful',
    'youre welcome', 'you are welcome', 'yw', 'no problem', 'np', 'no worries', 'anytime', 'sure thing',
    'ok', 'okay', 'k', 'kk', 'got it', 'gotcha', 'understood', 'alright', 'alrighty', 'fine', 'sure',
    'yeah', 'yep', 'yup', 'yes', 'nope', 'no', 'right', 'exactly', 'agreed', 'agree', 'fair',
    'fair enough', 'works', 'sounds good', 'sounds great', 'perfect', 'sweet', 'lovely', 'nice',
    'cool', 'awesome', 'great', 'amazing', 'fantastic', 'excellent', 'wow', 'whoa', 'nice one',
    'good one', 'good stuff', 'good to know', 'good to hear', 'glad to hear', 'thats helpful',
    'that helps', 'helpful', 'interesting', 'lol', 'lmao', 'rofl', 'haha', 'hahaha', 'hehe', 'hihi',
    'lmfao', 'xd',
    'bye', 'goodbye', 'good night', 'goodnight', 'see you', 'see ya', 'see you later', 'see you soon',
    'cya', 'laters', 'later', 'peace', 'peace out', 'take care', 'gtg', 'gotta go', 'catch you later',
    'ttyl', 'talk to you later', 'have a good day', 'have a nice day', 'have a good one', 'you too',
    'same to you',
    'how are you', 'how are u', 'how r u', 'hru', 'how are you doing', 'how you doing', 'how do you do',
    'hows it going', 'how is it going', 'how are things', 'how have you been', 'hows life',
    'how is life', 'whats up', 'what is up', 'what up', 'wassup', 'whats new', 'whats good',
    'hows your day', 'howd your day', 'what are you up to', 'whatcha doing', 'what you doing',
    'wyd',
    'yes please', 'please do', 'go ahead', 'continue', 'keep going', 'more', 'tell me more',
    'what else', 'again', 'anyway', 'lets go', 'ok go', 'by all means',
]);

function isCasual(raw) {
    const n = norm(raw);
    if (!n) return false;
    if (CASUAL_PHRASES.has(n)) return true;
    if (/^(hi|hey|hello|yo|sup|howdy|hiya)( there| everyone| guys| friend| again)?$/.test(n)) return true;
    if (/^(ok|okay|alright|got it|understood)[,.!]* thanks?$/.test(n)) return true;
    return false;
}

export function casualReply(query) {
    const n = norm(query);
    let kind = 'other';
    if (/^(bye|goodbye|good night|goodnight|see you|see ya|cya|laters|later|peace|take care|gtg|ttyl|talk to you later|catch you later)/.test(n)) kind = 'bye';
    else if (/^(thanks|thank|thx|ty|appreciate)|^(no problem|no worries|np|anytime|yw|youre welcome|sure thing)/.test(n)) kind = 'thanks';
    else if (/^(how (are|is|s|r)|hru|whats up|what is up|wassup|what up|sup|whats new|whats good|how have you been|hows life|what are you up to|wyd|hows your day)/.test(n)) kind = 'howru';
    else if (/^(hi|hey|hello|yo|howdy|hiya|greetings)|^(good )?(morning|afternoon|evening|day)/.test(n)) kind = 'greeting';
    const map = {
        greeting: `Hey there! I'm Auralis, your web research assistant. Give me a question and I'll dig into the live web for a grounded answer.`,
        howru: `Doing great — the web is wide open and I'm ready to dig. What should I research for you?`,
        thanks: `You're welcome! Happy to help — ask me anything else and I'll go find it.`,
        bye: `Goodbye! Come back whenever you need the web researched.`,
        other: `Happy to help! What would you like me to research?`,
    };
    return map[kind];
}

/* ---------- Calculations ---------- */

const NUM = '\\d+(?:\\.\\d+)?';

// Safe arithmetic evaluator (shunting-yard → RPN). No eval(), no Function().
function evalArith(expr) {
    const toks = [];
    const re = /\d+(?:\.\d+)?|[+\-*/^%()]/g;
    let m;
    while ((m = re.exec(expr))) toks.push(m[0]);
    if (toks.length === 0) return NaN;
    const prec = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3, 'u-': 4 };
    const rightAssoc = new Set(['^']);
    const out = [];
    const ops = [];
    let prev = null;
    for (const t of toks) {
        if (/\d/.test(t[0])) { out.push(parseFloat(t)); prev = t; continue; }
        if (t === '(') { ops.push(t); prev = t; continue; }
        if (t === ')') {
            while (ops.length && ops[ops.length - 1] !== '(') out.push(ops.pop());
            ops.pop();
            prev = t;
            continue;
        }
        let tok = t;
        if (t === '-' && (prev === null || prev === '(' || '+-*/^%'.includes(prev))) tok = 'u-';
        while (ops.length && ops[ops.length - 1] !== '(' &&
               (prec[ops[ops.length - 1]] > prec[tok] ||
                (prec[ops[ops.length - 1]] === prec[tok] && !rightAssoc.has(tok)))) {
            out.push(ops.pop());
        }
        ops.push(tok);
        prev = t;
    }
    while (ops.length) out.push(ops.pop());
    const st = [];
    for (const t of out) {
        if (typeof t === 'number') st.push(t);
        else if (t === 'u-') st.push(-st.pop());
        else {
            const b = st.pop();
            const a = st.pop();
            switch (t) {
                case '+': st.push(a + b); break;
                case '-': st.push(a - b); break;
                case '*': st.push(a * b); break;
                case '/': st.push(a / b); break;
                case '%': st.push(a % b); break;
                case '^': st.push(Math.pow(a, b)); break;
            }
        }
    }
    const r = st.length ? st[st.length - 1] : NaN;
    return isFinite(r) ? r : NaN;
}

function fmt(n) {
    if (!isFinite(n)) return String(n);
    return String(Math.round(n * 1e4) / 1e4);
}

function tryArith(q) {
    let s = q.toLowerCase()
        .replace(/[×x]/g, '*')
        .replace(/\b(what is|whats|what are|what was|compute|calculate|calculate the|solve|please|the answer|result|is equal to|equals|equal to|of)\b/g, ' ')
        .replace(/\b(multiplied by|multiply|times|multiplies)\b/g, '*')
        .replace(/\b(divided by|divide|over)\b/g, '/')
        .replace(/\b(plus|added to|add)\b/g, '+')
        .replace(/\b(minus|subtracted from|subtract|take away|less than)\b/g, '-')
        .replace(/\b(to the power of|raised to the power of)\b/g, '^')
        .replace(/[=?]/g, ' ')
        .replace(/[,\s]/g, '');
    if (!/[0-9]/.test(s)) return null;
    if (!/^[0-9+\-*/^().%]+$/.test(s)) return null;
    const n = evalArith(s);
    if (!isFinite(n) || Number.isNaN(n)) return null;
    return `${fmt(n)}`;
}

const UNIT_ALIAS = {
    km: 'km', kilometer: 'km', kilometers: 'km', kilometre: 'km', kilometres: 'km',
    mi: 'mi', mile: 'mi', miles: 'mi',
    m: 'm', meter: 'm', meters: 'm', metre: 'm', metres: 'm',
    ft: 'ft', foot: 'ft', feet: 'ft',
    cm: 'cm', centimeter: 'cm', centimeters: 'cm', centimetre: 'cm', centimetres: 'cm',
    inch: 'in', inches: 'in', 'in': 'in',
    kg: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
    lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
    g: 'g', gram: 'g', grams: 'g',
    oz: 'oz', ounce: 'oz', ounces: 'oz',
    l: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l',
    gal: 'gal', gallon: 'gal', gallons: 'gal',
    celsius: 'c', celcius: 'c', centigrade: 'c', '°c': 'c',
    fahrenheit: 'f', '°f': 'f',
    mph: 'mph', kmh: 'kmh', kph: 'kmh', kmph: 'kmh', 'km/h': 'kmh', 'km/hr': 'kmh',
    w: 'w', watt: 'w', watts: 'w', kw: 'kw', kilowatt: 'kw', kilowatts: 'kw',
    min: 'min', minute: 'min', minutes: 'min',
    h: 'h', hour: 'h', hours: 'h', hr: 'h',
    sec: 'sec', second: 'sec', seconds: 'sec', s: 'sec',
    'c': 'c', 'f': 'f',
};

// 1 unitA = CONV['a:b'] unitB
const CONV = {
    'km:mi': 0.621371, 'mi:km': 1.609344,
    'm:ft': 3.28084, 'ft:m': 0.3048,
    'cm:in': 0.393701, 'in:cm': 2.54,
    'kg:lb': 2.204623, 'lb:kg': 0.45359237,
    'g:oz': 0.035274, 'oz:g': 28.349523,
    'l:gal': 0.264172, 'gal:l': 3.785412,
    'mph:kmh': 1.609344, 'kmh:mph': 0.621371,
    'kph:kmh': 1, 'kmph:kmh': 1,
    'w:kw': 0.001, 'kw:w': 1000,
    'min:sec': 60, 'h:min': 60, 'h:sec': 3600,
};

function tryConvert(q) {
    let m = q.match(new RegExp(`(?:convert\\s+)?(${NUM})\\s*([°a-zA-Z]+)\\s*(?:to|in|into|->)\\s*([°a-zA-Z]+)`, 'i'));
    if (!m) {
        const rev = q.match(new RegExp(`how many\\s+([°a-zA-Z]+)\\s*(?:are|is)?\\s*(?:there\\s+)?in\\s*(${NUM})\\s*([°a-zA-Z]+)`, 'i'));
        if (!rev) return null;
        m = [rev[0], rev[2], rev[3], rev[1]];
    }
    const value = parseFloat(m[1]);
    const from = UNIT_ALIAS[String(m[2]).toLowerCase()];
    const to = UNIT_ALIAS[String(m[3]).toLowerCase()];
    if (!from || !to || !isFinite(value)) return null;
    let result;
    if ((from === 'c' || from === 'f') && (to === 'c' || to === 'f')) {
        result = from === 'c' ? value * 9 / 5 + 32 : (value - 32) * 5 / 9;
    } else {
        const f = CONV[from + ':' + to];
        if (f === undefined) {
            const rf = CONV[to + ':' + from];
            if (rf === undefined) return null;
            result = value / rf;
        } else {
            result = value * f;
        }
    }
    return `${fmt(value)} ${from} = ${fmt(result)} ${to}`;
}

const HOLIDAYS = {
    christmas: [12, 25], xmas: [12, 25], 'christmas eve': [12, 24],
    'new year': [1, 1], 'new years': [1, 1], 'new years day': [1, 1],
    'new years eve': [12, 31], 'new year eve': [12, 31],
    halloween: [10, 31], 'valentines day': [2, 14], valentines: [2, 14],
    'independence day': [7, 4],
};
const HOLIDAY_KEYS = new Set(Object.keys(HOLIDAYS));

function fourthThursdayOf(year) {
    const t = new Date(year, 10, 1);
    const diff = (4 - t.getDay() + 7) % 7;
    return new Date(year, 10, 1 + diff + 21);
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function tryDaysUntil(q) {
    const m = q.match(/how many days (?:are there )?(?:until|till|before|to)\s+(.+?)[?.!]*$/i)
        || q.match(/days until\s+(.+?)[?.!]*$/i);
    if (!m) return null;
    const raw = String(m[1]).trim().toLowerCase().replace(/[?.!,]+$/, '');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let t = null;
    let label = raw;
    if (raw === 'thanksgiving') {
        t = fourthThursdayOf(today.getFullYear());
        if (t < today) t = fourthThursdayOf(today.getFullYear() + 1);
    } else if (HOLIDAY_KEYS.has(raw)) {
        const [mo, day] = HOLIDAYS[raw];
        t = new Date(today.getFullYear(), mo - 1, day);
        if (t < today) t = new Date(today.getFullYear() + 1, mo - 1, day);
    } else {
        const md = raw.match(/(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?/i);
        if (md) {
            const mo = MONTHS[md[1].slice(0, 3).toLowerCase()];
            let day = Math.min(parseInt(md[2], 10), 31);
            t = new Date(today.getFullYear(), mo, day);
            if (t < today) t = new Date(today.getFullYear() + 1, mo, day);
            label = md[1] + ' ' + md[2];
        } else {
            const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
            if (iso) {
                t = new Date(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));
                label = iso[0];
            } else {
                const wd = raw.match(/(?:next\s+)?(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)/i);
                if (!wd) return null;
                const name = wd[1].toLowerCase();
                const idx = WEEKDAYS.findIndex(n => name.startsWith(n.slice(0, 3)));
                const diff = (idx - today.getDay() + 7) % 7;
                t = new Date(today);
                t.setDate(today.getDate() + diff);
                label = name;
            }
        }
    }
    const days = Math.round((t - today) / 86400000);
    if (days <= 0) return `It's ${label} today!`;
    return `There ${days === 1 ? 'is' : 'are'} ${days} day${days === 1 ? '' : 's'} until ${label}.`;
}

export function solveCalculation(query) {
    const pct = String(query).match(new RegExp(`(${NUM})\\s*(?:percent|%)\\s*of\\s*(${NUM})`, 'i'));
    if (pct) {
        const p = parseFloat(pct[1]);
        const v = parseFloat(pct[2]);
        return `${fmt(p)}% of ${fmt(v)} = ${fmt(p / 100 * v)}`;
    }
    const conv = tryConvert(String(query));
    if (conv) return conv;
    const days = tryDaysUntil(String(query));
    if (days) return days;
    return tryArith(String(query));
}

function isCalculation(q) {
    if (/(\d+(?:\.\d+)?)\s*(?:percent|%)\s*of\s*\d+(?:\.\d+)?/i.test(q)) return true;
    if (new RegExp(`(?:convert\\s+)?${NUM}\\s*[°a-zA-Z]+\\s*(?:to|in|into|->)\\s*[°a-zA-Z]+`, 'i').test(q)) return true;
    if (/how many\s+[°a-zA-Z]+\s*(?:are|is)?\s*(?:there\s+)?in\s*\d+/i.test(q)) return true;
    if (/how many days (?:are there )?(?:until|till|before|to)\b/i.test(q) || /days until\b/i.test(q)) return true;
    if (tryArith(q) !== null) return true;
    return false;
}

/* ---------- Creative requests ---------- */

const CREATIVE_RE = /^(write|create|compose|draft|imagine|invent|design|draw|sketch|make me|make up|tell me a|tell me an|give me a|give me an|come up with|brainstorm|rewrite|rephrase|paraphrase|translate|rap about|song about)\b/i;
const CREATIVE_WORD_RE = /\b(poem|haiku|sonnet|joke|jokes|lyrics|parody|fanfic|fiction|screenplay)\b/i;

function isCreative(q) {
    return CREATIVE_RE.test(q) || CREATIVE_WORD_RE.test(q);
}

export function creativeReply(query) {
    const q = norm(query);
    let kind = 'other';
    if (/\bjoke/.test(q)) kind = 'joke';
    else if (/\b(poem|haiku|sonnet|rhyme|verse)\b/.test(q)) kind = 'poem';
    else if (/\b(story|tale|fiction|fanfic|narrative)\b/.test(q)) kind = 'story';
    else if (/\b(song|lyrics|rap)\b/.test(q)) kind = 'lyrics';
    else if (/\b(translate|translation)\b/.test(q) || /in (spanish|french|german|italian|japanese|portuguese|chinese|russian)\b/.test(q)) kind = 'translate';
    else if (/\b(rewrite|paraphrase|rephrase)\b/.test(q)) kind = 'rewrite';
    const map = {
        joke: `Here's one: why did the database break up with the spreadsheet? Too many unresolved relationships. (One more: why do programmers prefer dark mode? Because light attracts bugs.) For fresher jokes on demand, add your free Gemini API key with /gemini <key>.`,
        poem: `A small one for you:\n\nAnswers hide in pages,\nlit by a patient, bright search —\nknowledge comes to light.\n\nI can do longer, custom poetry with your Gemini key — drop it in with /gemini <key>.`,
        story: `I'd love to write that — but original fiction runs on my Gemini engine. Add your free key with /gemini <key>, then ask again. Meanwhile, every good story needs a want, an obstacle, and a change; tell me the character and the conflict and I'll sketch the outline.`,
        lyrics: `Here's a chorus to get you going:\n\nPages turn and signals fly,\nquestions ride the open sky —\nlittle echoes, big replies,\nanswers forming in the quiet.\n\nFor verses tailored to your topic, add your Gemini key with /gemini <key>.`,
        translate: `Translation runs on my Gemini engine — add your free API key with /gemini <key> and I'll translate it properly.`,
        rewrite: `Rewriting needs my Gemini engine — add your free API key with /gemini <key> and I'll do it well.`,
        other: `I'd love to create that, but original writing runs on my Gemini engine — add your free API key with /gemini <key> and I'll make it happen.`,
    };
    return map[kind];
}

/* ---------- Research vs. knowledge vs. current ---------- */

const CURRENT_RE = /\b(latest|today|yesterday|tonight|this week|this month|this year|this quarter|current|breaking|recent|newest|news|weather|forecast|score|scores|election|announc|trending|what happened|status of|right now|price|prices|stock|stocks|shares|market|revenue|earnings|release|released|out now|just came out|update|updates|next week|upcoming)\b/i;

// Enhanced patterns for data/finance queries - these need specific, factual answers
const DATA_QUERY_RE = /\b(stock|stocks|price|pricing|cost|value|valuation|market cap|market capitalization|dividend|yield|eps|earnings per share|pe ratio|volume|trading|ticker|symbol|exchange|nasdaq|nyse|dow jones|s&p 500|sp 500|crypto|bitcoin|ethereum|btc|eth|currency|exchange rate|interest rate|inflation|gdp|unemployment|sales|revenue|profit|loss|balance sheet|cash flow)\b/i;

const FINANCE_SPECIFIC_RE = /\b(what (is|are|'s) .* (stock|price|trading at|worth|valued at)|how (much|many) (is|are) .* worth|current (price|stock|value) of|stock price of|market cap of|ticker for|symbol for|shares of)\b/i;

const FUTURE_RE = /\b(will|future|predict|prediction|outlook|projection|forecast|when (will|is|does))\b/i;

const RESEARCH_RE = /\b(why|how (do|does|can|is|to|are|much|many)|compare|comparison|versus|vs\.?|difference between|better|worst|best|top \d+|recommend|should i|worth it|analysis|analy[sz]e|investigat|research|deep dive|history of|impact of|effect of|pros and cons|review|tutorial|guide|explain|break down|factors|reasons|causes|statistics|data on|evidence for|sources on|studies|survey|growth|profits?|sales|industry|robinhood?)\b/i;

const KNOWLEDGE_RE = /^(what is|what are|what was|what were|what does|what do|whats|whats is|who is|who are|who was|who were|where is|where are|which is|which are|define|definition of|meaning of|is it true|is that true|are there|does |do (i|you|we|they|people)|can (i|you|we)|what is the meaning)/i;

// A query is a follow-up only when it OPENS with follow-up language
// ("what about X?", "why?", "more"). Matching words like "it"/"one"/"and"
// ANYWHERE glued fresh questions ("what is Skibidi Toilet … keep it short")
// onto the previous topic and poisoned the web search.
const FOLLOWUP_START = /^\s*(what about|how about|what else|and|also|then|more|expand|tell me more|explain(\s+more|\s+that|\s+it)?|its|it's|it|that|this|them|those|these|they|again|why|how|continue|go on|elaborate)\b/i;

export function expandQuery(query, history) {
    if (!Array.isArray(history) || history.length === 0) return query;
    const prev = [...history].reverse().find(m => m && m.role === 'user' && typeof m.text === 'string' && m.text.trim());
    if (!prev) return query;
    const q = String(query).trim();
    // Only true follow-ups get earlier context glued on — fresh questions
    // search for exactly what the user asked. Bare "why"/"how" only count as
    // follow-ups when the message is tiny ("why?", "how so?"); a full
    // question ("how do solar panels work?") is fresh.
    const words = q.split(/\s+/);
    const explicitFollowup = /^(what about|how about|what else|tell me more|go on|elaborate|explain\s+(that|it|more)|more|continue|again)\b/i.test(q);
    if (FOLLOWUP_START.test(q) && (explicitFollowup || words.length <= 3)) {
        const base = prev.text.trim().replace(/[?.!]+$/, '');
        return `${base} ${q}`.trim();
    }
    return q;
}

/* ---------- Persistent memory ---------- */

// Explicit memory commands ("remember that X", "forget X", "what do you
// remember") are handled before intent dispatch: they never search the web.
export function memoryCommand(query) {
    const q = String(query || '').trim();
    const store = q.match(/^remember\s+(?:that\s+)?(.+)$/i);
    if (store) {
        const f = store[1].replace(/[.!]+$/, '').trim();
        if (f.length >= 3 && f.length <= 200) return { cmd: 'store', fact: f };
    }
    const forget = q.match(/^forget\s+(.+)$/i);
    if (forget) {
        const kw = forget[1].trim();
        if (kw.length >= 2 && kw.length <= 60) return { cmd: 'forget', keyword: kw };
    }
    const RECALL_RE = /what do you remember|what do you know about me|what do you remember about me|do you remember (me|anything|us)|what did i (tell|say) you|did i tell you|whats my name|what is my name|do you know (me|my name|who i am)|what have i told you|do you keep notes|what do you remember about us|what (did|have|were) we (talk(ed|ing)?|chat(?:ted|ting)?|discuss(ed|ing)?|say|said) (about|earlier|before|previously)|whats? did we (talk|chat|discuss) about|(previous|last|earlier|past) (chat|conversation|session|messages)|remind me (what|about|of)|recap.*(conversation|chat|talking|talked|discussed)|summarize (our|this|the|my) (conversation|chat)/i;
    if (RECALL_RE.test(q)) return { cmd: 'recall' };
    return null;
}

// Best-effort capture of facts the user states in passing ("I use Linux",
// "my name is X"). Deliberately conservative: short declarative sentences
// that match recognizable self-disclosure patterns; questions, commands,
// and long-winded statements are skipped so we don't store junk.
const FACT_STARTERS = [
    /\bmy name is\s+/i, /\bcall me\s+/i, /\bi['’ ]?m (a|an|not|currently|into|really into|from)\s+/i,
    /\bi am (a|an|not|currently|into|really into|from)\s+/i,
    /\bi like\s+/i, /\bi love\s+/i, /\bi hate\s+/i, /\bi dislike\s+/i, /\bi prefer\s+/i,
    /\bi use\s+/i, /\bi work (as|at|on|with|for)\s+/i, /\bi live (in|at|near)\s+/i,
    /\bi play\s+/i, /\bi study\s+/i, /\bi (read|watch|listen to|drive|own|make|build|visit|cook|run|code|draw|play)\s+/i,
    /\bi have (a|an|the|two|three|\d)\s+/i, /\bi want\s+/i, /\bi need\s+/i,
    /\bi always\s+/i, /\bi never\s+/i,
    /\bwe (are|use|like|love|hate|prefer|play|work|live|build|make)\s+/i,
    /\bmy favorite\s+/i, /\bmy favourite\s+/i, /\bi was born\s+/i,
];
const FACT_EXCLUDE = /^(i|we)( have a question| want to (ask|know|see|find|find out|check|learn about)| need (help|to ask|to find|to check)| am asking| was wondering| am wondering| am looking for| need to know)/i;

export function extractFacts(text) {
    const facts = [];
    const seen = new Set();
    const sentences = String(text || '')
        .split(/(?<=[.!?])\s+|\n/)
        .map(s => s.trim())
        .filter(Boolean);
    for (const s of sentences) {
        if (/[?]$/.test(s) || s.length > 240 || s.length < 4) continue;
        let fact = null;
        for (const re of FACT_STARTERS) {
            if (re.test(s)) { fact = s; break; }
        }
        if (!fact) continue;
        fact = fact.replace(/[.!]+$/, '').replace(/\s+/g, ' ').trim();
        if (FACT_EXCLUDE.test(fact)) continue;
        if (fact.length > 200) fact = fact.slice(0, 200);
        if (!seen.has(fact)) { seen.add(fact); facts.push(fact); }
    }
    return facts.slice(0, 5);
}

export function detectIntent(query, history) {
    const q = String(query || '').trim();
    if (!q) return 'casual';
    if (isCasual(q)) return 'casual';
    if (isCalculation(q)) return 'calculation';
    if (isCreative(q)) return 'creative';
    
    // Check for finance/data queries first - these need specific factual answers
    if (DATA_QUERY_RE.test(q) || FINANCE_SPECIFIC_RE.test(q)) {
        return 'data';
    }
    
    if (CURRENT_RE.test(q) || FUTURE_RE.test(q)) return 'current';
    if (RESEARCH_RE.test(q)) return 'research';
    if (KNOWLEDGE_RE.test(q)) return 'knowledge';
    return 'research';
}