// Run from the extension folder: node --test tests/
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    abstinenceFactor, actChance, createPregnancy, cycleInfo, cycleReturnDay, femaleState, laborChance,
    maleFactor, maleState, ovulationDay, pregnancyInfo, refractoryMinutes, rollConception, rollCycles,
    rollTest, testosterone, ultrasoundShowsSex,
} from '../biology.js';

/** Deterministic rng from a list of values, then 0.5. */
const seq = (...values) => () => (values.length ? values.shift() : 0.5);
const woman = (over = {}) => ({ cycleStart: 0, cycleLength: 28, periodLength: 5, cycleShift: 0, ...over });
const man = (over = {}) => ({ fertility: 'normal', lifestyle: [], ejaculations: [], vasectomyDay: null, ...over });

describe('cycle', () => {
    it('places ovulation 14 days before the next period', () => {
        assert.equal(ovulationDay(28), 14);
        assert.equal(ovulationDay(32), 18);
        assert.equal(ovulationDay(21), 8);
    });

    it('walks through the phases of a 28-day cycle', () => {
        const phase = day => cycleInfo(woman(), day).phase;
        assert.equal(phase(0), 'menstruation');
        assert.equal(phase(4), 'menstruation');
        assert.equal(phase(8), 'follicular');
        assert.equal(phase(13), 'ovulation');
        assert.equal(phase(18), 'luteal');
        assert.equal(phase(25), 'pms');
    });

    it('marks the fertile window and today\'s chance', () => {
        const info = cycleInfo(woman(), 13); // cycle day 14 = ovulation
        assert.equal(info.cycleDay, 14);
        assert.equal(info.fertile, true);
        assert.equal(info.chanceToday, 0.33);
        assert.equal(cycleInfo(woman(), 16).chanceToday, 0, 'egg is gone two days after ovulation');
        assert.equal(cycleInfo(woman(), 5).fertile, false);
    });

    it('starts the next cycle and keeps irregular shifts within limits', () => {
        const f = woman({ irregularity: 3 });
        assert.equal(rollCycles(f, 30, seq(1)), true);
        assert.equal(f.cycleStart, 28);
        assert.equal(f.cycleShift, 3);
        assert.equal(rollCycles(f, 31), false);
    });

    it('gives stable symptoms for the same day', () => {
        const a = femaleState(woman(), 2).symptoms;
        const b = femaleState(woman(), 2).symptoms;
        assert.deepEqual(a, b);
        assert.equal(a.length, 2);
        assert.ok(femaleState(woman({ painfulPeriods: true }), 1).symptoms.includes('сильная боль'));
    });
});

describe('male', () => {
    it('lowers quality right after and long after the last ejaculation', () => {
        assert.equal(abstinenceFactor(0), 0.8);
        assert.equal(abstinenceFactor(3), 1);
        assert.equal(abstinenceFactor(14), 0.85);
    });

    it('feels a fever with a delay, then recovers', () => {
        const sick = man({ lifestyle: [{ day: 0, type: 'fever' }] });
        const at = day => maleFactor(sick, 30, day) / maleFactor(man(), 30, day);
        assert.ok(at(1) > 0.95, 'barely affected the next day');
        assert.ok(at(50) < 0.6, 'strongest a month or two later');
        assert.ok(at(120) > 0.99, 'recovered after about 100 days');
    });

    it('protects after a vasectomy only after about three months', () => {
        const m = man({ vasectomyDay: 0 });
        assert.ok(maleFactor(m, 30, 10) > 0);
        assert.equal(maleFactor(m, 30, 95), 0);
        assert.equal(maleFactor(man({ fertility: 'sterile' }), 30, 5), 0);
    });

    it('recovers faster when younger and peaks in the morning', () => {
        assert.ok(refractoryMinutes(22) < refractoryMinutes(45));
        assert.ok(testosterone(30, 8 * 60) > testosterone(30, 20 * 60));
        assert.ok(testosterone(60, 8 * 60) < testosterone(25, 8 * 60));
        assert.equal(maleState(man({ ejaculations: [3] }), 30, 5, 600).daysSinceLast, 2);
    });
});

