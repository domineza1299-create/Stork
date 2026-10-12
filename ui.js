/*
 * The compact look of the infoblock in the chat (block.js places it): panels that fold, thin bars instead of rings.
 * Also the line above the input and handleAction: the buttons that work the same in the infoblock and in the window.
 * The words, the numbers and the editors come from common.js; the window itself is window.js.
 */
import { saveSettingsDebounced } from '../../../../script.js';
import { cycleInfo, DOCTOR_VISITS, FEMALE_CONTRACEPTION, femaleState, laborProgress, pillState, pregnancyInfo } from './biology.js';
import { absMinute, acceptPregnancyClaim, clockText, dateLabel, editPregnancyClaim, liveNow, maleSnapshot, recoveryLeft, rejectPregnancyClaim, shortDate, timeLabel, withLive } from './engine.js';
import { activeIn, changed, currentState, readStatus, refreshStatus, retryRead, settings, updateCurrentState, VIEWS } from './store.js';
import { applyPersonEdit, setPeriodStart } from './setup.js';
import {
    ACT_LABEL, agoWord, avatarUrl, babyWeight, capitalize, claimCard, clamp01, cycleFields, cycleStrip, esc, femaleLevels, femaleTraits, icon, initials, irregularityWord,
    KIND_ICON, knowsPregnancy, levelWord, maleLevels, nameOf, nextInCycle, personFields, pregnancyLibidoWhy, recentEvents, riskyLately,
    spermGrade, spermPanel, upcomingRows, upcomingWhen, years,
} from './common.js';
import { calendarCore } from './classic.js';
import { downloadProblemLog, openStork } from './window.js';
import { notify, notifyDone, notifyWarn } from './notify.js';

// #region Folds: every panel opens and closes, and stays as she left it

const FOLD_KEY = 'stork_folds';
/** Open by default: the people and what they share; the details stay folded. */
const FOLD_DEFAULT = {
    user: true, char: true, shared: true,
    'user-fert': false, 'user-more': false, 'char-sperm': false, 'char-more': false,
    'shared-next': true, 'shared-recent': false,
    'cal-cycle': true, 'cal-mine': false,
    'preg-term': true, 'preg-baby': true, 'preg-mom': false, 'preg-doc': false,
};
let folds = null;
function readFolds() {
    if (!folds) {
        try { folds = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') ?? {}; } catch { folds = {}; }
    }
    return folds;
}
const isFoldOpen = key => readFolds()[key] ?? FOLD_DEFAULT[key] ?? true;
/** The block's main panels, the ones the automatic setting opens or folds. */
const MAIN_FOLDS = ['shared', 'user', 'char'];
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

/** A plain round avatar, initials when there is no picture. */
function avatarHtml(key, name, size = '') {
    const url = avatarUrl(key);
    return `<span class="stk-av${size ? ` is-${size}` : ''}">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : `<b>${esc(initials(name))}</b>`}</span>`;
}

/** The next dates that matter, as lines. */
const upcomingLines = (state, rows) => rows.map(([d, ic, text]) => li(ic, `<b>${esc(upcomingWhen(state, d))}</b> <span class="stk-muted">${esc(text)}</span>`)).join('');

// #endregion

// #region Status line and the folded infoblock

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
    return { text: word, short: vigor > 0.85 ? 'бодр' : word, tone: vigor > 0.65 ? 'accent' : 'calm' };
}

/**
 * The line above the input: she on the left, the story clock in the middle, he on the right. Square, one line
 * on any screen: on a narrow one the words get shorter, then the names and the date step back (CSS container queries).
 */
