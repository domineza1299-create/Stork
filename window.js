/*
 * The Stork window (the wand, the line above the input, /stork): tabs, the setup form, the journal and the settings.
 * Today, calendar and pregnancy are drawn by classic.js; the buttons shared with the infoblock go through handleAction in ui.js.
 */
import { saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { cycleInfo, ERAS, FEMALE_CONDITIONS, FEMALE_CONTRACEPTION, MALE_FERTILITY, PERIOD_FLOW, STORY_MODES } from './biology.js';
import { analyzeCards, guessAge, readCards } from './cards.js';
import { connectionManagerOn, CURRENT, describeChoice, ensureProfileChoice, errorText, getProfiles, requestModel } from './connection.js';
import { advanceTime, applyEvent, dateLabel, extractClock, extractDate, guessClock, MINUTES_PER_DAY, parseClock, storyDate } from './engine.js';
import { applySwitches, currentState, currentView, enableNow, onStateChange, otherClock, refreshStatus, rereadLast, settings, updateCurrentState, VIEWS } from './store.js';
import { ADULT_AGE, applySetupForm, ruDate, setPeriodStart } from './setup.js';
import { capitalize, esc, icon, nameOf, years } from './common.js';
import { eventLook, notify, notifyDone, notifyWarn } from './notify.js';
import { downloadReport, downloadStoppedReport, stoppedDiagnosis } from './diag.js';
import { clearLog, logCountText, logEvent, logListHtml, onLogChange } from './log.js';
import { handleAction, onKeyActivate } from './ui.js';
import { healthHtml } from './healthui.js';
import * as classic from './classic.js';
import { renderFamily } from './tree.js';

const TABS = [
    { id: 'today', icon: 'fa-sun', label: 'Сегодня' },
    { id: 'calendar', icon: 'fa-calendar-days', label: 'Календарь' },
    { id: 'family', icon: 'fa-people-roof', label: 'Древо' },
    { id: 'pregnancy', icon: 'fa-baby', label: 'Беременность' },
    { id: 'journal', icon: 'fa-book-open', label: 'Журнал' },
    { id: 'settings', icon: 'fa-sliders', label: 'Настройки' },
];

/**
 * Shows new story events as notifications (rolls stay secret); a tap opens the window.
 * «Нина: начались месячные» becomes the name above and «Начались месячные» below.
 */
const announced = new Map();
/** One story event is told once, however many readings carry it (her skip message and the reply after it). */
function firstTime(e) {
    const key = `${e.day}:${e.minutes ?? ''}:${e.who ?? ''}:${e.text}`;
    const now = Date.now();
    for (const [k, at] of announced) if (now - at > 10 * 60 * 1000) announced.delete(k);
    if (announced.has(key)) return false;
    announced.set(key, now);
    return true;
}

export function announce(events) {
    events = (events ?? []).filter(firstTime);
    // the dice of conception, for her eyes only (the story model never hears of them): with the spoilers on
    if (settings().showRolls) {
        for (const e of (events ?? []).filter(x => x.kind === 'roll' && /зачати/i.test(x.text))) {
            const yes = /получилось/.test(e.text) && !/не получилось/.test(e.text);
            const text = e.text.replace(/^Бросок на зачатие:\s*/, 'шанс ').replace(/, получилось$/, ' — получилось').replace(/, не получилось$/, ' — не получилось').replace(/^Зачатие:\s*/, '');
            notify(capitalize(text), { icon: yes ? 'fa-seedling' : 'fa-dice', tone: yes ? 'pink' : 'calm', title: 'Зачатие · спойлер', timeOut: 9000, onClick: () => openStork({ tab: 'journal' }) });
        }
    }
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
        // the story spoke of a period the cycle does not expect: she decides, with one tap
        const shift = event.kind === 'period_hint'
            ? { timeOut: 15000, action: 'Сдвинуть цикл', onClick: () => { updateCurrentState(state => setPeriodStart(state, event.day)); notifyDone('Цикл сдвинут: месячные с этого дня', { icon: 'fa-droplet', tone: 'period' }); } }
            : { timeOut: 7000, onClick: () => openStork() };
        notify(capitalize(own ? event.text.slice(name.length + 2) : event.text), { ...eventLook(event), title: own ? name : 'Stork', ...shift });
    }
}

