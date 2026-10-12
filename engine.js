/*
 * Stork engine: the story state, time, events from the model and the status text.
 * Pure functions over a plain JSON state, so it is saved with chat messages and tested in Node.
 */
import {
    ACT_PROTECTION, createPregnancy, cycleInfo, cycleReturnDay, DOCTOR_VISITS, EMERGENCY_PILL_FACTOR, EMERGENCY_PILL_WINDOW_DAYS, falseContractionsToday, FEMALE_CONTRACEPTION,
    femaleConditionFactor, FEMALE_CONDITIONS, femaleState, laborChance, laborProgress, LIFESTYLE, maleState, pillState, POSTPARTUM_RECOVERY_DAYS, pregnancyInfo,
    rollCondomBreak, rollConception, rollCycles, rollTest, startLabor, stressDelay, ultrasoundShowsSex,
} from './biology.js';

export const MINUTES_PER_DAY = 1440;
const MAX_LOG = 200;
const MAX_ROLLS = 100;

// #region State

export function createPerson(key, { name = '', sex = 'female', age = 25 } = {}) {
    return {
        key,
        name,
        sex,
        age,
        female: {
            cycleLength: 28,
            periodLength: 5,
            irregularity: 0,
            cycleStart: 0,
            cycleShift: 0,
            pmsSevere: false,
            painfulPeriods: false,
            contraception: 'none',
            pillMissedDay: null,
            pillStoppedDay: null,
            rolledCycle: null,
            delayedCycle: null,
            lateNoticed: [],
            pregnancy: null,
            postpartum: null,
            births: 0,
            flow: 'normal',
            pcos: false,
            endometriosis: false,
            perimenopause: false,
        },
        male: {
            fertility: 'normal',
            smoker: false,
            drinker: false,
            overweight: false,
            varicocele: false,
            couvadeSeed: Math.floor(Math.random() * 1000),
            vasectomyDay: null,
            lifestyle: [],
            ejaculations: [],
            // absolute story minutes of his orgasms: the reserve recovers by hours, not by days
            orgasms: [],
            lastOrgasmMinute: null,
        },
    };
}

/**
 * A fresh story state.
 * @param {object} options
 * @param {string} [options.startDate] ISO date of story day 0
 */
export function createState({ userName = '', charName = '', startDate = null, startMinutes = 9 * 60 } = {}) {
    return {
        version: 1,
        setupDone: false,
        clock: { day: 0, minutes: startMinutes },
        startDate,
        people: {
            user: createPerson('user', { name: userName, sex: 'female' }),
            char: createPerson('char', { name: charName, sex: 'male' }),
        },
        acts: [],
        rolls: [],
        log: [],
        pending: [],
        // how each person is right now by the story (from the scene analysis), fading over half a day
        live: {},
        // true once the story itself named a date: before that the calendar date is only a guess
        dateSure: false,
    };
}

/** Older saved states: fill in what newer versions expect. */
export function upgradeState(state) {
    state.live ??= {};
    state.dateSure ??= false;
    for (const person of Object.values(state.people ?? {})) {
        const m = person.male;
        if (m && !Array.isArray(m.orgasms)) m.orgasms = m.lastOrgasmMinute !== null && m.lastOrgasmMinute !== undefined ? [m.lastOrgasmMinute] : [];
    }
    return state;
}

export const cloneState = state => JSON.parse(JSON.stringify(state));
export const absMinute = clock => clock.day * MINUTES_PER_DAY + clock.minutes;

const otherKey = key => (key === 'user' ? 'char' : 'user');

/** The male partner for a woman, if the other person is male. */
function partnerOf(state, key) {
    const other = state.people[otherKey(key)];
    return other.sex === 'male' ? other : null;
}

function note(state, person, text, { model = true, kind = 'event' } = {}) {
    const entry = { day: state.clock.day, minutes: state.clock.minutes, who: person?.key ?? null, text, kind };
    state.log.push(entry);
    if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
    if (model) state.pending.push({ who: person?.key ?? null, text });
}

function roll(state, entry) {
    state.rolls.push({ day: state.clock.day, ...entry });
    if (state.rolls.length > MAX_ROLLS) state.rolls.splice(0, state.rolls.length - MAX_ROLLS);
}

// #endregion

// #region Daily processing

function processFemaleDay(state, person, rng) {
    const f = person.female;
    const day = state.clock.day;
    const name = person.name || 'Она';

    if (f.postpartum) {
        if (day >= f.postpartum.cycleReturnDay) {
            f.postpartum = null;
            f.cycleStart = day;
            f.cycleShift = 0;
            note(state, person, `${name}: впервые после родов начались месячные`);
        }
        return;
    }

    if (f.pregnancy) {
        processPregnancyDay(state, person, rng);
        return;
    }

    // Acts saved before the dice were thrown at the act itself: they get the old single roll
    // at the end of ovulation day, so a chat in progress loses nothing
    const ovulated = day - 1;
    const pill = pillState(f, ovulated);
    if (cycleInfo(f, ovulated).relative === 0 && f.rolledCycle !== f.cycleStart && !pill.suppressed) {
        const legacy = state.acts.filter(a => a.woman === person.key && a.rolled === undefined && a.day >= ovulated - 5 && a.day <= ovulated);
        if (legacy.length) {
            f.rolledCycle = f.cycleStart;
            for (const act of legacy) act.rolled = true;
            if (throwDice(state, person, legacy, ovulated, pill, rng)) return;
        }
    }

    if (rollCycles(f, day, rng)) {
        // Irregular after stopping the pill
        if (pillState(f, day).recovering) f.cycleShift += Math.round((rng() * 2 - 1) * 4);
        f.lateNoticed = [];
        const withdrawalBleed = ['pill', 'ring', 'patch'].includes(f.contraception);
        note(state, person, withdrawalBleed ? `${name}: началось кровотечение отмены (перерыв в контрацепции)` : `${name}: начались месячные`);
    }
}

