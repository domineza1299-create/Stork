/*
 * The intimate scene's block: it sits at the bottom of Stork's infoblock, comes by itself when a scene begins
 * and goes when it is over. The same look as the block above it: she on the left, he on the right.
 * Folded — one line: her readiness (drop) and how close each is (star), the scene's mood and its minutes.
 * Open — her readiness and «до оргазма» as two separate gauges, his «до оргазма», the position with its minutes,
 * the clothes, how private the place is, the risks (protection, contraception, fertile days, the story's own),
 * and the kinks (all of them in the full look, the ones in play lit; in «кратко» only the lit ones). No thoughts here:
 * they only retold the reply. Nothing twice: a pain, an injury and a risk that are one thing are shown once.
 * Text only in spans: some themes underline <em> inside a reply.
 */
import { esc, icon, nameOf } from './common.js';
import { FEMALE_CONTRACEPTION, femaleState, pillState } from './biology.js';
import { maleSnapshot } from './engine.js';
import { bondScore, DYN, injuriesNow, kinkChips, sameThing } from './intimacy.js';
import { kidsKnowledge } from './bond.js';

const OPEN_KEY = 'stork_scene_open';
export const sceneOpen = () => {
    try { return localStorage.getItem(OPEN_KEY) !== '0'; } catch { return true; }
};
export const setSceneOpen = on => {
    try { localStorage.setItem(OPEN_KEY, on ? '1' : '0'); } catch { /* private mode: only for this session */ }
};

const pct = v => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
const capital = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const POSE_TIRES = 12;

/** A gauge with its name and number: «Готовность» (arousal, wetness) and «До оргазма» are two different things. */
function gauge(label, ic, value, kind) {
    return `<span class="stk-ag-gauge is-${kind}"><span class="stk-ag-gauge-l">${icon(ic)}${label}</span><span class="stk-ag-track is-${kind}"><span style="width:${pct(value)}%"></span></span><span class="stk-ag-gauge-v">${pct(value)}%</span></span>`;
}

/** One of them: her readiness and how close each is, a word for how they are, what follows a climax. */
function personHtml(p, her) {
    const after = !her && p.refr > 0 ? `<span class="stk-ag-note">${icon('fa-hourglass-half')}передышка ~${p.refr} мин</span>`
        : her && p.sensitive ? `<span class="stk-ag-note">${icon('fa-bolt')}чувствительна после оргазма</span>` : '';
    return `<div class="stk-ag-person ${her ? 'is-her' : 'is-him'}">
        <span class="stk-ag-pname">${esc(p.name)}${p.org ? `<span class="stk-ag-org" title="оргазмов в этой сцене">${icon('fa-star')}${p.org}</span>` : ''}</span>
        ${her ? gauge('Готовность', 'fa-droplet', p.readiness, 'ready') : ''}
        ${gauge('До оргазма', 'fa-star', p.climax, 'climax')}
        ${p.state ? `<span class="stk-ag-state">${esc(capital(p.state))}</span>` : ''}
        ${after}
    </div>`;
}

/** The position and how long they have been in it: after a while the body starts to tell. */
function poseHtml(sc) {
    if (!sc.pose) return '';
    const min = sc.poseMin ?? 0;
    const long = min >= POSE_TIRES;
    return `<span class="stk-ag-detail${long ? ' is-warm' : ''}" title="${long ? 'долго в одной позе: ноги и колени затекают' : 'текущая поза'}">${icon('fa-person')}<span>${esc(capital(sc.pose))}${min ? ` · ${min} мин` : ''}</span></span>`;
}

