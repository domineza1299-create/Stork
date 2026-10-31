/*
 * Intimacy (formerly the Afterglow extension): the director of an intimate scene between {{char}} and {{user}}.
 * It adds realism and length — nobody finishes in two replies, the body comes before haste, he prepares her
 * if she is not ready. Pure functions over state.intim, so it rolls back with swipes like the rest of the state
 * and Node tests it. No SillyTavern imports.
 *
 * One request: Stork's own scene analysis carries a short "closeness" field every reply, and a full "afterglow"
 * section only while a scene is near or under way. Orgasms, protection and time come from Stork's own reading,
 * so the two never disagree.
 *
 * state.intim = {
 *   scene: null | { id, start, turns, minutes, visible, near, dyn, phase, pose, clothes, char: {...}, user: {...}, kinks: [names], ... },
 *   history: [{ at, id, turns, minutes, dyn, org, responds, marks, kinks }],
 *   kinks: undefined | [{ name, from }]  — every kink of the card and the persona (undefined: never read yet),
 *   voice: string | null                 — how {{char}} talks and thinks, for his inner line,
 *   profile: undefined | { char, user }  — how each of them is in bed, from the card and the persona (undefined: never read yet),
 * }
 */

export const DYN = {
    tender: { ru: 'Нежная', en: 'tender — gentle and careful, lots of touching and closeness', cap: 15 },
    languid: { ru: 'Томная', en: 'languid — slow and drawn out, a long plateau, climax held back', cap: 10 },
    passionate: { ru: 'Страстная', en: 'passionate — ardent and mutual, builds fast', cap: 22 },
    playful: { ru: 'Игривая', en: 'playful — teasing, laughter, pauses', cap: 15 },
    dominant: { ru: 'Властная', en: 'dominant — one partner leads and controls the pace', cap: 20 },
    rough: { ru: 'Грубая', en: 'rough — force and pressure; needs more preparation, leaves marks', cap: 25 },
    awkward: { ru: 'Неловкая', en: 'awkward — first time or inexperience: fumbling, a laugh, starting over', cap: 12 },
    hurried: { ru: 'Торопливая', en: 'hurried — little time or room; the body may not keep up', cap: 28 },
};

/** Stages: kept inside for pacing (one step a reply, the climax only after a real one), never shown. */
export const PHASES = ['prelude (kissing, undressing)', 'foreplay', 'preparing her body', 'intercourse begins', 'build-up', 'climax', 'afterglow'];

