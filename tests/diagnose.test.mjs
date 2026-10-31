// Run from the extension folder: node --test tests/*.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diagnose, scrub, scrubShape } from '../diagnose.js';

const on = { enabled: true, readMode: 'analyzer', intimacy: true };
const ready = { setupDone: true };
const now = 1_800_000_000_000;
const req = (outcome, extra = {}) => ({ at: now - 60_000, kind: 'scene', api: 'custom', model: 'google/gemini-3.8-flash', outcome, ...extra });

describe('«Перестал отслеживать»: why', () => {
    it('names the switches first', () => {
        const f = diagnose({ settings: { ...on, enabled: false }, state: { chatOff: true }, active: false, now });
        assert.match(f[0].problem, /выключен везде/);
        assert.ok(f.some(x => /выключен в этом чате/.test(x.problem)));
    });

    it('sees a model filter and says what helps', () => {
        const f = diagnose({ settings: on, state: ready, active: true, history: [req('ok'), req('filter', { native: 'PROHIBITED_CONTENT' }), req('filter'), req('filter')], now });
        assert.match(f[0].problem, /Подряд не прошло запросов: 3/);
        const filter = f.find(x => /Фильтр модели/.test(x.problem));
        assert.match(filter.why, /PROHIBITED_CONTENT/);
        assert.match(filter.help, /Модель для откровенных сцен/);
    });

    it('tells money, keys and overload apart', () => {
        assert.match(diagnose({ settings: on, state: ready, active: true, history: [req('error', { http: 402 })], now }).find(x => /Ошибки/.test(x.problem)).why, /деньги/);
        assert.match(diagnose({ settings: on, state: ready, active: true, history: [req('error', { http: 401 })], now }).find(x => /Ошибки/.test(x.problem)).why, /ключ/);
        assert.ok(diagnose({ settings: on, state: ready, active: true, history: [req('thinking')], now }).some(x => /думает дольше/.test(x.problem)));
    });

    it('has an answer even when nothing is wrong', () => {
        const f = diagnose({ settings: on, state: ready, active: true, history: [req('ok')], now });
        assert.match(f[0].problem, /Явной причины не видно/);
    });
});

describe('the report keeps the story out', () => {
    it('removes names in any case ending, quotes and links', () => {
        const t = scrub('Нины нет, Игорем занят; «она сказала, что беременна» https://proxy.my/x Ниной', ['Нина', 'Игорь Малеев']);
        assert.doesNotMatch(t, /Нин|Игор|беременна|proxy/);
        assert.match(t, /\[имя\]/);
    });

    it('keeps the finish reasons of a raw answer, hides its text', () => {
        const raw = JSON.stringify({ choices: [{ finish_reason: 'content_filter', native_finish_reason: 'PROHIBITED_CONTENT', message: { content: 'Нина и Игорь...', role: 'assistant' } }], model: 'google/gemini-3.8-flash' });
        const out = scrubShape(raw, ['Нина']);
        assert.match(out, /PROHIBITED_CONTENT/);
        assert.doesNotMatch(out, /Игорь/);
        assert.equal(scrubShape('not json'), null);
    });
});
