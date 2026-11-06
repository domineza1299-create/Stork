/*
 * Health and psyche (from the Health & Psyche extension, built into Stork): illnesses of the body and the mind of
 * {{char}} and {{user}}, their course by story time, medicines with side effects, doctors who sometimes get it
 * wrong, relapses, a chronic illness that flares. The tracker counts, the story model portrays.
 * Kept in Stork's own state, so a swipe or a deleted reply rolls it back like everything else. Read by Stork's
 * analysis of each reply (no tags for the story model). Only the two of them, no one else.
 * Pure: no SillyTavern imports; time comes as story days, the journal through a callback. Tested in Node.
 */

export const DAY_MIN = 1440;

// #region The catalogue

export const STAGES = [
    { max: 24, name: 'лёгкая', en: 'mild' },
    { max: 49, name: 'умеренная', en: 'moderate' },
    { max: 74, name: 'тяжёлая', en: 'severe' },
    { max: 100, name: 'критическая', en: 'critical' },
];
export const HOSPITAL_AT = 85;
export const REMISSION_AT = 15;
export const stageOf = severity => STAGES.find(st => Math.max(0, Math.min(100, severity)) <= st.max) ?? STAGES[3];
export const SEVERITY = { mild: 15, moderate: 40, severe: 65, critical: 88 };

/** «Реализм»: how fast illnesses run their course, and the dice of real medicine. */
export const HEALTH_REALISM = { misdiagnosis: 0.15, sideEffect: 0.35, interaction: 0.25, relapse: 20, randomPerDay: 0.008 };

/** What may come on its own, by season (months 0-11). */
const RANDOM = [
    { name: 'Простуда', type: 'physical', severity: 15, months: [9, 10, 11, 0, 1, 2, 3], weight: 30 },
    { name: 'Грипп', type: 'physical', severity: 32, months: [11, 0, 1, 2], weight: 15, fever: true },
    { name: 'Пищевое отравление', type: 'physical', severity: 26, months: null, weight: 12 },
    { name: 'Мигрень', type: 'physical', severity: 14, months: null, weight: 15 },
    { name: 'Ангина', type: 'physical', severity: 30, months: [8, 9, 10, 11, 0, 1], weight: 10, fever: true },
    { name: 'Сезонная аллергия', type: 'physical', severity: 12, months: [3, 4, 5, 7, 8], weight: 12 },
    { name: 'Ротавирус', type: 'physical', severity: 28, months: [10, 11, 0, 1, 2], weight: 8, fever: true },
    { name: 'Конъюнктивит', type: 'physical', severity: 12, months: null, weight: 6 },
    { name: 'Бессонница (эпизод)', type: 'mental', severity: 15, months: null, weight: 10 },
];
const SIDE_EFFECTS = {
    physical: ['тошнота', 'сонливость', 'головокружение', 'сухость во рту', 'головная боль', 'расстройство желудка', 'кожная сыпь', 'снижение аппетита'],
    mental: ['сонливость днём', 'эмоциональная притуплённость', 'тремор рук', 'набор веса', 'бессонница', 'снижение либидо', 'повышенная тревожность в первые дни', 'яркие сны'],
};
const INTERACTIONS = ['усиленная сонливость и заторможенность', 'тошнота и головокружение при совместном приёме', 'ослабление действия одного из препаратов', 'скачки давления', 'усиленная нагрузка на печень (нужен контроль)'];