// #region The log

/** «Скачать журнал»: a .txt file with everything needed to see what went wrong. */
/** «Перестал отслеживать!»: the likeliest reason on screen and a report without the story to send. */
export async function downloadStopped() {
    try {
        const top = stoppedDiagnosis()[0];
        await downloadStoppedReport();
        notifyWarn(`${top.problem}. Что поможет: ${top.help}. Отчёт скачан — пришли его разработчику, переписки и имён в нём нет.`, { timeOut: 15000 });
    } catch (error) {
        notifyWarn(`Не получилось собрать отчёт: ${error?.message ?? error}`);
    }
}

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
            <div class="stk-hint">${icon('fa-circle-info')}Если что-то не так — скачай журнал и пришли. Ключей API в нём нет.</div>
            <label class="stk-check"><input type="checkbox" class="stk-set" data-k="debugPrompts" ${settings().debugPrompts ? 'checked' : ''}>записывать промпты целиком (журнал станет большим, в нём будет текст истории)</label>
            <div class="stk-actions">
                <button type="button" class="stk-btn is-primary" data-stk-act="download-log">${icon('fa-download')}Скачать журнал</button>
                <button type="button" class="stk-btn is-warn" data-stk-act="stopped-report" title="Отчёт о том, почему Stork не отслеживает: без переписки и имён">${icon('fa-heart-crack')}Перестал отслеживать!</button>
                <button type="button" class="stk-btn is-ghost stk-log-clear">${icon('fa-broom')}Очистить</button>
            </div>
            <div class="stk-log-list">${logListHtml()}</div>
        </div>`;
}

// #endregion

// #region Setup

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
    const fromAnalysis = extractClock(readCards().opening) ?? parseClock(pre?.start?.time) ?? guessClock(readCards().opening);
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
            <label class="stk-check"><input type="checkbox" class="stk-in" data-k="userSmoker" ${checked(preUser.smoker, f.smoker)}>курит</label>
            <label class="stk-check"><input type="checkbox" class="stk-in" data-k="userDrinker" ${checked(preUser.drinker, f.drinker)}>часто выпивает</label>
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
            ${preChar.varicocele || m.varicocele ? `<div class="stk-row">${icon('fa-user-doctor')}варикоцеле: сперма слабее</div>` : ''}
            ${preChar.vasectomy || m.vasectomyDay !== null ? `<div class="stk-row">${icon('fa-scissors')}вазэктомия</div>` : ''}

        </div>
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-clock')}История</div>
            <div class="stk-grid">
                <label class="stk-field"><span>Дата в истории сейчас</span><input class="text_pole stk-story" data-k="startDate" type="text" inputmode="numeric" maxlength="10" placeholder="15.03.2025" value="${esc(ruDate(extractDate(readCards().opening, String(pre?.start?.date ?? '').slice(0, 4) || null) ?? (/^\d{4}-\d{2}-\d{2}$/.test(pre?.start?.date ?? '') ? pre.start.date : storyIsoDate(state))))}"></label>
                <label class="stk-field"><span>Время в истории сейчас</span><input class="text_pole stk-story" data-k="time" type="text" inputmode="numeric" maxlength="5" placeholder="21:00" value="${esc(startTime)}"></label>
            </div>
        </div>
        ${minors.length
            ? `<div class="stk-row is-warn">${icon('fa-ban')}По карточке ${minors.map(key => esc(people[key].name)).join(' и ')} младше 18 лет. Stork не ведёт репродуктивные механики для несовершеннолетних.</div>`
            : `<div class="stk-actions"><button type="button" class="stk-btn is-primary stk-setup-save">${icon('fa-check')}${state.setupDone ? 'Сохранить' : 'Включить Stork в этом чате'}</button></div>`}`;
}

