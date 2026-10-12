// Run from the extension folder: node --test tests/
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    advanceTime, applyEvent, buildStatus, createState, detectHints, parseDuration, parseTag, processReply, sceneToTag, stripTag,
} from '../engine.js';

const seq = (...values) => () => (values.length ? values.shift() : 0.5);
const DAY = 1440;

/** Anna (female, user side) and Mark (male, char side), cycle day 1 today. */
function couple(over = {}) {
    const state = createState({ userName: 'Анна', charName: 'Марк', startDate: '2025-03-01' });
    state.people.user.age = 26;
    state.people.char.age = 30;
    Object.assign(state.people.user.female, over);
    return state;
}

describe('model tag', () => {
    it('parses time and events', () => {
        const tag = parseTag('Текст ответа.\n<stork t="+2h" ev="intimacy:condom, orgasm:char, stress:user"/>');
        assert.equal(tag.found, true);
        assert.equal(tag.minutes, 120);
        assert.deepEqual(tag.events, [
            { type: 'intimacy', protection: 'condom' },
            { type: 'orgasm', who: 'char' },
            { type: 'stress', who: 'user' },
        ]);
        assert.equal(parseTag('без метки').found, false);
    });

    it('reads durations and removes the tag from text', () => {
        assert.equal(parseDuration('+1d'), 1440);
        assert.equal(parseDuration('30m'), 30);
        assert.equal(parseDuration('0'), 0);
        assert.equal(parseDuration('потом'), 0);
        assert.equal(stripTag('Привет.\n\n<stork t="+5m" ev=""/>'), 'Привет.');
    });

    it('guesses time skips and intimacy when the tag is missing', () => {
        assert.equal(detectHints('Наутро они проснулись вместе.').minutes, 1440);
        assert.equal(detectHints('Спустя неделю всё изменилось.').minutes, 10080);
        assert.equal(detectHints('Они переспали.').intimacy, true);
        assert.deepEqual(detectHints('Они пили чай.'), { minutes: 0, intimacy: false });
    });
});

describe('cycle over time', () => {
    it('starts a new period and tells the model once', () => {
        const state = couple();
        advanceTime(state, 28 * DAY);
        assert.equal(state.clock.day, 28);
        assert.equal(state.people.user.female.cycleStart, 28);
        assert.ok(state.pending.some(e => /начались месячные/.test(e.text)));
        const { state: next } = processReply(state, 'ответ без метки');
        assert.equal(next.pending.length, 0, 'told once, then cleared');
    });

    it('lets stress before ovulation delay the cycle', () => {
        const state = couple();
        advanceTime(state, 3 * DAY);
        applyEvent(state, { type: 'stress', who: 'user' }, seq(0.9));
        assert.equal(state.people.user.female.cycleShift, 5);
        applyEvent(state, { type: 'stress', who: 'user' }, seq(0.9));
        assert.equal(state.people.user.female.cycleShift, 5, 'only once per cycle');
    });
});

