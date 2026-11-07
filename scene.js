/*
 * Reads what happened in the role-play after each reply, through a chosen connection,
 * so the story model never has to know about Stork.
 */
import { remember, requestModel } from './connection.js';
import { cleanRpText, DIAGNOSES, SCENE_LIFESTYLE_TYPES as LIFESTYLE_TYPES } from './engine.js';
import { CLOSENESS_FIELD, CLOSENESS_RULE } from './intimacy.js';

export { sceneToTag } from './engine.js';
export { errorText } from './connection.js';

// The JSON itself is about 500-800 tokens, but reasoning models think first and the thinking counts against
// this limit too: Kimi K3 spends 1200-2500 tokens on it. The limit is only a ceiling, only used tokens are paid.
const SCENE_MAX_TOKENS = 6000;
/** Only the newest part of long messages matters for what just happened. */
const MAX_MESSAGE_CHARS = 5000;
const MAX_EARLIER_CHARS = 1500;

const SYSTEM_PROMPT = `You track a role-play story for a reproductive health tracker.
{{user}} is the woman, {{char}} is the man. Report events only as they actually happened in the newest messages.
For how each of them is now, think like an attentive doctor: draw conclusions from the tracker's body data together with the scene.
Reply with one JSON object and nothing else.`;

const RELATIONS = ['parent', 'child', 'sibling', 'spouse', 'partner', 'ex', 'grandparent', 'grandchild', 'auncle', 'niece', 'cousin'];

/**
 * @param {object} input
 * @param {object|null} [input.intim] the director: null when it is off; { full: bool, section: { context, field, rules } }
 * @param {string} [input.familyKnown] who is on the family tree already, a line each
 * @param {boolean} [input.trackExes] false: no exes on the tree
 * @param {boolean} [input.erectionDrops] false: outside causes never weaken his erection
 */
