/*
 * The infoblock inside the chat: under (or above, or in the middle of) the latest reply.
 * Folded — one symmetric line: she on the left, he on the right, the date and time between them.
 * Open — tabs «Сейчас» (a pregnancy opens it) and «Календарь»; every panel inside folds on its own.
 * Other extensions re-render the reply text and wipe foreign nodes: the block comes back in the same tick.
 */
import { getContext } from '../../../extensions.js';
import { activeIn, currentState, readStatus, settings } from './store.js';
import { applyAutoFolds, blockHeadHtml, handleAction, onKeyActivate, renderCalendar, renderNow } from './ui.js';

const OPEN_KEY = 'stork_block_open';
/** The one infoblock and its view: tab, editing, picked day — survive re-renders. */
let node = null;
let nodeId = null;
let lastHtml = '';
const view = { tab: 'now', monthOffset: 0, editPerson: null, pickDay: null };

const position = () => (['top', 'middle'].includes(settings().blockPosition) ? settings().blockPosition : 'bottom');
const isOpen = () => {
    try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
};
const setOpen = on => {
    try { localStorage.setItem(OPEN_KEY, on ? '1' : '0'); } catch { /* private mode: only for this session */ }
};
const getMesEl = id => document.querySelector(`#chat .mes[mesid="${id}"]`);

/** The latest reply of the bot after the user's first message: the block lives there. */
function targetIndex() {
    const chat = getContext().chat ?? [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        if (m.is_user) return null;          // the user wrote last: the block waits for the reply
        return chat.slice(0, i).some(x => x?.is_user) ? i : null;
    }
    return null;
}

// #region Where the reply text ends (from Hearthtide)

const TAIL_TAGS = /^(IMG|VIDEO|AUDIO|IFRAME|PICTURE|FIGURE|CANVAS|SVG|OBJECT|EMBED|BR|HR|STYLE|SCRIPT|TEMPLATE|LINK|META|BUTTON|INPUT|TEXTAREA|SELECT)$/;
const BOX_TAGS = /^(DIV|SECTION|ASIDE|DETAILS|FORM|NAV)$/;
const isOurs = n => n.nodeType === 1 && n.classList.contains('stk-ib');
/**
 * Infoblocks of sister extensions (Hearthtide) want the same spot right after the text.
 * Stork lines up after them instead of fighting: two blocks each pushing in front of the other
 * would move each other forever and freeze the page.
 */
