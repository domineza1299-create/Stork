// Run from the extension folder: node --test tests/*.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pregnancyInfo } from '../biology.js';
import {
    acceptPregnancyClaim, advanceTime, buildStatus, createState, editPregnancyClaim, MINUTES_PER_DAY, processReply, rejectPregnancyClaim, sceneToTag,
} from '../engine.js';

function couple() {
    const state = createState({ userName: 'Даша', charName: 'Лёша', startDate: '2026-01-01' });
    state.people.user.age = 26;
    state.people.char.age = 30;
    state.setupDone = true;
    advanceTime(state, 20 * MINUTES_PER_DAY, () => 0.5);
    return state;
}
const read = (state, scene, text = 'Текст ответа.') => processReply(state, `${text}\n${sceneToTag(scene)}`, () => 0.5, scene).state;
const week = state => pregnancyInfo(state.people.user.female.pregnancy, state.clock.day).week;

describe('a pregnancy the story states', () => {
    it('is written in right away with the term the story names, waiting for her answer', () => {
        const state = read(couple(), { minutes: 5, pregnancy_claim: { weeks: 8, days: 2, quote: 'я беременна, восемь недель' } });
        const p = state.people.user.female.pregnancy;
        assert.ok(p, 'pregnant now');
        assert.ok(p.knownBy.includes('user'), 'she knows');
        assert.ok(!p.knownBy.includes('char'), 'he does not yet');
        assert.equal(week(state), 8);
        assert.equal(state.pregnancyClaim.status, 'pending');
        assert.equal(state.pregnancyClaim.quote, 'я беременна, восемь недель');
        assert.match(buildStatus(state), /pregnant, 8 weeks/);
        assert.ok(state.log.some(e => e.kind === 'claim'));
    });

    it('guesses the term from the last closeness without protection when the story names none', () => {
        let state = couple();
        state = read(state, { minutes: 30, intimacy: { protection: 'none', finished_inside: true } });
        advanceTime(state, 30 * MINUTES_PER_DAY, () => 0.9);
        state = read(state, { minutes: 5, pregnancy_claim: { weeks: null, partner_knows: true } });
        assert.equal(state.pregnancyClaim.guessed, true);
        assert.equal(week(state), 6, 'about 30 days after the act is 6 weeks from the last period');
        assert.ok(state.people.user.female.pregnancy.knownBy.includes('char'), 'he knows: told in the same scene');
    });

    it('rejecting brings the old state back and stops the same claim for a while', () => {
        const before = couple();
        let state = read(before, { minutes: 5, pregnancy_claim: { weeks: 5 } });
        rejectPregnancyClaim(state);
        assert.equal(state.people.user.female.pregnancy, null);
        assert.equal(state.pregnancyClaim.status, 'rejected');
        state = read(state, { minutes: 60, pregnancy_claim: { weeks: 5 } });
        assert.equal(state.people.user.female.pregnancy, null, 'the story repeating it changes nothing');
    });

    it('rejecting keeps a pregnancy the dice made, still unknown to her', () => {
        const state = couple();
        read(state, {});
        state.people.user.female.pregnancy = { lmp: 5, conceptionDay: 19, babies: 1, births: 0, sexes: ['девочка'], kicksDay: 150, spottingDay: null, cravings: [], aversions: [], knownBy: [], sexKnown: false, visitsDone: [], labor: null };
        const after = read(state, { minutes: 5, pregnancy_claim: { weeks: 3 } });
        assert.ok(after.people.user.female.pregnancy.knownBy.includes('user'));
        rejectPregnancyClaim(after);
        assert.deepEqual(after.people.user.female.pregnancy.knownBy, [], 'hidden again, as it was');
        assert.equal(after.people.user.female.pregnancy.lmp, 5);
    });

    it('her own term wins and the story no longer moves it; accepting closes the question', () => {
        let state = read(couple(), { minutes: 5, pregnancy_claim: { weeks: 8 } });
        editPregnancyClaim(state, 10, 0);
        assert.equal(week(state), 10);
        state = read(state, { minutes: 5, pregnancy_claim: { weeks: 6 } });
        assert.equal(week(state), 10, 'edited by her: kept');
        acceptPregnancyClaim(state);
        assert.equal(state.pregnancyClaim.status, 'accepted');
        assert.equal(state.pregnancyClaim.prev, undefined);
    });

    it('a known pregnancy is re-dated only when the story names a term far from it, and that can be undone', () => {
        let state = read(couple(), { minutes: 5, pregnancy_claim: { weeks: 8 } });
        acceptPregnancyClaim(state);
        state = read(state, { minutes: 5, pregnancy_claim: { weeks: 9 } });
        assert.equal(state.pregnancyClaim.status, 'accepted', 'a week off: nothing to ask');
        state = read(state, { minutes: 5, pregnancy_claim: { weeks: 14 } });
        assert.equal(state.pregnancyClaim.kind, 'term');
        assert.equal(week(state), 14);
        rejectPregnancyClaim(state);
        assert.equal(week(state), 8);
    });

    it('the tag of the role-play model can say it too', () => {
        const state = processReply(couple(), 'Она положила руку на живот. <stork t="+5m" ev="pregnant:12"/>', () => 0.5).state;
        assert.equal(week(state), 12);
    });
});
