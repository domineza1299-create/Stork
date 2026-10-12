/*
 * What both looks share: the Stork window (window.js, classic.js) and the infoblock in the chat (ui.js).
 * Words, small calculations and the bits of markup that are the same in both, so a wording or a rule
 * changes in one place. Only the layout around them differs between the two looks.
 */
import { getContext } from '../../../extensions.js';
import { careOf, cycleInfo, FEMALE_CONDITIONS, FEMALE_CONTRACEPTION, FEMALE_HABITS, MALE_FERTILITY, pillState } from './biology.js';
import { dateLabel, liveNow, maleSnapshot, recoveryLeft, withLive } from './engine.js';
import { readStatus } from './store.js';

// Persona avatar lives in personas.js; loaded lazily so a missing module never breaks Stork
let personas = null;
import('../../../personas.js').then(m => { personas = m; }).catch(() => { });

// #region Words

export const PHASE_TONE = { menstruation: 'period', follicular: 'calm', ovulation: 'fertile', luteal: 'calm', pms: 'warm' };
export const ACT_LABEL = { none: 'без защиты', condom: 'презерватив', withdrawal: 'прерванный акт' };
export const KIND_ICON = { doctor: 'fa-user-doctor', labor: 'fa-baby', injury: 'fa-bandage', recovered: 'fa-battery-full', event: 'fa-circle-dot' };

export const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const icon = (name, extra = '') => `<i class="fa-solid ${name} stk-ic ${extra}"></i>`;
/** 21 год, 24 года, 25 лет */
export function years(n) {
    const tens = n % 100;
    const ones = n % 10;
    const word = tens >= 11 && tens <= 14 ? 'лет' : ones === 1 ? 'год' : ones >= 2 && ones <= 4 ? 'года' : 'лет';
    return `${n} ${word}`;
}
export const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1);
export const nameOf = person => person.name || (person.key === 'user' ? 'Ты' : 'Персонаж');
export const clamp01 = value => Math.min(1, Math.max(0, Number(value) || 0));
/** «высокое влечение», «высокая энергия» */
export const levelWord = (value, female = false) => (value > 0.8 ? (female ? 'высокая' : 'высокое') : value > 0.55 ? (female ? 'обычная' : 'обычное') : (female ? 'низкая' : 'сниженное'));
export const joinWhy = (...parts) => parts.filter(Boolean).join('; ');
/** Hours in words: «~5 ч», «~2 дн.» */
export const hoursWord = h => (h >= 36 ? `~${Math.round(h / 24)} дн.` : `~${Math.max(1, Math.round(h))} ч`);
/** «сегодня», «вчера», «5 дн. назад» */
export const agoWord = days => (days === 0 ? 'сегодня' : days === 1 ? 'вчера' : `${days} дн. назад`);
/** The baby's weight: grams, kilograms, or «меньше 1 г» */
export const babyWeight = grams => (grams >= 1000 ? `${(grams / 1000).toFixed(1)} кг` : grams < 1 ? 'меньше 1 г' : `${grams} г`);

export const knowsPregnancy = person => !!person.female.pregnancy?.knownBy.includes(person.key);

/** What comes next in her cycle, in words. */
export function nextInCycle(s, suppressed) {
    if (s.late) return `месячные запаздывают на ${s.cycleDay - s.length} дн.`;
    if (suppressed) return `до кровотечения отмены ${s.daysToPeriod} дн.`;
    if (s.relative < -5) return `фертильные дни через ${-5 - s.relative} дн., овуляция через ${-s.relative} дн.`;
    if (s.relative < 0) return `фертильные дни, овуляция через ${-s.relative} дн.`;
    if (s.relative === 0) return 'сегодня овуляция';
    return `до месячных ${s.daysToPeriod} дн.`;
}

/** Closeness without protection (or a broken condom) in her fertile days, in the last five days: a pregnancy is possible. */
export function riskyLately(state) {
    const f = state.people.user.female;
    const lastAct = state.acts.at(-1);
    if (!lastAct || f.pregnancy || f.postpartum) return false;
    const day = state.clock.day;
    return cycleInfo(f, day).fertile && !pillState(f, day).suppressed && (lastAct.protection === 'none' || lastAct.condomBroke) && day - lastAct.day <= 5;
}

/** The latest story events worth showing (no dice, no plain «близость»), newest first. */
export const recentEvents = (state, count) => [...state.log].reverse().filter(e => !['roll', 'intimacy'].includes(e.kind)).slice(0, count);