/** Risks: protection now, her contraception, her fertile days, and what the story itself shows. */
export function riskChips(state) {
    const sc = state.intim?.scene;
    if (!sc) return [];
    const out = [];
    // risks are red; injuries (healing) stay yellow; her fertile days pink
    const PROT = { none: ['без защиты', 'danger'], condom: ['презерватив', ''], withdrawal: ['прерванный акт', 'danger'] };
    if (PROT[sc.protection]) out.push({ text: PROT[sc.protection][0], tone: PROT[sc.protection][1] });
    const woman = Object.values(state.people ?? {}).find(p => p.sex === 'female');
    const f = woman?.female;
    if (f && !f.pregnancy) {
        const day = state.clock.day;
        const pill = pillState(f, day);
        if (pill.effective !== 'none') {
            const label = FEMALE_CONTRACEPTION[pill.effective]?.label;
            if (label) out.push({ text: label, tone: pill.missed ? 'danger' : '' });
        }
        const s = femaleState(f, day);
        if (s.fertile && !pill.suppressed) out.push({ text: `фертильные дни · ${Math.round(s.chanceToday * 100)}%`, tone: 'pink' });
    }
    for (const r of sc.risks ?? []) out.push({ text: r, tone: 'danger' });
    return out;
}

const PRIVACY = { private: ['наедине', 'fa-door-closed'], semi: ['могут быть рядом люди', 'fa-door-open'], public: ['публичное место', 'fa-people-group'] };
/** How private the place is and the chance someone interrupts: only what the story set up. */
function placeHtml(sc) {
    const pl = sc.place;
    if (!pl || (pl.privacy === 'private' && !pl.interrupt)) return '';
    const [label, ic] = PRIVACY[pl.privacy] ?? PRIVACY.semi;
    return `<span class="stk-ag-detail${pl.interrupt >= 30 ? ' is-warm' : ''}">${icon(ic)}<span>${label}${pl.interrupt ? ` · помешать могут ~${pl.interrupt}%` : ''}${pl.why ? ` — ${esc(pl.why)}` : ''}</span></span>`;
}

/**
 * Each of them on a line: all their kinks, the ones in play glowing softly; one the other does not know yet is dim
 * and dashed. Above them, how well they know each other in bed.
 */
function kinkRows(chips, herName, hisName, bond = null) {
    const rows = [['card', hisName, 'она'], ['persona', herName, 'он']].map(([from, who, other]) => {
        const list = chips.filter(k => (k.from ?? 'card') === from);
        if (!list.length) return '';
        return `<div class="stk-ag-kinkrow"><span class="stk-ag-kwho">${esc(who)}</span><div class="stk-ag-kinks">${list.map(k => `<span class="stk-ag-chip is-kink${k.on ? ' is-on' : ''}${k.known === false ? ' is-unknown' : ''}" title="${k.on ? 'сейчас в сцене' : k.known === false ? `${other} пока не знает` : `${other} знает`}">${esc(k.name)}</span>`).join('')}</div></div>`;
    }).join('');
    return rows;
}

export const BOND_WORD = 'притирка';
const BOND_TITLE = 'Притирка: как хорошо они знают друг друга в постели — что каждый знает о предпочтениях и отношении к детям другого, сколько раз были вместе';

const chipsHtml = (list, cls) => (list.length ? `<div class="stk-ag-kinks ${cls}">${list.join('')}</div>` : '');

/**
 * @param {object} state the state after the latest reply
 * @param {object} o { open, reading, brief }
 * @returns {string} '' when no scene is going on
 */
