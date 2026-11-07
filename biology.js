/*
 * Stork biology: pure functions, no SillyTavern imports, so it runs in plain Node for tests.
 * Time is an absolute story day (integer) plus minutes of that day.
 * Randomness always comes through an injected rng() returning [0, 1).
 */

// #region Constants

/**
 * Chance of conception from one unprotected act, by day relative to ovulation (Wilcox et al., 1995).
 * The day after: the egg lives up to a day, and the day of ovulation itself is never known to the hour — a small chance.
 */
export const DAY_CHANCE = { '-5': 0.10, '-4': 0.16, '-3': 0.14, '-2': 0.27, '-1': 0.31, '0': 0.33, '1': 0.08 };
/** The last day of the fertile window, after ovulation. */
export const FERTILE_AFTER = 1;

/** Multipliers for a single act. */
export const ACT_PROTECTION = {
    none: { factor: 1, label: 'без защиты' },
    condom: { factor: 0.02, label: 'презерватив' },
    withdrawal: { factor: 0.2, label: 'прерванный акт' },
};
export const CONDOM_BREAK_CHANCE = 0.02;
export const EMERGENCY_PILL_FACTOR = 0.15;
export const EMERGENCY_PILL_WINDOW_DAYS = 3;

/**
 * Ongoing female contraception. `suppresses`: hormonal methods that stop ovulation while used correctly.
 */
export const FEMALE_CONTRACEPTION = {
    none: { factor: 1, label: 'нет' },
    pill: { factor: 0.01, label: 'таблетки', suppresses: true },
    pill_missed: { factor: 0.3, label: 'таблетки, пропуск' },
    ring: { factor: 0.01, label: 'кольцо', suppresses: true },
    patch: { factor: 0.01, label: 'пластырь', suppresses: true },
    injection: { factor: 0.004, label: 'укол', suppresses: true },
    implant: { factor: 0.001, label: 'имплант', suppresses: true },
    iud: { factor: 0.002, label: 'гормональная спираль' },
    copper_iud: { factor: 0.006, label: 'медная спираль' },
};

/** Female conditions that change the cycle and the chance to conceive. */
export const FEMALE_CONDITIONS = {
    pcos: { factor: 0.5, irregularity: 7, label: 'СПКЯ', note: 'цикл нерегулярный, забеременеть труднее' },
    endometriosis: { factor: 0.6, painful: true, label: 'эндометриоз', note: 'сильная боль при месячных, забеременеть труднее' },
};

/** Her habits: they lower the chance to conceive too (smoking ages the eggs, drinking upsets the hormones). */
export const FEMALE_HABITS = {
    smoker: { factor: 0.8, label: 'курит', en: 'smokes' },
    drinker: { factor: 0.9, label: 'часто выпивает', en: 'drinks often' },
};

export const PERIOD_FLOW = {
    light: 'скудные',
    normal: 'обычные',
    heavy: 'обильные',
};

export const MALE_FERTILITY = {
    normal: { factor: 1, label: 'норма' },
    low: { factor: 0.35, label: 'сниженная' },
    sterile: { factor: 0, label: 'бесплодие' },
};

/**
 * Lifestyle events hurting sperm with a delay (spermatogenesis takes about 74 days).
 * `count` and `motility` say which part suffers more; `erection` and `libido` are the effect on the day itself.
 */
export const LIFESTYLE = {
    fever: { weight: 0.5, label: 'болезнь с температурой', erection: 0.15, libido: 0.3 },
    sauna: { weight: 0.12, label: 'сауна или горячая ванна' },
    alcohol: { weight: 0.08, label: 'алкоголь', erection: 0.25, libido: -0.1 },
    smoking: { weight: 0.04, label: 'курение' },
    cannabis: { weight: 0.15, label: 'травка', erection: 0.1, libido: 0.1 },
    steroids: { weight: 0.6, label: 'анаболики', libido: -0.2 },
    no_sleep: { weight: 0.05, label: 'недосып', erection: 0.15, libido: 0.2 },
    stress: { weight: 0.06, label: 'стресс', erection: 0.2, libido: 0.25 },
};

export const STORY_MODES = {
    realistic: { factor: 1, label: 'реалистичный' },
    story: { factor: 2.5, label: 'сюжетный' },
};

/** Home test sensitivity by days after ovulation; earlier than 9 days it almost never shows. */
const TEST_SENSITIVITY = [[9, 0.05], [10, 0.15], [11, 0.4], [12, 0.6], [13, 0.8], [14, 0.97]];
export const TEST_FALSE_POSITIVE = 0.005;

