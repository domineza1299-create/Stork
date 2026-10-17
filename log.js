/*
 * Stork's log: everything Stork says about its work in one place, with a download for the developer.
 * The browser console is a poor place for it: few people open it, other extensions write there too,
 * and it is empty after a reload.
 *
 * This module imports nothing: the request code, the window and index.js all write here,
 * and any import back would close a circle.
 */
const LIMIT = 600;
const DATA_LIMIT = 40000;
const PREFIX = '[Stork]';
const entries = [];
const listeners = new Set();
let installed = false;

const stringify = value => {
    if (value instanceof Error) {
        const cause = value.cause ? `\ncause: ${stringify(value.cause)}` : '';
        return `${value.stack || `${value.name}: ${value.message}`}${cause}`;
    }
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
};

export const logEntries = () => entries;
export const onLogChange = listener => { listeners.add(listener); return () => listeners.delete(listener); };

let pending = false;
function emit() {
    // a burst of entries is one redraw
    if (pending) return;
    pending = true;
    setTimeout(() => {
        pending = false;
        for (const listener of listeners) { try { listener(entries); } catch { /* the log must not break itself */ } }
    }, 200);
}

/**
 * @param {'info'|'warn'|'error'|'request'|'response'|'event'} level
 * @param {string} source who writes: the analysis, an event, the window
 * @param {string} text one line about what happened
 * @param {any} [data] details: unfold in the log and go into the download
 */
export function logEvent(level, source, text, data) {
    const entry = { at: Date.now(), level, source: String(source ?? ''), text: String(text ?? '') };
    if (data !== undefined && data !== null && data !== '') {
        const full = stringify(data);
        entry.data = full.length > DATA_LIMIT ? `${full.slice(0, DATA_LIMIT)}\n… (ещё ${full.length - DATA_LIMIT} знаков обрезано)` : full;
    }
    entries.push(entry);
    if (entries.length > LIMIT) entries.splice(0, entries.length - LIMIT);
    emit();
    return entry;
}

export function clearLog() {
    entries.length = 0;
    emit();
}

/**
 * Stork's own console lines and errors thrown in Stork's files go into the log too.
 * Other extensions' lines pass by untouched.
 */
export function installLogCapture() {
    if (installed) return;
    installed = true;
    for (const [method, level] of [['warn', 'warn'], ['error', 'error']]) {
        const original = console[method].bind(console);
        console[method] = (...args) => {
            if (typeof args[0] === 'string' && args[0].startsWith(PREFIX) && !args[0].startsWith(`${PREFIX}·`)) {
                const [first, ...rest] = args;
                logEvent(level, 'консоль', first.slice(PREFIX.length).trim(), rest.length ? rest.map(stringify).join('\n') : undefined);
            }
            return original(...args);
        };
    }
    const ours = value => /third-party\/Stork\//i.test(String(value ?? ''));
    window.addEventListener('error', event => {
        if (ours(event.filename) || ours(event.error?.stack)) logEvent('error', 'ошибка в коде', event.message, event.error ?? `${event.filename}:${event.lineno}`);
    });
    window.addEventListener('unhandledrejection', event => {
        if (ours(event.reason?.stack)) logEvent('error', 'ошибка в коде', event.reason?.message ?? String(event.reason), event.reason);
    });
}

/** The log as text, oldest first: what goes into the downloaded file. */
export function logText() {
    return entries.map(entry => {
        const head = `[${new Date(entry.at).toISOString()}] ${entry.level.toUpperCase()} ${entry.source}: ${entry.text}`;
        return entry.data ? `${head}\n${entry.data.split('\n').map(line => `    ${line}`).join('\n')}` : head;
    }).join('\n');
}

// #region The list in the window

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const ICONS = { info: 'fa-circle-info', warn: 'fa-triangle-exclamation', error: 'fa-circle-xmark', request: 'fa-arrow-up', response: 'fa-arrow-down', event: 'fa-bolt' };
const time = at => {
    const date = new Date(at);
    const two = n => String(n).padStart(2, '0');
    return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`;
};

export function logCountText() {
    const errors = entries.filter(entry => entry.level === 'error').length;
    const requests = entries.filter(entry => entry.level === 'request').length;
    return entries.length ? `записей ${entries.length} · запросов ${requests}${errors ? ` · ошибок ${errors}` : ''}` : '';
}

/** The newest entries first; long details fold away. */
export function logListHtml(max = 150) {
    if (!entries.length) return '<div class="stk-muted">Журнал пуст: с открытия страницы Stork ничего не делал.</div>';
    return entries.slice(-max).reverse().map(entry => {
        const head = `<i class="fa-solid ${ICONS[entry.level] ?? 'fa-circle'}" aria-hidden="true"></i><time>${time(entry.at)}</time><b>${escape(entry.source)}</b><span>${escape(entry.text)}</span>`;
        return entry.data
            ? `<details class="stk-log-row is-${entry.level}"><summary>${head}</summary><pre>${escape(entry.data)}</pre></details>`
            : `<div class="stk-log-row is-${entry.level}">${head}</div>`;
    }).join('');
}

// #endregion
