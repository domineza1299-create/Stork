// Run from the extension folder: node --test tests/*.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { realism } from '../biology.js';
import { buildStatus, createState, maleSnapshot, processReply, sceneToTag } from '../engine.js';
import { advance, intimacyPrompt, isTimeskip, kinkChips, readingMode, sectionPrompt } from '../intimacy.js';

function couple() {
    const state = createState({ userName: 'Нина', charName: 'Игорь', startDate: '2026-10-10' });
    state.people.user.age = 26;
    state.people.char.age = 33;
    state.clock.minutes = 21 * 60;
    state.setupDone = true;
    return state;
}
/** One reply read by the analysis, the way index.js does it. */
const read = (state, scene, text = 'Текст.') => processReply(state, `${text}\n${sceneToTag(scene)}`, () => 0.5, scene).state;
const ag = (over = {}) => ({ dynamic: 'passionate', phase: 1, pose: 'на диване', clothes: 'рубашка расстёгнута', char: { climax: 30, state: 'горячий', thought: 'Сейчас.' }, user: { climax: 20, readiness: 30, state: 'дрожит' }, kinks_active: [], next: 'Slow down.', ...over });

describe('the intimate scene', () => {
    it('starts with closeness, keeps the pace and never jumps to the peak', () => {
        let state = read(couple(), { minutes: 5, closeness: 'active', afterglow: ag() });
        const sc = state.intim.scene;
        assert.equal(sc.visible, true);
        assert.equal(sc.user.readiness, 30);
        // the reader says she is suddenly ready and he is at 95: the code holds them back
        state = read(state, { minutes: 5, closeness: 'active', afterglow: ag({ phase: 5, char: { climax: 95 }, user: { climax: 90, readiness: 100 } }) });
        const next = state.intim.scene;
        assert.ok(next.phase <= 2, `one step at a time (${next.phase})`);
        assert.equal(next.user.readiness, 65, 'readiness +35 at most');
        assert.ok(next.char.climax <= 30 + 22, 'climax grows by the cap of the dynamic');
        assert.match(intimacyPrompt(state), /Neither of them may climax|must not climax/);
    });

    it('takes orgasms from Stork\'s own reading and sets his refractory time', () => {
        let state = read(couple(), { minutes: 10, closeness: 'active', afterglow: ag({ char: { climax: 80 }, user: { climax: 80, readiness: 90 } }) });
        state = read(state, { minutes: 10, closeness: 'active', intimacy: { protection: 'none', finished_inside: true }, orgasm: ['char'], afterglow: ag({ phase: 5 }) });
        const sc = state.intim.scene;
        assert.equal(sc.char.org, 1);
        assert.equal(sc.char.climax, 100);
        assert.ok(sc.char.refr > 0);
        assert.match(intimacyPrompt(state), /refractory/);
    });

    it('ends with closeness none or a time skip, and remembers the scene', () => {
        let state = read(couple(), { minutes: 10, closeness: 'active', afterglow: ag({ responds: ['поцелуи в шею'], marks: ['засос на шее'] }) });
        state = read(state, { minutes: 20, closeness: 'none' });
        assert.equal(state.intim.scene, null);
        assert.equal(state.intim.history.length, 1);
        assert.deepEqual(state.intim.history[0].responds, ['поцелуи в шею']);
        assert.match(intimacyPrompt(state), /засос на шее/, 'the marks are recalled for a while');
        state = read(state, { minutes: 12 * 60, closeness: 'none' });
        assert.equal(intimacyPrompt(state), '', 'and forgotten later');
        assert.ok(isTimeskip('Утром она проснулась одна.'));
        assert.ok(isTimeskip('Через три часа спустя…') || isTimeskip('Три часа спустя они вышли.'));
        assert.ok(!isTimeskip('Она улыбнулась.'));
        let again = read(couple(), { minutes: 5, closeness: 'active', afterglow: ag() });
        again = read(again, { minutes: 5, closeness: 'active', user_skip: true });
        assert.equal(again.intim.history.length, 1, 'her time skip closes the scene');
    });

    it('asks for the full section only when it may be needed', () => {
        assert.equal(readingMode(couple(), ['Они пили чай и говорили о работе.']), 'light');
        assert.equal(readingMode(couple(), ['В десяти метрах от них Фомин замер. Разделить счёт? Всё кончилось хорошо, члены клуба ушли.']), 'light', 'whole words only');
        assert.equal(readingMode(couple(), ['Она застонала ему в губы.']), 'full');
        assert.equal(readingMode(couple(), ['Он поцеловал её в шею.']), 'full');
        const state = read(couple(), { minutes: 5, closeness: 'near' });
        assert.equal(state.intim.scene.near, true);
        assert.equal(readingMode(state, ['чай']), 'full', 'a scene that is near keeps the director');
        assert.match(intimacyPrompt(state), /heading toward intimacy/);
    });

    it('reads the kinks once and lights the active ones', () => {
        const first = sectionPrompt({ kinks: undefined, cards: 'Игорь любит контроль.' });
        assert.match(first.field, /kinks_all/);
        let state = read(couple(), { minutes: 5, closeness: 'active', afterglow: ag({ kinks_all: [{ name: 'контроль', from: 'card' }, { name: 'укусы', from: 'persona' }], kinks_active: ['контроль'], voice: 'Short, blunt.' }) });
        assert.deepEqual(state.intim.kinks.map(k => k.name), ['контроль', 'укусы']);
        assert.equal(state.intim.voice, 'Short, blunt.');
        assert.deepEqual(kinkChips(state), [{ name: 'контроль', on: true }, { name: 'укусы', on: false }]);
        const later = sectionPrompt({ kinks: state.intim.kinks });
        assert.doesNotMatch(later.field, /kinks_all/);
        assert.match(later.context, /контроль, укусы/);
    });

    it('starts from Stork\'s own reading of intercourse even without the section', () => {
        const state = read(couple(), { minutes: 15, closeness: 'none', intimacy: { protection: 'condom' } });
        assert.equal(state.intim.scene.visible, true);
        assert.ok(advance(null, null, { active: true, at: 0 }).visible);
    });
});

describe('the erection switch', () => {
    it('drink and stress weaken it only while the switch is on', () => {
        let state = read(couple(), { minutes: 5, lifestyle: [{ type: 'alcohol', who: 'char' }, { type: 'stress', who: 'char' }] });
        assert.ok(maleSnapshot(state, state.people.char).erection < 0.75);
        assert.match(buildStatus(state), /erection may let him down/);
        realism.erectionDrops = false;
        try {
            const s = maleSnapshot(state, state.people.char);
            assert.ok(s.erection >= 0.9);
            assert.ok(s.libido < 1, 'the rest of the realism stays');
            assert.doesNotMatch(buildStatus(state), /may let him down/);
            assert.doesNotMatch(sectionPrompt({ kinks: [], erectionDrops: false }).rules, /^$/);
            assert.match(sectionPrompt({ kinks: [], erectionDrops: false }).rules, /never fails him/);
        } finally {
            realism.erectionDrops = true;
        }
    });
});