// #endregion

// #region Avatars

/** Avatar of {{char}} (card) or {{user}} (persona), or null. */
export function avatarUrl(key) {
    try {
        const ctx = getContext();
        if (key === 'char') {
            const ch = ctx.characters?.[ctx.characterId];
            return ch?.avatar && ch.avatar !== 'none' ? `/thumbnail?type=avatar&file=${encodeURIComponent(ch.avatar)}` : null;
        }
        const file = personas?.user_avatar;
        if (file) return `/thumbnail?type=persona&file=${encodeURIComponent(file)}`;
        return document.querySelector('#chat .mes[is_user="true"] .avatar img')?.getAttribute('src') || null;
    } catch {
        return null;
    }
}
export const initials = name => String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase() || '?';

// #endregion

// #region Why the levels are what they are
// The body's reasons only: what the story does to them is told by the note from the scene analysis.

/** Her levels outside pregnancy, with the reasons in words. */
export function femaleLevels(state, person, s) {
    const live = liveNow(state, person.key);
    return {
        live,
        libido: withLive(s.libido, live.libido),
        energy: withLive(s.energy, live.energy),
        energyWhy: s.energy > 0.7 ? 'фаза даёт силы' : s.energy > 0.45 ? 'ровная' : 'фаза забирает силы',
        libidoWhy: `${s.phaseLabel}, ${s.libido > 0.8 ? 'на пике' : s.libido > 0.5 ? 'обычное для этих дней' : 'обычно ниже'}`,
    };
}

/** What is part of her: conditions, habits, perimenopause. */
export const femaleTraits = f => [
    ...Object.entries(FEMALE_CONDITIONS).filter(([k]) => f[k]).map(([, c]) => c.label),
    ...Object.entries(FEMALE_HABITS).filter(([k]) => f[k]).map(([, h]) => h.label),
    f.perimenopause ? 'перименопауза' : '',
].filter(Boolean);

/** Her desire while pregnant, and why. */
export const pregnancyLibidoWhy = info => (info.trimester === 2 ? 'во втором триместре обычно выше' : 'в этом триместре обычно ниже');

/**
 * Everything about him with the reasons in words: both looks show the same numbers and explain them the same way.
 * `freshLabels`: what hit him today or yesterday (alcohol, illness, stress); the other reasons leave them out, so they are said once.
 */
export function maleLevels(state, person) {
    const m = person.male;
    const s = maleSnapshot(state, person);
    const live = liveNow(state, person.key);
    const traits = [m.smoker ? 'курит' : '', m.drinker ? 'выпивает' : '', m.varicocele ? 'варикоцеле' : ''].filter(Boolean);
    const freshLabels = [...new Set(s.recent.filter(e => e.daysAgo <= 1).map(e => e.label))];
    const vigor = withLive(s.testosterone, live.energy);
    const libido = withLive(s.libido, live.libido);
    const hour = Math.floor(state.clock.minutes / 60);
    const dayWhy = hour >= 5 && hour < 12 ? 'утром тестостерон на пике' : hour >= 18 || hour < 5 ? 'к вечеру гормоны ниже' : 'днём ровно';
    // why the sperm numbers are what they are, with when it passes
    const delayed = s.reasons.map(r => `${r.label} ${r.daysAgo ? `${r.daysAgo} дн. назад` : 'сегодня'} — пройдёт через ${Math.ceil(r.recoversInDays / 7)} нед.`);
    const erectionOk = s.erection >= 0.75;
    return {
        s,
        live,
        traits,
        freshLabels,
        left: recoveryLeft(state, person),
        vigor,
        vigorWord: vigor > 0.85 ? 'на пике' : vigor > 0.65 ? 'в форме' : 'устал',
        vigorWhy: joinWhy(dayWhy, s.expectingFather ? 'будущий отец: гормоны ниже' : ''),
        libido,
        libidoWhy: s.daysSinceLast === 0 ? 'после близости ниже' : s.daysSinceLast !== null && s.daysSinceLast >= 4 ? `${s.daysSinceLast} дн. без близости, поэтому выше` : '',
        erectionOk,
        erectionWhy: freshLabels.length ? freshLabels.join(', ') : 'усталость или возраст',
        countWhy: joinWhy(
            s.reserve < 0.95 ? 'после недавней близости меньше обычного' : '',
            delayed.join('; '),
            MALE_FERTILITY[m.fertility]?.factor < 1 ? `фертильность: ${MALE_FERTILITY[m.fertility].label}` : '',
            traits.length && s.spermCount < 90 ? `влияет: ${traits.join(', ')}` : ''),
        motilityWhy: joinWhy(delayed.length ? 'тот же сдвиг, что и у количества: сперма созревает около 74 дней' : 'в норме', traits.length ? `влияет: ${traits.join(', ')}` : ''),
        // said of the reserve: «полный», «восстановится полностью через ~5 ч…»
        reserveWhy: s.reserve >= 0.99 ? 'полный' : s.reserveFullInHours ? `восстановится полностью через ${hoursWord(s.reserveFullInHours)} по времени истории` : 'восстанавливается',
        fertilityLine: `фертильность: ${MALE_FERTILITY[m.fertility]?.label ?? 'норма'}${traits.length ? ` · ${traits.join(', ')}` : ''}`,
    };
}

