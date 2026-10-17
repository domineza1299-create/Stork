/*
 * The Stork window's look (the wand, /stork): today, calendar and pregnancy, with rings around the avatars.
 * The infoblock in the chat has its own compact look in ui.js; the words, the numbers and the editors
 * both use come from common.js, the buttons from handleAction in ui.js.
 */
import { careOf, FEMALE_CONTRACEPTION, femaleState, laborProgress, pillState, pregnancyInfo } from './biology.js';
import { absMinute, clockText, dateLabel, liveNow, shortDate, storyDate, timeLabel, withLive } from './engine.js';
import {
    ACT_LABEL, agoWord, avatarUrl, babyWeight, capitalize, claimCard, clamp01, cycleFields, esc, femaleLevels, femaleTraits, icon, initials, KIND_ICON, knowsPregnancy,
    levelWord, maleLevels, monthGrid, nameOf, nextInCycle, personFields, pickBar, pregnancyLibidoWhy, readingLine, recentEvents, riskyLately, upcomingRows,
    pregnancyFacts, spermPanel, upcomingWhen, years,
} from './common.js';

// #region Cover with the avatar, tiles under it

const PHASE_TILE = { menstruation: 'месячные', follicular: 'фолликул.', ovulation: 'овуляция', luteal: 'лютеин.', pms: 'ПМС' };

/** Five steps of a level 0-1: a tile's meter. */
function segHtml(value, tone) {
    const filled = Math.max(value > 0.04 ? 1 : 0, Math.min(5, Math.round(clamp01(value) * 5)));
    return `<span class="stk-seg5" aria-hidden="true">${Array.from({ length: 5 }, (_, n) => `<i class="${n < filled ? `is-on is-${tone}` : ''}"></i>`).join('')}</span>`;
}

/** One tile under the cover: what, how much, and why in the tooltip. tile: { label, value, level 0-1, tone, why } */
function tileHtml({ label, value, level, tone, why }) {
    return `<div class="stk-ptile"${why ? ` title="${esc(why)}"` : ''}><span class="stk-ptile-k">${esc(label)}</span><b class="stk-ptile-v">${esc(value)}</b>${segHtml(level, tone)}</div>`;
}

/**
 * The head of a person card: the avatar as a wide cover, the name and the main state over it,
 * the levels as tiles under it. Replaces the rings: compact on a phone, the avatar stays the face of the card.
 */
function coverHtml(person, { sub, subTone, tiles }) {
    const url = avatarUrl(person.key);
    const name = nameOf(person);
    const face = url ? `<img src="${esc(url)}" alt="" loading="lazy">` : `<b>${esc(initials(name))}</b>`;
    return `<div class="stk-cover is-${person.key}">
            <div class="stk-cover-img${url ? '' : ' is-empty'}">${face}</div>
            <div class="stk-cover-text">
                <div class="stk-cover-name">${icon(person.key === 'user' ? 'fa-venus' : 'fa-mars')}<span>${esc(name)}</span>${person.age ? `<small>${person.age}</small>` : ''}</div>
                ${sub ? `<div class="stk-cover-sub is-${subTone}">${esc(sub)}</div>` : ''}
            </div>
            ${pencil(person.key)}
        </div>
        <div class="stk-ptiles" style="--n:${tiles.length}">${tiles.map(tileHtml).join('')}</div>`;
}

/** How the story shows this person now: note and mood from the analysis of the latest replies. */
function storyNote(state, key) {
    const live = liveNow(state, key);
    if (!live.note && !live.mood) return '';
    return `<div class="stk-story-note">${icon('fa-feather-pointed')}<div>${live.mood ? `<b>${esc(capitalize(live.mood))}.</b> ` : ''}${esc(live.note ?? '')}</div></div>`;
}

// #endregion

// #region Today

/** Pencil in the card title: quick edit of this person. */
const pencil = key => `<button type="button" class="stk-pen" data-stk-act="edit-person" data-key="${key}" title="Изменить" aria-label="Изменить">${icon('fa-pen')}</button>`;

/** Quick edit of one person: what Stork knows about them. */
function personEditor(state, key) {
    return `<div class="stk-card stk-edit is-editing" data-key="${key}">
        <div class="stk-card-title">${icon(key === 'user' ? 'fa-venus' : 'fa-mars')}${esc(nameOf(state.people[key]))}<span class="stk-muted">правка</span></div>
        ${personFields(state, key, { long: true })}
    </div>`;
}

