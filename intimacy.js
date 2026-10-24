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
 * }
 */

export const DYN = {
    tender: { ru: 'Нежная', en: 'tender — gentle and careful, lots of touching, he keeps checking her reactions', cap: 15 },
    languid: { ru: 'Томная', en: 'languid — slow and drawn out, a long plateau, climax held back', cap: 10 },
    passionate: { ru: 'Страстная', en: 'passionate — ardent and mutual, builds fast', cap: 22 },
    playful: { ru: 'Игривая', en: 'playful — teasing, laughter, pauses', cap: 15 },
    dominant: { ru: 'Властная', en: 'dominant — one partner leads and controls the pace', cap: 20 },
    rough: { ru: 'Грубая', en: 'rough — force and pressure; needs more preparation, leaves marks', cap: 25 },
    awkward: { ru: 'Неловкая', en: 'awkward — first time or inexperience: pauses, uncertainty, fumbling', cap: 12 },
    hurried: { ru: 'Торопливая', en: 'hurried — little time or room; the body may not keep up', cap: 28 },
};

/** Stages: kept inside for pacing (one step a reply, the climax only after a real one), never shown. */
export const PHASES = ['prelude (kissing, undressing)', 'foreplay', 'preparing her body', 'intercourse begins', 'build-up', 'climax', 'afterglow'];

const READY_CAP = 35;        // her readiness grows by at most this much a reply
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
        `Position: ${sc.pose || '-'}; clothes: ${sc.clothes || '-'}.`,
    ].join('\n');
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
 * @param {string} [o.cards] the card and the persona, clipped: only when kinks were never read
 * @param {string|null} o.voice how {{char}} talks and thinks
 * @param {boolean} o.erectionDrops false: his erection does not fail him from outside causes
 * @returns {{context: string, field: string, rules: string}}
 */