// #endregion

// #region Sperm: one compact panel for both looks

/** How likely he is to make her pregnant now, in one word: count and motility together, the reserve inside the count. */
export function spermGrade(s) {
    if (s.vasectomy === 'защищает') return { word: 'нет', tone: 'calm', value: 0 };
    const value = clamp01(s.countNow / 100) * Math.sqrt(clamp01(s.motility / 100));
    if (value >= 0.75) return { word: 'высокая', tone: 'pink', value };
    if (value >= 0.5) return { word: 'обычная', tone: 'accent', value };
    if (value >= 0.25) return { word: 'снижена', tone: 'warm', value };
    return { word: 'низкая', tone: 'period', value };
}

const LIST = items => (items.length > 1 ? `${items.slice(0, -1).join(', ')} и ${items.at(-1)}` : items[0] ?? '');
const weeksWord = days => {
    const w = Math.max(1, Math.ceil(days / 7));
    return `${w} ${w % 10 === 1 && w % 100 !== 11 ? 'неделю' : [2, 3, 4].includes(w % 10) && ![12, 13, 14].includes(w % 100) ? 'недели' : 'недель'}`;
};

/**
 * A conclusion about his sperm from the numbers alone: what is affected now, what only later. Used while the
 * scene analysis has said nothing about it (the tag mode, or a quiet stretch of the story).
 */
export function spermConclusion(state, person, L) {
    const s = L.s;
    if (s.vasectomy === 'защищает') return 'После вазэктомии сперматозоидов в эякуляте нет: зачатие от него невозможно, на влечение и эрекцию это не влияет.';
    if (s.vasectomy) return `Вазэктомия ещё не действует: в семенных путях остаются сперматозоиды, ${s.vasectomy.replace('ещё не защищает, ', '')} — до этого предохраняться нужно как обычно.`;
    const parts = [];
    const fresh = [...new Set(s.recent.filter(e => e.daysAgo <= 1 && ['alcohol', 'stress', 'no_sleep', 'fever', 'cannabis'].includes(e.type)).map(e => e.label))];
    if (fresh.length) parts.push(`${capitalize(LIST(fresh))} сразу бьют по эрекции и выносливости, а на самой сперме скажутся только через 2–3 месяца: столько она созревает.`);
    const delayed = [...s.reasons].sort((a, b) => b.recoversInDays - a.recoversInDays)[0];
    if (delayed && delayed.daysAgo >= 7) {
        parts.push(`Сейчас аукается ${delayed.label} ${delayed.daysAgo} дн. назад: сперматозоидов меньше и они медленнее, норма вернётся примерно через ${weeksWord(delayed.recoversInDays)}.`);
    }
    if (s.reserve < 0.6) {
        parts.push(`Запас после недавней разрядки ещё не восстановился: в эякуляте меньше сперматозоидов${s.reserveFullInHours ? `, полностью — через ${hoursWord(s.reserveFullInHours)}` : ''}.`);
    } else if (s.daysSinceLast !== null && s.daysSinceLast >= 4 && s.reserve >= 0.95) {
        parts.push(`${s.daysSinceLast} дн. без разрядки: запас полный, сперматозоидов больше обычного — шанс зачатия сейчас выше среднего.`);
    }
    if (MALE_FERTILITY[person.male.fertility]?.factor < 1 && parts.length < 2) parts.push(`Фертильность от природы ${MALE_FERTILITY[person.male.fertility].label}: зачатие возможно, но обычно требует больше времени.`);
    if (!parts.length) return 'Количество и подвижность в норме для его возраста, запас полный: по его части ничто не мешает зачатию.';
    return parts.slice(0, 2).join(' ');
}