export const PREGNANCY_DAYS = 280;
export const TWINS_CHANCE = 0.03;
export const POSTPARTUM_RECOVERY_DAYS = 42;

// #endregion

// #region Helpers

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Stable pseudo-random number for a key: the same day always shows the same symptoms. */
export function hashUnit(key) {
    let h = 2166136261;
    for (const char of String(key)) {
        h ^= char.charCodeAt(0);
        h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 100000) / 100000;
}

function pickStable(pool, count, key) {
    const items = [...pool];
    const result = [];
    for (let i = 0; i < count && items.length; i++) {
        const index = Math.floor(hashUnit(`${key}:${i}`) * items.length);
        result.push(items.splice(index, 1)[0]);
    }
    return result;
}

// #endregion

// #region Cycle

const PHASES = {
    menstruation: { label: 'менструация', libido: 0.3, energy: 0.35 },
    follicular: { label: 'фолликулярная фаза', libido: 0.55, energy: 0.7 },
    ovulation: { label: 'овуляция', libido: 0.95, energy: 0.9 },
    luteal: { label: 'лютеиновая фаза', libido: 0.5, energy: 0.6 },
    pms: { label: 'ПМС', libido: 0.35, energy: 0.4 },
};

const PHASE_SYMPTOMS = {
    menstruation: ['спазмы внизу живота', 'усталость', 'вздутие', 'тянет поясницу', 'хочется тепла и покоя', 'перепады настроения'],
    follicular: ['прилив энергии', 'хорошее настроение', 'кожа выглядит свежей', 'лёгкость в теле', 'хочется общаться'],
    ovulation: ['пик энергии', 'повышенная чувствительность', 'усиленное влечение', 'лёгкая тянущая боль сбоку внизу живота', 'уверенность в себе'],
    luteal: ['спокойствие', 'хочется уюта', 'повышенный аппетит', 'сонливость к вечеру', 'грудь слегка чувствительна'],
    pms: ['раздражительность', 'тяга к сладкому', 'грудь набухла и болит', 'плаксивость', 'отёки', 'плохой сон'],
};

/**
 * Ovulation day inside a cycle (1-based). The luteal phase is about 14 days,
 * so ovulation moves with the cycle length; irregular cycles shift it a little.
 */
export function ovulationDay(cycleLength, shift = 0) {
    return clamp(cycleLength - 14 + shift, 8, cycleLength - 9);
}

/**
 * Where a woman is in her cycle.
 * @param {object} f Female profile part: cycleStart, cycleLength, periodLength, cycleShift, pmsSevere
 * @param {number} day Absolute story day
 */
export function cycleInfo(f, day) {
    const length = f.cycleLength + (f.cycleShift ?? 0);
    const cycleDay = day - f.cycleStart + 1;
    const ovulation = ovulationDay(f.cycleLength, f.cycleShift ?? 0);
    const pmsDays = f.pmsSevere ? 7 : 5;

    let phase;
    if (cycleDay <= f.periodLength) phase = 'menstruation';
    else if (Math.abs(cycleDay - ovulation) <= 1) phase = 'ovulation';
    else if (cycleDay < ovulation) phase = 'follicular';
    else if (cycleDay > length - pmsDays) phase = 'pms';
    else phase = 'luteal';

    const relative = cycleDay - ovulation;
    const fertile = relative >= -5 && relative <= FERTILE_AFTER;
    const late = cycleDay > length;

    const nextPhaseDay = {
        menstruation: f.periodLength + 1,
        follicular: ovulation - 1,
        ovulation: ovulation + 2,
        luteal: length - pmsDays + 1,
        pms: length + 1,
    }[phase];

    return {
        cycleDay,
        length,
        ovulation,
        relative,
        phase,
        phaseLabel: PHASES[phase].label,
        fertile,
        late,
        chanceToday: DAY_CHANCE[String(relative)] ?? 0,
        daysToNextPhase: Math.max(0, nextPhaseDay - cycleDay),
        daysToPeriod: Math.max(0, length + 1 - cycleDay),
    };
}

/** Rough hormone curves (0-1) that drive mood, energy and desire. */
export function hormones(info) {
    const { cycleDay, ovulation, length } = info;
    const estrogen = cycleDay <= ovulation
        ? 0.2 + 0.8 * Math.exp(-((cycleDay - ovulation + 1) ** 2) / 18)
        : 0.25 + 0.35 * Math.exp(-((cycleDay - ovulation - 7) ** 2) / 20);
    const progesterone = cycleDay <= ovulation ? 0.1 : 0.1 + 0.9 * Math.exp(-((cycleDay - ovulation - 7) ** 2) / 14);
    const lh = Math.exp(-((cycleDay - ovulation + 0.5) ** 2) / 1.2);
    const fade = cycleDay > length - 3 ? 0.7 : 1;
    return { estrogen: estrogen * fade, progesterone: progesterone * fade, lh };
}