describe('conception and pregnancy', () => {
    it('throws the dice right at the act and starts a hidden pregnancy dated by ovulation', () => {
        const state = couple();
        advanceTime(state, 11 * DAY); // day 11 = cycle day 12, two days before ovulation
        applyEvent(state, { type: 'intimacy', protection: 'none' }, seq(0));
        assert.equal(state.rolls.at(-1)?.kind, 'conception', 'rolled at once, no waiting for midnight');
        const p = state.people.user.female.pregnancy;
        assert.ok(p, 'conceived');
        assert.equal(p.conceptionDay, 13, 'conception comes with ovulation');
        assert.deepEqual(p.knownBy, []);
        assert.ok(/does NOT know/.test(buildStatus(state)));
    });

    it('counts intimacy on ovulation day itself', () => {
        const state = couple();
        advanceTime(state, 13 * DAY + 3 * 60); // day 13 = ovulation, at noon
        applyEvent(state, { type: 'intimacy', protection: 'none' }, seq(0.2));
        assert.ok(state.rolls.at(-1).chance > 0.3);
        assert.ok(state.people.user.female.pregnancy, 'conceived');
    });

    it('does not roll outside the fertile window, and rolls each act once', () => {
        const state = couple();
        advanceTime(state, 3 * DAY);
        applyEvent(state, { type: 'intimacy', protection: 'none' }, seq(0));
        assert.equal(state.rolls.length, 0, 'too early in the cycle');
        advanceTime(state, 9 * DAY);
        applyEvent(state, { type: 'intimacy', protection: 'none' }, seq(0.99));
        applyEvent(state, { type: 'intimacy', protection: 'none' }, seq(0.99));
        assert.equal(state.rolls.length, 2);
        advanceTime(state, 3 * DAY, seq(0));
        assert.equal(state.rolls.length, 2, 'nothing more at midnight');
        assert.equal(state.people.user.female.pregnancy, null);
    });

    it('lets an emergency pill stop a pregnancy before ovulation', () => {
        const state = couple();
        advanceTime(state, 10 * DAY);
        applyEvent(state, { type: 'intimacy', protection: 'none' }, seq(0));
        assert.ok(state.people.user.female.pregnancy);
        advanceTime(state, 1 * DAY);
        applyEvent(state, { type: 'emergency_pill', who: 'user' }, seq(0.5));
        assert.equal(state.people.user.female.pregnancy, null, 'ovulation stopped');
        advanceTime(state, 20 * DAY);
        assert.ok(state.log.some(e => /начались месячные/.test(e.text)), 'the cycle goes on');
    });

    it('throws again when the condom turns out broken later', () => {
        const state = couple();
        advanceTime(state, 12 * DAY);
        applyEvent(state, { type: 'intimacy', protection: 'condom' }, seq(0.5, 0.5));
        assert.equal(state.people.user.female.pregnancy, null);
        applyEvent(state, { type: 'condom_broke' }, seq(0));
        assert.equal(state.rolls.length, 2);
        assert.ok(state.people.user.female.pregnancy, 'the second throw had no protection');
    });

    it('places intimacy after a time skip on the new day', () => {
        const state = couple();
        const scene = { minutes: 7 * DAY, intimacy: { protection: 'none', finished_inside: true, after_time_skip: true }, orgasm: ['char'] };
        const tag = sceneToTag(scene);
        assert.match(tag, /ev="" ev_end="intimacy:none,orgasm:char"/);
        const after = processReply(state, `Через неделю они переспали.\n${tag}`, seq(0.99), scene).state;
        assert.equal(after.acts[0].day, 7, 'a week later, not on the day the reply began');
        const first = { ...scene, intimacy: { ...scene.intimacy, after_time_skip: false } };
        const before = processReply(state, `Они переспали и уснули.\n${sceneToTag(first)}`, seq(0.99), first).state;
        assert.equal(before.acts[0].day, 0);
    });

    it('still rolls acts saved by an older version at the end of ovulation day', () => {
        const state = couple();
        advanceTime(state, 12 * DAY);
        state.acts.push({ day: 12, minute: 12 * DAY, protection: 'none', woman: 'user', force: 'yes', condomBroke: false });
        advanceTime(state, 1 * DAY, seq(0));
        assert.equal(state.rolls.length, 0);
        advanceTime(state, 1 * DAY, seq(0));
        assert.equal(state.rolls.length, 1);
        assert.ok(state.people.user.female.pregnancy);
    });

    it('lets him learn about the pregnancy only after she knows', () => {
        const state = couple();
        advanceTime(state, 12 * DAY);
        applyEvent(state, { type: 'intimacy', protection: 'none', force: 'yes' });
        advanceTime(state, 17 * DAY, seq(0));
        const p = state.people.user.female.pregnancy;
        applyEvent(state, { type: 'told', who: 'char' });
        assert.deepEqual(p.knownBy, [], 'nobody knows yet: nothing to tell');
        applyEvent(state, { type: 'test', who: 'user' }, seq(0.1));
        assert.ok(/Марк does not know about the pregnancy yet/.test(buildStatus(state)));
        const { state: next } = processReply(state, `Она показала ему тест.\n${sceneToTag({ partner_learns_pregnancy: true })}`);
        assert.deepEqual(next.people.user.female.pregnancy.knownBy, ['user', 'char']);
        assert.ok(next.pending.some(e => /Марк узнал о беременности/.test(e.text)));
        const status = buildStatus(next);
        assert.ok(/going to be a father/.test(status));
        assert.ok(!/does not know about the pregnancy/.test(status));
    });

    it('does not roll without a male partner or without acts', () => {
        const state = couple();
        advanceTime(state, 14 * DAY, seq(0));
        assert.equal(state.people.user.female.pregnancy, null);
        assert.equal(state.rolls.length, 0);
    });

    it('notices a late period, then a test reveals the pregnancy', () => {
        const state = couple();
        advanceTime(state, 12 * DAY);
        applyEvent(state, { type: 'intimacy', protection: 'none', force: 'yes' });
        advanceTime(state, 17 * DAY, seq(0)); // past the expected period on day 28
        assert.ok(state.log.some(e => /задержка месячных 1 день/.test(e.text)));
        applyEvent(state, { type: 'test', who: 'user' }, seq(0.1));
        assert.deepEqual(state.people.user.female.pregnancy.knownBy, ['user']);
        assert.ok(/pregnant, 4 weeks/.test(buildStatus(state)));
    });

    it('suppresses ovulation on the pill', () => {
        const state = couple({ contraception: 'pill' });
        advanceTime(state, 12 * DAY);
        applyEvent(state, { type: 'intimacy', protection: 'none' });
        advanceTime(state, 2 * DAY, seq(0));
        assert.equal(state.people.user.female.pregnancy, null);
        assert.ok(/the pill/.test(buildStatus(state)));
    });

    it('goes through labor to birth and recovery', () => {
        const state = couple();
        advanceTime(state, 12 * DAY);
        applyEvent(state, { type: 'intimacy', protection: 'none', force: 'yes' });
        const f = state.people.user.female;
        f.pregnancy.knownBy.push('user', 'char');
        // Jump to week 42 (day 294 from the last period): labor must start
        advanceTime(state, (42 * 7 - 12) * DAY, () => 0.99);
        assert.ok(f.pregnancy?.labor, 'labor started by week 42');
        assert.ok(/IN LABOR/.test(buildStatus(state)));
        advanceTime(state, 24 * 60, () => 0.99);
        assert.equal(f.pregnancy, null);
        assert.equal(f.births, 1);
        assert.ok(f.postpartum);
        assert.ok(state.log.some(e => /отошли воды/.test(e.text)));
        assert.ok(state.log.some(e => /роды завершились/.test(e.text)));
        assert.ok(state.log.some(e => /пора к врачу/.test(e.text)), 'doctor visits were reminded');
    });
});