export function femaleCard(state, person, view = {}) {
    if (view.editPerson === person.key) return personEditor(state, person.key);
    const f = person.female;
    const day = state.clock.day;
    const head = `<div class="stk-card-title">${icon('fa-venus')}${esc(nameOf(person))}<span class="stk-muted">${years(person.age)}</span>${pencil(person.key)}</div>`;
    if (f.pregnancy?.labor && knowsPregnancy(person)) {
        const progress = laborProgress(f.pregnancy.labor, absMinute(state.clock));
        return `<div class="stk-card has-cover is-alert">
            ${coverHtml(person, { sub: `роды · схватки каждые ${progress.intervalMinutes} мин${progress.waterBroken ? ', воды отошли' : ''}`, subTone: 'preg', tiles: [{ label: 'Роды', value: progress.label, level: progress.progress, tone: 'preg' }] })}
            ${storyNote(state, person.key)}</div>`;
    }
    if (f.pregnancy && knowsPregnancy(person)) {
        const info = pregnancyInfo(f.pregnancy, day);
        const live = liveNow(state, person.key);
        const libido = withLive(info.libido, live.libido);
        return `<div class="stk-card has-cover">
            ${coverHtml(person, {
        sub: `${info.week} нед. ${info.weekDay} дн. · ${info.trimester}-й триместр · до родов ${Math.max(0, info.daysToDue)} дн.`, subTone: 'preg',
        tiles: [
            { label: 'Срок', value: `${info.week} нед.`, level: info.week / 40, tone: 'preg', why: `${info.trimester}-й триместр` },
            { label: 'Влечение', value: levelWord(libido), level: libido, tone: 'pink', why: pregnancyLibidoWhy(info) },
        ],
    })}
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
    const traits = femaleTraits(f);
    const { libido, energy, libidoWhy, energyWhy } = femaleLevels(state, person, s);
    const phaseText = pill.suppressed && ['ovulation', 'follicular'].includes(s.phase) ? 'овуляции нет' : s.phaseLabel;
    // its own colour for the cycle: it does not merge with desire (pink) and energy (accent)
    const tone = { menstruation: 'period', pms: 'warm' }[s.phase] ?? 'preg';
    const phaseShort = pill.suppressed && ['ovulation', 'follicular'].includes(s.phase) ? 'без овуляции' : PHASE_TILE[s.phase] ?? phaseText;
    return `<div class="stk-card has-cover">
        ${coverHtml(person, {
        sub: `${phaseText} · день ${s.cycleDay} из ${s.length}`, subTone: tone,
        tiles: [
            { label: 'Цикл', value: phaseShort, level: s.cycleDay / s.length, tone, why: nextInCycle(s, pill.suppressed) },
            { label: 'Влечение', value: levelWord(libido), level: libido, tone: 'pink', why: libidoWhy },
            { label: 'Энергия', value: levelWord(energy), level: energy, tone: 'accent', why: energyWhy },
        ],
    })}
        ${s.fertile && !pill.suppressed ? `<div class="stk-row stk-fertile">${icon('fa-heart')}фертильные дни · шанс зачатия сегодня ${Math.round(s.chanceToday * 100)}%</div>` : `<div class="stk-row stk-muted">${icon('fa-calendar-day')}${esc(nextInCycle(s, pill.suppressed))}</div>`}
        <div class="stk-row">${icon('fa-heart-pulse')}${esc(s.symptoms.join(', '))}</div>
        ${storyNote(state, person.key)}
        <div class="stk-row stk-muted">${icon('fa-shield-halved')}контрацепция: ${esc(FEMALE_CONTRACEPTION[pill.effective]?.label ?? 'нет')}${traits.length ? ` · ${esc(traits.join(', '))}` : ''}</div>
    </div>`;
}

export function maleCard(state, person, view = {}) {
    if (view.editPerson === person.key) return personEditor(state, person.key);
    const L = maleLevels(state, person);
    const s = L.s;
    const today = L.freshLabels.length ? `${L.freshLabels.join(', ')} сегодня` : '';
    return `<div class="stk-card has-cover">
        ${coverHtml(person, {
        sub: [L.vigorWord, today].filter(Boolean).join(' · '), subTone: 'accent',
        tiles: [
            { label: 'Бодрость', value: L.vigorWord, level: L.vigor, tone: 'accent', why: L.vigorWhy },
            { label: 'Влечение', value: levelWord(L.libido), level: L.libido, tone: 'pink', why: L.libidoWhy },
            { label: 'Эрекция', value: L.erectionOk ? 'в порядке' : 'может подвести', level: s.erection, tone: 'warm', why: L.erectionOk ? '' : L.erectionWhy },
        ],
    })}
        ${L.left > 0 ? `<div class="stk-row stk-recover">${icon('fa-hourglass-half')}восстанавливается после оргазма: ещё ~${L.left} мин по времени истории</div>` : ''}
        ${storyNote(state, person.key)}
        <div class="stk-sub">Сперма</div>
        ${spermPanel(state, person, L)}
        ${s.couvade ? `<div class="stk-row">${icon('fa-face-tired')}сопереживает беременности: хуже спит, подташнивает</div>` : ''}
        <div class="stk-row stk-muted">${icon('fa-dna')}${esc(L.fertilityLine)}</div>
    </div>`;
}

/** The next dates that matter, as rows of the window. */
const upcoming = (state, woman) => upcomingRows(state, woman)
    .map(([d, ic, text]) => `<div class="stk-row">${icon(ic)}<span class="stk-up"><b>${esc(upcomingWhen(state, d))}</b><span class="stk-muted">${esc(text)}</span></span></div>`).join('');

/** What is shared between them: closeness, the chance today, what comes next, what happened lately. */
export function sharedCard(state) {
    const day = state.clock.day;
    const rows = [];
    const lastAct = state.acts.at(-1);
    if (lastAct) {
        rows.push(`<div class="stk-row">${icon('fa-heart')}последняя близость: ${agoWord(day - lastAct.day)} · ${esc(ACT_LABEL[lastAct.protection] ?? lastAct.protection)}${lastAct.condomBroke ? ', презерватив порвался' : ''}</div>`);
    }
    // the chance itself sits on her card; here only what it means for the two of them
    if (riskyLately(state)) rows.push(`<div class="stk-row stk-fertile">${icon('fa-seedling')}была близость без защиты в фертильные дни — беременность возможна</div>`);
    const next = upcoming(state, state.people.user);
    const recent = recentEvents(state, 3);
    return `<div class="stk-card stk-shared">
        <div class="stk-card-title">${icon('fa-people-arrows')}Вместе</div>
        ${rows.join('') || `<div class="stk-row stk-muted">${icon('fa-heart')}близости пока не было</div>`}
        ${next ? `<div class="stk-sub">Ближайшее</div>${next}` : ''}
        ${recent.length ? `<div class="stk-sub">Недавно</div>${recent.map(e => `<div class="stk-row">${icon(KIND_ICON[e.kind] ?? 'fa-circle-dot')}<span class="stk-muted">${esc(dateLabel(state, e.day, { day: 'numeric', month: 'short' }))}</span>${esc(e.text)}</div>`).join('')}` : ''}
    </div>`;
}

/** Both of them side by side (one under the other on a phone), then what they share. */
export function renderNow(state, view = {}) {
    const weekday = storyDate(state)?.toLocaleDateString('ru-RU', { weekday: 'long' }) ?? '';
    return `
        <div class="stk-clock"><div><b class="stk-clock-time">${clockText(state.clock.minutes)}</b><span>${esc(shortDate(state, state.clock.day, true))}</span></div><span class="stk-muted">${esc([weekday, timeLabel(state.clock.minutes), state.dateSure ? '' : 'дата пока примерная'].filter(Boolean).join(' · '))}</span></div>
        ${readingLine()}
        ${claimCard(state)}
        <div class="stk-duo">
            ${femaleCard(state, state.people.user, view)}
            ${maleCard(state, state.people.char, view)}
        </div>
        ${sharedCard(state)}`;
}

export function renderToday(state, view) {
    return `${renderNow(state, view)}
        <div class="stk-hint">${icon('fa-circle-info')}Stork сам следит за РП: время, близость, привычки, тесты. Карандаш у имени — поправить данные.</div>`;
}

// #endregion

// #region Calendar

/**
 * The month as a calendar: the next dates, the month with its arrows, the legend. The same in the window and in
 * the infoblock, so both show the one clear calendar.
 */
export function calendarCore(state, view, { upcomingDates = true } = {}) {
    const woman = state.people.user;
    const f = woman.female;
    const { month, grid } = monthGrid(state, view, storyDate(state) ?? new Date());
    // a known pregnancy: the cycle colours are gone from the month, so they leave the legend too
    const pregnant = !!f.pregnancy && knowsPregnancy(woman);
    return `
        ${upcomingDates ? `<div class="stk-card">
            <div class="stk-card-title">${icon('fa-calendar-check')}Ближайшие даты</div>
            ${upcoming(state, woman) || '<div class="stk-muted">пока ничего</div>'}
        </div>` : ''}
        <div class="stk-cal-head">
            <button type="button" class="stk-btn is-ghost" data-stk-act="cal-month" data-d="-1" aria-label="Предыдущий месяц">${icon('fa-chevron-left')}</button>
            <b>${esc(capitalize(month.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })))}</b>
            <button type="button" class="stk-btn is-ghost" data-stk-act="cal-month" data-d="1" aria-label="Следующий месяц">${icon('fa-chevron-right')}</button>
        </div>
        ${grid}
        <div class="stk-legend">
            ${pregnant ? '' : `<span><i class="is-period"></i>месячные</span>
            <span><i class="is-window"></i>фертильные дни</span>
            <span><i class="is-ovulation"></i>овуляция</span>
            <span><i class="is-warm"></i>ПМС</span>`}
            ${pregnant || f.postpartum ? '<span><i class="is-preg"></i>беременность</span>' : ''}
            <span>${icon('fa-heart')}близость</span>
            ${careOf(state).canSeeSex ? `<span>${icon('fa-vial')}тест</span>` : ''}
        </div>
        ${pickBar(state, view)}`;
}

export function renderCalendar(state, view) {
    const f = state.people.user.female;
    const editable = !f.pregnancy && !f.postpartum;
    // the strip of the cycle lives in the infoblock; here the month grid says the same, bigger
    return `
        ${calendarCore(state, view)}
        ${editable ? `<div class="stk-card stk-edit" data-key="user">
            <div class="stk-card-title">${icon('fa-sliders')}Мой цикл</div>
            ${cycleFields(f)}
        </div>` : ''}
        <div class="stk-hint">${icon('fa-circle-info')}${editable ? 'Нажми на прошедший день, чтобы отметить начало месячных. ' : ''}Будущие дни и прошлые циклы показаны как прогноз.</div>`;
}

// #endregion

// #region Pregnancy

/** ISO date of a story day for a date field, or '' when the story has no calendar. */
function isoOfDay(state, day) {
    const d = storyDate(state, day);
    if (!d) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A pregnancy by hand: by the term, by her last period or by the due date. Everything else Stork works out itself.
 * The three ways are radios; CSS shows the fields of the chosen one.
 */
function pregnancyForm(state) {
    const woman = [state.people.user, state.people.char].find(p => p.sex === 'female');
    const man = [state.people.user, state.people.char].find(p => p.sex === 'male');
    if (!woman) return '';
    const p = woman.female.pregnancy;
    const day = state.clock.day;
    const total = p ? day - p.lmp : 42;
    const hasDates = !!state.startDate;
    const mode = (id, label, checked) => `<label class="stk-pf-mode"><input type="radio" name="stk-pf-mode" data-f="mode" value="${id}" ${checked ? 'checked' : ''}><span>${label}</span></label>`;
    return `<div class="stk-card stk-edit stk-preg-form" data-key="preg">
        <div class="stk-card-title">${icon('fa-person-pregnant')}${p ? 'Изменить срок' : 'Указать беременность'}</div>
        <div class="stk-pf-modes" role="radiogroup">
            ${mode('term', 'Срок', true)}
            ${hasDates ? mode('lmp', 'Последние месячные', false) : ''}
            ${hasDates ? mode('due', 'Дата родов', false) : ''}
        </div>
        <div class="stk-claim-term stk-pf-row is-term">
            <span>Срок сейчас</span>
            <input class="text_pole" data-f="weeks" type="number" min="2" max="42" value="${Math.floor(total / 7)}" aria-label="недель"><span>нед.</span>
            <input class="text_pole" data-f="days" type="number" min="0" max="6" value="${total % 7}" aria-label="дней"><span>дн.</span>
        </div>
        ${hasDates ? `<label class="stk-field stk-pf-row is-lmp"><span>Первый день последних месячных</span><input class="text_pole" data-f="lmpDate" type="date" value="${isoOfDay(state, day - total)}"></label>
        <label class="stk-field stk-pf-row is-due"><span>Предполагаемая дата родов</span><input class="text_pole" data-f="dueDate" type="date" value="${isoOfDay(state, day - total + 280)}"></label>` : ''}
        ${man ? `<label class="stk-check"><input type="checkbox" data-f="partnerKnows" ${p?.knownBy.includes(man.key) ? 'checked' : ''}>${esc(nameOf(man))} знает о беременности</label>` : ''}
        <div class="stk-actions">
            <button type="button" class="stk-btn is-primary" data-stk-act="preg-save">${icon('fa-check')}Сохранить</button>
            <button type="button" class="stk-btn is-ghost" data-stk-act="preg-cancel">${icon('fa-xmark')}Отмена</button>
        </div>
    </div>`;
}

export function renderPregnancy(state, view = {}) {
    const woman = [state.people.user, state.people.char].find(p => p.sex === 'female' && p.female.pregnancy && knowsPregnancy(p));
    if (view.pregEdit) return pregnancyForm(state);
    if (!woman) {
        return `${claimCard(state)}<div class="stk-empty">${icon('fa-baby', 'stk-ic-xl')}<div>Беременности пока нет. Или о ней ещё никто не знает: сделай тест.</div>
            <button type="button" class="stk-btn" data-stk-act="preg-edit">${icon('fa-plus')}Указать вручную</button></div>`;
    }
    const p = woman.female.pregnancy;
    const info = pregnancyInfo(p, state.clock.day);
    const due = dateLabel(state, info.dueDay, { day: 'numeric', month: 'long', year: 'numeric' });
    const care = careOf(state);
    return `
        ${claimCard(state)}
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-person-pregnant')}${esc(nameOf(woman))}<button type="button" class="stk-pen" data-stk-act="preg-edit" title="Изменить срок" aria-label="Изменить срок">${icon('fa-pen')}</button></div>
            <div class="stk-big">${info.week} нед. ${info.weekDay} дн.<span class="stk-muted">${info.trimester}-й триместр · до родов ${Math.max(0, info.daysToDue)} дн. (${esc(due)})</span></div>
            <div class="stk-progress"><i style="width:${Math.min(100, Math.round(info.week / 40 * 100))}%"></i></div>
        </div>
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-seedling')}${p.babies > 1 ? 'Малыши' : 'Малыш'}</div>
            <div class="stk-stats">
                <div><b>${info.baby.length} см</b><span>рост</span></div>
                <div><b>${babyWeight(info.baby.weight)}</b><span>вес</span></div>
                <div><b>${esc(info.baby.compare)}</b><span>размером с</span></div>
            </div>
            <div class="stk-row">${icon('fa-wand-sparkles')}${esc(info.baby.develops)}</div>
            <div class="stk-row">${icon('fa-venus-mars')}${p.sexKnown ? esc(p.sexes.join(' и ')) : esc(care.sexUnknown)}</div>
            ${info.kicksFelt ? `<div class="stk-row">${icon('fa-shoe-prints')}толкается</div>` : ''}
        </div>
        <div class="stk-card">
            <div class="stk-card-title">${icon('fa-heart-pulse')}Мама</div>
            <div class="stk-row">живот: ${esc(info.belly)}, +${info.weightGain} кг</div>
            ${info.symptoms.length ? `<div class="stk-row">${esc(info.symptoms.join(', '))}</div>` : ''}
            <div class="stk-row">тянет на ${esc(p.cravings.join(' и '))}, не выносит ${esc(p.aversions.join(', '))}</div>
            ${pregnancyFacts(p)}
        </div>
        <div class="stk-card">
            <div class="stk-card-title">${icon(care.icon)}${care.title}</div>
            ${care.visits.map(v => `<div class="stk-row ${p.visitsDone.includes(v.week) ? '' : 'stk-muted'}">${icon(p.visitsDone.includes(v.week) ? 'fa-circle-check' : 'fa-circle')}${v.week} нед.: ${esc(v.label)}</div>`).join('')}
        </div>`;
}

// #endregion