/** A short reference for the window: what it is, how long, what helps. Treatment by groups, never doses. */
export const DISEASES = [
    { re: /простуд|орви|орз|насморк/i, days: [5, 10], self: true, about: 'Вирусная инфекция верхних дыхательных путей: насморк, першение, слабость, субфебрильная температура.', care: ['постельный режим 2–3 дня', 'тёплое питьё, влажный воздух'], meds: ['симптоматическое', 'антибиотики не нужны — вирус'] },
    { re: /грипп|инфлюэнц/i, days: [7, 14], fever: true, self: true, about: 'Острая вирусная инфекция с резким началом: высокая температура, ломота, головная боль, сухой кашель.', care: ['строгий постельный режим', 'обильное питьё'], meds: ['противовирусное в первые 48 ч', 'жаропонижающее'] },
    { re: /ангин|тонзиллит/i, days: [7, 12], fever: true, about: 'Бактериальное воспаление миндалин: сильная боль в горле, температура, налёт.', care: ['полоскания, мягкая тёплая еда', 'курс антибиотика допивать полностью'], meds: ['антибиотик курсом', 'местные антисептики'] },
    { re: /бронхит/i, days: [10, 21], self: true, about: 'Воспаление бронхов: затяжной кашель, тяжесть в груди.', care: ['влажный воздух, много питья', 'бросить курить хотя бы на время'], meds: ['отхаркивающие', 'антибиотик — только при бактериальном'] },
    { re: /пневмон|воспал.*л[её]гк/i, days: [14, 30], fever: true, about: 'Воспаление лёгочной ткани: высокая температура, одышка, боль при вдохе. Серьёзно.', care: ['часто нужен стационар', 'восстановление ещё 1–2 месяца'], meds: ['антибиотики', 'кислород при тяжёлом течении'] },
    { re: /ковид|covid|коронавирус/i, days: [10, 21], fever: true, self: true, about: 'Вирусная инфекция от лёгкого ОРВИ до пневмонии; долгий «хвост» слабости.', care: ['изоляция', 'постепенное возвращение к нагрузкам'], meds: ['симптоматическое', 'противовирусное в первые дни'] },
    { re: /ротавирус|кишечн.*инфекц|гастроэнтерит/i, days: [4, 8], fever: true, self: true, about: 'Кишечная инфекция: рвота, диарея, температура. Главная опасность — обезвоживание.', care: ['пить маленькими глотками', 'заразно для всей семьи'], meds: ['регидратация', 'сорбенты'] },
    { re: /отравлен/i, days: [2, 5], self: true, about: 'Пищевая интоксикация: тошнота, рвота, спазмы. Обычно проходит само.', care: ['первые часы — только питьё', 'скорая при крови или спутанности'], meds: ['сорбенты', 'регидратация'] },
    { re: /мигрен|головн.*бол/i, days: [1, 3], episodic: true, self: true, about: 'Приступ пульсирующей головной боли со свето- и звукобоязнью.', care: ['тёмная тихая комната, сон', 'купировать в первые 30 минут'], meds: ['триптаны или НПВС при приступе'] },
    { re: /гастрит|язв.*желуд/i, days: null, about: 'Хроническое воспаление желудка: боль под ложечкой, изжога; волнами.', care: ['дробное питание', 'без алкоголя и острого'], meds: ['ингибиторы протонной помпы'] },
    { re: /аллерг|поллиноз/i, days: [10, 30], self: true, cap: 55, about: 'Реакция иммунитета: чихание, зуд, слезотечение. Опасна только острая реакция (отёк, удушье) — тогда скорая.', care: ['промывание носа', 'найти триггер'], meds: ['антигистаминные', 'назальные стероиды'] },
    { re: /конъюнктивит/i, days: [5, 10], self: true, about: 'Воспаление слизистой глаза: покраснение, резь.', care: ['отдельное полотенце', 'не тереть глаза'], meds: ['капли по типу возбудителя'] },
    { re: /(?:^|[^а-яё])отит/i, days: [7, 14], about: 'Воспаление уха: стреляющая боль, снижение слуха.', care: ['ничего не капать без врача'], meds: ['ушные капли', 'антибиотик при среднем отите'] },
    { re: /цистит/i, days: [5, 10], about: 'Воспаление мочевого пузыря: резь, частые позывы.', care: ['много питья', 'долечивать — иначе к почкам'], meds: ['антибиотик коротким курсом'] },
    { re: /анеми|железодефицит/i, days: [60, 120], about: 'Недостаток гемоглобина: бледность, слабость, одышка.', care: ['найти причину', 'контроль анализов'], meds: ['железо длительным курсом'] },
    { re: /гипертон/i, days: null, about: 'Хронически повышенное давление: головные боли, риск инсульта.', care: ['контроль давления', 'терапию не бросать'], meds: ['гипотензивные ежедневно'] },
    { re: /диабет/i, days: null, about: 'Хроническое нарушение углеводного обмена.', care: ['контроль сахара', 'диета и режим'], meds: ['инсулин или сахароснижающие'] },
    { re: /астм/i, days: null, about: 'Хроническое воспаление дыхательных путей с приступами удушья.', care: ['ингалятор всегда с собой'], meds: ['базисная ингаляционная терапия'] },
    { re: /перелом/i, days: [30, 60], about: 'Перелом: боль, отёк; срастание требует фиксации.', care: ['покой и фиксация', 'реабилитация после гипса'], meds: ['обезболивающее', 'кальций и витамин D'] },
    { re: /сотрясен|черепно/i, days: [7, 21], about: 'Лёгкая черепно-мозговая травма: головная боль, тошнота, светобоязнь.', care: ['покой, минимум экранов', 'без алкоголя'], meds: ['по назначению невролога'] },
    { re: /депресс/i, days: [120, 240], about: 'Стойко сниженное настроение, нет радости, упадок сил, нарушен сон и аппетит.', care: ['психотерапия — основа', 'близким: не обесценивать'], meds: ['антидепрессант, эффект через 2–4 недели'] },
    { re: /тревожн|невроз/i, days: [90, 180], about: 'Фоновая тревога, прокручивание мыслей, телесные симптомы.', care: ['КПТ', 'дыхательные техники'], meds: ['СИОЗС курсом'] },
    { re: /панич/i, days: [60, 150], about: 'Внезапные приступы страха с сердцебиением и удушьем.', care: ['психотерапия с экспозицией', 'не избегать мест приступов'], meds: ['СИОЗС курсом'] },
    { re: /птср|посттравмат/i, days: [180, 365], about: 'Реакция на тяжёлую травму: флешбэки, кошмары, избегание.', care: ['травма-фокусированная терапия', 'без принуждения к рассказу'], meds: ['антидепрессанты'] },
    { re: /биполярн|маниакал/i, days: null, about: 'Смена фаз: депрессия и мания; пожизненное наблюдение.', care: ['режим сна', 'дневник настроения'], meds: ['нормотимики постоянно'] },
    { re: /(?:^|[^а-яё])окр(?:[^а-яё]|$)|навязчив|обсесс/i, days: [120, 300], about: 'Навязчивые мысли и ритуалы.', care: ['экспозиция с предотвращением ритуала'], meds: ['СИОЗС'] },
    { re: /бессонниц|инсомни/i, days: [14, 60], about: 'Трудно уснуть или удержать сон, днём разбитость.', care: ['одно время подъёма', 'без экранов перед сном'], meds: ['снотворное коротким курсом'] },
    { re: /анорекси|булими|расстройств.*питан/i, days: [180, 400], about: 'Расстройство пищевого поведения: искажённый образ тела.', care: ['психиатр, терапевт и диетолог вместе'], meds: ['по назначению психиатра'] },
    { re: /выгоран/i, days: [60, 180], about: 'Истощение от хронического стресса: цинизм, упадок сил.', care: ['настоящий отдых', 'пересмотр нагрузки'], meds: ['обычно не нужны'] },
    { re: /зависимост|алкоголизм|наркоман/i, days: [180, 400], about: 'Потеря контроля, толерантность, синдром отмены.', care: ['детокс под наблюдением', 'группы поддержки'], meds: ['терапия отмены'] },
];
export const diseaseInfo = name => DISEASES.find(d => d.re.test(String(name ?? ''))) ?? null;
const MENTAL_RE = /депресс|тревог|тревожн|панич|фоби|невроз|маниакал|бипол|шизофрен|психоз|бред|навязчив|обсесс|птср|посттравмат|бессонниц|инсомни|анорекси|булими|расстройств.*питан|сдвг|выгоран|зависимост|апати/i;
const FEVER_RE = /грипп|ангин|пневмон|ковид|covid|температур|лихорад|ротавирус|кишечн.*инфекц|бронхит/i;