export function buildScenePrompt({ userName, charName, dateText, status, timeline = '', earlier, userMessage, reply, skipCounted = false, intim = null, familyKnown = '', trackExes = true, erectionDrops = true, turnOns = '', health = null, dateGuess = false, relNow = 'unknown' }) {
    const relations = RELATIONS.filter(r => trackExes || r !== 'ex').map(r => `"${r}"`).join(' | ');
    const full = intim?.full ? intim.section : null;
    return `${timeline ? `STORY SO FAR (what happened lately, by story time; the newest line is right before these messages):
${timeline}

` : ''}Story time before these messages: ${dateText}. The scene goes on from there: a new day begins only if these messages move to it.${dateGuess ? `
That date is only the tracker's guess. If these messages name the date, put it into "date"; if they make only the month or the season clear (December, deep winter, the New Year coming), put the most plausible date in it (the year of the setting). The days between the guess and that date are NOT story time: never count them into "minutes".` : ''}${skipCounted ? `
The time skip the user message opens with is ALREADY COUNTED: the time above is after it. "minutes" is only the time that passes after that, in the reply; the scene is set after the skip.` : ''}
{{user}} = ${userName} (woman), {{char}} = ${charName} (man).
${status ? `
HOW THEY ARE BY THE TRACKER (body and cycle; the story may show more):
${status}
` : ''}${familyKnown ? `
ALREADY ON THE FAMILY TREE (use exactly these names; never list them in "family" again unless the relation changes):
${familyKnown}
` : ''}${full?.context ? `
${full.context}
` : ''}${earlier ? `
EARLIER REPLY (context only — already counted):
${cleanRpText(earlier).slice(-MAX_EARLIER_CHARS)}
` : ''}
USER MESSAGE:
${cleanRpText(userMessage).slice(-MAX_MESSAGE_CHARS) || '(none)'}

REPLY:
${cleanRpText(reply).slice(-MAX_MESSAGE_CHARS)}

Return JSON:
{
  "minutes": how many minutes of story time these messages take, from the user message to the end of the reply. Time moves in a continuous scene too: estimate it from what is done and said (a few lines of talk 2-5, washing up or a shower 10-20, getting dressed 5-10, a meal 20-40, a drive across town 20-40, a night about 480, "the next morning" about 720, "a week later" 10080). 0 only if it all is one single instant,
  "clock": "HH:MM" time of day at the END of these messages if the text states it as the time now (a header like 22:40, a clock or phone screen read in the scene), otherwise null. A header copied unchanged from the earlier reply is not the time now: then null,
  "date": "YYYY-MM-DD" only if these messages name the date the scene is in NOW (a header, "today is the 15th of March"); a date that is only mentioned (a plan, a letter, a memory, "tomorrow") is not it: then null,
  "part_of_day": "morning" | "day" | "evening" | "night" — the time of day these messages end in, if the text makes it clear (light, meals, "at dawn", "late at night"), otherwise null,
  "scene_after_skip": true | false,
  "summary": "what happened in these messages, one line in Russian, up to 20 words, facts only: where, who, what was done, and anything about the body (closeness, her period, nausea, a check-up, an injury). It is kept as the story so far",
  "era": "modern" | "past" — the world of the story: "past" for old times, a village of the old days, fantasy without modern medicine; "modern" otherwise,
  "intimacy": null or { "protection": "none" | "condom" | "pill_only", "finished_inside": true | false, "condom_broke": true | false },
  "past_intimacy": [ { "days_ago": number, "protection": "none" | "condom" | "pill_only", "finished_inside": true | false } ],
  "orgasm": [ "user" and/or "char" ],
  "lifestyle": [ { "type": ${LIFESTYLE_TYPES.map(t => `"${t}"`).join(' | ')}, "who": "user" | "char", "fever": true | false } ],
  "injury": [ { "who": "user" | "char", "what": "a few words in Russian", "heal_hours": number } ],
  "pregnancy_test": true | false,
  "doctor_visit": true | false,
  "ultrasound": true | false,
  "partner_learns_pregnancy": true | false,
  "pregnancy_facts": [ "new facts about her pregnancy these messages establish, each up to 12 words in Russian" ],
  "baby_sex": null | "girl" | "boy" | ["girl", "boy"],
  "pregnancy_claim": null or { "weeks": number or null, "days": number or null, "partner_knows": true | false, "quote": "the words that say it, up to 15 words, as written" },
  "diagnoses": [] — almost always empty; only if these messages show a doctor finding it or state it as a fact: some of ${DIAGNOSES.map(d => `"${d}"`).join(', ')},
  "period": "started" | "ongoing" | "over" | null,
  "period_days_ago": number | null,
  "family": [ { "name": "the relative's own name, as written", "sex": "male" | "female" | null, "relation": ${relations}, "of": "user" | "char" | "the name of another relative" } ],
  "missed_pill": true | false,${health ? `
  "health": [ { "action": "illness_new" | "med_taken" | "med_stop" | "doctor_visit" | "cured" | "hospital" | "genetic_reveal", "who": "user" | "char", ... } ],` : ''}
  "emergency_pill": true | false,
  "relation": null or { "status": "strangers" | "acquaintances" | "friends" | "dating" | "couple" | "engaged" | "married" | "separated" | "divorced" | "exes", "met_now": true | false, "known_days": number | null, "together_days": number | null },
  "kids_view": [ { "who": "user" | "char", "view": "wants" | "open" | "not_now" | "against", "said_to_other": true | false } ],
  ${intim ? CLOSENESS_FIELD : ''}${full ? `
  ${full.field}` : ''}
  "people": {
    "user": { "energy": -3..3 or null, "libido": -3..3 or null, "mood": "1-3 words in Russian" or null, "note": "Russian, 1-2 sentences" or null },
    "char": { the same, plus "sperm_note": "Russian, 1-2 sentences" or null, "desire_trigger": "a short complete phrase in Russian" or null, "desire_shown": "3-6 words in Russian" or null }
  }
}
Rules:
- Service lines of other extensions ([MN: …], status blocks, trackers' tags) are not the story: never take the time, the date or events from them.
- Count intimacy only for actual intercourse between {{user}} and {{char}} in these messages.
- "scene_after_skip": true when the messages first jump forward in time and the scene with everything in it (closeness, drinking, a test, a doctor, an injury) comes after the jump ("four months later… he pours a whiskey"); false when things happen first and the time passes after them (they made love, then slept till morning), or when there is no jump.
${health ? `- "health": illnesses of the body and the mind of {{user}} and {{char}} only — events that HAPPEN in these messages; empty if none. Never an injury (that goes into "injury"), never a pregnancy or its symptoms (the tracker has them). Already tracked: ${health.known || 'nothing'} — use the same names, never report those as new.
  - "illness_new": someone falls ill or a mental condition shows ("name" in Russian, "type": "physical" | "mental", "severity": "mild" | "moderate" | "severe", "chronic": true | false, "fever": true | false, "about": one phrase in Russian on what it is, "care": ["Russian"], "meds": ["Russian, groups of medicines, no doses"]).
  - "med_taken": took a dose ("med", "for" — the illness); also something nobody prescribed. "med_stop": quit a medicine ("med").
  - "doctor_visit": a doctor or a therapist sees them ("diagnosis" — what the doctor said, "prescribed": [{ "name", "schedule", "days" }], "next_visit_days": number or null, "about", "care").
  - "cured": the illness ends in the story ("name"). "hospital": "state": "admit" | "discharge". "genetic_reveal": tests show a hereditary risk ("name", "risk" 1-95, "type").
` : ''}- "injury": only a NEW injury these messages cause — damage to the body (a bruise, a cut, a sprain, a burn, a fracture). A limb gone numb, tiredness, muscles sore from effort are not injuries (they go into "energy" or the scene's "discomfort"). The healing injuries in the tracker above are already known: never report them again, even in other words. "heal_hours": how long until it stops mattering, realistically and by how hard it was: a knocked finger or a light bump 1-6, a small bruise 24-72, a scratch or a graze 48-96, a cut 96-168, a sprain about 336, a fracture 1000+.
- "pregnancy_test", "doctor_visit", "ultrasound": true only when it BEGINS in these messages. A visit or a test that was already going on in the earlier reply (the same appointment continues, they talk about its results) is not a new one: false.
- "illness" only for a sickness with a raised temperature (flu, an infection, a cold with fever) — then "fever": true. Injuries, bruises, cuts, pain, a hangover or tiredness are NOT an illness: put an injury into "injury", tiredness into "energy".
- "pregnancy_claim": when these messages, the USER MESSAGE included, state as a fact that {{user}} is pregnant: she says or thinks it as something she knows, a positive test, a doctor confirms it, the narration says so. The user writes {{user}} herself, so her own words count even if the tracker says she is not pregnant. "weeks"/"days": the term the text names (months → weeks: 2 months ≈ 8 weeks; "two weeks of delay" ≈ 6 weeks), null if no term. "partner_knows": true if {{char}} knows in these messages. null when it is only a fear, a guess, a joke, a plan, a dream, a question, or nothing like that.
- "family": almost always empty. Only relatives of {{user}} or {{char}} that these messages name or show for the first time, or a relation that changes now: "name is relation of of" (Галина — mother of {{char}}: { "name": "Галина", "sex": "female", "relation": "parent", "of": "char" }). "name" is the relative's own name exactly as the story gives it — never a relation word or a description («мама», «бабушка», «мать Игоря»); a relative the messages do not name is not listed; names in the language of the story. Someone already on the family tree is never listed again under another form of the name. When {{user}} and {{char}} marry, become a couple${trackExes ? ' or break up' : ''} in these messages: { "name": "char", "relation": ${trackExes ? '"spouse" | "partner" | "ex"' : '"spouse" | "partner"'}, "of": "user" }.${trackExes ? '' : ' Former partners (exes) are not tracked: never list them.'} Not friends, colleagues or a relative only mentioned in passing; a baby born in the story is counted by the tracker itself.${intim ? `
${CLOSENESS_RULE}` : ''}${full ? `
${full.rules}` : ''}
- "relation": null unless their relationship changes in these messages or they meet for the first time: "status" — what they are to each other now (a first date → "dating"; they agree to be together → "couple"; a proposal accepted → "engaged"; a wedding → "married"; a breakup → "exes"); "met_now": true when {{user}} and {{char}} meet for the very first time. The tracker knows their status before: ${relNow}. When it is "unknown", report their status now whatever happens, with "known_days" / "together_days" — how long they have known each other / been together, only if the story makes it clear (null otherwise).
- "kids_view": only when someone states how they feel about having children in these messages (their own view, not a guess): "said_to_other" true if the other one heard it. Empty otherwise.
- "pregnancy_facts": only while the tracker says she is pregnant and knows it: what these messages establish about this pregnancy that is worth remembering for its whole course — a symptom that stays (strong nausea, swelling), a complication or a threat, what a doctor or a midwife said, twins, a decision (to keep it, to hide it). Not a passing feeling of this scene, not what the tracker already says. Empty if nothing new.
- "baby_sex": only while she is pregnant, and only when these messages state the baby's sex as a fact: a doctor or an ultrasound says it, she tells what the doctor said, the narration names it. A list for twins, one per baby. If it differs from the tracker, these messages win. null when the sex is not named, only hoped for, guessed or asked about; never invent it.
- "partner_learns_pregnancy": true only when {{char}} learns in these messages that {{user}} is pregnant (she tells him, he sees a positive test, a doctor says it with him there); false if he already knew, if it is only a guess or a fear, or if nothing like that happened.
- "past_intimacy": intercourse between {{user}} and {{char}} the messages speak of as already past and not shown in the story before ("three weeks ago we slept together", "they have been sleeping together since spring": the latest time), with how many days before the END of these messages it was; finished_inside true unless said otherwise; protection "none" unless said. Empty if nothing like that.
- "period": "started" if her period begins in these messages, "ongoing" if they plainly show she has it now (she says so, blood, pads, he knows it is her period), "over" if the messages show it came and already ended (during a time skip: "a week in bed with her period", "her period is over"); null if it is only a guess, PMS, or not shown.
- "period_days_ago": how many days before the END of these messages her period began — counted by the story time of these messages (a week-long skip that starts with her period: about 7). 0 when it begins right now; null when "period" is null.
- "diagnoses": only what a doctor finds in these messages or what the story states as a fact, never a guess from symptoms. {{char}}: "varicocele"; "vasectomy" if he had one before; "vasectomy_now" if he has the operation in these messages. {{user}}: "pcos", "endometriosis". Empty if nothing like that.
- "people": how each of them is RIGHT NOW. energy and libido: compared with their usual level as the story shows it now (0 as usual, −3 drained or not in the mood at all, +3 full of energy or burning with desire); null if the messages show nothing about it.
- "note" is a conclusion, not a retelling. The reader has just read the scene: never repeat what happened or what the person did. Say what the text leaves out: why this person is like this now, from the body. Put together the tracker data (cycle phase and its hormones, period, PMS, ovulation, pregnancy week, testosterone by the time of day, tiredness, recovery after a climax, alcohol, lack of sleep, illness, stress) and what the messages show. If they are irritable, angry, tearful, tired, cold or aroused, explain the bodily reason in plain words anyone understands: hormones, oestrogen, progesterone, testosterone, adrenaline, blood sugar are fine; no Latin, no clinical jargon. Where the body explains nothing, say what the state will likely lead to: what the person will need or want next. 1-2 short sentences in Russian, concise. Never invent events or symptoms that neither the tracker nor the messages support. null if nothing new.
  Never guess about a pregnancy in the notes: whether she is pregnant is decided by the tracker (and by "pregnancy_claim" when the text states it), not by you. Mention it only if the tracker says she is pregnant and knows it; if it says she does not know, or says nothing, do not mention a pregnancy or its signs at all (no «possible pregnancy», no «toxicosis»), explain her state by her cycle and the scene.
  Bad, a retelling: "Отнёсся к началу месячных у Нины спокойно: принёс воду и предложил обезболивающее."
  Good, a conclusion: "Вечером тестостерон ниже, напора нет, поэтому забота даётся ему легко; рядом с ней он сейчас скорее нежен, чем страстен."
  Good, a conclusion: "Раздражительность от ПМС: перед месячными падают эстроген и прогестерон, нервы тоньше, мелочи задевают сильнее."
- "desire_trigger" (only {{char}}, outside an intimate scene): what in these messages stirred his desire for {{user}}${turnOns ? ` — by what his card says turns him on (${turnOns}), or by the moment itself` : ''}: a short complete phrase in Russian, 3-8 words, natural and whole (a phrase one would say, never a cut-off fragment or a list), as it happened in the text. null if nothing did; never invent one.
- "desire_shown" (only {{char}}): if his desire for {{user}} showed in these messages, HOW it showed, 3-6 words in Russian, so later replies do not repeat it. null if it did not show.
- "sperm_note" (only {{char}}): what the body state shown in these messages and in the tracker means for his sperm and his chance to make her pregnant now: alcohol, smoking, heat (sauna, a hot bath), fever, stress, lack of sleep, long abstinence, several orgasms in a row, recovery. A short medical conclusion in plain words, like a calm doctor would say it, no retelling of the scene, no Latin. Say what is affected now and what only later (sperm matures about 74 days, so today's drinking shows in 2-3 months${erectionDrops ? ', while erection and desire suffer right away' : ''}). 1-2 short sentences in Russian. null if nothing in these messages bears on it.${erectionDrops ? `
  Good: "Вечер с алкоголем на сперму сейчас почти не влияет — скажется месяца через два-три, а вот эрекция и выносливость сегодня будут слабее."` : `
  In this story {{char}}'s erection is never weakened by drink, stress, tiredness or illness: never say it is, in any note.
  Good: "Вечер с алкоголем на сперму сейчас почти не влияет — скажется месяца через два-три."`}
  Good: "Три дня без разрядки: запас полный, сперматозоидов больше, чем обычно, — шанс зачатия сейчас выше среднего."`;
}