function processPregnancyDay(state, person, rng) {
    const f = person.female;
    const p = f.pregnancy;
    const day = state.clock.day;
    const name = person.name || 'Она';
    const info = pregnancyInfo(p, day);
    const knows = p.knownBy.includes(person.key);

    if (p.spottingDay === day) note(state, person, `${name}: лёгкие мажущие выделения не в срок, она не придаёт им значения`);

    // Missed period: she notices on day 1, 3 and 7 of the delay
    const expected = p.lmp + f.cycleLength + (f.cycleShift ?? 0);
    const late = day - expected + 1;
    if (!knows && [1, 3, 7].includes(late) && !f.lateNoticed.includes(late)) {
        f.lateNoticed.push(late);
        note(state, person, `${name}: задержка месячных ${late} ${late === 1 ? 'день' : 'дня'}${late === 7 ? ', это уже тревожит' : ''}`);
    }

    if (day === p.kicksDay) note(state, person, knows ? `${name}: впервые почувствовала шевеления малыша` : `${name}: странное трепетание в животе`);

    for (const visit of DOCTOR_VISITS) {
        if (knows && info.week >= visit.week && !p.visitsDone.includes(visit.week)) {
            p.visitsDone.push(visit.week);
            note(state, person, `${name}: пора к врачу, ${visit.label}`, { kind: 'doctor' });
        }
    }

    if (!p.labor && falseContractionsToday(info.week, rng)) note(state, person, `${name}: тренировочные схватки, живот твердеет и отпускает`);

    if (!p.labor && rng() < laborChance(info.week)) {
        p.labor = startLabor(absMinute(state.clock), f.births, rng);
        note(state, person, `${name}: начались схватки, роды начинаются`, { kind: 'labor' });
    }
}

/** Labor moves with minutes, not days. */
function processLabor(state, person, rng) {
    const f = person.female;
    const p = f.pregnancy;
    if (!p?.labor) return;
    const name = person.name || 'Она';
    const progress = laborProgress(p.labor, absMinute(state.clock));
    if (progress.waterBroken && !p.labor.waterBroken) {
        p.labor.waterBroken = true;
        note(state, person, `${name}: отошли воды`, { kind: 'labor' });
    }
    if (progress.stage !== p.labor.stage) {
        p.labor.stage = progress.stage;
        if (progress.born) {
            const babies = p.sexes.map(s => s).join(' и ');
            note(state, person, `${name}: роды завершились, ${p.babies > 1 ? 'родились двойняшки' : 'родился малыш'} (${babies})`, { kind: 'labor' });
            f.births += 1;
            f.postpartum = { birthDay: state.clock.day, breastfeeding: true, cycleReturnDay: cycleReturnDay(state.clock.day, true, rng) };
            f.pregnancy = null;
        } else {
            note(state, person, `${name}: ${progress.label}, схватки каждые ${progress.intervalMinutes} мин`, { kind: 'labor' });
        }
    }
}

/**
 * Moves story time forward and processes every day passed.
 * @param {number} minutes Minutes to add (negative is ignored)
 */
export function advanceTime(state, minutes, rng = Math.random) {
    let left = Math.max(0, Math.round(minutes));
    while (left > 0) {
        const step = Math.min(left, MINUTES_PER_DAY - state.clock.minutes);
        state.clock.minutes += step;
        left -= step;
        for (const person of Object.values(state.people)) if (person.sex === 'female') processLabor(state, person, rng);
        if (state.clock.minutes >= MINUTES_PER_DAY) {
            state.clock.minutes -= MINUTES_PER_DAY;
            state.clock.day += 1;
            for (const person of Object.values(state.people)) if (person.sex === 'female') processFemaleDay(state, person, rng);
        }
    }
}

// #endregion

// #region Conception: the dice are thrown at the act

/**
 * One roll for these acts against the ovulation of this cycle. A success starts a hidden pregnancy dated by that
 * ovulation: sperm lives up to 5 days, so an act before it can still lead to one.
 * @returns {boolean} conceived
 */
function throwDice(state, person, acts, ovulated, pill, rng) {
    const f = person.female;
    const partner = partnerOf(state, person.key);
    if (!partner) return false;
    const result = rollConception({
        acts,
        ovulationAbsoluteDay: ovulated,
        femaleAge: person.age,
        femaleContraception: pill.effective,
        femaleFactor: femaleConditionFactor(f),
        male: partner.male,
        maleAge: partner.age,
        storyMode: state.storyMode ?? 'realistic',
        rng,
    });
    for (const act of acts) act.conceived = result.conceived;
    roll(state, { who: person.key, kind: 'conception', chance: result.chance, result: result.conceived, forced: result.forced });
    note(state, person, `Бросок на зачатие: ${Math.round(result.chance * 100)}%, ${result.conceived ? 'получилось' : 'не получилось'}`, { model: false, kind: 'roll' });
    if (result.conceived) f.pregnancy = createPregnancy({ lmp: f.cycleStart, conceptionDay: ovulated, twins: result.twins, births: f.births, rng });
    return result.conceived;
}