export function femaleState(f, day) {
    const info = cycleInfo(f, day);
    const phase = PHASES[info.phase];
    const symptoms = pickStable(PHASE_SYMPTOMS[info.phase], 2, `${f.cycleStart}:${day}`);
    if (info.phase === 'menstruation' && (f.painfulPeriods || f.endometriosis)) symptoms.unshift('сильная боль');
    if (info.phase === 'menstruation' && f.flow && f.flow !== 'normal') symptoms.unshift(`${PERIOD_FLOW[f.flow]} месячные`);
    if (info.phase === 'pms' && f.pmsSevere) symptoms.unshift('тяжёлый ПМС');
    return { ...info, libido: phase.libido, energy: phase.energy, hormones: hormones(info), symptoms };
}

/**
 * Starts a new cycle when the current one is over and no pregnancy stopped it.
 * Irregular cycles get a fresh random shift each time.
 */
export function rollCycles(f, day, rng = Math.random) {
    let changed = false;
    while (day - f.cycleStart + 1 > f.cycleLength + (f.cycleShift ?? 0)) {
        f.cycleStart += f.cycleLength + (f.cycleShift ?? 0);
        // PCOS and perimenopause make cycles wander more
        const spread = (f.irregularity ?? 0) + (f.pcos ? FEMALE_CONDITIONS.pcos.irregularity : 0) + (f.perimenopause ? 5 : 0);
        f.cycleShift = spread ? Math.round((rng() * 2 - 1) * spread) : 0;
        changed = true;
    }
    return changed;
}

// #endregion

// #region Male

const AGE_FACTOR_FEMALE = [[30, 1], [35, 0.85], [40, 0.6], [Infinity, 0.3]];
const AGE_FACTOR_MALE = [[40, 1], [45, 0.9], [50, 0.8], [Infinity, 0.65]];

function byAge(table, age) {
    for (const [limit, factor] of table) if ((age ?? 25) < limit) return factor;
    return 1;
}

export const femaleAgeFactor = age => byAge(AGE_FACTOR_FEMALE, age);
export const maleAgeFactor = age => byAge(AGE_FACTOR_MALE, age);

/** How strongly a lifestyle event from `daysAgo` affects sperm made now: none at first, full after a month, gone after ~100 days. */
function lifestyleImpact(daysAgo) {
    if (daysAgo < 0) return 0;
    if (daysAgo < 30) return daysAgo / 30;
    if (daysAgo <= 74) return 1;
    if (daysAgo < 100) return 1 - (daysAgo - 74) / 26;
    return 0;
}

/** Fewer than 2 days since the last ejaculation lowers quality, long abstinence slightly too. */
export function abstinenceFactor(daysSinceLast) {
    if (daysSinceLast === null || daysSinceLast === undefined) return 0.95;
    if (daysSinceLast < 1) return 0.8;
    if (daysSinceLast < 2) return 0.9;
    if (daysSinceLast <= 5) return 1;
    if (daysSinceLast <= 10) return 0.95;
    return 0.85;
}

/**
 * Male factor for an act on `day`: fertility, age, lifestyle (with delay), abstinence, vasectomy.
 * @param {object} m Male profile part
 * @param {number} age
 */
/** Sperm quality before abstinence: fertility, age, chronic habits, delayed lifestyle effects, vasectomy. */
export function spermQuality(m, age, day) {
    let factor = MALE_FERTILITY[m.fertility ?? 'normal']?.factor ?? 1;
    factor *= maleAgeFactor(age);
    if (m.smoker) factor *= 0.85;
    if (m.drinker) factor *= 0.9;
    if (m.varicocele) factor *= 0.7;
    for (const event of m.lifestyle ?? []) {
        const weight = LIFESTYLE[event.type]?.weight ?? 0;
        factor *= 1 - weight * lifestyleImpact(day - event.day);
    }
    if (m.vasectomyDay !== null && m.vasectomyDay !== undefined && day >= m.vasectomyDay) {
        const since = day - m.vasectomyDay;
        factor *= since >= 90 ? 0 : 0.5 * (1 - since / 90);
    }
    return clamp(factor, 0, 1);
}

