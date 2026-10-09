import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import {
    createPregnancy, cycleInfo, DOCTOR_VISITS, FEMALE_CONDITIONS, FEMALE_CONTRACEPTION, femaleState, laborProgress, maleState,
    MALE_FERTILITY, PERIOD_FLOW, perimenopause, pillState, pregnancyInfo, STORY_MODES,
} from './biology.js';
import { analyzeCards, getProfiles, guessAge, readCards } from './cards.js';
import { getContext } from '../../../extensions.js';
import { absMinute, advanceTime, applyEvent, dateLabel, liveNow, maleSnapshot, MINUTES_PER_DAY, parseClock, recoveryLeft, storyDate, timeLabel, withLive } from './engine.js';
import { activeIn, changed, currentState, onStateChange, readStatus, refreshStatus, retryRead, settings, updateCurrentState } from './store.js';
import { applyPersonEdit, setPeriodStart } from './setup.js';

// Persona avatar lives in personas.js; loaded lazily so a missing module never breaks Stork
let personas = null;
import('../../../personas.js').then(m => { personas = m; }).catch(() => { });

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
    return [`${dateLabel(state, state.clock.day, { day: 'numeric', month: 'long' })}, ${timeLabel(state.clock.minutes)}`, ...peopleParts(state)].join('<span class="stk-dot-sep">·</span>');
}

/** Each of them in a few words, as HTML parts. */
function peopleParts(state) {
    const parts = [];
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
            const s = maleSnapshot(state, person);
            const vigor = withLive(s.testosterone, liveNow(state, person.key).energy);
            const left = recoveryLeft(state, person);
            text = left > 0 ? `восстанавливается ~${left} мин` : vigor > 0.85 ? 'бодр' : vigor > 0.65 ? 'в форме' : 'устал';
        }
        parts.push(`<b class="stk-nw">${esc(nameOf(person))}:</b> ${esc(text)}`);
    }
    return parts;
}

/** Folded infoblock in the chat: both faces with a ring, date and time, each in a word. */
export function blockHeadHtml(state, open, reading) {
    const f = state.people.user.female;
    const day = state.clock.day;
    const userRing = f.pregnancy && knowsPregnancy(state.people.user)
        ? { value: pregnancyInfo(f.pregnancy, day).week / 40, tone: 'preg' }
        : f.postpartum ? { value: 1, tone: 'preg' } : (() => {
            const info = cycleInfo(f, day);
            return { value: info.cycleDay / info.length, tone: info.phase === 'menstruation' ? 'period' : info.phase === 'pms' ? 'warm' : info.fertile ? 'pink' : 'preg' };
        })();
    const ms = maleSnapshot(state, state.people.char);
    const charRing = { value: withLive(ms.testosterone, liveNow(state, 'char').energy), tone: 'accent' };
    const hh = String(Math.floor(state.clock.minutes / 60)).padStart(2, '0'), mm = String(state.clock.minutes % 60).padStart(2, '0');
    const failed = readStatus().failed;
    const mark = reading ? `<span class="stk-ib-mark is-reading" title="Читаю последний ответ">${icon('fa-feather-pointed')}</span>`
        : failed ? `<button type="button" class="stk-ib-mark is-failed" data-stk-act="retry" title="Анализ не прошёл: ${esc(failed.error)}. Повторить">${icon('fa-rotate-right')}</button>` : '';
    return `<div class="stk-ib-head" data-stk-act="block-toggle" role="button" tabindex="0" aria-expanded="${open}">
        <span class="stk-ib-faces">${ringsHtml([userRing], 'user', nameOf(state.people.user), 'xs')}${ringsHtml([charRing], 'char', nameOf(state.people.char), 'xs')}</span>
        <span class="stk-ib-text">
            <b>${icon('fa-dove')}${esc(capitalize(dateLabel(state, day, { day: 'numeric', month: 'long', weekday: 'short' })))}, ${hh}:${mm}</b>
            <span>${peopleParts(state).join('<span class="stk-dot-sep">·</span>')}</span>
        </span>
        ${mark}
        <i class="fa-solid fa-chevron-down stk-ib-chev"></i>
    </div>`;
}

/**
 * The line takes the width, side margins and rounding of the chat's input form, whatever the theme:
 * it looks like part of the chat, and follows when the window or a side panel changes size.
 */