/** The dice for one act, right when it happens: only inside the fertile window of this cycle. */
function rollAct(state, act, rng) {
    const woman = state.people[act.woman];
    const f = woman?.female;
    act.rolled = true;
    if (!f || f.pregnancy || f.postpartum) return;
    const pill = pillState(f, act.day);
    // hormonal contraception used correctly: no ovulation, nothing to roll
    if (pill.suppressed) return;
    const ovulated = f.cycleStart + cycleInfo(f, act.day).ovulation - 1;
    if (act.day < ovulated - 5 || act.day > ovulated) return;
    throwDice(state, woman, [act], ovulated, pill, rng);
}

// #endregion

// #region Events from the story

/** One orgasm of his, once per moment (intimacy and orgasm:char in the same reply are the same one). */
function markOrgasm(m, day, minute) {
    m.orgasms ??= [];
    if (m.lastOrgasmMinute === minute && m.orgasms.includes(minute)) return;
    m.ejaculations.push(day);
    m.orgasms.push(minute);
    if (m.orgasms.length > 30) m.orgasms.splice(0, m.orgasms.length - 30);
    m.lastOrgasmMinute = minute;
}

/**
 * Applies one event from the model's tag or a button.
 * @param {{type: string, who?: string, protection?: string, force?: string}} event
 */
export function applyEvent(state, event, rng = Math.random) {
    const day = state.clock.day;
    const who = event.who && state.people[event.who] ? state.people[event.who] : null;

    switch (event.type) {
        case 'intimacy': {
            const woman = Object.values(state.people).find(p => p.sex === 'female');
            const man = Object.values(state.people).find(p => p.sex === 'male');
            const protection = ACT_PROTECTION[event.protection] ? event.protection : 'none';
            const act = { day, minute: absMinute(state.clock), protection, woman: woman?.key ?? null, force: event.force ?? null, condomBroke: false };
            if (protection === 'condom' && (event.broke || rollCondomBreak(rng))) {
                act.condomBroke = true;
                note(state, man ?? woman, 'презерватив порвался');
            }
            note(state, null, `близость (${ACT_PROTECTION[protection].label})`, { model: false, kind: 'intimacy' });
            if (man) markOrgasm(man.male, day, absMinute(state.clock));
            if (woman && man) {
                state.acts.push(act);
                rollAct(state, act, rng);
            }
            break;
        }
        case 'condom_broke': {
            const act = state.acts.at(-1);
            if (act && act.day === day && !act.condomBroke) {
                act.condomBroke = true;
                note(state, null, 'презерватив порвался');
                // found out after the dice: the act is thrown again, now without protection
                if (act.rolled) rollAct(state, act, rng);
            }
            break;
        }
        case 'doctor': {
            const woman = Object.values(state.people).find(p => p.sex === 'female');
            const p = woman?.female.pregnancy;
            if (p && !p.knownBy.includes(woman.key)) p.knownBy.push(woman.key);
            note(state, woman, 'визит к врачу', { model: false });
            break;
        }
        case 'orgasm':
            if (who?.sex === 'male') markOrgasm(who.male, day, absMinute(state.clock));
            break;
        case 'emergency_pill': {
            const woman = who ?? Object.values(state.people).find(p => p.sex === 'female');
            for (const act of state.acts) if (act.woman === woman?.key && day - act.day <= EMERGENCY_PILL_WINDOW_DAYS) act.emergencyPillDay = day;
            // the dice already said yes, but ovulation has not come yet: the pill can still stop it
            const p = woman?.female?.pregnancy;
            const lucky = state.acts.some(a => a.woman === woman?.key && a.conceived && a.force !== 'yes' && day - a.day <= EMERGENCY_PILL_WINDOW_DAYS);
            if (p && !p.knownBy.length && day <= p.conceptionDay && lucky) {
                const stopped = rng() >= EMERGENCY_PILL_FACTOR;
                roll(state, { who: woman.key, kind: 'emergency_pill', result: stopped });
                note(state, woman, `Экстренная таблетка: ${stopped ? 'остановила овуляцию' : 'не сработала'}`, { model: false, kind: 'roll' });
                if (stopped) woman.female.pregnancy = null;
            }
            note(state, woman, 'приняла экстренную таблетку', { model: false });
            break;
        }
        case 'pill_missed':
            if (who?.sex === 'female') {
                who.female.pillMissedDay = day;
                note(state, who, 'пропустила таблетку', { model: false });
            }
            break;
        case 'test': {
            const woman = who?.sex === 'female' ? who : Object.values(state.people).find(p => p.sex === 'female');
            if (!woman) break;
            const p = woman.female.pregnancy;
            const daysAfterOvulation = p ? day - p.conceptionDay : null;
            const positive = rollTest(!!p, daysAfterOvulation, rng);
            roll(state, { who: woman.key, kind: 'test', result: positive });
            if (positive && p && !p.knownBy.includes(woman.key)) p.knownBy.push(woman.key);
            note(state, woman, `${woman.name || 'Она'} сделала тест на беременность: ${positive ? 'две полоски' : 'одна полоска'}`);
            break;
        }
        case 'ultrasound': {
            const woman = who?.sex === 'female' ? who : Object.values(state.people).find(p => p.sex === 'female');
            const p = woman?.female.pregnancy;
            if (!p) break;
            if (!p.knownBy.includes(woman.key)) p.knownBy.push(woman.key);
            const week = pregnancyInfo(p, day).week;
            const seen = !p.sexKnown && ultrasoundShowsSex(week, rng);
            if (seen) p.sexKnown = true;
            note(state, woman, `УЗИ: ${p.babies > 1 ? 'двойня' : 'один малыш'}, срок ${week} нед.${p.sexKnown ? `, пол: ${p.sexes.join(' и ')}` : ', пол пока не виден'}`);
            break;
        }
        case 'told': {
            // he learns about her pregnancy: she tells him, he sees the test, the doctor says it with him there
            const woman = Object.values(state.people).find(p => p.sex === 'female');
            const p = woman?.female.pregnancy;
            const learner = who ?? (woman ? partnerOf(state, woman.key) : null);
            // only once she knows herself: he cannot learn what nobody knows yet
            if (!p || !learner || learner === woman || p.knownBy.includes(learner.key) || !p.knownBy.includes(woman.key)) break;
            p.knownBy.push(learner.key);
            note(state, learner, `${learner.name || 'Он'} узнал о беременности`);
            break;
        }
        case 'stress':
        case 'illness':
            if (who?.sex === 'female' && !who.female.pregnancy && !who.female.postpartum) {
                const delay = stressDelay(who.female, day, rng);
                if (delay) note(state, who, `${event.type === 'stress' ? 'стресс' : 'болезнь'} сдвинул овуляцию на ${delay} дн.`, { model: false });
            }
            if (who?.sex === 'male') who.male.lifestyle.push({ day, type: event.type === 'illness' ? 'fever' : 'stress' });
            break;
        default:
            if (LIFESTYLE[event.type] && who?.sex === 'male') who.male.lifestyle.push({ day, type: event.type });
    }
}