// #endregion

// #region State

const uid = rng => Math.floor(rng() * 36 ** 6).toString(36).padStart(6, '0');
const norm = s => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '').replace(/(.)\1+/g, '$1');
/** «Депресия» and «депрессия», «грип» and «грипп» are the same; a long name contains a short one. */
export function sameName(a, b) {
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    return x === y || (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x)));
}
const patient = () => ({ ill: [], meds: [], genetics: [], hospital: null, nextVisit: null, onset: null });
export function ensureHealth(state) {
    state.health ??= {};
    state.health.char ??= patient();
    state.health.user ??= patient();
    return state.health;
}
export const activeIll = p => (p?.ill ?? []).filter(i => !i.cured && !i.remission);
const list = v => {
    const arr = Array.isArray(v) ? v : v ? String(v).split(/\s*[;·]\s*/) : [];
    const out = arr.map(x => String(x ?? '').trim()).filter(Boolean).slice(0, 3).map(x => x.slice(0, 100));
    return out.length ? out : null;
};

// #endregion

// #region The course of an illness

/** Severity per day under the current treatment: the same sum for the course and for the forecast. */
export function illnessDelta(p, ill, now, speed = 1) {
    const meds = p.meds.filter(m => m.forId === ill.id);
    const adherent = meds.some(m => m.missed < 2 && (now - (m.last ?? m.start)) / DAY_MIN <= 2.5);
    const mind = ill.type === 'mental' ? 0.55 : 1;
    if (p.hospital) return { delta: -6 * mind * speed, mode: 'hospital' };
    if (meds.length && adherent && !diseaseInfo(ill.name)?.self) {
        if (ill.diag.status === 'misdiagnosed') return { delta: 1 * mind * speed, mode: 'misdiag' };
        return { delta: (ill.diag.status === 'diagnosed' ? -4 : -2.5) * mind * speed, mode: 'treated' };
    }
    const info = diseaseInfo(ill.name);
    // a viral illness, a poisoning, an attack passes on its own in its usual time: a day or two to its peak, then down
    // (the medicines only ease it); the rest get worse untreated
    if (!ill.chronic && ill.type === 'physical' && info?.self && info.days) {
        const age = (now - ill.start) / DAY_MIN;
        const span = (info.days[0] + info.days[1]) / 2;
        if (age < Math.min(2, span / 3)) return { delta: 1.5 * speed, mode: 'passing' };
        const ease = meds.length && adherent ? 1.3 : meds.length ? 1 : 0.9;
        return { delta: -Math.max(3, ill.severity / Math.max(1, span - age)) * ease * speed, mode: 'passing' };
    }
    if (meds.length) return { delta: 1.5 * mind * speed, mode: 'missing' };
    if (!ill.chronic && ill.type === 'physical' && ill.severity < 30 && info?.days && info.days[1] <= 14) return { delta: -2.5 * speed, mode: 'passing' };
    return { delta: 3 * mind * speed, mode: 'untreated' };
}

