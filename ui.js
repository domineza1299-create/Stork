import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import {
    createPregnancy, cycleInfo, DOCTOR_VISITS, FEMALE_CONDITIONS, FEMALE_CONTRACEPTION, femaleState, laborProgress,
    MALE_FERTILITY, PERIOD_FLOW, perimenopause, pillState, pregnancyInfo, STORY_MODES,
} from './biology.js';
import { analyzeCards, getProfiles, guessAge, readCards } from './cards.js';
import { getContext } from '../../../extensions.js';
import { absMinute, advanceTime, applyEvent, dateLabel, liveNow, maleSnapshot, MINUTES_PER_DAY, parseClock, recoveryLeft, storyDate, timeLabel, withLive } from './engine.js';
import { activeIn, changed, currentState, currentView, onStateChange, readStatus, refreshStatus, retryRead, settings, updateCurrentState, VIEWS } from './store.js';
import { applyPersonEdit, setPeriodStart } from './setup.js';
import * as classic from './classic.js';

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

export const PHASE_TONE = { menstruation: 'period', follicular: 'calm', ovulation: 'fertile', luteal: 'calm', pms: 'warm' };

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

/** Shows new story events as toasts (rolls stay secret). */
export function announce(events) {
    if (!settings().toasts) return;
    for (const event of events ?? []) {
        if (['roll', 'intimacy'].includes(event.kind)) continue;
        const text = event.text.charAt(0).toUpperCase() + event.text.slice(1);
        toastr.info(text, 'Stork', { timeOut: 7000, onclick: () => openStork() });
    }
}

export function knowsPregnancy(person) {
    return !!person.female.pregnancy?.knownBy.includes(person.key);
}

// #region Folds: every panel opens and closes, and stays as she left it

const FOLD_KEY = 'stork_folds';
/** Open by default: the people and what they share; the details stay folded. */
const FOLD_DEFAULT = {
    user: true, char: true, shared: true,
    'user-fert': false, 'user-more': false, 'char-sperm': false, 'char-more': false,
    'shared-next': true, 'shared-recent': false,
    'cal-cycle': true, 'cal-month': true, 'cal-next': false, 'cal-mine': false,
    'preg-term': true, 'preg-baby': true, 'preg-mom': false, 'preg-doc': false,
};
let folds = null;
function readFolds() {
    if (!folds) {
        try { folds = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') ?? {}; } catch { folds = {}; }
    }
    return folds;
}
export const isFoldOpen = key => readFolds()[key] ?? FOLD_DEFAULT[key] ?? true;
/** The block's main panels, the ones the automatic setting opens or folds. */
export const MAIN_FOLDS = ['shared', 'user', 'char'];
/** «always open» / «always folded» for a new reply; «remember» leaves them as she left them. */
export function applyAutoFolds(mode = settings().blockFolds) {
    if (mode !== 'open' && mode !== 'closed') return;
    for (const key of MAIN_FOLDS) setFold(key, mode === 'open');
}
function setFold(key, open) {
    readFolds()[key] = open;
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(folds)); } catch { /* private mode: only for this session */ }
}

const chevron = () => '<i class="fa-solid fa-chevron-down stk-chev" aria-hidden="true"></i>';
const dot = tone => `<i class="stk-dot t-${tone}" aria-hidden="true"></i>`;

/**
 * A panel: a head that folds it (avatar or icon, title, one line under it, tools) and a body.
 * @param {string} key fold key
 * @param {object} head { avatar, icon, title, sub, tone, tools, alert }
 */
function panel(key, head, body, { forceOpen = false } = {}) {
    const open = forceOpen || isFoldOpen(key);
    const face = head.avatar ?? `<span class="stk-av is-icon t-${head.tone ?? 'pink'}">${icon(head.icon ?? 'fa-circle')}</span>`;
    return `<section class="stk-pn${open ? ' is-open' : ''}${head.alert ? ' is-alert' : ''}" data-fold-box="${key}">
        <div class="stk-pn-head" data-stk-act="fold" data-fold="${key}" role="button" tabindex="0" aria-expanded="${open}">
            ${face}
            <div class="stk-pn-title"><b>${head.title}</b>${head.sub ? `<small>${head.tone ? dot(head.tone) : ''}<span>${head.sub}</span></small>` : ''}</div>
            <div class="stk-pn-tools">${head.tools ?? ''}${chevron()}</div>
        </div>
        <div class="stk-pn-body">${body}</div>
    </section>`;
}

/** A small fold inside a panel: a line with a summary on the right. */
function subFold(key, iconName, title, summary, body) {
    const open = isFoldOpen(key);
    return `<div class="stk-sf${open ? ' is-open' : ''}" data-fold-box="${key}">
        <button type="button" class="stk-sf-head" data-stk-act="fold" data-fold="${key}" aria-expanded="${open}">
            ${icon(iconName)}<span>${esc(title)}</span>${summary ? `<em>${esc(summary)}</em>` : '<em></em>'}${chevron()}
        </button>
        <div class="stk-sf-body">${body}</div>
    </div>`;
}

/** One level as a thin bar: label, bar, a word. */
function bar(label, value, tone, word, title = '') {
    const v = Math.round(clamp01(value) * 100);
    return `<div class="stk-bar"${title ? ` title="${esc(title)}"` : ''}><span>${esc(label)}</span><div class="stk-track"><i class="t-${tone}" style="width:${v}%"></i></div><em>${esc(word)}</em></div>`;
}

/** A line of text with an icon. */
const li = (iconName, html, cls = '') => `<div class="stk-li ${cls}">${icon(iconName)}<span>${html}</span></div>`;

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

/** A plain round avatar, initials when there is no picture. */
function avatarHtml(key, name, size = '') {
    const url = avatarUrl(key);
    return `<span class="stk-av${size ? ` is-${size}` : ''}">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : `<b>${esc(initials(name))}</b>`}</span>`;
}

// #endregion

// #region Status line