/** One test tube: the level is the value, the number on top, a short word under it. */
function vial(label, value, text, tone, why) {
    const v = Math.round(clamp01(value) * 100);
    return `<div class="stk-vial t-${tone}" style="--v:${v}%" title="${esc(`${label}: ${text}${why ? ` — ${why}` : ''}`)}">
        <b>${esc(text)}</b><span class="stk-vial-tube"><i></i></span><small>${esc(label)}</small></div>`;
}

/**
 * Sperm in one compact panel: three tubes (count, motility, reserve) and one conclusion in words beside them —
 * from the scene analysis when it has one, otherwise from the numbers.
 */
export function spermPanel(state, person, L) {
    const s = L.s;
    const grade = spermGrade(s);
    const live = liveNow(state, person.key);
    const fromStory = !!live.spermNote;
    const text = live.spermNote ?? spermConclusion(state, person, L);
    // what weighs on him lately, as plain words: no «сегодня:» in front, the day is in the hint
    const factors = [...new Map(s.recent.filter(e => e.daysAgo <= 3).map(e => [e.label, e])).values()];
    const chips = factors.map(e => `<span title="${esc(agoWord(e.daysAgo))}">${esc(e.label)}</span>`).join('');
    return `<div class="stk-semen">
        <div class="stk-vials" aria-label="${esc(`количество ${s.countNow}%, подвижность ${s.motility}%, запас ${Math.round(s.reserve * 100)}%`)}">
            ${vial('количество', s.countNow / 100, `${s.countNow}%`, 'pink', L.countWhy || 'в норме')}
            ${vial('подвижность', s.motility / 100, `${s.motility}%`, 'preg', L.motilityWhy)}
            ${vial('запас', s.reserve, `${Math.round(s.reserve * 100)}%`, 'accent', L.reserveWhy)}
        </div>
        <div class="stk-semen-text">
            <div class="stk-semen-grade"><span>Плодовитость</span><b class="t-${grade.tone}">${esc(grade.word)}</b></div>
            ${chips ? `<div class="stk-chips">${chips}</div>` : ''}
            <p class="stk-semen-note${fromStory ? ' is-story' : ''}">${fromStory ? icon('fa-feather-pointed') : ''}${esc(text)}</p>
        </div>
    </div>`;
}

// #endregion

/** What the story established about this pregnancy, by week: the same list in the window and the infoblock. */
export function pregnancyFacts(p) {
    if (!p?.facts?.length) return '';
    return `<div class="stk-facts"><div class="stk-sub">${icon('fa-feather-pointed')}Из истории</div>
        ${p.facts.map(f => `<div class="stk-fact"><b>${f.week} нед.</b><span>${esc(f.text)}</span></div>`).join('')}</div>`;
}

// #region A pregnancy the story stated: she accepts, fixes the term or rejects it

/** The card that asks her, or '' when nothing waits. Same in the window and in the infoblock. */
export function claimCard(state) {
    const c = state.pregnancyClaim;
    if (c?.status !== 'pending') return '';
    const woman = state.people.user;
    const term = c.kind === 'term';
    const termText = `${c.weeks} нед.${c.days ? ` ${c.days} дн.` : ''}`;
    const text = term
        ? `В истории другой срок, и Stork уже записал его: <b>${esc(termText)}</b> — оставить так?`
        : `Stork записал: ${esc(nameOf(woman))} беременна, срок <b>${esc(termText)}</b>${c.guessed ? ' (примерно, по последней близости: в тексте срока нет)' : ''} — всё верно?`;
    return `<div class="stk-claim stk-edit" data-key="claim">
        <div class="stk-claim-head">${icon(term ? 'fa-calendar-check' : 'fa-person-pregnant')}<b>${term ? 'Срок из истории' : 'Беременность из истории'}</b><span>ждёт ответа</span></div>
        ${c.quote ? `<q>${esc(c.quote)}</q>` : ''}
        <div class="stk-claim-text">${text}</div>
        <div class="stk-claim-term">
            <span>Срок</span>
            <input class="text_pole" data-f="weeks" type="number" min="1" max="42" value="${c.weeks}" aria-label="недель"><span>нед.</span>
            <input class="text_pole" data-f="days" type="number" min="0" max="6" value="${c.days ?? 0}" aria-label="дней"><span>дн.</span>
            <button type="button" class="stk-btn is-ghost" data-stk-act="claim-term">${icon('fa-pen')}Поправить</button>
        </div>
        <div class="stk-actions">
            <button type="button" class="stk-btn is-primary" data-stk-act="claim-accept">${icon('fa-check')}Принять</button>
            <button type="button" class="stk-btn is-ghost" data-stk-act="claim-reject">${icon('fa-xmark')}${term ? 'Вернуть прежний срок' : 'Отклонить: не беременна'}</button>
        </div>
    </div>`;
}

