/*
 * Every request Stork makes to a model goes through here: one place decides which connection is used,
 * and every request lands in the log with its reason, the connection it really went through and the result.
 *
 * The connection is chosen like in Connection Manager: a profile from the list. A profile that is chosen but
 * no longer exists is an error, never a quiet switch to another model: before, Stork silently fell back to the
 * main connection and the requests went where she did not expect.
 */
import { getContext } from '../../../extensions.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { logEvent } from './log.js';
import { settings } from './store.js';

/** The main SillyTavern connection, chosen on purpose (not a missing profile). */
export const CURRENT = 'current';

/** The error and what caused it («API request failed» says little without its cause). */
export const errorText = error => [error?.message ?? String(error), error?.cause?.message ?? (error?.cause ? String(error.cause) : '')].filter(Boolean).join(': ');

/** Profiles Stork can use; empty when Connection Manager is off. */
export function getProfiles() {
    try {
        return ConnectionManagerRequestService.getSupportedProfiles();
    } catch {
        return [];
    }
}

export function connectionManagerOn() {
    try {
        ConnectionManagerRequestService.getSupportedProfiles();
        return true;
    } catch {
        return false;
    }
}

/**
 * Not chosen yet: the first profile, as Connection Manager lists them (the choice is saved, so it does not
 * drift when profiles are added). No profiles at all: the main connection.
 * @returns {string} the saved choice after this
 */
export function ensureProfileChoice(settings, save) {
    if (settings.readProfile) return settings.readProfile;
    const first = getProfiles()[0];
    settings.readProfile = first ? first.id : CURRENT;
    save?.();
    logEvent('info', 'connection', first ? `профиль для анализа не был выбран: взят первый, «${first.name}»` : 'профилей подключения нет: анализ идёт через основное подключение SillyTavern');
    return settings.readProfile;
}

/**
 * What a request will really go through.
 * @returns {{kind: 'profile', id: string, profile: object, label: string} | {kind: 'current', label: string}}
 * @throws when the chosen profile is gone or cannot be used
 */
export function resolveConnection(choice) {
    if (!choice || choice === CURRENT) {
        const ctx = getContext();
        const model = ctx.mainApi === 'openai' ? ctx.getChatCompletionModel?.() : ctx.onlineStatus;
        return { kind: 'current', label: `основное подключение SillyTavern · ${ctx.mainApi ?? '?'} · ${model ?? '?'}` };
    }
    if (!connectionManagerOn()) throw new Error('Connection Manager выключен в расширениях SillyTavern, а Stork настроен читать через профиль. Включи его или выбери в Stork «Основное подключение»');
    const all = getContext().extensionSettings?.connectionManager?.profiles ?? [];
    const profile = all.find(p => p.id === choice);
    if (!profile) throw new Error('Выбранный в Stork профиль подключения не найден (удалён или переименован в другом месте). Открой Stork → Настройки и выбери профиль заново');
    if (!getProfiles().some(p => p.id === choice)) throw new Error(`Профиль «${profile.name}» не подходит: Stork работает только с Chat Completion и Text Completion профилями, где указана модель`);
    return { kind: 'profile', id: profile.id, profile, label: describeProfile(profile) };
}

export const describeProfile = p => `профиль «${p.name}» · ${p.api ?? '?'} · ${p.model || '?'}${p.preset ? ` · пресет ${p.preset}` : ''}`;

/** For the settings and the report: what the saved choice means right now, without throwing. */
export function describeChoice(choice) {
    try {
        return resolveConnection(choice).label;
    } catch (error) {
        return `ОШИБКА: ${error.message}`;
    }
}

function extractText(result) {
    if (typeof result === 'string') return result;
    const content = result?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(part => part?.text ?? '').join('');
    return '';
}

