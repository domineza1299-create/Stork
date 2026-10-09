import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import {
    createPregnancy, cycleInfo, DOCTOR_VISITS, FEMALE_CONDITIONS, FEMALE_CONTRACEPTION, femaleState, laborProgress, maleState,
    MALE_FERTILITY, PERIOD_FLOW, perimenopause, pillState, pregnancyInfo, STORY_MODES,
} from './biology.js';
import { analyzeCards, getProfiles, guessAge, readCards } from './cards.js';
import { absMinute, advanceTime, applyEvent, dateLabel, maleSnapshot, MINUTES_PER_DAY, parseClock, storyDate, timeLabel } from './engine.js';
import { activeIn, currentState, onStateChange, refreshStatus, settings, updateCurrentState } from './store.js';

const TABS = [
    { id: 'today', icon: 'fa-sun', label: 'Сегодня' },
    { id: 'calendar', icon: 'fa-calendar-days', label: 'Календарь' },
    { id: 'pregnancy', icon: 'fa-baby', label: 'Беременность' },
    { id: 'journal', icon: 'fa-book-open', label: 'Журнал' },
    { id: 'settings', icon: 'fa-sliders', label: 'Настройки' },
];

const PHASE_TONE = { menstruation: 'period', follicular: 'calm', ovulation: 'fertile', luteal: 'calm', pms: 'warm' };

const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, extra = '') => `<i class="fa-solid ${name} stk-ic ${extra}"></i>`;
/** 21 год, 24 года, 25 лет */
function years(n) {
    const tens = n % 100;
    const ones = n % 10;
    const word = tens >= 11 && tens <= 14 ? 'лет' : ones === 1 ? 'год' : ones >= 2 && ones <= 4 ? 'года' : 'лет';
    return `${n} ${word}`;
}
const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1);
const nameOf = person => person.name || (person.key === 'user' ? 'Ты' : 'Персонаж');

/** Shows new story events as toasts (rolls stay secret). */
export function announce(events) {
    if (!settings().toasts) return;
    for (const event of events ?? []) {
        if (['roll', 'intimacy'].includes(event.kind)) continue;
        const text = event.text.charAt(0).toUpperCase() + event.text.slice(1);
        toastr.info(text, 'Stork', { timeOut: 7000, onclick: () => openStork() });
    }
}

function knowsPregnancy(person) {
    return !!person.female.pregnancy?.knownBy.includes(person.key);
}

// #region Status line

/** One short line above the input: date, and the most important about each person. */
function statusLineText(state) {
    const parts = [`${dateLabel(state, state.clock.day, { day: 'numeric', month: 'long' })}, ${timeLabel(state.clock.minutes)}`];
    for (const person of [state.people.user, state.people.char]) {
        let text;
        if (person.sex === 'female') {
            const f = person.female;
            if (f.pregnancy?.labor) text = 'роды';
            else if (f.pregnancy && knowsPregnancy(person)) {
                const info = pregnancyInfo(f.pregnancy, state.clock.day);
                text = `${info.week} нед., малыш размером с ${info.baby.compare}`;
            } else if (f.postpartum) text = `${state.clock.day - f.postpartum.birthDay} дн. после родов`;
            else {
                const info = cycleInfo(f, state.clock.day);
                text = info.late ? `задержка ${info.cycleDay - info.length} дн.` : `день ${info.cycleDay}, ${info.fertile && !pillState(f, state.clock.day).suppressed ? 'фертильно' : info.phaseLabel}`;
            }
        } else {
            const s = maleState(person.male, person.age, state.clock.day, state.clock.minutes);
            text = s.testosterone > 0.85 ? 'бодр' : s.testosterone > 0.65 ? 'в форме' : 'устал';
        }
        parts.push(`<b>${esc(nameOf(person))}:</b> ${esc(text)}`);
    }
    return parts.join('<span class="stk-dot-sep">·</span>');
}

export function renderStatusBar() {
    let bar = document.getElementById('stork_bar');
    const state = currentState();
    const show = settings().statusBar && activeIn(state);
    if (!show) {
        bar?.remove();
        return;
    }
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'stork_bar';
        bar.title = 'Stork: открыть подробности';
        bar.addEventListener('click', () => openStork());
        const form = document.getElementById('send_form');
        form?.parentElement?.insertBefore(bar, form);
    }
    bar.innerHTML = `${icon('fa-moon')}<span>${statusLineText(state)}</span>`;
}

// #endregion

// #region Setup

const ADULT_AGE = 18;

/**
 * Names always come from SillyTavern; ages from the analysis, the card text, or (if nothing found) a small field.
 * @returns {{user: {name: string, age: number|null}, char: {name: string, age: number|null}}}
 */
function cardPeople(view) {
    const cards = readCards();
    const analysis = view.analysis?.data;
    return {
        user: { name: cards.userName, age: analysis?.user?.age ?? guessAge(cards.userText) },
        char: { name: cards.charName, age: analysis?.char?.age ?? guessAge(cards.charText) },
    };
}

function ageBadge(key, person, view) {
    if (person.age) return `<span class="stk-muted">${years(person.age)}, из карточки</span>`;
    const manual = view.manualAge?.[key] ?? '';
    return `<label class="stk-inline-age"><span class="stk-muted">возраст не нашёлся в карточке:</span><input class="text_pole stk-age" data-person="${key}" type="number" min="18" max="90" value="${esc(manual)}" placeholder="лет"></label>`;
}