// #endregion

// #region Reading the story

/** «читаю последний ответ», or the failed analysis with a retry button. */
export function readingLine() {
    const rs = readStatus();
    if (rs.index !== null) return `<div class="stk-reading">${icon('fa-feather-pointed')}<span>читаю последний ответ — показатели обновятся</span></div>`;
    if (rs.failed) {
        return `<div class="stk-reading is-failed">${icon('fa-triangle-exclamation')}<span>анализ не прошёл${rs.failed.error ? `: ${esc(rs.failed.error)}` : ''}</span>
            <button type="button" class="stk-btn is-ghost" data-stk-act="retry">${icon('fa-rotate-right')}Повторить</button>
            <button type="button" class="stk-btn is-ghost" data-stk-act="download-log" title="Скачать журнал Stork для разработчика">${icon('fa-download')}Журнал</button></div>`;
    }
    return '';
}

// #endregion

// #region Calendar

/**
 * Her cycle as a strip of days. The window shows a tooltip on each day; past days are dimmed in the infoblock.
 * @param {{titles?: boolean}} [options]
 */
export function cycleStrip(f, day, { titles = false } = {}) {
    const info = cycleInfo(f, day);
    const pill = pillState(f, day);
    const cells = [];
    for (let d = 1; d <= info.length; d++) {
        const at = cycleInfo(f, f.cycleStart + d - 1);
        const classes = [`is-${PHASE_TONE[at.phase]}`];
        const fertile = at.fertile && !pill.suppressed;
        if (fertile) classes.push('is-window');
        if (at.relative === 0 && !pill.suppressed) classes.push('is-ovulation');
        if (d < info.cycleDay) classes.push('is-past');
        if (d === info.cycleDay) classes.push('is-today');
        const title = titles ? ` title="день ${d}: ${at.phaseLabel}${fertile ? ', фертильно' : ''}"` : '';
        cells.push(`<span class="${classes.join(' ')}"${title}></span>`);
    }
    return `<div class="stk-cycle"${titles ? '' : ' aria-hidden="true"'}>${cells.join('')}</div>`;
}

/** «15 октября (через 5 дн.)», or short: «15 окт.» */
export function upcomingWhen(state, d, short = false) {
    const day = state.clock.day;
    if (short) return d === day ? 'сегодня' : d === day + 1 ? 'завтра' : dateLabel(state, d, { day: 'numeric', month: 'short' });
    return `${dateLabel(state, d, { day: 'numeric', month: 'long' })}${d === day ? ' (сегодня)' : ` (через ${d - day} дн.)`}`;
}

/** The next dates that matter: ovulation and period, or doctor visits and birth. [[day, icon, text]] */
export function upcomingRows(state, woman) {
    const f = woman.female;
    const day = state.clock.day;
    const rows = [];
    if (f.pregnancy && knowsPregnancy(woman)) {
        const p = f.pregnancy;
        const care = careOf(state);
        for (const visit of care.visits) {
            const visitDay = p.lmp + visit.week * 7;
            if (visitDay >= day && !p.visitsDone.includes(visit.week)) rows.push([visitDay, care.icon, visit.label]);
        }
        rows.push([p.lmp + 280, 'fa-baby', 'предполагаемая дата родов']);
    } else if (!f.postpartum && !f.pregnancy) {
        const s = cycleInfo(f, day);
        const start = f.cycleStart;
        const suppressed = pillState(f, day).suppressed;
        if (!suppressed && s.relative <= -5) rows.push([start + s.ovulation - 6, 'fa-heart', 'начало фертильных дней']);
        if (!suppressed && s.relative < 0) rows.push([start + s.ovulation - 1, 'fa-egg', 'овуляция']);
        rows.push([start + s.length, 'fa-droplet', suppressed ? 'кровотечение отмены' : 'следующие месячные']);
    }
    return rows.filter(([d]) => d >= day).sort((a, b) => a[0] - b[0]).slice(0, 4);
}

