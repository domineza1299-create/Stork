/*
 * Setting a chat up without the setup form: from the analysis of the cards and the story opening,
 * with sensible defaults for what they don't say. Pure: no SillyTavern imports, tested in Node.
 */
import { createPregnancy, perimenopause } from './biology.js';
import { guessAge, parseClock } from './engine.js';

export const ADULT_AGE = 18;
const CONTRACEPTIONS = ['none', 'pill', 'ring', 'patch', 'injection', 'implant', 'iud', 'copper_iud'];
const clampInt = (v, min, max, fallback) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

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
    f.cycleShift = 0;
    f.contraception = CONTRACEPTIONS.includes(u.contraception) ? u.contraception : 'none';
    f.flow = ['light', 'normal', 'heavy'].includes(u.flow) ? u.flow : 'normal';
    f.pmsSevere = !!u.pms_severe;
    f.painfulPeriods = !!u.painful_periods;
    f.pcos = !!u.pcos;
    f.endometriosis = !!u.endometriosis;
    f.perimenopause = perimenopause(user.age);
    if (u.children) f.births = Math.max(f.births, Number(u.children) || 0);
    if (u.pregnant && !f.pregnancy) {
        const weeks = clampInt(u.pregnancy_weeks, 4, 41, 8);
        const lmp = day - weeks * 7;
        f.pregnancy = createPregnancy({ lmp, conceptionDay: lmp + 14, twins: false, births: f.births, rng });
        f.pregnancy.knownBy = ['user', 'char'];
    }

    const m = char.male;
    m.fertility = ['normal', 'low', 'sterile'].includes(c.fertility) ? c.fertility : 'normal';
    m.smoker = !!c.smoker;
    m.drinker = !!c.drinker;
    m.overweight = !!c.overweight;
    m.varicocele = !!c.varicocele;
    m.vasectomyDay = c.vasectomy ? day - 365 : null;

    // the story's own date and time; a guessed date stays "not sure" until the story names one
    const start = a.start ?? {};
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(start.date ?? ''))) {
        const base = new Date(`${start.date}T12:00:00Z`);
        base.setUTCDate(base.getUTCDate() - day);
        state.startDate = base.toISOString().slice(0, 10);
        state.dateSure = start.date_guessed === false;
    }
    const time = parseClock(start.time);
    if (time !== null) state.clock.minutes = time;
    if (a.story?.summary) state.storySummary = a.story.summary;
    state.setupDone = true;
    state.autoSetup = true;
    return state;
}