const PHASE_SHORT = { menstruation: 'месячные', follicular: 'фолликулярная фаза', ovulation: 'овуляция', luteal: 'лютеиновая фаза', pms: 'ПМС' };
const PHASE_DOT = { menstruation: 'period', pms: 'warm', ovulation: 'pink', follicular: 'calm', luteal: 'calm' };

/**
 * Each of them in a few words, with a colour: the same everywhere (the line, the block head, the panels).
 * `short` is for the folded block on a phone: one or two words.
 */
function statusOf(state, person) {
    const day = state.clock.day;
    if (person.sex === 'female') {
        const f = person.female;
        if (f.pregnancy?.labor && knowsPregnancy(person)) return { text: 'роды', short: 'роды', tone: 'preg' };
        if (f.pregnancy && knowsPregnancy(person)) {
            const week = pregnancyInfo(f.pregnancy, day).week;
            return { text: `${week} нед. беременности`, short: `${week} нед.`, tone: 'preg' };
        }
        if (f.postpartum) return { text: `${day - f.postpartum.birthDay} дн. после родов`, short: 'после родов', tone: 'preg' };
        const info = cycleInfo(f, day);
        if (info.late) return { text: `задержка ${info.cycleDay - info.length} дн.`, short: `задержка ${info.cycleDay - info.length} дн.`, tone: 'warm' };
        const suppressed = pillState(f, day).suppressed;
        if (info.fertile && !suppressed) return { text: `день ${info.cycleDay} · фертильно`, short: 'фертильно', tone: 'pink' };
        const noOvulation = suppressed && ['ovulation', 'follicular'].includes(info.phase);
        const phase = noOvulation ? 'без овуляции' : PHASE_SHORT[info.phase];
        const short = info.phase === 'menstruation' ? 'месячные' : info.phase === 'pms' ? 'ПМС' : `день ${info.cycleDay}`;
        return { text: `день ${info.cycleDay} · ${phase}`, short, tone: suppressed ? 'calm' : PHASE_DOT[info.phase] };
    }
    const left = recoveryLeft(state, person);
    if (left > 0) return { text: `восстанавливается ~${left} мин`, short: `отдых ~${left} мин`, tone: 'warm' };
    const vigor = withLive(maleSnapshot(state, person).testosterone, liveNow(state, person.key).energy);
    const word = vigor > 0.85 ? 'полон сил' : vigor > 0.65 ? 'в форме' : 'устал';
    return { text: word, short: word, tone: vigor > 0.65 ? 'accent' : 'calm' };
}

/** Each of them in a few words, as HTML parts. */
function peopleParts(state) {
    return [state.people.user, state.people.char].map(person => {
        const s = statusOf(state, person);
        return `<span class="stk-nw"><b>${esc(nameOf(person))}</b> ${dot(s.tone)}</span>${esc(s.text)}`;
    });
}

/** One short line above the input: date, and the most important about each person. */
function statusLineText(state) {
    return [`${dateLabel(state, state.clock.day, { day: 'numeric', month: 'long' })}, ${timeLabel(state.clock.minutes)}`, ...peopleParts(state)].join('<span class="stk-dot-sep">·</span>');
}

const clockText = state => `${String(Math.floor(state.clock.minutes / 60)).padStart(2, '0')}:${String(state.clock.minutes % 60).padStart(2, '0')}`;

/**
 * Folded infoblock: her on the left, him on the right (each with a word and a colour), the date and time between them.
 * Symmetric, so it reads at a glance and fits one line on a phone.
 */
