import { eventSource, event_types } from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import { dateLabel, detectHints, stripTag, timeLabel } from './engine.js';
import { analyzeScene, sceneToTag } from './scene.js';
import {
    activeIn, changed, currentState, getGenerationState, hashText, initSettings, MODULE, onRetry, onStateChange, processMessage,
    readStatus, refreshStatus, setGenerationState, setReadFailed, setReading, setStatus, settings, stateBefore, statusText, updateCurrentState,
} from './store.js';
import { buildStatus } from './engine.js';
import { analyzeCards, readCards } from './cards.js';
import { hasMinor, setupFromAnalysis } from './setup.js';
import { announce, openStork, renderStatusBar } from './ui.js';
import { renderBlocks, resetBlock, scheduleBlocks, watchChat } from './block.js';

// #region Generation

/**
 * Before a generation: a swipe, regenerate or continue rewrites the last reply,
 * so the status comes from the state before that reply.
 */
async function onGenerationAfterCommands(type) {
    if (pendingReading) {
        await Promise.race([pendingReading, new Promise(resolve => setTimeout(resolve, READ_WAIT_MS))]);
    }
    const chat = getContext().chat ?? [];
    const last = chat.length - 1;
    const rewritesLast = ['swipe', 'regenerate', 'continue'].includes(type) && chat[last] && !chat[last].is_user;
    setGenerationState(rewritesLast ? stateBefore(last) : null);
    setStatus(getGenerationState() ?? currentState());
}

// #endregion

// #region Tag: hidden from the reader and from the model's history

const TAG_HTML_RE = /(?:<|&lt;)stork\b[\s\S]*?(?:\/>|\/&gt;|>|&gt;)(?:\s*(?:<|&lt;)\/stork(?:>|&gt;))?/gi;

function hideTagIn(messageId) {
    const element = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
    if (!element) return;
    const cleaned = element.innerHTML.replace(TAG_HTML_RE, '');
    if (cleaned !== element.innerHTML) element.innerHTML = cleaned;
}

function hideAllTags() {
    document.querySelectorAll('#chat .mes').forEach(el => hideTagIn(el.getAttribute('mesid')));
}

/** Old replies keep their tags in the chat file, but the model never sees them. */
function stripTagsFromPrompt(data) {
    for (const message of data?.chat ?? []) {
        if (typeof message.content === 'string') message.content = stripTag(message.content);
        else if (Array.isArray(message.content)) {
            for (const part of message.content) if (part?.type === 'text') part.text = stripTag(part.text);
        }
    }
}

function stripTagsFromTextPrompt(data) {
    if (typeof data?.prompt === 'string') data.prompt = data.prompt.replace(/<stork\b[^>]*\/?>(?:\s*<\/stork>)?/gi, '');
}

// #endregion

// #region Replies

/** When the model forgot the tag: offer what the text suggests, never apply silently. */
function offerHints(index) {
    const chat = getContext().chat ?? [];
    const reply = chat[index]?.mes ?? '';
    const userText = chat[index - 1]?.is_user ? chat[index - 1].mes : '';
    const hints = detectHints(`${userText}\n${reply}`);
    if (!hints.minutes && !hints.intimacy) return;
    const parts = [];
    if (hints.minutes) parts.push(`прошло около ${hints.minutes >= 1440 ? `${Math.round(hints.minutes / 1440)} дн.` : `${Math.round(hints.minutes / 60)} ч`}`);
    if (hints.intimacy) parts.push('была близость');
    toastr.info(`Похоже, ${parts.join(' и ')}, но модель не оставила метку. Нажми, чтобы отметить.`, 'Stork', {
        timeOut: 15000,
        onclick: () => {
            const ev = hints.intimacy ? 'intimacy:none' : '';
            const result = processMessage(index, `<stork t="+${hints.minutes}m" ev="${ev}"/>`);
            refreshStatus();
            announce(result?.events);
            toastr.success('Отмечено', 'Stork', { timeOut: 2000 });
        },
    });
}

/** A running scene analysis: the next generation waits for it, so the model gets the fresh status. */
let pendingReading = null;
const READ_WAIT_MS = 30000;