/**
 * The month grid: phases as a forecast, closeness and tests marked, past days (up to 60) pickable
 * to say «here her period started».
 * @returns {{month: Date, grid: string}}
 */
export function monthGrid(state, view, today) {
    const woman = state.people.user;
    const f = woman.female;
    const day = state.clock.day;
    const month = new Date(today.getFullYear(), today.getMonth() + (view.monthOffset ?? 0), 1);
    const dayOf = date => day + Math.round((date - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
    const actDays = new Set(state.acts.map(a => a.day));
    const testDays = new Set(state.rolls.filter(r => r.kind === 'test').map(r => r.day));
    const firstWeekday = (month.getDay() + 6) % 7;
    const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const editable = !f.pregnancy && !f.postpartum;
    const cells = Array.from({ length: firstWeekday }, () => '<span class="is-empty"></span>');

    for (let d = 1; d <= daysInMonth; d++) {
        const storyDay = dayOf(new Date(month.getFullYear(), month.getMonth(), d));
        const classes = [];
        // a known pregnancy is counted from her last period, the way its weeks are: no cycle forecast over it
        const pregnantThen = f.pregnancy && knowsPregnancy(woman) && storyDay >= f.pregnancy.lmp;
        if (pregnantThen) classes.push('is-preg');
        else if (!f.postpartum && !(f.pregnancy && storyDay >= f.pregnancy.conceptionDay)) {
            const length = f.cycleLength;
            const k = Math.floor((storyDay - f.cycleStart) / length);
            const at = cycleInfo({ ...f, cycleStart: f.cycleStart + k * length, cycleShift: k === 0 ? f.cycleShift : 0 }, storyDay);
            classes.push(`is-${PHASE_TONE[at.phase]}`);
            if (at.fertile && !pillState(f, storyDay).suppressed) classes.push('is-window');
            if (at.relative === 0 && !pillState(f, storyDay).suppressed) classes.push('is-ovulation');
        }
        if (storyDay === day) classes.push('is-today');
        if (storyDay > day) classes.push('is-future');
        if (view.pickDay === storyDay) classes.push('is-picked');
        const icons = `${actDays.has(storyDay) ? icon('fa-heart', 'stk-mark') : ''}${testDays.has(storyDay) ? icon('fa-vial', 'stk-mark') : ''}`;
        const marks = icons ? `<b class="stk-marks" aria-hidden="true">${icons}</b>` : '';
        const pickable = editable && storyDay <= day && day - storyDay <= 60;
        cells.push(pickable
            ? `<button type="button" class="${classes.join(' ')}" data-stk-act="cal-day" data-day="${storyDay}"><em>${d}</em>${marks}</button>`
            : `<span class="${classes.join(' ')}"><em>${d}</em>${marks}</span>`);
    }
    const grid = `<div class="stk-cal">
                ${['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map(w => `<span class="is-head">${w}</span>`).join('')}
                ${cells.join('')}
            </div>`;
    return { month, grid };
}

/** The picked day: «Здесь начались месячные» or cancel. */
export function pickBar(state, view) {
    const f = state.people.user.female;
    if (view.pickDay === null || view.pickDay === undefined || f.pregnancy || f.postpartum) return '';
    return `<div class="stk-pick">
                <span>${icon('fa-droplet')}${esc(capitalize(dateLabel(state, view.pickDay, { day: 'numeric', month: 'long' })))}</span>
                <button type="button" class="stk-btn is-primary" data-stk-act="cal-period">Здесь начались месячные</button>
                <button type="button" class="stk-btn is-ghost" data-stk-act="cal-unpick">Отмена</button>
            </div>`;
}

const IRREGULARITY = [[0, 'регулярный'], [2, 'слегка гуляет'], [5, 'нерегулярный']];
export const irregularityWord = f => Object.fromEntries(IRREGULARITY)[Number(f.irregularity)] ?? 'свой';

/** Her cycle set by hand (length, period, regularity) with the save button: saved in this chat. */
export function cycleFields(f) {
    return `<div class="stk-grid">
                <label class="stk-field"><span>Длина цикла, дней</span><input class="text_pole" data-f="cycleLength" type="number" min="21" max="35" value="${f.cycleLength}"></label>
                <label class="stk-field"><span>Месячные, дней</span><input class="text_pole" data-f="periodLength" type="number" min="3" max="7" value="${f.periodLength}"></label>
                <label class="stk-field"><span>Цикл</span><select class="text_pole" data-f="irregularity">
                    ${IRREGULARITY.map(([v, l]) => `<option value="${v}" ${Number(f.irregularity) === v ? 'selected' : ''}>${l}</option>`).join('')}
                </select></label>
            </div>
            <div class="stk-actions"><button type="button" class="stk-btn is-primary" data-stk-act="save-person" data-key="user">${icon('fa-check')}Сохранить цикл</button></div>`;
}

// #endregion

// #region Person editor (the pencil)

/**
 * The fields of the quick editor for one person. `long`: the window explains the conditions in the labels
 * and lists the checkboxes one per line; the infoblock keeps them short and in a row.
 * @returns {string} the grid, the checkboxes and the buttons
 */
export function personFields(state, key, { long = false } = {}) {
    const p = state.people[key];
    const check = (k, on, label) => `<label class="stk-check"><input type="checkbox" data-f="${k}" ${on ? 'checked' : ''}>${label}</label>`;
    const checks = html => (long ? html : `<div class="stk-checks">${html}</div>`);
    const condition = k => (long ? `${FEMALE_CONDITIONS[k].label}: ${FEMALE_CONDITIONS[k].note}` : FEMALE_CONDITIONS[k].label);
    const actions = `<div class="stk-actions">
            <button type="button" class="stk-btn is-primary" data-stk-act="save-person" data-key="${key}">${icon('fa-check')}Сохранить</button>
            <button type="button" class="stk-btn is-ghost" data-stk-act="cancel-edit">Отмена</button>
        </div>`;
    const age = `<label class="stk-field"><span>Возраст</span><input class="text_pole" data-f="age" type="number" min="18" max="90" value="${p.age}"></label>`;
    if (key === 'user') {
        const f = p.female;
        const cycleEditable = !f.pregnancy && !f.postpartum;
        const info = cycleEditable ? cycleInfo(f, state.clock.day) : null;
        return `<div class="stk-grid">
                ${age}
                ${cycleEditable ? `
                <label class="stk-field"><span>День цикла сейчас</span><input class="text_pole" data-f="cycleDay" type="number" min="1" max="35" value="${Math.min(f.cycleLength, Math.max(1, info.cycleDay))}"></label>
                <label class="stk-field"><span>Длина цикла</span><input class="text_pole" data-f="cycleLength" type="number" min="21" max="35" value="${f.cycleLength}"></label>
                <label class="stk-field"><span>Месячные, дней</span><input class="text_pole" data-f="periodLength" type="number" min="3" max="7" value="${f.periodLength}"></label>` : ''}
                <label class="stk-field"><span>Контрацепция</span><select class="text_pole" data-f="contraception">
                    ${Object.keys(FEMALE_CONTRACEPTION).filter(k => k !== 'pill_missed').map(k => `<option value="${k}" ${f.contraception === k ? 'selected' : ''}>${FEMALE_CONTRACEPTION[k].label}</option>`).join('')}
                </select></label>
            </div>
            ${checks(`${check('pmsSevere', f.pmsSevere, 'сильный ПМС')}${check('painfulPeriods', f.painfulPeriods, 'болезненные месячные')}
                ${check('pcos', f.pcos, condition('pcos'))}${check('endometriosis', f.endometriosis, condition('endometriosis'))}
                ${check('smoker', f.smoker, 'курит')}${check('drinker', f.drinker, 'часто выпивает')}`)}
            ${actions}`;
    }
    const m = p.male;
    return `<div class="stk-grid">
                ${age}
                <label class="stk-field"><span>Фертильность</span><select class="text_pole" data-f="fertility">
                    ${Object.entries(MALE_FERTILITY).map(([k, v]) => `<option value="${k}" ${m.fertility === k ? 'selected' : ''}>${v.label}</option>`).join('')}
                </select></label>
            </div>
            ${checks(`${check('smoker', m.smoker, 'курит')}${check('drinker', m.drinker, 'часто выпивает')}`)}
            ${actions}`;
}

// #endregion
