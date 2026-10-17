/*
 * Stork's own notifications: a glass card with a coloured Font Awesome icon, in the colours of the current SillyTavern theme.
 * On a phone they come down under the top bar across the screen and go away with a swipe; on a computer they sit top right
 * and wait while the mouse is over them. Over an open popup (the Stork window) they move inside it, as SillyTavern's own toasts do.
 */
import { esc } from './common.js';

const MAX_SHOWN = 3;
const SWIPE_AWAY_PX = 70;

/** The container: inside the topmost open popup, or on the page. */
function container() {
    let box = document.getElementById('stork_toasts');
    if (!box) {
        box = document.createElement('div');
        box.id = 'stork_toasts';
        box.className = 'stk-toasts';
        box.setAttribute('aria-live', 'polite');
    }
    const host = [...document.querySelectorAll('dialog.popup[open]')].at(-1) ?? document.body;
    if (box.parentElement !== host) host.append(box);
    return box;
}

/**
 * Shows one notification.
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.icon] Font Awesome icon, like 'fa-droplet'
 * @param {'pink'|'period'|'warm'|'preg'|'accent'|'calm'} [options.tone] its colour: the same tones as everywhere in Stork
 * @param {string} [options.title] the small line above the text
 * @param {number} [options.timeOut] milliseconds; 0 stays until closed
 * @param {Function} [options.onClick] a tap on the card (or on the action button)
 * @param {string} [options.action] a button label for onClick
 */
export function notify(text, { icon = 'fa-dove', tone = 'pink', title = 'Stork', timeOut = 5000, onClick = null, action = '' } = {}) {
    const box = container();
    while (box.children.length >= MAX_SHOWN) box.firstElementChild.remove();
    const toast = document.createElement('div');
    toast.className = `stk-toast t-${tone}`;
    toast.setAttribute('role', 'status');
    toast.innerHTML = `
        <span class="stk-toast-ic" aria-hidden="true"><i class="fa-solid ${icon}"></i></span>
        <div class="stk-toast-text"><b>${esc(title)}</b><span>${esc(text)}</span></div>
        ${action ? `<button type="button" class="stk-toast-act">${esc(action)}</button>` : ''}
        <button type="button" class="stk-toast-x" aria-label="Закрыть"><i class="fa-solid fa-xmark"></i></button>
        ${timeOut ? `<i class="stk-toast-time" style="animation-duration:${timeOut}ms" aria-hidden="true"></i>` : ''}`;
    box.append(toast);

    let closed = false;
    const close = (away = 0) => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        toast.classList.add('is-leaving');
        if (away) toast.style.transform = `translateX(${away > 0 ? 110 : -110}%)`;
        setTimeout(() => {
            toast.remove();
            if (!box.children.length) box.remove();
        }, 260);
    };
    const run = () => {
        close();
        onClick?.();
    };

    // the time runs only while nobody is looking at it
    let left = timeOut;
    let started = Date.now();
    let timer = timeOut ? setTimeout(close, left) : null;
    const pause = () => {
        if (!timeOut || closed || toast.classList.contains('is-paused')) return;
        clearTimeout(timer);
        left -= Date.now() - started;
        toast.classList.add('is-paused');
    };
    const resume = () => {
        if (!timeOut || closed || !toast.classList.contains('is-paused')) return;
        started = Date.now();
        timer = setTimeout(close, Math.max(800, left));
        toast.classList.remove('is-paused');
    };

    toast.querySelector('.stk-toast-x').addEventListener('click', event => {
        event.stopPropagation();
        close();
    });
    toast.querySelector('.stk-toast-act')?.addEventListener('click', event => {
        event.stopPropagation();
        run();
    });
    toast.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') pause(); });
    toast.addEventListener('pointerleave', event => { if (event.pointerType === 'mouse') resume(); });

    // a tap runs it, a swipe sideways sends it away
    let x0 = null;
    let dx = 0;
    toast.addEventListener('pointerdown', event => {
        if (event.target.closest('button')) return;
        x0 = event.clientX;
        dx = 0;
        toast.setPointerCapture?.(event.pointerId);
        toast.classList.add('is-dragging');
        pause();
    });
    toast.addEventListener('pointermove', event => {
        if (x0 === null) return;
        dx = event.clientX - x0;
        toast.style.transform = `translateX(${dx}px)`;
        toast.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / 240));
    });
    const release = cancelled => {
        if (x0 === null) return;
        x0 = null;
        toast.classList.remove('is-dragging');
        if (!cancelled && Math.abs(dx) > SWIPE_AWAY_PX) return close(dx);
        toast.style.transform = '';
        toast.style.opacity = '';
        // with an action button only the button acts: a tap on the card just closes it
        if (!cancelled && Math.abs(dx) < 6) return onClick && !action ? run() : close();
        resume();
    };
    toast.addEventListener('pointerup', () => release(false));
    toast.addEventListener('pointercancel', () => release(true));
    return { close };
}

/** «Сохранено» and other short confirmations. */
export const notifyDone = (text, options = {}) => notify(text, { icon: 'fa-check', tone: 'accent', timeOut: 2200, ...options });
/** Something did not work or needs attention. */
export const notifyWarn = (text, options = {}) => notify(text, { icon: 'fa-triangle-exclamation', tone: 'warm', timeOut: 7000, ...options });

/** The icon and colour of a story event from the journal. */
export function eventLook(event) {
    const t = String(event?.text ?? '');
    if (event?.kind === 'labor') return { icon: 'fa-baby', tone: 'preg' };
    if (event?.kind === 'period_hint') return { icon: 'fa-droplet', tone: 'warm' };
    if (event?.kind === 'doctor') return { icon: 'fa-user-doctor', tone: 'accent' };
    if (event?.kind === 'injury') return { icon: 'fa-bandage', tone: 'warm' };
    if (event?.kind === 'recovered') return { icon: 'fa-battery-full', tone: 'accent' };
    if (/задержка/i.test(t)) return { icon: 'fa-hourglass-half', tone: 'warm' };
    if (/месячные|кровотечение отмены|выделения/i.test(t)) return { icon: 'fa-droplet', tone: 'period' };
    if (/тест/i.test(t)) return { icon: 'fa-vial', tone: 'pink' };
    if (/УЗИ/.test(t)) return { icon: 'fa-heart-pulse', tone: 'preg' };
    if (/схватк/i.test(t)) return { icon: 'fa-wave-square', tone: 'preg' };
    if (/шевелени|трепетание|узнал о беременности/i.test(t)) return { icon: 'fa-heart', tone: 'pink' };
    if (/презерватив/i.test(t)) return { icon: 'fa-triangle-exclamation', tone: 'warm' };
    if (/стресс|болезнь|овуляц/i.test(t)) return { icon: 'fa-cloud-rain', tone: 'warm' };
    return { icon: 'fa-dove', tone: 'pink' };
}
