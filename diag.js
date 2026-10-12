/*
 * The problem report: «Скопировать отчёт о проблеме». Stork remembers its last requests to the reading model
 * (what was asked, what came back, how long it took, the error) and its own notes; the report puts them together
 * with the settings, the connection and the chat's state, ready to paste into a message.
 */
import { extensionNames, getContext } from '../../../extensions.js';
import { cycleInfo } from './biology.js';
import { getProfiles } from './cards.js';
import { cleanRpText, dateLabel } from './engine.js';
import { currentState, readStatus, settings } from './store.js';

const MAX_CALLS = 4;
const MAX_NOTES = 40;
const calls = [];
const notes = [];
const now = () => new Date().toISOString();
const cut = (text, max) => {
    const s = String(text ?? '');
    return s.length > max ? `${s.slice(0, max)}… [ещё ${s.length - max} знаков]` : s;
};
/** The start and the end of a long text: the middle of a role-play reply says least about a problem. */
const ends = (text, head, tail) => {
    const s = String(text ?? '');
    return s.length > head + tail + 20 ? `${s.slice(0, head)}\n… [пропущено ${s.length - head - tail} знаков] …\n${s.slice(-tail)}` : s;
};

/** A note of Stork's own (what it read, threw away, failed at): also goes to the browser console. */
export function trace(text, level = 'info') {
    notes.push({ at: now(), level, text: cut(text, 400) });
    if (notes.length > MAX_NOTES) notes.shift();
    console[level === 'warn' ? 'warn' : 'info'](`[Stork] ${text}`);
}

/**
 * One request to the reading model, as it went.
 * @param {object} call { kind, profileId, maxTokens, system, prompt, response, text, error, ms }
 */
export function recordCall(call) {
    calls.push({ at: now(), ...call });
    if (calls.length > MAX_CALLS) calls.shift();
}

/** Errors thrown inside Stork's own files reach the report too. */
export function watchErrors() {
    const ours = value => /\/Stork\//.test(String(value?.stack ?? value?.filename ?? ''));
    window.addEventListener('error', event => {
        if (ours(event.error) || ours(event)) trace(`ошибка в коде: ${event.message}`, 'warn');
    });
    window.addEventListener('unhandledrejection', event => {
        if (ours(event.reason)) trace(`ошибка в коде: ${event.reason?.message ?? event.reason}`, 'warn');
    });
}

// #region The report

const describeProfile = id => {
    if (!id) return 'текущее подключение';
    const p = getProfiles().find(x => x.id === id);
    return p ? `профиль «${p.name}» · ${p.api ?? '?'} · ${p.model ?? '?'}` : `профиль ${id} (на этом устройстве его нет)`;
};

