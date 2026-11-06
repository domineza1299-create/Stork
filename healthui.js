/*
 * Health on screen: the «Здоровье» tab of the window (and of the full infoblock) and the few lines of the brief
 * infoblock. Stork's look: cards, chips, Font Awesome. The brief shows only what matters now.
 */
import { esc, icon, nameOf } from './common.js';
import { activeInjuries } from './engine.js';
import { activeIll, DAY_MIN, diseaseInfo, forecast, stageOf, STAGES } from './health.js';
import { realism } from './biology.js';

const TREND = { worsening: ['ухудшается', 'is-warm'], improving: ['на поправку', 'is-good'], onset: ['началась', ''], stable: ['стабильно', ''] };
const stageIdx = ill => Math.max(0, STAGES.indexOf(stageOf(ill.severity)));
const days = n => `${n} дн.`;
const now = state => state.clock.day * DAY_MIN + state.clock.minutes;

function stageChip(ill) {
    const i = stageIdx(ill);
    return `<span class="stk-hl-stage is-s${i}">${esc(stageOf(ill.severity).name)}</span>`;
}

function forecastText(p, ill, state) {
    const f = forecast(p, ill, now(state), realism.healthSpeed);
    if (f.dir === 'recover') return [`пройдёт через ~${days(f.days)}`, 'is-good'];
    if (f.dir === 'remission') return [`до ремиссии ~${days(f.days)}`, 'is-good'];
    if (f.dir === 'worsen') return [`до критической ~${days(f.days)}`, 'is-warm'];
    return ['', ''];
}

/** One illness: the name, the stage, how it goes, the diagnosis, what treats it; the reference folded away. */
function illnessHtml(state, key, p, ill, { tools = true } = {}) {
    const [trend, trendTone] = TREND[ill.trend] ?? TREND.stable;
    const [fc, fcTone] = forecastText(p, ill, state);
    const since = Math.max(0, Math.round((now(state) - ill.start) / DAY_MIN));
    const meds = p.meds.filter(m => m.forId === ill.id).map(m => m.name);
    const diag = ill.diag.status === 'diagnosed' ? `диагноз: «${esc(ill.diag.told || ill.name)}»`
        : ill.diag.status === 'misdiagnosed' ? `<span class="is-warm" title="Врач ошибся: на самом деле «${esc(ill.name)}». Персонажи этого не знают.">диагноз ошибочный: «${esc(ill.diag.told)}»</span>`
            : '<span class="stk-muted">без диагноза</span>';
    const info = diseaseInfo(ill.name);
    const about = ill.about || info?.about;
    const care = ill.care?.length ? ill.care : info?.care;
    const hint = ill.medsHint?.length ? ill.medsHint : info?.meds;
    const typical = info?.days ? `обычно ${info.days[0]}–${info.days[1]} дн.` : info?.days === null || ill.chronic ? 'хроническое' : '';
    const ref = about || care?.length || hint?.length ? `<details class="stk-hl-ref"><summary>${icon('fa-circle-info')}справка</summary>
        ${about ? `<div>${esc(about)}${typical ? ` <span class="stk-muted">${esc(typical)}</span>` : ''}</div>` : ''}
        ${care?.length ? `<div><b>Что делать:</b> ${esc(care.slice(0, 2).join(' · '))}</div>` : ''}
        ${hint?.length ? `<div><b>Лечение:</b> ${esc(hint.slice(0, 2).join(' · '))}</div>` : ''}
    </details>` : '';
    const buttons = tools ? `<span class="stk-hl-tools">
        <button type="button" class="stk-pen" data-stk-act="health-cure" data-who="${key}" data-id="${esc(ill.id)}" title="${ill.chronic ? 'В ремиссию' : 'Вылечена'}" aria-label="Вылечена">${icon('fa-check')}</button>
        <button type="button" class="stk-pen" data-stk-act="health-del" data-who="${key}" data-id="${esc(ill.id)}" title="Убрать: этого не было" aria-label="Убрать">${icon('fa-trash-can')}</button>
    </span>` : '';
    return `<div class="stk-hl-ill is-s${stageIdx(ill)}">
        <div class="stk-hl-head">${icon(ill.type === 'mental' ? 'fa-brain' : 'fa-virus')}<b>${esc(ill.name)}</b>${ill.chronic ? '<span class="stk-hl-chip">хрон.</span>' : ''}${stageChip(ill)}${buttons}</div>
        <div class="stk-hl-meta">
            <span>${days(since)}</span>
            <span class="${trendTone}">${trend}</span>
            ${fc ? `<span class="${fcTone}">${fc}</span>` : ''}
            <span>${diag}</span>
            <span>${meds.length ? icon('fa-pills') + esc(meds.join(', ')) : '<span class="stk-muted">не лечится</span>'}</span>
            ${ill.severity >= 75 && !p.hospital ? '<span class="is-crit">нужна больница</span>' : ''}
        </div>
        ${ref}
    </div>`;
}