/** How many days until it passes, or until it turns critical, as things go now. */
export function forecast(p, ill, now, speed = 1) {
    const { delta, mode } = illnessDelta(p, ill, now, speed);
    const info = diseaseInfo(ill.name);
    // one that passes on its own: its usual time, even while it is still climbing to its peak
    if (mode === 'passing' && info?.days) return { dir: 'recover', days: Math.max(1, Math.ceil(((info.days[0] + info.days[1]) / 2 - (now - ill.start) / DAY_MIN) / speed)), mode };
    if (delta < 0) return { dir: ill.chronic ? 'remission' : 'recover', days: Math.max(1, Math.ceil((ill.severity - (ill.chronic ? REMISSION_AT : 0)) / -delta)), mode };
    if (delta > 0 && (info?.cap ?? 100) < HOSPITAL_AT) return { dir: 'stable', days: null, mode };
    if (delta > 0) return { dir: 'worsen', days: Math.max(1, Math.ceil((HOSPITAL_AT - ill.severity) / delta)), mode };
    return { dir: 'stable', days: null, mode };
}

function finish(p, ill, log, key) {
    if (ill.chronic) {
        ill.remission = true;
        ill.severity = Math.min(ill.severity, REMISSION_AT);
        log(key, `«${ill.name}» — ремиссия`);
    } else {
        ill.cured = true;
        ill.severity = 0;
        ill.relapse = { chance: Math.min(70, HEALTH_REALISM.relapse + Math.min(30, ill.untreated * 1.5)), days: 30 };
        log(key, `«${ill.name}» — выздоровел${key === 'user' ? 'а' : ''}`);
    }
    if (p.onset && sameName(p.onset.name, ill.name)) p.onset = null;
    // nothing left to treat: the follow-up visit is not needed any more
    if (!activeIll(p).length && !p.meds.length) p.nextVisit = null;
}

/**
 * Story days pass: medicines run out or are missed, illnesses go their way, a cured one may come back,
 * a chronic one may flare, a predisposition may show, and now and then someone simply falls ill.
 * @param {object} state Stork's state (state.health, state.clock)
 * @param {number} days story days, may be a fraction
 * @param {function} log (key, text, {notify}) into Stork's journal
 * @returns {Array<{key, name, fever}>} new illnesses (for the body: fever, stress)
 */