function statusLineHtml(state, rs) {
    const side = (person, key) => {
        const st = statusOf(state, person);
        const name = nameOf(person);
        const parts = [
            `<i class="fa-solid ${key === 'user' ? 'fa-venus' : 'fa-mars'} stk-sb-ic t-${st.tone}" aria-hidden="true"></i>`,
            `<b class="stk-sb-name">${esc(name.split(/\s+/)[0])}</b>`,
            `<span class="stk-sb-st t-${st.tone}" title="${esc(st.text)}"><span class="stk-sb-long">${esc(st.text)}</span><span class="stk-sb-short">${esc(st.short)}</span></span>`,
        ];
        return `<span class="stk-sb-side is-${key}">${(key === 'user' ? parts : parts.reverse()).join('')}</span>`;
    };
    const [hh, mm] = clockText(state.clock.minutes).split(':');
    const mark = rs.failed
        ? `<button type="button" class="stk-retry" title="Анализ не прошёл: ${esc(rs.failed.error)}. Нажми, чтобы повторить" aria-label="Повторить анализ"><i class="fa-solid fa-rotate-right"></i></button>`
        : rs.index !== null ? '<i class="fa-solid fa-feather-pointed stk-sb-reading" title="Читаю последний ответ" aria-hidden="true"></i>' : '';
    return `${side(state.people.user, 'user')}
        <span class="stk-sb-mid">${mark}<span class="stk-sb-date">${esc(shortDate(state))}</span><time class="stk-sb-clock">${hh}<i>:</i>${mm}</time><span class="stk-sb-part">${esc(timeLabel(state.clock.minutes))}</span></span>
        ${side(state.people.char, 'char')}`;
}

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
        <div class="stk-ib-mid"><b>${mark}${clockText(state.clock.minutes)}</b><span>${esc(shortDate(state, state.clock.day, true))}${chevron()}</span></div>
        <div class="stk-ib-side is-right"><div class="stk-ib-who"><b>${esc(nameOf(c))}</b><span title="${esc(sc.text)}"><span>${esc(sc.short)}</span>${dot(sc.tone)}</span></div>${avatarHtml('char', nameOf(c), 'sm')}</div>
    </div>`;
}

/**
 * The line takes the width, side margins and rounding of the chat's input form, whatever the theme:
 * it looks like part of the chat, and follows when the window or a side panel changes size.
 */
let formObserver = null;
function syncBar(line, form) {
    if (!line || !form) return;
    const cs = getComputedStyle(form);
    line.style.boxSizing = 'border-box';
    line.style.width = `${form.getBoundingClientRect().width}px`;
    line.style.maxWidth = '100%';
    line.style.marginLeft = cs.marginLeft;
    line.style.marginRight = cs.marginRight;
}
function watchForm(line, form) {
    if (!form) return;
    syncBar(line, form);
    formObserver?.disconnect();
    if (typeof ResizeObserver === 'function') {
        formObserver = new ResizeObserver(() => syncBar(document.getElementById('stork_bar'), form));
        formObserver.observe(form);
    } else {
        window.addEventListener('resize', () => syncBar(document.getElementById('stork_bar'), form));
    }
}

export function renderStatusBar() {
    let line = document.getElementById('stork_bar');
    const state = currentState();
    const show = settings().statusBar && activeIn(state);
    if (!show) {
        line?.remove();
        return;
    }
    if (!line) {
        line = document.createElement('div');
        line.id = 'stork_bar';
        line.title = 'Stork: открыть подробности';
        line.addEventListener('click', event => {
            if (event.target.closest('.stk-retry')) {
                event.stopPropagation();
                retryRead();
                return;
            }
            openStork();
        });
        const form = document.getElementById('send_form');
        form?.parentElement?.insertBefore(line, form);
        watchForm(line, form);
    }
    const rs = readStatus();
    line.classList.toggle('is-reading', rs.index !== null);
    line.classList.toggle('is-failed', !!rs.failed);
    line.innerHTML = statusLineHtml(state, rs);
}

// #endregion

// #region «Сейчас»: both of them, built the same way

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

/** A person's panel open on the editor: the fields only, the head stays. */
const editorPanel = (state, person, tools) => panel(person.key, personHead(state, person, { tools }), `<div class="stk-edit" data-key="${person.key}">
            ${personFields(state, person.key)}
        </div>`, { forceOpen: true });

function femaleCard(state, person, view = {}) {
    const key = person.key;
    const editing = view.editPerson === key;
    const tools = pencil(key, editing);
    if (editing) return editorPanel(state, person, tools);
    const f = person.female;
    const day = state.clock.day;
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
        const live = liveNow(state, key);
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
                ${li('fa-ruler-vertical', `${info.baby.length} см, ${babyWeight(info.baby.weight)}`)}
                ${info.kicksFelt ? li('fa-shoe-prints', 'толкается') : ''}
                ${li('fa-venus-mars', p.sexKnown ? esc(p.sexes.join(' и ')) : 'пол пока неизвестен')}
                ${li('fa-calendar-check', `${info.trimester}-й триместр · до родов ${Math.max(0, info.daysToDue)} дн.`)}`)}
            ${subFold(`${key}-more`, 'fa-heart-pulse', 'Самочувствие', info.symptoms[0] ?? '', `
                ${info.symptoms.length > 1 ? li('fa-notes-medical', esc(info.symptoms.slice(1).join(', '))) : ''}
                ${li('fa-person-pregnant', `живот: ${esc(info.belly)}, +${info.weightGain} кг`)}
                ${li('fa-utensils', `тянет на ${esc(p.cravings.join(' и '))}, не выносит ${esc(p.aversions.join(', '))}`)}
                ${whyRow('Влечение', pregnancyLibidoWhy(info))}`)}`);
    }
    if (f.postpartum) {
        const since = day - f.postpartum.birthDay;
        const recovered = Math.min(1, since / 42);
        const energy = withLive(0.35 + 0.4 * recovered, liveNow(state, key).energy);
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
    const traits = femaleTraits(f);
    const { libido, energy, libidoWhy, energyWhy } = femaleLevels(state, person, s);
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
            ${traits.length ? li('fa-notes-medical', esc(traits.join(', '))) : ''}`)}
        ${subFold(`${key}-more`, 'fa-heart-pulse', 'Самочувствие', s.symptoms[0] ?? '', `
            ${s.symptoms.length > 1 ? li('fa-notes-medical', esc(s.symptoms.slice(1).join(', '))) : ''}
            ${whyRow('Энергия', energyWhy)}
            ${whyRow('Влечение', libidoWhy)}`)}`);
}

function maleCard(state, person, view = {}) {
    const key = person.key;
    const editing = view.editPerson === key;
    const tools = pencil(key, editing);
    if (editing) return editorPanel(state, person, tools);
    const L = maleLevels(state, person);
    const s = L.s;
    return panel(key, personHead(state, person, { tools }), `
        <div class="stk-bars">
            ${bar('Бодрость', L.vigor, 'accent', L.vigorWord)}
            ${bar('Влечение', L.libido, 'pink', levelWord(L.libido))}
            ${bar('Эрекция', s.erection, 'preg', L.erectionOk ? 'в порядке' : 'ненадёжна', L.erectionOk ? '' : 'может подвести')}
        </div>
        ${L.left > 0 ? li('fa-hourglass-half', `восстанавливается после оргазма: ещё ~${L.left} мин по времени истории`, 'is-warm') : ''}
        ${storyNote(state, key)}
        ${subFold(`${key}-sperm`, 'fa-dna', 'Сперма', `плодовитость ${spermGrade(s).word} · запас ${Math.round(s.reserve * 100)}%`, `
            ${spermPanel(state, person, L)}
            ${li('fa-dna', esc(L.fertilityLine), 'is-muted')}`)}
        ${subFold(`${key}-more`, 'fa-heart-pulse', 'Самочувствие', L.freshLabels.join(', '), `
            ${whyRow('Бодрость', L.vigorWhy)}
            ${whyRow('Влечение', L.libidoWhy)}
            ${L.erectionOk || L.freshLabels.length ? '' : whyRow('Эрекция', L.erectionWhy)}
            ${s.couvade ? li('fa-face-tired', 'сопереживает беременности: хуже спит, подташнивает') : ''}`)}`);
}

/** What is shared between them: closeness, what it means, what comes next, what happened lately. */
function sharedCard(state) {
    const lastAct = state.acts.at(-1);
    const sub = lastAct ? `близость ${agoWord(state.clock.day - lastAct.day)} · ${ACT_LABEL[lastAct.protection] ?? lastAct.protection}` : 'близости пока не было';
    const rows = [];
    if (lastAct?.condomBroke) rows.push(li('fa-triangle-exclamation', 'в последний раз порвался презерватив', 'is-warm'));
    const risky = riskyLately(state);
    if (risky) rows.push(li('fa-seedling', 'была близость без защиты в фертильные дни — беременность возможна', 'is-pink'));
    const next = upcomingRows(state, state.people.user);
    const recent = recentEvents(state, 4);
    const recentBody = recent.map(e => li(KIND_ICON[e.kind] ?? 'fa-circle-dot', `<span class="stk-muted">${esc(dateLabel(state, e.day, { day: 'numeric', month: 'short' }))}</span> ${esc(e.text)}`)).join('');
    return panel('shared', { icon: 'fa-people-arrows', tone: risky ? 'pink' : 'accent', title: 'Вместе', sub: esc(sub) }, `
        ${rows.join('')}
        ${next.length ? subFold('shared-next', 'fa-calendar-check', 'Ближайшее', `${upcomingWhen(state, next[0][0], true)} · ${next[0][2]}`, upcomingLines(state, next)) : ''}
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
    if (!people.length && !shared) return `${claimCard(state)}${li('fa-eye-slash', 'Все плашки скрыты. Вернуть — в окне Stork, вкладка «Настройки».', 'is-muted')}`;
    return `${claimCard(state)}${shared}${people.length ? `<div class="stk-pair${people.length === 1 ? ' is-single' : ''}">${people.join('')}</div>` : ''}`;
}

