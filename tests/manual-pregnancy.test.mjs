// Run from the extension folder: node --test tests/*.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pregnancyInfo } from '../biology.js';
import { advanceTime, buildStatus, createState, MINUTES_PER_DAY, setPregnancyByHand } from '../engine.js';

function couple() {
    const state = createState({ userName: 'Даша', charName: 'Лёша', startDate: '2026-01-01' });
    state.people.user.age = 26;
    state.people.char.age = 30;
    state.setupDone = true;
    advanceTime(state, 20 * MINUTES_PER_DAY, () => 0.5);
    return state;
}
const info = state => pregnancyInfo(state.people.user.female.pregnancy, state.clock.day);

describe('a pregnancy set by hand', () => {
    it('starts a new one at the term she gives, known to her, the earlier visits counted as done', () => {
        const state = couple();
        const r = setPregnancyByHand(state, { weeks: 21, days: 3, partnerKnows: true }, () => 0.5);
        assert.equal(r.ok, true);
        assert.equal(r.created, true);
        assert.equal(info(state).week, 21);
        assert.equal(info(state).weekDay, 3);
        const p = state.people.user.female.pregnancy;
        assert.ok(p.knownBy.includes('user') && p.knownBy.includes('char'));
        assert.deepEqual(p.visitsDone, [8, 12, 20]);
        assert.match(buildStatus(state), /pregnant, 21 weeks/);
    });

    it('re-dates the one there is: the baby, the due date and the visits follow', () => {
        const state = couple();
        setPregnancyByHand(state, { weeks: 30, days: 0 }, () => 0.5);
        const r = setPregnancyByHand(state, { weeks: 10, days: 0, partnerKnows: false });
        assert.equal(r.created, false);
        assert.equal(info(state).week, 10);
        assert.deepEqual(state.people.user.female.pregnancy.visitsDone, [8]);
        assert.ok(!state.people.user.female.pregnancy.knownBy.includes('char'));
    });

    it('takes the first day of the last period or the due date by the story calendar', () => {
        const state = couple(); // story day 20 = 2026-01-21
        assert.equal(setPregnancyByHand(state, { lmpDate: '2025-12-10' }).ok, true);
        assert.equal(state.clock.day - state.people.user.female.pregnancy.lmp, 42);
        assert.equal(setPregnancyByHand(state, { dueDate: '2026-07-01' }).ok, true);
        assert.equal(info(state).dueDay - state.clock.day, 161);
    });

    it('refuses a term that is not a pregnancy and settles a question the story left open', () => {
        const state = couple();
        assert.equal(setPregnancyByHand(state, { weeks: 1 }).ok, false);
        assert.equal(setPregnancyByHand(state, { weeks: 45 }).ok, false);
        assert.equal(state.people.user.female.pregnancy, null);
        state.pregnancyClaim = { status: 'pending', kind: 'pregnancy', prev: null };
        setPregnancyByHand(state, { weeks: 6 });
        assert.equal(state.pregnancyClaim.status, 'accepted');
    });
});