/**
 * The raw answer of the API, not just its text: finish_reason and the token usage show whether the reply
 * was cut by the token limit. Reasoning models (Kimi, DeepSeek, Gemini thinking…) spend part of the limit
 * on thinking, and some routers then put a placeholder `""` into content instead of leaving it empty.
 */
function readRaw(raw) {
    const choice = raw?.choices?.[0];
    if (!choice) return { text: extractText(raw), finish: '', reasoningTokens: 0, completionTokens: 0, reasoningChars: 0 };
    const message = choice.message ?? {};
    let text = '';
    if (typeof message.content === 'string') text = message.content;
    else if (Array.isArray(message.content)) text = message.content.map(part => part?.text ?? '').join('');
    else if (typeof choice.text === 'string') text = choice.text;
    const reasoning = message.reasoning ?? message.reasoning_content ?? '';
    return {
        text,
        finish: String(choice.finish_reason ?? choice.stop_reason ?? ''),
        reasoningTokens: Number(raw?.usage?.completion_tokens_details?.reasoning_tokens ?? 0),
        completionTokens: Number(raw?.usage?.completion_tokens ?? 0),
        reasoningChars: typeof reasoning === 'string' ? reasoning.length : 0,
    };
}

/** `""`, `''`, an empty code fence: what routers send instead of nothing. */
const isEmptyText = text => !String(text ?? '').replace(/```[a-z]*|["'`\s]/gi, '').trim();
const isCutByLimit = finish => /^(length|max_tokens|max_output_tokens)$/i.test(finish);

/** Thrown when the reply was cut by the token limit; carries what the log needs. */
export class TruncatedError extends Error {
    constructor(message, info) {
        super(message);
        this.name = 'TruncatedError';
        this.info = info;
    }
}

/** How far Stork raises the limit by itself when a reasoning model runs out of it. */
const MAX_AUTO_TOKENS = 16000;

/**
 * Requests are counted per reply and swipe. A second request for the very same text means something triggered
 * Stork twice: the log marks it as a warning. A new request after a continue or an edit is normal and only noted.
 */
const perReply = new Map();
export const forgetReplyCounts = () => perReply.clear();

function countReply(source, replyKey, replyHash, reason) {
    const seen = perReply.get(replyKey) ?? [];
    const repeat = seen.some(item => item.hash === replyHash);
    seen.push({ hash: replyHash, reason });
    perReply.set(replyKey, seen);
    if (seen.length < 2) return;
    const [index, swipe] = replyKey.split(':');
    const text = `${seen.length}-й запрос по ответу #${index} (свайп ${Number(swipe) + 1}). Причины по порядку: ${seen.map(item => item.reason).join(' → ')}`;
    logEvent(repeat ? 'warn' : 'info', source, repeat ? `${text}. Текст ответа тот же, что в прошлый раз — лишний запрос` : text);
}

/**
 * One request to the model. The log gets: why, through what, how big, how long, and what came back.
 * @param {object} request
 * @param {string} request.kind 'scene' | 'cards' | 'test'
 * @param {string} request.reason why this request is made now (shown in the log)
 * @param {string} [request.replyKey] `${index}:${swipe}` of the reply read automatically
 * @param {number} [request.replyHash] the story hash of that reply
 * @param {string} request.system
 * @param {string} request.prompt
 * @param {number} request.maxTokens
 * @param {string} request.choice the saved connection choice (profile id or 'current')
 * @returns {Promise<string>}
 */
/** A request that hangs (the provider never answers) is given up after this long: the reading shows «Повторить». */
const REQUEST_TIMEOUT_MS = 120000;

/** The answer, or an error after `ms`; the request itself is aborted when the connection lets us. */
function withTimeout(start, ms) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            controller?.abort();
            reject(new Error(`модель не ответила за ${Math.round(ms / 1000)} с (подключение зависло?) — нажми «Повторить»`));
        }, ms);
    });
    return Promise.race([start(controller?.signal), timeout]).finally(() => clearTimeout(timer));
}