/** The shape of what the model sent back, without the long texts: is there content, reasoning, a finish reason. */
function shape(value) {
    try {
        return cut(JSON.stringify(value, (key, v) => (typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}… [${v.length} знаков]` : v)), 1500);
    } catch {
        return String(value);
    }
}

async function versions() {
    const read = async url => {
        try {
            const response = await fetch(url, { cache: 'no-store' });
            return response.ok ? await response.json() : null;
        } catch {
            return null;
        }
    };
    const [st, manifest] = await Promise.all([read('/version'), read(new URL('./manifest.json', import.meta.url))]);
    return {
        stork: manifest?.version ?? '?',
        tavern: st ? `${st.pkgVersion ?? '?'}${st.gitBranch ? ` (${st.gitBranch} ${String(st.gitRevision ?? '').slice(0, 7)})` : ''}` : '?',
    };
}

function stateLines() {
    const st = currentState();
    const f = st.people?.user?.female;
    const lines = [];
    const hh = String(Math.floor(st.clock.minutes / 60)).padStart(2, '0');
    const mm = String(st.clock.minutes % 60).padStart(2, '0');
    lines.push(`включён в чате: ${st.setupDone ? 'да' : 'нет'}${st.chatOff ? ', выключен в этом чате' : ''}${st.minorBlocked ? ', заблокирован (возраст)' : ''}`);
    lines.push(`время истории: день ${st.clock.day}, ${dateLabel(st, st.clock.day, { day: 'numeric', month: 'long', year: 'numeric' })} ${hh}:${mm}, дата ${st.dateSure ? 'из истории' : 'примерная'}`);
    if (f) {
        const ci = cycleInfo(f, st.clock.day);
        lines.push(`она: ${st.people.user.name} (${st.people.user.age}), цикл ${f.cycleLength} дн., день ${ci.cycleDay}, ${ci.phaseLabel}, контрацепция ${f.contraception}`
            + `${f.pregnancy ? `, беременность (знают: ${f.pregnancy.knownBy.join(', ') || 'никто'}${f.pregnancy.labor ? ', роды' : ''})` : ''}${f.postpartum ? ', после родов' : ''}`);
    }
    const m = st.people?.char;
    if (m) lines.push(`он: ${m.name} (${m.age}), фертильность ${m.male.fertility}, привычки за 3 дня: ${m.male.lifestyle.filter(e => st.clock.day - e.day <= 3).map(e => e.type).join(', ') || 'нет'}`);
    lines.push(`близость: всего ${st.acts.length}, последняя: ${st.acts.at(-1) ? `день ${st.acts.at(-1).day}, ${st.acts.at(-1).protection}` : 'нет'}`);
    for (const key of ['user', 'char']) {
        const l = st.live?.[key];
        if (l) lines.push(`заметка (${key}): ${l.mood ?? 'нет'} / ${cut(l.note ?? 'нет', 200)} (записана в минуту ${l.at})`);
    }
    if (st.pending?.length) lines.push(`ждёт модели: ${st.pending.map(e => e.text).join('; ')}`);
    lines.push('журнал (последнее):');
    for (const e of st.log.slice(-8)) lines.push(`  день ${e.day} [${e.kind}] ${e.text}`);
    return lines;
}

function chatLines() {
    const chat = getContext().chat ?? [];
    const lines = [`сообщений в чате: ${chat.length}`];
    const from = Math.max(0, chat.length - 4);
    for (let i = from; i < chat.length; i++) {
        const m = chat[i];
        const swipe = m.swipe_id ?? 0;
        const snap = m.extra?.stork?.[swipe];
        lines.push(`#${i} ${m.is_user ? 'она' : m.is_system ? 'система' : 'бот'}, свайп ${swipe + 1}/${m.swipes?.length ?? 1}, ${String(m.mes ?? '').length} знаков, `
            + `запись Stork: ${snap ? `есть${snap.skip ? ` (перемотка ${snap.skip} мин)` : ''}${snap.fromHints ? ', по анализу' : ''}` : 'НЕТ'}`);
        lines.push(`   «${cut(cleanRpText(m.mes).replace(/\s+/g, ' '), 220)}»`);
    }
    return lines;
}

/** The whole report, as text to paste. */
export async function buildReport() {
    const ctx = getContext();
    const s = settings();
    const v = await versions();
    const rs = readStatus();
    const out = [];
    const section = title => out.push('', `=== ${title} ===`);
    out.push('ОТЧЁТ STORK', `время: ${now()}`, `Stork ${v.stork} · SillyTavern ${v.tavern}`, `браузер: ${globalThis.navigator?.userAgent ?? '?'}`);

    section('Настройки');
    out.push(`чтение РП: ${s.readMode === 'analyzer' ? 'анализ каждого ответа' : 'скрытая метка'} · через: ${describeProfile(s.readProfile)}`);
    out.push(`основное подключение: ${ctx.mainApi ?? '?'} · ${ctx.onlineStatus ?? '?'}${ctx.mainApi === 'openai' ? ` · ${ctx.getChatCompletionModel?.() ?? '?'}` : ''}`);
    out.push(`статус для модели: ${s.placement}, подробный ${s.detailed}, мягкие слова ${s.neutral} · включён везде: ${s.enabled}`);
    out.push(`сейчас: ${rs.index !== null ? `читаю ответ #${rs.index}` : 'не читаю'}${rs.failed ? ` · последняя ошибка: ответ #${rs.failed.index}: ${rs.failed.error}` : ''}`);
    out.push(`другие расширения: ${extensionNames.filter(n => !/Stork$/i.test(n)).map(n => n.replace(/^third-party\//, '')).join(', ') || 'нет'}`);

    section('Последние запросы к модели-анализатору');
    if (!calls.length) out.push('с открытия страницы запросов не было');
    for (const [i, c] of [...calls].reverse().entries()) {
        out.push(`--- ${i + 1}. ${c.kind === 'cards' ? 'чтение карточек' : 'анализ сцены'} · ${c.at} · ${c.ms} мс · ${describeProfile(c.profileId)} · лимит ${c.maxTokens} токенов`);
        out.push(`итог: ${c.error ? `ОШИБКА: ${c.error}` : 'разобрано'}`);
        out.push(`ответ модели (${String(c.text ?? '').length} знаков):`, c.text ? ends(c.text, 1500, 600) : '[ПУСТО]');
        if (c.response !== undefined) out.push(`что вернуло подключение: ${shape(c.response)}`);
        out.push(`запрос (${String(c.prompt ?? '').length} знаков):`, ends(c.prompt, 600, 900));
    }

    section('Заметки Stork');
    if (!notes.length) out.push('нет');
    for (const n of notes.slice(-20)) out.push(`${n.at} ${n.level === 'warn' ? '⚠ ' : ''}${n.text}`);

    section('Состояние Stork в этом чате');
    try {
        out.push(...stateLines());
    } catch (error) {
        out.push(`не удалось прочитать: ${error?.message ?? error}`);
    }

    section('Последние сообщения');
    out.push(...chatLines());
    return out.join('\n');
}

// #endregion