export function maleFactor(m, age, day) {
    const previous = (m.ejaculations ?? []).filter(d => d < day);
    const last = previous.length ? Math.max(...previous) : null;
    return clamp(spermQuality(m, age, day) * abstinenceFactor(last === null ? null : day - last), 0, 1);
}

/** Minutes until he can go again after an orgasm. */
export function refractoryMinutes(age) {
    if ((age ?? 25) < 26) return 15;
    if (age < 36) return 30;
    if (age < 46) return 60;
    return 120;
}

/** Testosterone through the day: morning peak, evening low; lower with age. */
export function testosterone(age, minutes) {
    const hour = (minutes ?? 720) / 60;
    const daily = 0.75 + 0.25 * Math.cos(((hour - 8) / 24) * 2 * Math.PI);
    const ageDrop = (age ?? 25) > 30 ? Math.max(0.6, 1 - ((age - 30) * 0.01)) : 1;
    return clamp(daily * ageDrop, 0, 1);
}

/** How much semen is ready: low right after, full again in about three days. */
export function semenReserve(daysSinceLast) {
    if (daysSinceLast === null || daysSinceLast === undefined) return 1;
    return [0.35, 0.7, 0.9][daysSinceLast] ?? 1;
}

/** Hours until the reserve is full again after one orgasm. */
export const RESERVE_FULL_HOURS = 72;
/**
 * The same by story hours, not whole days: each orgasm of the last three days takes its share,
 * and several in a row take more. Returns { reserve, fullInHours }.
 * @param {number[]} orgasmMinutes absolute story minutes of his orgasms
 */
export function reserveByHours(orgasmMinutes, nowMinute) {
    let used = 0;
    let fullIn = 0;
    for (const at of orgasmMinutes ?? []) {
        const hours = (nowMinute - at) / 60;
        if (hours < 0 || hours >= RESERVE_FULL_HOURS) continue;
        used += 0.65 * (1 - hours / RESERVE_FULL_HOURS);
        fullIn = Math.max(fullIn, RESERVE_FULL_HOURS - hours);
    }
    return { reserve: clamp(1 - used, 0.08, 1), fullInHours: Math.ceil(fullIn) };
}

/**
 * Switches of realism the user can turn off (set from the settings; plain values, so Node tests set them too).
 * erectionDrops false: drink, stress, tiredness or illness never weaken his erection; everything else stays real.
 */
export const realism = { erectionDrops: true, health: false, healthSpeed: 1 };

/**
 * Everything about him today.
 * @param {object} [options]
 * @param {boolean} [options.expectingFather] His partner is pregnant and he knows: testosterone drops, couvade may show
 */
export function maleState(m, age, day, minutes, { expectingFather = false, nowMinute = null } = {}) {
    const previous = (m.ejaculations ?? []).filter(d => d <= day);
    const last = previous.length ? Math.max(...previous) : null;
    const daysSinceLast = last === null ? null : day - last;
    const recent = (m.lifestyle ?? []).filter(e => day - e.day >= 0 && day - e.day < 100)
        .map(e => ({ ...e, label: LIFESTYLE[e.type]?.label ?? e.type, daysAgo: day - e.day }));

    // Sperm: the delayed lifestyle effects, with when he recovers
    const quality = spermQuality(m, age, day);
    const reasons = recent
        .filter(e => (LIFESTYLE[e.type]?.weight ?? 0) * lifestyleImpact(e.daysAgo) >= 0.03)
        .map(e => ({ label: e.label, daysAgo: e.daysAgo, recoversInDays: Math.max(0, 100 - e.daysAgo) }));
    const count = Math.round(quality * 100);
    const motility = Math.round(Math.pow(quality, 0.8) * 100);

    // The day itself: hormones, desire, erection
    let t = testosterone(age, minutes);
    if (expectingFather) t *= 0.85;
    let erection = (age ?? 25) <= 40 ? 0.95 : (age <= 50 ? 0.85 : 0.75);
    let libido = t;
    for (const e of recent) {
        const effect = LIFESTYLE[e.type];
        const fresh = e.type === 'stress' ? e.daysAgo <= 3 : e.daysAgo <= 1;
        if (!fresh || !effect) continue;
        if (realism.erectionDrops) erection *= 1 - (effect.erection ?? 0);
        libido *= 1 - (effect.libido ?? 0);
    }
    if (daysSinceLast === 0) libido *= 0.8;
    // Story hours when known: the reserve and the count right now move with each orgasm, not once a day
    const byHours = nowMinute !== null && (m.orgasms ?? []).length ? reserveByHours(m.orgasms, nowMinute) : null;
    const reserve = byHours ? byHours.reserve : semenReserve(daysSinceLast);

    return {
        testosterone: clamp(t, 0, 1),
        libido: clamp(libido, 0, 1),
        erection: clamp(erection, 0, 1),
        daysSinceLast,
        reserve,
        reserveFullInHours: byHours?.fullInHours ?? null,
        // what an act right now would carry: base quality, less right after an orgasm
        countNow: Math.round(quality * (0.4 + 0.6 * reserve) * 100),
        refractoryMinutes: refractoryMinutes(age),
        spermCount: count,
        motility,
        fertilityToday: maleFactor(m, age, day),
        reasons,
        vasectomy: m.vasectomyDay !== null && m.vasectomyDay !== undefined
            ? (day - m.vasectomyDay >= 90 ? 'защищает' : `ещё не защищает, осталось ~${90 - (day - m.vasectomyDay)} дн.`)
            : null,
        expectingFather,
        couvade: expectingFather && hashUnit(`couvade:${m.couvadeSeed ?? 0}`) < 0.3,
        recent,
    };
}