const SETUP_FIELDS = ['cycleLength', 'periodLength', 'cycleDay', 'irregularity', 'flow', 'contraception', 'pmsSevere', 'painfulPeriods', 'pcos', 'endometriosis',
    'userSmoker', 'userDrinker', 'fertility', 'smoker', 'drinker', 'startDate', 'time'];

/** Reads the setup form (and the names and ages from the cards) into the state. */
function applySetup($root, state, view) {
    const people = cardPeople(view);
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
    return `<div class="stk-empty">${icon('fa-dove', 'stk-ic-xl')}<div>Stork включится сам на твоём первом сообщении в этом чате: прочитает карточку, персону и начало истории — и дату со временем из шапки приветствия, если они там есть.</div>
        <div class="stk-actions" style="justify-content:center">
            <button type="button" class="stk-btn is-primary stk-enable-now">${icon('fa-power-off')}Включить сейчас</button>
            <button type="button" class="stk-btn stk-setup-now">${icon('fa-sliders')}Настроить вручную</button>
            <button type="button" class="stk-btn is-ghost stk-disable-chat">${icon('fa-ban')}Не включать в этом чате</button>
        </div></div>`;
}

// #region Journal and settings

function renderJournal(state) {
    const entries = [...state.log].reverse().filter(e => settings().showRolls || e.kind !== 'roll');
    const rows = entries.map(e => `<div class="stk-log ${e.kind === 'roll' ? 'is-roll' : ''}"><span>${esc(dateLabel(state, e.day, { day: 'numeric', month: 'short' }))}</span><div>${esc(e.text)}</div></div>`).join('');
    const journal = `
        <label class="stk-check"><input type="checkbox" class="stk-set" data-k="showRolls" ${settings().showRolls ? 'checked' : ''}>показывать броски кубиков (спойлер)</label>
        <div class="stk-card">${rows || '<div class="stk-muted">Пока ничего не произошло.</div>'}</div>`;
    if (!(settings().health && settings().readMode === 'analyzer')) return journal;
    // health on: its cards first, the journal of everything below
    return `${healthHtml(state)}
        <details class="stk-card stk-hl-journal"><summary class="stk-card-title">${icon('fa-book-open')}Журнал событий</summary>${journal}</details>`;
}

/**
 * The profile the analysis goes through, as a select. compact: names only, for the window's head;
 * otherwise with the model, for the settings. The same setting either way.
 */
/** The profile for the intimate scenes: the same as the analysis, or another one (a model whose filter lets the scenes through). */
function sceneProfileSelect() {
    const s = settings();
    const profiles = getProfiles();
    const v = s.sceneProfile ?? '';
    const missing = v && v !== CURRENT && !profiles.some(p => p.id === v);
    return `<select class="text_pole stk-set" data-k="sceneProfile" aria-label="Профиль для откровенных сцен">
        <option value="" ${!v ? 'selected' : ''}>тот же, что для анализа</option>
        ${missing ? '<option value="" selected>— профиль не найден —</option>' : ''}
        ${profiles.map(p => `<option value="${esc(p.id)}" ${p.id === v ? 'selected' : ''}>${esc(p.name)} · ${esc(p.model || '?')}</option>`).join('')}
        <option value="${CURRENT}" ${v === CURRENT ? 'selected' : ''}>Основное подключение SillyTavern</option>
    </select>`;
}

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

