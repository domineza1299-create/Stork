/*
 * The problem report: «Скачать журнал». A text file with the versions, the settings, the connection really used,
 * the chat's state, the last messages and the whole log (every request with its reason and result), ready
 * to send to the developer. No API keys go into it: profiles keep keys in SillyTavern's secrets, not here.
 */
import { extensionNames, getContext } from '../../../extensions.js';
import { cycleInfo } from './biology.js';
import { describeChoice } from './connection.js';
import { cleanRpText, dateLabel } from './engine.js';
import { logEvent, logText } from './log.js';
import { currentState, otherClock, readStatus, settings } from './store.js';

const cut = (text, max) => {
    const s = String(text ?? '');
    return s.length > max ? `${s.slice(0, max)}… [ещё ${s.length - max} знаков]` : s;
};

/** A note of Stork's own (what it read, threw away, failed at): into the log and the browser console. */
export function trace(text, level = 'info') {
    logEvent(level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'info', 'stork', text);
    // the «·» keeps the console capture from logging the same line twice
    console[level === 'warn' || level === 'error' ? 'warn' : 'info'](`[Stork]· ${text}`);
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
    const claim = st.pregnancyClaim;
    if (claim) lines.push(`беременность из истории: ${claim.status}${claim.kind === 'term' ? ' (срок)' : ''}, ${claim.weeks} нед. ${claim.days ?? 0} дн.${claim.guessed ? ', срок примерный' : ''}${claim.edited ? ', срок поправлен вручную' : ''}, день ${claim.day}${claim.quote ? ` · «${cut(claim.quote, 120)}»` : ''}`);
    if (st.pending?.length) lines.push(`ждёт модели: ${st.pending.map(e => e.text).join('; ')}`);
    lines.push('журнал истории (последнее):');
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

/** The whole report as text. */
export async function buildReport() {
    const ctx = getContext();
    const s = settings();
    const v = await versions();
    const rs = readStatus();
    const out = [];
    const section = title => out.push('', `=== ${title} ===`);
    out.push(`Stork ${v.stork} — журнал, ${new Date().toISOString()}`, `SillyTavern ${v.tavern}`, `браузер: ${globalThis.navigator?.userAgent ?? '?'}`);

    section('Настройки');
    out.push(`чтение РП: ${s.readMode === 'analyzer' ? 'анализ каждого ответа' : 'скрытая метка'}`);
    out.push(`анализ через: ${describeChoice(s.readProfile)} (сохранено: ${s.readProfile || 'не выбрано'})`);
    out.push(`основное подключение: ${ctx.mainApi ?? '?'} · ${ctx.onlineStatus ?? '?'}${ctx.mainApi === 'openai' ? ` · ${ctx.getChatCompletionModel?.() ?? '?'}` : ''}`);
    out.push(`статус для модели: ${s.placement}, подробный ${s.detailed}, мягкие слова ${s.neutral} · включён везде: ${s.enabled} · промпты в журнал: ${!!s.debugPrompts}`);
    out.push(`время в статусе для РП-модели: ${otherClock() ? `не передаётся, время ведёт ${otherClock()}` : 'передаётся'} · служебные строки [MN: …] и <horae> Stork не читает`);
    out.push(`сейчас: ${rs.index !== null ? `читаю ответ #${rs.index}` : 'не читаю'}${rs.failed ? ` · последняя ошибка: ответ #${rs.failed.index}: ${rs.failed.error}` : ''}`);
    out.push(`другие расширения: ${extensionNames.filter(n => !/Stork$/i.test(n)).map(n => n.replace(/^third-party\//, '')).join(', ') || 'нет'}`);

    section('Состояние Stork в этом чате');
    try {
        out.push(...stateLines());
    } catch (error) {
        out.push(`не удалось прочитать: ${error?.message ?? error}`);
    }

    section('Последние сообщения');
    try {
        out.push(...chatLines());
    } catch (error) {
        out.push(`не удалось прочитать: ${error?.message ?? error}`);
    }

    section('Журнал (старое сверху)');
    out.push(logText() || 'пусто');
    return out.join('\n');
}

/** Saves the report as a .txt file. */
export async function downloadReport() {
    const text = await buildReport();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `stork-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