describe('status text', () => {
    it('describes both people and asks for the tag', () => {
        const text = buildStatus(couple());
        assert.ok(text.includes('Анна (26): cycle day 1 of 28'));
        assert.ok(text.includes('Марк (30):'));
        assert.ok(text.includes('<stork'));
        assert.ok(!buildStatus(couple(), { withTag: false }).includes('<stork'));
    });

    it('is shorter when not detailed and softer when neutral', () => {
        const state = couple();
        assert.ok(buildStatus(state, { detailed: false }).length < buildStatus(state).length);
        state.pending.push({ who: 'user', text: 'секс без защиты' });
        assert.ok(buildStatus(state, { neutral: true }).includes('близость без защиты'));
    });

    it('tells when he is still recovering', () => {
        const state = couple();
        applyEvent(state, { type: 'intimacy', protection: 'condom' }, seq(0.9));
        assert.ok(/Still recovering/.test(buildStatus(state)));
        advanceTime(state, 60);
        assert.ok(!/Still recovering/.test(buildStatus(state)));
    });
});

describe('cards', async () => {
    const { guessAge } = await import('../engine.js');
    it('finds an age written in different ways', () => {
        assert.equal(guessAge('Марк, 30 лет, бармен.'), 30);
        assert.equal(guessAge('Возраст: 27\nРост 190'), 27);
        assert.equal(guessAge('Age: 34'), 34);
        assert.equal(guessAge('He is a 29-year-old doctor'), 29);
        assert.equal(guessAge('She is 23 years old.'), 23);
        assert.equal(guessAge('Ей исполнилось 22 года'), 22);
    });
    it('returns null when there is no age', () => {
        assert.equal(guessAge('Высокий, с тёмными волосами. Живёт в доме 5.'), null);
        assert.equal(guessAge(''), null);
    });
});

