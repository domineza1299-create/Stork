/*
 * The intimate scene's block: it sits at the bottom of Stork's infoblock, comes by itself when a scene begins
 * and goes when it is over. The same look as the block above it: she on the left, he on the right.
 * Folded — one line: how close each of them is, the scene's mood and its minutes between them.
 * Open — the two of them side by side (how close, her readiness, a word for how each is, his rest after a climax,
 * her sensitivity), the position and the clothes, his thought, and every kink of the card and the persona as chips.
 * Text only in spans: some themes underline <em> inside a reply.
 */
import { esc, icon, nameOf } from './common.js';
import { DYN, kinkChips } from './intimacy.js';

const OPEN_KEY = 'stork_scene_open';
export const sceneOpen = () => {
    try { return localStorage.getItem(OPEN_KEY) !== '0'; } catch { return true; }
};
export const setSceneOpen = on => {
    try { localStorage.setItem(OPEN_KEY, on ? '1' : '0'); } catch { /* private mode: only for this session */ }
};

const pct = v => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
const capital = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** One of them: how close, her readiness, a word for how they are, what follows a climax. */
function personHtml(p, her) {
    const climax = pct(p.climax);
    const after = !her && p.refr > 0 ? `<span class="stk-ag-note">${icon('fa-hourglass-half')}передышка ~${p.refr} мин</span>`
        : her && p.sensitive ? `<span class="stk-ag-note">${icon('fa-bolt')}чувствительна после оргазма</span>` : '';
    return `<div class="stk-ag-person ${her ? 'is-her' : 'is-him'}">
        <span class="stk-ag-pname">${esc(p.name)}${p.org ? `<span class="stk-ag-org" title="оргазмов в этой сцене">${icon('fa-star')}${p.org}</span>` : ''}</span>
        <span class="stk-ag-big">${climax}<span class="stk-ag-unit">%</span><span class="stk-ag-cap">до оргазма</span></span>
        <span class="stk-ag-track is-climax"><span style="width:${climax}%"></span></span>
        ${her ? `<span class="stk-ag-ready"><span class="stk-ag-ready-l">${icon('fa-droplet')}готова</span><span class="stk-ag-track is-ready"><span style="width:${pct(p.readiness)}%"></span></span><span class="stk-ag-ready-v">${pct(p.readiness)}%</span></span>` : ''}
        ${p.state ? `<span class="stk-ag-state">${esc(capital(p.state))}</span>` : ''}
        ${after}
    </div>`;
}

/**
 * @param {object} state the state after the latest reply
 * @param {object} o { open, reading }
 * @returns {string} '' when no scene is going on
 */
export function sceneBlockHtml(state, { open = sceneOpen(), reading = false, brief = false } = {}) {
    const sc = state.intim?.scene;
    if (!sc?.visible) return '';
    const her = { ...sc.user, name: nameOf(state.people.user) };
    const him = { ...sc.char, name: nameOf(state.people.char) };
    const dyn = DYN[sc.dyn]?.ru ?? 'Близость';
    const side = (p, right) => `<span class="stk-ag-side${right ? ' is-right' : ''}">
        <span class="stk-ag-who"><b>${esc(p.name)}</b><span>${right ? '' : '<span class="stk-ag-dot"></span>'}${pct(p.climax)}%${right ? '<span class="stk-ag-dot"></span>' : ''}</span></span></span>`;
    const head = `<div class="stk-ag-head" data-stk-act="ag-toggle" role="button" tabindex="0" aria-expanded="${open}" title="${open ? 'Свернуть сцену' : 'Развернуть сцену'}">
        ${side(her, false)}
        <span class="stk-ag-mid"><b>${reading ? `<span class="stk-ib-mark is-reading">${icon('fa-feather-pointed')}</span>` : icon('fa-fire-flame-curved', 'stk-ag-flame')}${esc(dyn)}</b><span>${sc.minutes} мин${icon('fa-chevron-down', 'stk-ag-chev')}</span></span>
        ${side(him, true)}
    </div>`;
    if (!open) return `<div class="stk-ag">${head}</div>`;
    // «кратко»: her readiness and his thought; the rest of the scene is in the full look
    if (brief) {
        return `<div class="stk-ag is-open is-brief">${head}
        <div class="stk-ag-body">
            <span class="stk-ag-ready"><span class="stk-ag-ready-l">${icon('fa-droplet')}${esc(her.name)} готова</span><span class="stk-ag-track is-ready"><span style="width:${pct(her.readiness)}%"></span></span><span class="stk-ag-ready-v">${pct(her.readiness)}%</span></span>
            ${[her.sensitive ? `<span class="stk-ag-note">${icon('fa-bolt')}${esc(her.name)}: чувствительна после оргазма</span>` : '', him.refr > 0 ? `<span class="stk-ag-note">${icon('fa-hourglass-half')}${esc(him.name)}: передышка ~${him.refr} мин</span>` : ''].join('')}
            ${sc.char.thought ? `<div class="stk-ag-thought"><span class="stk-ag-quote">«${esc(sc.char.thought)}»</span><span class="stk-ag-whose">${esc(him.name)}, про себя</span></div>` : ''}
        </div>
    </div>`;
    }

    const details = [['fa-person', sc.pose], ['fa-shirt', sc.clothes]].filter(([, v]) => v)
        .map(([ic, v]) => `<span class="stk-ag-detail">${icon(ic)}<span>${esc(capital(v))}</span></span>`).join('');
    const thought = sc.char.thought ? `<div class="stk-ag-thought"><span class="stk-ag-quote">«${esc(sc.char.thought)}»</span><span class="stk-ag-whose">${esc(him.name)}, про себя</span></div>` : '';
    const chips = kinkChips(state);
    const kinks = chips.length ? `<div class="stk-ag-kinks">${chips.map(k => `<span class="stk-ag-chip${k.on ? ' is-on' : ''}" title="${k.on ? 'сейчас в сцене' : 'из карточки или персоны'}">${esc(k.name)}</span>`).join('')}</div>` : '';
    const pains = [[her.name, sc.user.discomfort], [him.name, sc.char.discomfort]].filter(([, d]) => d)
        .map(([who, d]) => `<span class="stk-ag-pain">${icon('fa-triangle-exclamation')}<span>${esc(who)}: ${esc(d)}</span></span>`).join('');
    return `<div class="stk-ag is-open">${head}
        <div class="stk-ag-body">
            <div class="stk-ag-pair">${personHtml(her, true)}${personHtml(him, false)}</div>
            ${details ? `<div class="stk-ag-details">${details}</div>` : ''}
            ${pains ? `<div class="stk-ag-pains">${pains}</div>` : ''}
            ${thought}
            ${kinks}
        </div>
    </div>`;
}