// #endregion

// #region Conception

/**
 * Chance that one act leads to conception, before the woman's age and story mode.
 * @param {object} act { day, protection, condomBroke, emergencyPillDay }
 */
export function actChance(act, ovulationAbsoluteDay, femaleContraception, male, maleAge) {
    const base = DAY_CHANCE[String(act.day - ovulationAbsoluteDay)] ?? 0;
    if (!base) return 0;
    let factor = act.condomBroke ? 1 : (ACT_PROTECTION[act.protection ?? 'none']?.factor ?? 1);
    factor *= FEMALE_CONTRACEPTION[femaleContraception ?? 'none']?.factor ?? 1;
    if (act.emergencyPillDay !== undefined && act.emergencyPillDay !== null
        && act.emergencyPillDay - act.day <= EMERGENCY_PILL_WINDOW_DAYS && act.emergencyPillDay <= ovulationAbsoluteDay) {
        factor *= EMERGENCY_PILL_FACTOR;
    }
    return base * factor * maleFactor(male, maleAge, act.day);
}

/**
 * The decisive roll on ovulation day: every act of the 5 days before and the day itself counts.
 * An act marked force: 'yes' or 'no' overrides the dice.
 * @returns {{conceived: boolean, chance: number, twins: boolean, forced: boolean}}
 */
/** Her own fertility: conditions like PCOS or endometriosis lower it, and so do smoking and drinking. */
export function femaleConditionFactor(f) {
    let factor = 1;
    for (const [key, condition] of Object.entries({ ...FEMALE_CONDITIONS, ...FEMALE_HABITS })) if (f?.[key]) factor *= condition.factor;
    return factor;
}

export function rollConception({ acts, ovulationAbsoluteDay, femaleAge, femaleContraception, femaleFactor = 1, male, maleAge, storyMode = 'realistic', rng = Math.random }) {
    const window = acts.filter(a => a.day >= ovulationAbsoluteDay - 5 && a.day <= ovulationAbsoluteDay + FERTILE_AFTER);
    const forced = window.find(a => a.force === 'yes') ? 'yes' : (window.length && window.every(a => a.force === 'no') ? 'no' : null);
    let miss = 1;
    for (const act of window) miss *= 1 - actChance(act, ovulationAbsoluteDay, femaleContraception, male, maleAge);
    const chance = clamp((1 - miss) * femaleAgeFactor(femaleAge) * femaleFactor * (STORY_MODES[storyMode]?.factor ?? 1), 0, 0.95);
    const conceived = forced ? forced === 'yes' : rng() < chance;
    const twinsChance = TWINS_CHANCE * ((femaleAge ?? 25) >= 35 ? 1.5 : 1);
    return { conceived, chance, twins: conceived && rng() < twinsChance, forced: !!forced };
}

/** Whether a condom breaks during one act. */
export const rollCondomBreak = (rng = Math.random) => rng() < CONDOM_BREAK_CHANCE;

/**
 * A home pregnancy test.
 * @param {number|null} daysAfterOvulation null when not pregnant
 * @returns {boolean} positive
 */
export function rollTest(pregnant, daysAfterOvulation, rng = Math.random) {
    if (!pregnant) return rng() < TEST_FALSE_POSITIVE;
    let sensitivity = 0;
    for (const [days, value] of TEST_SENSITIVITY) if (daysAfterOvulation >= days) sensitivity = value;
    return rng() < sensitivity;
}

