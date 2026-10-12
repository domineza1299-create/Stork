// Run from the extension folder: node --test tests/*.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reserveByHours } from '../biology.js';
import {
    absMinute, buildStatus, createState, liveNow, maleSnapshot, processReply, recoveryLeft, sceneToTag, storyMinutes, upgradeState, withLive,
} from '../engine.js';

const at = (h, m = 0) => h * 60 + m;

function couple() {
    const state = createState({ userName: 'Нина', charName: 'Лёша', startDate: '2026-10-10' });
    state.people.user.age = 26;
    state.people.char.age = 30;
    state.clock.minutes = at(20);
    state.setupDone = true;
    return state;
}
/** One reply read by the analysis: the same way index.js does it. */
const read = (state, scene, text = 'Текст ответа.') => processReply(state, `${text}\n${sceneToTag(scene)}`, () => 0.5, scene).state;

describe('reserve by story hours', () => {
    it('drops right after an orgasm and comes back over three days', () => {
        assert.equal(reserveByHours([], 1000).reserve, 1);
        const now = 10000;
        const right = reserveByHours([now], now);
        assert.ok(right.reserve < 0.4 && right.fullInHours === 72);
        assert.ok(reserveByHours([now], now + 36 * 60).reserve > right.reserve);
        assert.equal(reserveByHours([now], now + 73 * 60).reserve, 1);
        assert.ok(reserveByHours([now - 60, now], now).reserve < right.reserve, 'two in a row take more');
    });

    it('moves the numbers after intimacy in the same day', () => {
        let state = couple();
        const before = maleSnapshot(state, state.people.char);
        state = read(state, { minutes: 20, intimacy: { protection: 'none', finished_inside: true }, orgasm: ['char'] });
        const after = maleSnapshot(state, state.people.char);
        assert.ok(after.reserve < before.reserve);
        assert.ok(after.countNow < before.countNow);
        assert.equal(state.people.char.male.orgasms.length, 1, 'intimacy and orgasm:char in one reply are one orgasm');
    });
});

describe('recovery after an orgasm', () => {
    it('shows only after an orgasm and tells once when it ran out by story time', () => {
        let state = couple();
        assert.equal(recoveryLeft(state), 0, 'nothing to recover from');
        state = read(state, { minutes: 5, intimacy: { protection: 'condom' }, orgasm: ['char'] });
        assert.ok(recoveryLeft(state) > 0);
        state = read(state, { minutes: 10 });
        assert.ok(recoveryLeft(state) > 0);
        assert.ok(!state.log.some(e => e.kind === 'recovered'));
        state = read(state, { minutes: 60 });
        assert.equal(recoveryLeft(state), 0);
        assert.equal(state.log.filter(e => e.kind === 'recovered').length, 1);
        state = read(state, { minutes: 60 });
        assert.equal(state.log.filter(e => e.kind === 'recovered').length, 1, 'only once');
    });
});

