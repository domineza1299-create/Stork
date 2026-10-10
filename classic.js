/*
 * The Stork window (the wand, /stork): the classic look with rings around the avatars.
 * The infoblock in the chat has its own compact design in ui.js; both share the data, the editors' logic and handleAction.
 */
import {
    cycleInfo, DOCTOR_VISITS, FEMALE_CONDITIONS, FEMALE_CONTRACEPTION, femaleState, laborProgress, MALE_FERTILITY, pillState, pregnancyInfo,
} from './biology.js';
import { absMinute, dateLabel, liveNow, maleSnapshot, recoveryLeft, storyDate, timeLabel, withLive } from './engine.js';
import {
    ACT_LABEL, avatarUrl, capitalize, clamp01, esc, hoursWord, icon, initials, joinWhy, KIND_ICON, knowsPregnancy, levelWord, nameOf,
    nextInCycle, PHASE_TONE, readingLine, storyWhy, years,
} from './ui.js';

// #region Today

// #region Rings around the avatars (the window keeps them)

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