function medHtml(key, m, { tools = true } = {}) {
    const sub = [
        m.missed >= 2 ? `<span class="is-warm">пропуски ${m.missed} дн.</span>` : '',
        m.side.length ? `побочно: ${esc(m.side.join(', '))}` : '',
        m.interaction ? esc(m.interaction) : '',
    ].filter(Boolean);
    return `<div class="stk-hl-med">
        <div class="stk-hl-head">${icon('fa-pills')}<b>${esc(m.name)}</b><span class="stk-muted">${esc(m.schedule)} · ещё ~${days(Math.max(1, Math.round(m.left)))}</span>
            ${tools ? `<span class="stk-hl-tools"><button type="button" class="stk-pen" data-stk-act="health-medstop" data-who="${key}" data-id="${esc(m.id)}" title="Отменить" aria-label="Отменить">${icon('fa-xmark')}</button></span>` : ''}</div>
        ${sub.length ? `<div class="stk-hl-meta">${sub.map(x => `<span>${x}</span>`).join('')}</div>` : ''}
    </div>`;
}

/** One of them: illnesses, medicines, injuries healing, remission, a visit, predispositions. '' when nothing. */
function personHealth(state, key, opts) {
    const p = state.health?.[key];
    const person = state.people[key];
    const hurts = activeInjuries(state).filter(i => i.who === key);
    const act = p ? activeIll(p) : [];
    const rem = p ? p.ill.filter(i => i.remission) : [];
    const gens = p ? p.genetics.filter(g => !g.shown) : [];
    const visit = p?.nextVisit;
    if (!act.length && !rem.length && !(p?.meds.length) && !gens.length && !p?.hospital && visit == null && !hurts.length) return '';
    const day = state.clock.day;
    const extra = [
        p?.hospital ? `<span class="is-crit">${icon('fa-hospital')}в больнице</span>` : '',
        rem.length ? `<span>${icon('fa-leaf')}ремиссия: ${esc(rem.map(i => i.name).join(', '))}</span>` : '',
        visit != null ? `<span class="${visit <= day ? 'is-warm' : ''}">${icon('fa-user-doctor')}к врачу: ${visit <= day ? 'пора' : `через ${days(visit - day)}`}</span>` : '',
        gens.length ? `<span>${icon('fa-dna')}предрасположенность: ${esc(gens.map(g => `${g.name} ${g.risk}%`).join(', '))}</span>` : '',
        ...hurts.map(i => `<span class="is-warm">${icon('fa-bandage')}${esc(i.what)}</span>`),
    ].filter(Boolean);
    return `<div class="stk-card stk-hl-person">
        <div class="stk-card-title">${icon(key === 'user' ? 'fa-venus' : 'fa-mars')}${esc(nameOf(person))}</div>
        ${act.map(ill => illnessHtml(state, key, p, ill, opts)).join('')}
        ${(p?.meds ?? []).map(m => medHtml(key, m, opts)).join('')}
        ${extra.length ? `<div class="stk-hl-extra">${extra.join('')}</div>` : ''}
    </div>`;
}

/** The «Здоровье» tab: both of them; «здоровы» when there is nothing. */
export function healthHtml(state, opts = {}) {
    const cards = ['user', 'char'].map(k => personHealth(state, k, opts)).filter(Boolean);
    return cards.length ? cards.join('') : `<div class="stk-empty">${icon('fa-heart-pulse', 'stk-ic-xl')}<div>Оба здоровы. Если в истории кто-то заболеет, Stork начнёт вести болезнь сам.</div></div>`;
}

/**
 * The brief infoblock: only what matters now — an illness that is moderate or worse, or getting worse; a missed
 * medicine; a hospital; a doctor due. One short line each.
 */
export function healthBriefRows(state, li) {
    if (!realism.health || !state.health) return [];
    const rows = [];
    const day = state.clock.day;
    for (const key of ['user', 'char']) {
        const p = state.health[key];
        if (!p) continue;
        const name = nameOf(state.people[key]);
        for (const ill of activeIll(p)) {
            if (ill.severity < 25 && ill.trend !== 'worsening' && ill.trend !== 'onset') continue;
            const [trend] = TREND[ill.trend] ?? TREND.stable;
            const meds = p.meds.some(m => m.forId === ill.id);
            rows.push(li(ill.type === 'mental' ? 'fa-brain' : 'fa-virus', `${esc(name)} · <b>${esc(ill.name)}</b> — ${esc(stageOf(ill.severity).name)}, ${trend}${meds ? '' : ', не лечится'}`, ill.severity >= 50 ? 'is-warm' : 'is-muted'));
        }
        const missed = p.meds.filter(m => m.missed >= 2);
        if (missed.length) rows.push(li('fa-pills', `${esc(name)}: пропускает ${esc(missed.map(m => m.name).join(', '))}`, 'is-warm'));
        if (p.hospital) rows.push(li('fa-hospital', `${esc(name)} в больнице${p.hospital.ready ? ' · можно выписывать' : ''}`, 'is-warm'));
        if (p.nextVisit != null && p.nextVisit <= day) rows.push(li('fa-user-doctor', `${esc(name)}: пора к врачу`, 'is-muted'));
    }
    return rows;
}