let formObserver = null;
function syncBar(bar, form) {
    if (!bar || !form) return;
    const cs = getComputedStyle(form);
    bar.style.boxSizing = 'border-box';
    bar.style.width = `${form.getBoundingClientRect().width}px`;
    bar.style.maxWidth = '100%';
    bar.style.marginLeft = cs.marginLeft;
    bar.style.marginRight = cs.marginRight;
    bar.style.borderRadius = cs.borderRadius && cs.borderRadius !== '0px' ? cs.borderRadius : '';
}
function watchForm(bar, form) {
    if (!form) return;
    syncBar(bar, form);
    formObserver?.disconnect();
    if (typeof ResizeObserver === 'function') {
        formObserver = new ResizeObserver(() => syncBar(document.getElementById('stork_bar'), form));
        formObserver.observe(form);
    } else {
        window.addEventListener('resize', () => syncBar(document.getElementById('stork_bar'), form));
    }
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
        bar.addEventListener('click', event => {
            if (event.target.closest('.stk-retry')) {
                event.stopPropagation();
                retryRead();
                return;
            }
            openStork();
        });
        const form = document.getElementById('send_form');
        form?.parentElement?.insertBefore(bar, form);
        watchForm(bar, form);
    }
    const rs = readStatus();
    bar.classList.toggle('is-reading', rs.index !== null);
    bar.classList.toggle('is-failed', !!rs.failed);
    const retry = rs.failed ? `<button type="button" class="stk-retry" title="Анализ не прошёл: ${esc(rs.failed.error)}. Нажми, чтобы повторить">${icon('fa-rotate-right')}</button>` : '';
    bar.innerHTML = `${icon(rs.index !== null ? 'fa-feather-pointed' : 'fa-moon')}<span class="stk-bar-text">${statusLineText(state)}</span>${retry}`;
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
    state.chatOff = false;
}

// #endregion

/** On/off switch for the whole extension: in the window header and the infoblock. */
export function switchHtml() {
    const on = settings().enabled;
    return `<button type="button" class="stk-switch${on ? ' is-on' : ''}" data-stk-act="toggle-ext" role="switch" aria-checked="${on}" title="${on ? 'Stork включён — нажми, чтобы выключить везде' : 'Stork выключен — нажми, чтобы включить'}"><i></i><span>${on ? 'вкл' : 'выкл'}</span></button>`;
}

// #region Not on in this chat