// #endregion

// #region Pregnancy

/** Week: [length cm, weight g, compared to, what develops]. Weeks 4-40. */
const BABY_WEEKS = {
    4: [0.1, 0, 'маковое зёрнышко', 'зародыш прикрепился к матке'],
    5: [0.2, 0, 'кунжутное семечко', 'закладывается сердце'],
    6: [0.6, 0, 'чечевица', 'сердце начинает биться'],
    7: [1.3, 1, 'черника', 'появляются зачатки ручек и ножек'],
    8: [1.6, 1, 'малина', 'формируются пальчики'],
    9: [2.3, 2, 'вишня', 'исчезает хвостик, двигается'],
    10: [3.1, 4, 'клубника', 'все органы заложены'],
    11: [4.1, 7, 'лайм', 'растут ноготки'],
    12: [5.4, 14, 'слива', 'появляются рефлексы'],
    13: [7.4, 23, 'лимон', 'отпечатки пальцев'],
    14: [8.7, 43, 'персик', 'морщит лицо, сосёт палец'],
    15: [10.1, 70, 'яблоко', 'чувствует свет'],
    16: [11.6, 100, 'авокадо', 'двигает глазами'],
    17: [13, 140, 'груша', 'откладывается жирок'],
    18: [14.2, 190, 'болгарский перец', 'слышит звуки, видно пол на УЗИ'],
    19: [15.3, 240, 'манго', 'кожа покрывается защитной смазкой'],
    20: [25.6, 300, 'банан', 'глотает, толкается заметно'],
    21: [26.7, 360, 'морковь', 'брови и ресницы'],
    22: [27.8, 430, 'папайя', 'различает голоса'],
    23: [28.9, 500, 'грейпфрут', 'активные кувырки'],
    24: [30, 600, 'початок кукурузы', 'развиваются лёгкие'],
    25: [34.6, 660, 'брюква', 'реагирует на прикосновения через живот'],
    26: [35.6, 760, 'кабачок', 'открывает глаза'],
    27: [36.6, 875, 'цветная капуста', 'режим сна и бодрствования'],
    28: [37.6, 1000, 'баклажан', 'моргает, видит сны'],
    29: [38.6, 1150, 'небольшая тыква', 'крепнут кости'],
    30: [39.9, 1300, 'кочан капусты', 'набирает вес'],
    31: [41.1, 1500, 'кокос', 'поворачивает голову'],
    32: [42.4, 1700, 'ананас', 'тренирует дыхание'],
    33: [43.7, 1900, 'дыня', 'укрепляется иммунитет'],
    34: [45, 2100, 'канталупа', 'почти готов к жизни снаружи'],
    35: [46.2, 2400, 'медовая дыня', 'тесно, толчки сильнее'],
    36: [47.4, 2600, 'салат ромэн', 'опускается ниже'],
    37: [48.6, 2900, 'мангольд', 'доношен'],
    38: [49.8, 3100, 'лук-порей', 'готов к рождению'],
    39: [50.7, 3300, 'маленький арбуз', 'ждёт своего часа'],
    40: [51.2, 3500, 'тыква', 'срок родов'],
};

const MOTHER_SYMPTOMS = [
    [4, ['задержка месячных', 'лёгкая усталость']],
    [6, ['утренняя тошнота', 'усталость', 'чувствительная грудь', 'частые походы в туалет', 'обострённое обоняние']],
    [13, ['тошнота отступает', 'возвращается энергия', 'аппетит растёт']],
    [18, ['первые шевеления', 'живот растёт', 'заложенный нос']],
    [24, ['толчки малыша', 'боль в спине', 'изжога']],
    [28, ['тренировочные схватки', 'одышка', 'отёки ног', 'тяжело спать']],
    [36, ['живот опустился', 'легче дышать', 'частые позывы', 'гнездование: хочется готовить дом']],
];