export function advanceHealth(state, days, rng = Math.random, log = () => {}, { speed = 1, now, month = 0, random = true, offscreen = false } = {}) {
    if (!(days > 0)) return [];
    // inside a skip of days nothing new comes by the dice (no new illness, relapse, flare or predisposition), and an
    // illness already there is cared for off-screen: it heals, a chronic one holds — never critical unseen
    if (offscreen) random = false;
    const h = ensureHealth(state);
    const onsets = [];
    for (const key of ['char', 'user']) {
        const p = h[key];
        p.meds = p.meds.filter(m => {
            m.left -= days;
            const gap = (now - (m.last ?? m.start)) / DAY_MIN;
            if (gap > 1.6 && !/необходим/i.test(m.schedule)) m.missed = Math.min(30, Math.max(m.missed, Math.floor(gap - 0.6)));
            if (m.left <= 0) { log(key, `курс «${m.name}» закончился`); return false; }
            return true;
        });
        for (const ill of p.ill) {
            if (ill.cured) {
                if (!ill.relapse) continue;
                ill.relapse.days -= days;
                if (ill.relapse.days <= 0) { ill.relapse = null; continue; }
                if (offscreen) continue;
                if (rng() * 100 < (ill.relapse.chance / 30) * days) {
                    Object.assign(ill, { cured: false, remission: false, severity: Math.max(15, Math.round((ill.peak ?? 40) * 0.6)), trend: 'worsening', relapse: null });
                    log(key, `рецидив: «${ill.name}»`, { notify: true });
                }
                continue;
            }
            if (ill.remission) {
                if (!offscreen && rng() * 100 < 0.15 * speed * days) {
                    Object.assign(ill, { remission: false, severity: 25 + Math.round(rng() * 20), trend: 'worsening' });
                    log(key, `обострение: «${ill.name}»`, { notify: true });
                }
                continue;
            }
            let { delta, mode } = illnessDelta(p, ill, now, speed);
            if (offscreen && delta > 0) { delta = ill.chronic ? 0 : -2.5 * (ill.type === 'mental' ? 0.55 : 1) * speed; mode = 'offscreen'; }
            if (mode === 'missing' || mode === 'untreated') ill.untreated += days;
            const before = ill.severity;
            // some never turn critical by themselves (an allergy is a nuisance, not a slow way to a hospital)
            ill.severity = Math.max(0, Math.min(diseaseInfo(ill.name)?.cap ?? 100, ill.severity + delta * days));
            ill.peak = Math.max(ill.peak ?? 0, ill.severity);
            ill.trend = ill.severity > before + 0.5 ? 'worsening' : ill.severity < before - 0.5 ? 'improving' : 'stable';
            if (ill.severity <= 0 || (ill.chronic && ill.severity <= REMISSION_AT)) { finish(p, ill, log, key); continue; }
            if (ill.severity >= HOSPITAL_AT && before < HOSPITAL_AT && !p.hospital) log(key, `«${ill.name}» в критической стадии — нужна больница`, { notify: true });
        }
        if (p.hospital) p.hospital.ready = Math.max(0, ...activeIll(p).map(i => i.severity)) < 40;
        if (!activeIll(p).length && !p.meds.length) p.nextVisit = null;
        for (const g of p.genetics) {
            if (g.shown || offscreen || !(rng() * 100 < g.risk * 0.0006 * days)) continue;
            g.shown = true;
            const ill = addIllness(state, key, { name: g.name, type: g.mental ? 'mental' : 'physical', severity: 18, chronic: true, source: 'genetic' }, rng, log);
            if (ill) { p.onset = { name: ill.name }; onsets.push({ key, name: ill.name, fever: false }); }
        }
    }
    // now and then someone just falls ill, more often in the cold months; never piled up
    if (random && rng() < HEALTH_REALISM.randomPerDay * days) {
        const key = rng() < 0.5 ? 'char' : 'user';
        const p = h[key];
        const pool = RANDOM.filter(r => (!r.months || r.months.includes(month)) && !p.ill.some(i => !i.cured && sameName(i.name, r.name)));
        if (pool.length && activeIll(p).length < 2) {
            let roll = rng() * pool.reduce((a, r) => a + r.weight, 0);
            const pick = pool.find(r => (roll -= r.weight) <= 0) ?? pool[0];
            const ill = addIllness(state, key, { name: pick.name, type: pick.type, severity: Math.round(pick.severity * 0.5), source: 'random' }, rng, log, { quiet: true });
            if (ill) {
                p.onset = { name: ill.name };
                onsets.push({ key, name: ill.name, fever: !!pick.fever });
                log(key, `заболевает: «${ill.name}»`, { notify: true });
            }
        }
    }
    return onsets;
}

// #endregion

// #region What the story says

export function addIllness(state, key, { name, type, severity = 15, chronic = false, source = 'story', about, care, meds }, rng = Math.random, log = () => {}, { quiet = false } = {}) {
    const p = ensureHealth(state)[key];
    if (!p || !name) return null;
    const now = absNow(state);
    const same = p.ill.find(i => !i.cured && sameName(i.name, name));
    if (same) {
        if (!same.remission) return null;
        // the chronic one is back
        Object.assign(same, { remission: false, severity: Math.max(same.severity, severity), trend: 'worsening' });
        log(key, `обострение: «${same.name}»`);
        return same;
    }
    const ill = {
        id: uid(rng),
        name: String(name).slice(0, 60),
        type: type === 'mental' || (type !== 'physical' && MENTAL_RE.test(name)) ? 'mental' : 'physical',
        chronic: !!chronic,
        severity: Math.max(1, Math.min(100, severity)),
        start: now,
        source,
        diag: { status: 'none', told: null },
        untreated: 0,
        remission: false,
        cured: false,
        relapse: null,
        trend: 'onset',
        about: about ? String(about).slice(0, 300) : null,
        care: list(care),
        medsHint: list(meds),
    };
    p.ill.push(ill);
    if (p.ill.length > 12) p.ill = p.ill.filter(i => !i.cured || i.relapse).slice(-12);
    if (!quiet) log(key, `${ill.type === 'mental' ? 'психика' : 'болезнь'}: «${ill.name}», ${stageOf(ill.severity).name}`);
    return ill;
}