export function sceneBlockHtml(state, { open = sceneOpen(), reading = false, brief = false } = {}) {
    const sc = state.intim?.scene;
    if (!sc?.visible) return '';
    const her = { ...sc.user, name: nameOf(state.people.user) };
    const him = { ...sc.char, name: nameOf(state.people.char) };
    const dyn = DYN[sc.dyn]?.ru ?? 'Близость';
    // the head: her readiness (drop) and how close she is (star); his closeness
    const nums = (p, isHer) => `${isHer ? `<span title="готовность">${icon('fa-droplet', 'stk-ag-i-ready')}${pct(p.readiness)}</span>` : ''}<span title="до оргазма">${icon('fa-star', 'stk-ag-i-climax')}${pct(p.climax)}%</span>`;
    const side = (p, right, isHer) => `<span class="stk-ag-side${right ? ' is-right' : ''}">
        <span class="stk-ag-who"><b>${esc(p.name)}</b><span class="stk-ag-nums">${nums(p, isHer)}</span></span></span>`;
    // how well they know each other in bed: one number under the scene's mood, not another bar
    const bond = bondScore(state.intim, kidsKnowledge(state));
    const head = `<div class="stk-ag-head" data-stk-act="ag-toggle" role="button" tabindex="0" aria-expanded="${open}" title="${open ? 'Свернуть сцену' : 'Развернуть сцену'}">
        ${side(her, false, state.people.user.sex === 'female')}
        <span class="stk-ag-mid"><b>${reading ? `<span class="stk-ib-mark is-reading">${icon('fa-feather-pointed')}</span>` : icon('fa-fire-flame-curved', 'stk-ag-flame')}${esc(dyn)}</b><span>${sc.minutes} мин · <span class="stk-ag-bond" title="${esc(BOND_TITLE)}">${icon('fa-handshake-simple')}${bond}</span>${icon('fa-chevron-down', 'stk-ag-chev')}</span></span>
        ${side(him, true, state.people.char.sex === 'female')}
    </div>`;
    if (!open) return `<div class="stk-ag">${head}</div>`;

    const details = [poseHtml(sc), sc.clothes ? `<span class="stk-ag-detail">${icon('fa-shirt')}<span>${esc(capital(sc.clothes))}</span></span>` : '', placeHtml(sc)].filter(Boolean).join('');
    // healing injuries: quietly, they matter only where the body meets them
    // what the body feels now wins; the injury behind it and a risk that says the same are not repeated
    const painList = [[her.name, sc.user.discomfort], [him.name, sc.char.discomfort]].filter(([, d]) => d);
    const said = painList.map(([, d]) => d);
    const hurtList = injuriesNow(state).filter(x => !said.some(d => sameThing(d, x.what)));
    said.push(...hurtList.map(x => x.what));
    const riskList = riskChips(state).filter(r => !said.some(d => sameThing(d, r.text)));
    const hurts = hurtList.map(x => `<span class="stk-ag-chip is-risk is-warm" title="заживает">${icon('fa-bandage')}${esc(x.what)} · ${esc(x.name)}</span>`);
    const risks = riskList.map(r => `<span class="stk-ag-chip is-risk${r.tone ? ` is-${r.tone}` : ''}">${esc(r.text)}</span>`);
    const chips = kinkChips(state);
    const pains = painList.map(([who, d]) => `<span class="stk-ag-pain">${icon('fa-triangle-exclamation')}<span>${esc(who)}: ${esc(d)}</span></span>`).join('');

    // «кратко»: both gauges, the position, the risks, the kinks of each (the ones in play glowing)
    if (brief) {
        const notes = [her.sensitive ? `<span class="stk-ag-note">${icon('fa-bolt')}${esc(her.name)}: чувствительна после оргазма</span>` : '', him.refr > 0 ? `<span class="stk-ag-note">${icon('fa-hourglass-half')}${esc(him.name)}: передышка ~${him.refr} мин</span>` : ''].join('');
        return `<div class="stk-ag is-open is-brief">${head}
        <div class="stk-ag-body">
            <div class="stk-ag-pair is-brief">
                <div class="stk-ag-col"><span class="stk-ag-pname">${esc(her.name)}</span>${gauge('Готовность', 'fa-droplet', her.readiness, 'ready')}${gauge('До оргазма', 'fa-star', her.climax, 'climax')}</div>
                <div class="stk-ag-col is-him"><span class="stk-ag-pname">${esc(him.name)}</span>${gauge('До оргазма', 'fa-star', him.climax, 'climax')}</div>
            </div>
            ${notes}
            ${details ? `<div class="stk-ag-details">${details}</div>` : ''}
            ${pains ? `<div class="stk-ag-pains">${pains}</div>` : ''}
            ${chipsHtml([...hurts, ...risks], 'is-risks')}
            ${kinkRows(chips, her.name, him.name)}
        </div>
    </div>`;
    }

    const kinks = kinkRows(chips, her.name, him.name);
    return `<div class="stk-ag is-open">${head}
        <div class="stk-ag-body">
            <div class="stk-ag-pair">${personHtml(her, true)}${personHtml(him, false)}</div>
            ${details ? `<div class="stk-ag-details">${details}</div>` : ''}
            ${pains ? `<div class="stk-ag-pains">${pains}</div>` : ''}
            ${chipsHtml([...hurts, ...risks], 'is-risks')}
            ${kinks}
        </div>
    </div>`;
}

