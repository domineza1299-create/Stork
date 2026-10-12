/*
 * Where the story state lives in SillyTavern, and how the model gets the status.
 * The chat's starting state is in chat metadata; every model reply keeps the state after it,
 * per swipe, so a reroll or a deleted message rolls the story back.
 */
import { saveChatDebounced } from '../../../../script.js';
import { extension_settings, extensionNames, getContext } from '../../../extensions.js';
import { buildStatus, cleanRpText, createState, MINUTES_PER_DAY, parseSkip, processReply, upgradeState } from './engine.js';

export const MODULE = 'stork';
const PROMPT_KEY = 'stork_status';
/** In-chat depth of the status: right before the latest messages, where models read it best. */
const STATUS_DEPTH = 1;
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;

const defaultSettings = {
    enabled: true,
    detailed: true,
    neutral: false,
    // 'inject': Stork places the status itself; 'macro': only through {{stork}} where the user put it
    placement: 'inject',
    // where Stork shows itself in the chat: the infoblock under the reply, the line above the input, both, or neither
    showBlock: true,
    statusBar: true,
    // where the infoblock sits in the latest reply: top | middle | bottom
    blockPosition: 'bottom',
    // which panels the infoblock shows (the window always shows everything)
    blockParts: { user: true, char: true, shared: true },
    // with each new reply: the block itself and its main panels start folded, open, or as she left them
    blockOpen: 'remember',
    blockFolds: 'remember',
    toasts: true,
    showRolls: false,
    // 'analyzer': Stork reads each reply through a connection; 'tag': the story model leaves a hidden tag (free)
    readMode: 'analyzer',
    // how many earlier replies the analysis remembers, one short line each (about 25 tokens a line)
    memoryReplies: 20,
    // a Connection Manager profile id, or 'current' for the main connection; '' = not chosen yet (the first profile is taken)
    readProfile: '',
    // the log keeps whole prompts too (big, and has the story's text)
    debugPrompts: false,
};

export function initSettings() {
    const saved = extension_settings[MODULE] ?? {};
    const s = { ...defaultSettings, ...saved };
    // before 0.10 «off» was one of the positions: now it is its own switch
    if (saved.showBlock === undefined && saved.blockPosition === 'off') s.showBlock = false;
    if (!['top', 'middle', 'bottom'].includes(s.blockPosition)) s.blockPosition = 'bottom';
    s.blockParts = { ...defaultSettings.blockParts, ...(saved.blockParts ?? {}) };
    extension_settings[MODULE] = s;
}

/** The four ways to see Stork in the chat, as two switches. */
export const VIEWS = {
    both: { showBlock: true, statusBar: true },
    block: { showBlock: true, statusBar: false },
    bar: { showBlock: false, statusBar: true },
    window: { showBlock: false, statusBar: false },
};
export function currentView() {
    const s = settings();
    return Object.entries(VIEWS).find(([, v]) => v.showBlock === !!s.showBlock && v.statusBar === !!s.statusBar)?.[0] ?? 'both';
}

export const settings = () => extension_settings[MODULE];

const listeners = new Set();
/** Called after any state change, so the status line and an open window can redraw. */
export function onStateChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
function notify() {
    for (const listener of listeners) {
        try {
            listener();
        } catch (error) {
            console.warn('[Stork] Listener failed', error);
        }
    }
}

// #region State

/** Not set up in this chat: a temporary default that is written nowhere until the user saves. */
function baseState({ persist = false } = {}) {
    const context = getContext();
    const meta = context.chatMetadata;
    if (meta[MODULE]) return upgradeState(meta[MODULE]);
    // the real date only until the story names its own (then the calendar re-anchors to it)
    const fresh = createState({ userName: context.name1, charName: context.name2, startDate: new Date().toISOString().slice(0, 10) });
    if (persist) {
        meta[MODULE] = fresh;
        context.saveMetadataDebounced();
    }
    return fresh;
}

const snapshotOf = message => message?.extra?.stork?.[message.swipe_id ?? 0] ?? null;

/** The state right before chat message `index` (that message itself is not counted). */
export function stateBefore(index) {
    const chat = getContext().chat ?? [];
    for (let i = Math.min(index, chat.length) - 1; i >= 0; i--) {
        const snapshot = snapshotOf(chat[i]);
        if (snapshot) return upgradeState(snapshot.state);
    }
    return baseState();
}

/**
 * The lines of the story so far before chat message `index`: one per read reply, the newest `limit` of them,
 * oldest first. Walks the chat back through the swipes that are shown now.
 */
