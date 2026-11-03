from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected 1 match, got {count}: {old[:80]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


# engine.js: local calendar date, remember fertility at the act, and use one set of day-part boundaries.
replace_once(
    'engine.js',
    "export const MINUTES_PER_DAY = 1440;\nconst MAX_LOG = 200;",
    "export const MINUTES_PER_DAY = 1440;\n\n/** Current calendar date in local time, not UTC (important around midnight on phones). */\nexport function localIsoDate(date = new Date()) {\n    const pad = n => String(n).padStart(2, '0');\n    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;\n}\n\nconst MAX_LOG = 200;",
)
replace_once(
    'engine.js',
    "    const pill = pillState(f, act.day);\n    // hormonal contraception used correctly: no ovulation, nothing to roll\n    if (pill.suppressed) return;\n    const cycle = cycleOf(f, act.day);\n    const ovulated = cycle.cycleStart + cycleInfo(cycle, act.day).ovulation - 1;\n    if (act.day < ovulated - 5 || act.day > ovulated) return;\n    throwDice(state, woman, [act], ovulated, pill, rng, cycle.cycleStart);",
    "    const pill = pillState(f, act.day);\n    const cycle = cycleOf(f, act.day);\n    const ovulated = cycle.cycleStart + cycleInfo(cycle, act.day).ovulation - 1;\n    // Save this on the act itself: later UI warnings must describe the day the act happened,\n    // even after the cycle has already rolled over. Older saved acts simply do not have the field.\n    act.fertile = !pill.suppressed && act.day >= ovulated - 5 && act.day <= ovulated;\n    if (!act.fertile) return;\n    throwDice(state, woman, [act], ovulated, pill, rng, cycle.cycleStart);",
)
replace_once(
    'engine.js',
    "export function partOf(minutes) {\n    const h = Math.floor(minutes / 60);\n    return h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'day' : h < 22 ? 'evening' : 'night';\n}",
    "export function partOf(minutes) {\n    const h = Math.floor(minutes / 60) % 24;\n    return h < 6 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'day' : 'evening';\n}",
)

# store.js: the guessed starting date must follow the phone/browser's local calendar day.
replace_once(
    'store.js',
    "import { buildStatus, cleanRpText, createState, MINUTES_PER_DAY, parseSkip, processReply, upgradeState } from './engine.js';",
    "import { buildStatus, cleanRpText, createState, localIsoDate, MINUTES_PER_DAY, parseSkip, processReply, upgradeState } from './engine.js';",
)
replace_once(
    'store.js',
    "const fresh = createState({ userName: context.name1, charName: context.name2, startDate: new Date().toISOString().slice(0, 10) });",
    "const fresh = createState({ userName: context.name1, charName: context.name2, startDate: localIsoDate() });",
)

# window.js: keep edits made while card analysis finishes, local date fallback, accessible icon-only tabs.
replace_once(
    'window.js',
    "import { advanceTime, applyEvent, dateLabel, extractClock, extractDate, MINUTES_PER_DAY, parseClock, storyDate } from './engine.js';",
    "import { advanceTime, applyEvent, dateLabel, extractClock, extractDate, localIsoDate, MINUTES_PER_DAY, parseClock, storyDate } from './engine.js';",
)
replace_once(
    'window.js',
    "    if (!date) return new Date().toISOString().slice(0, 10);",
    "    if (!date) return localIsoDate();",
)
replace_once(
    'window.js',
    "<nav class=\"stk-tabs\">${TABS.map(t => `<button type=\"button\" class=\"stk-tab\" data-tab=\"${t.id}\">${icon(t.icon)}<span>${t.label}</span></button>`).join('')}</nav>",
    "<nav class=\"stk-tabs\">${TABS.map(t => `<button type=\"button\" class=\"stk-tab\" data-tab=\"${t.id}\" title=\"${t.label}\" aria-label=\"${t.label}\">${icon(t.icon)}<span>${t.label}</span></button>`).join('')}</nav>",
)
replace_once(
    'window.js',
    "        // If she already changed something in the form, keep it: refresh only the analysis card\n        if (view.touched && !view.analysis.data) $root.find('.stk-analysis-card').replaceWith(renderAnalysis(view));\n        else render();",
    "        // If she already changed something in the form, keep it: refresh only the analysis card.\n        // A successful analysis must not redraw the whole form and erase unsaved edits.\n        if (view.touched) $root.find('.stk-analysis-card').replaceWith(renderAnalysis(view));\n        else render();",
)
replace_once(
    'window.js',
    "        $card.find('[data-k=\"cycleDay\"]').val(1 + Math.floor(Math.random() * length));\n    });",
    "        $card.find('[data-k=\"cycleDay\"]').val(1 + Math.floor(Math.random() * length));\n        view.touched = true;\n    });",
)

# common.js: the warning is about whether the act itself was in fertile days, not whether today is fertile.
replace_once(
    'common.js',
    "export function riskyLately(state) {\n    const f = state.people.user.female;\n    const lastAct = state.acts.at(-1);\n    if (!lastAct || f.pregnancy || f.postpartum) return false;\n    const day = state.clock.day;\n    return cycleInfo(f, day).fertile && !pillState(f, day).suppressed && (lastAct.protection === 'none' || lastAct.condomBroke) && day - lastAct.day <= 5;\n}",
    "export function riskyLately(state) {\n    const f = state.people.user.female;\n    const lastAct = state.acts.at(-1);\n    if (!lastAct || f.pregnancy || f.postpartum) return false;\n    const day = state.clock.day;\n    const unprotected = lastAct.protection === 'none' || lastAct.condomBroke;\n    const recent = day - lastAct.day >= 0 && day - lastAct.day <= 5;\n    // New acts remember this exactly. For older saved chats, reconstruct at most the previous cycle\n    // (the warning only looks five days back, while a cycle is at least 21 days).\n    const fertileAtAct = typeof lastAct.fertile === 'boolean' ? lastAct.fertile : (() => {\n        const cycle = lastAct.day >= f.cycleStart ? f : { ...f, cycleStart: f.cycleStart - f.cycleLength, cycleShift: 0 };\n        return cycleInfo(cycle, lastAct.day).fertile && !pillState(cycle, lastAct.day).suppressed;\n    })();\n    return fertileAtAct && unprotected && recent;\n}",
)

# style.css: keep the compact look, but make phone touch targets easier to hit.
style = Path('style.css')
css = style.read_text(encoding='utf-8')
marker = '/* Beta: larger touch targets on coarse pointers without enlarging the visible icons. */'
if marker not in css:
    css += "\n\n" + marker + "\n@media (pointer: coarse) {\n    .stk-pen,\n    .stk-icon-btn,\n    .stk-toast-x {\n        min-width: 40px;\n        min-height: 40px;\n    }\n\n    .stk-tab,\n    .stk-cal button {\n        min-height: 40px;\n    }\n}\n"
    style.write_text(css, encoding='utf-8')

# Mark the branch build visibly as beta.
replace_once('manifest.json', '"version": "0.20.1"', '"version": "0.20.2-beta.1"')

# Regression tests for the pure engine changes.
replace_once(
    'tests/engine.test.mjs',
    "    advanceTime, applyEvent, buildStatus, createState, detectHints, parseDuration, parseTag, processReply, sceneToTag, stripTag,\n",
    "    advanceTime, applyEvent, buildStatus, createState, detectHints, localIsoDate, parseDuration, parseTag, partOf, processReply, sceneToTag, stripTag,\n",
)
replace_once(
    'tests/engine.test.mjs',
    "}\n\ndescribe('model tag', () => {",
    "}\n\ndescribe('calendar helpers', () => {\n    it('uses local calendar components for the guessed date', () => {\n        const local = new Date(2026, 10, 3, 0, 30, 0);\n        assert.equal(localIsoDate(local), '2026-11-03');\n    });\n\n    it('uses the same boundaries for the named part of day', () => {\n        assert.equal(partOf(5 * 60 + 59), 'night');\n        assert.equal(partOf(6 * 60), 'morning');\n        assert.equal(partOf(17 * 60 + 59), 'day');\n        assert.equal(partOf(18 * 60), 'evening');\n    });\n});\n\ndescribe('model tag', () => {",
)
replace_once(
    'tests/engine.test.mjs',
    "    it('counts intimacy on ovulation day itself', () => {\n        const state = couple();\n        advanceTime(state, 13 * DAY + 3 * 60); // day 13 = ovulation, at noon\n        applyEvent(state, { type: 'intimacy', protection: 'none' }, seq(0.2));\n        assert.ok(state.rolls.at(-1).chance > 0.3);\n        assert.ok(state.people.user.female.pregnancy, 'conceived');\n    });\n",
    "    it('counts intimacy on ovulation day itself', () => {\n        const state = couple();\n        advanceTime(state, 13 * DAY + 3 * 60); // day 13 = ovulation, at noon\n        applyEvent(state, { type: 'intimacy', protection: 'none' }, seq(0.2));\n        assert.ok(state.rolls.at(-1).chance > 0.3);\n        assert.ok(state.people.user.female.pregnancy, 'conceived');\n    });\n\n    it('remembers whether each act itself happened in the fertile window', () => {\n        const early = couple();\n        advanceTime(early, 3 * DAY);\n        applyEvent(early, { type: 'intimacy', protection: 'none' }, seq(0.99));\n        assert.equal(early.acts.at(-1).fertile, false);\n\n        const fertile = couple();\n        advanceTime(fertile, 11 * DAY);\n        applyEvent(fertile, { type: 'intimacy', protection: 'none' }, seq(0.99));\n        assert.equal(fertile.acts.at(-1).fertile, true);\n    });\n",
)

print('Beta fixes applied successfully.')
