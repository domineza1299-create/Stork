/*
 * Reads what happened in the role-play after each reply, through a chosen connection,
 * so the story model never has to know about Stork.
 */
import { requestModel } from './connection.js';
import { cleanRpText, DIAGNOSES, SCENE_LIFESTYLE_TYPES as LIFESTYLE_TYPES } from './engine.js';

export { sceneToTag } from './engine.js';
export { errorText } from './connection.js';

// Room for the notes about both people; models with reasoning need more
const SCENE_MAX_TOKENS = 1200;
/** Only the newest part of long messages matters for what just happened. */
const MAX_MESSAGE_CHARS = 5000;
const MAX_EARLIER_CHARS = 1500;

const SYSTEM_PROMPT = `You track a role-play story for a reproductive health tracker.
{{user}} is the woman, {{char}} is the man. Report events only as they actually happened in the newest messages.
For how each of them is now, think like an attentive doctor: draw conclusions from the tracker's body data together with the scene.
Reply with one JSON object and nothing else.`;

export function buildScenePrompt({ userName, charName, dateText, status, earlier, userMessage, reply, skipCounted = false }) {
    return `Story time before these messages: ${dateText}.${skipCounted ? `
The time skip the user message opens with is ALREADY COUNTED: the time above is after it. "minutes" is only the time that passes after that, in the reply; the scene is set after the skip.` : ''}
{{user}} = ${userName} (woman), {{char}} = ${charName} (man).
${status ? `
HOW THEY ARE BY THE TRACKER (body and cycle; the story may show more):
${status}
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
  "minutes": how many minutes of story time passed in these messages (0 if a continuous scene; a night is about 480; "the next morning" about 720; "a week later" 10080),
  "clock": "HH:MM" time of day at the end of these messages if the text states it (for example a header like 22:40), otherwise null,
  "date": "YYYY-MM-DD" only if these messages name the calendar date (a header, a letter, a phone screen, "on the 15th of March"), otherwise null,
  "part_of_day": "morning" | "day" | "evening" | "night" — the time of day these messages end in, if the text makes it clear (light, meals, "at dawn", "late at night"), otherwise null,
  "scene_after_skip": true | false,
  "intimacy": null or { "protection": "none" | "condom" | "pill_only", "finished_inside": true | false, "condom_broke": true | false },
  "past_intimacy": [ { "days_ago": number, "protection": "none" | "condom" | "pill_only", "finished_inside": true | false } ],
  "orgasm": [ "user" and/or "char" ],
  "lifestyle": [ { "type": ${LIFESTYLE_TYPES.map(t => `"${t}"`).join(' | ')}, "who": "user" | "char", "fever": true | false } ],
  "injury": [ { "who": "user" | "char", "what": "a few words in Russian" } ],
  "pregnancy_test": true | false,
  "doctor_visit": true | false,
  "ultrasound": true | false,
  "partner_learns_pregnancy": true | false,
  "pregnancy_claim": null or { "weeks": number or null, "days": number or null, "partner_knows": true | false, "quote": "the words that say it, up to 15 words, as written" },
  "diagnoses": [ any of ${DIAGNOSES.map(d => `"${d}"`).join(', ')} ],
  "period": "started" | "ongoing" | null,
  "missed_pill": true | false,
  "emergency_pill": true | false,
  "people": {
    "user": { "energy": -3..3 or null, "libido": -3..3 or null, "mood": "1-3 words in Russian" or null, "note": "Russian, 1-2 sentences" or null },
    "char": { the same, plus "sperm_note": "Russian, 1-2 sentences" or null }
  }
}
Rules:
- Count intimacy only for actual intercourse between {{user}} and {{char}} in these messages.
- "scene_after_skip": true when the messages first jump forward in time and the scene with everything in it (closeness, drinking, a test, a doctor, an injury) comes after the jump ("four months later… he pours a whiskey"); false when things happen first and the time passes after them (they made love, then slept till morning), or when there is no jump.
- "illness" only for a sickness with a raised temperature (flu, an infection, a cold with fever) — then "fever": true. Injuries, bruises, cuts, pain, a hangover or tiredness are NOT an illness: put an injury into "injury", tiredness into "energy".
- "pregnancy_claim": when these messages, the USER MESSAGE included, state as a fact that {{user}} is pregnant: she says or thinks it as something she knows, a positive test, a doctor confirms it, the narration says so. The user writes {{user}} herself, so her own words count even if the tracker says she is not pregnant. "weeks"/"days": the term the text names (months → weeks: 2 months ≈ 8 weeks; "two weeks of delay" ≈ 6 weeks), null if no term. "partner_knows": true if {{char}} knows in these messages. null when it is only a fear, a guess, a joke, a plan, a dream, a question, or nothing like that.
- "partner_learns_pregnancy": true only when {{char}} learns in these messages that {{user}} is pregnant (she tells him, he sees a positive test, a doctor says it with him there); false if he already knew, if it is only a guess or a fear, or if nothing like that happened.
- "past_intimacy": intercourse between {{user}} and {{char}} the messages speak of as already past and not shown in the story before ("three weeks ago we slept together", "they have been sleeping together since spring": the latest time), with how many days before the END of these messages it was; finished_inside true unless said otherwise; protection "none" unless said. Empty if nothing like that.
- "period": "started" if her period begins in these messages, "ongoing" if they plainly show she has it now (she says so, blood, pads, he knows it is her period); null if it is only a guess, PMS, or not shown.
- "diagnoses": only what a doctor finds in these messages or what the story states as a fact, never a guess from symptoms. {{char}}: "varicocele"; "vasectomy" if he had one before; "vasectomy_now" if he has the operation in these messages. {{user}}: "pcos", "endometriosis". Empty if nothing like that.
- "people": how each of them is RIGHT NOW. energy and libido: compared with their usual level as the story shows it now (0 as usual, −3 drained or not in the mood at all, +3 full of energy or burning with desire); null if the messages show nothing about it.
- "note" is a conclusion, not a retelling. The reader has just read the scene: never repeat what happened or what the person did. Say what the text leaves out: why this person is like this now, from the body. Put together the tracker data (cycle phase and its hormones, period, PMS, ovulation, pregnancy week, testosterone by the time of day, tiredness, recovery after a climax, alcohol, lack of sleep, illness, stress) and what the messages show. If they are irritable, angry, tearful, tired, cold or aroused, explain the bodily reason in plain words anyone understands: hormones, oestrogen, progesterone, testosterone, adrenaline, blood sugar are fine; no Latin, no clinical jargon. Where the body explains nothing, say what the state will likely lead to: what the person will need or want next. 1-2 short sentences in Russian, concise. Never invent events or symptoms that neither the tracker nor the messages support. null if nothing new.
  Never guess about a pregnancy in the notes: whether she is pregnant is decided by the tracker (and by "pregnancy_claim" when the text states it), not by you. Mention it only if the tracker says she is pregnant and knows it; if it says she does not know, or says nothing, do not mention a pregnancy or its signs at all (no «possible pregnancy», no «toxicosis»), explain her state by her cycle and the scene.
  Bad, a retelling: "Отнёсся к началу месячных у Нины спокойно: принёс воду и предложил обезболивающее."
  Good, a conclusion: "Вечером тестостерон ниже, напора нет, поэтому забота даётся ему легко; рядом с ней он сейчас скорее нежен, чем страстен."
  Good, a conclusion: "Раздражительность от ПМС: перед месячными падают эстроген и прогестерон, нервы тоньше, мелочи задевают сильнее."
- "sperm_note" (only {{char}}): what the body state shown in these messages and in the tracker means for his sperm and his chance to make her pregnant now: alcohol, smoking, heat (sauna, a hot bath), fever, stress, lack of sleep, long abstinence, several orgasms in a row, recovery. A short medical conclusion in plain words, like a calm doctor would say it, no retelling of the scene, no Latin. Say what is affected now and what only later (sperm matures about 74 days, so today's drinking shows in 2-3 months, while erection and desire suffer right away). 1-2 short sentences in Russian. null if nothing in these messages bears on it.
  Good: "Вечер с алкоголем на сперму сейчас почти не влияет — скажется месяца через два-три, а вот эрекция и выносливость сегодня будут слабее."
  Good: "Три дня без разрядки: запас полный, сперматозоидов больше, чем обычно, — шанс зачатия сейчас выше среднего."`;
}

function parseJson(text) {
    const raw = String(text ?? '');
    if (!raw.trim()) throw new Error('модель вернула пустой ответ');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('в ответе модели нет данных');
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
    return parseJson(text);
}