export function pregnancyInfo(p, day) {
    const gaDays = day - p.lmp;
    const week = Math.floor(gaDays / 7);
    const trimester = week < 14 ? 1 : (week < 28 ? 2 : 3);
    const babyWeek = clamp(week, 4, 40);
    const [length, weight, compare, develops] = BABY_WEEKS[babyWeek] ?? BABY_WEEKS[40];
    let symptoms = [];
    for (const [fromWeek, list] of MOTHER_SYMPTOMS) if (week >= fromWeek) symptoms = list;
    let belly = 'не видно';
    if (week >= 13) belly = 'слегка округлился';
    if (week >= 17) belly = 'заметен';
    if (week >= 25) belly = 'большой';
    if (week >= 33) belly = 'очень большой';
    const weightGain = week < 13 ? Math.round(week * 0.15 * 10) / 10 : Math.round((2 + (week - 13) * 0.4) * 10) / 10;
    const libido = trimester === 2 ? 0.75 : 0.35;
    return {
        week,
        weekDay: gaDays % 7,
        trimester,
        dueDay: p.lmp + PREGNANCY_DAYS,
        daysToDue: p.lmp + PREGNANCY_DAYS - day,
        baby: { length, weight, compare, develops },
        symptoms: pickStable(symptoms, 3, `${p.lmp}:${day}`),
        belly,
        weightGain,
        libido,
        kicksFelt: p.kicksDay !== undefined && day >= p.kicksDay,
        sexVisible: week >= 18,
    };
}

const CRAVINGS = ['солёные огурцы', 'сладкое', 'цитрусовые', 'мороженое', 'острое', 'мясо', 'молочное', 'хлеб с маслом', 'фрукты', 'необычные сочетания'];
const AVERSIONS = ['запах кофе', 'жареное', 'рыба', 'духи', 'табачный дым', 'мясо', 'яйца', 'запах готовки'];

/**
 * Starts a pregnancy record. lmp is the first day of the last period (obstetric dating).
 * @param {number} [births] Earlier births: kicks are felt sooner in a later pregnancy
 */
export function createPregnancy({ lmp, conceptionDay, twins, births = 0, rng = Math.random }) {
    const babies = twins ? 2 : 1;
    const kicksWeek = births ? 16 + Math.floor(rng() * 3) : 18 + Math.floor(rng() * 5);
    const pick = (pool, count) => {
        const items = [...pool];
        return Array.from({ length: count }, () => items.splice(Math.floor(rng() * items.length), 1)[0]);
    };
    const sexes = Array.from({ length: babies }, () => (rng() < 0.5 ? 'девочка' : 'мальчик'));
    const cravings = pick(CRAVINGS, 2);
    return {
        lmp,
        conceptionDay,
        babies,
        births,
        sexes,
        kicksDay: lmp + 7 * kicksWeek,
        spottingDay: rng() < 0.3 ? conceptionDay + 6 + Math.floor(rng() * 5) : null,
        cravings,
        aversions: pick(AVERSIONS.filter(item => !cravings.includes(item)), 1),
        knownBy: [],
        sexKnown: false,
        visitsDone: [],
        labor: null,
    };
}

/** Prenatal visits: the week they become due and what they are about. */
export const DOCTOR_VISITS = [
    { week: 8, label: 'первый приём у врача: подтвердить беременность, услышать сердцебиение' },
    { week: 12, label: 'первый скрининг и УЗИ' },
    { week: 20, label: 'второй скрининг, УЗИ, можно узнать пол' },
    { week: 32, label: 'третий скрининг, положение малыша' },
];

/**
 * Who looks after a pregnancy depends on the world of the story. modern: a doctor, tests, ultrasound.
 * traditional (old times, an old-Slavic village, fantasy): a midwife, signs and hands, the sex is learned at birth.
 */
export const CARE = {
    modern: {
        title: 'Врач',
        icon: 'fa-user-doctor',
        visits: DOCTOR_VISITS,
        due: label => `пора к врачу, ${label}`,
        visited: 'визит к врачу',
        sexUnknown: 'пол пока неизвестен, узнать на УЗИ с 18 недель',
        canSeeSex: true,
    },
    traditional: {
        title: 'Повитуха',
        icon: 'fa-hand-holding-heart',
        visits: [
            { week: 8, label: 'повитуха смотрит её и по приметам подтверждает, что она в тягости' },
            { week: 16, label: 'повитуха щупает живот, считает срок, даёт травы от дурноты' },
            { week: 28, label: 'повитуха проверяет, как лежит дитя, наставляет беречься' },
            { week: 36, label: 'повитуха готовит её к родам: баня, чистое полотно, кто будет рядом' },
        ],
        due: label => `пора позвать повитуху: ${label}`,
        visited: 'приходила повитуха',
        sexUnknown: 'кто родится, узнают только при родах',
        canSeeSex: false,
    },
};
export const ERAS = { modern: 'современный мир', traditional: 'старина или фэнтези: повитуха вместо врача' };
/** The care of this story: modern unless the world is set in old times. */
export const careOf = state => CARE[state?.era === 'traditional' ? 'traditional' : 'modern'];

// #endregion

// #region Labor