export function storyLines(index, limit = 20) {
    const chat = getContext().chat ?? [];
    const lines = [];
    for (let i = Math.min(index, chat.length) - 1; i >= 0 && lines.length < limit; i--) {
        const line = snapshotOf(chat[i])?.state?.lastLine;
        if (line?.text) lines.push(line);
    }
    return lines.reverse();
}

/** The state after the whole chat: what the next reply builds on. */
export const currentState = () => stateBefore(Infinity);

/** Stork works only in chats where it was set up: other chats get nothing. */
export const activeIn = state => settings().enabled && !!state?.setupDone && !state?.chatOff;

export function hashText(text) {
    let h = 0;
    for (const char of String(text)) h = (h * 31 + char.charCodeAt(0)) | 0;
    return h;
}

// #region Other extensions rewrite replies: telling the same reply from a new one

/**
 * The story of a reply: no pictures or HTML (an image generator puts the picture in place of its tag, other extensions
 * add their markup), but Stork's own tag stays, it is the story's data.
 */
export const storyText = mes => cleanRpText(String(mes ?? '').replace(/<(stork\b[^>]*?)\/?>/gi, '[$1]')).replace(/\s+/g, ' ').trim();
export const storyHash = mes => hashText(storyText(mes));

const SIG_SIZE = 24;
/** Share of the fingerprint two texts must have in common to be one reply (a block added or a picture swapped in). */
const SAME_REPLY = 0.6;
/** A short fingerprint of the wording (MinHash of word pairs): two versions of one reply share most of it, another reply almost none. */
export function storySig(mes) {
    const words = storyText(mes).toLowerCase().split(' ');
    const sig = new Array(SIG_SIZE).fill(0x7fffffff);
    for (let i = 0; i < Math.max(1, words.length - 1); i++) {
        const pair = `${words[i]} ${words[i + 1] ?? ''}`;
        for (let k = 0; k < SIG_SIZE; k++) {
            const h = hashText(`${k}:${pair}`) & 0x7fffffff;
            if (h < sig[k]) sig[k] = h;
        }
    }
    return sig;
}
export const likeness = (a, b) => (Array.isArray(a) && Array.isArray(b) ? a.filter((v, k) => v === b[k]).length / SIG_SIZE : 0);
export const similarSig = (a, b) => likeness(a, b) >= SAME_REPLY;

/**
 * This snapshot still belongs to this text. strict: only the very same story counts (her own edit, a continued reply);
 * otherwise a version rewritten by another extension counts too.
 */
export function sameReply(snapshot, mes, { strict = false } = {}) {
    if (!snapshot) return false;
    // older snapshots kept the hash of the raw text
    if (snapshot.hash === storyHash(mes) || snapshot.hash === hashText(mes)) return true;
    return !strict && similarSig(snapshot.sig, storySig(mes));
}

// #endregion

/**
 * (Re)computes the state after one model reply. Unchanged text keeps its dice.
 * @param {object} [options]
 * @param {boolean} [options.strict] only the very same text keeps its dice (see sameReply)
 * @returns {{tag: object, events: object[]}|null} The tag and the new log entries
 */
export function processMessage(index, textOverride = null, scene = null, { strict = false } = {}) {
    const chat = getContext().chat ?? [];
    const message = chat[index];
    if (!message || message.is_user || message.is_system) return null;
    const hash = storyHash(message.mes);
    const existing = snapshotOf(message);
    if (textOverride === null && sameReply(existing, message.mes, { strict })) return null;
    const before = stateBefore(index);
    // An analysis result is read together with the reply itself, so a time header in the text still counts
    const { state, tag } = processReply(before, textOverride === null ? message.mes : `${message.mes}
${textOverride}`, Math.random, scene);
    message.extra ??= {};
    message.extra.stork ??= {};
    message.extra.stork[message.swipe_id ?? 0] = { hash, sig: storySig(message.mes), state, tagFound: tag.found, fromHints: textOverride !== null };
    if (textOverride !== null) saveChatDebounced();
    notify();
    return { tag, events: state.log.slice(before.log.length) };
}

/** Skips shorter than a day are left to the reading of the reply: they change nothing in her cycle. */
const MIN_PRE_SKIP = MINUTES_PER_DAY;

/**
 * Her message opens with a time skip («4 месяца спустя…»): the time moves now, before the bot answers, so the bot
 * writes from the right day of her cycle. The reading of the reply then counts only what comes after the skip.
 * @returns {{minutes: number, state: object, events: object[]}|null} what changed, or null
 */