function renderAnalysis(view) {
    const a = view.analysis;
    let body = '';
    if (!a || a.loading) body = `<div class="stk-row stk-muted">${icon('fa-circle-notch', 'fa-spin')}читаю карточку, твою персону и начало РП…</div>`;
    else if (a.error) {
        body = `<div class="stk-row is-warn">${icon('fa-triangle-exclamation')}${esc(a.error)}</div>
            <div class="stk-actions"><button type="button" class="stk-btn is-ghost stk-analyze">${icon('fa-rotate-right')}Повторить</button></div>`;
    } else {
        const story = a.data.story ?? {};
        const start = a.data.start ?? {};
        body = `
            ${start.time || start.place ? `<div class="stk-row">${icon('fa-location-dot')}начало истории: ${esc([start.time, start.place].filter(Boolean).join(', '))}</div>` : ''}
            ${story.relationship ? `<div class="stk-row">${icon('fa-people-arrows')}${esc(story.relationship)}${story.trying_for_baby ? ', пытаются завести ребёнка' : ''}</div>` : ''}
            ${story.summary ? `<div class="stk-row">${icon('fa-eye')}${esc(story.summary)}</div>` : ''}
            <div class="stk-hint">${icon('fa-circle-check')}Всё подставлено ниже. Проверь и нажми «Включить».</div>`;
    }
    return `
        <div class="stk-card stk-analysis-card">
            <div class="stk-card-title">${icon('fa-wand-magic-sparkles')}Что Stork понял из карточек и РП</div>
            ${body}
        </div>`;
}

