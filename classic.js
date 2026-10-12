/*
 * The Stork window's look (the wand, /stork): today, calendar and pregnancy, with rings around the avatars.
 * The infoblock in the chat has its own compact look in ui.js; the words, the numbers and the editors
 * both use come from common.js, the buttons from handleAction in ui.js.
 */
import { cycleInfo, DOCTOR_VISITS, FEMALE_CONTRACEPTION, femaleState, laborProgress, pillState, pregnancyInfo } from './biology.js';
import { absMinute, dateLabel, liveNow, storyDate, timeLabel, withLive } from './engine.js';
import {
    ACT_LABEL, agoWord, avatarUrl, babyWeight, capitalize, clamp01, cycleFields, cycleStrip, esc, femaleLevels, femaleTraits, icon, initials, KIND_ICON, knowsPregnancy,
    levelWord, maleLevels, monthGrid, nameOf, nextInCycle, personFields, pickBar, pregnancyLibidoWhy, readingLine, recentEvents, riskyLately, upcomingRows,
    upcomingWhen, years,
} from './common.js';

// #region Rings around the avatars

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
        return `<div class="stk-card is-alert">${head}
            <div class="stk-person">${ringsHtml([{ value: progress.progress, tone: 'preg' }], person.key, nameOf(person))}
                <div class="stk-legend-col">${legendRow('preg', 'Роды', progress.label, `схватки каждые ${progress.intervalMinutes} мин${progress.waterBroken ? ', воды отошли' : ''}`)}</div></div>
            ${storyNote(state, person.key)}</div>`;
    }
    if (f.pregnancy && knowsPregnancy(person)) {
        const info = pregnancyInfo(f.pregnancy, day);
        const live = liveNow(state, person.key);
        const libido = withLive(info.libido, live.libido);
        return `<div class="stk-card">${head}
            <div class="stk-person">${ringsHtml([{ value: info.week / 40, tone: 'preg' }, { value: libido, tone: 'pink' }], person.key, nameOf(person))}
                <div class="stk-legend-col">
                    ${legendRow('preg', 'Срок', `${info.week} нед. ${info.weekDay} дн.`, `${info.trimester}-й триместр · до родов ${Math.max(0, info.daysToDue)} дн.`)}
                    ${legendRow('pink', 'Влечение', levelWord(libido), pregnancyLibidoWhy(info))}
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
    const traits = femaleTraits(f);
    const { libido, energy, libidoWhy, energyWhy } = femaleLevels(state, person, s);
    const phaseText = pill.suppressed && ['ovulation', 'follicular'].includes(s.phase) ? 'овуляции нет' : s.phaseLabel;
    // its own colour for the cycle ring: it does not merge with desire (pink) and energy (accent)
    const tone = { menstruation: 'period', pms: 'warm' }[s.phase] ?? 'preg';
    return `<div class="stk-card">${head}
        <div class="stk-person">
            ${ringsHtml([{ value: s.cycleDay / s.length, tone }, { value: libido, tone: 'pink' }, { value: energy, tone: 'accent' }], person.key, nameOf(person))}
            <div class="stk-legend-col">
                ${legendRow(tone, 'Цикл', phaseText, `день ${s.cycleDay} из ${s.length} · ${nextInCycle(s, pill.suppressed)}`)}
                ${legendRow('pink', 'Влечение', levelWord(libido), libidoWhy)}
                ${legendRow('accent', 'Энергия', levelWord(energy), energyWhy)}
            </div>
        </div>
        ${s.fertile && !pill.suppressed ? `<div class="stk-row stk-fertile">${icon('fa-heart')}фертильные дни · шанс зачатия сегодня ${Math.round(s.chanceToday * 100)}%</div>` : ''}
        <div class="stk-row">${icon('fa-heart-pulse')}${esc(s.symptoms.join(', '))}</div>
        ${storyNote(state, person.key)}
        <div class="stk-row stk-muted">${icon('fa-shield-halved')}контрацепция: ${esc(FEMALE_CONTRACEPTION[pill.effective]?.label ?? 'нет')}${traits.length ? ` · ${esc(traits.join(', '))}` : ''}</div>
    </div>`;
}

export function maleCard(state, person, view = {}) {
    if (view.editPerson === person.key) return personEditor(state, person.key);
    const L = maleLevels(state, person);
    const s = L.s;
    const fresh = [...new Set(s.recent.filter(e => e.daysAgo <= 1).map(e => `${e.daysAgo ? 'вчера' : 'сегодня'}: ${e.label}`))];
    return `<div class="stk-card">
        <div class="stk-card-title">${icon('fa-mars')}${esc(nameOf(person))}<span class="stk-muted">${years(person.age)}</span>${pencil(person.key)}</div>
        <div class="stk-person">
            ${ringsHtml([{ value: L.vigor, tone: 'accent' }, { value: L.libido, tone: 'pink' }, { value: s.erection, tone: 'warm' }], person.key, nameOf(person))}
            <div class="stk-legend-col">
                ${legendRow('accent', 'Бодрость', L.vigorWord, L.vigorWhy)}
                ${legendRow('pink', 'Влечение', levelWord(L.libido), L.libidoWhy)}
                ${legendRow('warm', 'Эрекция', L.erectionOk ? 'в порядке' : 'может подвести', L.erectionOk ? '' : L.erectionWhy)}
            </div>
        </div>
        ${L.left > 0 ? `<div class="stk-row stk-recover">${icon('fa-hourglass-half')}восстанавливается после оргазма: ещё ~${L.left} мин по времени истории</div>` : ''}
        ${storyNote(state, person.key)}
        <div class="stk-sub">Сперма</div>
        <div class="stk-sperm">
            <div>${miniRing('pink', s.countNow / 100, `${s.countNow}%`)}<div><b>Количество</b><small>${esc(L.countWhy || 'в норме')}</small></div></div>
            <div>${miniRing('pink', s.motility / 100, `${s.motility}%`)}<div><b>Подвижность</b><small>${esc(L.motilityWhy)}</small></div></div>
            <div>${miniRing('accent', s.reserve, `${Math.round(s.reserve * 100)}%`)}<div><b>Запас</b><small>${esc(L.reserveWhy)}</small></div></div>
        </div>
        ${fresh.length ? `<div class="stk-row">${icon('fa-wine-glass')}${esc(fresh.join(', '))}</div>` : ''}
        ${s.vasectomy ? `<div class="stk-row">${icon('fa-scissors')}вазэктомия: ${esc(s.vasectomy)}</div>` : ''}
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

export function renderToday(state, view) {
    return `${renderNow(state, view)}
        <div class="stk-hint">${icon('fa-circle-info')}Stork сам следит за РП: время, близость, привычки, тесты. Карандаш у имени — поправить данные.</div>`;
}

// #endregion

// #region Calendar

export function renderCalendar(state, view) {
    const woman = state.people.user;
    const f = woman.female;
    const editable = !f.pregnancy && !f.postpartum;
    const { month, grid } = monthGrid(state, view, storyDate(state) ?? new Date());
    return `
        ${editable ? `<div class="stk-card">
            <div class="stk-card-title">${icon('fa-arrows-spin')}Цикл ${esc(nameOf(woman))}<span class="stk-muted">день ${cycleInfo(f, state.clock.day).cycleDay}</span></div>
            ${cycleStrip(f, state.clock.day, { titles: true })}
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
        ${grid}
        <div class="stk-legend">
            <span><i class="is-period"></i>месячные</span>
            <span><i class="is-window"></i>фертильные дни</span>
            <span><i class="is-ovulation"></i>овуляция</span>
                <span><i class="is-warm"></i>ПМС</span>
            <span><i class="is-preg"></i>беременность</span>
            <span>${icon('fa-heart')}близость</span>
            <span>${icon('fa-vial')}тест</span>
        </div>
        ${pickBar(state, view)}
        ${editable ? `<div class="stk-card stk-edit" data-key="user">
            <div class="stk-card-title">${icon('fa-sliders')}Мой цикл</div>
            ${cycleFields(f)}
        </div>` : ''}
        <div class="stk-hint">${icon('fa-circle-info')}${editable ? 'Нажми на прошедший день, чтобы отметить начало месячных. ' : ''}Будущие дни и прошлые циклы показаны как прогноз.</div>`;
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
                <div><b>${babyWeight(info.baby.weight)}</b><span>вес</span></div>
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
