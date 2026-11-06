/*
 * «Перестал отслеживать!»: why Stork is not tracking, from what it knows about itself — the switches, the chat's
 * state and how the last requests went. And the cleaner for the report: no story, no names, no cards.
 * Pure: no SillyTavern imports, tested in Node.
 */

const MODEL = r => [r.api, r.model].filter(Boolean).join(' · ') || 'модель';
const count = (list, f) => list.filter(f).length;

/**
 * @param {object} o
 * @param {object} o.settings Stork's settings
 * @param {object} o.state the chat's state now
 * @param {boolean} o.active Stork works in this chat now
 * @param {string} o.readChoice the analysis connection in words ('ОШИБКА: …' when it cannot be used)
 * @param {Array} o.history requestHistory(), oldest first
 * @param {Array} o.unread indexes of the bot's recent replies that have no Stork record
 * @param {number} [o.now]
 * @returns {Array<{ problem: string, why: string, help: string }>} the likeliest first
 */
export function diagnose({ settings: s, state, active, readChoice = '', history = [], unread = [], now = Date.now() }) {
    const out = [];
    const add = (problem, why, help) => out.push({ problem, why, help });
    if (!s.enabled) add('Stork выключен везде', 'переключатель «вкл/выкл» в окне Stork стоит на «выкл»', 'включить переключатель в шапке окна Stork');
    if (state?.minorBlocked) add('Stork заблокирован в этом чате', 'в карточке или персоне персонаж младше 18 — так задумано', 'ничего: в таких чатах Stork не работает');
    if (state?.chatOff) add('Stork выключен в этом чате', 'нажата кнопка «Не включать в этом чате»', 'Stork → «Настройки» → «Этот чат» → включить снова');
    if (s.enabled && !state?.setupDone && !state?.chatOff && !state?.minorBlocked) {
        add('Stork ещё не включился в этом чате', 'он включается на первом сообщении пользователя; если чтение карточек не прошло, он ждёт', 'окно Stork → «Включить сейчас»; если не получается — смотри ошибки запросов ниже');
    }
    if (s.readMode === 'tag' && active && unread.length) {
        add('РП-модель не ставит скрытую метку', `в режиме «скрытая метка» ответы без метки не читаются: не прочитано ${unread.length}`, 'Stork → «Настройки» → «Чтение РП» → «отдельный анализ каждого ответа»');
    }
    if (s.readMode === 'analyzer' && readChoice.startsWith('ОШИБКА')) add('Профиль для анализа не работает', readChoice.replace(/^ОШИБКА:\s*/, ''), 'Stork → «Настройки» → «Чтение РП» → выбрать профиль заново и нажать «Проверить подключение»');

    // the requests of the last day, newest last
    const recent = history.filter(r => now - (r.at ?? 0) < 24 * 3600 * 1000);
    const scene = recent.filter(r => r.kind === 'scene').slice(-20);
    const failed = scene.filter(r => r.outcome !== 'ok');
    const lastOk = [...scene].reverse().find(r => r.outcome === 'ok');
    const sinceOk = lastOk ? scene.slice(scene.indexOf(lastOk) + 1) : scene;
    const byOutcome = kind => failed.filter(r => r.outcome === kind);
    const models = list => [...new Set(list.map(MODEL))].join(', ');

    const filter = byOutcome('filter');
    if (filter.length) {
        const native = [...new Set(filter.map(r => r.native).filter(Boolean))].join(', ');
        add(`Фильтр модели не пропустил текст (${filter.length} из ${scene.length})`,
            `${models(filter)} отказывается читать${native ? ` (${native})` : ''} — обычно откровенные сцены; Stork тогда читает ответ без режиссёра близости`,
            'Stork → «Настройки» → «Близость» → «Модель для откровенных сцен»: выбрать модель без такого фильтра (например, DeepSeek); или сменить модель анализа');
    }
    const thinking = byOutcome('thinking');
    if (thinking.length) add(`Модель думает дольше лимита (${thinking.length} раз)`, `${models(thinking)} тратит все токены на размышления и не успевает ответить`, 'выбрать для анализа модель без долгих размышлений (Flash-версии) или выключить размышления в профиле');
    const timeout = byOutcome('timeout');
    if (timeout.length) add(`Модель не отвечает (${timeout.length} раз)`, `${models(timeout)} не ответила за 2 минуты: роутер перегружен или модель зависла`, 'выбрать другой профиль для анализа или повторить позже');
    const http = byOutcome('error');
    if (http.length) {
        const codes = [...new Set(http.map(r => r.http).filter(Boolean))];
        const what = codes.includes(401) || codes.includes(403) ? 'ключ API не принят или нет доступа к модели'
            : codes.includes(402) ? 'закончились деньги или кредиты у провайдера'
            : codes.includes(429) ? 'слишком много запросов: провайдер ограничил'
            : codes.some(c => c >= 500) ? 'ошибка на стороне провайдера или роутера'
            : 'запрос не прошёл';
        add(`Ошибки подключения (${http.length} раз${codes.length ? `, коды ${codes.join(', ')}` : ''})`, `${models(http)}: ${what}`, codes.includes(402) ? 'пополнить баланс или выбрать другой профиль' : 'проверить профиль кнопкой «Проверить подключение» или выбрать другой');
    }
    const empty = byOutcome('empty');
    if (empty.length) add(`Пустой ответ без объяснения (${empty.length} раз)`, `${models(empty)} вернула пустоту${empty.some(r => r.providerError) ? ' с ошибкой провайдера' : ''}: часто так роутер прячет отказ или перегрузку`, 'повторить; если повторяется — другой профиль для анализа');
    const json = byOutcome('bad-json');
    if (json.length) add(`Ответ не в нужном формате (${json.length} раз)`, `${models(json)} отвечает не JSON-ом`, 'выбрать для анализа другую модель (лучше всего справляются Flash и DeepSeek)');
    const noConn = byOutcome('no-connection');
    if (noConn.length) add('Запрос не отправлен', noConn.at(-1).err || 'профиль подключения не найден', 'Stork → «Настройки» → «Чтение РП» → выбрать профиль');

    if (active && s.readMode === 'analyzer' && unread.length && !failed.length) {
        add(`Не прочитано ответов: ${unread.length}`, 'ошибок в запросах нет: возможно, страницу перезагрузили или ответы пришли, пока Stork был выключен', 'кнопка «Перечитать» в окне Stork или свайп ответа');
    }
    if (sinceOk.length >= 3 && sinceOk.every(r => r.outcome !== 'ok')) {
        out.unshift({ problem: `Подряд не прошло запросов: ${sinceOk.length}`, why: 'с последнего удачного анализа ничего не прочитано', help: 'начни с первой причины ниже' });
    }
    if (!out.length) add('Явной причины не видно', 'выключателей нет, ошибок в запросах за сутки нет', 'опиши, что именно перестало обновляться (время, цикл, режиссёр); повтори проблему и сразу скачай отчёт');
    return out;
}

