/*
 * Stork engine: the story state, time, events from the model and the status text.
 * Pure functions over a plain JSON state, so it is saved with chat messages and tested in Node.
 */
import {
    ACT_PROTECTION, careOf, hashUnit, realism, createPregnancy, cycleInfo, cycleReturnDay, EMERGENCY_PILL_FACTOR, EMERGENCY_PILL_WINDOW_DAYS, falseContractionsToday,
    femaleConditionFactor, FEMALE_CONDITIONS, FEMALE_HABITS, femaleState, laborChance, laborProgress, LIFESTYLE, maleState, pillState, POSTPARTUM_RECOVERY_DAYS, PREGNANCY_DAYS, pregnancyInfo,
    rollCondomBreak, rollConception, rollCycles, rollTest, startLabor, stressDelay, ultrasoundShowsSex,
} from './biology.js';

import { addBirths, applyFindings, emptyFamily, ensureFamily, mergeDuplicates } from './family.js';
import { applyIntimacy, ensureIntim, soloKink } from './intimacy.js';
import { advanceByLine } from './storyclock.js';
import { advanceHealth, applyHealth, healthOnBody, healthPrompt } from './health.js';

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
            smoker: false,
            drinker: false,
        },
        male: {
            fertility: 'normal',
            smoker: false,
            drinker: false,
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
        family: emptyFamily(),
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
    // 0.15 kept the story so far inside every state; now each reply keeps only its own line (see lastLine)
    delete state.timeline;
    state.dateSure ??= false;
    ensureFamily(state);
    // older versions could put the same relative on the tree twice
    mergeDuplicates(state);
    ensureIntim(state);
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
    if (model) state.pending.push({ who: person?.key ?? null, text, day: state.clock.day });
}

/**
 * What the model is told «just happened»: only the last day of story time, each thing once.
 * After a long time skip the four periods of four months are in the journal, not news for the scene.
 */