// #endregion

// #region Buttons shared by the infoblock and the window

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
    const saveSetting = (key, value) => {
        settings()[key] = value;
        saveSettingsDebounced();
        changed();
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
            notifyDone('Сохранено');
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
            if (done) notifyDone('Начало месячных отмечено, цикл пересчитан', { icon: 'fa-droplet', tone: 'period' });
            else notifyWarn('Этот день отметить нельзя', { timeOut: 2500 });
            break;
        }
        case 'claim-accept':
            updateCurrentState(state => acceptPregnancyClaim(state));
            notifyDone('Беременность принята', { icon: 'fa-person-pregnant', tone: 'preg' });
            break;
        case 'claim-reject': {
            let term = false;
            updateCurrentState(state => { term = state.pregnancyClaim?.kind === 'term'; rejectPregnancyClaim(state); });
            notify(term ? 'Срок возвращён прежний' : 'Отклонено: Stork не считает это беременностью', { icon: 'fa-rotate-left', tone: 'calm', timeOut: 4000 });
            break;
        }
        case 'claim-term': {
            const v = values();
            if (!(Number(v.weeks) > 0)) {
                notifyWarn('Укажи срок в неделях', { timeOut: 2500 });
                return true;
            }
            updateCurrentState(state => editPregnancyClaim(state, v.weeks, v.days));
            notifyDone('Срок поправлен', { icon: 'fa-calendar-check', tone: 'preg' });
            break;
        }
        case 'retry': retryRead(); break;
        case 'tab': view.tab = target.dataset.tab; view.editPerson = null; break;
        case 'toggle-ext':
            settings().enabled = !settings().enabled;
            saveSettingsDebounced();
            refreshStatus();
            changed();
            notify(settings().enabled ? 'Stork включён' : 'Stork выключен: модель его не видит, анализа нет', { icon: 'fa-power-off', tone: settings().enabled ? 'accent' : 'calm', timeOut: 2500 });
            break;
        case 'view':
            Object.assign(settings(), VIEWS[target.dataset.view] ?? VIEWS.both);
            saveSettingsDebounced();
            changed();
            break;
        case 'block-pos': saveSetting('blockPosition', target.dataset.pos); break;
        case 'block-auto': saveSetting(target.dataset.k, target.dataset.v); break;
        case 'block-part': saveSetting('blockParts', { ...settings().blockParts, [target.dataset.part]: !!target.checked }); break;
        case 'open-window':
            openStork({ tab: target.dataset.tab });
            return true;
        case 'download-log':
            downloadProblemLog();
            return true;
        default: return false;
    }
    rerender();
    return true;
}