const SISTER = '.ht-ib, .ht-cards';
const isSister = n => n.nodeType === 1 && !!n.matches?.(SISTER);
const isBlank = n => n.nodeType === 8 || (n.nodeType === 3 && !n.textContent.trim());
function hasText(n) {
    if (n.nodeType === 3) return !!n.textContent.trim();
    if (n.nodeType !== 1 || isOurs(n) || isSister(n) || TAIL_TAGS.test(String(n.tagName).toUpperCase())) return false;
    return !!n.textContent.trim();
}
// someone else's block: a container with a class or an id — the reply's own markup has none
const foreignBox = n => n.nodeType === 1 && BOX_TAGS.test(String(n.tagName).toUpperCase()) && !!(n.className || n.id);
function textEnd(text) {
    const nodes = [...text.childNodes];
    for (let i = nodes.length - 1; i >= 0; i--) if (hasText(nodes[i]) && !foreignBox(nodes[i])) return nodes[i];
    for (let i = nodes.length - 1; i >= 0; i--) if (hasText(nodes[i])) return nodes[i];
    return null;
}
/** The sister blocks right after ref: Stork goes behind them. */
function pastSisters(ref) {
    let last = ref;
    for (let n = ref.nextSibling; n && (isBlank(n) || isSister(n)); n = n.nextSibling) if (isSister(n)) last = n;
    return last;
}
const putAfter = (ref, el) => {
    const at = pastSisters(ref);
    if (at.nextSibling !== el && at !== el) at.parentNode.insertBefore(el, at.nextSibling);
};
/** Already right after the text (sister blocks between are fine): do not move it, or it jumps while pictures load. */
function settled(el) {
    if (!el.isConnected) return false;
    let p = el.previousSibling;
    while (p && (isBlank(p) || isSister(p))) p = p.previousSibling;
    return !!p && hasText(p) && !foreignBox(p) && !p.classList?.contains('mes_text');
}
/** On top: right before the text, with only sister blocks between. */
function settledTop(el, text) {
    if (el.parentNode !== text.parentNode) return false;
    let n = el.nextSibling;
    while (n && (isBlank(n) || isSister(n))) n = n.nextSibling;
    return n === text;
}
let placedAt = null;
function place(mesEl, el) {
    const text = mesEl.querySelector('.mes_text');
    if (!text) return false;
    const pos = position();
    // the position was changed in the settings: move it even if it sits «right» for the old one
    if (placedAt !== pos) el.remove();
    placedAt = pos;
    if (pos === 'top') {
        if (!settledTop(el, text)) text.insertAdjacentElement('beforebegin', el);
    } else if (pos === 'middle') {
        if (!(el.parentNode === text && settled(el))) {
            const parts = [...text.children].filter(x => !isOurs(x) && hasText(x) && !foreignBox(x));
            if (parts.length >= 2) putAfter(parts[Math.ceil(parts.length / 2) - 1], el);
            else putAfter(textEnd(text) || text, el);
        }
    } else if (!(mesEl.contains(el) && settled(el))) {
        putAfter(textEnd(text) || text, el);
    }
    return true;
}

// #endregion

// #region Render

function bodyHtml(state) {
    // a pregnancy has no tab of its own: it opens «Сейчас», first thing
    const tabs = [['now', 'fa-sun', 'Сейчас'], ['calendar', 'fa-calendar-days', 'Календарь']];
    if (!tabs.some(([id]) => id === view.tab)) view.tab = 'now';
    const panel = view.tab === 'calendar' ? renderCalendar(state, view) : renderNow(state, view);
    return `<nav class="stk-tabs">${tabs.map(([id, ic, label]) => `<button type="button" class="stk-tab${view.tab === id ? ' is-on' : ''}" data-stk-act="tab" data-tab="${id}"><i class="fa-solid ${ic} stk-ic"></i><span>${label}</span></button>`).join('')}</nav>
        <div class="stk-panel">${panel}</div>
        <div class="stk-ib-foot">
            <button type="button" class="stk-link" data-stk-act="open-window" data-tab="today"><i class="fa-solid fa-dove stk-ic"></i>Открыть Stork</button>
            <button type="button" class="stk-link" data-stk-act="open-window" data-tab="settings"><i class="fa-solid fa-sliders stk-ic"></i>Вид и плашки</button>
        </div>`;
}

let renderTimer = null;
let autoStamp = null;
export function scheduleBlocks() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => renderBlocks(), 40);
}

