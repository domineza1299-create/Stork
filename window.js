/*
 * The Stork window (the wand, the line above the input, /stork): tabs, the setup form, the journal and the settings.
 * Today, calendar and pregnancy are drawn by classic.js; the buttons shared with the infoblock go through handleAction in ui.js.
 */
import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { cycleInfo, ERAS, FEMALE_CONDITIONS, FEMALE_CONTRACEPTION, MALE_FERTILITY, PERIOD_FLOW, STORY_MODES } from './biology.js';
import { analyzeCards, guessAge, readCards } from './cards.js';
import { connectionManagerOn, CURRENT, describeChoice, ensureProfileChoice, errorText, getProfiles, requestModel } from './connection.js';
import { advanceTime, applyEvent, dateLabel, dateWithWeekday, MINUTES_PER_DAY, parseClock } from './engine.js';
import { currentState, currentView, onStateChange, refreshStatus, rereadLast, settings, updateCurrentState, VIEWS } from './store.js';
import { ADULT_AGE, applySetupForm, setPeriodStart, setStoryDate } from './setup.js';
import { capitalize, esc, icon, nameOf, storyIsoDate, years } from './common.js';
import { eventLook, notify, notifyDone, notifyWarn } from './notify.js';
import { downloadReport } from './diag.js';
import { clearLog, logCountText, logEvent, logListHtml, onLogChange } from './log.js';
import { handleAction, onKeyActivate } from './ui.js';
import * as classic from './classic.js';

const TABS = [
    { id: 'today', icon: 'fa-sun', label: 'Сегодня' },
    { id: 'calendar', icon: 'fa-calendar-days', label: 'Календарь' },
    { id: 'pregnancy', icon: 'fa-baby', label: 'Беременность' },
    { id: 'journal', icon: 'fa-book-open', label: 'Журнал' },
    { id: 'settings', icon: 'fa-sliders', label: 'Настройки' },
];

/**
 * Shows new story events as notifications (rolls stay secret); a tap opens the window.
 * «Нина: начались месячные» becomes the name above and «Начались месячные» below.
 */
export function announce(events) {
    if (!settings().toasts) return;
    const { people, clock } = currentState();
    const shown = (events ?? []).filter(e => !['roll', 'intimacy'].includes(e.kind));
    // after a long time skip: what happened on the way goes into one line, only the last day gets its own
    const recent = shown.filter(e => e.day >= clock.day - 1);
    const earlier = shown.filter(e => e.day < clock.day - 1);
    if (earlier.length) {
        const counts = new Map();
        for (const e of earlier) counts.set(e.text, (counts.get(e.text) ?? 0) + 1);
        const list = [...counts].map(([text, n]) => `${text}${n > 1 ? ` (×${n})` : ''}`).join('; ');
        notify(`Пока шло время: ${list}. Всё есть в журнале.`, { icon: 'fa-clock-rotate-left', tone: 'calm', timeOut: 8000, onClick: () => openStork({ tab: 'journal' }) });
    }
    const seen = new Set();
    for (const event of recent) {
        if (seen.has(event.text)) continue;
        seen.add(event.text);
        const name = event.who ? people[event.who]?.name : '';
        const own = !!name && event.text.startsWith(`${name}: `);
        // the story spoke of a period the cycle does not expect, or named another date: she decides, with one tap
        const shift = event.kind === 'period_hint'
            ? { timeOut: 15000, action: 'Сдвинуть цикл', onClick: () => { updateCurrentState(state => setPeriodStart(state, event.day)); notifyDone('Цикл сдвинут: месячные с этого дня', { icon: 'fa-droplet', tone: 'period' }); } }
            : event.kind === 'date_hint'
                ? { timeOut: 15000, action: 'Переставить', onClick: () => { updateCurrentState(state => setStoryDate(state, event.date, event.day)); notifyDone(`Дата переставлена: ${dateWithWeekday(currentState(), undefined, { long: true })}`, { icon: 'fa-calendar-day' }); } }
                : { timeOut: 7000, onClick: () => openStork() };
        notify(capitalize(own ? event.text.slice(name.length + 2) : event.text), { ...eventLook(event), title: own ? name : 'Stork', ...shift });
    }
}