function parseJson(text) {
    const raw = String(text ?? '');
    if (!raw.trim()) throw new Error('модель вернула пустой ответ');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0) throw new Error('в ответе модели нет данных');
    if (end <= start) throw new Error('ответ модели оборван на середине (не хватило лимита токенов)');
    try {
        return JSON.parse(raw.slice(start, end + 1));
    } catch {
        throw new Error('анализ ответил не в том формате');
    }
}

/**
 * One request about the newest messages, through the connection chosen in Stork.
 * @param {object} input
 * @param {string} input.profileId the saved choice: a Connection Manager profile id or 'current'
 * @param {string} input.reason why it is read now (goes into the log)
 * @param {string} [input.replyKey] `${index}:${swipe}` of the reply, when read automatically
 * @param {number} [input.replyHash] its story hash
 */
export async function analyzeScene({ profileId, reason, replyKey, replyHash, ...input }) {
    const text = await requestModel({
        kind: 'scene', reason, replyKey, replyHash, choice: profileId, system: SYSTEM_PROMPT, prompt: buildScenePrompt(input), maxTokens: SCENE_MAX_TOKENS,
    });
    try {
        return parseJson(text);
    } catch (error) {
        remember({ kind: 'scene', outcome: 'bad-json', size: String(text ?? '').length, err: String(error?.message ?? error).slice(0, 120) });
        throw error;
    }
}