/** Labor stages by share of total duration. */
const LABOR_STAGES = [
    { until: 0.6, stage: 'early', label: 'ранние схватки', interval: [20, 5] },
    { until: 0.95, stage: 'active', label: 'активные схватки', interval: [5, 2] },
    { until: 1, stage: 'pushing', label: 'потуги', interval: [2, 2] },
];

/** First labor takes longer: about 12 hours, a later one about 7. */
export function startLabor(startMinute, births, rng = Math.random) {
    const hours = births ? 5 + rng() * 5 : 8 + rng() * 10;
    return {
        startMinute,
        durationMinutes: Math.round(hours * 60),
        waterBreaksAt: Math.round(rng() * 0.9 * hours * 60),
        stage: 'early',
        waterBroken: false,
    };
}

/**
 * Where labor is after `nowMinute`.
 * @returns {{stage: string, label: string, intervalMinutes: number, waterBroken: boolean, born: boolean, progress: number}}
 */
export function laborProgress(labor, nowMinute) {
    const progress = clamp((nowMinute - labor.startMinute) / labor.durationMinutes, 0, 1);
    const waterBroken = nowMinute - labor.startMinute >= labor.waterBreaksAt;
    if (progress >= 1) return { stage: 'born', label: 'роды завершились', intervalMinutes: 0, waterBroken: true, born: true, progress };
    let from = 0;
    for (const s of LABOR_STAGES) {
        if (progress < s.until) {
            const local = (progress - from) / (s.until - from);
            const interval = Math.round(s.interval[0] + (s.interval[1] - s.interval[0]) * local);
            return { stage: s.stage, label: s.label, intervalMinutes: interval, waterBroken, born: false, progress };
        }
        from = s.until;
    }
    return { stage: 'pushing', label: 'потуги', intervalMinutes: 2, waterBroken, born: false, progress };
}

/** Practice contractions in the third trimester: a few days a week. */
export const falseContractionsToday = (week, rng = Math.random) => week >= 28 && week < 40 && rng() < 0.15;

// #endregion

// #region Life effects on the female cycle

/**
 * Stress, illness or heavy training before ovulation push it (and the period) later.
 * Applied at most once per cycle.
 * @returns {number} Days added to this cycle
 */
export function stressDelay(f, day, rng = Math.random) {
    const info = cycleInfo(f, day);
    if (f.delayedCycle === f.cycleStart || info.cycleDay >= info.ovulation) return 0;
    const delay = 2 + Math.floor(rng() * 4);
    f.cycleShift = (f.cycleShift ?? 0) + delay;
    f.delayedCycle = f.cycleStart;
    return delay;
}

/**
 * Hormonal pill: no real ovulation while taken, a withdrawal bleed on schedule.
 * A missed pill (or vomiting) weakens it for 7 days; after stopping, cycles stay irregular for 1-3 months.
 */
export function pillState(f, day) {
    const missed = f.pillMissedDay !== null && f.pillMissedDay !== undefined && day - f.pillMissedDay >= 0 && day - f.pillMissedDay < 7;
    const recovering = f.pillStoppedDay !== null && f.pillStoppedDay !== undefined && day - f.pillStoppedDay < 75;
    const method = FEMALE_CONTRACEPTION[f.contraception ?? 'none'] ?? FEMALE_CONTRACEPTION.none;
    return {
        onPill: f.contraception === 'pill',
        missed,
        // Hormonal methods (used correctly) keep ovulation from happening at all
        suppressed: !!method.suppresses && !missed,
        effective: f.contraception === 'pill' && missed ? 'pill_missed' : f.contraception ?? 'none',
        recovering,
    };
}

/** Women over 45 enter perimenopause: cycles wander more. */
export const perimenopause = age => (age ?? 25) >= 45;

// #endregion

// #region Pregnancy milestones

/** Daily chance that labor starts, by week. */
export function laborChance(week) {
    if (week < 37) return 0;
    if (week >= 42) return 1;
    return { 37: 0.02, 38: 0.04, 39: 0.07, 40: 0.12, 41: 0.2 }[week] ?? 0;
}

/** Ultrasound: chance to see the baby's sex. */
export function ultrasoundShowsSex(week, rng = Math.random) {
    if (week < 18) return false;
    return rng() < (week < 20 ? 0.8 : 0.95);
}

/** When the cycle comes back after birth. */
export function cycleReturnDay(birthDay, breastfeeding, rng = Math.random) {
    const span = breastfeeding ? [90, 180] : [42, 70];
    return birthDay + span[0] + Math.floor(rng() * (span[1] - span[0]));
}

// #endregion