export function blockHeadHtml(state, open, reading) {
    const u = state.people.user;
    const c = state.people.char;
    const su = statusOf(state, u);
    const sc = statusOf(state, c);
    const failed = readStatus().failed;
    const mark = reading ? `<span class="stk-ib-mark is-reading" title="Читаю последний ответ">${icon('fa-feather-pointed')}</span>`
        : failed ? `<button type="button" class="stk-ib-mark is-failed" data-stk-act="retry" title="Анализ не прошёл: ${esc(failed.error)}. Повторить">${icon('fa-rotate-right')}</button>` : '';
    return `<div class="stk-ib-head" data-stk-act="block-toggle" role="button" tabindex="0" aria-expanded="${open}" title="${open ? 'Свернуть' : 'Развернуть'}">
        <div class="stk-ib-side">${avatarHtml('user', nameOf(u), 'sm')}<div class="stk-ib-who"><b>${esc(nameOf(u))}</b><span title="${esc(su.text)}">${dot(su.tone)}<span>${esc(su.short)}</span></span></div></div>
        <div class="stk-ib-mid"><b>${esc(dateLabel(state, state.clock.day, { weekday: 'short', day: 'numeric', month: 'short' }))}</b><span>${mark}${clockText(state)}${chevron()}</span></div>
        <div class="stk-ib-side is-right"><div class="stk-ib-who"><b>${esc(nameOf(c))}</b><span title="${esc(sc.text)}"><span>${esc(sc.short)}</span>${dot(sc.tone)}</span></div>${avatarHtml('char', nameOf(c), 'sm')}</div>
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
                <label class="stk-field"><span>Дата в истории сейчас</span><input class="text_pole stk-story" data-k="startDate" type="date" value="${esc(/^\d{4}-\d{2}-\d{2}$/.test(pre?.start?.date ?? '') ? pre.start.date : storyIsoDate(state))}"></label>
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

// #region Today: both of them, side by side and built the same way

export const clamp01 = value => Math.min(1, Math.max(0, Number(value) || 0));
/** «высокое влечение», «высокая энергия» */
export const levelWord = (value, female = false) => (value > 0.8 ? (female ? 'высокая' : 'высокое') : value > 0.55 ? (female ? 'обычная' : 'обычное') : (female ? 'низкая' : 'сниженное'));

/** What comes next in her cycle, in words. */
export function nextInCycle(s, suppressed) {
    if (s.late) return `месячные запаздывают на ${s.cycleDay - s.length} дн.`;
    if (suppressed) return `до кровотечения отмены ${s.daysToPeriod} дн.`;
    if (s.relative < -5) return `фертильные дни через ${-5 - s.relative} дн., овуляция через ${-s.relative} дн.`;
    if (s.relative < 0) return `фертильные дни, овуляция через ${-s.relative} дн.`;
    if (s.relative === 0) return 'сегодня овуляция';
    return `до месячных ${s.daysToPeriod} дн.`;
}

/** What the story did to this level: words for the offset from the analysis. */
export function storyWhy(offset) {
    if (offset >= 1.5) return 'по сюжету заметно выше обычного';
    if (offset >= 0.5) return 'по сюжету чуть выше';
    if (offset <= -1.5) return 'по сюжету заметно ниже обычного';
    if (offset <= -0.5) return 'по сюжету чуть ниже';
    return '';
}
export const joinWhy = (...parts) => parts.filter(Boolean).join('; ');
/** «Влечение — потому что…» inside «Самочувствие». */
const whyRow = (label, why) => (why ? li('fa-circle-info', `<b>${esc(label)}:</b> ${esc(why)}`, 'is-muted') : '');

/** How the story shows this person now: mood and a note from the analysis of the latest replies. */
function storyNote(state, key) {
    const live = liveNow(state, key);
    if (!live.note && !live.mood) return '';
    return `<div class="stk-note">${icon('fa-feather-pointed')}<span>${live.mood ? `<b>${esc(capitalize(live.mood))}.</b> ` : ''}${esc(live.note ?? '')}</span></div>`;
}

/** Pencil in the panel head: quick edit of this person. */
const pencil = (key, editing) => `<button type="button" class="stk-pen${editing ? ' is-on' : ''}" data-stk-act="edit-person" data-key="${key}" title="${editing ? 'Закрыть правку' : 'Изменить'}" aria-label="Изменить">${icon(editing ? 'fa-xmark' : 'fa-pen')}</button>`;

function personHead(state, person, extra = {}) {
    const s = statusOf(state, person);
    return {
        avatar: avatarHtml(person.key, nameOf(person)),
        title: `${esc(nameOf(person))}<span class="stk-age">${years(person.age)}</span>`,
        sub: esc(s.text),
        tone: s.tone,
        ...extra,
    };
}

export function femaleCard(state, person, view = {}) {
    const key = person.key;
    const editing = view.editPerson === key;
    const tools = pencil(key, editing);
    if (editing) return panel(key, personHead(state, person, { tools }), personEditor(state, key), { forceOpen: true });
    const f = person.female;
    const day = state.clock.day;
    const live = liveNow(state, key);
    const note = storyNote(state, key);

    if (f.pregnancy?.labor && knowsPregnancy(person)) {
        const progress = laborProgress(f.pregnancy.labor, absMinute(state.clock));
        return panel(key, personHead(state, person, { tools, alert: true }), `
            <div class="stk-bars">${bar('Роды', progress.progress, 'preg', progress.label)}</div>
            ${li('fa-stopwatch', `схватки каждые ${progress.intervalMinutes} мин${progress.waterBroken ? ', воды отошли' : ''}`)}
            ${note}`);
    }
    if (f.pregnancy && knowsPregnancy(person)) {
        const info = pregnancyInfo(f.pregnancy, day);
        const libido = withLive(info.libido, live.libido);
        const energy = withLive([0, 0.45, 0.7, 0.45][info.trimester], live.energy);
        const p = f.pregnancy;
        return panel(key, personHead(state, person, { tools }), `
            <div class="stk-bars">
                ${bar('Энергия', energy, 'accent', levelWord(energy, true))}
                ${bar('Влечение', libido, 'pink', levelWord(libido))}
                ${bar('Срок', info.week / 40, 'preg', `${info.week} из 40 нед.`)}
            </div>
            ${note}
            ${subFold(`${key}-fert`, 'fa-seedling', 'Малыш', `размером с ${info.baby.compare}`, `
                ${li('fa-wand-sparkles', esc(info.baby.develops))}
                ${li('fa-ruler-vertical', `${info.baby.length} см, ${info.baby.weight >= 1000 ? `${(info.baby.weight / 1000).toFixed(1)} кг` : info.baby.weight < 1 ? 'меньше 1 г' : `${info.baby.weight} г`}`)}
                ${info.kicksFelt ? li('fa-shoe-prints', 'толкается') : ''}
                ${li('fa-venus-mars', p.sexKnown ? esc(p.sexes.join(' и ')) : 'пол пока неизвестен')}
                ${li('fa-calendar-check', `${info.trimester}-й триместр · до родов ${Math.max(0, info.daysToDue)} дн.`)}`)}
            ${subFold(`${key}-more`, 'fa-heart-pulse', 'Самочувствие', info.symptoms[0] ?? '', `
                ${info.symptoms.length ? li('fa-notes-medical', esc(info.symptoms.join(', '))) : ''}
                ${li('fa-person-pregnant', `живот: ${esc(info.belly)}, +${info.weightGain} кг`)}
                ${li('fa-utensils', `тянет на ${esc(p.cravings.join(' и '))}, не выносит ${esc(p.aversions.join(', '))}`)}
                ${whyRow('Влечение', joinWhy(info.trimester === 2 ? 'во втором триместре обычно выше' : 'в этом триместре обычно ниже', storyWhy(live.libido)))}`)}`);
    }
    if (f.postpartum) {
        const since = day - f.postpartum.birthDay;
        const recovered = Math.min(1, since / 42);
        const energy = withLive(0.35 + 0.4 * recovered, live.energy);
        return panel(key, personHead(state, person, { tools }), `
            <div class="stk-bars">
                ${bar('Энергия', energy, 'accent', levelWord(energy, true))}
                ${bar('Восстановление', recovered, 'preg', since < 42 ? `${since} из 42 дн.` : 'позади')}
            </div>
            ${f.postpartum.breastfeeding ? li('fa-baby', 'кормит грудью, месячные пока не вернулись') : ''}
            ${note}`);
    }

    const s = femaleState(f, day);
    const pill = pillState(f, day);
    const conditions = Object.entries(FEMALE_CONDITIONS).filter(([k]) => f[k]).map(([, c]) => c.label);
    const libido = withLive(s.libido, live.libido);
    const energy = withLive(s.energy, live.energy);
    const phaseText = pill.suppressed && ['ovulation', 'follicular'].includes(s.phase) ? 'овуляции нет' : s.phaseLabel;
    const fertile = s.fertile && !pill.suppressed;
    const fertSummary = pill.suppressed ? 'овуляции нет' : fertile ? `шанс сегодня ${Math.round(s.chanceToday * 100)}%` : s.relative < -5 ? `окно через ${-5 - s.relative} дн.` : 'вне окна';
    return panel(key, personHead(state, person, { tools }), `
        <div class="stk-bars">
            ${bar('Энергия', energy, 'accent', levelWord(energy, true))}
            ${bar('Влечение', libido, 'pink', levelWord(libido))}
            <div class="stk-bar" title="${esc(`день ${s.cycleDay} из ${s.length}: ${phaseText}`)}"><span>Цикл</span>${cycleStrip(f, day)}<em>${s.cycleDay} из ${s.length}</em></div>
        </div>
        ${note}
        ${subFold(`${key}-fert`, 'fa-heart', 'Фертильность', fertSummary, `
            ${li('fa-arrows-spin', `${esc(phaseText)} · ${esc(nextInCycle(s, pill.suppressed))}`)}
            ${fertile ? li('fa-seedling', `фертильные дни · шанс зачатия сегодня ${Math.round(s.chanceToday * 100)}%`, 'is-pink') : ''}
            ${li('fa-shield-halved', `контрацепция: ${esc(FEMALE_CONTRACEPTION[pill.effective]?.label ?? 'нет')}`)}
            ${conditions.length || f.perimenopause ? li('fa-notes-medical', esc([...conditions, f.perimenopause ? 'перименопауза' : ''].filter(Boolean).join(', '))) : ''}`)}
        ${subFold(`${key}-more`, 'fa-heart-pulse', 'Самочувствие', s.symptoms[0] ?? '', `
            ${li('fa-notes-medical', esc(s.symptoms.join(', ')))}
            ${whyRow('Энергия', joinWhy(s.energy > 0.7 ? 'фаза даёт силы' : s.energy > 0.45 ? 'ровная' : 'фаза забирает силы', storyWhy(live.energy)))}
            ${whyRow('Влечение', joinWhy(`${s.phaseLabel}: ${s.libido > 0.8 ? 'на пике' : s.libido > 0.5 ? 'обычное для этих дней' : 'обычно ниже'}`, storyWhy(live.libido)))}`)}`);
}

/** Hours in words: «~5 ч», «~2 дн.» */
export const hoursWord = h => (h >= 36 ? `~${Math.round(h / 24)} дн.` : `~${Math.max(1, Math.round(h))} ч`);

export function maleCard(state, person, view = {}) {
    const key = person.key;
    const editing = view.editPerson === key;
    const tools = pencil(key, editing);
    if (editing) return panel(key, personHead(state, person, { tools }), personEditor(state, key), { forceOpen: true });
    const m = person.male;
    const s = maleSnapshot(state, person);
    const live = liveNow(state, key);
    const left = recoveryLeft(state, person);
    const traits = [m.smoker ? 'курит' : '', m.drinker ? 'выпивает' : '', m.overweight ? 'лишний вес' : '', m.varicocele ? 'варикоцеле' : ''].filter(Boolean);
    const freshWhy = [...new Set(s.recent.filter(e => e.daysAgo <= 1).map(e => e.label))];
    const vigor = withLive(s.testosterone, live.energy);
    const libido = withLive(s.libido, live.libido);
    const hour = Math.floor(state.clock.minutes / 60);
    const dayWhy = hour >= 5 && hour < 12 ? 'утром тестостерон на пике' : hour >= 18 || hour < 5 ? 'к вечеру гормоны ниже' : 'днём ровно';
    const delayed = s.reasons.map(r => `${r.label} ${r.daysAgo ? `${r.daysAgo} дн. назад` : 'сегодня'} — пройдёт через ${Math.ceil(r.recoversInDays / 7)} нед.`);
    const countWhy = joinWhy(
        s.reserve < 0.95 ? 'после недавней близости меньше обычного' : '',
        delayed.join('; '),
        MALE_FERTILITY[m.fertility]?.factor < 1 ? `фертильность: ${MALE_FERTILITY[m.fertility].label}` : '',
        traits.length && s.spermCount < 90 ? `влияет: ${traits.join(', ')}` : '');
    const reserveWhy = s.reserve >= 0.99 ? 'запас полный' : s.reserveFullInHours ? `запас восстановится через ${hoursWord(s.reserveFullInHours)} по времени истории` : 'запас восстанавливается';
    const erectionOk = s.erection >= 0.75;
    return panel(key, personHead(state, person, { tools }), `
        <div class="stk-bars">
            ${bar('Бодрость', vigor, 'accent', vigor > 0.85 ? 'на пике' : vigor > 0.65 ? 'в форме' : 'устал')}
            ${bar('Влечение', libido, 'pink', levelWord(libido))}
            ${bar('Эрекция', s.erection, 'preg', erectionOk ? 'в порядке' : 'ненадёжна', erectionOk ? '' : 'может подвести')}
        </div>
        ${left > 0 ? li('fa-hourglass-half', `восстанавливается после оргазма: ещё ~${left} мин по времени истории`, 'is-warm') : ''}
        ${storyNote(state, key)}
        ${subFold(`${key}-sperm`, 'fa-dna', 'Сперма', `${s.countNow}% · запас ${Math.round(s.reserve * 100)}%`, `
            <div class="stk-bars">
                ${bar('Количество', s.countNow / 100, 'pink', `${s.countNow}%`)}
                ${bar('Подвижность', s.motility / 100, 'pink', `${s.motility}%`)}
                ${bar('Запас', s.reserve, 'accent', `${Math.round(s.reserve * 100)}%`)}
            </div>
            ${countWhy ? li('fa-circle-info', esc(countWhy), 'is-muted') : ''}
            ${li('fa-battery-half', esc(reserveWhy), 'is-muted')}
            ${li('fa-dna', `фертильность: ${esc(MALE_FERTILITY[m.fertility]?.label ?? 'норма')}${traits.length ? ` · ${esc(traits.join(', '))}` : ''}`)}
            ${s.vasectomy ? li('fa-scissors', `вазэктомия: ${esc(s.vasectomy)}`) : ''}`)}
        ${subFold(`${key}-more`, 'fa-heart-pulse', 'Самочувствие', freshWhy.length ? `сегодня: ${freshWhy.join(', ')}` : dayWhy, `
            ${whyRow('Бодрость', joinWhy(dayWhy, s.expectingFather ? 'будущий отец: гормоны ниже' : '', storyWhy(live.energy)))}
            ${whyRow('Влечение', joinWhy(s.daysSinceLast === 0 ? 'после сегодняшней близости ниже' : s.daysSinceLast !== null && s.daysSinceLast >= 4 ? `${s.daysSinceLast} дн. без близости — выше` : '', freshWhy.length ? `сегодня: ${freshWhy.join(', ')}` : '', storyWhy(live.libido)) || 'как обычно')}
            ${whyRow('Эрекция', erectionOk ? 'без помех' : (freshWhy.length ? freshWhy.join(', ') : 'усталость или возраст'))}
            ${s.couvade ? li('fa-face-tired', 'сопереживает беременности: хуже спит, подташнивает') : ''}`)}`);
}

/** Quick edit of one person: the fields only (the panel head stays). */
function personEditor(state, key) {
    const p = state.people[key];
    const check = (k, on, label) => `<label class="stk-check"><input type="checkbox" data-f="${k}" ${on ? 'checked' : ''}>${label}</label>`;
    const actions = `<div class="stk-actions">
        <button type="button" class="stk-btn is-primary" data-stk-act="save-person" data-key="${key}">${icon('fa-check')}Сохранить</button>
        <button type="button" class="stk-btn is-ghost" data-stk-act="cancel-edit">Отмена</button>
    </div>`;
    if (key === 'user') {
        const f = p.female;
        const cycleEditable = !f.pregnancy && !f.postpartum;
        const info = cycleEditable ? cycleInfo(f, state.clock.day) : null;
        return `<div class="stk-edit" data-key="user">
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
            <div class="stk-checks">
                ${check('pmsSevere', f.pmsSevere, 'сильный ПМС')}${check('painfulPeriods', f.painfulPeriods, 'болезненные месячные')}
                ${check('pcos', f.pcos, FEMALE_CONDITIONS.pcos.label)}${check('endometriosis', f.endometriosis, FEMALE_CONDITIONS.endometriosis.label)}
            </div>
            ${actions}
        </div>`;
    }
    const m = p.male;
    return `<div class="stk-edit" data-key="char">
        <div class="stk-grid">
            <label class="stk-field"><span>Возраст</span><input class="text_pole" data-f="age" type="number" min="18" max="90" value="${p.age}"></label>
            <label class="stk-field"><span>Фертильность</span><select class="text_pole" data-f="fertility">
                ${Object.entries(MALE_FERTILITY).map(([k, v]) => `<option value="${k}" ${m.fertility === k ? 'selected' : ''}>${v.label}</option>`).join('')}
            </select></label>
        </div>
        <div class="stk-checks">
            ${check('smoker', m.smoker, 'курит')}${check('drinker', m.drinker, 'часто выпивает')}${check('overweight', m.overweight, 'лишний вес')}
            ${check('varicocele', m.varicocele, 'варикоцеле')}${check('vasectomy', m.vasectomyDay !== null, 'вазэктомия')}
        </div>
        ${actions}
    </div>`;
}

export function readingLine() {
    const rs = readStatus();
    if (rs.index !== null) return `<div class="stk-reading">${icon('fa-feather-pointed')}<span>читаю последний ответ — показатели обновятся</span></div>`;
    if (rs.failed) return `<div class="stk-reading is-failed">${icon('fa-triangle-exclamation')}<span>анализ не прошёл${rs.failed.error ? `: ${esc(rs.failed.error)}` : ''}</span><button type="button" class="stk-btn is-ghost" data-stk-act="retry">${icon('fa-rotate-right')}Повторить</button></div>`;
    return '';
}

export const ACT_LABEL = { none: 'без защиты', condom: 'презерватив', withdrawal: 'прерванный акт' };
export const KIND_ICON = { doctor: 'fa-user-doctor', labor: 'fa-baby', injury: 'fa-bandage', recovered: 'fa-battery-full', event: 'fa-circle-dot' };

/** What is shared between them: closeness, what it means, what comes next, what happened lately. */
export function sharedCard(state) {
    const woman = state.people.user;
    const f = woman.female;
    const day = state.clock.day;
    const lastAct = state.acts.at(-1);
    const ago = lastAct ? day - lastAct.day : null;
    const when = ago === null ? '' : ago === 0 ? 'сегодня' : ago === 1 ? 'вчера' : `${ago} дн. назад`;
    const sub = lastAct ? `близость ${when} · ${ACT_LABEL[lastAct.protection] ?? lastAct.protection}` : 'близости пока не было';
    const rows = [];
    if (lastAct?.condomBroke) rows.push(li('fa-triangle-exclamation', 'в последний раз порвался презерватив', 'is-warm'));
    if (!f.pregnancy && !f.postpartum && lastAct) {
        const s = cycleInfo(f, day);
        if (s.fertile && !pillState(f, day).suppressed && (lastAct.protection === 'none' || lastAct.condomBroke) && ago <= 5) {
            rows.push(li('fa-seedling', 'была близость без защиты в фертильные дни — беременность возможна', 'is-pink'));
        }
    }
    const next = upcomingRows(state, woman);
    const recent = [...state.log].reverse().filter(e => !['roll', 'intimacy'].includes(e.kind)).slice(0, 4);
    const nextBody = next.map(([d, ic, text]) => li(ic, `<b>${esc(upcomingWhen(state, d))}</b> <span class="stk-muted">${esc(text)}</span>`)).join('');
    const recentBody = recent.map(e => li(KIND_ICON[e.kind] ?? 'fa-circle-dot', `<span class="stk-muted">${esc(dateLabel(state, e.day, { day: 'numeric', month: 'short' }))}</span> ${esc(e.text)}`)).join('');
    return panel('shared', { icon: 'fa-people-arrows', tone: rows.some(r => r.includes('is-pink')) ? 'pink' : 'accent', title: 'Вместе', sub: esc(sub) }, `
        ${rows.join('')}
        ${next.length ? subFold('shared-next', 'fa-calendar-check', 'Ближайшее', `${upcomingWhen(state, next[0][0], true)} · ${next[0][2]}`, nextBody) : ''}
        ${recent.length ? subFold('shared-recent', 'fa-clock-rotate-left', 'Недавно', `${recent.length} ${recent.length === 1 ? 'событие' : recent.length < 5 ? 'события' : 'событий'}`, recentBody) : ''}
        ${!rows.length && !next.length && !recent.length ? li('fa-circle-info', 'пока ничего', 'is-muted') : ''}`);
}

/**
 * The «Сейчас» tab of the infoblock: what they share on top, then both of them
 * (side by side when there is room, one under the other on a phone). Only the panels she chose.
 */
export function renderNow(state, view = {}) {
    const parts = settings().blockParts ?? {};
    const people = [parts.user !== false && femaleCard(state, state.people.user, view), parts.char !== false && maleCard(state, state.people.char, view)].filter(Boolean);
    const shared = parts.shared !== false ? sharedCard(state) : '';
    if (!people.length && !shared) return li('fa-eye-slash', 'Все плашки скрыты. Вернуть — в окне Stork, вкладка «Настройки».', 'is-muted');
    return `${shared}${people.length ? `<div class="stk-pair${people.length === 1 ? ' is-single' : ''}">${people.join('')}</div>` : ''}`;
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
        case 'fold': {
            // folding happens right in the page: nothing is redrawn, so nothing else jumps or replays its animation
            const key = target.dataset.fold;
            const open = !isFoldOpen(key);
            setFold(key, open);
            const box = target.closest('[data-fold-box]');
            if (box) {
                box.classList.toggle('is-open', open);
                box.classList.add('is-anim');
                target.setAttribute('aria-expanded', String(open));
            }
            return true;
        }
        case 'edit-person': view.editPerson = view.editPerson === target.dataset.key ? null : target.dataset.key; break;
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
        case 'view':
            Object.assign(settings(), VIEWS[target.dataset.view] ?? VIEWS.both);
            saveSettingsDebounced();
            changed();
            break;
        case 'block-pos':
            settings().blockPosition = target.dataset.pos;
            saveSettingsDebounced();
            changed();
            break;
        case 'block-auto':
            settings()[target.dataset.k] = target.dataset.v;
            saveSettingsDebounced();
            changed();
            break;
        case 'block-part':
            settings().blockParts = { ...settings().blockParts, [target.dataset.part]: !!target.checked };
            saveSettingsDebounced();
            changed();
            break;
        case 'open-window':
            openStork({ tab: target.dataset.tab });
            return true;
        default: return false;
    }
    rerender();
    return true;
}

// #endregion

// #region Calendar

function cycleStrip(f, day) {
    const info = cycleInfo(f, day);
    const pill = pillState(f, day);
    const cells = [];
    for (let d = 1; d <= info.length; d++) {
        const at = cycleInfo(f, f.cycleStart + d - 1);
        const classes = [`is-${PHASE_TONE[at.phase]}`];
        if (at.fertile && !pill.suppressed) classes.push('is-window');
        if (at.relative === 0 && !pill.suppressed) classes.push('is-ovulation');
        if (d < info.cycleDay) classes.push('is-past');
        if (d === info.cycleDay) classes.push('is-today');
        cells.push(`<span class="${classes.join(' ')}"></span>`);
    }
    return `<div class="stk-cycle" aria-hidden="true">${cells.join('')}</div>`;
}

/** «15 октября (через 5 дн.)», or short: «15 окт.» */
function upcomingWhen(state, d, short = false) {
    const day = state.clock.day;
    if (short) return d === day ? 'сегодня' : d === day + 1 ? 'завтра' : dateLabel(state, d, { day: 'numeric', month: 'short' });
    return `${dateLabel(state, d, { day: 'numeric', month: 'long' })}${d === day ? ' (сегодня)' : ` (через ${d - day} дн.)`}`;
}

/** The next dates that matter: ovulation and period, or doctor visits and birth. [[day, icon, text]] */
function upcomingRows(state, woman) {
    const f = woman.female;
    const day = state.clock.day;
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
        const suppressed = pillState(f, day).suppressed;
        if (!suppressed && s.relative < -5) rows.push([start + s.ovulation - 6, 'fa-heart', 'начало фертильных дней']);
        if (!suppressed && s.relative < 0) rows.push([start + s.ovulation - 1, 'fa-egg', 'овуляция']);
        rows.push([start + s.length, 'fa-droplet', suppressed ? 'кровотечение отмены' : 'следующие месячные']);
    }
    return rows.filter(([d]) => d >= day).sort((a, b) => a[0] - b[0]).slice(0, 4);
}

function upcoming(state, woman) {
    return upcomingRows(state, woman).map(([d, ic, text]) => li(ic, `<b>${esc(upcomingWhen(state, d))}</b> <span class="stk-muted">${esc(text)}</span>`)).join('');
}

export function renderCalendar(state, view) {
    const woman = state.people.user;
    const f = woman.female;
    const day = state.clock.day;
    const today = storyDate(state) ?? new Date();
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
        if (storyDay === day) classes.push('is-today');
        if (storyDay > day) classes.push('is-future');
        if (view.pickDay === storyDay) classes.push('is-picked');
        const marks = `${actDays.has(storyDay) ? icon('fa-heart', 'stk-mark') : ''}${testDays.has(storyDay) ? icon('fa-vial', 'stk-mark') : ''}`;
        // прошедшие дни (и сегодня) можно отметить: «здесь начались месячные»
        const pickable = editable && storyDay <= day && day - storyDay <= 60;
        cells.push(pickable
            ? `<button type="button" class="${classes.join(' ')}" data-stk-act="cal-day" data-day="${storyDay}"><em>${d}</em>${marks}</button>`
            : `<span class="${classes.join(' ')}"><em>${d}</em>${marks}</span>`);
    }

    const info = editable ? cycleInfo(f, day) : null;
    const suppressed = editable && pillState(f, day).suppressed;
    const next = upcomingRows(state, woman);
    const nav = d => `<button type="button" class="stk-pen" data-stk-act="cal-month" data-d="${d}" aria-label="${d < 0 ? 'Предыдущий' : 'Следующий'} месяц">${icon(d < 0 ? 'fa-chevron-left' : 'fa-chevron-right')}</button>`;
    return `
        ${editable ? panel('cal-cycle', { icon: 'fa-arrows-spin', tone: PHASE_DOT[info.phase] === 'calm' ? 'preg' : PHASE_DOT[info.phase], title: 'Цикл', sub: `${esc(nameOf(woman))} · день ${info.cycleDay} из ${info.length} · ${esc(suppressed && ['ovulation', 'follicular'].includes(info.phase) ? 'овуляции нет' : info.phaseLabel)}` }, `
            <div class="stk-cycle-big">${cycleStrip(f, day)}</div>
            ${li('fa-forward', esc(nextInCycle(info, suppressed)))}`) : ''}
        ${panel('cal-month', { icon: 'fa-calendar-days', tone: 'accent', title: esc(capitalize(month.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }))), tools: `${nav(-1)}${nav(1)}` }, `
            <div class="stk-cal">
                ${['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].map(w => `<span class="is-head">${w}</span>`).join('')}
                ${cells.join('')}
            </div>
            ${view.pickDay !== null && view.pickDay !== undefined && editable ? `<div class="stk-pick">
                <span>${icon('fa-droplet')}${esc(capitalize(dateLabel(state, view.pickDay, { day: 'numeric', month: 'long' })))}</span>
                <button type="button" class="stk-btn is-primary" data-stk-act="cal-period">Здесь начались месячные</button>
                <button type="button" class="stk-btn is-ghost" data-stk-act="cal-unpick">Отмена</button>
            </div>` : ''}
            ${editable ? li('fa-hand-pointer', 'нажми на прошедший день, чтобы отметить начало месячных', 'is-muted') : ''}
            <div class="stk-legend">
                <span><i class="is-period"></i>месячные</span>
                <span><i class="is-window"></i>фертильные</span>
                <span><i class="is-ovulation"></i>овуляция</span>
                ${f.pregnancy ? '<span><i class="is-preg"></i>беременность</span>' : ''}
                <span>${icon('fa-heart')}близость</span>
                <span>${icon('fa-vial')}тест</span>
            </div>`)}
        ${panel('cal-next', { icon: 'fa-calendar-check', tone: 'pink', title: 'Ближайшие даты', sub: next.length ? esc(`${upcomingWhen(state, next[0][0], true)} · ${next[0][2]}`) : 'пока ничего' }, upcoming(state, woman) || li('fa-circle-info', 'пока ничего', 'is-muted'))}
        ${editable ? cycleEditor(f) : ''}`;
}

/** Her cycle, set by hand right in the calendar: saved in this chat. */
function cycleEditor(f) {
    const irregular = { 0: 'регулярный', 2: 'слегка гуляет', 5: 'нерегулярный' }[Number(f.irregularity)] ?? 'свой';
    return panel('cal-mine', { icon: 'fa-sliders', tone: 'calm', title: 'Мой цикл', sub: `${f.cycleLength} дн., месячные ${f.periodLength} дн., ${irregular}` }, `
        <div class="stk-edit" data-key="user">
            <div class="stk-grid">
                <label class="stk-field"><span>Длина цикла, дней</span><input class="text_pole" data-f="cycleLength" type="number" min="21" max="35" value="${f.cycleLength}"></label>
                <label class="stk-field"><span>Месячные, дней</span><input class="text_pole" data-f="periodLength" type="number" min="3" max="7" value="${f.periodLength}"></label>
                <label class="stk-field"><span>Цикл</span><select class="text_pole" data-f="irregularity">
                    ${[[0, 'регулярный'], [2, 'слегка гуляет'], [5, 'нерегулярный']].map(([v, l]) => `<option value="${v}" ${Number(f.irregularity) === v ? 'selected' : ''}>${l}</option>`).join('')}
                </select></label>
            </div>
            <div class="stk-actions"><button type="button" class="stk-btn is-primary" data-stk-act="save-person" data-key="user">${icon('fa-check')}Сохранить цикл</button></div>
        </div>`);
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
    const weight = info.baby.weight >= 1000 ? `${(info.baby.weight / 1000).toFixed(1)} кг` : info.baby.weight < 1 ? 'меньше 1 г' : `${info.baby.weight} г`;
    return `
        ${panel('preg-term', { avatar: avatarHtml('user', nameOf(woman)), tone: 'preg', title: `${info.week} нед. ${info.weekDay} дн.`, sub: `${info.trimester}-й триместр · до родов ${Math.max(0, info.daysToDue)} дн.` }, `
            <div class="stk-bars">${bar('Срок', info.week / 40, 'preg', `${Math.min(100, Math.round(info.week / 40 * 100))}%`)}</div>
            ${li('fa-calendar-check', `предполагаемая дата родов: ${esc(due)}`)}`)}
        ${panel('preg-baby', { icon: 'fa-seedling', tone: 'pink', title: p.babies > 1 ? 'Малыши' : 'Малыш', sub: esc(`размером с ${info.baby.compare}`) }, `
            <div class="stk-stats">
                <div><b>${info.baby.length} см</b><span>рост</span></div>
                <div><b>${weight}</b><span>вес</span></div>
                <div><b>${esc(info.baby.compare)}</b><span>размером с</span></div>
            </div>
            ${li('fa-wand-sparkles', esc(info.baby.develops))}
            ${li('fa-venus-mars', p.sexKnown ? esc(p.sexes.join(' и ')) : 'пол пока неизвестен, узнать на УЗИ с 18 недель')}
            ${info.kicksFelt ? li('fa-shoe-prints', 'толкается') : ''}`)}
        ${panel('preg-mom', { icon: 'fa-heart-pulse', tone: 'preg', title: 'Мама', sub: esc(`живот: ${info.belly}, +${info.weightGain} кг`) }, `
            ${info.symptoms.length ? li('fa-notes-medical', esc(info.symptoms.join(', '))) : ''}
            ${li('fa-utensils', `тянет на ${esc(p.cravings.join(' и '))}, не выносит ${esc(p.aversions.join(', '))}`)}`)}
        ${panel('preg-doc', { icon: 'fa-user-doctor', tone: 'accent', title: 'Врач', sub: `${p.visitsDone.length} из ${DOCTOR_VISITS.length} визитов` },
            DOCTOR_VISITS.map(v => li(p.visitsDone.includes(v.week) ? 'fa-circle-check' : 'fa-circle', `<b>${v.week} нед.</b> ${esc(v.label)}`, p.visitsDone.includes(v.week) ? '' : 'is-muted')).join(''))}`;
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
                <button type="button" class="stk-btn is-ghost stk-do" data-ev="told" data-who="char">узнал о беременности</button>
            </div>
        </details>`;
}

