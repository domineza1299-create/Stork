import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import { dateLabel, detectHints, stripTag, timeLabel } from './engine.js';
import { analyzeScene, errorText, sceneToTag } from './scene.js';
import { trace, watchErrors } from './diag.js';
import {
    activeIn, changed, currentState, currentView, getGenerationState, initSettings, MODULE, onReread, onRetry, onStateChange, processMessage,
    processUserMessage, readStatus, refreshStatus, sameReply, setGenerationState, setReadFailed, setReading, setStatus, settings, similarSig,
    skipBefore, stateBefore, statusText, storyHash, storySig, updateCurrentState, VIEWS,
} from './store.js';
import { buildStatus } from './engine.js';
import { analyzeCards, readCards } from './cards.js';
import { hasMinor, setupFromAnalysis } from './setup.js';
import { renderStatusBar } from './ui.js';
import { announce, openStork } from './window.js';
import { notify, notifyDone, notifyWarn } from './notify.js';
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
    notify(`Похоже, ${parts.join(' и ')}, но модель не оставила метку.`, {
        icon: 'fa-wand-magic-sparkles',
        tone: 'accent',
        timeOut: 15000,
        action: 'Отметить',
        onClick: () => {
            const ev = hints.intimacy ? 'intimacy:none' : '';
            const result = processMessage(index, `<stork t="+${hints.minutes}m" ev="${ev}"/>`);
            refreshStatus();
            announce(result?.events);
            notifyDone('Отмечено');
        },
    });
}

/** A running scene analysis: the next generation waits for it, so the model gets the fresh status. */
let pendingReading = null;
const READ_WAIT_MS = 30000;

// #region Reading a reply, safe from other extensions that rewrite it

/** Readings running now, one per reply and swipe: the same reply is never read twice at once. */
const readsInFlight = new Map();
/** The newest reading of each reply: an older one that comes back later must not overwrite it. */
const latestRead = new Map();
let readCount = 0;
/** How many times a reply was read again because its reading had to be thrown away: never in a loop. */
const rereads = new Map();
const MAX_REREADS = 2;

/**
 * Reads one reply. strict: her own edit or a continued reply, read anew unless the story is exactly the same.
 * Otherwise (another extension updated the reply: a picture, a block, markup) a reply that is still the same story
 * keeps its reading, and a second event for it joins the reading already running instead of paying again.
 */
export function readReply(index, { force = false, strict = false } = {}) {
    const message = getContext().chat?.[index];
    if (!message) return Promise.resolve();
    const key = `${index}:${message.swipe_id ?? 0}`;
    const hash = storyHash(message.mes);
    const sig = storySig(message.mes);
    const running = readsInFlight.get(key);
    if (running && (running.hash === hash || (!strict && similarSig(running.sig, sig)))) return running.run;
    const entry = { hash, sig };
    entry.run = readReplyNow(index, { force, strict }).finally(() => {
        if (readsInFlight.get(key) === entry) readsInFlight.delete(key);
    });
    readsInFlight.set(key, entry);
    return entry.run;
}

/** A reading had to be thrown away and nothing else will read the reply: read it once more, a little later. */
function rereadLater(index) {
    const chat = getContext().chat;
    const count = rereads.get(index) ?? 0;
    if (count >= MAX_REREADS) return;
    rereads.set(index, count + 1);
    setTimeout(() => {
        const message = getContext().chat === chat ? chat?.[index] : null;
        if (!message || message.extra?.stork?.[message.swipe_id ?? 0]) return;
        pendingReading = readReply(index, { force: true }).finally(() => { pendingReading = null; });
    }, 500);
}

/**
 * Reads one reply: through a connection (analyzer) or from the hidden tag.
 * Unchanged text is skipped, so swiping back and forth costs nothing.
 */