function addMed(state, key, { name, forName, schedule, days, source }, rng, log) {
    const p = ensureHealth(state)[key];
    if (!p || !name || p.meds.some(m => sameName(m.name, name))) return p?.meds.find(m => sameName(m.name, name)) ?? null;
    const now = absNow(state);
    const target = p.ill.find(i => !i.cured && sameName(i.name, forName)) ?? activeIll(p).sort((a, b) => b.severity - a.severity)[0] ?? null;
    const med = {
        id: uid(rng),
        name: String(name).slice(0, 60),
        forId: target?.id ?? null,
        schedule: String(schedule || '1 раз в день').slice(0, 40),
        left: Math.max(1, Math.min(3650, parseInt(days, 10) || 14)),
        start: now,
        last: null,
        doses: 0,
        missed: 0,
        side: [],
        interaction: null,
        source,
    };
    if (rng() < HEALTH_REALISM.sideEffect) {
        const pool = target?.type === 'mental' ? SIDE_EFFECTS.mental : SIDE_EFFECTS.physical;
        med.side = [...new Set([pool[Math.floor(rng() * pool.length)], ...(rng() < 0.3 ? [pool[Math.floor(rng() * pool.length)]] : [])])];
    }
    if (p.meds.length && rng() < HEALTH_REALISM.interaction) med.interaction = INTERACTIONS[Math.floor(rng() * INTERACTIONS.length)];
    p.meds.push(med);
    log(key, `${source === 'self' ? 'принимает' : 'назначен'} «${med.name}»${med.side.length ? ` — побочно: ${med.side.join(', ')}` : ''}`);
    return med;
}

const absNow = state => state.clock.day * DAY_MIN + state.clock.minutes;

/**
 * What the reading found in this reply: someone fell ill, took a pill, saw a doctor, got better, went to hospital.
 * @param {Array} events [{ action, who, ... }] from the analysis
 * @returns {Array<{key, name, fever}>} new illnesses (for the body)
 */
export function applyHealth(state, events, rng = Math.random, log = () => {}) {
    const h = ensureHealth(state);
    const onsets = [];
    const now = absNow(state);
    for (const ev of (Array.isArray(events) ? events : []).slice(0, 8)) {
        const key = ev?.who === 'user' ? 'user' : ev?.who === 'char' ? 'char' : null;
        const p = key && h[key];
        if (!p) continue;
        switch (String(ev.action ?? '')) {
            case 'illness_new': {
                const ill = addIllness(state, key, {
                    name: ev.name, type: ev.type, severity: SEVERITY[String(ev.severity ?? 'mild').toLowerCase()] ?? 15,
                    chronic: ev.chronic === true, about: ev.about, care: ev.care, meds: ev.meds,
                }, rng, log);
                if (ill) onsets.push({ key, name: ill.name, fever: ev.fever === true || FEVER_RE.test(ill.name) || !!diseaseInfo(ill.name)?.fever });
                if (p.onset && sameName(p.onset.name, ev.name)) p.onset = null;
                break;
            }
            case 'med_taken': {
                let med = p.meds.find(m => sameName(m.name, ev.med ?? ev.name));
                // something from the cabinet nobody prescribed: self-treatment
                if (!med) med = addMed(state, key, { name: ev.med ?? ev.name, forName: ev.for, schedule: 'по необходимости', days: 7, source: 'self' }, rng, log);
                if (!med) break;
                med.last = now;
                med.doses += 1;
                med.missed = 0;
                const ill = p.ill.find(i => i.id === med.forId && !i.cured && !i.remission);
                // a pill eases a body's attack at once; the mind takes weeks
                if (ill && ill.type === 'physical') {
                    ill.severity = Math.max(0, ill.severity - (diseaseInfo(ill.name)?.episodic ? Math.max(8, ill.severity * 0.75) : 4 * (1 - ill.severity / 100)));
                    ill.trend = 'improving';
                    if (ill.severity <= 2) finish(p, ill, log, key);
                }
                break;
            }
            case 'med_stop': {
                const i = p.meds.findIndex(m => sameName(m.name, ev.med ?? ev.name));
                if (i >= 0) { log(key, `бросил${key === 'user' ? 'а' : ''} «${p.meds[i].name}»`); p.meds.splice(i, 1); }
                break;
            }
            case 'doctor_visit': doctor(state, key, p, ev, rng, log); break;
            case 'cured': {
                const act = activeIll(p);
                const ill = act.find(i => sameName(i.name, ev.name)) ?? (act.length === 1 ? act[0] : null);
                if (!ill) break;
                // no miracle cures: a heavy illness only takes a big step towards it
                const treated = ill.diag.status === 'diagnosed' && p.meds.some(m => m.forId === ill.id);
                const limit = diseaseInfo(ill.name)?.episodic ? 55 : treated ? 40 : 28;
                if (ill.severity <= limit) { ill.severity = ill.chronic ? REMISSION_AT : 0; finish(p, ill, log, key); } else { ill.severity = limit; ill.trend = 'improving'; log(key, `«${ill.name}» идёт на поправку`); }
                break;
            }
            case 'hospital': {
                const into = /admit|in/i.test(String(ev.state ?? ''));
                if (into && !p.hospital) { p.hospital = { since: now, ready: false }; log(key, 'в больнице', { notify: true }); }
                if (!into && p.hospital) { p.hospital = null; log(key, 'выписан' + (key === 'user' ? 'а' : '') + ' из больницы', { notify: true }); }
                break;
            }
            case 'genetic_reveal': {
                const name = String(ev.name ?? '').slice(0, 60);
                if (name && !p.genetics.some(g => sameName(g.name, name))) {
                    p.genetics.push({ name, risk: Math.max(1, Math.min(95, parseInt(ev.risk, 10) || 30)), mental: ev.type === 'mental' || MENTAL_RE.test(name), shown: false });
                    log(key, `предрасположенность: «${name}»`);
                }
                break;
            }
            default: break;
        }
    }
    return onsets;
}