/** ISO date (yyyy-mm-dd) of the current story day, for the date field. */
function storyIsoDate(state) {
    const date = storyDate(state);
    if (!date) return new Date().toISOString().slice(0, 10);
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function renderSetup(state, view) {
    const people = cardPeople(view);
    const f = state.people.user.female;
    const m = state.people.char.male;
    const pre = view.analysis?.data;
    const preUser = pre?.user ?? {};
    const preChar = pre?.char ?? {};
    const contraception = preUser.contraception ?? f.contraception;
    const fertility = preChar.fertility ?? m.fertility;
    const cycleLength = preUser.cycle_length ?? f.cycleLength;
    const info = cycleInfo(f, state.clock.day);
    const pad = n => String(n).padStart(2, '0');
    const fromAnalysis = parseClock(pre?.start?.time);
    const minutes = fromAnalysis ?? state.clock.minutes;
    const startTime = `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
    const ageOf = key => people[key].age ?? (Number(view.manualAge?.[key]) || null);
    const minors = ['user', 'char'].filter(key => ageOf(key) && ageOf(key) < ADULT_AGE);
    const checked = (value, fallback) => ((value ?? fallback) ? 'checked' : '');

    return `
        ${renderAnalysis(view)}
        ${readingCard()}
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-venus')}${esc(people.user.name || '{{user}}')}${ageBadge('user', people.user, view)}</div>
            ${preUser.pregnant ? `<div class="stk-row">${icon('fa-person-pregnant')}по карточке беременна${preUser.pregnancy_weeks ? `, ${preUser.pregnancy_weeks} нед.` : ''}: Stork начнёт с этого срока</div>` : ''}
            <div class="stk-grid">
                <label class="stk-field"><span>Длина цикла, дней</span><input class="text_pole stk-in" data-k="cycleLength" type="number" min="21" max="35" value="${cycleLength}"></label>
                <label class="stk-field"><span>Месячные, дней</span><input class="text_pole stk-in" data-k="periodLength" type="number" min="3" max="7" value="${f.periodLength}"></label>
                <label class="stk-field"><span>Какой сейчас день цикла</span><input class="text_pole stk-in" data-k="cycleDay" type="number" min="1" max="35" value="${preUser.cycle_day ?? (state.setupDone ? Math.min(cycleLength, Math.max(1, info.cycleDay)) : view.randomDay)}"></label>
                <label class="stk-field"><span>Цикл</span>
                    <select class="text_pole stk-in" data-k="irregularity">
                        <option value="0" ${f.irregularity === 0 ? 'selected' : ''}>регулярный</option>
                        <option value="2" ${f.irregularity === 2 ? 'selected' : ''}>слегка гуляет</option>
                        <option value="5" ${f.irregularity === 5 ? 'selected' : ''}>нерегулярный</option>
                    </select>
                </label>
                <label class="stk-field"><span>Месячные по обильности</span>
                    <select class="text_pole stk-in" data-k="flow">
                        ${Object.entries(PERIOD_FLOW).map(([k, l]) => `<option value="${k}" ${(preUser.flow ?? f.flow ?? 'normal') === k ? 'selected' : ''}>${l}</option>`).join('')}
                    </select>
                </label>
                <label class="stk-field"><span>Контрацепция</span>
                    <select class="text_pole stk-in" data-k="contraception">
                        ${Object.keys(FEMALE_CONTRACEPTION).filter(k => k !== 'pill_missed').map(k => `<option value="${k}" ${contraception === k ? 'selected' : ''}>${FEMALE_CONTRACEPTION[k].label}</option>`).join('')}
                    </select>
                </label>
            </div>
            <div class="stk-actions">
                <button type="button" class="stk-btn is-ghost stk-random-day">${icon('fa-dice')}Случайный день цикла</button>
            </div>
            <label class="stk-check"><input type="checkbox" class="stk-in" data-k="pmsSevere" ${checked(preUser.pms_severe, f.pmsSevere)}>сильный ПМС</label>
            <label class="stk-check"><input type="checkbox" class="stk-in" data-k="painfulPeriods" ${checked(preUser.painful_periods, f.painfulPeriods)}>болезненные месячные</label>
            <label class="stk-check"><input type="checkbox" class="stk-in" data-k="pcos" ${checked(preUser.pcos, f.pcos)}>${FEMALE_CONDITIONS.pcos.label}: ${FEMALE_CONDITIONS.pcos.note}</label>
            <label class="stk-check"><input type="checkbox" class="stk-in" data-k="endometriosis" ${checked(preUser.endometriosis, f.endometriosis)}>${FEMALE_CONDITIONS.endometriosis.label}: ${FEMALE_CONDITIONS.endometriosis.note}</label>
        </div>
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-mars')}${esc(people.char.name || '{{char}}')}${ageBadge('char', people.char, view)}</div>
            <label class="stk-field"><span>Фертильность</span>
                <select class="text_pole stk-in" data-k="fertility">
                    ${Object.entries(MALE_FERTILITY).map(([k, v]) => `<option value="${k}" ${fertility === k ? 'selected' : ''}>${v.label}</option>`).join('')}
                </select>
            </label>
            <label class="stk-check"><input type="checkbox" class="stk-in" data-k="smoker" ${checked(preChar.smoker, m.smoker)}>курит</label>
            <label class="stk-check"><input type="checkbox" class="stk-in" data-k="drinker" ${checked(preChar.drinker, m.drinker)}>часто выпивает</label>
            <label class="stk-check"><input type="checkbox" class="stk-in" data-k="overweight" ${checked(preChar.overweight, m.overweight)}>лишний вес</label>
            <label class="stk-check"><input type="checkbox" class="stk-in" data-k="varicocele" ${checked(preChar.varicocele, m.varicocele)}>варикоцеле (снижает фертильность)</label>
            <label class="stk-check"><input type="checkbox" class="stk-in" data-k="vasectomy" ${checked(preChar.vasectomy, m.vasectomyDay !== null)}>вазэктомия</label>
        </div>
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-clock')}История</div>
            <div class="stk-grid">
                <label class="stk-field"><span>Дата в истории сейчас</span><input class="text_pole stk-story" data-k="startDate" type="date" value="${esc(/^d{4}-d{2}-d{2}$/.test(pre?.start?.date ?? '') ? pre.start.date : storyIsoDate(state))}"></label>
                <label class="stk-field"><span>Время в истории сейчас</span><input class="text_pole stk-story" data-k="time" type="time" value="${esc(startTime)}"></label>
                <label class="stk-field"><span>Шансы зачатия</span>
                    <select class="text_pole stk-story" data-k="storyMode">
                        ${Object.entries(STORY_MODES).map(([k, v]) => `<option value="${k}" ${(state.storyMode ?? 'realistic') === k ? 'selected' : ''}>${v.label}</option>`).join('')}
                    </select>
                </label>
            </div>
        </div>
        ${minors.length
            ? `<div class="stk-row is-warn">${icon('fa-ban')}По карточке ${minors.map(key => esc(people[key].name)).join(' и ')} младше 18 лет. Stork не ведёт репродуктивные механики для несовершеннолетних.</div>`
            : `<div class="stk-actions"><button type="button" class="stk-btn is-primary stk-setup-save">${icon('fa-check')}${state.setupDone ? 'Сохранить' : 'Включить Stork в этом чате'}</button></div>`}`;
}

/** Reads the setup form into the state. {{user}} is always the woman, {{char}} always the man. */
function applySetup($root, state, view) {
    const people = cardPeople(view);
    const read = key => {
        const el = $root.find(`[data-k="${key}"]`)[0];
        if (!el) return undefined;
        return el.type === 'checkbox' ? el.checked : el.value;
    };
    const user = state.people.user;
    const char = state.people.char;
    user.sex = 'female';
    char.sex = 'male';
    user.name = people.user.name;
    char.name = people.char.name;
    user.age = people.user.age ?? (Number(view.manualAge?.user) || 25);
    char.age = people.char.age ?? (Number(view.manualAge?.char) || 28);

    const f = user.female;
    const day = state.clock.day;
    f.cycleLength = Math.min(35, Math.max(21, Number(read('cycleLength')) || 28));
    f.periodLength = Math.min(7, Math.max(3, Number(read('periodLength')) || 5));
    const cycleDay = Math.min(f.cycleLength, Math.max(1, Number(read('cycleDay')) || 1));
    f.cycleStart = day - (cycleDay - 1);
    f.cycleShift = 0;
    f.irregularity = Number(read('irregularity')) || 0;
    const contraception = read('contraception') ?? 'none';
    if (f.contraception === 'pill' && contraception !== 'pill') f.pillStoppedDay = day;
    f.contraception = contraception;
    f.pmsSevere = !!read('pmsSevere');
    f.painfulPeriods = !!read('painfulPeriods');
    f.pcos = !!read('pcos');
    f.endometriosis = !!read('endometriosis');
    f.flow = read('flow') ?? 'normal';
    f.perimenopause = perimenopause(user.age);

    const pre = view.analysis?.data;
    if (pre?.user?.children) f.births = Math.max(f.births, Number(pre.user.children) || 0);
    if (pre?.user?.pregnant && !f.pregnancy) {
        const weeks = Math.min(41, Math.max(4, Number(pre.user.pregnancy_weeks) || 8));
        const lmp = day - weeks * 7;
        f.pregnancy = createPregnancy({ lmp, conceptionDay: lmp + 14, twins: false, births: f.births });
        f.pregnancy.knownBy = ['user', 'char'];
    }

    const m = char.male;
    m.fertility = read('fertility') ?? 'normal';
    m.smoker = !!read('smoker');
    m.drinker = !!read('drinker');
    m.overweight = !!read('overweight');
    m.varicocele = !!read('varicocele');
    m.vasectomyDay = read('vasectomy') ? (m.vasectomyDay ?? day - 365) : null;

    const startDate = $root.find('.stk-story[data-k="startDate"]').val();
    if (startDate) state.startDate = new Date(new Date(`${startDate}T12:00:00`).getTime() - day * 86400000).toISOString().slice(0, 10);
    state.clock.minutes = parseClock($root.find('.stk-story[data-k="time"]').val()) ?? state.clock.minutes;
    state.storyMode = $root.find('.stk-story[data-k="storyMode"]').val() ?? 'realistic';
    if (pre?.story?.summary) state.storySummary = pre.story.summary;
    state.setupDone = true;
}

// #endregion

// #region Today

function meter(label, value, tone = '', note = '') {
    return `<div class="stk-meter ${tone}"><span>${label}</span><div><i style="width:${Math.round(clamp01(value) * 100)}%"></i></div>${note ? `<em>${esc(note)}</em>` : ''}</div>`;
}

const clamp01 = value => Math.min(1, Math.max(0, Number(value) || 0));
const levelWord = value => (value > 0.8 ? 'высокое' : value > 0.55 ? 'обычное' : 'сниженное');

/** What comes next in her cycle, in words. */
function nextInCycle(s, suppressed) {
    if (s.late) return `месячные запаздывают на ${s.cycleDay - s.length} дн.`;
    if (suppressed) return `до кровотечения отмены ${s.daysToPeriod} дн.`;
    if (s.relative < -5) return `фертильные дни через ${-5 - s.relative} дн., овуляция через ${-s.relative} дн.`;
    if (s.relative < 0) return `фертильные дни, овуляция через ${-s.relative} дн.`;
    if (s.relative === 0) return 'сегодня овуляция';
    return `до месячных ${s.daysToPeriod} дн.`;
}

function femaleCard(state, person) {
    const f = person.female;
    const day = state.clock.day;
    const head = `<div class="stk-card-title">${icon('fa-venus')}${esc(nameOf(person))}<span class="stk-muted">${years(person.age)}</span></div>`;
    if (f.pregnancy?.labor && knowsPregnancy(person)) {
        const progress = laborProgress(f.pregnancy.labor, absMinute(state.clock));
        return `<div class="stk-card is-alert">${head}<div class="stk-big">Роды: ${esc(progress.label)}</div>
            <div class="stk-muted">схватки каждые ${progress.intervalMinutes} мин${progress.waterBroken ? ', воды отошли' : ''}</div>
            <div class="stk-progress"><i style="width:${Math.round(progress.progress * 100)}%"></i></div></div>`;
    }
    if (f.pregnancy && knowsPregnancy(person)) {
        const info = pregnancyInfo(f.pregnancy, day);
        return `<div class="stk-card">${head}
            <div class="stk-big">${info.week} нед. ${info.weekDay} дн.<span class="stk-muted">${info.trimester}-й триместр · до родов ${Math.max(0, info.daysToDue)} дн.</span></div>
            <div class="stk-progress"><i style="width:${Math.min(100, Math.round(info.week / 40 * 100))}%"></i></div>
            <div class="stk-row">${icon('fa-seedling')}малыш размером с ${esc(info.baby.compare)}${info.kicksFelt ? ', толкается' : ''}</div>
            <div class="stk-row">${icon('fa-person-pregnant')}живот: ${esc(info.belly)}, +${info.weightGain} кг</div>
            ${info.symptoms.length ? `<div class="stk-row">${icon('fa-notes-medical')}${esc(info.symptoms.join(', '))}</div>` : ''}
            ${meter('влечение', info.libido, 'is-pink')}
        </div>`;
    }
    if (f.postpartum) {
        const since = day - f.postpartum.birthDay;
        return `<div class="stk-card">${head}<div class="stk-big">${since} дн. после родов</div>
            <div class="stk-row">${icon('fa-bed')}${since < 42 ? 'восстановление, нужен покой' : 'восстановилась'}</div>
            ${f.postpartum.breastfeeding ? `<div class="stk-row">${icon('fa-baby')}кормит грудью, месячные пока не вернулись</div>` : ''}</div>`;
    }
    const s = femaleState(f, day);
    const pill = pillState(f, day);
    const conditions = Object.entries(FEMALE_CONDITIONS).filter(([key]) => f[key]).map(([, c]) => c.label);
    return `<div class="stk-card">${head}
        <div class="stk-big">День ${s.cycleDay}<span class="stk-muted">из ${s.length} · ${esc(pill.suppressed && ['ovulation', 'follicular'].includes(s.phase) ? 'овуляции нет' : s.phaseLabel)}</span></div>
        <div class="stk-row ${s.late ? 'is-warn' : ''}">${icon(s.late ? 'fa-triangle-exclamation' : 'fa-calendar-day')}${esc(nextInCycle(s, pill.suppressed))}${s.fertile && !pill.suppressed ? ' · <b class="stk-fertile">шанс зачатия сегодня ' + Math.round(s.chanceToday * 100) + '%</b>' : ''}</div>
        <div class="stk-row">${icon('fa-heart-pulse')}${esc(s.symptoms.join(', '))}</div>
        ${meter('влечение', s.libido, 'is-pink', levelWord(s.libido))}
        ${meter('энергия', s.energy, '', levelWord(s.energy))}
        <div class="stk-row stk-muted">${icon('fa-shield-halved')}${esc(FEMALE_CONTRACEPTION[pill.effective]?.label ?? 'нет')}${conditions.length ? ` · ${esc(conditions.join(', '))}` : ''}${f.perimenopause ? ' · перименопауза' : ''}</div>
    </div>`;
}

function maleCard(state, person) {
    const m = person.male;
    const s = maleSnapshot(state, person);
    const recovering = m.lastOrgasmMinute !== null && absMinute(state.clock) - m.lastOrgasmMinute < s.refractoryMinutes;
    const traits = [m.smoker ? 'курит' : '', m.drinker ? 'выпивает' : '', m.overweight ? 'лишний вес' : '', m.varicocele ? 'варикоцеле' : ''].filter(Boolean);
    const fresh = [...new Set(s.recent.filter(e => e.daysAgo <= 1).map(e => `${e.daysAgo ? 'вчера' : 'сегодня'}: ${e.label}`))];
    const reasons = s.reasons.map(r => `${r.label} ${r.daysAgo ? `${r.daysAgo} дн. назад` : 'сегодня'}, пройдёт через ~${Math.ceil(r.recoversInDays / 7)} нед.`);
    return `<div class="stk-card">
        <div class="stk-card-title">${icon('fa-mars')}${esc(nameOf(person))}<span class="stk-muted">${years(person.age)}</span></div>
        <div class="stk-big">${s.testosterone > 0.85 ? 'Бодр' : s.testosterone > 0.65 ? 'В форме' : 'Устал'}<span class="stk-muted">${s.daysSinceLast === null ? 'близости ещё не было' : `последняя близость ${s.daysSinceLast ? `${s.daysSinceLast} дн. назад` : 'сегодня'}`}</span></div>
        <div class="stk-sub">Сперма</div>
        ${meter('количество', s.spermCount / 100, 'is-pink', `${s.spermCount}% нормы`)}
        ${meter('подвижность', s.motility / 100, 'is-pink', `${s.motility}% нормы`)}
        ${meter('запас', s.reserve, '', s.reserve >= 1 ? 'полный' : 'восстанавливается')}
        ${reasons.length ? `<div class="stk-row stk-muted">${icon('fa-clock-rotate-left')}${esc(reasons.join('; '))}</div>` : ''}
        ${fresh.length ? `<div class="stk-row">${icon('fa-wine-glass')}${esc(fresh.join(', '))}</div>` : ''}
        ${s.vasectomy ? `<div class="stk-row">${icon('fa-scissors')}вазэктомия: ${esc(s.vasectomy)}</div>` : ''}
        <div class="stk-sub">Сейчас</div>
        ${meter('тестостерон', s.testosterone, '', s.expectingFather ? 'снижен: будущий отец' : levelWord(s.testosterone))}
        ${meter('влечение', s.libido, 'is-pink', levelWord(s.libido))}
        ${meter('эрекция', s.erection, '', s.erection < 0.75 ? 'может подвести' : 'в порядке')}
        ${recovering ? `<div class="stk-row">${icon('fa-hourglass-half')}восстанавливается после оргазма ещё ~${s.refractoryMinutes - (absMinute(state.clock) - m.lastOrgasmMinute)} мин</div>` : `<div class="stk-row stk-muted">${icon('fa-hourglass-half')}восстановление после оргазма ~${s.refractoryMinutes} мин</div>`}
        ${s.couvade ? `<div class="stk-row">${icon('fa-face-tired')}сопереживает беременности: хуже спит, подташнивает</div>` : ''}
        <div class="stk-row stk-muted">${icon('fa-dna')}фертильность: ${esc(MALE_FERTILITY[m.fertility]?.label ?? 'норма')}${traits.length ? ` · ${esc(traits.join(', '))}` : ''}</div>
    </div>`;
}

function renderToday(state) {
    return `
        <div class="stk-clock"><b>${esc(capitalize(dateLabel(state)))}</b><span class="stk-muted">${esc(timeLabel(state.clock.minutes))}</span></div>
        ${femaleCard(state, state.people.user)}
        ${maleCard(state, state.people.char)}
        <div class="stk-hint">${icon('fa-circle-info')}Stork сам следит за РП: время, близость, привычки, тесты. Поправить вручную можно в «Настройках».</div>`;
}

// #endregion

// #region Calendar

function cycleStrip(f, day) {
    const info = cycleInfo(f, day);
    const cells = [];
    for (let d = 1; d <= info.length; d++) {
        const at = cycleInfo(f, f.cycleStart + d - 1);
        const classes = [`is-${PHASE_TONE[at.phase]}`];
        if (at.fertile) classes.push('is-window');
        if (at.relative === 0) classes.push('is-ovulation');
        if (d === info.cycleDay) classes.push('is-today');
        cells.push(`<span class="${classes.join(' ')}" title="день ${d}: ${at.phaseLabel}${at.fertile ? ', фертильно' : ''}"></span>`);
    }
    return `<div class="stk-cycle">${cells.join('')}</div>`;
}

/** The next dates that matter: ovulation and period, or doctor visits and birth. */
function upcoming(state, woman) {
    const f = woman.female;
    const day = state.clock.day;
    const when = d => `${dateLabel(state, d, { day: 'numeric', month: 'long' })}${d === day ? ' (сегодня)' : ` (через ${d - day} дн.)`}`;
    const rows = [];
    if (f.pregnancy && knowsPregnancy(woman)) {
        const p = f.pregnancy;
        for (const visit of DOCTOR_VISITS) {
            const visitDay = p.lmp + visit.week * 7;
            if (visitDay >= day && !p.visitsDone.includes(visit.week)) rows.push([visitDay, 'fa-user-doctor', visit.label]);
        }
        rows.push([p.lmp + 280, 'fa-baby', 'предполагаемая дата родов']);
    } else if (!f.postpartum && !f.pregnancy) {
        const s = cycleInfo(f, day);
        const start = f.cycleStart;
        if (!pillState(f, day).suppressed && s.relative < 0) {
            rows.push([start + s.ovulation - 6, 'fa-heart', 'начало фертильных дней']);
            rows.push([start + s.ovulation - 1, 'fa-egg', 'овуляция']);
        }
        rows.push([start + s.length, 'fa-droplet', pillState(f, day).suppressed ? 'кровотечение отмены' : 'следующие месячные']);
    }
    return rows.filter(([d]) => d >= day).sort((a, b) => a[0] - b[0]).slice(0, 4)
        .map(([d, ic, text]) => `<div class="stk-row">${icon(ic)}<b>${esc(when(d))}</b><span class="stk-muted">${esc(text)}</span></div>`).join('');
}

function renderCalendar(state, view) {
    const woman = state.people.user;
    const f = woman.female;
    const today = storyDate(state) ?? new Date();
    const month = new Date(today.getFullYear(), today.getMonth() + view.monthOffset, 1);
    const dayOf = date => state.clock.day + Math.round((date - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
    const actDays = new Set(state.acts.map(a => a.day));
    const testDays = new Set(state.rolls.filter(r => r.kind === 'test').map(r => r.day));
    const firstWeekday = (month.getDay() + 6) % 7;
    const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const cells = Array.from({ length: firstWeekday }, () => '<span class="is-empty"></span>');

    for (let d = 1; d <= daysInMonth; d++) {
        const storyDay = dayOf(new Date(month.getFullYear(), month.getMonth(), d));
        const classes = [];
        const pregnantThen = f.pregnancy && knowsPregnancy(woman) && storyDay >= f.pregnancy.conceptionDay;
        if (pregnantThen) classes.push('is-preg');
        else if (!f.postpartum && !(f.pregnancy && storyDay >= f.pregnancy.conceptionDay)) {
            const length = f.cycleLength;
            const k = Math.floor((storyDay - f.cycleStart) / length);
            const at = cycleInfo({ ...f, cycleStart: f.cycleStart + k * length, cycleShift: k === 0 ? f.cycleShift : 0 }, storyDay);
            classes.push(`is-${PHASE_TONE[at.phase]}`);
            if (at.fertile && !pillState(f, storyDay).suppressed) classes.push('is-window');
            if (at.relative === 0 && !pillState(f, storyDay).suppressed) classes.push('is-ovulation');
        }
        if (storyDay === state.clock.day) classes.push('is-today');
        if (storyDay > state.clock.day) classes.push('is-future');
        const marks = `${actDays.has(storyDay) ? icon('fa-heart', 'stk-mark') : ''}${testDays.has(storyDay) ? icon('fa-vial', 'stk-mark') : ''}`;
        cells.push(`<span class="${classes.join(' ')}"><em>${d}</em>${marks}</span>`);
    }

    const showStrip = !f.pregnancy && !f.postpartum;
    return `
        ${showStrip ? `<div class="stk-card">
            <div class="stk-card-title">${icon('fa-arrows-spin')}Цикл ${esc(nameOf(woman))}<span class="stk-muted">день ${cycleInfo(f, state.clock.day).cycleDay}</span></div>
            ${cycleStrip(f, state.clock.day)}
        </div>` : ''}
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-calendar-check')}Ближайшие даты</div>
            ${upcoming(state, woman) || '<div class="stk-muted">пока ничего</div>'}
        </div>
        <div class="stk-cal-head">
            <button type="button" class="stk-btn is-ghost stk-month" data-d="-1">${icon('fa-chevron-left')}</button>
            <b>${esc(capitalize(month.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })))}</b>
            <button type="button" class="stk-btn is-ghost stk-month" data-d="1">${icon('fa-chevron-right')}</button>
        </div>
        <div class="stk-cal">
            ${['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map(w => `<span class="is-head">${w}</span>`).join('')}
            ${cells.join('')}
        </div>
        <div class="stk-legend">
            <span><i class="is-period"></i>месячные</span>
            <span><i class="is-window"></i>фертильные дни</span>
            <span><i class="is-ovulation"></i>овуляция</span>
            <span><i class="is-preg"></i>беременность</span>
            <span>${icon('fa-heart')}близость</span>
            <span>${icon('fa-vial')}тест</span>
        </div>
        <div class="stk-hint">${icon('fa-circle-info')}Будущие дни и прошлые циклы показаны как прогноз.</div>`;
}

// #endregion

// #region Pregnancy

function renderPregnancy(state) {
    const woman = [state.people.user, state.people.char].find(p => p.sex === 'female' && p.female.pregnancy && knowsPregnancy(p));
    if (!woman) {
        return `<div class="stk-empty">${icon('fa-baby', 'stk-ic-xl')}<div>Беременности пока нет. Или о ней ещё никто не знает: сделай тест.</div></div>`;
    }
    const p = woman.female.pregnancy;
    const info = pregnancyInfo(p, state.clock.day);
    const due = dateLabel(state, info.dueDay, { day: 'numeric', month: 'long', year: 'numeric' });
    return `
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-person-pregnant')}${esc(nameOf(woman))}</div>
            <div class="stk-big">${info.week} нед. ${info.weekDay} дн.<span class="stk-muted">${info.trimester}-й триместр · до родов ${Math.max(0, info.daysToDue)} дн. (${esc(due)})</span></div>
            <div class="stk-progress"><i style="width:${Math.min(100, Math.round(info.week / 40 * 100))}%"></i></div>
        </div>
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-seedling')}${p.babies > 1 ? 'Малыши' : 'Малыш'}</div>
            <div class="stk-stats">
                <div><b>${info.baby.length} см</b><span>рост</span></div>
                <div><b>${info.baby.weight >= 1000 ? `${(info.baby.weight / 1000).toFixed(1)} кг` : info.baby.weight < 1 ? 'меньше 1 г' : `${info.baby.weight} г`}</b><span>вес</span></div>
                <div><b>${esc(info.baby.compare)}</b><span>размером с</span></div>
            </div>
            <div class="stk-row">${icon('fa-wand-sparkles')}${esc(info.baby.develops)}</div>
            <div class="stk-row">${icon('fa-venus-mars')}${p.sexKnown ? esc(p.sexes.join(' и ')) : 'пол пока неизвестен, узнать на УЗИ с 18 недель'}</div>
            ${info.kicksFelt ? `<div class="stk-row">${icon('fa-shoe-prints')}толкается</div>` : ''}
        </div>
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-heart-pulse')}Мама</div>
            <div class="stk-row">живот: ${esc(info.belly)}, +${info.weightGain} кг</div>
            ${info.symptoms.length ? `<div class="stk-row">${esc(info.symptoms.join(', '))}</div>` : ''}
            <div class="stk-row">тянет на ${esc(p.cravings.join(' и '))}, не выносит ${esc(p.aversions.join(', '))}</div>
        </div>
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-user-doctor')}Врач</div>
            ${DOCTOR_VISITS.map(v => `<div class="stk-row ${p.visitsDone.includes(v.week) ? '' : 'stk-muted'}">${icon(p.visitsDone.includes(v.week) ? 'fa-circle-check' : 'fa-circle')}${v.week} нед.: ${esc(v.label)}</div>`).join('')}
        </div>`;
}

// #endregion

// #region Journal and settings

function renderJournal(state) {
    const entries = [...state.log].reverse().filter(e => settings().showRolls || e.kind !== 'roll');
    const rows = entries.map(e => `<div class="stk-log ${e.kind === 'roll' ? 'is-roll' : ''}"><span>${esc(dateLabel(state, e.day, { day: 'numeric', month: 'short' }))}</span><div>${esc(e.text)}</div></div>`).join('');
    return `
        <label class="stk-check"><input type="checkbox" class="stk-set" data-k="showRolls" ${settings().showRolls ? 'checked' : ''}>показывать броски кубиков (спойлер)</label>
        <div class="stk-card">${rows || '<div class="stk-muted">Пока ничего не произошло.</div>'}</div>`;
}

/** How Stork reads the role-play: a separate request per reply, or a hidden tag from the story model. */
function readingCard() {
    const s = settings();
    const profiles = getProfiles();
    return `
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-book-open-reader')}Чтение РП</div>
            <label class="stk-field"><span>Как Stork понимает, что произошло</span>
                <select class="text_pole stk-set" data-k="readMode">
                    <option value="analyzer" ${s.readMode === 'analyzer' ? 'selected' : ''}>отдельный анализ каждого ответа (надёжно)</option>
                    <option value="tag" ${s.readMode === 'tag' ? 'selected' : ''}>скрытая метка от РП-модели (бесплатно)</option>
                </select>
            </label>
            ${s.readMode === 'analyzer' ? `
                <label class="stk-field"><span>Через что читать</span>
                    <select class="text_pole stk-set" data-k="readProfile">
                        <option value="" ${s.readProfile ? '' : 'selected'}>Текущее подключение</option>
                        ${profiles.map(p => `<option value="${esc(p.id)}" ${p.id === s.readProfile ? 'selected' : ''}>Профиль «${esc(p.name)}» · ${esc(p.model ?? '?')}</option>`).join('')}
                    </select>
                </label>
                <div class="stk-hint">${icon('fa-coins')}Один короткий запрос после каждого ответа, около 1-2 тысяч токенов. Дешевле всего выбрать недорогую модель отдельным профилем.</div>`
                : `<div class="stk-hint">${icon('fa-circle-info')}РП-модель в конце ответа ставит скрытую строчку. Бесплатно, но модель иногда забывает: тогда Stork предложит отметить сам.</div>`}
        </div>`;
}

/** Manual fixes, folded away: Stork reads the story itself, this is only for corrections. */
function manualCard(view) {
    const lifestyle = [['alcohol', 'алкоголь'], ['smoking', 'курение'], ['sauna', 'сауна'], ['illness', 'болезнь'], ['stress', 'стресс'], ['no_sleep', 'недосып']];
    return `
        <details class="stk-card stk-fold" ${view?.manualOpen ? 'open' : ''}>
            <summary>${icon('fa-screwdriver-wrench')}Поправить вручную</summary>
            <div class="stk-sub">Время</div>
            <div class="stk-actions">
                <button type="button" class="stk-btn is-ghost stk-time" data-min="60">+1 ч</button>
                <button type="button" class="stk-btn is-ghost stk-time" data-min="${MINUTES_PER_DAY}">+1 день</button>
                <button type="button" class="stk-btn is-ghost stk-time" data-min="${MINUTES_PER_DAY * 7}">+1 неделя</button>
            </div>
            <div class="stk-sub">Близость</div>
            <div class="stk-actions">
                ${[['none', 'без защиты'], ['condom', 'презерватив'], ['withdrawal', 'прерванный']].map(([k, l]) => `<button type="button" class="stk-btn is-ghost stk-intimacy" data-p="${k}">${l}</button>`).join('')}
            </div>
            <div class="stk-sub">Она</div>
            <div class="stk-actions">
                <button type="button" class="stk-btn is-ghost stk-do" data-ev="test" data-who="user">тест</button>
                <button type="button" class="stk-btn is-ghost stk-do" data-ev="ultrasound" data-who="user">УЗИ</button>
                <button type="button" class="stk-btn is-ghost stk-do" data-ev="pill_missed" data-who="user">пропуск таблетки</button>
                <button type="button" class="stk-btn is-ghost stk-do" data-ev="emergency_pill" data-who="user">экстренная таблетка</button>
                <button type="button" class="stk-btn is-ghost stk-do" data-ev="stress" data-who="user">стресс</button>
                <button type="button" class="stk-btn is-ghost stk-do" data-ev="illness" data-who="user">болезнь</button>
            </div>
            <div class="stk-sub">Он</div>
            <div class="stk-actions">
                ${lifestyle.map(([k, l]) => `<button type="button" class="stk-btn is-ghost stk-do" data-ev="${k}" data-who="char">${l}</button>`).join('')}
            </div>
        </details>`;
}

function renderSettings(state, view) {
    const s = settings();
    const toggle = (key, title, note) => `<label class="stk-setting"><div><b>${title}</b><span class="stk-muted">${note}</span></div><input type="checkbox" class="stk-set" data-k="${key}" ${s[key] ? 'checked' : ''}></label>`;
    return `
        ${readingCard()}
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-comments')}Для модели</div>
            ${toggle('detailed', 'Подробный статус', 'самочувствие, влечение, малыш; выключи, чтобы экономить токены')}
            ${toggle('neutral', 'Нейтральные слова', 'мягче формулировки, если провайдер строгий')}
            <label class="stk-field"><span>Куда ставить статус</span>
                <select class="text_pole stk-set" data-k="placement">
                    <option value="inject" ${s.placement === 'inject' ? 'selected' : ''}>сам, перед последними сообщениями (лучше всего)</option>
                    <option value="macro" ${s.placement === 'macro' ? 'selected' : ''}>только через {{stork}} в пресете</option>
                </select>
            </label>
        </div>
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-eye')}Показывать</div>
            ${toggle('statusBar', 'Строка над полем ввода', 'дата и коротко о каждом')}
            ${toggle('toasts', 'Уведомления о событиях', 'начались месячные, задержка, схватки')}
        </div>
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-comment-dots')}Этот чат</div>
            <div class="stk-actions">
                <button type="button" class="stk-btn stk-edit-setup">${icon('fa-pen')}Изменить персонажей</button>
                <button type="button" class="stk-btn is-ghost stk-disable-chat">${icon('fa-power-off')}Выключить Stork в этом чате</button>
            </div>
        </div>
        ${manualCard(view)}`;
}

// #endregion

/**
 * Opens the Stork window.
 * @param {object} [options]
 * @param {string} [options.tab]
 */
export async function openStork({ tab } = {}) {
    const view = { randomDay: 1 + Math.floor(Math.random() * 28), tab: tab ?? 'today', monthOffset: 0, intimacyMenu: false, editing: false, analysis: null, manualAge: {} };
    const $root = $(`
        <div class="stk">
            <div class="stk-head"><div class="stk-brand">${icon('fa-dove')}<span>Stork</span></div></div>
            <nav class="stk-tabs">${TABS.map(t => `<button type="button" class="stk-tab" data-tab="${t.id}">${icon(t.icon)}<span>${t.label}</span></button>`).join('')}</nav>
            <div class="stk-panel"></div>
        </div>`);

    const render = () => {
        const state = currentState();
        const setup = !state.setupDone || view.editing;
        $root.find('.stk-tabs').toggle(!setup);
        $root.find('.stk-tab').each((_, el) => $(el).toggleClass('is-on', el.dataset.tab === view.tab));
        const html = setup ? renderSetup(state, view) : {
            today: renderToday,
            calendar: renderCalendar,
            pregnancy: renderPregnancy,
            journal: renderJournal,
            settings: renderSettings,
        }[view.tab](state, view);
        $root.find('.stk-panel').html(html);
    };

/** Reads the cards and the story opening as soon as setup is shown: no button to press. */
    const runAnalysis = async () => {
        view.analysis = { loading: true };
        render();
        try {
            view.analysis = { data: await analyzeCards(settings().readProfile ?? '') };
        } catch (error) {
            view.analysis = { error: String(error?.message ?? error) };
        }
        // If she already changed something in the form, keep it: refresh only the analysis card
        if (view.touched && !view.analysis.data) $root.find('.stk-analysis-card').replaceWith(renderAnalysis(view));
        else render();
    };

    const act = mutate => {
        const { events } = updateCurrentState(mutate);
        announce(events);
        render();
    };

    $root.on('click', '.stk-tab, .stk-tab-go', function () {
        view.tab = this.dataset.tab;
        view.intimacyMenu = false;
        render();
    });
    // Setup
    $root.on('input change', '.stk-in, .stk-story', () => { view.touched = true; });
    $root.on('input', '.stk-age', function () {
        view.manualAge[this.dataset.person] = this.value;
    });
    $root.on('change', '.stk-age', () => render());
    $root.on('click', '.stk-analyze', () => runAnalysis());
    $root.on('click', '.stk-random-day', function () {
        const $card = $(this).closest('.stk-card');
        const length = Number($card.find('[data-k="cycleLength"]').val()) || 28;
        $card.find('[data-k="cycleDay"]').val(1 + Math.floor(Math.random() * length));
    });
    $root.on('click', '.stk-setup-save', () => {
        updateCurrentState(state => applySetup($root, state, view));
        view.editing = false;
        view.tab = 'today';
        render();
        toastr.success('Stork включён в этом чате', 'Stork', { timeOut: 2500 });
    });
    // Today
    $root.on('click', '.stk-time', function () {
        const minutes = Number(this.dataset.min);
        act(state => advanceTime(state, minutes));
    });
    $root.on('click', '.stk-intimacy-open', () => {
        view.intimacyMenu = !view.intimacyMenu;
        render();
    });
    $root.on('click', '.stk-intimacy', function () {
        view.intimacyMenu = false;
        act(state => applyEvent(state, { type: 'intimacy', protection: this.dataset.p }));
        toastr.info('Близость отмечена', 'Stork', { timeOut: 2000 });
    });
    $root.on('click', '.stk-do', function () {
        act(state => applyEvent(state, { type: this.dataset.ev, who: this.dataset.who }));
    });
    // Calendar
    $root.on('click', '.stk-month', function () {
        view.monthOffset += Number(this.dataset.d);
        render();
    });
    // Settings
    $root.on('change', '.stk-set', function () {
        settings()[this.dataset.k] = this.type === 'checkbox' ? this.checked : this.value;
        saveSettingsDebounced();
        // Before setup nothing is written into the chat: just redraw
        if (currentState().setupDone) updateCurrentState(() => { });
        else refreshStatus();
        if (view.touched) return;
        render();
    });
    $root.on('click', '.stk-edit-setup', () => {
        view.editing = true;
        view.touched = false;
        runAnalysis();
    });
    $root.on('click', '.stk-disable-chat', () => {
        updateCurrentState(state => { state.setupDone = false; });
        render();
        toastr.info('Stork выключен в этом чате. Данные сохранены, включить можно снова.', 'Stork');
    });

    // <details> toggle does not bubble: listen in the capture phase to remember the fold
    $root[0].addEventListener('toggle', event => {
        if (event.target.classList?.contains('stk-fold')) view.manualOpen = event.target.open;
    }, true);

    const unsubscribe = onStateChange(() => render());
    render();
    if (!currentState().setupDone) runAnalysis();
    await callGenericPopup($root, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: 'Закрыть' });
    unsubscribe?.();
}