async function readReplyNow(index, { force = false, strict = false } = {}) {
    const chat = getContext().chat ?? [];
    const message = chat[index];
    if (!message || message.is_user || message.is_system) return;
    const snapshot = message.extra?.stork?.[message.swipe_id ?? 0];
    if (!force && sameReply(snapshot, message.mes, { strict })) return;

    if (settings().readMode !== 'analyzer') {
        const result = processMessage(index, null, null, { strict });
        refreshStatus();
        if (!result) return;
        announce(result.events);
        if (!result.tag.found) offerHints(index);
        return;
    }

    const mine = ++readCount;
    latestRead.set(index, mine);
    const before = stateBefore(index);
    const sig = storySig(message.mes);
    const swipe = message.swipe_id ?? 0;
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
            status: buildStatus(before, { detailed: true, withTag: false, guide: false }),
            earlier,
            userMessage: userAt !== null ? chat[userAt].mes : '',
            reply: message.mes,
            skipCounted: skipBefore(index) > 0,
        });
        // another chat opened, the reply was swiped or deleted, or a newer reading of it started: this answer is not for what is there now
        const now = getContext().chat === chat ? chat[index] : null;
        if (!now || (now.swipe_id ?? 0) !== swipe || latestRead.get(index) !== mine) {
            trace(`ответ #${index}: пока шёл анализ, ответ сменился или его читают заново, этот результат не нужен`);
            return;
        }
        // another extension may have rewritten the reply meanwhile (a picture in place of its tag): the same story still counts
        if (!similarSig(sig, storySig(now.mes))) {
            trace(`ответ #${index}: сильно изменился, пока шёл анализ (другое расширение?), читаю заново`);
            rereadLater(index);
            return;
        }
        console.info('[Stork] сцена:', scene);
        trace(`ответ #${index} прочитан: ${sceneToTag(scene)}`);
        const result = processMessage(index, sceneToTag(scene), scene);
        setReading(null);
        refreshStatus();
        announce(result?.events);
    } catch (error) {
        trace(`ответ #${index}: анализ не прошёл: ${errorText(error)}`, 'warn');
        setReadFailed(index, error);
        notifyWarn(`Не получилось прочитать сцену: ${error?.message ?? error}`, { timeOut: 12000, action: 'Повторить', onClick: () => retry(index) });
    } finally {
        if (readStatus().index === index) setReading(null);
    }
}

/** Repeat the analysis of a reply that failed: the same text, read again. */
function retry(index) {
    const chat = getContext().chat ?? [];
    if (!chat[index]) return;
    pendingReading = readReply(index, { force: true }).finally(() => { pendingReading = null; });
}

// #endregion

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
            trace('карточки прочитаны, Stork включается в этом чате');
        } catch (error) {
            trace(`карточки прочитать не вышло, настраиваюсь по умолчанию: ${errorText(error)}`, 'warn');
        }
        if (hasMinor(analysis, cards)) {
            updateCurrentState(state => { state.minorBlocked = true; });
            notifyWarn('По карточке персонаж младше 18 лет: Stork в этом чате не работает.', { icon: 'fa-ban' });
            setReading(null);
            return false;
        }
        updateCurrentState(state => setupFromAnalysis(state, analysis, cards));
        notify('Stork включился в этом чате: цикл и состояние ведутся по сюжету. Нажми, чтобы поправить.', { icon: 'fa-dove', tone: 'pink', timeOut: 7000, onClick: () => openStork() });
        return true;
    })().finally(() => { enabling = null; });
    return enabling;
}

/**
 * Her message, before the bot answers it: a time skip it opens with moves the story right now,
 * so the bot already writes from the right day.
 */
function onMessageSent(messageId) {
    const index = Number(messageId);
    if (!activeIn(stateBefore(index))) return;
    const result = processUserMessage(index);
    refreshStatus();
    if (!result) return;
    const when = dateLabel(result.state, result.state.clock.day, { day: 'numeric', month: 'long' });
    trace(`сообщение #${index}: перемотка на ${result.minutes} мин до ответа бота, теперь ${when}`);
    notify(`Перемотала время по твоему сообщению: теперь в истории ${when}`, { icon: 'fa-forward', tone: 'accent', timeOut: 5000 });
    announce(result.events);
}