describe('conception', () => {
    const base = { ovulationAbsoluteDay: 13, femaleAge: 25, femaleContraception: 'none', male: man(), maleAge: 28 };

    it('counts acts up to 5 days before ovulation', () => {
        assert.ok(actChance({ day: 8 }, 13, 'none', man(), 28) > 0);
        assert.equal(actChance({ day: 7 }, 13, 'none', man(), 28), 0, '6 days before is too early');
        assert.equal(actChance({ day: 14 }, 13, 'none', man(), 28), 0, 'after ovulation is too late');
    });

    it('reduces the chance with protection and lets a broken condom through', () => {
        const none = actChance({ day: 12 }, 13, 'none', man(), 28);
        const condom = actChance({ day: 12, protection: 'condom' }, 13, 'none', man(), 28);
        const broken = actChance({ day: 12, protection: 'condom', condomBroke: true }, 13, 'none', man(), 28);
        const pill = actChance({ day: 12 }, 13, 'pill', man(), 28);
        const emergency = actChance({ day: 12, emergencyPillDay: 13 }, 13, 'none', man(), 28);
        assert.ok(condom < none * 0.05);
        assert.equal(broken, none);
        assert.ok(pill < none * 0.02);
        assert.ok(Math.abs(emergency - none * 0.15) < 1e-9);
    });

    it('combines several acts and rolls once', () => {
        const one = rollConception({ ...base, acts: [{ day: 12 }], rng: seq(0.99) });
        const two = rollConception({ ...base, acts: [{ day: 11 }, { day: 12 }], rng: seq(0.99) });
        assert.ok(two.chance > one.chance);
        assert.equal(one.conceived, false);
        assert.equal(rollConception({ ...base, acts: [{ day: 12 }], rng: seq(0.01) }).conceived, true);
    });

    it('obeys story overrides and modes', () => {
        assert.equal(rollConception({ ...base, acts: [{ day: 2, force: 'yes' }, { day: 12 }], rng: seq(0.99) }).conceived, false, 'forced act outside the window does not count');
        assert.equal(rollConception({ ...base, acts: [{ day: 12, force: 'yes' }], rng: seq(0.99) }).conceived, true);
        assert.equal(rollConception({ ...base, acts: [{ day: 12, force: 'no' }], rng: seq(0) }).conceived, false);
        const story = rollConception({ ...base, acts: [{ day: 12 }], storyMode: 'story', rng: seq(0.99) });
        const real = rollConception({ ...base, acts: [{ day: 12 }], rng: seq(0.99) });
        assert.ok(story.chance > real.chance * 2);
    });

    it('is lower with age and impossible with a sterile partner', () => {
        const young = rollConception({ ...base, acts: [{ day: 12 }] }).chance;
        const older = rollConception({ ...base, femaleAge: 41, acts: [{ day: 12 }] }).chance;
        assert.ok(older < young * 0.5);
        assert.equal(rollConception({ ...base, male: man({ fertility: 'sterile' }), acts: [{ day: 12 }] }).chance, 0);
    });
});