describe('story time, not real time', () => {
    it('anchors the calendar to the first date the story names, without moving the cycle', () => {
        let state = couple();
        const cycleStart = state.people.user.female.cycleStart;
        assert.equal(state.dateSure, false);
        state = read(state, { minutes: 0, date: '2024-03-15' });
        assert.equal(state.dateSure, true);
        assert.equal(state.startDate, '2024-03-15');
        assert.equal(state.clock.day, 0);
        assert.equal(state.people.user.female.cycleStart, cycleStart);
    });

    it('jumps forward to a later date and never goes back', () => {
        let state = read(couple(), { minutes: 0, date: '2024-03-15' });
        state = read(state, { minutes: 3 * 1440, date: '2024-03-18', clock: '09:30' });
        assert.equal(state.clock.day, 3);
        assert.equal(state.clock.minutes, at(9, 30));
        state = read(state, { date: '2024-03-10' });
        assert.equal(state.clock.day, 3, 'an earlier date does not rewind');
    });

    it('moves to the part of the day the story is in', () => {
        const state = couple();
        state.clock.minutes = at(9);
        assert.equal(storyMinutes(state, { part: 'evening' }), at(19) - at(9));
        assert.equal(storyMinutes(state, { part: 'morning' }), 0, 'already morning');
        state.clock.minutes = at(20);
        assert.equal(storyMinutes(state, { part: 'evening', minutes: 15 }), 15);
    });

    it('takes the world of the story from the first reply that tells it, and keeps it', async () => {
        const { careOf } = await import('../biology.js');
        let state = couple();
        state = read(state, { minutes: 5 });
        assert.equal(careOf(state).title, 'Врач', 'nothing said yet: modern');
        state = read(state, { minutes: 5, era: 'past' });
        assert.equal(careOf(state).title, 'Повитуха');
        state = read(state, { minutes: 5, era: 'modern' });
        assert.equal(careOf(state).title, 'Повитуха', 'one reply saying otherwise does not switch it');
    });

    it('asks once when the story names another date, and moves only the dates when she agrees', async () => {
        const { setStoryDate } = await import('../setup.js');
        const { shortDate, dateWithWeekday } = await import('../engine.js');
        let state = couple();
        setStoryDate(state, '2026-05-10');
        const cycleStart = state.people.user.female.cycleStart;
        state = read(state, { minutes: 5, date: '2026-06-03' });
        assert.equal(shortDate(state), '10 мая', 'nothing moves by itself');
        const hints = s => s.log.filter(e => e.kind === 'date_hint');
        assert.equal(hints(state).length, 1);
        assert.equal(hints(state)[0].date, '2026-06-03');
        assert.match(hints(state)[0].text, /В истории 3 июня, а у Stork 10 мая/);
        state = read(state, { minutes: 5, date: '2026-06-03' });
        assert.equal(hints(state).length, 1, 'the same difference is asked once');
        // «Переставить», pressed twice: the second tap changes nothing
        const hint = hints(state)[0];
        assert.equal(setStoryDate(state, hint.date, hint.day), true);
        setStoryDate(state, hint.date, hint.day);
        assert.equal(shortDate(state), '3 июн');
        assert.equal(dateWithWeekday(state, undefined, { long: true }), 'среда, 3 июн');
        assert.equal(state.people.user.female.cycleStart, cycleStart, 'the cycle keeps its days');
        state = read(state, { minutes: 5, date: '2026-06-03' });
        assert.equal(hints(state).length, 1, 'agreed: no more questions');
        state = read(state, { minutes: 4 * 1440, date: '2026-06-07', clock: '10:00' });
        assert.equal(shortDate(state), '7 июн', 'a time skip to a later date still moves on by itself');
        assert.equal(hints(state).length, 1);
    });
});

describe('the story drives how they are', () => {
    it('keeps a bruise from becoming an illness with fever', () => {
        let state = couple();
        state = read(state, { minutes: 10, lifestyle: [{ type: 'illness', who: 'char', fever: false }], injury: [{ who: 'char', what: 'ссадина на ребре' }] });
        assert.equal(state.people.char.male.lifestyle.length, 0, 'no fever');
        assert.ok(state.log.some(e => e.kind === 'injury' && /ссадина на ребре/.test(e.text)));
        state = read(state, { minutes: 10, lifestyle: [{ type: 'illness', who: 'char', fever: true }] });
        assert.equal(state.people.char.male.lifestyle[0].type, 'fever');
    });

    it('applies how tired or eager they are, fades over half a day, and tells the model', () => {
        let state = couple();
        state = read(state, { minutes: 5, people: { char: { energy: -3, libido: 2, mood: 'вымотан', note: 'Весь день на ногах, ребро ноет.' } } });
        const live = liveNow(state, 'char');
        assert.equal(live.energy, -3);
        assert.ok(withLive(0.8, live.energy) < 0.4);
        const status = buildStatus(state, { withTag: false });
        assert.ok(status.includes('As the story shows now: вымотан — Весь день на ногах, ребро ноет.'));
        assert.ok(/tired\./.test(status));
        assert.ok(!/[а-яё]{4,} [а-яё]{4,} [а-яё]{4,}/i.test(status.replace(/As the story shows now:[^\n]*/g, '').replace(/Feels:[^.]*\./g, '')), 'instructions in English');
        state = read(state, { minutes: 13 * 60 });
        assert.equal(liveNow(state, 'char').energy, 0, 'faded');
    });

    it('upgrades an old saved state', () => {
        const old = couple();
        delete old.live;
        delete old.dateSure;
        delete old.people.char.male.orgasms;
        old.people.char.male.lastOrgasmMinute = absMinute(old.clock);
        upgradeState(old);
        assert.deepEqual(old.people.char.male.orgasms, [absMinute(old.clock)]);
        assert.deepEqual(old.live, {});
    });
});