// #endregion

// #region Model tag

/** The instruction appended to the status: how to report what happened. */
export const TAG_INSTRUCTION = 'At the very end of the reply add one hidden tracker line (the reader never sees it): '
    + '<stork t="story time that passed in this reply: +15m, +2h, +1d or 0" ev="events, comma-separated, or empty"/>. '
    + 'Events: intimacy:none|condom|withdrawal (intercourse and protection), orgasm:user|char, test:user|char (pregnancy test), '
    + 'condom_broke, doctor, ultrasound, told:char (he learned she is pregnant), stress:user|char, illness:user|char (only a sickness with fever — never an injury or a bruise), '
    + 'alcohol:user|char, smoking:user|char, cannabis:user|char, sauna:user|char, no_sleep:user|char, pill_missed:user|char, emergency_pill:user|char. '
    + 'If he did not finish inside, write intimacy:withdrawal. Events that happened after the time skip of this reply (a week later they made love) go into ev_end="..." instead of ev. '
    + 'Only what actually happened in this reply. Never mention or explain the line.';

const TAG_RE = /<stork\b([^>]*?)\/?>(?:\s*<\/stork>)?/gi;

/** Parses a duration like +15m, +2h, +1d, +1w. */
export function parseDuration(text) {
    const match = String(text ?? '').trim().match(/^\+?(\d+(?:[.,]\d+)?)\s*(m|min|h|d|w)?$/i);
    if (!match) return 0;
    const value = Number(match[1].replace(',', '.'));
    const unit = (match[2] ?? 'm').toLowerCase();
    return Math.round(value * ({ m: 1, min: 1, h: 60, d: 1440, w: 10080 }[unit] ?? 1));
}

/**
 * Finds the tracker tag in a reply.
 * @returns {{found: boolean, minutes: number, events: object[]}}
 */