function doctor(state, key, p, ev, rng, log) {
    const told = String(ev.diagnosis ?? '').slice(0, 80);
    let ill = p.ill.find(i => !i.cured && sameName(i.name, told)) ?? activeIll(p).filter(i => i.diag.status !== 'diagnosed').sort((a, b) => b.severity - a.severity)[0] ?? null;
    if (ill) {
        if (ev.about && !ill.about) ill.about = String(ev.about).slice(0, 300);
        if (!ill.care) ill.care = list(ev.care);
        if (ill.diag.status === 'misdiagnosed') {
            if (rng() < 0.6) { ill.diag = { status: 'diagnosed', told: ill.name }; log(key, `диагноз уточнён: «${ill.name}»`); }
        } else if (ill.diag.status === 'none') {
            // doctors sometimes get it wrong: the characters do not know, the treatment just does not help
            if (told && !sameName(told, ill.name) && rng() < HEALTH_REALISM.misdiagnosis) {
                ill.diag = { status: 'misdiagnosed', told };
                log(key, `диагноз: «${told}» (на самом деле — «${ill.name}»)`);
            } else {
                ill.diag = { status: 'diagnosed', told: told || ill.name };
                log(key, `диагноз: «${ill.diag.told}»`);
            }
        }
    } else if (told) {
        // the doctor names something the tracker did not know yet
        ill = addIllness(state, key, { name: told, type: ev.type, severity: SEVERITY[String(ev.severity ?? 'mild')] ?? 20, about: ev.about, care: ev.care }, rng, log);
        if (ill) ill.diag = { status: 'diagnosed', told };
    }
    for (const m of (Array.isArray(ev.prescribed) ? ev.prescribed : []).slice(0, 4)) {
        const name = typeof m === 'string' ? m : m?.name;
        if (name) addMed(state, key, { name, forName: ill?.name ?? told, schedule: m?.schedule, days: m?.days, source: 'doctor' }, rng, log);
    }
    const next = Number(ev.next_visit_days);
    p.nextVisit = next >= 1 && next <= 365 ? state.clock.day + Math.round(next) : ill && !ill.cured ? state.clock.day + 7 : p.nextVisit;
}

// #endregion

// #region For the story model, the reader and Stork's body

const TREND_EN = { worsening: 'worsening', improving: 'improving', onset: 'just started', stable: 'stable' };
/**
 * What the story model needs: each illness at its stage, the medicines and their side effects, a hospital, a visit due,
 * a new onset to play. Short, no tags (Stork's analysis reads the story). '' when both are well.
 */
