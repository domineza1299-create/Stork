// Run from the extension folder: node --test tests/*.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { advanceTime, buildStatus, createState, extractDate, MINUTES_PER_DAY, processReply, removePregnancyByHand, sceneToTag, setBabySex, setPregnancyByHand } from '../engine.js';
import { setStoryClock, setupFromAnalysis } from '../setup.js';

function couple() {
    const state = createState({ userName: 'Даша', charName: 'Лёша', startDate: '2026-01-01' });
    state.people.user.age = 26;
    state.people.char.age = 30;
    state.setupDone = true;
    advanceTime(state, 20 * MINUTES_PER_DAY, () => 0.5);
    return state;
}
const preg = state => state.people.user.female.pregnancy;

describe('the date in the greeting header', () => {
    it('reads the common ways of writing it', () => {
        assert.equal(extractDate('📅 2025-03-15 | 21:00\nТекст'), '2025-03-15');
        assert.equal(extractDate('15.03.2025, суббота, 21:00'), '2025-03-15');
        assert.equal(extractDate('15 марта, 21:00', 2024), '2024-03-15');
        assert.equal(extractDate('Он вошёл в комнату.'), null);
    });

    it('wins over what the analysis guessed, and the time too', () => {
        const cards = { userName: 'Нина', charName: 'Игорь', userText: 'Нина, 24 года.', charText: 'Игорь, 33 года.', opening: '15.03.2025 | 21:00\nИгорь открыл дверь.' };
        const state = setupFromAnalysis(createState(), { start: { date: '2025-06-01', time: '09:00' } }, cards, () => 0.5);
        assert.equal(state.startDate, '2025-03-15');
        assert.equal(state.dateSure, true);
        assert.equal(state.clock.minutes, 21 * 60);
    });
});

describe('the date and time by hand', () => {
    it('puts today on the given date and sets the clock', () => {
        const state = couple(); // story day 20
        assert.equal(setStoryClock(state, { date: '2026-05-09', time: '07:30' }), true);
        assert.equal(state.clock.minutes, 7 * 60 + 30);
        assert.equal(state.dateSure, true);
        const today = new Date(`${state.startDate}T12:00:00Z`);
        today.setUTCDate(today.getUTCDate() + state.clock.day);
        assert.equal(today.toISOString().slice(0, 10), '2026-05-09');
        assert.equal(setStoryClock(state, { date: 'nonsense', time: '' }), false);
    });
});

describe('the baby\'s sex', () => {
    it('follows the story, not the dice, and stays', () => {
        const state = couple();
        setPregnancyByHand(state, { weeks: 20 }, () => 0.9);
        assert.equal(setBabySex(state, 'girl'), true);
        assert.deepEqual(preg(state).sexes, ['девочка']);
        assert.equal(preg(state).sexKnown, true);
        assert.match(buildStatus(state), /girl — settled/);
        // a later term edit does not re-roll it
        setPregnancyByHand(state, { weeks: 21 });
        assert.deepEqual(preg(state).sexes, ['девочка']);
    });

    it('comes from the reading of a reply', () => {
        const state = couple();
        setPregnancyByHand(state, { weeks: 20 }, () => 0.1);
        const scene = { minutes: 10, baby_sex: 'girl' };
        const after = processReply(state, `Врач улыбнулся: «Девочка».\n${sceneToTag(scene)}`, () => 0.5, scene).state;
        assert.deepEqual(after.people.user.female.pregnancy.sexes, ['девочка']);
    });

    it('twins with two sexes', () => {
        const state = couple();
        setPregnancyByHand(state, { weeks: 22 });
        setBabySex(state, ['girl', 'boy']);
        assert.equal(preg(state).babies, 2);
        assert.deepEqual(preg(state).sexes, ['девочка', 'мальчик']);
    });
});

describe('the whole pregnancy by hand', () => {
    it('saves twins, the sexes, the facts and cravings', () => {
        const state = couple();
        setPregnancyByHand(state, { weeks: 24 });
        const r = setPregnancyByHand(state, { weeks: 24, babies: 2, sexes: ['мальчик', 'девочка'], facts: ['УЗИ: всё хорошо', '', 'Анемия лёгкая'], cravings: 'солёное, мандарины', aversions: 'кофе' });
        assert.equal(r.ok, true);
        const p = preg(state);
        assert.equal(p.babies, 2);
        assert.deepEqual(p.sexes, ['мальчик', 'девочка']);
        assert.equal(p.sexKnown, true);
        assert.deepEqual(p.facts.map(f => f.text), ['УЗИ: всё хорошо', 'Анемия лёгкая']);
        assert.deepEqual(p.cravings, ['солёное', 'мандарины']);
        assert.deepEqual(p.aversions, ['кофе']);
        setPregnancyByHand(state, { weeks: 24, babies: 1, sexes: [''] });
        assert.equal(preg(state).babies, 1);
        assert.equal(preg(state).sexKnown, false);
    });

    it('removes it, and the cycle goes on', () => {
        const state = couple();
        setPregnancyByHand(state, { weeks: 8 });
        removePregnancyByHand(state, () => 0.5);
        assert.equal(preg(state), null);
        assert.match(buildStatus(state), /Даша \(26\): cycle day/);
    });
});