describe('scene analysis', async () => {
    const { sceneToTag, parseTag } = await import('../engine.js');
    it('turns an analysis into a tag Stork understands', () => {
        const tag = parseTag(sceneToTag({
            minutes: 480,
            intimacy: { protection: 'condom', finished_inside: true, condom_broke: true },
            orgasm: ['char', 'nobody'],
            lifestyle: [{ type: 'alcohol', who: 'char' }, { type: 'unknown', who: 'char' }],
            pregnancy_test: true,
        }));
        assert.equal(tag.minutes, 480);
        assert.deepEqual(tag.events.map(e => e.type), ['intimacy', 'orgasm', 'alcohol', 'test']);
        assert.equal(tag.events[0].protection, 'condom');
        assert.equal(tag.events[0].broke, true, 'the break rides with its act');
    });
    it('treats finishing outside without protection as withdrawal', () => {
        const tag = parseTag(sceneToTag({ minutes: 30, intimacy: { protection: 'none', finished_inside: false } }));
        assert.equal(tag.events[0].protection, 'withdrawal');
    });
    it('handles an empty or broken analysis', () => {
        assert.deepEqual(parseTag(sceneToTag({})), { found: true, minutes: 0, events: [], eventsEnd: [], clock: null });
        assert.equal(parseTag(sceneToTag({ minutes: 'много' })).minutes, 0);
    });
});

describe('cleaning role-play text', async () => {
    const { cleanRpText, parseClock } = await import('../engine.js');
    it('drops image tags and HTML but keeps the story', () => {
        const text = '<img data-iig-instruction=\'{"style":"masterpiece","prompt":"_Igor"}\' src="x">\n**22:40, Квартира.**\n\n\n\nОн вошёл. ![pic](a.png) <b>Устал</b>.';
        assert.equal(cleanRpText(text), '**22:40, Квартира.**\n\nОн вошёл.  Устал.');
    });
    it('reads clock time', () => {
        assert.equal(parseClock('22:40'), 22 * 60 + 40);
        assert.equal(parseClock('7.05'), 7 * 60 + 5);
        assert.equal(parseClock('25:00'), null);
        assert.equal(parseClock(null), null);
    });
});

describe('story clock from the text', async () => {
    const { extractClock, minutesToClock, processReply, sceneToTag, parseTag } = await import('../engine.js');
    const at = (h, m = 0) => h * 60 + m;

    it('reads a time header at the start of a reply', () => {
        assert.equal(extractClock('**22:40, Квартира Игоря на Дубенском.**\n___\nЗамок щёлкнул.'), at(22, 40));
        assert.equal(extractClock('<img src="x">\n*07.15* Утро.'), at(7, 15));
        assert.equal(extractClock('Он сказал: позвони мне в 22:40.'), null, 'a time inside a sentence is not a header');
    });

    it('moves to the written time instead of guessing', () => {
        assert.equal(minutesToClock(at(8), at(22, 40), 600), at(14, 40));
        assert.equal(minutesToClock(at(22, 40), at(22, 35), 0), 0, 'a few minutes earlier is the same moment');
        assert.equal(minutesToClock(at(23), at(7), 480), at(8), 'past midnight to the morning');
        assert.equal(minutesToClock(at(22), at(9), 10080), 7 * 1440 + at(11), 'a week later at nine');
    });

    it('applies a header from the reply and a clock from the analysis', () => {
        const state = createState({ userName: 'Дора', charName: 'Игорь' });
        state.clock.minutes = at(8);
        const fromHeader = processReply(state, '**22:40, Квартира.**\nОн вошёл.');
        assert.equal(fromHeader.state.clock.minutes, at(22, 40));
        assert.equal(fromHeader.state.clock.day, 0);
        const tag = sceneToTag({ minutes: 600, clock: '18:00' });
        assert.equal(parseTag(tag).clock, at(18));
        const fromAnalysis = processReply(state, `Текст без заголовка.\n${tag}`);
        assert.equal(fromAnalysis.state.clock.minutes, at(18));
    });
});
