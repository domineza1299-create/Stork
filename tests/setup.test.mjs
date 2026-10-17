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

    it('reads «null» from the analysis as unknown, not as zero', () => {
        const analysis = { user: { age: 26, cycle_length: null, cycle_day: null, pregnant: true, pregnancy_weeks: null }, char: { age: 30 } };
        const state = setupFromAnalysis(createState(), analysis, cards, () => 0.5);
        const f = state.people.user.female;
        assert.equal(f.cycleLength, 28, 'not squeezed to the 21-day minimum');
        assert.equal(f.pregnancy.lmp, state.clock.day - 8 * 7, 'an unknown term is 8 weeks, not 4');
        const fresh = setupFromAnalysis(createState(), { ...analysis, user: { age: 26, cycle_day: null } }, cards, () => 0.5);
        assert.equal(fresh.clock.day - fresh.people.user.female.cycleStart + 1, 15, 'a random day, not always day 1');
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

describe('the setup form in the window', async () => {
    const { applySetupForm } = await import('../setup.js');
    it('reads the form into the state, with the pregnancy the cards describe', () => {
        const state = createState();
        state.people.user.female.contraception = 'pill';
        applySetupForm(state, {
            userName: 'Нина', charName: 'Лёша', userAge: 27, charAge: undefined,
            cycleLength: '30', periodLength: '', cycleDay: '9', irregularity: '2', flow: 'light', contraception: 'ring', endometriosis: true,
            fertility: 'low', smoker: true, startDate: '2026-05-10', time: '07:45', storyMode: 'story',
        }, { user: { pregnant: true, pregnancy_weeks: 12, children: 1 }, story: { summary: 'итог' } }, () => 0.5);
        const f = state.people.user.female;
        assert.equal(state.people.user.age, 27);
        assert.equal(state.people.char.age, 28, 'no age anywhere: the default');
        assert.equal(f.cycleLength, 30);
        assert.equal(f.periodLength, 5, 'an empty field keeps the default');
        assert.equal(f.contraception, 'ring');
        assert.equal(f.pillStoppedDay, 0, 'stopping the pill is remembered');
        assert.equal(f.births, 1);
        assert.equal(f.pregnancy.lmp, -12 * 7);
        assert.equal(state.people.char.male.fertility, 'low');
        assert.equal(state.startDate, '2026-05-10');
        assert.equal(state.clock.minutes, 7 * 60 + 45);
        assert.equal(state.storyMode, 'story');
        assert.equal(state.storySummary, 'итог');
        assert.equal(state.setupDone, true);
    });
});

describe('quick edits', async () => {
    const { applyPersonEdit, setPeriodStart } = await import('../setup.js');
    const { cycleInfo } = await import('../biology.js');
    it('changes only what the form sends', () => {
        const state = setupFromAnalysis(createState(), null, cards, () => 0);
        state.clock.day = 40;
        applyPersonEdit(state, 'user', { age: '27', cycleDay: '12', cycleLength: '30', contraception: 'ring', pcos: true });
        const f = state.people.user.female;
        assert.equal(state.people.user.age, 27);
        assert.equal(cycleInfo(f, 40).cycleDay, 12);
        assert.equal(f.cycleLength, 30);
        assert.equal(f.contraception, 'ring');
        assert.equal(f.pcos, true);
        assert.equal(f.periodLength, 5, 'untouched');
        applyPersonEdit(state, 'char', { age: '35', fertility: 'low', smoker: true, vasectomy: false });
        assert.equal(state.people.char.age, 35);
        assert.equal(state.people.char.male.fertility, 'low');
        assert.equal(state.people.char.male.vasectomyDay, null);
        applyPersonEdit(state, 'user', { age: '15' });
        assert.equal(state.people.user.age, 18, 'never under 18');
    });

    it('marks the start of her period from the calendar, only in the past and not while pregnant', () => {
        const state = setupFromAnalysis(createState(), null, cards, () => 0);
        state.clock.day = 50;
        assert.equal(setPeriodStart(state, 47), true);
        assert.equal(cycleInfo(state.people.user.female, 50).cycleDay, 4);
        assert.equal(setPeriodStart(state, 52), false, 'not in the future');
        const pregnant = setupFromAnalysis(createState(), { user: { pregnant: true, pregnancy_weeks: 10 } }, cards);
        assert.equal(setPeriodStart(pregnant, 0), false);
    });
});