/** Where Stork shows itself in the chat: four tiles with a tiny picture each, then where the infoblock sits and what it shows. */
function viewCard() {
    const s = settings();
    const current = currentView();
    const tiles = [
        ['block', 'Инфоблок', 'под ответом бота'],
        ['bar', 'Полоса', 'над полем ввода'],
        ['both', 'Оба', 'блок и полоса'],
        ['window', 'Только окно', 'в чате ничего'],
    ];
    // a sketch of the chat: two lines of a reply, the infoblock, the input with the line above it
    const sketch = id => `<span class="stk-sketch" aria-hidden="true">
        <i class="is-text"></i><i class="is-text is-short"></i>
        <i class="is-block${VIEWS[id].showBlock ? '' : ' is-off'}"></i>
        <i class="is-line${VIEWS[id].statusBar ? '' : ' is-off'}"></i>
        <i class="is-input"></i>
    </span>`;
    const parts = s.blockParts ?? {};
    const autoSeg = (key, options) => `<div class="stk-seg is-wide">${options.map(([v, l]) => `<button type="button" class="${(s[key] ?? 'remember') === v ? 'is-on' : ''}" data-stk-act="block-auto" data-k="${key}" data-v="${v}">${l}</button>`).join('')}</div>`;
    const partCheck = (key, label) => `<label class="stk-check"><input type="checkbox" data-stk-act="block-part" data-part="${key}" ${parts[key] !== false ? 'checked' : ''}>${label}</label>`;
    return `
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-eye')}Как показывать Stork в чате</div>
            <div class="stk-tiles" role="radiogroup">
                ${tiles.map(([id, title, note]) => `<button type="button" class="stk-tile${current === id ? ' is-on' : ''}" role="radio" aria-checked="${current === id}" data-stk-act="view" data-view="${id}">${sketch(id)}<b>${title}</b><small>${note}</small></button>`).join('')}
            </div>
            ${current === 'window' ? `<div class="stk-hint">${icon('fa-circle-info')}Stork работает как обычно, просто молча. Открыть — палочка → Stork или команда /stork.</div>` : ''}
            ${s.showBlock ? `
                <div class="stk-sub">Где инфоблок</div>
                <div class="stk-seg is-wide">
                    ${[['top', 'сверху'], ['middle', 'в середине'], ['bottom', 'снизу']].map(([v, l]) => `<button type="button" class="${s.blockPosition === v ? 'is-on' : ''}" data-stk-act="block-pos" data-pos="${v}">${l}</button>`).join('')}
                </div>
                <div class="stk-sub">Что в инфоблоке</div>
                <div class="stk-checks">
                    ${partCheck('user', esc(nameOf(currentState().people.user)))}
                    ${partCheck('char', esc(nameOf(currentState().people.char)))}
                    ${partCheck('shared', '«Вместе»: близость, ближайшие даты, события')}
                </div>
                <div class="stk-sub">Инфоблок у нового ответа</div>
                ${autoSeg('blockOpen', [['closed', 'свёрнут'], ['open', 'развёрнут'], ['remember', 'как оставила']])}
                <div class="stk-sub">Плашки «Вместе», ${esc(nameOf(currentState().people.user))}, ${esc(nameOf(currentState().people.char))}</div>
                ${autoSeg('blockFolds', [['closed', 'свёрнуты'], ['open', 'развёрнуты'], ['remember', 'как оставила']])}
                <div class="stk-hint">${icon('fa-hand-pointer')}«Свёрнут» и «развёрнут» срабатывают с каждым новым ответом бота; между ответами всё можно открывать и закрывать нажатием. «Как оставила» — Stork помнит последнее.</div>` : ''}
        </div>`;
}

function renderSettings(state, view) {
    const s = settings();
    const toggle = (key, title, note) => `<label class="stk-setting"><div><b>${title}</b><span class="stk-muted">${note}</span></div><input type="checkbox" class="stk-set" data-k="${key}" ${s[key] ? 'checked' : ''}></label>`;
    return `
        ${viewCard()}
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
            <div class="stk-card-title">${icon('fa-bell')}Уведомления</div>
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

/** Enter or Space on a panel head works like a click (the heads are not buttons: a pencil sits inside). */
export function onKeyActivate(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const el = event.target;
    if (el?.getAttribute?.('role') !== 'button' || !el.dataset?.stkAct) return;
    event.preventDefault();
    el.click();
}

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
            today: classic.renderToday,
            calendar: classic.renderCalendar,
            pregnancy: classic.renderPregnancy,
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

    // a background update (a reply was read) must not wipe a form she is typing in
    const unsubscribe = onStateChange(() => {
        if ($root[0].contains(document.activeElement) && document.activeElement.closest?.('.stk-edit')) return;
        render();
    });
    $root[0].addEventListener('keydown', onKeyActivate);
    render();
    await callGenericPopup($root, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: 'Закрыть' });
    unsubscribe?.();
}