/**
 * Removes the story from a line: the names of everyone in it, quotes, links.
 * @param {string} text
 * @param {string[]} names the names in this chat: hers, his, the family's, the persona's
 */
export function scrub(text, names = []) {
    let t = String(text ?? '');
    t = t.replace(/https?:\/\/\S+/gi, '[ссылка]');
    t = t.replace(/«[^»]{0,600}»/g, '«…»').replace(/"[^"\n]{25,600}"/g, '"…"');
    const words = [...new Set(names.flatMap(n => String(n ?? '').split(/[\s,.()]+/)).filter(w => w.length >= 3))]
        .sort((a, b) => b.length - a.length);
    for (const w of words) {
        // the name and its Russian endings: Нина, Нины, Ниной; Игорь, Игоря, Игорем
        const stem = w.length >= 4 && /[аяьйео]$/i.test(w) ? w.slice(0, -1) : w;
        const safe = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        t = t.replace(new RegExp(`(?<![\\p{L}])${safe}\\p{L}{0,3}(?![\\p{L}])`, 'giu'), '[имя]');
    }
    return t;
}

/** The provider's raw answer without its text: finish reasons, usage, errors stay. */
export function scrubShape(data, names = []) {
    let value;
    try { value = typeof data === 'string' ? JSON.parse(data) : data; } catch { return null; }
    if (!value || typeof value !== 'object') return null;
    const TEXT_KEYS = /^(content|text|reasoning|reasoning_content|reasoning_details|refusal|parts)$/i;
    const walk = v => {
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') {
            const o = {};
            for (const [k, x] of Object.entries(v)) {
                o[k] = TEXT_KEYS.test(k) ? (typeof x === 'string' ? `[${x.length} знаков]` : '[скрыто]') : walk(x);
            }
            return o;
        }
        return typeof v === 'string' ? scrub(v, names).slice(0, 300) : v;
    };
    return JSON.stringify(walk(value), null, 2);
}

/**
 * The last guard before a report leaves the browser: whatever looks like a key, a token, a password or an address is
 * cut out — even if a provider's error message echoed it. The model's name stays (gpt-5.6-sol is fine).
 */
export function redactSecrets(text) {
    return String(text ?? '')
        // keys of the known providers and a «Bearer …» header
        .replace(/\b(?:sk|sk-ant|sk-proj|sk-or|rk|pk|gsk|xai|hf|ghp|gho|ghu|ghs|glpat|r8|nvapi|pplx|fw|csk)[-_][A-Za-z0-9_\-]{6,}/g, '[ключ скрыт]')
        .replace(/\bAIza[0-9A-Za-z_\-]{20,}/g, '[ключ скрыт]')
        .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=\-]{8,}/gi, '$1 [скрыто]')
        // «api_key: …», «"password": "…"», «x-api-key=…»
        .replace(/((?:api[_-]?key|x-api-key|apikey|secret|token|access[_-]?token|password|passwd|authorization|auth)["']?\s*[:=]\s*["']?)(?!Bearer\b|Basic\b)[^\s"',;}]{4,}/gi, '$1[скрыто]')
        // addresses: a custom endpoint or a proxy can carry a key in itself
        .replace(/\b(?:https?|wss?):\/\/[^\s"'<>)\]]+/gi, '[адрес скрыт]')
        .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[ip скрыт]')
        // any long opaque run of letters and digits (a token, a session id)
        .replace(/\b(?=[A-Za-z0-9_\-]*\d)(?=[A-Za-z0-9_\-]*[A-Za-z])[A-Za-z0-9_\-]{32,}\b/g, '[скрыто]');
}