export function processUserMessage(index) {
    const chat = getContext().chat ?? [];
    const message = chat[index];
    if (!message?.is_user) return null;
    const minutes = parseSkip(message.mes);
    const existing = snapshotOf(message);
    if (minutes < MIN_PRE_SKIP) {
        // the skip was edited away
        if (existing) {
            delete message.extra.stork;
            saveChatDebounced();
            notify();
        }
        return null;
    }
    if (existing?.hash === storyHash(message.mes)) return null;
    const before = stateBefore(index);
    const { state } = processReply(before, `<stork t="+${minutes}m" ev=""/>`);
    message.extra ??= {};
    message.extra.stork = { 0: { hash: storyHash(message.mes), sig: storySig(message.mes), state, skip: minutes } };
    saveChatDebounced();
    notify();
    return { minutes, state, events: state.log.slice(before.log.length) };
}

/** The time skip of her message before this reply, already counted before the bot answered (0 if none). */
export function skipBefore(index) {
    const chat = getContext().chat ?? [];
    const user = chat[index - 1];
    return user?.is_user ? (snapshotOf(user)?.skip ?? 0) : 0;
}

/**
 * Saves a change made by hand (buttons, setup) into the latest point of the story.
 * @returns {{state: object, events: object[]}}
 */
export function updateCurrentState(mutate) {
    const context = getContext();
    const chat = context.chat ?? [];
    let target = null;
    for (let i = chat.length - 1; i >= 0 && !target; i--) {
        const snapshot = snapshotOf(chat[i]);
        if (snapshot) target = snapshot.state;
    }
    const persistBase = !target;
    target ??= baseState({ persist: true });
    const logLength = target.log.length;
    mutate(target);
    if (persistBase) context.saveMetadataDebounced();
    else saveChatDebounced();
    refreshStatus();
    notify();
    return { state: target, events: target.log.slice(logLength) };
}

// #endregion

// #region Reading the story: in progress, failed (with a retry)

const reading = { index: null, failed: null };
let retryHandler = null;
export const readStatus = () => reading;
export function setReading(index) {
    reading.index = index;
    if (index !== null) reading.failed = null;
    notify();
}
export function setReadFailed(index, error) {
    reading.index = null;
    reading.failed = index === null ? null : { index, error: String(error?.message ?? error ?? '') };
    notify();
}
export const onRetry = handler => { retryHandler = handler; };
export const retryRead = () => (reading.failed && retryHandler ? retryHandler(reading.failed.index) : null);
let rereadHandler = null;
export const onReread = handler => { rereadHandler = handler; };
/** «Перечитать последний ответ» in the window: her message and the latest reply are read anew. */
export const rereadLast = () => rereadHandler?.() ?? false;

/**
 * The tag mode only: how many of the latest bot replies in a row came without Stork's tag (0 when the newest has one).
 * Replies read by the analysis or marked from a hint count as read; a reply never read ends the count.
 */
export function missingTags() {
    if (settings().readMode !== 'tag') return 0;
    const chat = getContext().chat ?? [];
    let count = 0;
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message || message.is_user || message.is_system) continue;
        const snapshot = message.extra?.stork?.[message.swipe_id ?? 0];
        if (!snapshot || snapshot.tagFound || snapshot.fromHints) break;
        count++;
    }
    return count;
}

// #endregion

// #region Status for the model

/** Other trackers that tell the story model the time themselves: with one of them on, Stork does not add a second clock. */
const CLOCK_KEEPERS = [
    { name: 'Mnema', folder: /(^|\/)(5555990|mnema)$/i, on: () => extension_settings.mnema?.enabled !== false },
    { name: 'Horae', folder: /(^|\/)(SillyTavern-)?Horae$/i, on: () => true },
];
/** The other tracker that keeps the time in this SillyTavern, or null. */
export function otherClock() {
    const disabled = extension_settings.disabledExtensions ?? [];
    for (const keeper of CLOCK_KEEPERS) {
        const folder = (extensionNames ?? []).find(n => keeper.folder.test(n));
        if (folder && !disabled.includes(folder) && keeper.on()) return keeper.name;
    }
    return null;
}

export function statusText(state, withTag = settings().readMode === 'tag') {
    return buildStatus(state, { detailed: settings().detailed, neutral: settings().neutral, withTag, withTime: !otherClock() });
}

/** The state a running generation builds on; the macro must agree with the injected status. */
let generationState = null;
export const setGenerationState = state => { generationState = state; };
export const getGenerationState = () => generationState;

/** Puts the status into the prompt (or clears it when Stork is off here or placed by macro). */
export function setStatus(state) {
    const value = activeIn(state) && settings().placement === 'inject' ? statusText(state) : '';
    getContext().setExtensionPrompt(PROMPT_KEY, value, IN_CHAT, STATUS_DEPTH, false, ROLE_SYSTEM);
}

export function refreshStatus() {
    try {
        setStatus(currentState());
    } catch (error) {
        console.warn('[Stork] Could not build the status', error);
    }
}

export const changed = () => notify();

// #endregion