export function healthPrompt(state, names = {}, { pregnant = false } = {}) {
    const h = state.health;
    if (!h) return '';
    const day = state.clock.day;
    const out = [];
    for (const key of ['char', 'user']) {
        const p = h[key];
        if (!p) continue;
        const who = names[key] || (key === 'char' ? '{{char}}' : '{{user}}');
        const lines = [];
        for (const ill of activeIll(p)) {
            const st = stageOf(ill.severity);
            const diag = ill.diag.status === 'diagnosed' ? `diagnosed as «${ill.diag.told || ill.name}»`
                : ill.diag.status === 'misdiagnosed' ? `the doctor said «${ill.diag.told}», but it is really «${ill.name}» — nobody knows; the treatment does not help`
                    : 'not diagnosed yet: they feel the symptoms, they do not know the name';
            lines.push(`«${ill.name}» (${ill.type === 'mental' ? 'mind' : 'body'}), ${st.en}, ${TREND_EN[ill.trend] ?? 'stable'}${ill.chronic ? ', chronic' : ''}; ${diag}.`);
            if (ill.severity >= HOSPITAL_AT && !p.hospital) lines.push('Critical: the story has to move towards emergency care now.');
        }
        const rem = p.ill.filter(i => i.remission);
        if (rem.length) lines.push(`In remission: ${rem.map(i => `«${i.name}»`).join(', ')} — an occasional echo at most.`);
        for (const m of p.meds) {
            const parts = [`takes «${m.name}» (${m.schedule})`];
            if (m.missed >= 2) parts.push(`but has missed it ${m.missed} days — the symptoms come back${/антидеп|сиозс|нормотим|антипсих/i.test(m.name) ? ', and the withdrawal shows' : ''}`);
            if (m.side.length) parts.push(`side effects: ${m.side.join(', ')}`);
            if (m.interaction) parts.push(`interaction: ${m.interaction}`);
            lines.push(`${parts.join('; ')}.`);
        }
        if (p.hospital) lines.push(`In hospital (${Math.max(0, day - Math.floor(p.hospital.since / DAY_MIN))} days): the scenes happen in and around it${p.hospital.ready ? '; better now — discharge can come' : ''}.`);
        if (p.nextVisit !== null && p.nextVisit !== undefined) {
            if (p.nextVisit <= day) lines.push('A doctor\'s appointment is due: they go, or skip it (skipping has consequences).');
            else if (p.nextVisit - day <= 2) lines.push(`A doctor's appointment in ${p.nextVisit - day} day(s).`);
        }
        if (p.onset) lines.push(`Coming down with «${p.onset.name}» now: the first symptoms, subtle, unnamed — they do not know yet what it is.`);
        if (lines.length) out.push(`${who}: ${lines.join(' ')}`);
    }
    if (!out.length) return '';
    const L = ['[Health — the tracker counts the course, the story portrays it; never mention the tracker.]', ...out];
    L.push(`Symptoms at their stage shape the scene — pace, mood, what the body can do — in ways true to each of them, not the same way every reply; the mind colours ${names.char || '{{char}}'}'s thoughts and reactions. ${names.user || '{{user}}'}'s illness shows only from the outside — what can be seen or what others notice; never her thoughts or choices. Real people put off doctors, forget pills, hide symptoms. No cure in one scene; the mind takes months.`);
    if (pregnant) L.push('She is pregnant: every prescription must be pregnancy-safe (doctors change or refuse what is not), a high fever or a severe illness threatens the pregnancy and is treated with urgency, the mind is more fragile.');
    return L.join('\n');
}

/** For Stork's analysis: what is tracked now, so the reader names the same illness and medicine, not a new one. */
export function healthKnown(state, names = {}) {
    const h = state.health;
    if (!h) return '';
    return ['char', 'user'].map(key => {
        const p = h[key];
        const ills = (p?.ill ?? []).filter(i => !i.cured).map(i => `${i.name}${i.remission ? ' (remission)' : ''}`);
        const meds = (p?.meds ?? []).map(m => m.name);
        if (!ills.length && !meds.length && !p?.hospital) return '';
        return `${names[key] || key}: ${[ills.length && `ill: ${ills.join(', ')}`, meds.length && `medicines: ${meds.join(', ')}`, p.hospital && 'in hospital'].filter(Boolean).join('; ')}`;
    }).filter(Boolean).join('\n');
}

/**
 * What illness does to the body Stork tracks: desire and energy. Fever, pain, a low mood, a medicine that dulls desire.
 * @returns {{ desire: number, energy: number, ru: string[], en: string[] }} desire and energy offsets (-0.4..0)
 */
export function healthOnBody(state, key) {
    const p = state.health?.[key];
    if (!p) return { desire: 0, energy: 0, ru: [], en: [] };
    let desire = 0, energy = 0;
    const ru = [], en = [];
    for (const ill of activeIll(p)) {
        const k = ill.severity / 100;
        if (ill.type === 'mental') {
            desire -= 0.35 * k + (/депресс/i.test(ill.name) ? 0.1 : 0);
            energy -= 0.25 * k;
        } else {
            desire -= 0.4 * k;
            energy -= 0.45 * k;
        }
        if (ill.severity >= 25) { ru.push(`${ill.name.toLowerCase()} гасит`); en.push(`${ill.name} (${stageOf(ill.severity).en}) weighs on it`); }
    }
    if (p.meds.some(m => m.side.includes('снижение либидо') || m.side.includes('эмоциональная притуплённость'))) { desire -= 0.12; ru.push('побочка лекарства'); en.push('a medicine that dulls it'); }
    return { desire: Math.max(-0.4, desire), energy: Math.max(-0.4, energy), ru, en };
}

// #endregion