export function parseTag(text) {
    const matches = [...String(text ?? '').matchAll(TAG_RE)];
    if (!matches.length) return { found: false, minutes: 0, events: [], eventsEnd: [], clock: null };
    const attrs = Object.fromEntries([...matches.at(-1)[1].matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map(m => [m[1], m[2]]));
    return { found: true, minutes: parseDuration(attrs.t), events: parseEvents(attrs.ev), eventsEnd: parseEvents(attrs.ev_end), clock: parseClock(attrs.clock) };
}

function parseEvents(text) {
    const events = String(text ?? '').split(',').map(s => s.trim()).filter(Boolean).map(token => {
        const [type, arg] = token.split(':').map(s => s.trim());
        if (type === 'intimacy') return { type, protection: arg || 'none' };
        return { type, who: arg || null };
    });
    // a broken condom belongs to the act of the same reply: the dice for it are thrown with the break known
    const act = events.find(e => e.type === 'intimacy');
    if (act?.protection === 'condom' && events.some(e => e.type === 'condom_broke')) {
        act.broke = true;
        return events.filter(e => e.type !== 'condom_broke');
    }
    return events;
}

export const stripTag = text => String(text ?? '').replace(TAG_RE, '').replace(/\n{3,}$/g, '\n\n').trimEnd();

const TIME_HINTS = [
    [/на следующ(ее|ий|ей) (утро|день)|наутро|следующим утром|the next (morning|day)/i, 1440],
    [/через (неделю|7 дней)|спустя неделю|a week later/i, 10080],
    [/через (месяц)|спустя месяц|a month later/i, 43200],
    [/через (пару|несколько) дней|спустя (пару|несколько) дней|a few days later/i, 2880],
    [/(вечером|к вечеру|later that evening)/i, 240],
];
const INTIMACY_HINT = /занялись любовью|переспали|made love|slept together|кончил|секс|близост/i;

/** Fallback when the model forgot the tag: guesses to offer the user, never applied silently. */
export function detectHints(text) {
    let minutes = 0;
    for (const [re, value] of TIME_HINTS) if (re.test(text)) minutes = Math.max(minutes, value);
    return { minutes, intimacy: INTIMACY_HINT.test(String(text ?? '')) };
}

// #endregion

// #region Scene analysis

export const SCENE_LIFESTYLE_TYPES = ['alcohol', 'smoking', 'cannabis', 'steroids', 'sauna', 'illness', 'stress', 'no_sleep'];
const LIFESTYLE_TYPES = SCENE_LIFESTYLE_TYPES;

/**
 * Turns the analysis into Stork's tag, so replies read by a model and replies with a tag go the same way.
 * @returns {string}
 */
export function sceneToTag(scene) {
    const events = [];
    // the closeness came after the time skip («a week later they made love»): it happens on the new day
    const late = [];
    const intimacy = scene?.intimacy;
    const closeness = intimacy?.after_time_skip === true ? late : events;
    if (intimacy) {
        let protection = intimacy.protection === 'condom' ? 'condom' : 'none';
        if (protection === 'none' && intimacy.finished_inside === false) protection = 'withdrawal';
        closeness.push(`intimacy:${protection}`);
        if (protection === 'condom' && intimacy.condom_broke) closeness.push('condom_broke');
    }
    for (const who of scene?.orgasm ?? []) if (who === 'user' || who === 'char') closeness.push(`orgasm:${who}`);
    for (const item of scene?.lifestyle ?? []) {
        // a bruise, a cut or a hangover is not an illness: only a sickness with fever counts as one
        if (item?.type === 'illness' && item.fever !== true) continue;
        if (LIFESTYLE_TYPES.includes(item?.type) && (item.who === 'user' || item.who === 'char')) events.push(`${item.type}:${item.who}`);
    }
    if (scene?.pregnancy_test) events.push('test:user');
    if (scene?.doctor_visit) events.push('doctor');
    if (scene?.ultrasound) events.push('ultrasound');
    // after the test, the doctor and the ultrasound: she learns first, then he can
    if (scene?.partner_learns_pregnancy === true) events.push('told:char');
    if (scene?.missed_pill) events.push('pill_missed:user');
    if (scene?.emergency_pill) events.push('emergency_pill:user');
    const minutes = Math.max(0, Math.round(Number(scene?.minutes) || 0));
    const clock = parseClock(scene?.clock);
    const clockAttr = clock === null ? '' : ` clock="${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}"`;
    return `<stork t="+${minutes}m"${clockAttr} ev="${events.join(',')}"${late.length ? ` ev_end="${late.join(',')}"` : ''}/>`;
}

// #endregion

// #region Cards

/**
 * Role-play text without markup: image-generation tags, HTML and markdown images only waste tokens
 * and confuse the reader model.
 */
export function cleanRpText(text) {
    return String(text ?? '')
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
        .replace(/<[^>]*>/g, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Reads "22:40" style time into minutes of the day, or null. */
export function parseClock(text) {
    const match = String(text ?? '').match(/^(\d{1,2})[:.](\d{2})$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}


const AGE_PATTERNS = [
    /(?:возраст|age)\s*[:=\-–]?\s*(\d{1,2})\b/i,
    // \b does not see Cyrillic letters: look around with Unicode classes instead
    /(?<!\d)(\d{1,2})\s*-?\s*(?:лет|года|год)(?![\p{L}])/iu,
    /\b(\d{1,2})\s*(?:-|\s)?(?:years?[\s-]*old|y\.?\s?o\.?)\b/i,
];

/** Finds an age written in a card, or null. */
export function guessAge(text) {
    for (const pattern of AGE_PATTERNS) {
        const match = String(text ?? '').match(pattern);
        const age = match ? Number(match[1]) : NaN;
        if (age >= 10 && age <= 99) return age;
    }
    return null;
}

// #endregion

// #region Status for the model

// Softer words for strict providers (the status is in English; values from the story may be Russian)
const NEUTRAL = [[/\bsex(ual)?\b/gi, 'intimacy'], [/arous\w*/gi, 'desire'], [/orgasm\w*/gi, 'climax'], [/секс\w*/gi, 'близость'], [/оргазм\w*/gi, 'кульминация']];

const PHASE_EN = { menstruation: 'her period', follicular: 'follicular phase', ovulation: 'ovulation', luteal: 'luteal phase', pms: 'PMS' };
const BELLY_EN = { 'не видно': 'not showing yet', 'слегка округлился': 'slightly rounded', 'заметен': 'showing', 'большой': 'big', 'очень большой': 'very big' };
const CONTRACEPTION_EN = {
    none: 'none', pill: 'the pill', pill_missed: 'the pill, a missed dose this week', ring: 'vaginal ring', patch: 'patch', injection: 'injection',
    implant: 'implant', iud: 'hormonal IUD', copper_iud: 'copper IUD',
};
const level = v => (v > 0.8 ? 'high' : v > 0.55 ? 'normal' : 'low');
const days = n => `${n} day${n === 1 ? '' : 's'}`;

/** What the scene analysis saw in the story about this person (in the story's language): the story keeps it. */
function storyLine(state, person) {
    const live = liveNow(state, person.key);
    return live.note || live.mood ? ` As the story shows now: ${[live.mood, live.note].filter(Boolean).join(' — ')}` : '';
}

function femaleLine(state, person, detailed) {
    return `${femaleLineRaw(state, person, detailed)}${storyLine(state, person)}`;
}

function femaleLineRaw(state, person, detailed) {
    const f = person.female;
    const day = state.clock.day;
    const name = person.name || 'She';
    const age = person.age ? ` (${person.age})` : '';
    if (f.postpartum) {
        const since = day - f.postpartum.birthDay;
        return `${name}${age}: ${days(since)} after giving birth${since < POSTPARTUM_RECOVERY_DAYS ? ', still recovering, needs rest' : ''}${f.postpartum.breastfeeding ? ', breastfeeding' : ''}.`;
    }
    if (f.pregnancy) {
        const p = f.pregnancy;
        const info = pregnancyInfo(p, day);
        const knows = p.knownBy.includes(person.key);
        if (p.labor) {
            const progress = laborProgress(p.labor, absMinute(state.clock));
            return `${name}${age}: IN LABOR — ${progress.stage === 'pushing' ? 'pushing' : progress.stage === 'active' ? 'active contractions' : 'early contractions'}, every ${progress.intervalMinutes} min${progress.waterBroken ? ', her water has broken' : ''}. This comes first in the scene.`;
        }
        if (!knows) {
            const hints = info.week >= 5 ? info.symptoms.slice(0, 2).join(', ') : 'no signs yet';
            return `${name}${age}: pregnant (${info.week} weeks) but does NOT know it yet. Only hints may show: ${hints}. Never name the cause.`;
        }
        const parts = [`${name}${age}: pregnant, ${info.week} weeks (trimester ${info.trimester}), ${days(Math.max(0, info.daysToDue))} to the due date. Belly: ${BELLY_EN[info.belly] ?? info.belly}.`];
        const partner = partnerOf(state, person.key);
        if (partner && !p.knownBy.includes(partner.key)) parts.push(`${partner.name || 'He'} does not know about the pregnancy yet.`);
        if (detailed) {
            if (info.symptoms.length) parts.push(`Feels: ${info.symptoms.join(', ')}.`);
            parts.push(`The baby is the size of ${info.baby.compare}${info.kicksFelt ? ', kicks' : ''}.`);
            parts.push(`Craves ${p.cravings.join(' and ')}; can't stand ${p.aversions.join(', ')}.`);
            if (p.babies > 1) parts.push('Twins.');
            if (p.sexKnown) parts.push(`Sex: ${p.sexes.join(' and ')}.`);
        }
        return parts.join(' ');
    }
    const st = femaleState(f, day);
    const pill = pillState(f, day);
    const phase = pill.suppressed && ['ovulation', 'follicular'].includes(st.phase) ? 'hormonal contraception, no ovulation' : PHASE_EN[st.phase];
    const parts = [`${name}${age}: cycle day ${st.cycleDay} of ${st.length}, ${phase}.`];
    if (st.late) parts.push(`Her period is ${days(st.cycleDay - st.length)} late.`);
    if (detailed) {
        parts.push(`Feels: ${st.symptoms.join(', ')}.`);
        const live = liveNow(state, person.key);
        const libido = withLive(st.libido, live.libido), energy = withLive(st.energy, live.energy);
        parts.push(`Desire ${level(libido)}, energy ${level(energy)}.`);
        if (st.fertile && !pill.suppressed) parts.push('Fertile days now.');
        const conditions = Object.entries(FEMALE_CONDITIONS).filter(([key]) => f[key]).map(([, c]) => `${c.label} (${c.note})`);
        if (conditions.length) parts.push(`Conditions: ${conditions.join('; ')}.`);
    }
    parts.push(`Contraception: ${CONTRACEPTION_EN[pill.effective] ?? 'none'}.`);
    return parts.join(' ');
}

/** Whether he knows his partner is pregnant. */
function isExpectingFather(state, person) {
    const partner = state.people[otherKey(person.key)];
    return partner.sex === 'female' && !!partner.female.pregnancy?.knownBy.includes(person.key);
}

export function maleSnapshot(state, person) {
    return maleState(person.male, person.age, state.clock.day, state.clock.minutes, { expectingFather: isExpectingFather(state, person), nowMinute: absMinute(state.clock) });
}

/** Minutes until he can go again, 0 when he is ready (or there was no orgasm). */
export function recoveryLeft(state, person = state.people.char) {
    const m = person?.male;
    if (!m || person.sex !== 'male' || m.lastOrgasmMinute === null || m.lastOrgasmMinute === undefined) return 0;
    const s = maleSnapshot(state, person);
    return Math.max(0, s.refractoryMinutes - (absMinute(state.clock) - m.lastOrgasmMinute));
}

// #region How they are by the story

/** Story-driven state fades over half a day; the note stays a day. */
const LIVE_FADE_HOURS = 12;
export function liveNow(state, key) {
    const l = state.live?.[key];
    if (!l) return { energy: 0, libido: 0, note: null, mood: null };
    const hours = (absMinute(state.clock) - l.at) / 60;
    const k = Math.max(0, 1 - hours / LIVE_FADE_HOURS);
    return { energy: (l.energy ?? 0) * k || 0, libido: (l.libido ?? 0) * k || 0, note: hours < 24 ? l.note : null, mood: hours < LIVE_FADE_HOURS ? l.mood : null, hours };
}
/** A level 0-1 with the story's offset (-3..3) on top of the body's own level. */
export const withLive = (base, offset) => Math.min(1, Math.max(0, base + 0.15 * (offset ?? 0)));

const toOffset = v => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Math.max(-3, Math.min(3, Math.round(Number(v)))));
/** The analysis says how each person is now: replaces the earlier reading (it describes now, not a change). */
function applyPeople(state, people) {
    for (const key of ['user', 'char']) {
        const p = people?.[key];
        if (!p || !state.people[key]) continue;
        const prev = state.live[key] ?? {};
        const energy = toOffset(p.energy), libido = toOffset(p.libido);
        const note = typeof p.note === 'string' && p.note.trim() ? p.note.trim().slice(0, 300) : null;
        const mood = typeof p.mood === 'string' && p.mood.trim() ? p.mood.trim().slice(0, 40) : null;
        if (energy === null && libido === null && !note && !mood) continue;
        state.live[key] = {
            energy: energy ?? liveNow(state, key).energy,
            libido: libido ?? liveNow(state, key).libido,
            note: note ?? prev.note ?? null,
            mood: mood ?? prev.mood ?? null,
            at: absMinute(state.clock),
        };
    }
}
/** Injuries are noted, not turned into an illness: a bruise does not give a fever. */
function applyInjuries(state, injuries) {
    for (const item of injuries ?? []) {
        const person = state.people[item?.who];
        const what = typeof item?.what === 'string' ? item.what.trim().slice(0, 80) : '';
        if (!person || !what) continue;
        if (state.log.some(e => e.kind === 'injury' && e.who === person.key && e.text.endsWith(what) && state.clock.day - e.day < 3)) continue;
        note(state, person, `${person.name || 'Он'}: ${what}`, { model: false, kind: 'injury' });
    }
}

// #endregion

function maleLine(state, person, detailed) {
    return `${maleLineRaw(state, person, detailed)}${storyLine(state, person)}`;
}

function maleLineRaw(state, person, detailed) {
    const name = person.name || 'He';
    const age = person.age ? ` (${person.age})` : '';
    const s = maleSnapshot(state, person);
    const parts = [`${name}${age}:`];
    if (detailed) {
        const live = liveNow(state, person.key);
        const vigor = withLive(s.testosterone, live.energy), libido = withLive(s.libido, live.libido);
        parts.push(vigor > 0.85 ? 'full of energy, at his peak.' : vigor > 0.65 ? 'in his usual shape.' : 'tired.');
        parts.push(`Desire ${level(libido)}.`);
        if (s.erection < 0.75) parts.push('His erection may let him down (stress, tiredness or drink).');
        if (s.daysSinceLast !== null) parts.push(`Last intimacy ${s.daysSinceLast === 0 ? 'today' : `${days(s.daysSinceLast)} ago`}.`);
        const left = recoveryLeft(state, person);
        if (left > 0) parts.push(`Still recovering after his climax: ready again in about ${left} min of story time.`);
        const recent = s.recent.filter(e => e.daysAgo <= 3).map(e => e.label);
        if (recent.length) parts.push(`Lately: ${[...new Set(recent)].join(', ')}.`);
        if (s.couvade) parts.push('Shares the pregnancy in his body: sleeps worse, sometimes nauseous, odd cravings.');
    }
    if (s.expectingFather) parts.push('Knows he is going to be a father; it softens him — gentler, more protective.');
    return parts.length > 1 ? parts.join(' ') : `${name}${age}: nothing notable.`;
}

/** Calendar date of a story day, or null when the story has no start date. */
export function storyDate(state, day = state.clock.day) {
    if (!state.startDate) return null;
    const date = new Date(`${state.startDate}T12:00:00`);
    date.setDate(date.getDate() + day);
    return date;
}

export function dateLabel(state, day = state.clock.day, options = { day: 'numeric', month: 'long', weekday: 'long' }) {
    const date = storyDate(state, day);
    return date ? date.toLocaleDateString('ru-RU', options) : `день ${day + 1}`;
}

export function timeLabel(minutes) {
    const h = Math.floor(minutes / 60);
    if (h < 5) return 'ночь';
    if (h < 12) return 'утро';
    if (h < 17) return 'день';
    if (h < 22) return 'вечер';
    return 'ночь';
}

/**
 * The text the model gets before its reply.
 * @param {object} options
 * @param {boolean} [options.detailed]
 * @param {boolean} [options.neutral] Softer words for strict providers
 * @param {boolean} [options.withTag] Ask for the tracker tag
 */
export function buildStatus(state, { detailed = true, neutral = false, withTag = true } = {}) {
    const hh = String(Math.floor(state.clock.minutes / 60)).padStart(2, '0'), mm = String(state.clock.minutes % 60).padStart(2, '0');
    const date = storyDate(state);
    const when = date ? `${date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}, ${hh}:${mm}` : `story day ${state.clock.day + 1}, ${hh}:${mm}`;
    const lines = [`[Stork — the bodies of ${state.people.char.name || '{{char}}'} and ${state.people.user.name || '{{user}}'}; background for the story, not its topic | ${when}]`];
    for (const person of [state.people.char, state.people.user]) {
        lines.push(person.sex === 'female' ? femaleLine(state, person, detailed) : maleLine(state, person, detailed));
    }
    if (state.pending.length) {
        lines.push(`Just happened — let it show once in this reply, in a natural way: ${state.pending.map(e => e.text).join('; ')}.`);
    }
    const user = state.people.user.name || '{{user}}';
    lines.push(`Let these states show in the reply through bodies and behaviour — movement, reactions, appetite, tiredness or strength, desire or its absence — in small touches that fit the scene. Never state numbers, phases or this block itself. ${user}'s state shows only in what can be seen or what others notice; never write ${user}'s thoughts, feelings, words or choices. The scene always comes first.`);
    if (withTag) lines.push(TAG_INSTRUCTION);
    let text = lines.join('\n');
    if (neutral) for (const [re, word] of NEUTRAL) text = text.replace(re, word);
    return text;
}

// #endregion

/**
 * Processes one model reply: clears what the model was told, applies the tag.
 * @returns {{state: object, tag: object}}
 */
export function processReply(previousState, replyText, rng = Math.random, scene = null) {
    const state = upgradeState(cloneState(previousState));
    state.pending = [];
    const tag = parseTag(replyText);
    const wasRecovering = recoveryLeft(state) > 0;
    // Events happen before the time of the reply passes (intimacy, then the night)
    for (const event of tag.events) applyEvent(state, event, rng);
    const clock = tag.clock ?? extractClock(replyText);
    advanceTime(state, storyMinutes(state, { clock, minutes: tag.minutes, date: scene?.date, part: scene?.part_of_day }), rng);
    // ...and what came after the time skip happens at the new moment
    for (const event of tag.eventsEnd ?? []) applyEvent(state, event, rng);
    if (scene) {
        applyPeople(state, scene.people);
        applyInjuries(state, scene.injury);
    }
    // He was recovering and the story time ran out: tell once
    const man = state.people.char;
    if (wasRecovering && recoveryLeft(state) <= 0 && man?.sex === 'male') {
        note(state, man, `${man.name || 'Он'}: силы восстановились`, { model: false, kind: 'recovered' });
    }
    return { state, tag: { ...tag, clock } };
}

const PART_MINUTES = { morning: 8 * 60, day: 13 * 60, evening: 19 * 60, night: 23 * 60 };
/** Part of the day by the clock, the same boundaries as timeLabel(). */
export function partOf(minutes) {
    const h = Math.floor(minutes / 60);
    return h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'day' : h < 22 ? 'evening' : 'night';
}
/** Story day of an ISO date, by the chat's start date. */
function dayOfDate(state, iso) {
    if (!state.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(iso ?? ''))) return null;
    return Math.round((new Date(`${iso}T12:00:00Z`) - new Date(`${state.startDate}T12:00:00Z`)) / 86400000);
}
/**
 * How far the story moved, best source first: a date the story names, then a clock, then a part of the day,
 * then the guessed duration. Time never goes back. The first date the story names anchors the calendar
 * (before it the date was only a guess, often today's real one).
 */
export function storyMinutes(state, { clock = null, minutes = 0, date = null, part = null } = {}) {
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? '')) ? date : null;
    if (validDate && (!state.dateSure || !state.startDate)) {
        // re-anchor: today is that date; the cycle and everything else stay where they are
        const base = new Date(`${validDate}T12:00:00Z`);
        base.setUTCDate(base.getUTCDate() - state.clock.day);
        state.startDate = base.toISOString().slice(0, 10);
        state.dateSure = true;
    } else if (validDate) {
        const target = dayOfDate(state, validDate);
        if (target !== null && target > state.clock.day) {
            const at = clock ?? (part && PART_MINUTES[part]) ?? state.clock.minutes;
            return (target - state.clock.day) * MINUTES_PER_DAY + at - state.clock.minutes;
        }
    }
    if (clock !== null) return minutesToClock(state.clock.minutes, clock, minutes);
    // the story says it is evening now while the clock says morning: move to that part of the day
    if (part && PART_MINUTES[part] !== undefined && partOf(state.clock.minutes + minutes) !== part) {
        return minutesToClock(state.clock.minutes, PART_MINUTES[part], minutes);
    }
    return minutes;
}

/**
 * Time written in the story wins over a guessed duration: move to the next moment the clock shows that time,
 * keeping the whole days the reader counted (a week later at 09:00).
 */
export function minutesToClock(nowMinutes, clockMinutes, guessedMinutes = 0) {
    const days = Math.floor(Math.max(0, guessedMinutes) / MINUTES_PER_DAY);
    let delta = (clockMinutes - nowMinutes + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    // A header a few minutes "earlier" than now is the same moment, not tomorrow
    if (!days && delta > 18 * 60 && guessedMinutes < 6 * 60) delta = 0;
    return days * MINUTES_PER_DAY + delta;
}

/** A time header at the start of a reply, like "**22:40, Квартира**". */
export function extractClock(text) {
    const head = cleanRpText(text).slice(0, 300);
    const match = head.match(/(?:^|\n)[\s*_#>~[(]*(\d{1,2}[:.]\d{2})(?!\d)/);
    return match ? parseClock(match[1]) : null;
}
