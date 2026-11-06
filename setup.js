/*
 * Setting a chat up without the setup form: from the analysis of the cards and the story opening,
 * with sensible defaults for what they don't say. Pure: no SillyTavern imports, tested in Node.
 */
import { createPregnancy, perimenopause } from './biology.js';
import { extractClock, extractDate, guessAge, guessClock, parseClock, setBabySex } from './engine.js';
import { applyFindings } from './family.js';
import { cleanKinks, ensureIntim } from './intimacy.js';

/** The kinks of the card and the persona and how he talks: read once, for the intimate scenes. */
function intimacyFromCards(state, a) {
    const intim = ensureIntim(state);
    const kinks = cleanKinks(a?.kinks);
    if (kinks) intim.kinks = kinks;
    const bed = a?.in_bed;
    if (kinks && bed && typeof bed === 'object') {
        const clip = (v, n) => (typeof v === 'string' && v.trim() && !/^null$/i.test(v.trim()) ? v.trim().slice(0, n) : null);
        intim.profile = { char: clip(bed.char, 500), user: clip(bed.user, 300) };
    }
    if (typeof a?.voice === 'string' && a.voice.trim()) intim.voice = a.voice.trim().slice(0, 240);
}

export const ADULT_AGE = 18;
const CONTRACEPTIONS = ['none', 'pill', 'ring', 'patch', 'injection', 'implant', 'iud', 'copper_iud'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A whole number in [min, max]; nothing given (null, as the analysis says «unknown», or an empty field) is the fallback. */
const clampInt = (v, min, max, fallback) => {
    if (v === null || v === undefined || v === '') return fallback;
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Children and a pregnancy the cards describe: she and he already know about it. */
function pregnancyFromCards(f, day, u, rng) {
    if (u.children) f.births = Math.max(f.births, Number(u.children) || 0);
    if (u.pregnant && !f.pregnancy) {
        const weeks = clampInt(u.pregnancy_weeks, 4, 41, 8);
        const lmp = day - weeks * 7;
        f.pregnancy = createPregnancy({ lmp, conceptionDay: lmp + 14, twins: false, births: f.births, rng });
        f.pregnancy.knownBy = ['user', 'char'];
        if (u.pregnancy_sex) f.pregnancy.cardSex = u.pregnancy_sex;
    }
}

/**
 * Varicocele and a vasectomy are not ticked by hand: the cards say so, or the scene analysis finds them later
 * (a doctor, the story). A card can add them, never take them away.
 */
function diagnosesFromCards(m, day, c) {
    if (['low', 'normal', 'high'].includes(c.libido)) m.temperament = c.libido;
    if (c.varicocele) m.varicocele = true;
    if (c.vasectomy && (m.vasectomyDay === null || m.vasectomyDay === undefined)) m.vasectomyDay = day - 365;
}

/**
 * A date as she types it: «15.03.2025», «15.3.25», «15/03/2025», «2025-03-15». A day that does not exist is null.
 * @returns {string|null} ISO
 */
export function parseStoryDate(text) {
    const t = String(text ?? '').trim();
    let y, m, d;
    let match = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) [, y, m, d] = match.map(Number);
    else if ((match = t.match(/^(\d{1,2})[./\-\s](\d{1,2})[./\-\s](\d{2}|\d{4})$/))) {
        [, d, m, y] = match.map(Number);
        if (y < 100) y += 2000;
    } else return null;
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
    return date.toISOString().slice(0, 10);
}

/** «2025-03-15» → «15.03.2025», for the typed fields. */
export const ruDate = iso => (ISO_DATE.test(String(iso ?? '')) ? iso.split('-').reverse().join('.') : '');

/** «21:00», «21.00», «2100», «9:05» → minutes of the day; the hour alone («21») is the full hour. */
export function parseTypedClock(text) {
    const t = String(text ?? '').trim().replace(/\s+/g, '');
    const m = t.match(/^(\d{1,2})(?:[:.,]?(\d{2}))?$/);
    if (!m) return null;
    const h = Number(m[1]), min = Number(m[2] ?? 0);
    return h < 24 && min < 60 ? h * 60 + min : null;
}

/**
 * The story's date and time set by hand: the clock shows them from now on, the cycle and everything else stay
 * where they are (only the calendar date moves, and the hour of today).
 * @param {{date?: string, time?: string}} v as typed: «15.03.2025» (or ISO), «21:00»
 * @returns {boolean} something was set
 */
export function setStoryClock(state, v) {
    let done = false;
    const iso = parseStoryDate(v.date);
    // the guessed date left in the field as it was is not a date the story set: it stays a guess, so the first
    // date the story names still re-dates the calendar instead of counting months between them
    const untouched = iso && !state.dateSure && iso === todayIso(state);
    if (iso && !untouched) {
        anchorStartDate(state, iso);
        state.dateSure = true;
        done = true;
    }
    if (untouched) done = true;
    const time = parseTypedClock(v.time);
    if (time !== null) {
        state.clock.minutes = time;
        done = true;
    }
    return done;
}

/** The story's date today as ISO, by its start date; null without one. */
function todayIso(state) {
    if (!ISO_DATE.test(String(state.startDate ?? ''))) return null;
    const d = new Date(`${state.startDate}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + state.clock.day);
    return d.toISOString().slice(0, 10);
}

/** Today in the story is this ISO date: story day 0 moves so that the current day lands on it. */
function anchorStartDate(state, iso) {
    const base = new Date(`${iso}T12:00:00Z`);
    base.setUTCDate(base.getUTCDate() - state.clock.day);
    state.startDate = base.toISOString().slice(0, 10);
}

/**
 * Ages from the analysis or the card text. null when unknown.
 * @returns {{user: number|null, char: number|null}}
 */
export function agesOf(analysis, cards) {
    return {
        user: Number(analysis?.user?.age) || guessAge(cards?.userText) || null,
        char: Number(analysis?.char?.age) || guessAge(cards?.charText) || null,
    };
}

/** Someone is under 18 by the cards: Stork stays off in this chat. */
export function hasMinor(analysis, cards) {
    const ages = agesOf(analysis, cards);
    return [ages.user, ages.char].some(age => age && age < ADULT_AGE);
}

/**
 * Fills a fresh state from the analysis. {{user}} is always the woman, {{char}} the man.
 * @param {object} state Fresh state (mutated)
 * @param {object|null} analysis What analyzeCards() returned, or null when it failed
 * @param {{userName: string, charName: string, userText?: string, charText?: string}} cards
 */
export function setupFromAnalysis(state, analysis, cards, rng = Math.random) {
    const a = analysis ?? {};
    const u = a.user ?? {};
    const c = a.char ?? {};
    const ages = agesOf(a, cards);
    const user = state.people.user;
    const char = state.people.char;
    user.sex = 'female';
    char.sex = 'male';
    user.name = cards.userName || user.name;
    char.name = cards.charName || char.name;
    user.age = ages.user ?? 25;
    char.age = ages.char ?? 28;

    const f = user.female;
    const day = state.clock.day;
    f.cycleLength = clampInt(u.cycle_length, 21, 35, 28);
    f.periodLength = 5;
    // unknown day of the cycle: a random one, as the setup form does
    const cycleDay = clampInt(u.cycle_day, 1, f.cycleLength, 1 + Math.floor(rng() * f.cycleLength));
    f.cycleStart = day - (cycleDay - 1);
    // only a day the cards state is a confirmed cycle: a random one gives way to the story's first period
    f.syncedDay = u.cycle_day ? day : null;
    f.cycleShift = 0;
    f.contraception = CONTRACEPTIONS.includes(u.contraception) ? u.contraception : 'none';
    f.flow = ['light', 'normal', 'heavy'].includes(u.flow) ? u.flow : 'normal';
    f.pmsSevere = !!u.pms_severe;
    f.painfulPeriods = !!u.painful_periods;
    f.pcos = !!u.pcos;
    f.endometriosis = !!u.endometriosis;
    f.smoker = !!u.smoker;
    f.drinker = !!u.drinker;
    f.perimenopause = perimenopause(user.age);
    pregnancyFromCards(f, day, u, rng);

    const m = char.male;
    m.fertility = ['normal', 'low', 'sterile'].includes(c.fertility) ? c.fertility : 'normal';
    m.smoker = !!c.smoker;
    m.drinker = !!c.drinker;
    diagnosesFromCards(m, day, c);

    // the story's own date and time; a guessed date stays "not sure" until the story names one
    const start = a.start ?? {};
    if (ISO_DATE.test(String(start.date ?? ''))) {
        anchorStartDate(state, start.date);
        state.dateSure = start.date_guessed === false;
    }
    // the greeting's own header («**21:00, Ресторан…**», «15.03.2025») wins over a guess: it is written, not inferred
    const opening = cards?.opening ?? '';
    const headDate = extractDate(opening, String(start.date ?? '').slice(0, 4) || null);
    if (headDate) {
        anchorStartDate(state, headDate);
        state.dateSure = true;
    }
    // a clock in the greeting, else the reading's time (exact or its best guess), else a time-of-day word in the greeting
    const time = extractClock(opening) ?? parseClock(start.time) ?? guessClock(opening);
    if (time !== null) state.clock.minutes = time;
    if (a.story?.summary) state.storySummary = a.story.summary;
    // the world of the story: a doctor or a midwife looks after a pregnancy
    if (a.story?.era === 'past' || a.story?.era === 'modern') {
        state.era = a.story.era === 'past' ? 'traditional' : 'modern';
        state.eraSet = true;
    }
    // relatives the cards name go onto the family tree
    applyFindings(state, a.family, 'card');
    intimacyFromCards(state, a);
    if (state.people.user.female.pregnancy?.cardSex) setBabySex(state, state.people.user.female.pregnancy.cardSex, { from: 'card' });
    state.setupDone = true;
    state.autoSetup = true;
    return state;
}

/**
 * The setup form in the window (shown with what the analysis found), read into the state.
 * {{user}} is always the woman, {{char}} always the man.
 * @param {object} v Form values (strings or booleans) plus names and ages: userName, charName, userAge, charAge
 * @param {object|null} analysis What analyzeCards() returned: a pregnancy and children the cards describe
 */
export function applySetupForm(state, v, analysis = null, rng = Math.random) {
    const user = state.people.user;
    const char = state.people.char;
    user.sex = 'female';
    char.sex = 'male';
    user.name = v.userName;
    char.name = v.charName;
    user.age = v.userAge ?? 25;
    char.age = v.charAge ?? 28;

    const f = user.female;
    const day = state.clock.day;
    f.cycleLength = clampInt(v.cycleLength, 21, 35, 28);
    f.periodLength = clampInt(v.periodLength, 3, 7, 5);
    f.cycleStart = day - (clampInt(v.cycleDay, 1, f.cycleLength, 1) - 1);
    f.syncedDay = day;
    f.cycleShift = 0;
    f.irregularity = clampInt(v.irregularity, 0, 7, 0);
    const contraception = CONTRACEPTIONS.includes(v.contraception) ? v.contraception : 'none';
    if (f.contraception === 'pill' && contraception !== 'pill') f.pillStoppedDay = day;
    f.contraception = contraception;
    f.pmsSevere = !!v.pmsSevere;
    f.painfulPeriods = !!v.painfulPeriods;
    f.pcos = !!v.pcos;
    f.endometriosis = !!v.endometriosis;
    f.smoker = !!v.userSmoker;
    f.drinker = !!v.userDrinker;
    f.flow = ['light', 'normal', 'heavy'].includes(v.flow) ? v.flow : 'normal';
    f.perimenopause = perimenopause(user.age);
    pregnancyFromCards(f, day, analysis?.user ?? {}, rng);

    const m = char.male;
    m.fertility = ['normal', 'low', 'sterile'].includes(v.fertility) ? v.fertility : 'normal';
    m.smoker = !!v.smoker;
    m.drinker = !!v.drinker;
    diagnosesFromCards(m, day, analysis?.char ?? {});

    const startIso = parseStoryDate(v.startDate);
    if (startIso) anchorStartDate(state, startIso);
    state.clock.minutes = parseTypedClock(v.time) ?? state.clock.minutes;
    state.storyMode = v.storyMode ?? state.storyMode ?? 'realistic';
    // the world of the story: from her choice in the form, otherwise from the cards
    if (v.era === 'traditional' || v.era === 'modern') {
        state.era = v.era;
        state.eraSet = true;
    } else if (analysis?.story?.era === 'past' || analysis?.story?.era === 'modern') {
        state.era = analysis.story.era === 'past' ? 'traditional' : 'modern';
        state.eraSet = true;
    }
    if (analysis?.story?.summary) state.storySummary = analysis.story.summary;
    applyFindings(state, analysis?.family, 'card');
    if (analysis) intimacyFromCards(state, analysis);
    state.setupDone = true;
    state.chatOff = false;
    return state;
}

// #region Quick edits from the pencil and the calendar

const CYCLE_EDITABLE = f => !f.pregnancy && !f.postpartum;

/**
 * Applies the person editor. Only the fields present are changed.
 * @param {'user'|'char'} key
 * @param {object} v Values from the form (strings or booleans)
 */
export function applyPersonEdit(state, key, v) {
    const person = state.people[key];
    if (!person) return state;
    const day = state.clock.day;
    if (v.age !== undefined && v.age !== '') person.age = clampInt(v.age, ADULT_AGE, 90, person.age);
    if (key === 'user') {
        const f = person.female;
        if (v.cycleLength !== undefined) f.cycleLength = clampInt(v.cycleLength, 21, 35, f.cycleLength);
        if (v.periodLength !== undefined) f.periodLength = clampInt(v.periodLength, 3, 7, f.periodLength);
        if (v.irregularity !== undefined) f.irregularity = clampInt(v.irregularity, 0, 7, f.irregularity);
        if (v.cycleDay !== undefined && v.cycleDay !== '' && CYCLE_EDITABLE(f)) {
            const cycleDay = clampInt(v.cycleDay, 1, f.cycleLength, 1);
            f.cycleStart = day - (cycleDay - 1);
    f.syncedDay = day;
            f.cycleShift = 0;
            f.rolledCycle = null;
            f.lateNoticed = [];
        }
        if (v.contraception !== undefined && CONTRACEPTIONS.includes(v.contraception)) {
            if (f.contraception === 'pill' && v.contraception !== 'pill') f.pillStoppedDay = day;
            f.contraception = v.contraception;
        }
        for (const k of ['pmsSevere', 'painfulPeriods', 'pcos', 'endometriosis', 'smoker', 'drinker']) if (v[k] !== undefined) f[k] = !!v[k];
        f.perimenopause = perimenopause(person.age);
    } else {
        const m = person.male;
        if (v.fertility !== undefined && ['normal', 'low', 'sterile'].includes(v.fertility)) m.fertility = v.fertility;
        if (['low', 'normal', 'high'].includes(v.temperament)) m.temperament = v.temperament;
        for (const k of ['smoker', 'drinker']) if (v[k] !== undefined) m[k] = !!v[k];
    }
    return state;
}

/** «Here her period started» from the calendar: the cycle restarts that day (today or earlier, not while pregnant). */
export function setPeriodStart(state, storyDay) {
    const f = state.people.user?.female;
    if (!f || !CYCLE_EDITABLE(f) || storyDay > state.clock.day || state.clock.day - storyDay > 60) return false;
    f.cycleStart = storyDay;
    f.syncedDay = state.clock.day;
    f.cycleShift = 0;
    f.rolledCycle = null;
    f.lateNoticed = [];
    return true;
}

// #endregion