function renderWaiting(state) {
    if (!settings().enabled) {
        return `<div class="stk-empty">${icon('fa-power-off', 'stk-ic-xl')}<div>Stork выключен везде. Включить — переключателем вверху справа.</div></div>`;
    }
    if (state.minorBlocked) {
        return `<div class="stk-empty">${icon('fa-ban', 'stk-ic-xl')}<div>По карточке персонаж младше 18 лет. Stork не ведёт репродуктивные механики для несовершеннолетних.</div></div>`;
    }
    if (state.chatOff) {
        return `<div class="stk-empty">${icon('fa-moon', 'stk-ic-xl')}<div>Stork выключен в этом чате. Всё, что он успел записать, сохранено.</div>
            <button type="button" class="stk-btn is-primary stk-enable-chat">${icon('fa-power-off')}Включить снова</button></div>`;
    }
    return `<div class="stk-empty">${icon('fa-dove', 'stk-ic-xl')}<div>Stork включится сам, когда бот ответит на твоё первое сообщение в этом чате: прочитает карточку, персону и начало истории и запомнит всё для этого чата.</div>
        <div class="stk-actions" style="justify-content:center">
            <button type="button" class="stk-btn stk-setup-now">${icon('fa-sliders')}Настроить сейчас вручную</button>
            <button type="button" class="stk-btn is-ghost stk-disable-chat">${icon('fa-power-off')}Не включать в этом чате</button>
        </div></div>`;
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

// #region Rings around the avatars

/** Avatar of {{char}} (card) or {{user}} (persona), or null. */
function avatarUrl(key) {
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
const initials = name => String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase() || '?';

/**
 * Concentric rings with the avatar in the middle. rings: [{ value 0-1, tone }], outer first.
 * One SVG, stroke-dasharray only: cheap to draw and to animate.
 */
function ringsHtml(rings, key, name, size = 'lg') {
    const stroke = size === 'lg' ? 7 : size === 'xs' ? 9 : 6;
    const gap = 3;
    const outer = 60 - stroke / 2 - 1;
    const circles = rings.map((r, n) => {
        const radius = outer - n * (stroke + gap);
        const v = Math.round(clamp01(r.value) * 100);
        return `<circle class="stk-ring-bg" cx="60" cy="60" r="${radius}" stroke-width="${stroke}"/>
            <circle class="stk-ring-v is-${r.tone}" cx="60" cy="60" r="${radius}" stroke-width="${stroke}" pathLength="100" stroke-dasharray="${v} 100" transform="rotate(-90 60 60)"/>`;
    }).join('');
    const inner = outer - (rings.length - 1) * (stroke + gap) - stroke / 2 - 3;
    const inset = ((60 - inner) / 120 * 100).toFixed(1);
    const url = key ? avatarUrl(key) : null;
    const face = url ? `<img src="${esc(url)}" alt="" loading="lazy">` : `<b>${esc(initials(name))}</b>`;
    return `<div class="stk-rings is-${size}"><svg viewBox="0 0 120 120" aria-hidden="true">${circles}</svg><span class="stk-face" style="inset:${inset}%">${face}</span></div>`;
}

/** One line of the legend next to the rings: colour, name, value, and why. */
function legendRow(tone, label, value, why) {
    return `<div class="stk-leg"><i class="is-${tone}"></i><div><span><b>${esc(label)}</b> ${esc(value)}</span>${why ? `<small>${esc(why)}</small>` : ''}</div></div>`;
}
/** Small ring with a value inside, for the three sperm numbers. */
function miniRing(tone, value, text) {
    const v = Math.round(clamp01(value) * 100);
    return `<div class="stk-mini-ring"><svg viewBox="0 0 40 40" aria-hidden="true"><circle class="stk-ring-bg" cx="20" cy="20" r="16" stroke-width="4"/><circle class="stk-ring-v is-${tone}" cx="20" cy="20" r="16" stroke-width="4" pathLength="100" stroke-dasharray="${v} 100" transform="rotate(-90 20 20)"/></svg><b>${esc(text)}</b></div>`;
}

/** What the story did to this level: words for the offset from the analysis. */
function storyWhy(offset) {
    if (offset >= 1.5) return 'по сюжету заметно выше обычного';
    if (offset >= 0.5) return 'по сюжету чуть выше';
    if (offset <= -1.5) return 'по сюжету заметно ниже обычного';
    if (offset <= -0.5) return 'по сюжету чуть ниже';
    return '';
}
const joinWhy = (...parts) => parts.filter(Boolean).join('; ');

/** How the story shows this person now: note and mood from the analysis of the latest replies. */
function storyNote(state, key) {
    const live = liveNow(state, key);
    if (!live.note && !live.mood) return '';
    return `<div class="stk-story-note">${icon('fa-feather-pointed')}<div>${live.mood ? `<b>${esc(capitalize(live.mood))}.</b> ` : ''}${esc(live.note ?? '')}</div></div>`;
}

// #endregion

/** Pencil in the card title: quick edit of this person. */
const pencil = key => `<button type="button" class="stk-pen" data-stk-act="edit-person" data-key="${key}" title="Изменить" aria-label="Изменить">${icon('fa-pen')}</button>`;

export function femaleCard(state, person, view = {}) {
    if (view.editPerson === person.key) return personEditor(state, person.key);
    const f = person.female;
    const day = state.clock.day;
    const live = liveNow(state, person.key);
    const head = `<div class="stk-card-title">${icon('fa-venus')}${esc(nameOf(person))}<span class="stk-muted">${years(person.age)}</span>${pencil(person.key)}</div>`;
    if (f.pregnancy?.labor && knowsPregnancy(person)) {
        const progress = laborProgress(f.pregnancy.labor, absMinute(state.clock));
        return `<div class="stk-card is-alert">${head}
            <div class="stk-person">${ringsHtml([{ value: progress.progress, tone: 'preg' }], person.key, nameOf(person))}
                <div class="stk-legend-col">${legendRow('preg', 'Роды', progress.label, `схватки каждые ${progress.intervalMinutes} мин${progress.waterBroken ? ', воды отошли' : ''}`)}</div></div>
            ${storyNote(state, person.key)}</div>`;
    }
    if (f.pregnancy && knowsPregnancy(person)) {
        const info = pregnancyInfo(f.pregnancy, day);
        const libido = withLive(info.libido, live.libido);
        return `<div class="stk-card">${head}
            <div class="stk-person">${ringsHtml([{ value: info.week / 40, tone: 'preg' }, { value: libido, tone: 'pink' }], person.key, nameOf(person))}
                <div class="stk-legend-col">
                    ${legendRow('preg', 'Срок', `${info.week} нед. ${info.weekDay} дн.`, `${info.trimester}-й триместр · до родов ${Math.max(0, info.daysToDue)} дн.`)}
                    ${legendRow('pink', 'Влечение', levelWord(libido), joinWhy(info.trimester === 2 ? 'второй триместр — обычно выше' : 'в этом триместре обычно ниже', storyWhy(live.libido)))}
                </div></div>
            <div class="stk-row">${icon('fa-seedling')}малыш размером с ${esc(info.baby.compare)}${info.kicksFelt ? ', толкается' : ''}</div>
            <div class="stk-row">${icon('fa-person-pregnant')}живот: ${esc(info.belly)}, +${info.weightGain} кг</div>
            ${info.symptoms.length ? `<div class="stk-row">${icon('fa-notes-medical')}${esc(info.symptoms.join(', '))}</div>` : ''}
            ${storyNote(state, person.key)}
        </div>`;
    }
    if (f.postpartum) {
        const since = day - f.postpartum.birthDay;
        return `<div class="stk-card">${head}<div class="stk-big">${since} дн. после родов</div>
            <div class="stk-row">${icon('fa-bed')}${since < 42 ? 'восстановление, нужен покой' : 'восстановилась'}</div>
            ${f.postpartum.breastfeeding ? `<div class="stk-row">${icon('fa-baby')}кормит грудью, месячные пока не вернулись</div>` : ''}
            ${storyNote(state, person.key)}</div>`;
    }
    const s = femaleState(f, day);
    const pill = pillState(f, day);
    const conditions = Object.entries(FEMALE_CONDITIONS).filter(([key]) => f[key]).map(([, c]) => c.label);
    const libido = withLive(s.libido, live.libido);
    const energy = withLive(s.energy, live.energy);
    const phaseText = pill.suppressed && ['ovulation', 'follicular'].includes(s.phase) ? 'овуляции нет' : s.phaseLabel;
    // свой цвет у кольца цикла: не сливается с влечением (розовое) и энергией (акцент)
    const tone = { menstruation: 'period', pms: 'warm' }[s.phase] ?? 'preg';
    return `<div class="stk-card">${head}
        <div class="stk-person">
            ${ringsHtml([{ value: s.cycleDay / s.length, tone }, { value: libido, tone: 'pink' }, { value: energy, tone: 'accent' }], person.key, nameOf(person))}
            <div class="stk-legend-col">
                ${legendRow(tone, 'Цикл', phaseText, `день ${s.cycleDay} из ${s.length} · ${nextInCycle(s, pill.suppressed)}`)}
                ${legendRow('pink', 'Влечение', levelWord(libido), joinWhy(`${s.phaseLabel}: ${s.libido > 0.8 ? 'на пике' : s.libido > 0.5 ? 'обычное для этих дней' : 'обычно ниже'}`, storyWhy(live.libido)))}
                ${legendRow('accent', 'Энергия', levelWord(energy), joinWhy(s.energy > 0.7 ? 'фаза даёт силы' : s.energy > 0.45 ? 'ровная' : 'фаза забирает силы', storyWhy(live.energy)))}
            </div>
        </div>
        ${s.fertile && !pill.suppressed ? `<div class="stk-row stk-fertile">${icon('fa-heart')}фертильные дни · шанс зачатия сегодня ${Math.round(s.chanceToday * 100)}%</div>` : ''}
        <div class="stk-row">${icon('fa-heart-pulse')}${esc(s.symptoms.join(', '))}</div>
        ${storyNote(state, person.key)}
        <div class="stk-row stk-muted">${icon('fa-shield-halved')}контрацепция: ${esc(FEMALE_CONTRACEPTION[pill.effective]?.label ?? 'нет')}${conditions.length ? ` · ${esc(conditions.join(', '))}` : ''}${f.perimenopause ? ' · перименопауза' : ''}</div>
    </div>`;
}

/** Quick edit of one person: what Stork knows about them. */
function personEditor(state, key) {
    const p = state.people[key];
    const check = (k, on, label) => `<label class="stk-check"><input type="checkbox" data-f="${k}" ${on ? 'checked' : ''}>${label}</label>`;
    if (key === 'user') {
        const f = p.female;
        const cycleEditable = !f.pregnancy && !f.postpartum;
        const info = cycleEditable ? cycleInfo(f, state.clock.day) : null;
        return `<div class="stk-card stk-edit is-editing" data-key="user">
            <div class="stk-card-title">${icon('fa-venus')}${esc(nameOf(p))}<span class="stk-muted">правка</span></div>
            <div class="stk-grid">
                <label class="stk-field"><span>Возраст</span><input class="text_pole" data-f="age" type="number" min="18" max="90" value="${p.age}"></label>
                ${cycleEditable ? `
                <label class="stk-field"><span>День цикла сейчас</span><input class="text_pole" data-f="cycleDay" type="number" min="1" max="35" value="${Math.min(f.cycleLength, Math.max(1, info.cycleDay))}"></label>
                <label class="stk-field"><span>Длина цикла</span><input class="text_pole" data-f="cycleLength" type="number" min="21" max="35" value="${f.cycleLength}"></label>
                <label class="stk-field"><span>Месячные, дней</span><input class="text_pole" data-f="periodLength" type="number" min="3" max="7" value="${f.periodLength}"></label>` : ''}
                <label class="stk-field"><span>Контрацепция</span><select class="text_pole" data-f="contraception">
                    ${Object.keys(FEMALE_CONTRACEPTION).filter(k => k !== 'pill_missed').map(k => `<option value="${k}" ${f.contraception === k ? 'selected' : ''}>${FEMALE_CONTRACEPTION[k].label}</option>`).join('')}
                </select></label>
            </div>
            ${check('pmsSevere', f.pmsSevere, 'сильный ПМС')}${check('painfulPeriods', f.painfulPeriods, 'болезненные месячные')}
            ${check('pcos', f.pcos, `${FEMALE_CONDITIONS.pcos.label}: ${FEMALE_CONDITIONS.pcos.note}`)}${check('endometriosis', f.endometriosis, `${FEMALE_CONDITIONS.endometriosis.label}: ${FEMALE_CONDITIONS.endometriosis.note}`)}
            <div class="stk-actions">
                <button type="button" class="stk-btn is-primary" data-stk-act="save-person" data-key="user">${icon('fa-check')}Сохранить</button>
                <button type="button" class="stk-btn is-ghost" data-stk-act="cancel-edit">Отмена</button>
            </div>
        </div>`;
    }
    const m = p.male;
    return `<div class="stk-card stk-edit is-editing" data-key="char">
        <div class="stk-card-title">${icon('fa-mars')}${esc(nameOf(p))}<span class="stk-muted">правка</span></div>
        <div class="stk-grid">
            <label class="stk-field"><span>Возраст</span><input class="text_pole" data-f="age" type="number" min="18" max="90" value="${p.age}"></label>
            <label class="stk-field"><span>Фертильность</span><select class="text_pole" data-f="fertility">
                ${Object.entries(MALE_FERTILITY).map(([k, v]) => `<option value="${k}" ${m.fertility === k ? 'selected' : ''}>${v.label}</option>`).join('')}
            </select></label>
        </div>
        ${check('smoker', m.smoker, 'курит')}${check('drinker', m.drinker, 'часто выпивает')}${check('overweight', m.overweight, 'лишний вес')}
        ${check('varicocele', m.varicocele, 'варикоцеле (снижает фертильность)')}${check('vasectomy', m.vasectomyDay !== null, 'вазэктомия')}
        <div class="stk-actions">
            <button type="button" class="stk-btn is-primary" data-stk-act="save-person" data-key="char">${icon('fa-check')}Сохранить</button>
            <button type="button" class="stk-btn is-ghost" data-stk-act="cancel-edit">Отмена</button>
        </div>
    </div>`;
}

/** Hours in words: «~5 ч», «~2 дн.» */
const hoursWord = h => (h >= 36 ? `~${Math.round(h / 24)} дн.` : `~${Math.max(1, Math.round(h))} ч`);

export function maleCard(state, person, view = {}) {
    if (view.editPerson === person.key) return personEditor(state, person.key);
    const m = person.male;
    const s = maleSnapshot(state, person);
    const live = liveNow(state, person.key);
    const left = recoveryLeft(state, person);
    const traits = [m.smoker ? 'курит' : '', m.drinker ? 'выпивает' : '', m.overweight ? 'лишний вес' : '', m.varicocele ? 'варикоцеле' : ''].filter(Boolean);
    const fresh = [...new Set(s.recent.filter(e => e.daysAgo <= 1).map(e => `${e.daysAgo ? 'вчера' : 'сегодня'}: ${e.label}`))];
    const vigor = withLive(s.testosterone, live.energy);
    const libido = withLive(s.libido, live.libido);
    const hour = Math.floor(state.clock.minutes / 60);
    const dayWhy = hour >= 5 && hour < 12 ? 'утром тестостерон на пике' : hour >= 18 || hour < 5 ? 'к вечеру гормоны ниже' : 'днём ровно';
    const freshWhy = s.recent.filter(e => e.daysAgo <= 1).map(e => e.label);
    // why the sperm numbers are what they are — in words, with when it passes
    const delayed = s.reasons.map(r => `${r.label} ${r.daysAgo ? `${r.daysAgo} дн. назад` : 'сегодня'} — пройдёт через ${Math.ceil(r.recoversInDays / 7)} нед.`);
    const countWhy = joinWhy(
        s.reserve < 0.95 ? 'после недавней близости меньше, чем обычно' : '',
        delayed.join('; '),
        !delayed.length && s.spermCount >= 90 ? 'в норме' : '',
        MALE_FERTILITY[m.fertility]?.factor < 1 ? `фертильность: ${MALE_FERTILITY[m.fertility].label}` : '',
        traits.length && s.spermCount < 90 ? `влияет: ${traits.join(', ')}` : '');
    const motilityWhy = joinWhy(delayed.length ? 'тот же сдвиг, что и у количества: сперма созревает около 74 дней' : 'в норме', traits.length ? `влияет: ${traits.join(', ')}` : '');
    const reserveWhy = s.reserve >= 0.99 ? 'полный' : s.reserveFullInHours ? `восстановится полностью через ${hoursWord(s.reserveFullInHours)} по времени истории` : 'восстанавливается';
    return `<div class="stk-card">
        <div class="stk-card-title">${icon('fa-mars')}${esc(nameOf(person))}<span class="stk-muted">${years(person.age)}</span>${pencil(person.key)}</div>
        <div class="stk-person">
            ${ringsHtml([{ value: vigor, tone: 'accent' }, { value: libido, tone: 'pink' }, { value: s.erection, tone: 'warm' }], person.key, nameOf(person))}
            <div class="stk-legend-col">
                ${legendRow('accent', 'Бодрость', vigor > 0.85 ? 'на пике' : vigor > 0.65 ? 'в форме' : 'устал', joinWhy(dayWhy, s.expectingFather ? 'будущий отец: гормоны ниже' : '', storyWhy(live.energy)))}
                ${legendRow('pink', 'Влечение', levelWord(libido), joinWhy(s.daysSinceLast === 0 ? 'после сегодняшней близости ниже' : s.daysSinceLast !== null && s.daysSinceLast >= 4 ? `${s.daysSinceLast} дн. без близости — выше` : '', freshWhy.length ? `сегодня: ${freshWhy.join(', ')}` : '', storyWhy(live.libido)))}
                ${legendRow('warm', 'Эрекция', s.erection < 0.75 ? 'может подвести' : 'в порядке', s.erection < 0.75 ? (freshWhy.length ? freshWhy.join(', ') : 'усталость или возраст') : '')}
            </div>
        </div>
        ${left > 0 ? `<div class="stk-row stk-recover">${icon('fa-hourglass-half')}восстанавливается после оргазма: ещё ~${left} мин по времени истории</div>` : ''}
        ${storyNote(state, person.key)}
        <div class="stk-sub">Сперма</div>
        <div class="stk-sperm">
            <div>${miniRing('pink', s.countNow / 100, `${s.countNow}%`)}<div><b>Количество</b><small>${esc(countWhy || 'в норме')}</small></div></div>
            <div>${miniRing('pink', s.motility / 100, `${s.motility}%`)}<div><b>Подвижность</b><small>${esc(motilityWhy)}</small></div></div>
            <div>${miniRing('accent', s.reserve, `${Math.round(s.reserve * 100)}%`)}<div><b>Запас</b><small>${esc(reserveWhy)}</small></div></div>
        </div>
        ${fresh.length ? `<div class="stk-row">${icon('fa-wine-glass')}${esc(fresh.join(', '))}</div>` : ''}
        ${s.vasectomy ? `<div class="stk-row">${icon('fa-scissors')}вазэктомия: ${esc(s.vasectomy)}</div>` : ''}
        ${s.couvade ? `<div class="stk-row">${icon('fa-face-tired')}сопереживает беременности: хуже спит, подташнивает</div>` : ''}
        <div class="stk-row stk-muted">${icon('fa-dna')}фертильность: ${esc(MALE_FERTILITY[m.fertility]?.label ?? 'норма')}${traits.length ? ` · ${esc(traits.join(', '))}` : ''}</div>
    </div>`;
}

function readingLine() {
    const rs = readStatus();
    if (rs.index !== null) return `<div class="stk-reading">${icon('fa-feather-pointed')}<span>читаю последний ответ — показатели обновятся</span></div>`;
    if (rs.failed) return `<div class="stk-reading is-failed">${icon('fa-triangle-exclamation')}<span>анализ не прошёл${rs.failed.error ? `: ${esc(rs.failed.error)}` : ''}</span><button type="button" class="stk-btn is-ghost" data-stk-act="retry">${icon('fa-rotate-right')}Повторить</button></div>`;
    return '';
}

/** What is shared between them: closeness, the chance today, what comes next, what happened lately. */
export function sharedCard(state) {
    const woman = state.people.user;
    const f = woman.female;
    const day = state.clock.day;
    const rows = [];
    const lastAct = state.acts.at(-1);
    if (lastAct) {
        const ago = day - lastAct.day;
        rows.push(`<div class="stk-row">${icon('fa-heart')}последняя близость: ${ago === 0 ? 'сегодня' : ago === 1 ? 'вчера' : `${ago} дн. назад`} · ${esc(ACT_LABEL[lastAct.protection] ?? lastAct.protection)}${lastAct.condomBroke ? ', презерватив порвался' : ''}</div>`);
    }
    if (!f.pregnancy && !f.postpartum) {
        const s = cycleInfo(f, day);
        const pill = pillState(f, day);
        // the chance itself sits on her card; here only what it means for the two of them
        if (s.fertile && !pill.suppressed && lastAct?.protection === 'none' && day - lastAct.day <= 5) rows.push(`<div class="stk-row stk-fertile">${icon('fa-seedling')}была близость без защиты в фертильные дни — беременность возможна</div>`);
    }
    const next = upcoming(state, woman);
    const recent = [...state.log].reverse().filter(e => !['roll', 'intimacy'].includes(e.kind)).slice(0, 3);
    return `<div class="stk-card stk-shared">
        <div class="stk-card-title">${icon('fa-people-arrows')}Вместе</div>
        ${rows.join('') || `<div class="stk-row stk-muted">${icon('fa-heart')}близости пока не было</div>`}
        ${next ? `<div class="stk-sub">Ближайшее</div>${next}` : ''}
        ${recent.length ? `<div class="stk-sub">Недавно</div>${recent.map(e => `<div class="stk-row">${icon(KIND_ICON[e.kind] ?? 'fa-circle-dot')}<span class="stk-muted">${esc(dateLabel(state, e.day, { day: 'numeric', month: 'short' }))}</span>${esc(e.text)}</div>`).join('')}` : ''}
    </div>`;
}
const ACT_LABEL = { none: 'без защиты', condom: 'презерватив', withdrawal: 'прерванный акт' };
const KIND_ICON = { doctor: 'fa-user-doctor', labor: 'fa-baby', injury: 'fa-bandage', recovered: 'fa-battery-full', event: 'fa-circle-dot' };

/** Both of them side by side (one under the other on a phone), then what they share. */
export function renderNow(state, view = {}) {
    const hh = String(Math.floor(state.clock.minutes / 60)).padStart(2, '0'), mm = String(state.clock.minutes % 60).padStart(2, '0');
    return `
        <div class="stk-clock"><b>${esc(capitalize(dateLabel(state)))}</b><span class="stk-muted">${hh}:${mm} · ${esc(timeLabel(state.clock.minutes))}${state.dateSure ? '' : ' · дата пока примерная'}</span></div>
        ${readingLine()}
        <div class="stk-duo">
            ${femaleCard(state, state.people.user, view)}
            ${maleCard(state, state.people.char, view)}
        </div>
        ${sharedCard(state)}`;
}

function renderToday(state, view) {
    return `${renderNow(state, view)}
        <div class="stk-hint">${icon('fa-circle-info')}Stork сам следит за РП: время, близость, привычки, тесты. Карандаш у имени — поправить данные.</div>`;
}

/**
 * Buttons that work the same in the window and in the chat infoblock.
 * @returns {boolean} the click was ours
 */
export function handleAction(target, view, rerender) {
    const act = target?.dataset?.stkAct;
    if (!act) return false;
    const form = target.closest('.stk-edit');
    const values = () => {
        const v = {};
        form?.querySelectorAll('[data-f]').forEach(el => { v[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value; });
        return v;
    };
    switch (act) {
        case 'edit-person': view.editPerson = target.dataset.key; break;
        case 'cancel-edit': view.editPerson = null; break;
        case 'save-person':
            updateCurrentState(state => applyPersonEdit(state, target.dataset.key, values()));
            view.editPerson = null;
            toastr.success('Сохранено', 'Stork', { timeOut: 1500 });
            break;
        case 'cal-month': view.monthOffset = (view.monthOffset ?? 0) + Number(target.dataset.d); break;
        case 'cal-day': {
            const day = Number(target.dataset.day);
            view.pickDay = view.pickDay === day ? null : day;
            break;
        }
        case 'cal-unpick': view.pickDay = null; break;
        case 'cal-period': {
            const day = view.pickDay;
            let done = false;
            updateCurrentState(state => { done = setPeriodStart(state, day); });
            view.pickDay = null;
            toastr[done ? 'success' : 'warning'](done ? 'Начало месячных отмечено, цикл пересчитан' : 'Этот день отметить нельзя', 'Stork', { timeOut: 2000 });
            break;
        }
        case 'retry': retryRead(); break;
        case 'tab': view.tab = target.dataset.tab; view.editPerson = null; break;
        case 'toggle-ext':
            settings().enabled = !settings().enabled;
            saveSettingsDebounced();
            refreshStatus();
            changed();
            toastr.info(settings().enabled ? 'Stork включён' : 'Stork выключен: модель его не видит, анализа нет', 'Stork', { timeOut: 2000 });
            break;
        default: return false;
    }
    rerender();
    return true;
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
        .map(([d, ic, text]) => `<div class="stk-row">${icon(ic)}<span class="stk-up"><b>${esc(when(d))}</b><span class="stk-muted">${esc(text)}</span></span></div>`).join('');
}

export function renderCalendar(state, view) {
    const woman = state.people.user;
    const f = woman.female;
    const today = storyDate(state) ?? new Date();
    const month = new Date(today.getFullYear(), today.getMonth() + view.monthOffset, 1);
    const dayOf = date => state.clock.day + Math.round((date - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
    const actDays = new Set(state.acts.map(a => a.day));
    const testDays = new Set(state.rolls.filter(r => r.kind === 'test').map(r => r.day));
    const firstWeekday = (month.getDay() + 6) % 7;
    const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const editable = !f.pregnancy && !f.postpartum;
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
        if (view.pickDay === storyDay) classes.push('is-picked');
        const marks = `${actDays.has(storyDay) ? icon('fa-heart', 'stk-mark') : ''}${testDays.has(storyDay) ? icon('fa-vial', 'stk-mark') : ''}`;
        // прошедшие дни (и сегодня) можно отметить: «здесь начались месячные»
        const pickable = editable && storyDay <= state.clock.day && state.clock.day - storyDay <= 60;
        cells.push(pickable
            ? `<button type="button" class="${classes.join(' ')}" data-stk-act="cal-day" data-day="${storyDay}"><em>${d}</em>${marks}</button>`
            : `<span class="${classes.join(' ')}"><em>${d}</em>${marks}</span>`);
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
            <button type="button" class="stk-btn is-ghost" data-stk-act="cal-month" data-d="-1" aria-label="Предыдущий месяц">${icon('fa-chevron-left')}</button>
            <b>${esc(capitalize(month.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })))}</b>
            <button type="button" class="stk-btn is-ghost" data-stk-act="cal-month" data-d="1" aria-label="Следующий месяц">${icon('fa-chevron-right')}</button>
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
        ${view.pickDay !== null && view.pickDay !== undefined && editable ? `<div class="stk-pick">
            <span>${icon('fa-droplet')}${esc(capitalize(dateLabel(state, view.pickDay, { day: 'numeric', month: 'long' })))}</span>
            <button type="button" class="stk-btn is-primary" data-stk-act="cal-period">Здесь начались месячные</button>
            <button type="button" class="stk-btn is-ghost" data-stk-act="cal-unpick">Отмена</button>
        </div>` : ''}
        ${editable ? cycleEditor(f) : ''}
        <div class="stk-hint">${icon('fa-circle-info')}${editable ? 'Нажми на прошедший день, чтобы отметить начало месячных. ' : ''}Будущие дни и прошлые циклы показаны как прогноз.</div>`;
}

/** Her cycle, set by hand right in the calendar: saved in this chat. */
function cycleEditor(f) {
    return `<div class="stk-card stk-edit" data-key="user">
        <div class="stk-card-title">${icon('fa-sliders')}Мой цикл</div>
        <div class="stk-grid">
            <label class="stk-field"><span>Длина цикла, дней</span><input class="text_pole" data-f="cycleLength" type="number" min="21" max="35" value="${f.cycleLength}"></label>
            <label class="stk-field"><span>Месячные, дней</span><input class="text_pole" data-f="periodLength" type="number" min="3" max="7" value="${f.periodLength}"></label>
            <label class="stk-field"><span>Цикл</span><select class="text_pole" data-f="irregularity">
                ${[[0, 'регулярный'], [2, 'слегка гуляет'], [5, 'нерегулярный']].map(([v, l]) => `<option value="${v}" ${Number(f.irregularity) === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></label>
        </div>
        <div class="stk-actions"><button type="button" class="stk-btn is-primary" data-stk-act="save-person" data-key="user">${icon('fa-check')}Сохранить цикл</button></div>
    </div>`;
}

// #endregion

// #region Pregnancy

export function renderPregnancy(state) {
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
            <label class="stk-field"><span>Инфоблок в чате</span>
                <select class="text_pole stk-set" data-k="blockPosition">
                    ${[['bottom', 'под ответом бота'], ['top', 'над ответом'], ['middle', 'посередине ответа'], ['off', 'не показывать']].map(([v, l]) => `<option value="${v}" ${(s.blockPosition ?? 'bottom') === v ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
            </label>
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
    const view = { randomDay: 1 + Math.floor(Math.random() * 28), tab: tab ?? 'today', monthOffset: 0, intimacyMenu: false, editing: false, analysis: null, manualAge: {}, editPerson: null, pickDay: null };
    const $root = $(`
        <div class="stk stk-window">
            <div class="stk-head"><div class="stk-brand">${icon('fa-dove')}<span>Stork</span></div><span class="stk-switch-slot"></span></div>
            <nav class="stk-tabs">${TABS.map(t => `<button type="button" class="stk-tab" data-tab="${t.id}">${icon(t.icon)}<span>${t.label}</span></button>`).join('')}</nav>
            <div class="stk-panel"></div>
        </div>`);

    const render = () => {
        const state = currentState();
        // включить / выключить Stork — в шапке окна
        $root.find('.stk-switch-slot').html(switchHtml());
        const setup = view.editing;
        // not on here yet, turned off here, or off everywhere: a short explanation instead of an empty tracker
        const waiting = !setup && (!settings().enabled || !state.setupDone || state.chatOff || state.minorBlocked);
        $root.find('.stk-tabs').toggle(!setup && !waiting);
        $root.find('.stk-tab').each((_, el) => $(el).toggleClass('is-on', el.dataset.tab === view.tab));
        const html = waiting ? renderWaiting(state) : setup ? renderSetup(state, view) : {
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

    // кнопки, общие с инфоблоком в чате: карандаши, календарь, повтор, переключатель
    $root[0].addEventListener('click', event => {
        const target = event.target.closest('[data-stk-act]');
        if (target && $root[0].contains(target)) handleAction(target, view, render);
    });
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
        updateCurrentState(state => { state.chatOff = true; });
        render();
        toastr.info('Stork выключен в этом чате и сам больше не включится. Данные сохранены.', 'Stork');
    });
    $root.on('click', '.stk-enable-chat', () => {
        updateCurrentState(state => { state.chatOff = false; });
        render();
        toastr.info(currentState().setupDone ? 'Stork снова работает в этом чате' : 'Stork включится с ближайшим ответом бота', 'Stork', { timeOut: 2500 });
    });
    $root.on('click', '.stk-setup-now', () => {
        view.editing = true;
        view.touched = false;
        runAnalysis();
    });

    // <details> toggle does not bubble: listen in the capture phase to remember the fold
    $root[0].addEventListener('toggle', event => {
        if (event.target.classList?.contains('stk-fold')) view.manualOpen = event.target.open;
    }, true);

    const unsubscribe = onStateChange(() => render());
    render();
    await callGenericPopup($root, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: 'Закрыть' });
    unsubscribe?.();
}