describe('tests and pregnancy', () => {
    it('shows a pregnancy test only after enough days', () => {
        assert.equal(rollTest(true, 7, seq(0.01)), false);
        assert.equal(rollTest(true, 14, seq(0.9)), true);
        assert.equal(rollTest(false, 20, seq(0.5)), false);
    });

    it('dates the pregnancy from the last period', () => {
        const p = createPregnancy({ lmp: 0, conceptionDay: 13, twins: false, rng: seq(0.2, 0.3, 0.9) });
        const early = pregnancyInfo(p, 28);
        assert.equal(early.week, 4);
        assert.equal(early.trimester, 1);
        assert.equal(early.dueDay, 280);
        const mid = pregnancyInfo(p, 20 * 7);
        assert.equal(mid.trimester, 2);
        assert.equal(mid.baby.compare, 'банан');
        assert.equal(mid.belly, 'заметен');
        assert.ok(mid.weightGain > 4 && mid.weightGain < 6);
        assert.equal(pregnancyInfo(p, 30 * 7).trimester, 3);
    });

    it('makes twins with two sexes and schedules first kicks', () => {
        const p = createPregnancy({ lmp: 0, conceptionDay: 13, twins: true, rng: seq(0, 0.1, 0.9) });
        assert.equal(p.babies, 2);
        assert.deepEqual(p.sexes, ['девочка', 'мальчик']);
        assert.equal(p.kicksDay, 18 * 7);
    });

    it('never craves and hates the same food', () => {
        for (let i = 0; i < 200; i++) {
            const p = createPregnancy({ lmp: 0, conceptionDay: 13, twins: false });
            assert.ok(!p.aversions.some(a => p.cravings.includes(a)), `${p.cravings} / ${p.aversions}`);
        }
    });

    it('starts labor only near term and reveals sex from week 18', () => {
        assert.equal(laborChance(36), 0);
        assert.ok(laborChance(40) > laborChance(38));
        assert.equal(laborChance(42), 1);
        assert.equal(ultrasoundShowsSex(16, seq(0)), false);
        assert.equal(ultrasoundShowsSex(21, seq(0.5)), true);
        assert.ok(cycleReturnDay(0, true, seq(0)) > cycleReturnDay(0, false, seq(0)));
    });
});

describe('male details and new conditions', async () => {
    const { maleState, pillState, rollConception, femaleConditionFactor, semenReserve } = await import('../biology.js');
    const male = (over = {}) => ({ fertility: 'normal', lifestyle: [], ejaculations: [], vasectomyDay: null, ...over });

    it('drinking today weakens erection, not sperm yet', () => {
        const sober = maleState(male(), 30, 10, 600);
        const drunk = maleState(male({ lifestyle: [{ day: 10, type: 'alcohol' }] }), 30, 10, 600);
        assert.ok(drunk.erection < 0.75 && sober.erection > 0.9);
        assert.equal(drunk.spermCount, sober.spermCount);
    });

    it('lowers testosterone for an expecting father and explains slow sperm recovery', () => {
        assert.ok(maleState(male(), 30, 10, 480, { expectingFather: true }).testosterone < maleState(male(), 30, 10, 480).testosterone);
        const sick = maleState(male({ lifestyle: [{ day: 0, type: 'fever' }] }), 30, 40, 600);
        assert.equal(sick.reasons[0].label, 'болезнь с температурой');
        assert.equal(sick.reasons[0].recoversInDays, 60);
        assert.equal(semenReserve(0), 0.35);
        assert.equal(semenReserve(5), 1);
    });

    it('suppresses ovulation with hormonal methods only', () => {
        for (const method of ['pill', 'ring', 'patch', 'injection', 'implant']) assert.equal(pillState({ contraception: method }, 5).suppressed, true, method);
        for (const method of ['none', 'iud', 'copper_iud']) assert.equal(pillState({ contraception: method }, 5).suppressed, false, method);
        assert.equal(pillState({ contraception: 'pill', pillMissedDay: 3 }, 5).suppressed, false, 'a missed pill lets ovulation through');
    });

    it('lowers the chance with PCOS and endometriosis', () => {
        assert.equal(femaleConditionFactor({ pcos: true, endometriosis: true }), 0.3);
        const base = { acts: [{ day: 12 }], ovulationAbsoluteDay: 13, femaleAge: 25, femaleContraception: 'none', male: male(), maleAge: 28 };
        assert.ok(rollConception({ ...base, femaleFactor: 0.5 }).chance < rollConception(base).chance * 0.6);
    });
});