/** Enter or Space on a panel head works like a click (the heads are not buttons: a pencil sits inside). */
export function onKeyActivate(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const el = event.target;
    if (el?.getAttribute?.('role') !== 'button' || !el.dataset?.stkAct) return;
    event.preventDefault();
    el.click();
}

// #endregion

// #region Calendar

export function renderCalendar(state, view) {
    const woman = state.people.user;
    const f = woman.female;
    const day = state.clock.day;
    const editable = !f.pregnancy && !f.postpartum;
    const info = editable ? cycleInfo(f, day) : null;
    const suppressed = editable && pillState(f, day).suppressed;
    // the strip of her cycle on top (only here: the window has the month for it), then the same calendar as in the window
    return `
        ${editable ? panel('cal-cycle', { icon: 'fa-arrows-spin', tone: PHASE_DOT[info.phase] === 'calm' ? 'preg' : PHASE_DOT[info.phase], title: 'Цикл', sub: `${esc(nameOf(woman))} · день ${info.cycleDay} из ${info.length} · ${esc(suppressed && ['ovulation', 'follicular'].includes(info.phase) ? 'овуляции нет' : info.phaseLabel)}` }, `
            <div class="stk-cycle-big">${cycleStrip(f, day)}</div>
            ${li('fa-forward', esc(nextInCycle(info, suppressed)))}`) : ''}
        <div class="stk-ib-cal">${calendarCore(state, view)}</div>
        ${editable ? li('fa-hand-pointer', 'нажми на прошедший день, чтобы отметить начало месячных', 'is-muted') : ''}
        ${editable ? panel('cal-mine', { icon: 'fa-sliders', tone: 'calm', title: 'Мой цикл', sub: `${f.cycleLength} дн., месячные ${f.periodLength} дн., ${irregularityWord(f)}` }, `
        <div class="stk-edit" data-key="user">
            ${cycleFields(f)}
        </div>`) : ''}`;
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
        ${claimCard(state)}
        ${panel('preg-term', { avatar: avatarHtml('user', nameOf(woman)), tone: 'preg', title: `${info.week} нед. ${info.weekDay} дн.`, sub: `${info.trimester}-й триместр · до родов ${Math.max(0, info.daysToDue)} дн.` }, `
            <div class="stk-bars">${bar('Срок', info.week / 40, 'preg', `${Math.min(100, Math.round(info.week / 40 * 100))}%`)}</div>
            ${li('fa-calendar-check', `предполагаемая дата родов: ${esc(due)}`)}`)}
        ${panel('preg-baby', { icon: 'fa-seedling', tone: 'pink', title: p.babies > 1 ? 'Малыши' : 'Малыш', sub: esc(`размером с ${info.baby.compare}`) }, `
            <div class="stk-stats">
                <div><b>${info.baby.length} см</b><span>рост</span></div>
                <div><b>${babyWeight(info.baby.weight)}</b><span>вес</span></div>
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