const READY_CAP = 40;        // her readiness grows by at most this much a reply
const READY_LEAD = 15;       // her «до оргазма» never runs more than this ahead of her readiness
const POSE_TIRES = 12;       // minutes in one position before the body starts to tell
const MAX_BEATS = 4;         // what he did in the last replies, so the next does something else
const PRE_PEAK = 92;         // without an orgasm in this reply «до оргазма» stays below this
const REFRACTORY = 15;       // his minutes after an orgasm
const MAX_SCENE_MINUTES = 120;
const AFTER_MINUTES = 6 * 60;  // after the scene, its marks are recalled this long (story time)
const MAX_HISTORY = 20;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d = null) => {
    if (v === null || v === undefined || String(v).trim() === '') return d;
    const n = Number(String(v).replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : d;
};
const str = (v, max = 120) => {
    const x = String(v ?? '').replace(/\s+/g, ' ').trim();
    return x && !/^(null|none|нет|-|—|n\/a|undefined)$/i.test(x) ? x.slice(0, max) : null;
};
const bool = v => v === true || /^(true|yes|да|1)$/i.test(String(v ?? '').trim());
const uniq = (arr, max) => {
    const seen = new Set();
    const out = [];
    for (const x of arr) {
        const k = String(x ?? '').toLowerCase().trim();
        if (k && !seen.has(k)) { seen.add(k); out.push(x); }
    }
    return out.slice(-max);
};
const norm = v => String(v ?? '').toLowerCase().replace(/[^\p{L}\d]+/gu, ' ').trim();
const list = (v, max = 6, len = 60) => (Array.isArray(v) ? v : []).map(x => str(typeof x === 'string' ? x : x?.name ?? x?.text, len)).filter(Boolean).slice(0, max);

export function ensureIntim(state) {
    state.intim ??= { scene: null, history: [] };
    state.intim.history ??= [];
    if (state.intim.scene === undefined) state.intim.scene = null;
    return state.intim;
}

// #region What the story says before the reading

/** A time skip in her message: during a scene it ends the scene. «Утром…», «Позже…», «Later…» at the start count too. */
const SKIP_RE = /(прошл[оаи]?\s+(\S+\s+)?(час|дн|сут|недел|месяц|год|лет)|(час|дн|сут|недел|месяц|год|лет)\S*\s+спустя|спустя\s+(\S+\s+)?(час|дн|сут|недел|месяц|год|лет)|на\s+следующ\S+\s+(день|утро|вечер|ночь|неделе)|наутро|утром\s+следующ|тайм-?скип|time\s*skip|\b(hours?|days?|weeks?|months?|years?)\s+later\b|\bthe\s+next\s+(morning|day|evening|week)\b)/i;
const START_SKIP_RE = /^[\s*_~"«(\[]*(утром|наутро|вечером|дн[её]м|ночью|позже|позднее|на рассвете|к утру|later|in the morning|the next)/i;
export const isTimeskip = text => SKIP_RE.test(String(text ?? '')) || START_SKIP_RE.test(String(text ?? ''));

/**
 * Words that may mean a scene is starting: the full section is asked for only then (or while a scene goes on).
 * Broad on purpose — a miss costs a reply without the director, a false hit only a few hundred tokens.
 */
const HINT_STEMS = [
    'поцел', 'целов', 'целу[юе]', 'губам', 'губы', 'раздева', 'раздел(ся|ась|ись|а)(?!\\p{L})', 'раздет', 'расстегн', 'стянул', 'снял[аи]? (с себя|с неё|с нее|с него|рубашк|футболк|плать|бель)',
    'бель[её]', 'трусик', 'трусы', 'лифчик', 'ширинк', 'ласк', 'приласк', 'возбужд', 'стон', 'застон', 'обнаж', 'голая', 'голый', 'голое', 'голые', 'нагая', 'нагой', 'наготу',
    'член(?!ств|ов|ы(?!\\p{L}))', 'влагалищ', 'клитор', 'соск', 'сосок', 'грудь', 'бёдр', 'бедр', 'между ног', 'секс', 'близост', 'переспа', 'трах', 'оргазм',
    'конч(ил[аи]?|аю|ает|ая|ить|у)(?!\\p{L})', 'постел', 'kiss', 'undress', 'naked', 'moan', 'arous', 'breast', 'thigh', 'between (her|his) legs', 'sex', 'orgasm', 'bed(?!\\p{L})',
];
// each stem from the start of a word: «метрах» is not «трах», «разделить» is not «разделась»
const HINT_RE = new RegExp(`(?<!\\p{L})(?:${HINT_STEMS.join('|')})`, 'iu');
export const mayBeIntimate = text => HINT_RE.test(String(text ?? ''));

/**
 * How much of the director the next reading carries.
 * 'full': a scene is near or going on, or the text hints at one; 'light': only the one-word "closeness" field.
 */
export function readingMode(state, texts = []) {
    const sc = state.intim?.scene;
    if (sc?.visible || sc?.near) return 'full';
    return texts.some(mayBeIntimate) ? 'full' : 'light';
}

// #endregion

// #region The section of the analysis request

const pct = v => `${Math.round(v)}%`;

/** The scene before the newest messages, for the reader. */
function stateLine(sc) {
    if (!sc || (!sc.visible && !sc.near)) return 'No intimate scene is tracked yet.';
    if (!sc.visible) return 'Things were heading toward intimacy, it had not started yet.';
    const u = sc.user, c = sc.char;
    return [
        `Dynamic: ${sc.dyn}. Stage: ${sc.phase} (${PHASES[sc.phase]}). ${sc.minutes} story minutes, ${sc.turns} replies so far.`,
        `{{user}}: readiness ${u.readiness}, climax ${u.climax}, state "${u.state || '-'}", orgasms ${u.org}${u.sensitive ? ', oversensitive after orgasm' : ''}.`,
        `{{char}}: climax ${c.climax}, state "${c.state || '-'}", orgasms ${c.org}${c.refr > 0 ? `, refractory ~${c.refr} min left` : ''}.`,
        `Position: ${sc.pose || '-'}${sc.pose ? ` (~${sc.poseMin ?? 0} min in it)` : ''}; clothes: ${sc.clothes || '-'}; protection: ${sc.protection || 'unknown'}.`,
        sc.place ? `Place: ${sc.place.privacy}, chance of interruption ${sc.place.interrupt}% (${sc.place.why || '-'}).` : '',
        sc.beats?.length ? `What {{char}} did in the last replies: ${sc.beats.join('; ')}.` : '',
    ].filter(Boolean).join('\n');
}

/** The one field every reading carries while the director is on. */
export const CLOSENESS_FIELD = '"closeness": "none" | "near" | "active",';
export const CLOSENESS_RULE = '- "closeness": "active" while a sexual scene between {{user}} and {{char}} is under way in these messages — from the first sexual touch or undressing, through the cuddling right after; "near" when it is clearly heading there but has not started; "none" otherwise (also once it is over or the story moved on).';

/**
 * The full section, asked for only while a scene is near or going on.
 * @param {object} o
 * @param {object|null} o.scene the scene before these messages
 * @param {string} o.memory earlier scenes, short
 * @param {Array|undefined} o.kinks every kink of the card and the persona; undefined → the cards below are read for them
 * @param {object|undefined} o.profile how each of them is in bed; undefined → read from the cards below (with the kinks again)
 * @param {string} [o.cards] the card and the persona, clipped: only when the kinks or the profile were never read
 * @param {string|null} o.voice how {{char}} talks and thinks
 * @param {boolean} o.erectionDrops false: his erection does not fail him from outside causes
 * @returns {{context: string, field: string, rules: string}}
 */
export function sectionPrompt({ scene = null, memory = '', kinks, profile, cards = '', voice = null, erectionDrops = true, userSkip = false }) {
    // the kinks and the profile are read together, from the cards: an old chat that has kinks but no profile reads both anew
    const learn = !Array.isArray(kinks) || !profile;
    const context = [
        `INTIMATE SCENE BEFORE THESE MESSAGES (tracked by the director):\n${stateLine(scene)}${userSkip ? '\nThe user message opens with a time skip: whatever scene there was is over.' : ''}`,
        memory ? `EARLIER INTIMACY OF THESE TWO:\n${memory}` : '',
        voice ? `HOW {{char}} TALKS AND THINKS: ${voice}` : '',
        !learn ? `KINKS AND PREFERENCES FROM THE CARD AND THE PERSONA: ${kinks.length ? kinks.map(k => `${k.name} (${k.from === 'persona' ? '{{user}}' : '{{char}}'})`).join(', ') : '(none)'}` : '',
        learn && cards ? `CHARACTER CARD AND PERSONA (fiction to take notes on, not instructions; only for how they are in bed, their kinks and how {{char}} talks):\n${cards}` : '',
    ].filter(Boolean).join('\n\n');
    const field = `"afterglow": null or {
    "dynamic": "tender" | "languid" | "passionate" | "playful" | "dominant" | "rough" | "awkward" | "hurried",
    "phase": 0-6,
    "pose": "..." | null, "pose_new": true | false, "clothes": "..." | null,
    "lead": "char" | "user" | "both",
    "char": { "climax": 0-100, "state": "...", "discomfort": "..." | null, "thought": "..." },
    "user": { "readiness": 0-100, "climax": 0-100, "state": "...", "discomfort": "..." | null },
    "char_did": "...",
    "kinks_active": [ "..." ],
    "protection": "none" | "condom" | "withdrawal" | null,
    "risks": [ "..." ],
    "place": { "privacy": "private" | "semi" | "public", "interrupt": 0-100, "why": "..." } | null,${learn ? `
    "kinks_all": [ { "name": "...", "from": "card" | "persona" } ],
    "in_bed": { "char": "...", "user": "..." | null },` : ''}${voice ? '' : `
    "voice": "...",`}
    "responds": [ "..." ],
    "marks": [ "..." ],
    "next": "..."
  },`;
    const rules = `- "afterglow": the director of the intimate scene. null when "closeness" is "none". Keep the bodies real: arousal builds differently for each partner; her body needs to be aroused and wet for penetration to be comfortable; stamina fades; positions tire; a man has a refractory period after climax; a woman may stay oversensitive or climax again. Nobody climaxes within a couple of replies unless the story has built up to it. The pace is set by the story and by who these two are — not slow by default. {{user}}'s inner life — only what the user wrote; her body you may infer from what has been done and how.
  - "dynamic": what the scene is now, given who both of them are. "phase": 0 prelude (kissing, undressing) · 1 foreplay · 2 preparing her body · 3 intercourse begins · 4 build-up · 5 climax · 6 afterglow; it moves with the story and can go back.
  - "readiness" (her only): her arousal and wetness — how ready her body is for sex. It rises with whatever arouses HER (touch, kisses, words, her kinks, the situation itself) and can rise fast when the story shows she is very turned on; it falls with discomfort, fear, cold, distraction. Low readiness with penetration means discomfort or pain.
  - "climax": how close each of them is to orgasm right now, 0-100, by what is actually done and how; it falls with pauses, discomfort, distraction. Hers cannot run ahead of her readiness (readiness 30 → climax at most ~45). 100 only at the moment of orgasm (the orgasm itself goes into "orgasm" above).
  - "pose": the position they are in now, a few words ("она сверху", "у стены, он сзади"); null before there is one. "pose_new": true if they changed position in these messages.
  - "state": 1-3 words for how each of them is right now (breath, body, composure). "discomfort": a few words (a leg gone numb, knees on a hard floor, a cramp), or null.
  - "thought": {{char}}'s inner thought at this moment — one short line in his own voice, exactly as he would think it: his vocabulary, temper and manner of speech. Not a summary of events.
  - "char_did": 3-6 words, the main thing {{char}} did in these messages ("целовал шею", "спросил, готова ли", "посадил на стол").
  - "kinks_active": which of the kinks and preferences ${learn ? 'of the card and the persona' : 'listed above'} are actually in play in these messages — done, said or clearly wanted — written exactly as listed; empty if none.
  - "protection": what protects them now as the messages show it — "condom" once he put one on, "none" for intercourse without, "withdrawal" if he pulled out; null while it is not clear.
  - "risks": other risks the story itself shows right now, a few words each: drunk, a condom slipped, no lubricant, an injury, a dangerous place. Not protection, fertility or the place and being seen (each tracked separately). Empty if none.
  - "place": how private the place is, ONLY from what the story established: "private" (a home, a locked room, a hotel room), "semi" (a car, an office, a fitting room — people may be near), "public". "interrupt": the chance someone interrupts or catches them soon, judging only by what the story says (people around, a door without a lock, someone expected home); 0 when nothing in the story suggests it. "why": a few words. Never invent people or events the story does not have.${learn ? `
  - "kinks_all": EVERY kink, fetish, sexual preference or turn-on the card or the persona names or clearly implies (from the texts, never from these messages) ("оральный секс", "разные позы", "заводит её грудь", "доминирование"), "from" where it is written; never invent; never anything they name as a limit or a dislike; empty if none.
  - "in_bed": in English, from the card and the persona only — what they actually say, never a guess and never from these messages. "char": 2-3 sentences on {{char}} in bed — libido, experience, who leads, pace, what turns him on, habits, what he says or does not say. "user": 1-2 sentences on {{user}} the same way, or null if the persona says nothing.` : ''}${voice ? '' : `
  - "voice": in English, one sentence on how {{char}} talks and thinks (vocabulary, temper, manner), from the card.`}
  - "responds": what {{user}} visibly enjoyed, judging only by the user's own writing; new things only, a few words each.
  - "marks": physical traces left on either of them in these messages (hickeys, scratches, bruises); new ones only.
  - "next": in English, 1-2 sentences for the story model — where the NEXT reply should take the scene so it moves and stays true to {{char}}: his character, his ways in bed, his preferences, what she responds to; something different from what he did in the last replies; a change of position when one has gone on long or hurts; holding back when he is too close. Never steer toward stalling: no asking whether she is ready or wants it, no endless preparing once the user moves things forward. Steer, do not script; never decide {{user}}'s actions.${erectionDrops ? '' : `
  - {{char}}'s erection never fails him because of outside causes (drink, stress, tiredness, illness): never report it as a discomfort or steer toward it.`}
  - Every text value of "afterglow" except "next", "voice" and "in_bed": Russian only, short.`;
    return { context, field, rules };
}

const PRIVACY = ['private', 'semi', 'public'];
function placeOf(raw) {
    if (!raw || typeof raw !== 'object' || !PRIVACY.includes(String(raw.privacy))) return null;
    return { privacy: String(raw.privacy), interrupt: clamp(Math.round(num(raw.interrupt, 0)), 0, 100), why: str(raw.why, 60) };
}

const BED_RE = /(sex|kink|fetish|\bbed\b|intima|libido|arous|turn[- ]?on|nsfw|erotic|orgasm|dominan|submissi|секс|интим|постел|кинк|фетиш|либидо|возбужд|эрот|оргазм|доминир|подчин)/i;
const VOICE_RE = /(speech|voice|talk|personality|character|речь|голос|характер|личност)/i;
/**
 * The part of a card that says how someone is in bed, within max characters: a card puts its «Sexual Preferences»
 * anywhere, often past the first few thousand characters. Bed sections first, then single lines about it from
 * other sections, then how he speaks and who he is, then the start of the card.
 */
export function bedExcerpt(text, max = 3000) {
    const src = String(text ?? '').replace(/\r/g, '');
    if (src.length <= max) return src;
    // sections: a markdown header and what follows it; a card without headers is cut into paragraphs
    const parts = /^#{1,4} /m.test(src) ? src.split(/\n(?=#{1,4} )/) : src.split(/\n\s*\n/);
    const head = s => s.split('\n')[0];
    const picked = [];
    const used = new Set();
    let size = 0;
    const take = (s, i) => {
        if (size >= max || (i !== undefined && used.has(i))) return;
        const piece = s.trim().slice(0, max - size);
        if (!piece) return;
        picked.push(piece);
        size += piece.length + 2;
        if (i !== undefined) used.add(i);
    };
    parts.forEach((s, i) => { if (BED_RE.test(head(s))) take(s, i); });
    parts.forEach((s, i) => {
        if (used.has(i)) return;
        const lines = s.split('\n').filter((l, j) => j > 0 && BED_RE.test(l));
        if (lines.length) take(`${head(s)}\n${lines.join('\n')}`);
    });
    parts.forEach((s, i) => { if (VOICE_RE.test(head(s))) take(s, i); });
    parts.forEach((s, i) => take(s, i));
    return picked.join('\n\n');
}

/** The section as the analysis returned it, cleaned. null when there is none. */
export function parseSection(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const person = (p, her) => ({
        climax: num(p?.climax),
        readiness: her ? num(p?.readiness) : null,
        state: str(p?.state, 40),
        discomfort: str(p?.discomfort, 70),
        thought: her ? null : str(p?.thought, 200),
    });
    return {
        dynamic: DYN[String(raw.dynamic || '').toLowerCase()] ? String(raw.dynamic).toLowerCase() : null,
        phase: num(raw.phase),
        pose: str(raw.pose, 80),
        clothes: str(raw.clothes, 100),
        lead: ['char', 'user', 'both'].includes(String(raw.lead)) ? String(raw.lead) : null,
        char: person(raw.char, false),
        user: person(raw.user, true),
        kinksActive: list(raw.kinks_active, 12, 40),
        kinksAll: Array.isArray(raw.kinks_all) ? raw.kinks_all.map(k => ({ name: str(typeof k === 'string' ? k : k?.name, 40), from: k?.from === 'persona' ? 'persona' : 'card' })).filter(k => k.name).slice(0, 16) : null,
        voice: str(raw.voice, 240),
        poseNew: bool(raw.pose_new),
        charDid: str(raw.char_did, 60),
        protection: ['none', 'condom', 'withdrawal'].includes(String(raw.protection)) ? String(raw.protection) : null,
        risks: list(raw.risks, 4, 50),
        place: placeOf(raw.place),
        inBed: raw.in_bed && typeof raw.in_bed === 'object' ? { char: str(raw.in_bed.char, 500), user: str(raw.in_bed.user, 300) } : null,
        responds: list(raw.responds, 4),
        marks: list(raw.marks, 4),
        next: str(raw.next, 500),
    };
}

/** Kinks from the cards analysis (at setup): a list of names or { name, from }. */
export function cleanKinks(raw) {
    if (!Array.isArray(raw)) return null;
    return raw.map(k => ({ name: str(typeof k === 'string' ? k : k?.name, 40), from: k?.from === 'persona' ? 'persona' : 'card' })).filter(k => k.name)
        .filter((k, i, all) => all.findIndex(x => x.name.toLowerCase() === k.name.toLowerCase()) === i).slice(0, 16);
}

// #endregion

// #region The scene itself

export function newScene(at) {
    return {
        id: `s${at}`,
        start: at,
        turns: 0,
        minutes: 0,
        visible: false,
        near: false,
        dyn: 'tender',
        phase: 0,
        lead: null,
        pose: null,
        poseMin: 0,
        clothes: null,
        protection: null,
        risks: [],
        place: null,
        beats: [],
        char: { climax: 0, state: null, org: 0, refr: 0, discomfort: null, thought: null },
        user: { climax: 0, readiness: 0, state: null, org: 0, discomfort: null, sensitive: false },
        kinks: [],
        hindrance: null,
        responds: [],
        marks: [],
        next: null,
    };
}

/**
 * The scene after one reply: the reader proposes, the code keeps the pace.
 * @param {object|null} prev
 * @param {object|null} s parseSection(), or null (only "closeness" was read: the numbers stay)
 * @param {object} o { active, at, minutes, orgasm: { user, char } }
 */
export function advance(prev, s, { active, at, minutes = 0, orgasm = {} }) {
    const first = !prev?.visible;
    const sc = prev ? JSON.parse(JSON.stringify(prev)) : newScene(at);
    if (first && prev && !prev.visible) Object.assign(sc, newScene(prev.start ?? at), { id: prev.id, near: false });
    const r = s ?? { char: {}, user: {}, kinksActive: [], responds: [], marks: [] };
    sc.turns += 1;
    const mins = clamp(Math.round(minutes || 0), 0, MAX_SCENE_MINUTES);
    sc.minutes += mins;
    sc.visible = !!active;
    sc.near = !active;
    if (r.dynamic) sc.dyn = r.dynamic;
    const cap = DYN[sc.dyn]?.cap ?? 15;
    const herOrgasm = !!orgasm.user, hisOrgasm = !!orgasm.char;
    const anyOrgasm = herOrgasm || hisOrgasm;

    // stage: at most one step a reply (an orgasm goes straight to the peak), the peak only after a real one
    if (r.phase !== null && r.phase !== undefined) {
        let p = clamp(Math.round(r.phase), 0, 6);
        if (!first && p > sc.phase + 1) p = anyOrgasm ? Math.max(sc.phase + 1, 5) : sc.phase + 1;
        if (p >= 5 && !anyOrgasm && !(sc.char.org || sc.user.org)) p = 4;
        sc.phase = p;
    } else if (anyOrgasm) sc.phase = Math.max(sc.phase, 5);

    // him
    sc.char.refr = Math.max(0, (sc.char.refr || 0) - mins);
    {
        const c = r.char ?? {};
        let v = c.climax ?? sc.char.climax;
        if (hisOrgasm) { sc.char.org += 1; v = 100; sc.char.refr = REFRACTORY; }
        else {
            if (!first) v = Math.min(v, sc.char.climax >= 100 ? 10 : sc.char.climax + cap);
            if (sc.char.refr > 0) v = Math.min(v, 10);
            v = Math.min(v, PRE_PEAK);
        }
        sc.char.climax = clamp(Math.round(v), 0, 100);
        if (c.state) sc.char.state = c.state;
        if (s) sc.char.discomfort = c.discomfort ?? null;
        if (c.thought) sc.char.thought = c.thought;
    }
    // her: readiness (arousal, wetness) first — how close she is to orgasm cannot run ahead of it
    {
        const u = r.user ?? {};
        let rd = u.readiness ?? sc.user.readiness;
        if (!first) rd = Math.min(rd, sc.user.readiness + READY_CAP);
        if (herOrgasm) rd = Math.max(rd, 80);
        sc.user.readiness = clamp(Math.round(rd), 0, 100);
        let v = u.climax ?? sc.user.climax;
        if (herOrgasm) { sc.user.org += 1; v = 100; sc.user.sensitive = true; }
        else {
            if (!first) v = Math.min(v, sc.user.climax >= 100 ? 45 : sc.user.climax + cap);
            v = Math.min(v, PRE_PEAK, sc.user.readiness + READY_LEAD);
            if (sc.user.climax < 100) sc.user.sensitive = sc.user.sensitive && mins < 10;
            else sc.user.sensitive = mins < 10;
        }
        sc.user.climax = clamp(Math.round(v), 0, 100);
        if (u.state) sc.user.state = u.state;
        if (s) sc.user.discomfort = u.discomfort ?? null;
    }

    // the position: a new one starts its minutes anew; the same one tires the body
    if (r.pose && (r.poseNew || !sc.pose || norm(r.pose) !== norm(sc.pose) && r.poseNew !== false)) sc.poseMin = Math.min(mins, 5);
    else if (sc.pose || r.pose) sc.poseMin = (sc.poseMin ?? 0) + mins;
    for (const k of ['pose', 'clothes', 'lead']) if (r[k]) sc[k] = r[k];
    if (r.protection) sc.protection = r.protection;
    if (r.place) sc.place = r.place;
    if (r.charDid) sc.beats = [...(sc.beats ?? []), r.charDid].slice(-MAX_BEATS);
    if (s) {
        sc.kinks = r.kinksActive ?? [];
        sc.risks = r.risks ?? [];
        sc.hindrance = r.hindrance ?? null;
        sc.next = r.next ?? null;
    }
    sc.responds = uniq([...sc.responds, ...(r.responds ?? [])], 8);
    sc.marks = uniq([...sc.marks, ...(r.marks ?? [])], 8);
    return sc;
}

/** A finished scene in a few words, for the memory of later ones. */
export function summarize(sc, endAt) {
    return {
        at: endAt,
        id: sc.id,
        turns: sc.turns,
        minutes: sc.minutes,
        dyn: sc.dyn,
        org: { c: sc.char.org, u: sc.user.org },
        responds: sc.responds.slice(-6),
        marks: sc.marks.slice(-6),
        kinks: (sc.kinks ?? []).slice(0, 4),
    };
}

/** The memory for the reader: the last scenes a line each, older ones in one line. */
export function memoryText(history, maxChars = 1200) {
    if (!history?.length) return '';
    const line = h => `${DYN[h.dyn]?.en.split(' —')[0] || h.dyn}, ~${h.minutes} min, orgasms him ${h.org.c} / her ${h.org.u}`
        + `${h.responds.length ? `; she responded to: ${h.responds.join(', ')}` : ''}`
        + `${h.kinks?.length ? `; kinks in play: ${h.kinks.join(', ')}` : ''}`
        + `${h.marks.length ? `; marks left: ${h.marks.join(', ')}` : ''}`;
    const recent = history.slice(-3);
    const old = history.slice(0, -3);
    const parts = [`Times together so far: ${history.length}.`];
    if (old.length) {
        const known = uniq(old.flatMap(h => h.responds), 10);
        const kinks = uniq(old.flatMap(h => h.kinks ?? []), 6);
        parts.push(`Earlier (${old.length}): ${known.length ? `she responded to ${known.join(', ')}` : 'nothing special noted'}${kinks.length ? `; kinks: ${kinks.join(', ')}` : ''}.`);
    }
    recent.forEach((h, i) => parts.push(`${i === recent.length - 1 ? 'Last time' : 'Before'}: ${line(h)}.`));
    let t = parts.join('\n');
    while (t.length > maxChars && parts.length > 2) { parts.splice(1, 1); t = parts.join('\n'); }
    return t.slice(0, maxChars);
}

/** What he already knows she responds to: from earlier scenes and this one. */
export const knownOf = (history, sc) => uniq([...(history ?? []).flatMap(h => h.responds), ...(sc?.responds ?? [])], 8);

function endScene(intim, endAt) {
    const sc = intim.scene;
    if (sc?.everActive) {
        intim.history = [...intim.history.filter(h => h.id !== sc.id), summarize(sc, endAt)].slice(-MAX_HISTORY);
    }
    intim.scene = null;
}

/**
 * One reply read: start, go on with or end the scene. Called by the engine with the analysis.
 * @param {object} state the state after the reply's time has passed
 * @param {object} scene the analysis: closeness, afterglow, orgasm, intimacy, user_skip
 * @param {object} o { at: absolute story minute now, minutes: story minutes this reply took }
 * @returns {'start'|'end'|null} what changed, for the journal
 */
export function applyIntimacy(state, scene, { at, minutes = 0 }) {
    const intim = ensureIntim(state);
    const s = parseSection(scene?.afterglow);
    // kinks and his voice: read once (from the cards at setup, or here, the first time a scene comes)
    if (s?.kinksAll && (!Array.isArray(intim.kinks) || !intim.profile)) {
        const fresh = cleanKinks(s.kinksAll);
        intim.kinks = fresh?.length ? fresh : intim.kinks ?? [];
        // asked once: an empty answer is kept as «nothing in the cards», not asked every reply
        intim.profile = s.inBed ?? { char: null, user: null };
    } else if (s?.inBed && !intim.profile) intim.profile = s.inBed;
    if (s?.voice && !intim.voice) intim.voice = s.voice;

    let closeness = ['none', 'near', 'active'].includes(scene?.closeness) ? scene.closeness : null;
    // actual intercourse in Stork's own reading is a scene whatever the field says
    if (scene?.intimacy) closeness = 'active';
    if (closeness === null) closeness = s ? 'active' : 'none';
    const prev = intim.scene;
    const orgasm = { user: (scene?.orgasm ?? []).includes('user'), char: (scene?.orgasm ?? []).includes('char') };
    // a time skip in her message, or a long jump in the reply, ends what was going on
    const skipped = scene?.user_skip === true || minutes > 3 * 60;
    if (prev && skipped) endScene(intim, at - minutes);

    if (closeness === 'none') {
        const was = intim.scene?.visible;
        if (intim.scene) endScene(intim, at);
        return was ? 'end' : null;
    }
    const base = intim.scene;
    if (closeness === 'near' && base?.visible) {
        // it was going on and is only «near» now: the scene is over, the next may come
        endScene(intim, at);
        intim.scene = advance(null, s, { active: false, at, minutes: 0, orgasm: {} });
        return 'end';
    }
    const wasVisible = !!base?.visible;
    const sc = advance(base, s, { active: closeness === 'active', at, minutes: wasVisible ? minutes : 0, orgasm });
    if (sc.visible) sc.everActive = true;
    else if (base?.everActive) sc.everActive = true;
    intim.scene = sc;
    return sc.visible && !wasVisible ? 'start' : null;
}

/** The same kink in other words: «оральный секс» and «оральные ласки», «доминирование» and «мужское доминирование». */
export function sameKink(a, b) {
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    if (x === y || x.includes(y) || y.includes(x)) return true;
    const stems = s => s.split(' ').filter(w => w.length > 3).map(w => w.slice(0, 5));
    const sx = stems(x), sy = stems(y);
    return sx.length > 0 && sx.some(w => sy.includes(w));
}

/** The kinks to show as chips: every kink of the card and the persona, the active ones lit. */
export function kinkChips(state) {
    const intim = state.intim ?? {};
    const active = intim.scene?.kinks ?? [];
    const all = Array.isArray(intim.kinks) ? intim.kinks.map(k => k.name) : [];
    const names = all.slice(0, 20);
    for (const k of active) if (!names.some(n => sameKink(n, k))) names.push(k);
    return names.slice(0, 20).map(name => ({ name, on: active.some(k => sameKink(name, k)) }));
}

// #endregion

// #region For the story model

/** Limits the code sets for the next reply: only what the numbers forbid, never how he should behave. */
export function guards(sc) {
    const out = [];
    if (sc.user.readiness < 50 && sc.phase >= 3) out.push(`{{user}} is not aroused and wet enough yet (${sc.user.readiness}%): penetration is uncomfortable for her, and her body shows it. What {{char}} does about it is his own — true to his character, not a pause in the story.`);
    if (sc.user.discomfort) out.push(`{{user}} feels discomfort (${sc.user.discomfort}): it shows in her body and {{char}} notices it as he would.`);
    if (sc.char.discomfort) out.push(`{{char}} feels discomfort (${sc.char.discomfort}).`);
    if (sc.pose && sc.phase >= 1 && (sc.poseMin ?? 0) >= POSE_TIRES) out.push(`They have been in this position (${sc.pose}) for about ${sc.poseMin} minutes: legs, knees or arms start to tire or go numb — a shift or a new position comes naturally when it fits.`);
    if (sc.char.refr > 0) out.push(`{{char}} has just climaxed: refractory period, about ${sc.char.refr} more minutes — he cannot climax again yet.`);
    if (sc.user.sensitive) out.push('{{user}} has just climaxed and is oversensitive: the same touch may now be too much.');
    const close = v => v >= 85;
    if (!close(sc.char.climax) && !close(sc.user.climax)) out.push('Neither of them is close to orgasm yet: no climax in this reply.');
    else {
        if (!close(sc.char.climax)) out.push(`{{char}} is only at ${sc.char.climax}%: he does not climax in this reply.`);
        if (!close(sc.user.climax)) out.push(`{{user}} is only at ${sc.user.climax}%: her orgasm does not come in this reply unless the user writes it.`);
    }
    return out;
}

/** What the place means for them, for the story model: only what the story set up, never a push toward an interruption. */
function placeLine(place) {
    if (!place || place.privacy === 'private') return '';
    const why = place.why ? ` (${place.why})` : '';
    return `The place is ${place.privacy === 'public' ? 'public' : 'not quite private'}${why}: it can colour the scene — keeping quiet, haste, the thrill. An interruption may come only from what the story already has there; never invent one.`;
}

/** How each of them is in bed and what they like: from the cards, so he is himself and not a template. */
function portrait(intim) {
    const L = [];
    const p = intim.profile ?? {};
    const kinks = Array.isArray(intim.kinks) ? intim.kinks : [];
    const his = kinks.filter(k => k.from !== 'persona').map(k => k.name);
    const hers = kinks.filter(k => k.from === 'persona').map(k => k.name);
    if (p.char) L.push(`{{char}} in bed: ${p.char}`);
    if (his.length) L.push(`{{char}}'s preferences: ${his.join(', ')}.`);
    if (p.user) L.push(`{{user}} in bed: ${p.user}`);
    if (hers.length) L.push(`{{user}}'s preferences: ${hers.join(', ')}.`);
    if (his.length || hers.length) L.push('Let these shape what he does — one at a time, when the moment fits, not all at once.');
    return L;
}

const NO_TEMPLATE = 'Make this reply his own, not a template: vary what he does and how the reply ends. Do not end with {{char}} asking whether she is ready, wants it or is okay, and do not stall — when {{user}} moves things forward, he goes with her. End on an action, a sensation or his words.';

/**
 * The guidance for the story model: the scene in progress, a scene that is near, or the traces of the last one.
 * @param {object} state
 * @param {object} o { userSkip: her last message skips time, erectionDrops }
 */
export function intimacyPrompt(state, { userSkip = false, erectionDrops = true } = {}) {
    const intim = state.intim;
    if (!intim) return '';
    const sc = userSkip ? null : intim.scene;
    const firm = erectionDrops ? '' : ' His erection does not fail him because of drink, stress or tiredness.';
    if (sc?.visible) {
        const u = sc.user, c = sc.char;
        const L = ['[Intimate scene in progress — guidance for writing it; never mention it.]'];
        L.push(`Dynamic: ${DYN[sc.dyn]?.en ?? sc.dyn}. Stage: ${PHASES[sc.phase]} · ${sc.minutes} min in.`);
        L.push(`{{user}}: aroused/wet ${pct(u.readiness)}, closeness to orgasm ${pct(u.climax)}${u.state ? ` — ${u.state}` : ''}${u.org ? `; orgasms so far: ${u.org}` : ''}.`);
        L.push(`{{char}}: closeness to orgasm ${pct(c.climax)}${c.state ? ` — ${c.state}` : ''}${c.org ? `; orgasms so far: ${c.org}` : ''}.${firm}`);
        const scene = [sc.pose && `position: ${sc.pose}`, sc.clothes && `clothes: ${sc.clothes}`].filter(Boolean);
        if (scene.length) L.push(`${scene.join('; ')}.`);
        const place = placeLine(sc.place);
        if (place) L.push(place);
        else if (sc.hindrance) L.push(`Mind the setting: ${sc.hindrance}.`);
        L.push(...portrait(intim));
        if (sc.kinks?.length) L.push(`In play now: ${sc.kinks.join(', ')}.`);
        const known = knownOf(intim.history, sc);
        if (known.length) L.push(`{{char}} already knows what {{user}} responds to: ${known.join(', ')} — he uses it the way a partner who remembers would.`);
        if (sc.beats?.length) L.push(`In the last replies he already: ${sc.beats.join('; ')} — do something different now.`);
        L.push('Bodies are real: breath, stamina, muscles, wetness, positions that tire. Never speak or decide for {{user}}.');
        L.push(NO_TEMPLATE);
        L.push(...guards(sc));
        if (sc.next) L.push(`This reply: ${sc.next}`);
        return L.join('\n');
    }
    if (sc?.near) {
        return [
            '[Things are heading toward intimacy — guidance; never mention it.]',
            ...portrait(intim),
            'If it begins, let it begin the way these two would. Nobody climaxes in the reply where it starts.',
            NO_TEMPLATE,
            sc.next ? `This reply: ${sc.next}` : '',
        ].filter(Boolean).join('\n');
    }
    const last = intim.history?.at(-1);
    const now = (state.clock?.day ?? 0) * 1440 + (state.clock?.minutes ?? 0);
    if (last?.marks?.length && now - last.at < AFTER_MINUTES) {
        return `[After their recent intimacy — marks left on them: ${last.marks.join(', ')}. Let it show where it fits; never mention this note.]`;
    }
    return '';
}

// #endregion