const PACE = { slow: 'неспешно', steady: 'ровно', urgent: 'на взводе' };
/** Hours before this solo since his last release, and how many times today: from his own record. */
function soloFacts(state, man, solo) {
    // his own release in this solo is not «before» it, wherever the reading put its minute
    const all = [...(man.male.orgasms ?? [])].sort((a, b) => a - b);
    if (solo.org > 0 || solo.refr > 0) all.splice(-1, 1);
    const orgasms = all.filter(m => m < solo.start);
    const before = orgasms.length ? Math.max(...orgasms) : null;
    const day = state.clock.day;
    const today = (man.male.orgasms ?? []).filter(m => Math.floor(m / 1440) === day).length;
    return { hoursBefore: before === null ? null : Math.round((solo.start - before) / 60), today };
}
const sinceWord = h => (h >= 48 ? `${Math.floor(h / 24)} дн.` : `${Math.max(1, h)} ч`);

/**
 * Him alone: the same block as a scene with her, in his own colour, only what matters — how close he is,
 * what he does now (it changes, never the same), who is on his mind, a short thought; a few facts of his body.
 * @returns {string} '' when he is not alone with himself
 */
export function soloBlockHtml(state, { open = sceneOpen(), reading = false } = {}) {
    const solo = state.intim?.solo;
    const man = Object.values(state.people ?? {}).find(p => p.sex === 'male');
    if (!solo?.visible || !man) return '';
    const name = nameOf(man);
    const done = solo.refr > 0;
    const head = `<div class="stk-ag-head" data-stk-act="ag-toggle" role="button" tabindex="0" aria-expanded="${open}" title="${open ? 'Свернуть' : 'Развернуть'}">
        <span class="stk-ag-side"><span class="stk-ag-who"><b>${esc(name)}</b><span>наедине · ${solo.minutes} мин</span></span></span>
        <span class="stk-ag-mid"><b>${reading ? `<span class="stk-ib-mark is-reading">${icon('fa-feather-pointed')}</span>` : icon('fa-fire-flame-curved', 'stk-ag-flame')}${done ? 'Разрядка' : esc(PACE[solo.pace] ?? 'Сам с собой')}</b><span>${icon('fa-chevron-down', 'stk-ag-chev')}</span></span>
        <span class="stk-ag-side is-right"><span class="stk-ag-who"><b>${pct(solo.climax)}%</b><span>до разрядки</span></span></span>
    </div>`;
    if (!open) return `<div class="stk-ag is-solo">${head}</div>`;
    const s = maleSnapshot(state, man);
    const f = soloFacts(state, man, solo);
    const facts = [
        f.hoursBefore !== null && solo.turns <= 2 ? `до этого без разрядки ${sinceWord(f.hoursBefore)}` : '',
        f.today > 1 ? `сегодня ${f.today}-й раз` : '',
        `запас ${Math.round(s.reserve * 100)}%`,
    ].filter(Boolean).map(t => `<span class="stk-ag-chip">${esc(t)}</span>`);
    const rows = [
        solo.doing ? `<span class="stk-ag-detail">${icon('fa-hand')}<span>${esc(capital(solo.doing))}</span></span>` : '',
        solo.fantasy ? `<span class="stk-ag-detail">${icon('fa-cloud')}<span>${esc(capital(solo.fantasy))}</span></span>` : '',
        done ? `<span class="stk-ag-detail">${icon('fa-hourglass-half')}<span>передышка ~${solo.refr} мин</span></span>` : '',
        placeHtml(solo),
    ].filter(Boolean).join('');
    return `<div class="stk-ag is-solo is-open">${head}
        <div class="stk-ag-body">
            ${gauge('До разрядки', 'fa-star', solo.climax, 'climax')}
            ${rows ? `<div class="stk-ag-details">${rows}</div>` : ''}
            ${facts.length ? `<div class="stk-ag-kinks is-facts">${facts.join('')}</div>` : ''}
            ${solo.thought ? `<div class="stk-ag-solo-thought">«${esc(solo.thought)}»</div>` : ''}
        </div>
    </div>`;
}