export async function requestModel({ kind, reason, replyKey = '', replyHash = 0, system, prompt, maxTokens, choice }) {
    const source = { scene: 'анализ сцены', cards: 'чтение карточек', test: 'проверка подключения' }[kind] ?? kind;
    const started = performance.now();
    const full = !!settings().debugPrompts;
    let connection;
    try {
        connection = resolveConnection(choice);
    } catch (error) {
        logEvent('error', source, `${reason}: запрос не отправлен — ${error.message}`);
        throw error;
    }
    if (replyKey) countReply(source, replyKey, replyHash, reason);
    logEvent('request', source, `${reason} · ${connection.label} · ${system.length + prompt.length} знаков · лимит ${maxTokens} токенов`,
        full ? `SYSTEM:\n${system}\n\nUSER:\n${prompt}` : undefined);

    let limit = maxTokens;
    for (let attempt = 1; ; attempt++) {
        let result;
        const attemptStarted = performance.now();
        try {
            if (connection.kind === 'profile') {
                const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
                // text completion profiles need the messages turned into one prompt with the profile's instruct template
                const built = ConnectionManagerRequestService.constructPrompt(messages, connection.id);
                // extractData: false — the raw answer keeps finish_reason and usage, so a cut reply is seen as cut
                result = await withTimeout(signal => ConnectionManagerRequestService.sendRequest(connection.id, built, limit,
                    { stream: false, signal, extractData: false, includePreset: false, includeInstruct: false }), REQUEST_TIMEOUT_MS);
            } else {
                result = await withTimeout(() => getContext().generateRaw({ prompt, systemPrompt: system, responseLength: limit }), REQUEST_TIMEOUT_MS);
            }
        } catch (error) {
            logEvent('error', source, `${Math.round(performance.now() - started)} мс · ${errorText(error)}`, error?.cause ?? error);
            throw error;
        }
        const read = readRaw(result);
        const text = String(read.text ?? '');
        const ms = Math.round(performance.now() - attemptStarted);
        const tokens = read.completionTokens
            ? ` · потрачено ${read.completionTokens} ток.${read.reasoningTokens ? `, из них на размышления ${read.reasoningTokens}` : ''}`
            : (read.reasoningChars ? ` · размышления ${read.reasoningChars} знаков` : '');

        if (isCutByLimit(read.finish)) {
            const thinkingAteAll = isEmptyText(text);
            const why = thinkingAteAll
                ? `модель потратила весь лимит ${limit} токенов на размышления и не успела ответить`
                : `ответ обрезан лимитом ${limit} токенов`;
            if (limit < MAX_AUTO_TOKENS) {
                const next = Math.min(MAX_AUTO_TOKENS, limit * 2);
                logEvent('warn', source, `${ms} мс · ${why}${tokens}. Повторяю с лимитом ${next}`, text || undefined);
                limit = next;
                continue;
            }
            logEvent('error', source, `${ms} мс · ${why}${tokens}`, text || shape(result));
            throw new TruncatedError(`${why}. Выбери в Stork модель без долгих размышлений (например, Flash) или ту, где размышления можно выключить`, { limit, ...read });
        }
        if (isEmptyText(text)) {
            logEvent('error', source, `${ms} мс · модель вернула пустой ответ${read.finish ? ` (finish_reason: ${read.finish})` : ''}${tokens}`, shape(result));
            throw new Error('модель вернула пустой ответ');
        }
        logEvent('response', source, `${ms} мс · ${text.length} знаков${tokens}${attempt > 1 ? ` · с ${attempt}-й попытки, лимит ${limit}` : ''}`, text);
        return text;
    }
}

/** The shape of what came back when it had no text: is there reasoning, a finish reason, an error. */
function shape(value) {
    try {
        return JSON.stringify(value, (key, v) => (typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}… [${v.length} знаков]` : v), 2);
    } catch {
        return String(value);
    }
}