// #region The log

/** «Скачать журнал»: a .txt file with everything needed to see what went wrong. */
export async function downloadProblemLog() {
    try {
        await downloadReport();
        notifyDone('Журнал скачан: пришли этот файл вместе с описанием, что случилось', { icon: 'fa-file-arrow-down', timeOut: 6000 });
    } catch (error) {
        notifyWarn(`Не получилось сохранить журнал: ${error?.message ?? error}`);
    }
}

function logCard() {
    return `
        <div class="stk-card stk-log-card">
            <div class="stk-card-title">${icon('fa-file-lines')}Журнал Stork<span class="stk-muted stk-log-count">${esc(logCountText())}</span></div>
            <div class="stk-hint">${icon('fa-circle-info')}Всё, что Stork делает: каждый запрос к модели (зачем, через какой профиль, сколько ждали, что вернулось), события чата и ошибки. Живёт до перезагрузки страницы. Если что-то не так — скачай журнал и пришли файл; ключей API в нём нет.</div>
            <label class="stk-check"><input type="checkbox" class="stk-set" data-k="debugPrompts" ${settings().debugPrompts ? 'checked' : ''}>записывать промпты целиком (журнал станет большим, в нём будет текст истории)</label>
            <div class="stk-actions">
                <button type="button" class="stk-btn is-primary" data-stk-act="download-log">${icon('fa-download')}Скачать журнал</button>
                <button type="button" class="stk-btn is-ghost stk-log-clear">${icon('fa-broom')}Очистить</button>
            </div>
            <div class="stk-log-list">${logListHtml()}</div>
        </div>`;
}

// #endregion

// #region Setup

/**
 * Names always come from SillyTavern. Ages: in a chat already set up, what Stork keeps (the pencil may have changed it);
 * otherwise from the analysis, the card text, or (if nothing found) a small field.
 * @returns {{user: {name: string, age: number|null}, char: {name: string, age: number|null}}}
 */
function cardPeople(view, state) {
    const cards = readCards();
    const analysis = view.analysis?.data;
    const kept = key => (state.setupDone ? state.people[key].age : null);
    return {
        user: { name: cards.userName, age: kept('user') ?? analysis?.user?.age ?? guessAge(cards.userText) },
        char: { name: cards.charName, age: kept('char') ?? analysis?.char?.age ?? guessAge(cards.charText) },
    };
}