/**
 * Reads one reply: through a connection (analyzer) or from the hidden tag.
 * Unchanged text is skipped, so swiping back and forth costs nothing.
 */
async function readReply(index, force = false) {
    const chat = getContext().chat ?? [];
    const message = chat[index];
    if (!message || message.is_user || message.is_system) return;
    const snapshot = message.extra?.stork?.[message.swipe_id ?? 0];
    if (!force && snapshot && snapshot.hash === hashText(message.mes)) return;

    if (settings().readMode !== 'analyzer') {
        const result = processMessage(index);
        refreshStatus();
        if (!result) return;
        announce(result.events);
        if (!result.tag.found) offerHints(index);
        return;
    }

    const before = stateBefore(index);
    const hash = hashText(message.mes);
    // the reply before the user's message — context, so the analysis follows the scene, not one line of it
    const userAt = chat[index - 1]?.is_user ? index - 1 : null;
    const earlier = userAt !== null && chat[userAt - 1] && !chat[userAt - 1].is_user && !chat[userAt - 1].is_system ? chat[userAt - 1].mes : '';
    setReading(index);
    try {
        const scene = await analyzeScene({
            profileId: settings().readProfile ?? '',
            userName: before.people.user.name,
            charName: before.people.char.name,
            dateText: `${dateLabel(before)}, ${String(Math.floor(before.clock.minutes / 60)).padStart(2, '0')}:${String(before.clock.minutes % 60).padStart(2, '0')} (${timeLabel(before.clock.minutes)})`,
            status: buildStatus(before, { detailed: true, withTag: false }),
            earlier,
            userMessage: userAt !== null ? chat[userAt].mes : '',
            reply: message.mes,
        });
        // the text changed while we read (swipe, edit): this answer is about the old one
        if (hashText(getContext().chat?.[index]?.mes) !== hash) return;
        console.info('[Stork] сцена:', scene);
        const result = processMessage(index, sceneToTag(scene), scene);
        setReading(null);
        refreshStatus();
        announce(result?.events);
    } catch (error) {
        console.warn('[Stork] Scene analysis failed', error);
        setReadFailed(index, error);
        toastr.warning(`Не получилось прочитать сцену: ${error?.message ?? error}. Нажми, чтобы повторить.`, 'Stork', {
            timeOut: 12000,
            onclick: () => retry(index),
        });
    } finally {
        if (readStatus().index === index) setReading(null);
    }
}

/** Repeat the analysis of a reply that failed: the same text, read again. */
function retry(index) {
    const chat = getContext().chat ?? [];
    if (!chat[index]) return;
    pendingReading = readReply(index, true).finally(() => { pendingReading = null; });
}

// #region Each chat on its own: Stork turns itself on with the first real reply

/** The greeting (before the user's first message) is not read: everything starts with the first reply to her. */
const isOpening = index => !(getContext().chat ?? []).slice(0, index).some(m => m?.is_user);

let enabling = null;
/**
 * A chat where Stork was never set up: read the cards and the story opening once, set up from them and remember it
 * in this chat. Never in a chat where she turned it off, never before the first real reply, never with a minor.
 * @returns {Promise<boolean>} Stork is on in this chat now
 */
async function autoEnable(index) {
    const before = stateBefore(index);
    if (!settings().enabled || before.setupDone || before.chatOff || before.minorBlocked || isOpening(index)) return false;
    if (enabling) return enabling;
    enabling = (async () => {
        setReading(index);
        const cards = readCards();
        let analysis = null;
        try {
            analysis = await analyzeCards(settings().readProfile ?? '');
            console.info('[Stork] карточки и начало истории:', analysis);
        } catch (error) {
            console.warn('[Stork] Card analysis failed — setting up with defaults', error);
        }
        if (hasMinor(analysis, cards)) {
            updateCurrentState(state => { state.minorBlocked = true; });
            toastr.warning('По карточке персонаж младше 18 лет: Stork в этом чате не работает.', 'Stork');
            setReading(null);
            return false;
        }
        updateCurrentState(state => setupFromAnalysis(state, analysis, cards));
        toastr.success('Stork включился в этом чате: цикл и состояние ведутся по сюжету. Поправить — в окне Stork.', 'Stork', { timeOut: 5000 });
        return true;
    })().finally(() => { enabling = null; });
    return enabling;
}

