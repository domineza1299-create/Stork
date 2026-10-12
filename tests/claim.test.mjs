// Run from the extension folder: node --test tests/*.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pregnancyInfo } from '../biology.js';
import {
    acceptPregnancyClaim, advanceTime, buildStatus, createState, editPregnancyClaim, MINUTES_PER_DAY, processReply, rejectPregnancyClaim, sceneToTag, timelineText,
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

describe('time and memory of the story', () => {
    it('does not turn the day for a date or a time of day the scene only mentions', () => {
        let state = couple();
        state.clock.minutes = 13 * 60;
        const day = state.clock.day;
        state = read(state, { minutes: 10, part_of_day: 'morning' });
        assert.equal(state.clock.day, day, '«morning» said at 13:00 in a ten-minute scene is not the next morning');
        state = read(state, { minutes: 5, date: '2026-01-25' });
        assert.equal(state.clock.day, day, 'a date mentioned in passing does not move the calendar');
        state = read(state, { minutes: 600, part_of_day: 'morning', scene_after_skip: true });
        assert.equal(state.clock.day, day + 1, 'a real skip to the next morning does');
    });

    it('each reply keeps only its own line of the story, and the lines read with their story time', () => {
        let state = read(couple(), { minutes: 60, summary: 'утром пили кофе на кухне' });
        const first = state.lastLine;
        assert.equal(first.text, 'утром пили кофе на кухне');
        state = read(state, { minutes: 30 });
        assert.equal(state.lastLine, null, 'a reply without a summary has no line, the earlier one is not copied');
        assert.equal(state.timeline, undefined, 'nothing grows inside the state');
        const text = timelineText(state, [first, { at: first.at + 1440, text: 'на следующий день гуляли' }]);
        assert.match(text, /^\S+ \d+ \S+ \d{2}:\d{2} — утром пили кофе на кухне\n\S+ \d+ \S+ \d{2}:\d{2} — на следующий день гуляли$/);
    });

    it('a midwife instead of a doctor in an old-world story', () => {
        let state = couple();
        state = read(state, { minutes: 5, era: 'past', pregnancy_claim: { weeks: 7 } });
        assert.equal(state.era, 'traditional');
        advanceTime(state, 8 * MINUTES_PER_DAY, () => 0.9);
        assert.ok(state.log.some(e => /повитуху/.test(e.text)), 'the visit is the midwife');
        assert.ok(!state.log.some(e => /врач/.test(e.text)));
        state = read(state, { minutes: 5, ultrasound: true });
        assert.equal(state.people.user.female.pregnancy.sexKnown, false, 'no ultrasound to see the sex');
    });
});

describe('the body keeps its course between replies', () => {
    it('does not move the cycle for a period the story mentions in the first half of it', () => {
        let state = couple();
        const f = state.people.user.female;
        f.cycleStart = state.clock.day - 7;
        f.syncedDay = state.clock.day - 7;
        state = read(state, { minutes: 5, period: 'ongoing' });
        assert.equal(state.people.user.female.cycleStart, f.cycleStart, 'day 8 of a cycle she set a week ago: the cycle stays');
        assert.ok(state.log.some(e => e.kind === 'period_hint'), 'she is asked instead');
        const late = couple();
        late.people.user.female.cycleStart = late.clock.day - 7;
        const moved = read(late, { minutes: 5, period: 'started' });
        assert.equal(moved.people.user.female.cycleStart, moved.clock.day, 'never confirmed: the story is trusted');
    });

    it('keeps what the story establishes about the pregnancy and tells both models', () => {
        let state = read(couple(), { minutes: 5, pregnancy_claim: { weeks: 7 } });
        state = read(state, { minutes: 5, pregnancy_facts: ['сильный токсикоз по утрам'] });
        state = read(state, { minutes: 5, pregnancy_facts: ['Сильный токсикоз по утрам!', 'повитуха сказала: дитя крупное'] });
        const facts = state.people.user.female.pregnancy.facts.map(f => f.text);
        assert.deepEqual(facts, ['сильный токсикоз по утрам', 'повитуха сказала: дитя крупное'], 'the same fact once');
        assert.match(buildStatus(state, { detailed: false }), /Established in the story: сильный токсикоз по утрам \(week 7\)/);
    });
});
