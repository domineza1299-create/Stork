/*
 * Stork engine: the story state, time, events from the model and the status text.
 * Pure functions over a plain JSON state, so it is saved with chat messages and tested in Node.
 */
import {
    ACT_PROTECTION, createPregnancy, cycleInfo, cycleReturnDay, DOCTOR_VISITS, falseContractionsToday, FEMALE_CONTRACEPTION,
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
    };
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

    if (rollCycles(f, day, rng)) {
        // Irregular after stopping the pill
        if (pillState(f, day).recovering) f.cycleShift += Math.round((rng() * 2 - 1) * 4);
        f.lateNoticed = [];
        const withdrawalBleed = ['pill', 'ring', 'patch'].includes(f.contraception);
        note(state, person, withdrawalBleed ? `${name}: началось кровотечение отмены (перерыв в контрацепции)` : `${name}: начались месячные`);
    }

    const info = cycleInfo(f, day);
    const pill = pillState(f, day);
    // Decisive roll on ovulation day; hormonal contraception used correctly suppresses ovulation
    if (info.relative === 0 && f.rolledCycle !== f.cycleStart && !pill.suppressed) {
        f.rolledCycle = f.cycleStart;
        const partner = partnerOf(state, person.key);
        const acts = state.acts.filter(a => a.woman === person.key);
        if (partner && acts.some(a => a.day >= day - 5 && a.day <= day)) {
            const result = rollConception({
                acts,
                ovulationAbsoluteDay: day,
                femaleAge: person.age,
                femaleContraception: pill.effective,
                femaleFactor: femaleConditionFactor(f),
                male: partner.male,
                maleAge: partner.age,
                storyMode: state.storyMode ?? 'realistic',
                rng,
            });
            roll(state, { who: person.key, kind: 'conception', chance: result.chance, result: result.conceived, forced: result.forced });
            note(state, person, `Бросок на зачатие: ${Math.round(result.chance * 100)}%, ${result.conceived ? 'получилось' : 'не получилось'}`, { model: false, kind: 'roll' });
            if (result.conceived) {
                f.pregnancy = createPregnancy({ lmp: f.cycleStart, conceptionDay: day, twins: result.twins, births: f.births, rng });
            }
        }
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

// #region Events from the story

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
            if (woman && man) state.acts.push(act);
            if (man) {
                man.male.ejaculations.push(day);
                man.male.lastOrgasmMinute = absMinute(state.clock);
            }
            note(state, null, `близость (${ACT_PROTECTION[protection].label})`, { model: false, kind: 'intimacy' });
            break;
        }
        case 'condom_broke': {
            const act = state.acts.at(-1);
            if (act && act.day === day && !act.condomBroke) {
                act.condomBroke = true;
                note(state, null, 'презерватив порвался');
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
            if (who?.sex === 'male') {
                who.male.ejaculations.push(day);
                who.male.lastOrgasmMinute = absMinute(state.clock);
            }
            break;
        case 'emergency_pill': {
            const woman = who ?? Object.values(state.people).find(p => p.sex === 'female');
            for (const act of state.acts) if (act.woman === woman?.key && day - act.day <= 3) act.emergencyPillDay = day;
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
export const TAG_INSTRUCTION = 'В самом конце ответа добавь одну строку-метку для трекера (она скрыта от читателя): '
    + '<stork t="сколько прошло времени в этом ответе: +15m, +2h, +1d или 0" ev="события через запятую или пусто"/>. '
    + 'События: intimacy:none|condom|withdrawal (близость и защита), orgasm:user|char, test:user|char (тест на беременность), '
    + 'condom_broke, doctor, ultrasound, stress:user|char, illness:user|char, alcohol:user|char, smoking:user|char, '
    + 'cannabis:user|char, sauna:user|char, no_sleep:user|char, pill_missed:user|char, emergency_pill:user|char. '
    + 'Если закончил не внутри, пиши intimacy:withdrawal. Пиши только то, что действительно произошло в этом ответе.';

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
    if (!matches.length) return { found: false, minutes: 0, events: [], clock: null };
    const attrs = Object.fromEntries([...matches.at(-1)[1].matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map(m => [m[1], m[2]]));
    const events = String(attrs.ev ?? '').split(',').map(s => s.trim()).filter(Boolean).map(token => {
        const [type, arg] = token.split(':').map(s => s.trim());
        if (type === 'intimacy') return { type, protection: arg || 'none' };
        return { type, who: arg || null };
    });
    return { found: true, minutes: parseDuration(attrs.t), events, clock: parseClock(attrs.clock) };
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
    const intimacy = scene?.intimacy;
    if (intimacy) {
        let protection = intimacy.protection === 'condom' ? 'condom' : 'none';
        if (protection === 'none' && intimacy.finished_inside === false) protection = 'withdrawal';
        events.push(`intimacy:${protection}`);
        if (protection === 'condom' && intimacy.condom_broke) events.push('condom_broke');
    }
    for (const who of scene?.orgasm ?? []) if (who === 'user' || who === 'char') events.push(`orgasm:${who}`);
    for (const item of scene?.lifestyle ?? []) {
        if (LIFESTYLE_TYPES.includes(item?.type) && (item.who === 'user' || item.who === 'char')) events.push(`${item.type}:${item.who}`);
    }
    if (scene?.pregnancy_test) events.push('test:user');
    if (scene?.doctor_visit) events.push('doctor');
    if (scene?.ultrasound) events.push('ultrasound');
    if (scene?.missed_pill) events.push('pill_missed:user');
    if (scene?.emergency_pill) events.push('emergency_pill:user');
    const minutes = Math.max(0, Math.round(Number(scene?.minutes) || 0));
    const clock = parseClock(scene?.clock);
    const clockAttr = clock === null ? '' : ` clock="${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}"`;
    return `<stork t="+${minutes}m"${clockAttr} ev="${events.join(',')}"/>`;
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

const NEUTRAL = [[/секс\w*/gi, 'близость'], [/возбужд\w*/gi, 'влечение'], [/оргазм\w*/gi, 'кульминация']];

function femaleLine(state, person, detailed) {
    const f = person.female;
    const day = state.clock.day;
    const name = person.name || 'Она';
    const age = person.age ? ` (${person.age})` : '';
    if (f.postpartum) {
        const since = day - f.postpartum.birthDay;
        return `${name}${age}: ${since} дн. после родов${since < POSTPARTUM_RECOVERY_DAYS ? ', восстанавливается, нужен покой' : ''}${f.postpartum.breastfeeding ? ', кормит грудью' : ''}.`;
    }
    if (f.pregnancy) {
        const p = f.pregnancy;
        const info = pregnancyInfo(p, day);
        const knows = p.knownBy.includes(person.key);
        if (p.labor) {
            const progress = laborProgress(p.labor, absMinute(state.clock));
            return `${name}${age}: РОДЫ. ${progress.label}, схватки каждые ${progress.intervalMinutes} мин${progress.waterBroken ? ', воды отошли' : ''}.`;
        }
        if (!knows) {
            const hints = info.week >= 5 ? info.symptoms.slice(0, 2).join(', ') : 'никаких признаков';
            return `${name}${age}: беременна (${info.week} нед.), но ещё НЕ знает об этом. Показывай только намёки: ${hints}. Не называй причину.`;
        }
        const parts = [`${name}${age}: беременна, ${info.week} нед. (${info.trimester}-й триместр), до родов ${Math.max(0, info.daysToDue)} дн.`];
        parts.push(`Живот: ${info.belly}.`);
        if (detailed) {
            if (info.symptoms.length) parts.push(`Самочувствие: ${info.symptoms.join(', ')}.`);
            parts.push(`Малыш размером с ${info.baby.compare}${info.kicksFelt ? ', толкается' : ''}.`);
            parts.push(`Тянет на ${p.cravings.join(' и ')}, не выносит ${p.aversions.join(', ')}.`);
            if (p.babies > 1) parts.push('Двойня.');
            if (p.sexKnown) parts.push(`Пол: ${p.sexes.join(' и ')}.`);
        }
        return parts.join(' ');
    }
    const state0 = femaleState(f, day);
    const pill = pillState(f, day);
    const phase = pill.suppressed && ['ovulation', 'follicular'].includes(state0.phase) ? 'гормональная контрацепция, овуляции нет' : state0.phaseLabel;
    const parts = [`${name}${age}: день цикла ${state0.cycleDay} из ${state0.length}, ${phase}.`];
    if (state0.late) parts.push(`Месячные запаздывают на ${state0.cycleDay - state0.length} дн.`);
    if (detailed) {
        parts.push(`Самочувствие: ${state0.symptoms.join(', ')}.`);
        const desire = state0.libido > 0.8 ? 'сильное' : state0.libido > 0.5 ? 'обычное' : 'сниженное';
        parts.push(`Влечение ${desire}, энергия ${state0.energy > 0.7 ? 'высокая' : state0.energy > 0.45 ? 'средняя' : 'низкая'}.`);
        if (state0.fertile && !pill.suppressed) parts.push('Сейчас фертильные дни.');
        const conditions = Object.entries(FEMALE_CONDITIONS).filter(([key]) => f[key]).map(([, c]) => `${c.label} (${c.note})`);
        if (conditions.length) parts.push(`Особенности: ${conditions.join('; ')}.`);
    }
    parts.push(`Контрацепция: ${FEMALE_CONTRACEPTION[pill.effective]?.label ?? 'нет'}.`);
    return parts.join(' ');
}

/** Whether he knows his partner is pregnant. */
function isExpectingFather(state, person) {
    const partner = state.people[otherKey(person.key)];
    return partner.sex === 'female' && !!partner.female.pregnancy?.knownBy.includes(person.key);
}

export function maleSnapshot(state, person) {
    return maleState(person.male, person.age, state.clock.day, state.clock.minutes, { expectingFather: isExpectingFather(state, person) });
}

function maleLine(state, person, detailed) {
    const m = person.male;
    const name = person.name || 'Он';
    const age = person.age ? ` (${person.age})` : '';
    const s = maleSnapshot(state, person);
    const parts = [`${name}${age}:`];
    const level = value => (value > 0.8 ? 'высокое' : value > 0.55 ? 'обычное' : 'сниженное');
    if (detailed) {
        parts.push(s.testosterone > 0.85 ? 'бодр, на пике сил.' : s.testosterone > 0.65 ? 'в обычной форме.' : 'устал.');
        parts.push(`Влечение ${level(s.libido)}.`);
        if (s.erection < 0.75) parts.push('Эрекция может подвести (стресс, усталость или алкоголь).');
        if (s.daysSinceLast !== null) parts.push(`Последняя близость ${s.daysSinceLast === 0 ? 'сегодня' : `${s.daysSinceLast} дн. назад`}.`);
        if (m.lastOrgasmMinute !== null && absMinute(state.clock) - m.lastOrgasmMinute < s.refractoryMinutes) {
            parts.push(`Ещё восстанавливается, будет готов примерно через ${s.refractoryMinutes - (absMinute(state.clock) - m.lastOrgasmMinute)} мин.`);
        }
        const recent = s.recent.filter(e => e.daysAgo <= 3).map(e => e.label);
        if (recent.length) parts.push(`Недавно: ${[...new Set(recent)].join(', ')}.`);
        if (s.couvade) parts.push('Сопереживает беременности партнёрши: хуже спит, иногда подташнивает, тянет на еду.');
    }
    if (s.expectingFather) parts.push('Знает, что станет отцом, гормонально перестраивается: мягче, заботливее.');
    return parts.length > 1 ? parts.join(' ') : `${name}${age}: без особенностей.`;
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
    const lines = [`[Stork | ${dateLabel(state)}, ${timeLabel(state.clock.minutes)}]`];
    for (const person of [state.people.char, state.people.user]) {
        lines.push(person.sex === 'female' ? femaleLine(state, person, detailed) : maleLine(state, person, detailed));
    }
    if (state.pending.length) {
        lines.push(`Только что произошло (обыграй в ответе один раз): ${state.pending.map(e => e.text).join('; ')}.`);
    }
    lines.push('Учитывай это состояние в описаниях.');
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
export function processReply(previousState, replyText, rng = Math.random) {
    const state = cloneState(previousState);
    state.pending = [];
    const tag = parseTag(replyText);
    // Events happen before the time of the reply passes (intimacy, then the night)
    for (const event of tag.events) applyEvent(state, event, rng);
    const clock = tag.clock ?? extractClock(replyText);
    advanceTime(state, clock === null ? tag.minutes : minutesToClock(state.clock.minutes, clock, tag.minutes), rng);
    return { state, tag: { ...tag, clock } };
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
