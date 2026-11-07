/*
 * Them on screen: who they are to each other, how long they have known each other and been together, and how each
 * feels about children — a few short lines, in the window between her and him, and at the top of the infoblock.
 */
import { esc, icon, nameOf } from './common.js';
import { bondRows, KIDS, REL } from './bond.js';

/** «Нина — не против детей»; a quiet eye-slash when the other one does not know it yet. */
function kidsBits(state) {
    const k = state.kids;
    if (!k) return [];
    return ['user', 'char'].filter(key => k[key]?.view).map(key => {
        const other = key === 'user' ? 'он' : 'она';
        const hidden = !k[key].known;
        return `<span class="stk-them-kid">${esc(nameOf(state.people[key]))}: ${esc(KIDS[k[key].view].ru.replace(/ детей$/, ''))}${hidden ? `<i class="fa-solid fa-eye-slash stk-ic stk-them-hidden" title="${other} пока не знает"></i>` : ''}</span>`;
    });
}

/**
 * Compact, in Stork's look: one line of small chips — the status, known for, together for (only while together) —
 * and under it, smaller, how each feels about children. '' when Stork knows nothing yet.
 */
export function themHtml(state, { card = false } = {}) {
    const chips = bondRows(state).map(r => `<span class="stk-them-chip${r.label === 'Статус' ? ' is-status' : ''}" title="${esc(r.label)}">${icon(r.icon)}${r.label === 'Статус' ? '' : `<span class="stk-them-l">${esc(r.label.toLowerCase())}</span>`}<b>${esc(r.value)}</b></span>`);
    const kids = kidsBits(state);
    if (!chips.length && !kids.length) {
        // a chat Stork set up before it knew this: the window says so and offers to find out now (one reading)
        return card && state.setupDone
            ? `<div class="stk-them-empty"><span class="stk-muted">Кто они друг другу и сколько знакомы — Stork узнает со следующим ответом.</span><button type="button" class="stk-btn is-ghost" data-stk-act="bond-learn">${icon('fa-rotate')}Узнать сейчас</button></div>`
            : '';
    }
    const body = `${chips.length ? `<div class="stk-them-chips">${chips.join('')}</div>` : ''}${kids.length ? `<div class="stk-them-kids">${icon('fa-baby-carriage')}<span>дети —</span>${kids.join('<span class="stk-them-dot">·</span>')}</div>` : ''}`;
    // in the window it sits inside «Вместе»
    if (card) return `<div class="stk-them is-in-card">${body}</div>`;
    // in the infoblock: one quiet line at the bottom — the status, then «знакомы» and «вместе» as words, no boxes
    const rows = bondRows(state);
    const status = rows.find(r => r.label === 'Статус');
    const rest = rows.filter(r => r !== status).map(r => `<span>${esc(r.label.toLowerCase())} <b>${esc(r.value)}</b></span>`);
    const line = [status ? `<b class="stk-tf-status">${esc(status.value)}</b>` : '', ...rest].filter(Boolean).join('<i class="stk-tf-dot">·</i>');
    return `<div class="stk-them-foot">${line ? `<div class="stk-tf-line">${icon('fa-people-arrows', 'stk-tf-ic')}${line}</div>` : ''}${kids.length ? `<div class="stk-tf-kids">${icon('fa-baby-carriage', 'stk-tf-ic')}${kids.join('<i class="stk-tf-dot">·</i>')}</div>` : ''}</div>`;
}

/** «пара», «друзья»: for a folded card's summary. */
export const themStatusWord = state => REL[state.bond?.status]?.ru ?? '';