/**
 * Read the latest reply anew, by hand: her message before it first (a time skip in it), then the reply itself.
 * @returns {boolean} there was a reply to read
 */
export function rereadLatest() {
    const chat = getContext().chat ?? [];
    let index = chat.length - 1;
    while (index >= 0 && (chat[index]?.is_user || chat[index]?.is_system)) index--;
    if (index < 0 || isOpening(index) || !activeIn(stateBefore(index))) return false;
    if (chat[index - 1]?.is_user) processUserMessage(index - 1);
    trace(`ответ #${index}: перечитываю по кнопке`);
    rereads.delete(index);
    pendingReading = readReply(index, { force: true, strict: true }).finally(() => { pendingReading = null; });
    return true;
}

/** A new reply, or one continued: whatever it says now is read. */
async function onMessageReceived(messageId) {
    const index = Number(messageId);
    hideTagIn(messageId);
    if (!activeIn(stateBefore(index)) && !(await autoEnable(index))) return;
    pendingReading = readReply(index, { strict: true }).finally(() => { pendingReading = null; });
}

/** Her edit is read anew; a swipe or another extension's update only when the story itself is different. */
async function onMessageChanged(messageId, eventName) {
    const index = Number(messageId);
    setTimeout(() => hideTagIn(messageId), 0);
    if (getContext().chat?.[index]?.is_user) return onMessageSent(index);
    if (!activeIn(stateBefore(index)) && !(await autoEnable(index))) return;
    pendingReading = readReply(index, { strict: eventName === 'MESSAGE_EDITED' }).finally(() => { pendingReading = null; });
}

/**
 * A chat opened with its latest reply never read (the page was closed while reading, or the reading was lost):
 * read it now, so the story does not stand still at an older reply.
 */
function readMissed() {
    const chat = getContext().chat ?? [];
    const index = chat.length - 1;
    const message = chat[index];
    if (!message || message.is_user || message.is_system || isOpening(index) || pendingReading) return;
    if (message.extra?.stork?.[message.swipe_id ?? 0] || !activeIn(stateBefore(index))) return;
    trace(`ответ #${index} не был прочитан: читаю при открытии чата`);
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
                    <label for="stork_view"><small>Как показывать в чате</small></label>
                    <select id="stork_view" class="text_pole">
                        <option value="both">инфоблок и полоса над полем ввода</option>
                        <option value="block">только инфоблок под ответом</option>
                        <option value="bar">только полоса над полем ввода</option>
                        <option value="window">ничего, только окно Stork</option>
                    </select>
                    <small>Всё остальное — в окне: персонажи, цикл, беременность, журнал, где стоит инфоблок и что в нём. Окно открывают палочка, полоса над полем ввода и команда /stork.</small>
                </div>
            </div>
        </div>`);
    $('#stork_open').on('click', () => openStork());
    $('#stork_view').val(currentView()).on('change', function () {
        Object.assign(settings(), VIEWS[this.value] ?? VIEWS.both);
        saveSettingsDebounced();
        changed();
    });
}

/** The same choice made in the window shows here too. */
function syncDrawer() {
    const select = document.getElementById('stork_view');
    if (select && select.value !== currentView()) select.value = currentView();
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
    onStateChange(syncDrawer);
    onRetry(retry);
    onReread(rereadLatest);
    watchChat();
    watchErrors();

    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, stripTagsFromPrompt);
    eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, stripTagsFromTextPrompt);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    if (event_types.MESSAGE_SENT) eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
    for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED']) {
        if (event_types[name]) eventSource.on(event_types[name], () => setGenerationState(null));
    }
    for (const name of ['MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED']) {
        if (event_types[name]) eventSource.on(event_types[name], messageId => onMessageChanged(messageId, name));
    }
    for (const name of ['CHAT_CHANGED', 'MESSAGE_DELETED']) {
        if (event_types[name]) {
            eventSource.on(event_types[name], () => {
                if (name === 'CHAT_CHANGED') {
                    resetBlock();
                    rereads.clear();
                    latestRead.clear();
                    setTimeout(readMissed, 1000);
                }
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