function ageBadge(key, person, view, state) {
    if (person.age) return `<span class="stk-muted">${years(person.age)}${state.setupDone ? '' : ', из карточки'}</span>`;
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

/**
 * The setup form. The first time it is filled from the analysis of the cards and the story opening;
 * in a chat already set up (no analysis then) from what Stork keeps now, so a save changes only what she edits.
 */
function renderSetup(state, view) {
    const people = cardPeople(view, state);
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
    // remembered: a date she types over this one is hers and is kept
    view.shownDate = /^\d{4}-\d{2}-\d{2}$/.test(pre?.start?.date ?? '') ? pre.start.date : storyIsoDate(state);
    const ageOf = key => people[key].age ?? (Number(view.manualAge?.[key]) || null);
    const minors = ['user', 'char'].filter(key => ageOf(key) && ageOf(key) < ADULT_AGE);
    const checked = (value, fallback) => ((value ?? fallback) ? 'checked' : '');

    return `
        ${state.setupDone ? '' : renderAnalysis(view)}
        ${readingCard()}
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-venus')}${esc(people.user.name || '{{user}}')}${ageBadge('user', people.user, view, state)}</div>
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
            <label class="stk-check"><input type="checkbox" class="stk-in" data-k="userSmoker" ${checked(preUser.smoker, f.smoker)}>курит</label>
            <label class="stk-check"><input type="checkbox" class="stk-in" data-k="userDrinker" ${checked(preUser.drinker, f.drinker)}>часто выпивает</label>
        </div>
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-mars')}${esc(people.char.name || '{{char}}')}${ageBadge('char', people.char, view, state)}</div>
            <label class="stk-field"><span>Фертильность</span>
                <select class="text_pole stk-in" data-k="fertility">
                    ${Object.entries(MALE_FERTILITY).map(([k, v]) => `<option value="${k}" ${fertility === k ? 'selected' : ''}>${v.label}</option>`).join('')}
                </select>
            </label>
            <label class="stk-check"><input type="checkbox" class="stk-in" data-k="smoker" ${checked(preChar.smoker, m.smoker)}>курит</label>
            <label class="stk-check"><input type="checkbox" class="stk-in" data-k="drinker" ${checked(preChar.drinker, m.drinker)}>часто выпивает</label>
            ${preChar.varicocele || m.varicocele ? `<div class="stk-row">${icon('fa-user-doctor')}варикоцеле: сперма слабее</div>` : ''}
            ${preChar.vasectomy || m.vasectomyDay !== null ? `<div class="stk-row">${icon('fa-scissors')}вазэктомия</div>` : ''}
            <div class="stk-hint">${icon('fa-circle-info')}Варикоцеле и вазэктомию Stork берёт из карточки и из РП сам: если врач их найдёт или о них скажут по сюжету.</div>
        </div>
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-clock')}История</div>
            <div class="stk-grid">
                <label class="stk-field"><span>Дата в истории сейчас</span><input class="text_pole stk-story" data-k="startDate" type="date" value="${esc(view.shownDate)}"></label>
                <label class="stk-field"><span>Время в истории сейчас</span><input class="text_pole stk-story" data-k="time" type="time" value="${esc(startTime)}"></label>
                <label class="stk-field"><span>Шансы зачатия</span>
                    <select class="text_pole stk-story" data-k="storyMode">
                        ${Object.entries(STORY_MODES).map(([k, v]) => `<option value="${k}" ${(state.storyMode ?? 'realistic') === k ? 'selected' : ''}>${v.label}</option>`).join('')}
                    </select>
                </label>
                <label class="stk-field"><span>Мир истории</span>
                    <select class="text_pole stk-story" data-k="era">
                        ${Object.entries(ERAS).map(([k, v]) => `<option value="${k}" ${(pre?.story?.era === 'past' && !state.eraSet ? 'traditional' : state.era ?? 'modern') === k ? 'selected' : ''}>${v}</option>`).join('')}
                    </select>
                </label>
            </div>
        </div>
        ${minors.length
            ? `<div class="stk-row is-warn">${icon('fa-ban')}По карточке ${minors.map(key => esc(people[key].name)).join(' и ')} младше 18 лет. Stork не ведёт репродуктивные механики для несовершеннолетних.</div>`
            : `<div class="stk-actions"><button type="button" class="stk-btn is-primary stk-setup-save">${icon('fa-check')}${state.setupDone ? 'Сохранить' : 'Включить Stork в этом чате'}</button></div>`}`;
}

/** What the setup form shows from the story: when it changes, the form is behind. */
const formStamp = state => `${state.setupDone}|${state.clock.day}|${state.clock.minutes}|${state.startDate}|${state.log.length}|${state.people.user.female.cycleStart}`;

const SETUP_FIELDS = ['cycleLength', 'periodLength', 'cycleDay', 'irregularity', 'flow', 'contraception', 'pmsSevere', 'painfulPeriods', 'pcos', 'endometriosis',
    'userSmoker', 'userDrinker', 'fertility', 'smoker', 'drinker', 'startDate', 'time', 'storyMode', 'era'];

/** Reads the setup form (and the names and ages from the cards) into the state. */
function applySetup($root, state, view) {
    const people = cardPeople(view, state);
    const values = {
        userName: people.user.name,
        charName: people.char.name,
        userAge: people.user.age ?? (Number(view.manualAge?.user) || undefined),
        charAge: people.char.age ?? (Number(view.manualAge?.char) || undefined),
    };
    for (const key of SETUP_FIELDS) {
        const el = $root.find(`[data-k="${key}"]`)[0];
        if (el) values[key] = el.type === 'checkbox' ? el.checked : el.value;
    }
    values.dateChanged = 'startDate' in (view.edits ?? {}) && !!values.startDate && values.startDate !== view.shownDate;
    applySetupForm(state, values, view.analysis?.data ?? null);
}

// #endregion

/** On/off switch for the whole extension, in the window header. */
function switchHtml() {
    const on = settings().enabled;
    return `<button type="button" class="stk-switch${on ? ' is-on' : ''}" data-stk-act="toggle-ext" role="switch" aria-checked="${on}" title="${on ? 'Stork включён — нажми, чтобы выключить везде' : 'Stork выключен — нажми, чтобы включить'}"><i></i><span>${on ? 'вкл' : 'выкл'}</span></button>`;
}

/** Not on in this chat (yet, any more, or anywhere): a short explanation instead of an empty tracker. */
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

// #region Journal and settings

function renderJournal(state) {
    const entries = [...state.log].reverse().filter(e => settings().showRolls || e.kind !== 'roll');
    const rows = entries.map(e => `<div class="stk-log ${e.kind === 'roll' ? 'is-roll' : ''}"><span>${esc(dateLabel(state, e.day, { day: 'numeric', month: 'short' }))}</span><div>${esc(e.text)}</div></div>`).join('');
    return `
        <label class="stk-check"><input type="checkbox" class="stk-set" data-k="showRolls" ${settings().showRolls ? 'checked' : ''}>показывать броски кубиков (спойлер)</label>
        <div class="stk-card">${rows || '<div class="stk-muted">Пока ничего не произошло.</div>'}</div>`;
}

/**
 * The profile the analysis goes through, as a select. compact: names only, for the window's head;
 * otherwise with the model, for the settings. The same setting either way.
 */
function profileSelect(compact = false) {
    const s = settings();
    ensureProfileChoice(s, saveSettingsDebounced);
    const profiles = getProfiles();
    const missing = s.readProfile && s.readProfile !== CURRENT && !profiles.some(p => p.id === s.readProfile);
    return `<select class="text_pole stk-set${compact ? ' stk-head-profile' : ''}" data-k="readProfile" title="Через какой профиль Stork читает РП" aria-label="Профиль подключения для анализа">
        ${missing ? '<option value="" selected>— профиль не найден —</option>' : ''}
        ${profiles.map(p => `<option value="${esc(p.id)}" ${p.id === s.readProfile ? 'selected' : ''}>${esc(p.name)}${compact ? '' : ` · ${esc(p.model || '?')}`}</option>`).join('')}
        <option value="${CURRENT}" ${s.readProfile === CURRENT ? 'selected' : ''}>${compact ? 'Основное подключение' : 'Основное подключение SillyTavern (та же модель, что пишет РП)'}</option>
    </select>`;
}

/** How deep the analysis remembers the story: replies, one short line each. */
const MEMORY_OPTIONS = [10, 20, 40, 80, 150];

/** How Stork reads the role-play: a separate request per reply through a chosen profile, or a hidden tag from the story model. */
function readingCard() {
    const s = settings();
    const analyzer = s.readMode === 'analyzer';
    const used = analyzer ? describeChoice(s.readProfile) : '';
    const iconBtn = (cls, ic, title) => `<button type="button" class="stk-icon-btn ${cls}" title="${title}" aria-label="${title}">${icon(ic)}</button>`;
    return `
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-book-open-reader')}Чтение РП</div>
            <label class="stk-field"><span>Как Stork понимает, что произошло</span>
                <select class="text_pole stk-set" data-k="readMode">
                    <option value="analyzer" ${analyzer ? 'selected' : ''}>отдельный анализ каждого ответа (надёжно)</option>
                    <option value="tag" ${!analyzer ? 'selected' : ''}>скрытая метка от РП-модели (бесплатно)</option>
                </select>
            </label>
            ${analyzer ? `
                <div class="stk-field"><span>Профиль подключения для анализа</span>
                    <div class="stk-profile-row">
                        ${profileSelect()}
                        ${iconBtn('stk-test-connection', 'fa-plug-circle-check', 'Проверить подключение')}
                        ${iconBtn('stk-refresh-profiles', 'fa-rotate', 'Обновить список профилей')}
                    </div>
                </div>
                <div class="stk-hint ${used.startsWith('ОШИБКА') ? 'is-warn' : ''}">${icon(used.startsWith('ОШИБКА') ? 'fa-triangle-exclamation' : 'fa-plug')}Запросы идут: ${esc(used)}</div>
                <label class="stk-field"><span>Память анализа: сколько прошлых ответов помнить</span>
                    <select class="text_pole stk-set" data-k="memoryReplies">
                        ${MEMORY_OPTIONS.map(n => `<option value="${n}" ${Number(s.memoryReplies ?? 20) === n ? 'selected' : ''}>${n} ответов · ≈${Math.round(n * 25 / 100) * 100 || 100} токенов</option>`).join('')}
                    </select>
                </label>
                <div class="stk-hint">${icon('fa-clock-rotate-left')}От каждого ответа в память идёт одна строка «когда и что было», не весь текст. Так анализ помнит прошлые дни и не путает время. Больше ответов — дольше память, но дороже каждый запрос.</div>
                ${!connectionManagerOn() ? `<div class="stk-hint is-warn">${icon('fa-triangle-exclamation')}Connection Manager выключен: профилей нет, доступно только основное подключение.</div>` : ''}
                <div class="stk-hint">${icon('fa-coins')}Ровно один короткий запрос после каждого нового ответа бота, около 1-2 тысяч токенов (плюс один раз чтение карточек, когда Stork включается в чате). Свайп назад, правки других расширений и картинки запросов не тратят. Дешевле всего выбрать недорогую модель отдельным профилем.</div>`
                : `<div class="stk-hint">${icon('fa-circle-info')}РП-модель в конце ответа ставит скрытую строчку. Бесплатно, но модель иногда забывает: тогда у часов появится значок, а Stork предложит перейти на анализ.</div>`}
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
    const people = currentState().people;
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
                    ${partCheck('user', esc(nameOf(people.user)))}
                    ${partCheck('char', esc(nameOf(people.char)))}
                    ${partCheck('shared', '«Вместе»: близость, ближайшие даты, события')}
                </div>
                <div class="stk-sub">Инфоблок у нового ответа</div>
                ${autoSeg('blockOpen', [['closed', 'свёрнут'], ['open', 'развёрнут'], ['remember', 'как оставила']])}
                <div class="stk-sub">Плашки «Вместе», ${esc(nameOf(people.user))}, ${esc(nameOf(people.char))}</div>
                ${autoSeg('blockFolds', [['closed', 'свёрнуты'], ['open', 'развёрнуты'], ['remember', 'как оставила']])}
                <div class="stk-hint">${icon('fa-hand-pointer')}«Свёрнут» и «развёрнут» срабатывают с каждым новым ответом бота; между ответами всё можно открывать и закрывать нажатием. «Как оставила» — Stork помнит последнее.</div>` : ''}
        </div>`;
}

function renderSettings(state, view) {
    const s = settings();
    const toggle = (key, title, note) => `<label class="stk-setting"><div><b>${title}</b><span class="stk-muted">${note}</span></div><input type="checkbox" class="stk-set" data-k="${key}" ${s[key] ? 'checked' : ''}></label>`;
    return `
        ${readingCard()}
        ${viewCard()}
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
                <button type="button" class="stk-btn stk-reread">${icon('fa-rotate')}Перечитать последний ответ</button>
                <button type="button" class="stk-btn is-ghost stk-disable-chat">${icon('fa-power-off')}Выключить Stork в этом чате</button>
            </div>
            <div class="stk-hint">${icon('fa-circle-info')}«Перечитать» прочитает заново твоё последнее сообщение и ответ бота на него, если что-то записалось не так.</div>
        </div>
        ${logCard()}
        ${manualCard(view)}`;
}

// #endregion

/**
 * Opens the Stork window.
 * @param {object} [options]
 * @param {string} [options.tab]
 */
export async function openStork({ tab } = {}) {
    const view = { randomDay: 1 + Math.floor(Math.random() * 28), tab: tab ?? 'today', monthOffset: 0, editing: false, analysis: null, manualAge: {}, editPerson: null, pickDay: null };
    const $root = $(`
        <div class="stk stk-window">
            <div class="stk-head"><div class="stk-brand">${icon('fa-dove')}<span>Stork</span></div><span class="stk-profile-slot"></span><span class="stk-switch-slot"></span></div>
            <nav class="stk-tabs">${TABS.map(t => `<button type="button" class="stk-tab" data-tab="${t.id}">${icon(t.icon)}<span>${t.label}</span></button>`).join('')}</nav>
            <div class="stk-panel"></div>
        </div>`);

    const render = () => {
        const state = currentState();
        $root.find('.stk-switch-slot').html(switchHtml());
        // the profile right in the head: switching between profiles without opening the settings
        $root.find('.stk-profile-slot').html(settings().readMode === 'analyzer' ? profileSelect(true) : '');
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
        // the setup form drawn again (an age, the analysis, a reply read): what she changed goes back on top,
        // the fields she did not touch show Stork's newest values
        if (setup) {
            view.formStamp = formStamp(state);
            for (const [key, value] of Object.entries(view.edits ?? {})) {
                const el = $root.find(`.stk-in[data-k="${key}"], .stk-story[data-k="${key}"]`)[0];
                if (!el) continue;
                if (el.type === 'checkbox') el.checked = value;
                else el.value = value;
            }
            view.stale = false;
        }
    };

    /** Reads the cards and the story opening as soon as setup is shown: no button to press. */
    const runAnalysis = async () => {
        view.analysis = { loading: true };
        render();
        try {
            ensureProfileChoice(settings(), saveSettingsDebounced);
            view.analysis = { data: await analyzeCards(settings().readProfile, 'окно настройки: чтение карточек') };
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
    const startSetup = () => {
        view.editing = true;
        view.touched = false;
        view.edits = {};
        view.stale = false;
        // a chat already set up: the form shows what Stork keeps now, the cards are not read again
        if (currentState().setupDone) {
            view.analysis = null;
            render();
        } else runAnalysis();
    };

    // buttons shared with the infoblock: pencils, calendar, retry, the switch, the view settings
    $root[0].addEventListener('click', event => {
        const target = event.target.closest('[data-stk-act]');
        if (target && $root[0].contains(target)) handleAction(target, view, render);
    });
    $root.on('click', '.stk-tab', function () {
        view.tab = this.dataset.tab;
        render();
    });
    // Setup
    // every field she changes is remembered: only these are hers, the rest follow the story
    const edited = el => {
        view.touched = true;
        (view.edits ??= {})[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value;
    };
    $root.on('input change', '.stk-in, .stk-story', function () { edited(this); });
    $root.on('input', '.stk-age', function () {
        view.manualAge[this.dataset.person] = this.value;
    });
    $root.on('change', '.stk-age', () => render());
    $root.on('click', '.stk-analyze', () => runAnalysis());
    $root.on('click', '.stk-random-day', function () {
        const $card = $(this).closest('.stk-card');
        const length = Number($card.find('[data-k="cycleLength"]').val()) || 28;
        const field = $card.find('[data-k="cycleDay"]').val(1 + Math.floor(Math.random() * length))[0];
        if (field) edited(field);
    });
    $root.on('click', '.stk-setup-save', () => {
        // a reply was read while the form was open: first the newest time and cycle, with her changes on top
        if (view.stale) render();
        const wasOn = currentState().setupDone;
        updateCurrentState(state => applySetup($root, state, view));
        view.editing = false;
        view.edits = {};
        view.tab = 'today';
        render();
        notifyDone(wasOn ? 'Сохранено' : 'Stork включён в этом чате', { icon: wasOn ? 'fa-check' : 'fa-dove', timeOut: 2500 });
    });
    $root.on('click', '.stk-edit-setup, .stk-setup-now', startSetup);
    // Manual fixes
    $root.on('click', '.stk-time', function () {
        const minutes = Number(this.dataset.min);
        act(state => advanceTime(state, minutes));
    });
    $root.on('click', '.stk-intimacy', function () {
        act(state => applyEvent(state, { type: 'intimacy', protection: this.dataset.p }));
        notifyDone('Близость отмечена', { icon: 'fa-heart', tone: 'pink' });
    });
    $root.on('click', '.stk-do', function () {
        act(state => applyEvent(state, { type: this.dataset.ev, who: this.dataset.who }));
    });
    // Settings
    $root.on('change', '.stk-set', function () {
        settings()[this.dataset.k] = this.type === 'checkbox' ? this.checked : this.value;
        if (this.dataset.k === 'readProfile' || this.dataset.k === 'readMode') {
            logEvent('info', 'настройки', `${this.dataset.k === 'readMode' ? 'чтение РП' : 'анализ через'}: ${this.dataset.k === 'readMode' ? this.value : describeChoice(this.value)}`);
        }
        saveSettingsDebounced();
        // the connection and the log change nothing in the story: no chat save, only a redraw
        if (['readProfile', 'debugPrompts', 'memoryReplies'].includes(this.dataset.k)) {
            if (!view.touched) render();
            return;
        }
        // Before setup nothing is written into the chat: just redraw
        if (currentState().setupDone) updateCurrentState(() => { });
        else refreshStatus();
        if (view.touched) return;
        render();
    });
    $root.on('click', '.stk-log-clear', () => clearLog());
    $root.on('click', '.stk-refresh-profiles', () => {
        const count = getProfiles().length;
        logEvent('info', 'настройки', `список профилей обновлён: ${count}`);
        render();
        notifyDone(count ? `Профилей подключения: ${count}` : 'Профилей нет: создай их в Connection Manager', { icon: 'fa-rotate', timeOut: 2500 });
    });
    $root.on('click', '.stk-test-connection', async function () {
        const button = $(this).prop('disabled', true).addClass('is-busy');
        try {
            const text = await requestModel({ kind: 'test', reason: 'кнопка «Проверить подключение»', choice: settings().readProfile, system: 'You are a connection test.', prompt: 'Reply with one word: OK', maxTokens: 300 });
            notifyDone(`Подключение работает (${describeChoice(settings().readProfile)}): ${text.trim().slice(0, 60)}`, { icon: 'fa-plug-circle-check', timeOut: 7000 });
        } catch (error) {
            notifyWarn(`Подключение не работает: ${errorText(error)}`, { timeOut: 12000 });
        } finally {
            button.prop('disabled', false).removeClass('is-busy');
        }
    });
    $root.on('click', '.stk-reread', () => {
        if (rereadLast()) notify('Перечитываю последний ответ, это займёт столько же, сколько обычный анализ', { icon: 'fa-rotate', tone: 'accent', timeOut: 4000 });
        else notifyWarn('Перечитывать нечего: в этом чате ещё нет ответа бота, который Stork читает', { timeOut: 4000 });
    });
    $root.on('click', '.stk-disable-chat', () => {
        updateCurrentState(state => { state.chatOff = true; });
        render();
        notify('Stork выключен в этом чате и сам больше не включится. Данные сохранены.', { icon: 'fa-moon', tone: 'calm', timeOut: 6000 });
    });
    $root.on('click', '.stk-enable-chat', () => {
        updateCurrentState(state => { state.chatOff = false; });
        render();
        notifyDone(currentState().setupDone ? 'Stork снова работает в этом чате' : 'Stork включится с ближайшим ответом бота', { icon: 'fa-power-off', timeOut: 3000 });
    });

    // <details> toggle does not bubble: listen in the capture phase to remember the fold
    $root[0].addEventListener('toggle', event => {
        if (event.target.classList?.contains('stk-fold')) view.manualOpen = event.target.open;
    }, true);

    // a background update (a reply was read) must not wipe a form she is typing in
    const unsubscribe = onStateChange(() => {
        // the setup form stays as she is filling it; the newest time and cycle come in when she saves
        if (view.editing) {
            // a reading started or a setting changed: nothing in the form is behind
            if (formStamp(currentState()) === view.formStamp) return;
            view.stale = true;
            if (!$root.find('.stk-stale').length) {
                $root.find('.stk-panel').prepend(`<div class="stk-hint stk-stale">${icon('fa-feather-pointed')}Stork прочитал новый ответ: время и дата обновятся при сохранении, твои правки останутся.</div>`);
            }
            return;
        }
        if ($root[0].contains(document.activeElement) && document.activeElement.closest?.('.stk-edit')) return;
        render();
    });
    // the log list in the settings updates by itself while the window is open
    const unsubscribeLog = onLogChange(() => {
        $root.find('.stk-log-list').html(logListHtml());
        $root.find('.stk-log-count').text(logCountText());
    });
    $root[0].addEventListener('keydown', onKeyActivate);
    render();
    await callGenericPopup($root, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: 'Закрыть' });
    unsubscribe?.();
    unsubscribeLog?.();
}
