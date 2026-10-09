/*
 * Where the story state lives in SillyTavern, and how the model gets the status.
 * The chat's starting state is in chat metadata; every model reply keeps the state after it,
 * per swipe, so a reroll or a deleted message rolls the story back.
 */
import { saveChatDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { buildStatus, createState, processReply, upgradeState } from './engine.js';

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
    statusBar: true,
    toasts: true,
    showRolls: false,
    // 'analyzer': Stork reads each reply through a connection; 'tag': the story model leaves a hidden tag (free)
    readMode: 'analyzer',
    readProfile: '',
};

export function initSettings() {
    extension_settings[MODULE] = { ...defaultSettings, ...extension_settings[MODULE] };
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

/** The state after the whole chat: what the next reply builds on. */
export const currentState = () => stateBefore(Infinity);

/** Stork works only in chats where it was set up: other chats get nothing. */
export const activeIn = state => settings().enabled && !!state?.setupDone && !state?.chatOff;

export function hashText(text) {
    let h = 0;
    for (const char of String(text)) h = (h * 31 + char.charCodeAt(0)) | 0;
    return h;
}

/**
 * (Re)computes the state after one model reply. Unchanged text keeps its dice.
 * @returns {{tag: object, events: object[]}|null} The tag and the new log entries
 */
export function processMessage(index, textOverride = null, scene = null) {
    const chat = getContext().chat ?? [];
    const message = chat[index];
    if (!message || message.is_user || message.is_system) return null;
    const hash = hashText(message.mes);
    const existing = snapshotOf(message);
    if (existing?.hash === hash && textOverride === null) return null;
    const before = stateBefore(index);
    // An analysis result is read together with the reply itself, so a time header in the text still counts
    const { state, tag } = processReply(before, textOverride === null ? message.mes : `${message.mes}
${textOverride}`, Math.random, scene);
    message.extra ??= {};
    message.extra.stork ??= {};
    message.extra.stork[message.swipe_id ?? 0] = { hash, state, tagFound: tag.found, fromHints: textOverride !== null };
    if (textOverride !== null) saveChatDebounced();
    notify();
    return { tag, events: state.log.slice(before.log.length) };
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

// #endregion

// #region Status for the model

export function statusText(state, withTag = settings().readMode === 'tag') {
    return buildStatus(state, { detailed: settings().detailed, neutral: settings().neutral, withTag });
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