async function onMessageReceived(messageId) {
    const index = Number(messageId);
    hideTagIn(messageId);
    if (!activeIn(stateBefore(index)) && !(await autoEnable(index))) return;
    pendingReading = readReply(index).finally(() => { pendingReading = null; });
}

async function onMessageChanged(messageId) {
    const index = Number(messageId);
    setTimeout(() => hideTagIn(messageId), 0);
    if (!activeIn(stateBefore(index)) && !(await autoEnable(index))) return;
    pendingReading = readReply(index).finally(() => { pendingReading = null; });
}

// #endregion

// #endregion

// #region Entry points

function registerMacro() {
    getContext().registerMacro?.(MODULE, () => {
        const state = getGenerationState() ?? currentState();
        return activeIn(state) ? statusText(state) : '';
    }, 'Stork: репродуктивный статус {{user}} и {{char}}');
}

function registerSlashCommand() {
    const { SlashCommandParser, SlashCommand } = getContext();
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'stork',
        callback: async () => {
            await openStork();
            return '';
        },
        helpString: 'Открыть Stork: цикл, беременность и состояние {{user}} и {{char}}.',
    }));
}

function renderWandButton() {
    $('#extensionsMenu').append(`
        <div id="stork_wand_container" class="extension_container interactable" tabindex="0">
            <div id="stork_wand" class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="listitem" title="Цикл, беременность и состояние персонажей">
                <div class="fa-solid fa-dove extensionsMenuExtensionButton"></div>
                <span>Stork</span>
            </div>
        </div>`);
    $('#stork_wand').on('click', () => openStork());
}

function renderSettingsDrawer() {
    $('#extensions_settings2').append(`
        <div class="stork-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b><i class="fa-solid fa-dove"></i> Stork</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="menu_button menu_button_icon" id="stork_open"><i class="fa-solid fa-dove"></i> Открыть Stork</div>
                    <small>Всё в одном окне: настройка персонажей, цикл, беременность, журнал. Ещё его открывают палочка, строка над полем ввода и команда /stork.</small>
                </div>
            </div>
        </div>`);
    $('#stork_open').on('click', () => openStork());
}

// #endregion

jQuery(() => {
    initSettings();
    registerMacro();
    registerSlashCommand();
    renderWandButton();
    renderSettingsDrawer();
    onStateChange(renderStatusBar);
    onStateChange(scheduleBlocks);
    onRetry(retry);
    watchChat();

    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, stripTagsFromPrompt);
    eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, stripTagsFromTextPrompt);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED']) {
        if (event_types[name]) eventSource.on(event_types[name], () => setGenerationState(null));
    }
    for (const name of ['MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED']) {
        if (event_types[name]) eventSource.on(event_types[name], onMessageChanged);
    }
    for (const name of ['CHAT_CHANGED', 'MESSAGE_DELETED']) {
        if (event_types[name]) {
            eventSource.on(event_types[name], () => {
                if (name === 'CHAT_CHANGED') resetBlock();
                refreshStatus();
                changed();
                setTimeout(hideAllTags, 50);
                for (const ms of [150, 600]) setTimeout(() => renderBlocks(), ms);
            });
        }
    }
    // the infoblock follows the latest reply: new, swiped, edited, re-rendered
    for (const name of ['CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MORE_MESSAGES_LOADED', 'GENERATION_ENDED']) {
        if (event_types[name]) eventSource.on(event_types[name], () => scheduleBlocks());
    }
    for (const name of ['CHARACTER_MESSAGE_RENDERED', 'MORE_MESSAGES_LOADED']) {
        if (event_types[name]) eventSource.on(event_types[name], () => setTimeout(hideAllTags, 0));
    }
    refreshStatus();
    renderStatusBar();
    setTimeout(() => renderBlocks(), 300);
});