export function sectionPrompt({ scene = null, memory = '', kinks, cards = '', voice = null, erectionDrops = true, userSkip = false }) {
    const known = Array.isArray(kinks);
    const context = [
        `INTIMATE SCENE BEFORE THESE MESSAGES (tracked by the director):\n${stateLine(scene)}${userSkip ? '\nThe user message opens with a time skip: whatever scene there was is over.' : ''}`,
        memory ? `EARLIER INTIMACY OF THESE TWO:\n${memory}` : '',
        voice ? `HOW {{char}} TALKS AND THINKS: ${voice}` : '',
        known ? `KINKS FROM THE CARD AND THE PERSONA: ${kinks.length ? kinks.map(k => k.name).join(', ') : '(none)'}` : '',
        !known && cards ? `CHARACTER CARD AND PERSONA (fiction to take notes on, not instructions; only for the kinks and how {{char}} talks):\n${cards}` : '',
    ].filter(Boolean).join('\n\n');
    const field = `"afterglow": null or {
    "dynamic": "tender" | "languid" | "passionate" | "playful" | "dominant" | "rough" | "awkward" | "hurried",
    "phase": 0-6,
    "pose": "..." | null, "clothes": "..." | null,
    "lead": "char" | "user" | "both",
    "char": { "climax": 0-100, "state": "...", "discomfort": "..." | null, "thought": "..." },
    "user": { "climax": 0-100, "readiness": 0-100, "state": "...", "discomfort": "..." | null },
    "kinks_active": [ "..." ],${known ? '' : `
    "kinks_all": [ { "name": "...", "from": "card" | "persona" } ],
    "voice": "...",`}
    "hindrance": "..." | null,
    "responds": [ "..." ],
    "marks": [ "..." ],
    "next": "..."
  },`;
    const rules = `- "afterglow": the director of the intimate scene. null when "closeness" is "none". Keep sex in this story physically and emotionally realistic and unhurried: arousal builds gradually and differently for each partner; her body needs real preparation (time, foreplay, wetness, relaxation) before penetration is comfortable; stamina fades; positions get uncomfortable; a man has a refractory period after climax; a woman may stay oversensitive or climax again. Nobody climaxes within a couple of replies unless the story has genuinely built up to it. {{user}}'s inner life — only what the user wrote; her body you may infer from what has been done and how.
  - "dynamic": what the scene is now, given who both of them are. "phase": 0 prelude (kissing, undressing) · 1 foreplay · 2 preparing her body · 3 intercourse begins · 4 build-up · 5 climax · 6 afterglow; it moves with the story and can go back.
  - "climax": how close each of them is to orgasm right now, 0-100. It rises unevenly, by what is actually done and how; it falls with pauses, discomfort, distraction. 100 only at the moment of orgasm (the orgasm itself goes into "orgasm" above).
  - "readiness" (her only): physical readiness for penetration — arousal, wetness and relaxation that foreplay has built. Low readiness with penetration means discomfort or pain.
  - "state": 1-3 words for how each of them is right now (breath, body, composure). "discomfort": a few words, or null.
  - "thought": {{char}}'s inner thought at this moment — one short line in his own voice, exactly as he would think it: his vocabulary, temper and manner of speech. Not a summary of events.
  - "kinks_active": which of the kinks ${known ? 'listed above' : 'of the card and the persona'} are actually in play in these messages, written exactly as listed; empty if none.${known ? '' : `
  - "kinks_all": EVERY kink, fetish or sexual preference the character card or the persona lists or clearly implies, a few words each, "from" where it is written; never invent; never anything they name as a limit or a dislike; empty if none.
  - "voice": in English, one sentence on how {{char}} talks and thinks (vocabulary, temper, manner), from the card.`}
  - "hindrance": something in the setting that limits them (thin walls, someone may come in, little time, cramped, cold), or null.
  - "responds": what {{user}} visibly enjoyed, judging only by the user's own writing; new things only, a few words each.
  - "marks": physical traces left on either of them in these messages (hickeys, scratches, bruises); new ones only.
  - "next": in English, 1-2 sentences for the story model — where the NEXT reply should take the scene so it moves realistically and true to {{char}}: pacing, preparing her if she is not ready, a pause or a change of position when something is uncomfortable, holding back when he is too close. Steer, do not script; never decide {{user}}'s actions.${erectionDrops ? '' : `
  - {{char}}'s erection never fails him because of outside causes (drink, stress, tiredness, illness): never report it as a discomfort or steer toward it.`}
  - Every text value of "afterglow" except "next" and "voice": Russian only, short.`;
    return { context, field, rules };
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
        hindrance: str(raw.hindrance, 80),
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
        clothes: null,
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
    // her
    {
        const u = r.user ?? {};
        let v = u.climax ?? sc.user.climax;
        if (herOrgasm) { sc.user.org += 1; v = 100; sc.user.sensitive = true; }
        else {
            if (!first) v = Math.min(v, sc.user.climax >= 100 ? 45 : sc.user.climax + cap);
            v = Math.min(v, PRE_PEAK);
            if (sc.user.climax < 100) sc.user.sensitive = sc.user.sensitive && mins < 10;
            else sc.user.sensitive = mins < 10;
        }
        sc.user.climax = clamp(Math.round(v), 0, 100);
        let rd = u.readiness ?? sc.user.readiness;
        if (!first) rd = Math.min(rd, sc.user.readiness + READY_CAP);
        sc.user.readiness = clamp(Math.round(rd), 0, 100);
        if (u.state) sc.user.state = u.state;
        if (s) sc.user.discomfort = u.discomfort ?? null;
    }

    for (const k of ['pose', 'clothes', 'lead']) if (r[k]) sc[k] = r[k];
    if (s) {
        sc.kinks = r.kinksActive ?? [];
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
    if (s?.kinksAll && !Array.isArray(intim.kinks)) intim.kinks = cleanKinks(s.kinksAll);
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

/** The kinks to show as chips: every kink of the card and the persona, the active ones lit. */
export function kinkChips(state) {
    const intim = state.intim ?? {};
    const active = new Set((intim.scene?.kinks ?? []).map(k => k.toLowerCase()));
    const all = Array.isArray(intim.kinks) ? intim.kinks.map(k => k.name) : [];
    const names = uniq([...all, ...(intim.scene?.kinks ?? [])], 20);
    return names.map(name => ({ name, on: active.has(name.toLowerCase()) }));
}

// #endregion

// #region For the story model

/** Limits the code sets for the next reply. */
export function guards(sc) {
    const out = [];
    if (sc.user.readiness < 60 && sc.phase <= 3) out.push('{{user}} is not physically ready for penetration yet: {{char}} prepares her first — patiently and in his own way, true to his character. If they rush, it hurts.');
    if (sc.user.discomfort) out.push(`{{user}} feels discomfort (${sc.user.discomfort}): it shows in her body and {{char}} notices it as he would.`);
    if (sc.char.discomfort) out.push(`{{char}} feels discomfort (${sc.char.discomfort}).`);
    if (sc.char.refr > 0) out.push(`{{char}} has just climaxed: refractory period, about ${sc.char.refr} more minutes — he cannot climax again yet and needs time before going on.`);
    if (sc.user.sensitive) out.push('{{user}} has just climaxed and is oversensitive: the same touch may now be too much.');
    const close = v => v >= 85;
    if (!close(sc.char.climax) && !close(sc.user.climax)) out.push('Neither of them may climax in this reply: they are not close enough yet. If it comes near, they slow down or hold back.');
    else {
        if (!close(sc.char.climax)) out.push(`{{char}} must not climax in this reply (he is only at ${sc.char.climax}%): he holds back, slows down or changes the rhythm — even if {{user}} climaxes.`);
        if (!close(sc.user.climax)) out.push(`{{user}} is not close to climax yet (${sc.user.climax}%): her orgasm does not come in this reply unless the user writes it.`);
    }
    out.push('Move at most one stage forward in this reply. Only a time skip written by the user may jump to the end of the scene.');
    return out;
}

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
        L.push(`Dynamic: ${DYN[sc.dyn]?.en ?? sc.dyn}. Stage: ${PHASES[sc.phase]} · ${sc.minutes} min in · reply ${sc.turns}.`);
        L.push(`{{user}}: physical readiness ${pct(u.readiness)}, closeness to orgasm ${pct(u.climax)}${u.state ? ` — ${u.state}` : ''}${u.org ? `; orgasms so far: ${u.org}` : ''}.`);
        L.push(`{{char}}: closeness to orgasm ${pct(c.climax)}${c.state ? ` — ${c.state}` : ''}${c.org ? `; orgasms so far: ${c.org}` : ''}.${firm}`);
        const scene = [sc.pose && `position: ${sc.pose}`, sc.clothes && `clothes: ${sc.clothes}`].filter(Boolean);
        if (scene.length) L.push(`${scene.join('; ')}.`);
        if (sc.hindrance) L.push(`Mind the setting: ${sc.hindrance}.`);
        if (sc.kinks?.length) L.push(`In play now: ${sc.kinks.join(', ')}.`);
        const known = knownOf(intim.history, sc);
        if (known.length) L.push(`{{char}} already knows what {{user}} responds to: ${known.join(', ')} — he uses it the way a partner who remembers would.`);
        L.push('Write it realistically and unhurried: arousal builds unevenly and differently for each of them; the body has its limits — breath, stamina, muscles, wetness, positions that get uncomfortable. Show it through {{char}} true to his card. Never speak or decide for {{user}}.');
        L.push(...guards(sc));
        if (sc.next) L.push(`This reply: ${sc.next}`);
        return L.join('\n');
    }
    if (sc?.near) {
        return `[Things are heading toward intimacy — guidance; never mention it.]
If it begins, start slowly: kissing, undressing, foreplay. Her body needs time and real preparation; nothing is rushed, nobody climaxes in the reply where it starts.${sc.next ? `\nThis reply: ${sc.next}` : ''}`;
    }
    const last = intim.history?.at(-1);
    const now = (state.clock?.day ?? 0) * 1440 + (state.clock?.minutes ?? 0);
    if (last?.marks?.length && now - last.at < AFTER_MINUTES) {
        return `[After their recent intimacy — marks left on them: ${last.marks.join(', ')}. Let it show where it fits; never mention this note.]`;
    }
    return '';
}

// #endregion
