// Run from the extension folder: node --test tests/*.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createState, buildStatus } from '../engine.js';
import { hasMinor, setupFromAnalysis } from '../setup.js';

const cards = { userName: 'Нина', charName: 'Лёша', userText: 'Нина, 24 года, медсестра.', charText: 'Лёша, 31 год.' };

describe('setting a chat up by itself', () => {
    it('takes what the analysis found and fills the rest with defaults', () => {
        const state = setupFromAnalysis(createState(), {
            user: { age: 24, contraception: 'pill', cycle_length: 30, cycle_day: 10, pcos: true },
            char: { age: 31, smoker: true, fertility: 'low' },
            start: { time: '22:40', date: '2024-03-15', date_guessed: false },
        }, cards, () => 0.5);
        assert.equal(state.setupDone, true);
        assert.equal(state.people.user.age, 24);
        assert.equal(state.people.user.female.contraception, 'pill');
        assert.equal(state.people.user.female.cycleLength, 30);
        assert.equal(state.clock.day - state.people.user.female.cycleStart + 1, 10);
        assert.equal(state.people.char.male.fertility, 'low');
        assert.equal(state.people.char.male.smoker, true);
        assert.equal(state.clock.minutes, 22 * 60 + 40);
        assert.equal(state.startDate, '2024-03-15');
        assert.equal(state.dateSure, true);
    });

    it('works without an analysis: ages from the card text, a random cycle day, a guessed date stays unsure', () => {
        const state = setupFromAnalysis(createState(), null, cards, () => 0.1);
        assert.equal(state.people.user.age, 24);
        assert.equal(state.people.char.age, 31);
        assert.equal(state.people.user.female.contraception, 'none');
        const guessed = setupFromAnalysis(createState(), { start: { date: '1995-12-20', date_guessed: true } }, cards);
        assert.equal(guessed.startDate, '1995-12-20');
        assert.equal(guessed.dateSure, false);
    });

    it('starts a pregnancy the cards describe, and refuses minors', () => {
        const state = setupFromAnalysis(createState(), { user: { pregnant: true, pregnancy_weeks: 20 } }, cards);
        assert.ok(state.people.user.female.pregnancy);
        assert.match(buildStatus(state), /pregnant, 20 weeks/);
        assert.equal(hasMinor({ user: { age: 16 } }, cards), true);
        assert.equal(hasMinor(null, { ...cards, charText: 'Ему 17 лет.' }), true);
        assert.equal(hasMinor(null, cards), false);
    });
});