function freshPending(state) {
    const seen = new Set();
    return state.pending.filter(e => (e.day ?? state.clock.day) >= state.clock.day - 1).reverse()
        .filter(e => !seen.has(e.text) && seen.add(e.text)).reverse();
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

    const care = careOf(state);
    for (const visit of care.visits) {
        if (knows && info.week >= visit.week && !p.visitsDone.includes(visit.week)) {
            p.visitsDone.push(visit.week);
            note(state, person, `${name}: ${care.due(visit.label)}`, { kind: 'doctor' });
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
            // the baby goes onto the family tree as a child of both
            addBirths(state, p.sexes, state.clock.day);
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
    const from = absMinute(state.clock);
    const total = left;
    // a skip of days: what would happen to their health meanwhile happens off-screen — nobody falls ill by the dice,
    // and an illness they had was taken care of rather than left to grow critical unseen
    const offscreen = left > 2 * MINUTES_PER_DAY;
    while (left > 0) {
        const step = Math.min(left, MINUTES_PER_DAY - state.clock.minutes);
        state.clock.minutes += step;
        left -= step;
        if (realism.health) healthTick(state, step, rng, offscreen);
        for (const person of Object.values(state.people)) if (person.sex === 'female') processLabor(state, person, rng);
        if (state.clock.minutes >= MINUTES_PER_DAY) {
            state.clock.minutes -= MINUTES_PER_DAY;
            state.clock.day += 1;
            for (const person of Object.values(state.people)) if (person.sex === 'female') processFemaleDay(state, person, rng);
        }
    }
    // the nights slept through in this stretch of time (a short scene at 4 a.m. is not a night's sleep)
    if (total >= 3 * 60) nights(state, from, absMinute(state.clock), rng);
}

/**
 * What a night does to a man who has gone without release: the longer, the likelier a wet dream (more so when young),
 * which is a release of its own; or he wakes with an insistent morning erection. Medically: nocturnal emissions grow
 * with abstinence and fall with age. Told once, never every morning.
 */
function nights(state, from, to, rng) {
    const man = Object.values(state.people).find(p => p.sex === 'male');
    if (!man?.male) return;
    const name = man.name || 'Он';
    // each 04:00 in the stretch, after the stretch began
    for (let night = Math.ceil((from - 4 * 60) / MINUTES_PER_DAY) * MINUTES_PER_DAY + 4 * 60; night <= to; night += MINUTES_PER_DAY) {
        if (night <= from) continue;
        const last = man.male.lastOrgasmMinute ?? 0;
        if (night <= last) continue;
        const need = (ABSTAIN_DAYS[temperamentOf(state, man)] ?? ABSTAIN_DAYS.normal) * 24 * 60;
        const ratio = (night - last) / need;
        const age = man.age ?? 30;
        const base = age < 25 ? 0.1 : age < 35 ? 0.06 : age < 45 ? 0.035 : 0.02;
        const chance = base * Math.max(0, ratio - 0.6) * 2.5;
        if (chance > 0 && rng() < chance) {
            const day = Math.floor(night / MINUTES_PER_DAY);
            markOrgasm(man.male, day, night);
            const recent = to - night < MINUTES_PER_DAY;
            const entry = { day, minutes: night % MINUTES_PER_DAY, who: man.key, text: `${name}: ночная поллюция — долгое воздержание`, kind: 'emission' };
            state.log.push(entry);
            if (recent) state.pending.push({ who: man.key, text: `${name} had a wet dream last night after a long time without release`, day: state.clock.day });
            continue;
        }
        // the last morning of the stretch only, and not always: an insistent morning erection
        if (ratio >= 0.6 && to - night < 8 * 60 && rng() < 0.3) {
            state.pending.push({ who: man.key, text: `${name} woke with an insistent morning erection — long without release`, day: state.clock.day });
        }
    }
}

/** The journal of health: «Игорь: «Грипп» — выздоровел» into Stork's own journal. */
const healthLog = state => (key, text) => {
    const person = state.people[key];
    note(state, person, `${person?.name || (key === 'char' ? 'Он' : 'Она')}: ${text}`, { model: false, kind: 'health' });
};
/** A new illness with fever is also what Stork's body knows as one: his sperm, her ovulation. */
function healthBody(state, onsets, rng) {
    for (const o of onsets) if (o.fever) applyEvent(state, { type: 'illness', who: o.key }, rng);
}
function healthTick(state, minutes, rng, offscreen = false) {
    const date = storyDate(state);
    const onsets = advanceHealth(state, minutes / MINUTES_PER_DAY, rng, healthLog(state), { speed: realism.healthSpeed, now: absMinute(state.clock), month: date ? date.getMonth() : 0, offscreen });
    healthBody(state, onsets, rng);
}

// #endregion

// #region Conception: the dice are thrown at the act

/**
 * One roll for these acts against the ovulation of this cycle. A success starts a hidden pregnancy dated by that
 * ovulation: sperm lives up to 5 days, so an act before it can still lead to one.
 * @returns {boolean} conceived
 */
function throwDice(state, person, acts, ovulated, pill, rng, lmp = person.female.cycleStart) {
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
    if (result.conceived) f.pregnancy = createPregnancy({ lmp, conceptionDay: ovulated, twins: result.twins, births: f.births, rng });
    return result.conceived;
}

/** The cycle a day belongs to: the current one, or an earlier one of her usual length (for closeness told about later). */
function cycleOf(f, day) {
    if (day >= f.cycleStart) return f;
    const k = Math.floor((day - f.cycleStart) / f.cycleLength);
    return { ...f, cycleStart: f.cycleStart + k * f.cycleLength, cycleShift: 0 };
}

/** The dice for one act: only inside the fertile window of the cycle it fell in. */
function rollAct(state, act, rng) {
    const woman = state.people[act.woman];
    const f = woman?.female;
    act.rolled = true;
    if (!f || f.pregnancy || f.postpartum) return;
    const pill = pillState(f, act.day);
    // hormonal contraception used correctly: no ovulation, nothing to roll
    if (pill.suppressed) return;
    const cycle = cycleOf(f, act.day);
    const ovulated = cycle.cycleStart + cycleInfo(cycle, act.day).ovulation - 1;
    if (act.day < ovulated - 5 || act.day > ovulated) return;
    throwDice(state, woman, [act], ovulated, pill, rng, cycle.cycleStart);
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
/** A check-up, an ultrasound, a test: the same one told over several replies is counted once. */
const VISIT_HOURS = { doctor: 4, ultrasound: 4, test: 3 };
function sameVisit(state, type) {
    if (!VISIT_HOURS[type]) return false;
    state.seen ??= {};
    const now = absMinute(state.clock);
    const last = state.seen[type];
    state.seen[type] = now;
    return last !== undefined && last !== null && now - last >= 0 && now - last < VISIT_HOURS[type] * 60;
}

export function applyEvent(state, event, rng = Math.random) {
    const day = state.clock.day;
    if (!event?.manual && sameVisit(state, event?.type)) return;
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
            // his recovery starts at his climax, not at the start of intercourse
            if (man && !event.open) markOrgasm(man.male, day, absMinute(state.clock));
            if (woman && man) {
                state.acts.push(act);
                rollAct(state, act, rng);
            }
            break;
        }
        case 'past_intimacy': {
            // «three weeks ago we slept together»: an act on that day, with its own dice by the cycle she was in then
            const woman = Object.values(state.people).find(p => p.sex === 'female');
            const man = Object.values(state.people).find(p => p.sex === 'male');
            const daysAgo = Math.round(Number(event.daysAgo));
            if (!woman || !man || !(daysAgo >= 1)) break;
            const actDay = day - daysAgo;
            // already known from the story: not counted twice
            if (state.acts.some(a => a.woman === woman.key && Math.abs(a.day - actDay) <= 1)) break;
            const protection = ACT_PROTECTION[event.protection] ? event.protection : 'none';
            const act = { day: actDay, minute: actDay * MINUTES_PER_DAY + 22 * 60, protection, woman: woman.key, force: null, condomBroke: false, past: true };
            state.acts.push(act);
            state.acts.sort((a, b) => a.day - b.day);
            note(state, null, `близость ${daysAgo} дн. назад (${ACT_PROTECTION[protection].label}), со слов истории`, { model: false, kind: 'intimacy' });
            rollAct(state, act, rng);
            break;
        }
        case 'period_started':
        case 'period_ongoing': {
            // the story plainly shows her period: the cycle follows the story, not the count
            const woman = Object.values(state.people).find(p => p.sex === 'female');
            const f = woman?.female;
            if (!f || f.pregnancy || f.postpartum) break;
            const now = cycleInfo(f, day);
            const ago = Math.max(0, Math.round(event.daysAgo ?? 0));
            if (!ago && now.phase === 'menstruation') break;
            // the story's period began «ago» days back: Stork's own cycle had one then (give or take three days) —
            // the same period, nothing to move
            const storyStart = day - ago - (event.type === 'period_ongoing' && !ago ? 1 : 0);
            const ownStart = day - (now.cycleDay - 1);
            if (Math.abs(ownStart - storyStart) <= 3 || Math.abs(ownStart - f.cycleLength - storyStart) <= 3) break;
            // The cycle was set by her or by the story lately: a period in its first half is far more likely a slip
            // of the story or of the analysis (a memory, a fear, last month) than the body. The cycle stays, she is
            // asked instead. Long unconfirmed (a skip of months, never set): the story's period wins at once.
            const confirmed = typeof f.syncedDay === 'number' && day - f.syncedDay < 2 * f.cycleLength;
            if (confirmed && now.cycleDay < Math.max(15, now.length - 10)) {
                note(state, woman, `${woman.name || 'Она'}: в истории месячные, а по циклу день ${now.cycleDay} — цикл не сдвинут`, { model: false, kind: 'period_hint' });
                break;
            }
            f.cycleStart = storyStart;
            f.syncedDay = day;
            f.cycleShift = 0;
            f.rolledCycle = null;
            f.delayedCycle = null;
            f.lateNoticed = [];
            note(state, woman, `${woman.name || 'Она'}: цикл сверен с историей, ${ago ? `месячные начались ${ago} дн. назад` : 'сейчас месячные'}`, { model: false });
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
            // a visit about an illness is told by health (the diagnosis); the pregnancy visit stays Stork's own
            if (!realism.health || p) note(state, woman, careOf(state).visited, { model: false });
            break;
        }
        case 'orgasm':
            if (who?.sex === 'male') markOrgasm(who.male, day, absMinute(state.clock));
            if (who?.sex === 'female') who.female.lastOrgasmMinute = absMinute(state.clock);
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
            // no ultrasound in old times: the midwife's hands tell the term, never the sex
            if (!careOf(state).canSeeSex) {
                note(state, woman, `повитуха осмотрела живот: срок около ${week} нед.`);
                break;
            }
            const seen = !p.sexKnown && ultrasoundShowsSex(week, rng);
            if (seen) p.sexKnown = true;
            note(state, woman, `УЗИ: ${p.babies > 1 ? 'двойня' : 'один малыш'}, срок ${week} нед.${p.sexKnown ? `, пол: ${p.sexes.join(' и ')}` : ', пол пока не виден'}`);
            break;
        }
        case 'pregnancy_claim':
            claimPregnancy(state, event, rng);
            break;
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
        // what a doctor found or the story says outright: Stork takes it on by itself, nobody has to tick it
        case 'varicocele':
        case 'vasectomy':
        case 'vasectomy_now': {
            const man = Object.values(state.people).find(p => p.sex === 'male');
            const m = man?.male;
            if (!m) break;
            const name = man.name || 'Он';
            if (event.type === 'varicocele' && !m.varicocele) {
                m.varicocele = true;
                note(state, man, `${name}: варикоцеле, сперма слабее`, { model: false, kind: 'doctor' });
            } else if (event.type === 'vasectomy' && m.vasectomyDay === null) {
                // done long ago: it protects already
                m.vasectomyDay = day - 365;
                note(state, man, `${name}: была вазэктомия, детей от него не будет`, { model: false, kind: 'doctor' });
            } else if (event.type === 'vasectomy_now' && (m.vasectomyDay === null || m.vasectomyDay < day - 365)) {
                m.vasectomyDay = day;
                note(state, man, `${name}: сделал вазэктомию, защищать начнёт примерно через 3 месяца`, { model: false, kind: 'doctor' });
            }
            break;
        }
        case 'pcos':
        case 'endometriosis': {
            const woman = Object.values(state.people).find(p => p.sex === 'female');
            if (!woman || woman.female[event.type]) break;
            woman.female[event.type] = true;
            note(state, woman, `${woman.name || 'Она'}: ${FEMALE_CONDITIONS[event.type].label}, ${FEMALE_CONDITIONS[event.type].note}`, { model: false, kind: 'doctor' });
            break;
        }
        case 'stress':
        case 'illness':
            if (event.type === 'illness' && who) {
                state.seen ??= {};
                state.seen.fever ??= {};
                if (state.seen.fever[who.key] === day) break;
                state.seen.fever[who.key] = day;
            }
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

// #region A pregnancy the story states

/** A claim the story makes again while she has not decided yet, or soon after she rejected it, changes nothing. */
const CLAIM_REJECT_DAYS = 30;
/** A known pregnancy is re-dated by the story only when the term it names is this far off. */
const CLAIM_TERM_SLACK_DAYS = 10;
const termDays = (weeks, days) => Math.round((Number(weeks) || 0) * 7 + (Number(days) || 0));

/** Moves a pregnancy so that today it is `total` days from the last period; its own dates move with it. */
export function setPregnancyTerm(p, day, total) {
    const shift = (day - total) - p.lmp;
    if (!shift) return;
    for (const key of ['lmp', 'conceptionDay', 'kicksDay', 'spottingDay']) if (typeof p[key] === 'number') p[key] += shift;
}

/** No term in the story: from the latest closeness that could have led to it, otherwise six weeks. */
function guessTermDays(state, woman, day) {
    const act = [...state.acts].reverse().find(a => a.woman === woman.key && (a.protection !== 'condom' || a.condomBroke) && day - a.day >= 7 && day - a.day <= 280);
    return act ? day - act.day + 14 : 42;
}

/**
 * The story says she is pregnant (her own message counts: she decides): Stork writes it in right away, dated by
 * the term the story names, and keeps what was there before, so she can accept it, fix the term, or reject it
 * (a false alarm, a lie in the story) and get the old state back.
 * @param {{weeks?: number, days?: number, quote?: string, who?: string}} claim
 */
export function claimPregnancy(state, claim, rng = Math.random) {
    const woman = Object.values(state.people).find(p => p.sex === 'female');
    const f = woman?.female;
    if (!f || f.pregnancy?.labor) return false;
    const day = state.clock.day;
    const prior = state.pregnancyClaim;
    if (prior?.status === 'rejected' && day - prior.decidedDay < CLAIM_REJECT_DAYS) return false;
    const named = Number(claim.weeks) > 0 || Number(claim.days) > 0;
    const total = named ? Math.min(42 * 7, Math.max(14, termDays(claim.weeks, claim.days))) : null;
    const quote = typeof claim.quote === 'string' ? claim.quote.trim().slice(0, 160) : '';
    const name = woman.name || 'Она';
    const p = f.pregnancy;

    if (p && p.knownBy.includes(woman.key)) {
        // already known: only a pending claim follows the story, or a term far from the tracker's
        const now = day - p.lmp;
        if (!named || Math.abs(now - total) < CLAIM_TERM_SLACK_DAYS) return false;
        if (prior?.status === 'pending') {
            // she set the term herself: the story does not move it while she decides
            if (prior.edited) return false;
            setPregnancyTerm(p, day, total);
            Object.assign(prior, { weeks: Math.floor(total / 7), days: total % 7, guessed: false, quote: quote || prior.quote });
            return true;
        }
        state.pregnancyClaim = { status: 'pending', kind: 'term', day, weeks: Math.floor(total / 7), days: total % 7, guessed: false, quote, prev: cloneState(p), prevPostpartum: f.postpartum ?? null };
        setPregnancyTerm(p, day, total);
        note(state, woman, `${name}: срок по истории ${Math.floor(total / 7)} нед. — проверь в Stork`, { model: false, kind: 'claim' });
        return true;
    }

    const prev = p ? cloneState(p) : null;
    const days = total ?? guessTermDays(state, woman, day);
    if (p) {
        // the dice had already said yes: she learns it now, at the term the story names
        if (named) setPregnancyTerm(p, day, days);
    } else {
        f.pregnancy = createPregnancy({ lmp: day - days, conceptionDay: day - days + 14, twins: false, births: f.births, rng });
        f.pregnancy.fromStory = true;
    }
    if (!f.pregnancy.knownBy.includes(woman.key)) f.pregnancy.knownBy.push(woman.key);
    state.pregnancyClaim = {
        status: 'pending', kind: 'pregnancy', day, weeks: Math.floor(days / 7), days: days % 7, guessed: !named, quote,
        prev, prevPostpartum: f.postpartum ?? null,
    };
    f.postpartum = null;
    note(state, woman, `${name}: беременность по истории, ${named ? '' : 'примерно '}${Math.floor(days / 7)} нед. — проверь в Stork`, { model: false, kind: 'claim' });
    return true;
}

/** She agrees with what Stork wrote in: the question goes away, the pregnancy stays. */
export function acceptPregnancyClaim(state) {
    const c = state.pregnancyClaim;
    if (c?.status !== 'pending') return false;
    c.status = 'accepted';
    c.decidedDay = state.clock.day;
    delete c.prev;
    return true;
}

/** Not a pregnancy (a false alarm, a lie, a mistake of the analysis): everything goes back to how it was. */
export function rejectPregnancyClaim(state) {
    const c = state.pregnancyClaim;
    if (c?.status !== 'pending') return false;
    const woman = Object.values(state.people).find(p => p.sex === 'female');
    if (woman) {
        woman.female.pregnancy = c.prev ?? null;
        woman.female.postpartum = c.prevPostpartum ?? woman.female.postpartum ?? null;
        note(state, woman, `${woman.name || 'Она'}: ${c.kind === 'term' ? 'срок из истории не принят' : 'беременность из истории отклонена, Stork её не считает'}`, { model: false, kind: 'claim' });
    }
    c.status = 'rejected';
    c.decidedDay = state.clock.day;
    delete c.prev;
    return true;
}

/**
 * A pregnancy set by hand: her own (the story has one Stork missed, an old chat) or new dates for the one there is.
 * Only the start is stored (lmp): the week, the baby, the due date, the visits and the status for the model all
 * follow from it by themselves. Visits before this week count as done off-screen (no pile of «пора к врачу»),
 * the ones ahead come as usual; a labor that started too early stops.
 * @param {{weeks?: number|string, days?: number|string, lmpDate?: string, dueDate?: string, partnerKnows?: boolean}} input
 *   the term, or the first day of the last period, or the due date (ISO, by the story's calendar)
 * @returns {{ok: boolean, error?: string, created?: boolean, weeks?: number, days?: number}}
 */
export function setPregnancyByHand(state, input, rng = Math.random) {
    const woman = Object.values(state.people).find(p => p.sex === 'female');
    const f = woman?.female;
    if (!f) return { ok: false, error: 'в этом чате нет героини' };
    const day = state.clock.day;
    let total;
    if (input.lmpDate || input.dueDate) {
        const at = dayOfDate(state, input.lmpDate || input.dueDate);
        if (at === null) return { ok: false, error: 'у истории нет календарной даты: укажи срок неделями' };
        total = input.lmpDate ? day - at : PREGNANCY_DAYS - (at - day);
    } else {
        total = termDays(input.weeks, input.days);
    }
    if (!Number.isFinite(total) || total < 14) return { ok: false, error: 'срок меньше 2 недель — так беременность ещё не считается' };
    if (total > 42 * 7) return { ok: false, error: 'срок больше 42 недель' };

    const created = !f.pregnancy;
    if (created) {
        f.pregnancy = createPregnancy({ lmp: day - total, conceptionDay: day - total + 14, twins: false, births: f.births, rng });
        f.postpartum = null;
    } else {
        setPregnancyTerm(f.pregnancy, day, total);
    }
    const p = f.pregnancy;
    p.manual = true;
    if (!p.knownBy.includes(woman.key)) p.knownBy.push(woman.key);
    const partner = Object.values(state.people).find(x => x.sex === 'male');
    if (partner && typeof input.partnerKnows === 'boolean') {
        const knows = p.knownBy.includes(partner.key);
        if (input.partnerKnows && !knows) p.knownBy.push(partner.key);
        if (!input.partnerKnows && knows) p.knownBy = p.knownBy.filter(k => k !== partner.key);
    }
    const week = Math.floor(total / 7);
    p.visitsDone = careOf(state).visits.filter(v => v.week < week).map(v => v.week);
    // the rest of the form: twins, the sex of each baby, what the story established, cravings
    if (input.babies !== undefined) {
        const babies = Math.max(1, Math.min(2, Math.round(Number(input.babies) || 1)));
        while (p.sexes.length < babies) p.sexes.push(rng() < 0.5 ? 'девочка' : 'мальчик');
        p.sexes = p.sexes.slice(0, babies);
        p.babies = babies;
    }
    if (Array.isArray(input.sexes)) {
        const named = input.sexes.slice(0, p.babies).map(s => SEX_WORD[String(s ?? '').toLowerCase()] ?? null);
        if (named.some(Boolean)) {
            // a sex left «не знаю» next to a named one keeps what the dice chose for that baby
            p.sexes = p.sexes.map((s, i) => named[i] ?? s);
            p.sexKnown = true;
            p.sexFrom = 'hand';
        } else {
            p.sexKnown = false;
            delete p.sexFrom;
        }
    } else if (week < 18 && p.sexFrom !== 'hand' && p.sexFrom !== 'story') p.sexKnown = false;
    if (Array.isArray(input.facts)) {
        p.facts = input.facts.map(t => String(t ?? '').trim().replace(/\s+/g, ' ').slice(0, 120)).filter(Boolean).slice(0, 12)
            .map(text => p.facts?.find(f => f.text === text) ?? { week, text });
    }
    const words = v => String(v ?? '').split(/[,;\n]/).map(s => s.trim()).filter(Boolean).slice(0, 4);
    if (input.cravings !== undefined) p.cravings = words(input.cravings);
    if (input.aversions !== undefined) p.aversions = words(input.aversions);
    if (p.labor && week < 37) p.labor = null;
    // a question from the story waiting for her answer is settled by what she set herself
    const claim = state.pregnancyClaim;
    if (claim?.status === 'pending') {
        claim.status = 'accepted';
        claim.decidedDay = day;
        delete claim.prev;
    }
    const term = `${week} нед.${total % 7 ? ` ${total % 7} дн.` : ''}`;
    note(state, woman, `${woman.name || 'Она'}: ${created ? 'беременность указана вручную' : 'срок беременности поправлен вручную'} — ${term}`, { model: false, kind: 'claim' });
    return { ok: true, created, weeks: week, days: total % 7 };
}

/** No pregnancy after all (the reading got it wrong): it is removed and her cycle goes on as if it never was. */
export function removePregnancyByHand(state, rng = Math.random) {
    const woman = Object.values(state.people).find(p => p.sex === 'female');
    const f = woman?.female;
    if (!f?.pregnancy) return false;
    f.cycleStart = Math.min(f.cycleStart, f.pregnancy.lmp);
    f.cycleShift = 0;
    f.pregnancy = null;
    rollCycles(f, state.clock.day, rng);
    if (state.pregnancyClaim?.status === 'pending') state.pregnancyClaim.status = 'rejected';
    note(state, woman, `${woman.name || 'Она'}: беременность убрана вручную`, { model: false, kind: 'claim' });
    return true;
}

/** Her own term: the pregnancy is re-dated, the story no longer moves it while she decides. */
export function editPregnancyClaim(state, weeks, days) {
    const c = state.pregnancyClaim;
    const woman = Object.values(state.people).find(p => p.sex === 'female');
    const p = woman?.female.pregnancy;
    if (c?.status !== 'pending' || !p) return false;
    const total = Math.min(42 * 7, Math.max(7, termDays(weeks, days)));
    setPregnancyTerm(p, state.clock.day, total);
    Object.assign(c, { weeks: Math.floor(total / 7), days: total % 7, guessed: false, edited: true });
    return true;
}

// #endregion

// #region Model tag

/** The instruction appended to the status: how to report what happened. */
export const TAG_INSTRUCTION = 'At the very end of the reply add one hidden tracker line (the reader never sees it): '
    + '<stork t="story time that passed in this reply: +15m, +2h, +1d or 0" ev="events, comma-separated, or empty"/>. '
    + 'Events: intimacy:none|condom|withdrawal (intercourse and protection), orgasm:user|char, test:user|char (pregnancy test), '
    + 'condom_broke, doctor, ultrasound, told:char (he learned she is pregnant), pregnant:WEEKS (the reply or her message states as a fact that she is pregnant; WEEKS is the term the text names, 0 if none),  stress:user|char, illness:user|char (only a sickness with fever — never an injury or a bruise), '
    + 'alcohol:user|char, smoking:user|char, cannabis:user|char, sauna:user|char, no_sleep:user|char, pill_missed:user|char, emergency_pill:user|char, '
    + 'and a diagnosis only when a doctor finds it or the story states it as a fact: varicocele, vasectomy (he had one before), vasectomy_now (the operation in this reply), pcos, endometriosis. '
    + 'period_started or period_ongoing only when the reply plainly shows she has her period now. '
    + 'Intercourse spoken of as past (three weeks ago they slept together): past:none|condom|withdrawal:DAYS_AGO. '
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
        const [type, arg, extra] = token.split(':').map(s => s.trim());
        // intimacy:none:open — intercourse in this reply, but he has not climaxed (yet)
        if (type === 'intimacy') return extra === 'open' ? { type, protection: arg || 'none', open: true } : { type, protection: arg || 'none' };
        // past:none:21 is closeness 21 days before now
        if (type === 'past') return { type: 'past_intimacy', protection: arg || 'none', daysAgo: Number(extra) };
        // period_started:7 — her period began 7 days ago (in a skipped week)
        if (type === 'period_started' || type === 'period_ongoing') return { type, daysAgo: Math.max(0, Number(arg) || 0) };
        // pregnant:8 or pregnant:8:3 is the story saying she is pregnant, 8 weeks (and 3 days)
        if (type === 'pregnant') return { type: 'pregnancy_claim', weeks: Number(arg) || 0, days: Number(extra) || 0 };
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

// #region A time skip at the start of her message

const SKIP_NUMBERS = {
    один: 1, одну: 1, одна: 1, пару: 2, пара: 2, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8,
    девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12, несколько: 3, a: 1, an: 1, one: 1, two: 2, three: 3, four: 4,
    five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, few: 3, several: 3, couple: 2,
};
const SKIP_NUM = `(\\d+(?:[.,]\\d+)?|${Object.keys(SKIP_NUMBERS).join('|')})`;
const SKIP_UNIT = '(минут\\p{L}*|час\\p{L}*|дн\\p{L}*|день|сут\\p{L}*|недел\\p{L}*|месяц\\p{L}*|год\\p{L}*|лет|minutes?|hours?|days?|weeks?|months?|years?)';
const unitMinutes = unit => [[/^(минут|minute)/, 1], [/^(час|hour)/, 60], [/^(дн|день|сут|day)/, 1440], [/^(недел|week)/, 10080], [/^(месяц|month)/, 43200], [/^(год|лет|year)/, 525600]]
    .find(([re]) => re.test(unit))?.[1] ?? 0;
const SKIP_PATTERNS = [
    // «4 месяца спустя», «пару дней спустя», «two weeks later»
    new RegExp(`^(?:${SKIP_NUM}\\s+)?${SKIP_UNIT}\\s+(?:спустя|позже|later)`, 'iu'),
    // «спустя неделю», «прошло 4 месяца»
    new RegExp(`^(?:спустя|прошл[оаи]?|прош[её]л)\\s+(?:${SKIP_NUM}\\s+)?${SKIP_UNIT}`, 'iu'),
    // «таймскип: 2 недели»
    new RegExp(`^(?:тайм-?скип|time-?\\s?skip)\\s*[:—–-]?\\s*(?:на\\s+)?(?:${SKIP_NUM}\\s+)?${SKIP_UNIT}`, 'iu'),
    // «через неделю.» only as a whole phrase: «через месяц у нас свадьба» is a plan, not a skip
    new RegExp(`^через\\s+(?:${SKIP_NUM}\\s+)?${SKIP_UNIT}(?=\\s*(?:[,.:;!—–-]|$))`, 'iu'),
];
const HALF_YEAR = /^(?:пол\s?года\s+(?:спустя|позже)|(?:спустя|через|тайм-?скип:?)\s+пол\s?года|half a year later)/iu;
const NEXT_DAY = /^(?:на следующ(?:ий|ее) (?:день|утро)|наутро|the next (?:day|morning)|next (?:day|morning))/iu;

/**
 * A time skip her message opens with («4 месяца спустя. Мы…»), in minutes, or 0.
 * Only at the very start: a time somewhere in the middle is a memory or a plan, not a skip.
 */
export function parseSkip(text, nowMinutes = null) {
    const head = cleanRpText(text).replace(/^[\s*_~([«"'>]+/u, '').replace(/^(?:ooc|ООС)\s*:\s*/iu, '').split(/[.!?\n]/)[0].trim().toLowerCase();
    if (!head) return 0;
    if (HALF_YEAR.test(head)) return 6 * 43200;
    if (NEXT_DAY.test(head)) {
        if (nowMinutes === null || nowMinutes === undefined) return MINUTES_PER_DAY;
        // «наутро», «на следующее утро»: the next morning, about 8:00 — not this very minute a day later
        if (/утр|morning/i.test(head)) return MINUTES_PER_DAY - nowMinutes + 8 * 60;
        // «на следующий день» from the middle of the night means the coming day (10:00), not the same night hour
        if (nowMinutes < 6 * 60) return 10 * 60 - nowMinutes;
        if (nowMinutes >= 22 * 60) return MINUTES_PER_DAY - nowMinutes + 10 * 60;
        return MINUTES_PER_DAY;
    }
    for (const re of SKIP_PATTERNS) {
        const m = head.match(re);
        if (!m) continue;
        const count = m[1] === undefined ? 1 : (SKIP_NUMBERS[m[1]] ?? Number(String(m[1]).replace(',', '.')));
        const minutes = Math.round(count * unitMinutes(m[2]));
        if (minutes > 0) return minutes;
    }
    return 0;
}

// #endregion

/** Fallback when the model forgot the tag: guesses to offer the user, never applied silently. */
export function detectHints(text) {
    let minutes = 0;
    for (const [re, value] of TIME_HINTS) if (re.test(text)) minutes = Math.max(minutes, value);
    return { minutes, intimacy: INTIMACY_HINT.test(String(text ?? '')) };
}

// #endregion

// #region Scene analysis

export const SCENE_LIFESTYLE_TYPES = ['alcohol', 'smoking', 'cannabis', 'steroids', 'sauna', 'illness', 'stress', 'no_sleep'];
/** What a doctor can find or the story can state: the man's and the woman's, each is about one of them. */
export const DIAGNOSES = ['varicocele', 'vasectomy', 'vasectomy_now', 'pcos', 'endometriosis'];
const LIFESTYLE_TYPES = SCENE_LIFESTYLE_TYPES;

/**
 * Turns the analysis into Stork's tag, so replies read by a model and replies with a tag go the same way.
 * @returns {string}
 */
export function sceneToTag(scene) {
    // the scene came after the time skip («four months later… he pours a whiskey»): everything in it happens on the new day
    const late = [];
    const afterSkip = scene?.scene_after_skip === true || scene?.intimacy?.after_time_skip === true;
    const events = afterSkip ? late : [];
    const intimacy = scene?.intimacy;
    const act = i => {
        let protection = i?.protection === 'condom' ? 'condom' : 'none';
        if (protection === 'none' && i?.finished_inside === false) protection = 'withdrawal';
        return protection;
    };
    if (intimacy) {
        // the reading says who climaxed: intercourse without his climax yet starts no recovery
        const open = Array.isArray(scene.orgasm) && !scene.orgasm.includes('char') && intimacy.finished_inside !== true;
        const protection = open && intimacy.finished_inside === false && act(intimacy) === 'withdrawal' ? 'none' : act(intimacy);
        events.push(`intimacy:${protection}${open ? ':open' : ''}`);
        if (protection === 'condom' && intimacy.condom_broke) events.push('condom_broke');
    }
    for (const who of scene?.orgasm ?? []) if (who === 'user' || who === 'char') events.push(`orgasm:${who}`);
    for (const item of scene?.lifestyle ?? []) {
        // a bruise, a cut or a hangover is not an illness: only a sickness with fever counts as one
        if (item?.type === 'illness' && item.fever !== true) continue;
        if (LIFESTYLE_TYPES.includes(item?.type) && (item.who === 'user' || item.who === 'char')) events.push(`${item.type}:${item.who}`);
    }
    // the story says she is pregnant: before the test, so a test in the same scene reads the same truth
    const claim = scene?.pregnancy_claim;
    if (claim && typeof claim === 'object') {
        const weeks = Math.max(0, Math.round(Number(claim.weeks) || 0));
        const days = Math.max(0, Math.min(6, Math.round(Number(claim.days) || 0)));
        events.push(`pregnant:${weeks}${days ? `:${days}` : ''}`);
        if (claim.partner_knows === true && scene?.partner_learns_pregnancy !== true) events.push('told:char');
    }
    if (scene?.pregnancy_test) events.push('test:user');
    if (scene?.doctor_visit) events.push('doctor');
    if (scene?.ultrasound) events.push('ultrasound');
    // after the test, the doctor and the ultrasound: she learns first, then he can
    if (scene?.partner_learns_pregnancy === true) events.push('told:char');
    for (const item of scene?.diagnoses ?? []) if (DIAGNOSES.includes(item)) events.push(item);
    if (scene?.missed_pill) events.push('pill_missed:user');
    if (scene?.emergency_pill) events.push('emergency_pill:user');
    // the story plainly shows her period: the cycle follows the story
    if (['started', 'ongoing', 'over'].includes(scene?.period)) {
        const ago = Math.max(0, Math.min(40, Math.round(Number(scene.period_days_ago) || 0)));
        // a period that came and went in the skipped time began «ago» days before the end of these messages
        const type = scene.period === 'over' ? 'period_started' : `period_${scene.period}`;
        const days = scene.period === 'over' ? Math.max(ago, 3) : ago;
        events.push(days ? `${type}:${days}` : type);
    }
    // closeness the messages speak of as past («three weeks ago we slept together»): counted back from the end of them
    for (const past of scene?.past_intimacy ?? []) {
        const daysAgo = Math.round(Number(past?.days_ago));
        if (daysAgo >= 1 && daysAgo <= 120) late.push(`past:${act(past)}:${daysAgo}`);
    }
    const minutes = Math.max(0, Math.round(Number(scene?.minutes) || 0));
    const clock = parseClock(scene?.clock);
    const clockAttr = clock === null ? '' : ` clock="${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}"`;
    const now = afterSkip ? [] : events;
    return `<stork t="+${minutes}m"${clockAttr} ev="${now.join(',')}"${late.length ? ` ev_end="${late.join(',')}"` : ''}/>`;
}

// #endregion

// #region Cards

/**
 * Role-play text without markup: image-generation tags, HTML and markdown images only waste tokens
 * and confuse the reader model.
 */
/**
 * A reply with no story in it: an empty answer of the model, only spaces, only service lines and tags, a lone «...».
 * Reading it would cost a request and move nothing real, so it is not read until it gets a text.
 */
export function isEmptyReply(text) {
    const letters = cleanRpText(String(text ?? '').replace(/<!--[\s\S]*?-->/g, '')).match(/[\p{L}\p{N}]/gu);
    return !letters || letters.length < 3;
}

export function cleanRpText(text) {
    return String(text ?? '')
        .replace(FOREIGN_TRACKERS, '')
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
        .replace(/<[^>]*>/g, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Service lines other trackers make the story model write into the reply. They are not the story, and their time
 * is theirs: Stork keeps its own clock and must not take it from them.
 * [MN: clock: 10:45 | …] — Mnema (5555990); <horae>…</horae>, <horaeevent>…</horaeevent> — Horae; HTML comments.
 */
const FOREIGN_TRACKERS = /\[MN:[^\]]*\]|<(horae\w*)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi;

/** Reads "22:40" style time into minutes of the day, or null. */
export function parseClock(text) {
    const match = String(text ?? '').match(/^(\d{1,2})[:.](\d{2})$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}


/** Ways of writing one's own age that cannot mean anything else. \b does not see Cyrillic: Unicode classes instead. */
const AGE_PATTERNS = [
    /(?:возраст|age)\s*[:=\-–]?\s*(\d{1,2})\b/i,
    /(?<!\d)(\d{1,2})\s*-?\s*летн(?:ий|яя|его|ей|юю|ему|ем|ие|их)(?![\p{L}])/iu,
    /\b(\d{1,2})\s*(?:-|\s)?(?:years?[\s-]*old|y\.?\s?o\.?)\b/i,
    /(?<![\p{L}])(?:ей|ему|мне|тебе)\s+(?:(?:уже|почти|только|всего|скоро|исполнилось|за)\s+)?(\d{1,2})\s*(?:лет|года|год)(?![\p{L}])/iu,
];
/** A bare «12 лет» is often not an age at all: work, marriage, «10 лет назад», a child's age. */
const BARE_AGE = /(?<!\d)(\d{1,2})\s*-?\s*(?:лет|года|год)(?![\p{L}])/giu;
// Looked for in the same part of the sentence (up to a comma): «работает в компании 12 лет» is not an age,
// «работает официанткой, 17 лет» is. Kept narrow on purpose: a missed adult age falls back to a default,
// a missed minor must not happen.
const NOT_OWN_AGE_BEFORE = /(?<![\p{L}])(?:через|за|в течение|спустя|последние|стаж\p{L}*|опыт\p{L}*|работает|работал\p{L}*|служит|служил\p{L}*|компании|фирме|вместе|женаты?|замужем|в браке|знакомы|встречаются|дочер\p{L}*|дочк\p{L}*|сын\p{L}*|брат\p{L}*|сестр\p{L}*|ребён\p{L}*|ребен\p{L}*|дети|детей|детям|племянни\p{L}*)(?![\p{L}])/iu;
// right after the number, without a comma: «12 лет назад», «5 лет замужем»; «25 лет, замужем» is an age
const NOT_OWN_AGE_AFTER = /^\s*(?:уже\s+)?(?:назад|спустя|подряд|стажа|опыта|работы|службы|брака|отношений|тюрьмы|заключения|замужем|женаты?|в браке|работает|служит|знакомы|вместе|встречаются)(?![\p{L}])/iu;

/** Finds an age written in a card, or null. */
export function guessAge(text) {
    const source = String(text ?? '');
    const valid = age => (age >= 10 && age <= 99 ? age : null);
    for (const pattern of AGE_PATTERNS) {
        const age = valid(Number(source.match(pattern)?.[1]));
        if (age) return age;
    }
    for (const match of source.matchAll(BARE_AGE)) {
        const before = source.slice(Math.max(0, match.index - 40), match.index).split(/[.!?\n;,]/).at(-1);
        const after = source.slice(match.index + match[0].length, match.index + match[0].length + 20);
        if (NOT_OWN_AGE_BEFORE.test(before) || NOT_OWN_AGE_AFTER.test(after)) continue;
        const age = valid(Number(match[1]));
        if (age) return age;
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
const weeks = n => `${n} week${n === 1 ? '' : 's'}`;

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
    // the dice said yes before ovulation: until that day her body is still in its cycle
    if (f.pregnancy && day >= f.pregnancy.conceptionDay) {
        const p = f.pregnancy;
        const info = pregnancyInfo(p, day);
        const knows = p.knownBy.includes(person.key);
        if (p.labor) {
            const progress = laborProgress(p.labor, absMinute(state.clock));
            return `${name}${age}: IN LABOR — ${progress.stage === 'pushing' ? 'pushing' : progress.stage === 'active' ? 'active contractions' : 'early contractions'}, every ${progress.intervalMinutes} min${progress.waterBroken ? ', her water has broken' : ''}. This comes first in the scene.`;
        }
        if (!knows) {
            const hints = info.week >= 5 ? info.symptoms.slice(0, 2).join(', ') : 'no signs yet';
            return `${name}${age}: pregnant (${weeks(info.week)}) but does NOT know it yet. Only hints may show: ${hints}. Never name the cause.`;
        }
        const parts = [`${name}${age}: pregnant, ${weeks(info.week)} (trimester ${info.trimester}), ${days(Math.max(0, info.daysToDue))} to the due date. Belly: ${BELLY_EN[info.belly] ?? info.belly}.`];
        const partner = partnerOf(state, person.key);
        if (partner && !p.knownBy.includes(partner.key)) parts.push(`${partner.name || 'He'} does not know about the pregnancy yet.`);
        if (detailed) {
            if (info.symptoms.length) parts.push(`Feels: ${info.symptoms.join(', ')}.`);
            parts.push(`The baby is the size of ${info.baby.compare}${info.kicksFelt ? ', kicks' : ''}.`);
            parts.push(`Craves ${p.cravings.join(' and ')}; can't stand ${p.aversions.join(', ')}.`);
            if (p.babies > 1) parts.push('Twins.');
            if (p.sexKnown) parts.push(`The baby is ${p.sexes.map(s => (s === 'девочка' ? 'a girl' : 'a boy')).join(' and ')} — settled, never change it.`);
        }
        // what the story itself has established about this pregnancy: kept, whatever the detail level
        if (p.facts?.length) parts.push(`Established in the story: ${p.facts.map(f => `${f.text} (week ${f.week})`).join('; ')}.`);
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
        const habits = Object.entries(FEMALE_HABITS).filter(([key]) => f[key]).map(([, h]) => h.en);
        if (habits.length) parts.push(`Habits: ${habits.join(', ')}.`);
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

// #region His desire: the body, his nature, abstinence, her, the story

const TENSION_HALF_HOURS = 36;     // built-up desire fades by half in a day and a half without release
const DESIRE_STRONG = 0.78;        // above it the model is told once that it has built up
/** One word for his desire, the same everywhere it is said: «сильное» from where the story model is told so. */
export const desireWord = level => (level >= DESIRE_STRONG ? 'сильное' : level > 0.55 ? 'обычное' : 'сниженное');
const HOT_RE = /high libido|strong libido|insatiab|hot-blooded|высок\S*\s+либидо|ненасыт|темпераментн|страстн\S*\s+натур/i;
const COOL_RE = /low libido|cold|reserved in bed|asexual|низк\S*\s+либидо|холод|равнодуш\S*\s+к\s+секс/i;
/** His temperament: set by hand or from the cards; older chats guess it from what the cards said about him in bed. */
export function temperamentOf(state, person) {
    const m = person?.male;
    if (m?.temperament) return m.temperament;
    const text = [state.intim?.profile?.char, ...(state.intim?.kinks ?? []).filter(k => k.from !== 'persona').map(k => k.name)].filter(Boolean).join(' ');
    return HOT_RE.test(text) ? 'high' : COOL_RE.test(text) ? 'low' : 'normal';
}
/** What built up in the story (her teasing, closeness, his own turn-ons), faded by the hours since. */
export function tensionNow(state) {
    const d = state.desire;
    if (!d?.tension) return 0;
    const hours = Math.max(0, (absMinute(state.clock) - (d.at ?? 0)) / 60);
    return d.tension * Math.pow(0.5, hours / TENSION_HALF_HOURS);
}
/**
 * His desire for her now, 0-1, with the reasons: in Russian for the windows, in English for the story model.
 * The body (testosterone through the day and the years, drink, stress, sleep, illness), his nature (the card),
 * abstinence, her fertile days, what built up in the story, and how the story shows him now.
 */
export function maleDesire(state, person, s = maleSnapshot(state, person)) {
    const m = person.male;
    const now = absMinute(state.clock);
    const ru = [], en = [];
    // the body's own level, kept off the ceiling so the other causes can still add up:
    // a man of 33 is about 0.78 in the morning, 0.64 by day, 0.53 late at night
    let v = 0.2 + 0.6 * s.libido;
    const temper = temperamentOf(state, person);
    if (temper === 'high') { v += 0.12; ru.push('горячий по натуре'); en.push('hot-blooded by nature, per his card'); }
    else if (temper === 'low') { v *= 0.8; ru.push('сдержан по натуре'); en.push('cool by nature, per his card'); }
    // abstinence: right after release it is lower; from the third day it grows, for about a week
    const last = m.lastOrgasmMinute;
    if (last !== null && last !== undefined && now >= last) {
        const hours = (now - last) / 60;
        if (hours < 12) { ru.push('недавно была разрядка'); en.push('satisfied not long ago'); }
        else if (hours >= 48) {
            const d = Math.floor(hours / 24);
            v += 0.24 * Math.min(1, (abstinence(state, person.key)?.pct ?? 0) / 100);
            ru.push(`${d} дн. без разрядки`);
            en.push(`${d} days without release`);
        }
    } else if ((abstinence(state, person.key)?.days ?? 0) >= 2) {
        // nothing known of him before the story: the days of the story itself count
        const a = abstinence(state, person.key);
        v += 0.24 * Math.min(1, a.pct / 100);
        ru.push(`${a.days} дн. без разрядки`);
        en.push(`${a.days} days without release`);
    }
    const hour = Math.floor(state.clock.minutes / 60);
    if (hour >= 5 && hour < 11) { ru.push('утро'); en.push('morning, his testosterone peak'); }
    // her fertile days: her scent, her voice, how she moves — it acts on him, a little
    const woman = Object.values(state.people).find(p => p.sex === 'female');
    if (woman?.female && !woman.female.pregnancy) {
        const f = femaleState(woman.female, state.clock.day);
        if (f.fertile && !pillState(woman.female, state.clock.day).suppressed) { v += 0.06; ru.push('её фертильные дни'); en.push('her fertile days (her scent and nearness act on him more)'); }
    }
    const seenLabels = new Set();
    for (const e of s.recent.filter(x => (x.type === 'stress' ? x.daysAgo <= 3 : x.daysAgo <= 1) && LIFESTYLE[x.type]?.libido)) {
        if (seenLabels.has(e.label)) continue;
        seenLabels.add(e.label);
        const up = LIFESTYLE[e.type].libido < 0;
        ru.push(`${e.label}${up ? ' раскрепощает' : ' гасит'}`);
        en.push(`${e.type.replace('_', ' ')} ${up ? 'loosens him up' : 'dampens it'}`);
    }
    if (s.expectingFather) { ru.push('будущий отец: гормоны ниже'); en.push('expecting father: his hormones are lower'); }
    if (realism.health) {
        const ill = healthOnBody(state, person.key);
        if (ill.desire) { v += ill.desire; ru.push(...ill.ru); en.push(...ill.en); }
    }
    const tension = tensionNow(state);
    if (tension > 0.12) {
        v += 0.3 * tension;
        const why = state.desire?.trigger;
        ru.push(why ? `завело: ${why}` : 'накопилось напряжение');
        en.push(`built up in the story${why ? ` (${why})` : ''}`);
    }
    const level = withLive(v, liveNow(state, person.key).libido);
    return { level: Math.max(0, Math.min(1, level)), ru, en, temper, tension };
}

/** Days without release to the full strain, by his nature: a hot-blooded man feels it sooner, a cool one later. */
const ABSTAIN_DAYS = { high: 5, normal: 8, low: 14 };
const HER_ABSTAIN_DAYS = 10;
/**
 * How long one of them has gone without release: him since his last orgasm (with her or alone), her since her
 * orgasm or their closeness. Before any is known, counted from the start of the story («known» false).
 * @returns {null|{ hours: number, days: number, pct: number, known: boolean }} pct: 0-100 of what their nature bears
 */
export function abstinence(state, key) {
    const person = state.people?.[key];
    if (!person) return null;
    const now = absMinute(state.clock);
    let last = null;
    if (person.sex === 'male') last = person.male?.lastOrgasmMinute ?? null;
    else {
        const acts = (state.acts ?? []).filter(a => a.woman === key && Number.isFinite(a.minute) && a.minute <= now).map(a => a.minute);
        const times = [person.female?.lastOrgasmMinute, ...acts].filter(x => Number.isFinite(x) && x <= now);
        last = times.length ? Math.max(...times) : null;
    }
    const known = last !== null && last !== undefined;
    const hours = Math.max(0, (now - (known ? last : 0)) / 60);
    const need = (person.sex === 'male' ? ABSTAIN_DAYS[temperamentOf(state, person)] ?? ABSTAIN_DAYS.normal : HER_ABSTAIN_DAYS) * 24;
    return { hours, days: Math.floor(hours / 24), pct: Math.min(100, Math.round((hours / need) * 100)), known };
}

/**
 * For the story model: his abstinence when it begins to tell. No ways of showing it on purpose — how it comes out is
 * his card's; it grows until it is released, with her or alone.
 */
function abstinenceLine(state) {
    const man = Object.values(state.people).find(p => p.sex === 'male');
    if (!man || state.intim?.scene?.visible || state.intim?.solo?.visible) return '';
    const a = abstinence(state, man.key);
    if (!a || a.pct < 50 || a.days < 2) return '';
    const name = man.name || '{{char}}';
    const limit = a.pct >= 100 ? ' It is at its limit now and will not wait much longer.' : '';
    return `${name} has had no release for ${a.days} days (abstinence ${a.pct}% of what his nature bears). The strain tells on his temper and mood — in his own way, true to his card, never the same way twice, never the topic — and grows until it is released: with {{user}} if the story gets there, or alone, by his own hand.${limit}`;
}

const EDGE_HOURS = 4;          // an ache after arousal without release lasts about this long
/**
 * What his body feels from going without release. Long abstinence: a heaviness, then a dull ache low in the groin.
 * Arousal that ended without release (a scene broken off when he was close): his testicles ache for a few hours,
 * more the longer he has gone without. Not while a scene or he alone is going on: then it is the scene.
 * @returns {{ stage: number, ru: string, en: string }} stage 0 nothing, 1 heaviness, 2 a dull ache, 3 an ache after arousal
 */
export function maleAche(state, man) {
    const none = { stage: 0, ru: '', en: '' };
    if (!man?.male || state.intim?.scene?.visible || state.intim?.solo?.visible) return none;
    const now = absMinute(state.clock);
    const a = abstinence(state, man.key);
    const edge = state.edge;
    if (edge && (man.male.lastOrgasmMinute ?? -Infinity) < edge.at && now - edge.at <= EDGE_HOURS * 60) {
        const strong = (a?.pct ?? 0) >= 80;
        return { stage: 3, ru: strong ? 'сильно ноют яички: возбуждение без разрядки' : 'ноют яички: возбуждение без разрядки', en: `${strong ? 'a strong' : 'an'} ache in his testicles: he was aroused and did not get release` };
    }
    if ((a?.pct ?? 0) >= 100) return { stage: 2, ru: 'ноющая тяжесть в паху', en: 'a dull ache and heaviness in his groin from going without release' };
    if ((a?.pct ?? 0) >= 60) return { stage: 1, ru: 'тяжесть внизу живота', en: 'a heaviness and tension low in his groin from going without release' };
    return none;
}

/**
 * After a reply: arousal that broke off without release is remembered; the ache is told to the story model only when it
 * comes or grows, and then at most once in half a day of story — not in every reply.
 */
function trackAche(state) {
    const man = Object.values(state.people).find(p => p.sex === 'male');
    if (!man) return;
    const now = absMinute(state.clock);
    const sc = state.intim?.scene;
    if (sc?.visible && (sc.char?.climax ?? 0) >= 50) state.edge = { at: now };
    else if (state.intim?.solo?.visible && (state.intim.solo.climax ?? 0) >= 50) state.edge = { at: now };
    if (state.edge && (man.male.lastOrgasmMinute ?? -Infinity) >= state.edge.at) state.edge = null;
    const ache = maleAche(state, man);
    const was = state.ache ?? { stage: 0, told: null };
    const due = was.told === null || was.told === undefined || now - was.told >= 12 * 60;
    if (ache.stage > 0 && (ache.stage > was.stage || due)) {
        state.pending.push({ who: man.key, text: `${man.name || '{{char}}'} feels ${ache.en}`, day: state.clock.day });
        state.ache = { stage: ache.stage, told: now };
    } else state.ache = { stage: ache.stage, told: was.told ?? null };
}

/** The same words everywhere: «воздержание 4 дн. · 50%», its tone and where it is counted from. */
export function abstinenceView(a, ache = null) {
    if (!a) return null;
    return {
        text: `воздержание ${a.days ? `${a.days} дн.` : `${Math.max(1, Math.round(a.hours))} ч`} · ${a.pct}%${ache?.stage ? ` · ${ache.ru}` : ''}`,
        tone: a.pct >= 100 || (ache?.stage ?? 0) >= 2 ? 'warm' : a.pct >= 60 || ache?.stage ? 'pink' : 'muted',
        why: a.known ? 'с последней разрядки' : 'с начала истории: раньше Stork не знает',
    };
}

const SOLO_GAP_HOURS = 36;
/**
 * His card says he pleasures himself: now and then — strong desire, a day and a half since any release, not with her
 * in a scene, and a day the dice chose (about one day in three) — the story model hears that he might, when alone.
 * Never more: whether and when is the story's.
 */
function soloMoment(state, man, d) {
    if (state.intim?.scene?.visible || state.intim?.solo?.visible) return '';
    const kink = soloKink(state.intim);
    const a = abstinence(state, man.key);
    const atLimit = (a?.pct ?? 0) >= 100;
    // with the kink in his card: when his desire is up or the abstinence tells; without it — only at its limit
    if (kink ? d.level < 0.66 && (a?.pct ?? 0) < 60 : !atLimit) return '';
    const now = absMinute(state.clock);
    const last = Math.max(man.male.lastOrgasmMinute ?? -Infinity, state.intim?.soloLast ?? -Infinity);
    if (now - last < SOLO_GAP_HOURS * 60) return '';
    if (hashUnit(`solo:${state.clock.day}:${man.name}`) > (atLimit ? 0.75 : 0.35)) return '';
    const why = kink ? 'His card says he takes care of himself alone' : 'His abstinence is at its limit';
    return `${why}: if the story leaves him a moment alone, he may — in his own way, at a moment that fits him; never pushed into the scene, never in front of {{user}} unless the story leads there. `;
}

/**
 * For the story model: his desire as an undercurrent, shown his own way and never the same way twice.
 * No examples of behaviour on purpose: examples become the template every reply copies.
 */
function desireLine(state) {
    const man = Object.values(state.people).find(p => p.sex === 'male');
    if (!man || state.intim?.scene?.visible || state.intim?.solo?.visible) return '';
    const d = maleDesire(state, man);
    const name = man.name || '{{char}}';
    const shown = (state.desire?.shown ?? []).slice(-3);
    const notAgain = shown.length ? ` How it showed lately (do not repeat it, in any wording): ${shown.join('; ')}.` : '';
    const alone = soloMoment(state, man, d);
    if (d.level >= 0.66) {
        return `${alone}${name}'s desire for {{user}} is ${d.level >= DESIRE_STRONG ? 'strong' : 'noticeable'} now (${d.en.join(', ') || 'his body'}). It is a real undercurrent in him: let it surface only in ways true to his card — his temper, his manner, his restraint or directness, his history with her — and only where the scene allows; often it stays under the surface.${notAgain} Never the topic of the reply, never the same way twice; {{user}} decides where it goes.`;
    }
    if (d.level <= 0.33) return `${alone}${name}'s desire is low now (${d.en.join(', ') || 'his body'}): if it shows at all, it shows his own way, never as the topic.`;
    return alone.trim();
}

// #endregion

// #region How they are by the story

/**
 * What this reply did to his desire: a turn-on of his the story showed, his arousal by the reading, closeness that is
 * near; his climax releases it all. How it showed is remembered, so the next reply finds another way.
 * When it crosses into «strong», the story model is told once.
 */
function applyDesire(state, scene, startedAt, before) {
    const man = Object.values(state.people).find(p => p.sex === 'male');
    if (!man) return;
    const d = state.desire ?? { tension: 0, at: absMinute(state.clock), trigger: null, shown: [], notedAt: null };
    const now = absMinute(state.clock);
    let tension = tensionNow(state);
    const c = scene?.people?.char ?? {};
    const trigger = typeof c.desire_trigger === 'string' && c.desire_trigger.trim() && !/^null$/i.test(c.desire_trigger.trim()) ? c.desire_trigger.trim().slice(0, 60) : null;
    if (trigger) { tension += 0.22; d.trigger = trigger; }
    const lib = Number(c.libido);
    if (lib > 0) tension += 0.06 * lib;
    if (scene?.closeness === 'near') tension += 0.1;
    const released = (man.male.lastOrgasmMinute ?? -1) >= startedAt;
    if (released) { tension = 0; d.trigger = null; d.shown = []; }
    d.tension = Math.min(1, tension);
    d.at = now;
    const shown = typeof c.desire_shown === 'string' && c.desire_shown.trim() && !/^null$/i.test(c.desire_shown.trim()) ? c.desire_shown.trim().slice(0, 60) : null;
    if (shown && !released) d.shown = [...(d.shown ?? []), shown].slice(-4);
    state.desire = d;
    const after = maleDesire(state, man);
    if (before < DESIRE_STRONG && after.level >= DESIRE_STRONG && (d.notedAt === null || d.notedAt === undefined || now - d.notedAt > 12 * 60) && !state.intim?.scene?.visible) {
        d.notedAt = now;
        note(state, man, `${man.name || 'Его'}: желание к ней сильное${d.trigger ? ` · завело: ${d.trigger}` : ''}`, { kind: 'desire' });
    }
}

/** Story-driven state fades over half a day; the note stays a day. */
const LIVE_FADE_HOURS = 12;
export function liveNow(state, key) {
    const l = state.live?.[key];
    if (!l) return { energy: 0, libido: 0, note: null, mood: null, spermNote: null };
    const hours = (absMinute(state.clock) - l.at) / 60;
    const k = Math.max(0, 1 - hours / LIVE_FADE_HOURS);
    // the sperm note speaks of days, not of the moment: it stays three days of story time
    const spermHours = l.spermAt === null || l.spermAt === undefined ? Infinity : (absMinute(state.clock) - l.spermAt) / 60;
    return { energy: (l.energy ?? 0) * k || 0, libido: (l.libido ?? 0) * k || 0, note: hours < 24 ? l.note : null, mood: hours < LIVE_FADE_HOURS ? l.mood : null, spermNote: spermHours < 72 ? l.spermNote ?? null : null, hours };
}
/** A level 0-1 with the story's offset (-3..3) on top of the body's own level. */
export const withLive = (base, offset) => Math.min(1, Math.max(0, base + 0.15 * (offset ?? 0)));
/**
 * His energy before the story's offset. Testosterone only nudges it: the evening dip is real but small and is
 * not tiredness. Taken 1:1, it made him «tired» every evening from about 15:00 to 01:00 whatever the story said,
 * and the status pushed the role-play model to show it. Now he is in his usual shape by default (about 0.67-0.82
 * at 30-40) and gets tired from the story (the analysis' energy −1 and lower) or with age.
 */
export const maleBaseVigor = t => 0.75 + 0.3 * ((t ?? 0.75) - 0.75);
/** His energy now, 0-1: the body and what the story shows. */
export const maleVigor = (state, person, snapshot = maleSnapshot(state, person)) => withLive(maleBaseVigor(snapshot.testosterone) + (realism.health ? healthOnBody(state, person.key).energy : 0), liveNow(state, person.key).energy);

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
        // his sperm, as the latest scene bears on it: a conclusion of its own, kept until a newer one comes
        const spermNote = typeof p.sperm_note === 'string' && p.sperm_note.trim() ? p.sperm_note.trim().slice(0, 300) : null;
        if (energy === null && libido === null && !note && !mood && !spermNote) continue;
        state.live[key] = {
            energy: energy ?? liveNow(state, key).energy,
            libido: libido ?? liveNow(state, key).libido,
            note: note ?? prev.note ?? null,
            mood: mood ?? prev.mood ?? null,
            spermNote: spermNote ?? prev.spermNote ?? null,
            spermAt: spermNote ? absMinute(state.clock) : prev.spermAt ?? null,
            at: absMinute(state.clock),
        };
    }
}
/**
 * The story so far for the analysis prompt: one line per earlier reply with its story time, «пт 16 янв 10:45 — …».
 * Each reply keeps only its own line (state.lastLine), so a deep memory costs nothing in the chat file,
 * and a swipe or a deleted message takes its line away with it.
 * @param {{at: number, text: string}[]} lines oldest first
 */
export function timelineText(state, lines = []) {
    return lines.map(e => {
        const day = Math.floor(e.at / MINUTES_PER_DAY);
        const date = storyDate(state, day);
        const when = date ? `${date.toLocaleDateString('ru-RU', { weekday: 'short' })} ${shortDate(state, day)}` : `день ${day + 1}`;
        return `${when} ${clockText(e.at % MINUTES_PER_DAY)} — ${e.text}`;
    }).join('\n');
}

/**
 * What the story establishes about her pregnancy (a strong nausea, what the midwife said, a threat, twins by the
 * doctor's word) is kept with the pregnancy itself: it goes back to both models and shows in the window, so the
 * course of the pregnancy is remembered however long ago it was told. Short, unique, the newest dozen.
 */
const MAX_PREGNANCY_FACTS = 12;
function addPregnancyFacts(state, facts) {
    const woman = Object.values(state.people).find(p => p.sex === 'female');
    const p = woman?.female.pregnancy;
    if (!p || !p.knownBy.includes(woman.key) || !Array.isArray(facts)) return;
    p.facts ??= [];
    const key = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const week = pregnancyInfo(p, state.clock.day).week;
    for (const raw of facts) {
        const text = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').slice(0, 120) : '';
        if (!text || p.facts.some(f => key(f.text) === key(text))) continue;
        p.facts.push({ week, text });
    }
    if (p.facts.length > MAX_PREGNANCY_FACTS) p.facts.splice(0, p.facts.length - MAX_PREGNANCY_FACTS);
}

const SEX_WORD = { girl: 'девочка', boy: 'мальчик', female: 'девочка', male: 'мальчик', 'девочка': 'девочка', 'мальчик': 'мальчик' };
/**
 * The baby's sex as the story states it (a doctor, an ultrasound, she tells it): it replaces what the dice chose
 * at conception, and from then on nothing re-rolls it. «girl», «boy», or a list for twins.
 * @returns {boolean} something changed
 */
export function setBabySex(state, value, { from = 'story' } = {}) {
    const woman = Object.values(state.people).find(p => p.sex === 'female');
    const p = woman?.female.pregnancy;
    if (!p) return false;
    const list = (Array.isArray(value) ? value : [value]).map(v => SEX_WORD[String(v ?? '').toLowerCase().trim()]).filter(Boolean);
    if (!list.length) return false;
    const babies = Math.max(p.babies ?? 1, list.length);
    const sexes = Array.from({ length: babies }, (_, i) => list[i] ?? list[list.length - 1]);
    const changed = !p.sexKnown || babies !== p.babies || sexes.join() !== p.sexes.join();
    p.babies = babies;
    p.sexes = sexes;
    p.sexKnown = true;
    p.sexFrom = from;
    if (changed && from === 'story') note(state, woman, `${woman.name || 'Она'}: пол малыша — ${sexes.join(' и ')}`, { model: false, kind: 'doctor' });
    return changed;
}

// #region Injuries: noted once, heal in their own time

const HEAL_DAYS = [[/перелом|сломан|трещин/i, 42], [/растяжен|вывих|связк|надрыв/i, 14], [/ожог/i, 10], [/синяк|ушиб|гематом|кровоподт/i, 8], [/порез|рана|рассеч|шов|швы/i, 7], [/ссадин|царапин|содран/i, 5], [/засос|укус|след/i, 4]];
/** Days to heal: what the reading says, else by the word, else a week. */
export function healDays(what, given) {
    const n = Math.round(Number(given));
    if (n >= 1 && n <= 90) return n;
    for (const [re, days] of HEAL_DAYS) if (re.test(what)) return days;
    return 7;
}
const injuryStems = s => String(s ?? '').toLowerCase().split(/[^\p{L}\d]+/u).filter(w => w.length > 3).map(w => w.slice(0, 5));
/** The same injury in other words: «ссадина на колене» and «ссадины на коленях»; not «синяк на руке» and «синяк на бедре». */
export function sameInjury(a, b) {
    const x = new Set(injuryStems(a)), y = new Set(injuryStems(b));
    if (!x.size || !y.size) return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
    const both = [...x].filter(w => y.has(w)).length;
    return both / new Set([...x, ...y]).size >= 0.5;
}
/** Older chats noted injuries only in the journal: they count as a week each. */
function injuriesOf(state) {
    if (Array.isArray(state.injuries)) return state.injuries;
    return state.log.filter(e => e.kind === 'injury').map(e => {
        const at = e.day * MINUTES_PER_DAY + (e.minutes ?? 0);
        const what = e.text.replace(/^[^:]*:\s*/, '');
        return { who: e.who, what, since: at, heals: at + healDays(what) * MINUTES_PER_DAY };
    });
}
/** Injuries not healed yet, newest last. */
export function activeInjuries(state) {
    const now = absMinute(state.clock);
    return injuriesOf(state).filter(i => i.heals > now);
}

/** Injuries are noted, not turned into an illness: a bruise does not give a fever. */
function applyInjuries(state, injuries) {
    const now = absMinute(state.clock);
    state.injuries = injuriesOf(state).filter(i => i.heals > now);
    for (const item of injuries ?? []) {
        const person = state.people[item?.who];
        const what = typeof item?.what === 'string' ? item.what.trim().slice(0, 80) : '';
        if (!person || !what) continue;
        // the same bruise told again in the next reply is not a new one
        if (state.injuries.some(i => i.who === person.key && sameInjury(i.what, what))) continue;
        state.injuries.push({ who: person.key, what, since: now, heals: now + healDays(what, item.heal_days) * MINUTES_PER_DAY });
        note(state, person, `${person.name || 'Он'}: ${what}`, { model: false, kind: 'injury' });
    }
}

/** For the story model: healing injuries, to matter only where the body meets them. */
function injuryLine(state) {
    const list = activeInjuries(state);
    if (!list.length) return '';
    const items = list.map(i => `${state.people[i.who]?.name || i.who} — ${i.what}`).join('; ');
    return `Healing injuries: ${items}. They show only where the body meets them — a touch, a movement, a position — never as a topic of their own.`;
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
        const vigor = maleVigor(state, person, s), desire = maleDesire(state, person, s);
        parts.push(vigor > 0.85 ? 'full of energy, at his peak.' : vigor > 0.65 ? 'in his usual shape.' : 'tired.');
        // the reasons go into the desire guidance when there is one; in the middle range they stay here
        const guided = !state.intim?.scene?.visible && (desire.level >= 0.66 || desire.level <= 0.33);
        parts.push(`Desire ${level(desire.level)}${desire.en.length && !guided ? ` (${desire.en.join(', ')})` : ''}.`);
        if (s.erection < 0.75) parts.push('His erection may let him down (stress, tiredness or drink).');
        else if (!realism.erectionDrops && s.recent.some(x => x.daysAgo <= 1 && LIFESTYLE[x.type]?.erection)) parts.push('Whatever the day was like, his erection does not let him down.');
        if (s.daysSinceLast !== null) parts.push(`Last intimacy ${s.daysSinceLast === 0 ? 'today' : `${days(s.daysSinceLast)} ago`}.`);
        const left = recoveryLeft(state, person);
        if (left > 0) parts.push(`Still recovering after his climax: ready again in about ${left} min of story time.`);
        const recent = s.recent.filter(e => e.daysAgo <= 3).map(e => e.label);
        if (recent.length) parts.push(`Lately: ${[...new Set(recent)].join(', ')}.`);
        const habits = [person.male.smoker && 'smokes', person.male.drinker && 'drinks often'].filter(Boolean);
        if (habits.length) parts.push(`Habits: ${habits.join(', ')}.`);
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

/** The part of the day in words, with the same boundaries as Mnema (5555990): both blocks name it alike. */
export function timeLabel(minutes) {
    const h = Math.floor(minutes / 60) % 24;
    if (h < 6) return 'ночь';
    if (h < 12) return 'утро';
    if (h < 18) return 'день';
    return 'вечер';
}

/** «10:45» */
export const clockText = minutes => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

const SHORT_MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
/** «16 янв» or «16 янв 2026»: the date the way Mnema (5555990) writes it, so the two blocks read the same. */
export function shortDate(state, day = state.clock.day, withYear = false) {
    const date = storyDate(state, day);
    if (!date) return `день ${day + 1}`;
    return `${date.getDate()} ${SHORT_MONTHS[date.getMonth()]}${withYear ? ` ${date.getFullYear()}` : ''}`;
}

/**
 * The text the model gets before its reply.
 * @param {object} options
 * @param {boolean} [options.detailed]
 * @param {boolean} [options.neutral] Softer words for strict providers
 * @param {boolean} [options.withTag] Ask for the tracker tag
 * @param {boolean} [options.guide] How to play the states out: for the story model, not for the scene analysis
 */
export function buildStatus(state, { detailed = true, neutral = false, withTag = true, guide = true, withTime = true, extra = '' } = {}) {
    const hh = String(Math.floor(state.clock.minutes / 60)).padStart(2, '0'), mm = String(state.clock.minutes % 60).padStart(2, '0');
    const date = storyDate(state);
    const when = date ? `${date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}, ${hh}:${mm}` : `story day ${state.clock.day + 1}, ${hh}:${mm}`;
    // withTime false: another tracker already tells the story model the time, and two clocks only confuse it
    const lines = [`[Stork — the bodies of ${state.people.char.name || '{{char}}'} and ${state.people.user.name || '{{user}}'}; background for the story, not its topic${withTime ? ` | ${when}` : ''}]`];
    for (const person of [state.people.char, state.people.user]) {
        lines.push(person.sex === 'female' ? femaleLine(state, person, detailed) : maleLine(state, person, detailed));
    }
    const hurts = injuryLine(state);
    if (hurts) lines.push(hurts);
    const want = desireLine(state);
    if (want) lines.push(want);
    const strain = abstinenceLine(state);
    if (strain) lines.push(strain);
    if (realism.health) {
        const woman = Object.values(state.people).find(p => p.sex === 'female');
        const health = healthPrompt(state, { char: state.people.char.name, user: state.people.user.name }, { pregnant: !!woman?.female?.pregnancy?.knownBy?.includes(woman.key) });
        if (health) lines.push(health);
    }
    const pending = freshPending(state);
    if (pending.length) {
        lines.push(`Just happened — let it show once in this reply, in a natural way: ${pending.map(e => e.text).join('; ')}.`);
    }
    const user = state.people.user.name || '{{user}}';
    if (guide) lines.push(`Let these states show in the reply through bodies and behaviour — movement, reactions, appetite, tiredness or strength, desire or its absence — in small touches that fit the scene. Never state numbers, phases or this block itself. ${user}'s state shows only in what can be seen or what others notice; never write ${user}'s thoughts, feelings, words or choices. The scene always comes first.`);
    if (withTag) lines.push(TAG_INSTRUCTION);
    // the intimate scene's own guidance (the director), when one is near or going on
    if (extra) lines.push(extra);
    let text = lines.join('\n');
    if (neutral) for (const [re, word] of NEUTRAL) text = text.replace(re, word);
    return text;
}

// #endregion

/**
 * Processes one model reply: clears what the model was told, applies the tag.
 * @returns {{state: object, tag: object}}
 */
export function processReply(previousState, replyText, rng = Math.random, scene = null, { storyClock = null } = {}) {
    const state = upgradeState(cloneState(previousState));
    state.pending = [];
    state.lastLine = null;
    const tag = parseTag(replyText);
    const quote = scene?.pregnancy_claim?.quote;
    if (quote) for (const event of [...tag.events, ...(tag.eventsEnd ?? [])]) if (event.type === 'pregnancy_claim') event.quote = quote;
    const wasRecovering = recoveryLeft(state) > 0;
    const startedAt = absMinute(state.clock);
    // the baby's sex the story names wins over the dice: before an ultrasound of this reply shows the sex
    if (scene?.baby_sex) setBabySex(state, scene.baby_sex);
    // Events happen before the time of the reply passes (intimacy, then the night)
    for (const event of tag.events) applyEvent(state, event, rng);
    const clock = tag.clock ?? extractClock(replyText);
    const skip = scene?.scene_after_skip === true || (tag.eventsEnd ?? []).length > 0;
    if (storyClock && (storyClock.minutes !== null || storyClock.passed !== null)) {
        // the story model's own time line (as in Almanac): the moment the reply ends, never back
        const by = advanceByLine({ startDate: state.startDate, day: state.clock.day, minutes: state.clock.minutes, dateSure: state.dateSure }, storyClock);
        advanceTime(state, by.advance, rng);
        if (by.setMinutes !== undefined) state.clock.minutes = by.setMinutes;
        if (by.anchorIso) {
            // the calendar was a guess: the line's date is today, the cycle and everything else stay where they are
            const base = new Date(`${by.anchorIso}T12:00:00Z`);
            base.setUTCDate(base.getUTCDate() - state.clock.day);
            state.startDate = base.toISOString().slice(0, 10);
            state.dateSure = true;
        }
        state.timeNote = { passed: Math.max(0, absMinute(state.clock) - startedAt), why: storyClock.why ?? null, by: storyClock.from ?? 'story', note: by.note };
    } else {
        const info = {};
        advanceTime(state, storyMinutes(state, { clock, minutes: tag.minutes, date: scene?.date, part: scene?.part_of_day, skip, told: parseSkip(replyText), info }), rng);
        state.timeNote = { passed: absMinute(state.clock) - startedAt, why: null, by: 'reading', note: info.note ?? null };
    }
    // ...and what came after the time skip happens at the new moment
    for (const event of tag.eventsEnd ?? []) applyEvent(state, event, rng);
    if (scene) {
        // his desire before this reply moved it: the reading's «aroused» counts as part of the change
        const man = Object.values(state.people).find(p => p.sex === 'male');
        const desireBefore = man ? maleDesire(state, man).level : 0;
        applyPeople(state, scene.people);
        applyDesire(state, scene, startedAt, desireBefore);
        if (realism.health && Array.isArray(scene.health)) healthBody(state, applyHealth(state, scene.health, rng, healthLog(state)), rng);
        applyInjuries(state, scene.injury);
        addPregnancyFacts(state, scene.pregnancy_facts);
        // a relative the story names for the first time, a wedding: onto the family tree
        for (const text of applyFindings(state, scene.family, 'story')) note(state, null, `Семья: ${text}`, { model: false, kind: 'family' });
        // this reply's line of the story so far: the analysis of later replies gathers them from the chat
        const line = typeof scene.summary === 'string' ? scene.summary.trim().replace(/\s+/g, ' ').slice(0, 160) : '';
        if (line) state.lastLine = { at: absMinute(state.clock), text: line };
        // the world of the story, once: the care of a pregnancy follows it (a doctor or a midwife)
        if (!state.eraSet && (scene.era === 'past' || scene.era === 'modern')) state.era = scene.era === 'past' ? 'traditional' : 'modern';
        // the intimate scene (the director): only when this reading carried it
        if (scene.closeness !== undefined || scene.afterglow !== undefined) {
            applyIntimacy(state, scene, { at: absMinute(state.clock), minutes: absMinute(state.clock) - startedAt });
        }
    }
    // He was recovering and the story time ran out: tell once
    const man = state.people.char;
    if (wasRecovering && recoveryLeft(state) <= 0 && man?.sex === 'male') {
        note(state, man, `${man.name || 'Он'}: силы восстановились`, { model: false, kind: 'recovered' });
    }
    trackAche(state);
    state.pending = freshPending(state);
    return { state, tag: { ...tag, clock } };
}

const PART_MINUTES = { morning: 8 * 60, day: 13 * 60, evening: 19 * 60, night: 23 * 60 };
/**
 * A date that jumps by more than two days beyond what the story counts as passed — and by more than twice that —
 * corrects the calendar instead of moving time: «12 декабря» named in a scene of 25 minutes is not 300 days lived.
 */
export const isRedate = (jump, counted) => jump - counted > 2 * MINUTES_PER_DAY && counted < jump / 2;
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
export function storyMinutes(state, { clock = null, minutes = 0, date = null, part = null, skip = false, told = 0, info = {} } = {}) {
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? '')) ? date : null;
    let anchoring = validDate && (!state.dateSure || !state.startDate);
    // A new day needs the story to move there: a time skip, or the analysis counting hours. A date or a time of day
    // alone (a letter, a plan, «tomorrow morning» said aloud) is not a reason to turn the calendar.
    const longScene = skip || minutes >= 3 * 60;
    const sameDay = advance => longScene || state.clock.minutes + advance < MINUTES_PER_DAY;
    if (validDate && !anchoring) {
        const target = dayOfDate(state, validDate);
        if (target !== null && target > state.clock.day && (skip || minutes >= 6 * 60)) {
            const at = clock ?? (part && PART_MINUTES[part]) ?? state.clock.minutes;
            const jump = (target - state.clock.day) * MINUTES_PER_DAY + at - state.clock.minutes;
            // A date far beyond the time these messages count, and no words of a skip in them: the calendar was
            // wrong (a date set by hand, a guess kept), not months passing. It is re-dated; nothing is lived through.
            const counted = Math.max(0, minutes, told);
            if (!isRedate(jump, counted)) return jump;
            anchoring = true;
            info.note = `дата сверена с историей: ${validDate.split('-').reverse().join('.')} — это не скачок времени`;
        }
    }
    // the calendar is a guess and the reading counted the days from that guess to the story's date: those days are
    // the guess's error, not story time — only the hours of the scene count
    if (anchoring && !told && minutes > 2 * MINUTES_PER_DAY) {
        const gap = (dayOfDate(state, validDate) ?? Infinity) - state.clock.day;
        if (Math.abs(minutes / MINUTES_PER_DAY - gap) <= 1.5) minutes %= MINUTES_PER_DAY;
    }
    let advance = minutes;
    if (clock !== null) {
        const byClock = minutesToClock(state.clock.minutes, clock, minutes);
        if (sameDay(byClock)) advance = byClock;
    } else if (part && PART_MINUTES[part] !== undefined && partOf(state.clock.minutes + minutes) !== part) {
        // the story says it is evening now while the clock says morning: move to that part of the day
        const byPart = minutesToClock(state.clock.minutes, PART_MINUTES[part], minutes);
        if (sameDay(byPart)) advance = byPart;
    }
    if (anchoring) {
        // re-anchor: the moment these messages end in («four months later… 26 April») is that date;
        // the cycle and everything else stay where they are
        const endDay = state.clock.day + Math.floor((state.clock.minutes + advance) / MINUTES_PER_DAY);
        const base = new Date(`${validDate}T12:00:00Z`);
        base.setUTCDate(base.getUTCDate() - endDay);
        state.startDate = base.toISOString().slice(0, 10);
        state.dateSure = true;
    }
    return advance;
}

/**
 * Time written in the story wins over a guessed duration: move to the next moment the clock shows that time,
 * keeping the whole days the reader counted (a week later at 09:00).
 */
export function minutesToClock(nowMinutes, clockMinutes, guessedMinutes = 0) {
    const days = Math.floor(Math.max(0, guessedMinutes) / MINUTES_PER_DAY);
    let delta = (clockMinutes - nowMinutes + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    // The same time as now, or a few minutes "earlier": a header the story model copied without moving it, not tomorrow.
    // Then the time these messages took counts, so the clock does not stand still for the whole scene.
    if (!days && (delta === 0 || delta > 18 * 60) && guessedMinutes < 6 * 60) return Math.max(0, guessedMinutes);
    return days * MINUTES_PER_DAY + delta;
}

/** Words for the time of day, the first one the text names wins: «поздно ночью», «утро», «вечер». */
const PART_WORDS = [
    [/полноч|midnight/i, 0], [/рассвет|на заре|dawn/i, 6 * 60], [/(?<!\p{L})утр|(?<!\p{L})morning/iu, 8 * 60],
    [/полдень|(?<!\p{L})обед|noon|lunch/iu, 13 * 60], [/(?<!\p{L})дн[её]м|(?<!\p{L})afternoon/iu, 15 * 60],
    [/(?<!\p{L})вечер|закат|сумерк|(?<!\p{L})evening|sunset|dusk/iu, 19 * 60 + 30], [/(?<!\p{L})ноч|(?<!\p{L})поздн|(?<!\p{L})night|late at night/iu, 23 * 60 + 30],
];
/**
 * The time of day a text plainly suggests when it states no clock: the first time-of-day word in its opening lines.
 * @returns {number|null} minutes of the day
 */
export function guessClock(text) {
    const head = cleanRpText(text).slice(0, 700);
    let best = null;
    for (const [re, minutes] of PART_WORDS) {
        const m = head.match(re);
        if (m && (best === null || m.index < best.at)) best = { at: m.index, minutes };
    }
    return best ? best.minutes : null;
}

const MONTHS_RU = ['январ', 'феврал', 'март', 'апрел', 'ма[йя]', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
/**
 * A date in the header at the start of a message: «15.03.2025», «15.03.25», «2025-03-15», «15 марта 2025».
 * A day and a month without a year take `year` (the analysis' guess, say). Only the first lines count:
 * a date in the middle of the text is a letter or a memory, not the date of the scene.
 * @returns {string|null} ISO date
 */
export function extractDate(text, year = null) {
    const head = cleanRpText(text).slice(0, 300).split('\n').slice(0, 3).join('\n');
    const iso = (y, m, d) => {
        const yy = Number(y) < 100 ? 2000 + Number(y) : Number(y);
        const date = new Date(Date.UTC(yy, Number(m) - 1, Number(d)));
        return date.getUTCDate() === Number(d) && date.getUTCMonth() === Number(m) - 1 ? date.toISOString().slice(0, 10) : null;
    };
    let m = head.match(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/);
    if (m) return iso(m[1], m[2], m[3]);
    m = head.match(/(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})(?![\d.])/);
    if (m) return iso(m[3], m[2], m[1]);
    m = head.match(new RegExp(`(?<!\\d)(\\d{1,2})\\s+(${MONTHS_RU.join('|')})\\p{L}*(?:\\s+(\\d{4}))?`, 'iu'));
    if (m) {
        const month = MONTHS_RU.findIndex(r => new RegExp(`^${r}`, 'iu').test(m[2])) + 1;
        const y = m[3] ?? year;
        return y && month ? iso(y, month, m[1]) : null;
    }
    return null;
}

/** A time header at the start of a reply, like "**22:40, Квартира**". */
export function extractClock(text) {
    const head = cleanRpText(text).slice(0, 300);
    // a line that starts with the time: «21:00», «*21.00*» — but not a date like «15.03.2025»
    const match = head.match(/(?:^|\n)[\s*_#>~[(]*(\d{1,2}[:.]\d{2})(?![\d.\/-]*\d)/);
    if (match) return parseClock(match[1]);
    // a short header line with the time after a separator: «📅 15.03.2025 | 21:00», «Суббота, 21:00, бар»
    for (const line of head.split('\n').slice(0, 3)) {
        if (line.length > 120) continue;
        // only after a separator, never inside a sentence («позвони мне в 22:40»)
        const inner = line.match(/(?:[|•·,—–]|\p{Extended_Pictographic})\s*(\d{1,2}:\d{2})(?![\d:])/u);
        if (inner) return parseClock(inner[1]);
    }
    return null;
}