/** Who keeps the story clock: the story model's hidden line (as in Almanac), Almanac itself, or the reading. */
function clockSwitch() {
    const s = settings();
    const other = otherClock();
    if (other === 'Almanac') return `<div class="stk-hint">${icon('fa-hourglass-half')}Время ведёт Almanac: Stork берёт дату и время из него и своё правило не добавляет.</div>`;
    return `<label class="stk-setting"><div><b>Время считает РП-модель</b><span class="stk-muted">скрытая строка в ответе; выключи — считает анализ</span></div><input type="checkbox" class="stk-set" data-k="storyClock" ${s.storyClock !== false ? 'checked' : ''}></label>`;
}

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
            ${clockSwitch()}
            ${analyzer ? `
                <div class="stk-field"><span>Профиль подключения для анализа</span>
                    <div class="stk-profile-row">
                        ${profileSelect()}
                        ${iconBtn('stk-test-connection', 'fa-plug-circle-check', 'Проверить подключение')}
                        ${iconBtn('stk-refresh-profiles', 'fa-rotate', 'Обновить список профилей')}
                    </div>
                </div>
                <div class="stk-hint ${used.startsWith('ОШИБКА') ? 'is-warn' : ''}">${icon(used.startsWith('ОШИБКА') ? 'fa-triangle-exclamation' : 'fa-plug')}Запросы идут: ${esc(used)}</div>
                <label class="stk-field"><span>Контекст сообщений</span>
                    <select class="text_pole stk-set" data-k="memoryReplies">
                        ${MEMORY_OPTIONS.map(n => `<option value="${n}" ${Number(s.memoryReplies ?? 20) === n ? 'selected' : ''}>${n} сообщений</option>`).join('')}
                    </select>
                </label>
                ${!connectionManagerOn() ? `<div class="stk-hint is-warn">${icon('fa-triangle-exclamation')}Connection Manager выключен: профилей нет, доступно только основное подключение.</div>` : ''}`
                : `<div class="stk-hint">${icon('fa-circle-info')}Бесплатно, но модель иногда забывает метку.</div>`}
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
            ${current === 'window' ? `<div class="stk-hint">${icon('fa-circle-info')}Открыть — палочка → Stork или /stork.</div>` : ''}
            ${s.showBlock ? `
                <div class="stk-sub">Где инфоблок</div>
                <div class="stk-seg is-wide">
                    ${[['top', 'сверху'], ['middle', 'в середине'], ['bottom', 'снизу']].map(([v, l]) => `<button type="button" class="${s.blockPosition === v ? 'is-on' : ''}" data-stk-act="block-pos" data-pos="${v}">${l}</button>`).join('')}
                </div>
                <div class="stk-sub">Вид инфоблока</div>
                <div class="stk-seg is-wide">
                    ${[['brief', 'кратко'], ['full', 'подробно']].map(([v, l]) => `<button type="button" class="${(s.blockStyle ?? 'brief') === v ? 'is-on' : ''}" data-stk-act="block-auto" data-k="blockStyle" data-v="${v}">${l}</button>`).join('')}
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
                ${autoSeg('blockFolds', [['closed', 'свёрнуты'], ['open', 'развёрнуты'], ['remember', 'как оставила']])}` : ''}
        </div>`;
}

/**
 * Their kinks, read once from the cards: his and hers, each can be renamed, removed or added by hand.
 * Read again from the cards only by the button (one request).
 */
function kinksCard(state, view) {
    if (!state.setupDone) return '';
    const kinks = Array.isArray(state.intim?.kinks) ? state.intim.kinks : [];
    const group = (from, key) => {
        const items = kinks.map((k, i) => ({ ...k, i })).filter(k => (k.from === 'persona') === (from === 'persona'));
        const chips = items.map(k => view.kinkEdit === k.i
            ? `<span class="stk-edit stk-kink-form"><input class="text_pole" data-f="name" type="text" maxlength="40" value="${esc(k.name)}" aria-label="Кинк"><button type="button" class="stk-icon-btn is-primary" data-stk-act="kink-save" data-i="${k.i}" title="Сохранить" aria-label="Сохранить">${icon('fa-check')}</button><button type="button" class="stk-icon-btn" data-stk-act="kink-cancel" title="Отмена" aria-label="Отмена">${icon('fa-xmark')}</button></span>`
            : `<span class="stk-kchip"><button type="button" class="stk-kchip-name" data-stk-act="kink-edit" data-i="${k.i}" title="Изменить">${esc(k.name)}</button><button type="button" class="stk-kchip-del" data-stk-act="kink-del" data-i="${k.i}" title="Убрать" aria-label="Убрать">${icon('fa-xmark')}</button></span>`).join('');
        return `<div class="stk-kink-group">
            <div class="stk-kink-who">${icon(key === 'user' ? 'fa-venus' : 'fa-mars')}${esc(nameOf(state.people[key]))}</div>
            <div class="stk-kchips">${chips || '<span class="stk-muted">пусто</span>'}</div>
            <span class="stk-edit stk-kink-form is-add"><input class="text_pole" data-f="name" type="text" maxlength="40" placeholder="добавить…" aria-label="Новый кинк"><button type="button" class="stk-icon-btn" data-stk-act="kink-add" data-who="${key}" title="Добавить" aria-label="Добавить">${icon('fa-plus')}</button></span>
        </div>`;
    };
    return `<div class="stk-card stk-kinks-card">
        <div class="stk-card-title">${icon('fa-heart-circle-bolt')}Кинки</div>
        ${group('card', 'char')}
        ${group('persona', 'user')}
        <div class="stk-actions"><button type="button" class="stk-btn is-ghost" data-stk-act="kinks-reread" ${view.kinksReading ? 'disabled' : ''}>${icon(view.kinksReading ? 'fa-circle-notch' : 'fa-rotate', view.kinksReading ? 'fa-spin' : '')}Перечитать карточки</button></div>
    </div>`;
}

function renderSettings(state, view) {
    const s = settings();
    const toggle = (key, title, note = '') => `<label class="stk-setting"><div><b>${title}</b>${note ? `<span class="stk-muted">${note}</span>` : ''}</div><input type="checkbox" class="stk-set" data-k="${key}" ${s[key] ? 'checked' : ''}></label>`;
    return `
        ${readingCard()}
        ${viewCard()}
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-comments')}Для модели</div>
            ${toggle('detailed', 'Подробный статус', 'больше токенов')}
            ${toggle('neutral', 'Нейтральные слова', 'для строгих провайдеров')}
            <label class="stk-field"><span>Куда ставить статус</span>
                <select class="text_pole stk-set" data-k="placement">
                    <option value="inject" ${s.placement === 'inject' ? 'selected' : ''}>сам, перед последними сообщениями (лучше всего)</option>
                    <option value="macro" ${s.placement === 'macro' ? 'selected' : ''}>только через {{stork}} в пресете</option>
                </select>
            </label>
        </div>
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-fire-flame-curved')}Близость</div>
            ${toggle('intimacy', 'Режиссёр близости', s.readMode === 'analyzer' ? '' : 'нужен анализ каждого ответа')}
            ${toggle('intimacyBlock', 'Блок сцены в чате')}
            ${s.readMode === 'analyzer' && s.intimacy ? `<label class="stk-field"><span>Модель для откровенных сцен</span>${sceneProfileSelect()}</label>` : ''}
        </div>
        ${s.intimacy ? kinksCard(state, view) : ''}
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-scale-balanced')}Реализм</div>
            ${toggle('erectionDrops', 'Падение эрекции', 'от алкоголя, стресса, недосыпа')}
            ${toggle('trackExes', 'Отслеживать бывших')}
            ${s.readMode === 'analyzer' ? toggle('health', 'Здоровье и психика', 'выключено — только травмы') : `<div class="stk-hint">${icon('fa-circle-info')}Здоровье и психика — только с анализом каждого ответа.</div>`}
            ${s.health && s.readMode === 'analyzer' ? `<label class="stk-field"><span>Течение болезней</span><select class="text_pole stk-set" data-k="healthSpeed">
                ${[['0.5', 'медленно ×0.5'], ['1', 'реализм ×1'], ['2', 'быстро ×2']].map(([v, l]) => `<option value="${v}" ${String(s.healthSpeed ?? 1) === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></label>` : ''}
        </div>
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-bell')}Уведомления</div>
            ${toggle('toasts', 'Уведомления о событиях')}
        </div>
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-comment-dots')}Этот чат</div>
            ${state.setupDone ? `<label class="stk-field"><span>Шансы зачатия</span>
                <select class="text_pole stk-chat-set" data-k="storyMode">
                    ${Object.entries(STORY_MODES).map(([k, v]) => `<option value="${k}" ${(state.storyMode ?? 'realistic') === k ? 'selected' : ''}>${v.label}</option>`).join('')}
                </select>
            </label>` : ''}
            <div class="stk-actions">
                <button type="button" class="stk-btn stk-edit-setup">${icon('fa-pen')}Изменить персонажей</button>
                <button type="button" class="stk-btn stk-reread">${icon('fa-rotate')}Перечитать последний ответ</button>
                <button type="button" class="stk-btn is-ghost stk-disable-chat">${icon('fa-power-off')}Выключить Stork в этом чате</button>
            </div>
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
        const journalTab = $root.find('.stk-tab[data-tab="journal"]');
        journalTab.html(settings().health && settings().readMode === 'analyzer' ? `${icon('fa-notes-medical')}<span>Здоровье</span>` : `${icon('fa-book-open')}<span>Журнал</span>`);
        const html = waiting ? renderWaiting(state) : setup ? renderSetup(state, view) : {
            today: classic.renderToday,
            calendar: classic.renderCalendar,
            pregnancy: classic.renderPregnancy,
            family: renderFamily,
            journal: renderJournal,
            settings: renderSettings,
        }[view.tab](state, view);
        // the tree keeps where she scrolled it; opened anew, it shows the two of them in the middle
        const oldBox = $root.find('.stk-tree-scroll')[0];
        const kept = oldBox ? { left: oldBox.scrollLeft, top: oldBox.scrollTop } : null;
        $root.find('.stk-panel').html(html);
        const box = $root.find('.stk-tree-scroll')[0];
        if (box) {
            if (kept) Object.assign(box, { scrollLeft: kept.left, scrollTop: kept.top });
            else {
                const me = box.querySelector('[data-id="user"]');
                if (me && box.scrollWidth > box.clientWidth) box.scrollLeft = me.offsetLeft + me.offsetWidth - box.clientWidth / 2;
            }
            // a picked relative's editor is under the tree: bring it into sight on a phone
            $root.find('.stk-fam-edit')[0]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
        runAnalysis();
    };

    // buttons shared with the infoblock: pencils, calendar, retry, the switch, the view settings
    $root[0].addEventListener('click', event => {
        const target = event.target.closest('[data-stk-act]');
        if (target && $root[0].contains(target)) handleAction(target, view, render);
    });
    $root.on('click', '.stk-tab', function () {
        view.tab = this.dataset.tab;
        view.pregEdit = false;
        view.famPick = null;
        view.famAdd = false;
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
        notifyDone('Stork включён в этом чате', { icon: 'fa-dove', timeOut: 2500 });
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
        act(state => applyEvent(state, { type: this.dataset.ev, who: this.dataset.who, manual: true }));
    });
    // Settings
    $root.on('change', '.stk-set', function () {
        settings()[this.dataset.k] = this.type === 'checkbox' ? this.checked : this.value;
        applySwitches();
        if (this.dataset.k === 'readProfile' || this.dataset.k === 'readMode') {
            logEvent('info', 'настройки', `${this.dataset.k === 'readMode' ? 'чтение РП' : 'анализ через'}: ${this.dataset.k === 'readMode' ? this.value : describeChoice(this.value)}`);
        }
        saveSettingsDebounced();
        // the connection and the log change nothing in the story: no chat save, only a redraw
        if (['readProfile', 'sceneProfile', 'debugPrompts', 'memoryReplies'].includes(this.dataset.k)) {
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
            const text = await requestModel({ kind: 'test', reason: 'кнопка «Проверить подключение»', choice: settings().readProfile, system: 'You are a connection test.', prompt: 'Reply with one word: OK', maxTokens: 1500 });
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
    $root.on('click', '.stk-enable-now', async function () {
        $(this).prop('disabled', true).html(`${icon('fa-spinner fa-spin')}Читаю карточки…`);
        const ok = await enableNow();
        if (!ok && !currentState().setupDone) notifyWarn('Не получилось включить: посмотри журнал Stork в «Настройках»', { timeOut: 5000 });
        render();
    });
    $root.on('change', '.stk-chat-set', function () {
        const key = this.dataset.k;
        const value = this.value;
        updateCurrentState(state => { state[key] = value; });
        notifyDone('Сохранено', { timeOut: 1500 });
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