/** Draws (or removes) the infoblock. force: even while she is typing in its form. */
export function renderBlocks(force = false) {
    const state = currentState();
    const id = !settings().showBlock || !activeIn(state) ? null : targetIndex();
    const mesEl = id === null ? null : getMesEl(id);
    if (!mesEl) {
        node?.remove();
        node = null;
        nodeId = null;
        lastHtml = '';
        return;
    }
    // she is typing in the block's form: a background update must not wipe it
    if (!force && node?.isConnected && nodeId === id && node.contains(document.activeElement) && document.activeElement.closest?.('.stk-edit')) return;
    if (nodeId !== id) {
        node?.remove();
        node = null;
        view.editPerson = null;
        view.pickDay = null;
    }
    // a new reply (or the automatic setting just changed): start folded or open, as she chose
    const stamp = `${id}|${settings().blockOpen}|${settings().blockFolds}`;
    if (stamp !== autoStamp) {
        autoStamp = stamp;
        if (settings().blockOpen === 'open' || settings().blockOpen === 'closed') setOpen(settings().blockOpen === 'open');
        applyAutoFolds();
    }
    if (!node) {
        node = document.createElement('div');
        node.className = 'stk stk-ib';
        bind(node);
        lastHtml = '';
    }
    nodeId = id;
    if (!place(mesEl, node)) return;
    const open = isOpen();
    const reading = readStatus().index !== null;
    node.classList.toggle('is-open', open);
    node.classList.toggle('is-reading', reading);
    node.classList.toggle('is-failed', !!readStatus().failed);
    // the same markup is not set again: running animations are not restarted
    const html = blockHeadHtml(state, open, reading) + (open ? `<div class="stk-ib-body">${bodyHtml(state)}</div>` : '');
    if (html !== lastHtml) {
        node.innerHTML = html;
        lastHtml = html;
    }
}

function bind(el) {
    el.addEventListener('click', event => {
        const target = event.target.closest('[data-stk-act]');
        if (!target || !el.contains(target)) return;
        // the chat's own handlers (swipes, editing the message) must not see clicks inside the block
        event.stopPropagation();
        if (target.dataset.stkAct === 'block-toggle') {
            setOpen(!isOpen());
            renderBlocks(true);
            return;
        }
        handleAction(target, view, () => renderBlocks(true));
    });
    el.addEventListener('keydown', onKeyActivate);
}

// #endregion

// #region Coming back when someone wipes it

let observer = null;
const MAX_MOVES = 150;         // reactions per second: a re-render or streaming needs a few dozen, a fight needs thousands
let moves = 0;
let movesTimer = null;
let cooling = false;
/** SillyTavern and other extensions re-render the reply text: put the block back in the same tick, before paint. */
export function watchChat(tries = 0) {
    const chatEl = document.getElementById('chat');
    if (!chatEl) {
        if (tries < 60) setTimeout(() => watchChat(tries + 1), 500);
        return;
    }
    if (observer) return;
    observer = new MutationObserver(mutations => {
        if (!node) return;
        let foreign = false;
        for (const m of mutations) {
            if (m.target.nodeType === 1 && m.target.closest?.('.stk-ib')) continue;      // our own changes
            const nodes = [...m.addedNodes, ...m.removedNodes];
            if (nodes.length && nodes.every(n => isOurs(n))) continue;
            foreign = true;
            break;
        }
        if (!foreign) return;
        // a safety net: if some other extension keeps moving blocks around, stop answering for a while
        // instead of chasing it forever (an endless chase freezes the page, worst of all on phones)
        if (++moves > MAX_MOVES) {
            if (!cooling) {
                cooling = true;
                console.warn('[Stork] инфоблок: другое расширение постоянно двигает разметку — пауза');
                setTimeout(() => { cooling = false; moves = 0; }, 2000);
            }
            return;
        }
        if (!movesTimer) movesTimer = setTimeout(() => { moves = 0; movesTimer = null; }, 1000);
        const mesEl = nodeId === null ? null : getMesEl(nodeId);
        if (!mesEl) {
            scheduleBlocks();
            return;
        }
        const other = mesEl.querySelector('.stk-ib');
        if (other && other !== node) other.remove();
        if (!node.isConnected || (position() === 'bottom' && !settled(node))) place(mesEl, node);
        else if (position() === 'top' && !settledTop(node, mesEl.querySelector('.mes_text') ?? node)) place(mesEl, node);
    });
    observer.observe(chatEl, { childList: true, subtree: true });
}

/** A new chat: the block starts on the tab «Сейчас», nothing half-edited. */
export function resetBlock() {
    node?.remove();
    node = null;
    nodeId = null;
    lastHtml = '';
    Object.assign(view, { tab: 'now', monthOffset: 0, editPerson: null, pickDay: null });
}

// #endregion
