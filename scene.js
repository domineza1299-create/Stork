/*
 * Reads what happened in the role-play after each reply, through a chosen connection,
 * so the story model never has to know about Stork.
 */
import { getContext } from '../../../extensions.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { resolveProfileId } from './cards.js';
import { cleanRpText, DIAGNOSES, SCENE_LIFESTYLE_TYPES as LIFESTYLE_TYPES } from './engine.js';
import { recordCall } from './diag.js';

export { sceneToTag } from './engine.js';

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
  "diagnoses": [ any of ${DIAGNOSES.map(d => `"${d}"`).join(', ')} ],
  "period": "started" | "ongoing" | null,
  "missed_pill": true | false,
  "emergency_pill": true | false,
  "people": {
    "user": { "energy": -3..3 or null, "libido": -3..3 or null, "mood": "1-3 words in Russian" or null, "note": "Russian, 1-2 sentences" or null },
    "char": { the same }
  }
}
Rules:
- Count intimacy only for actual intercourse between {{user}} and {{char}} in these messages.
- "scene_after_skip": true when the messages first jump forward in time and the scene with everything in it (closeness, drinking, a test, a doctor, an injury) comes after the jump ("four months later… he pours a whiskey"); false when things happen first and the time passes after them (they made love, then slept till morning), or when there is no jump.
- "illness" only for a sickness with a raised temperature (flu, an infection, a cold with fever) — then "fever": true. Injuries, bruises, cuts, pain, a hangover or tiredness are NOT an illness: put an injury into "injury", tiredness into "energy".
- "partner_learns_pregnancy": true only when {{char}} learns in these messages that {{user}} is pregnant (she tells him, he sees a positive test, a doctor says it with him there); false if he already knew, if it is only a guess or a fear, or if nothing like that happened.
- "past_intimacy": intercourse between {{user}} and {{char}} the messages speak of as already past and not shown in the story before ("three weeks ago we slept together", "they have been sleeping together since spring": the latest time), with how many days before the END of these messages it was; finished_inside true unless said otherwise; protection "none" unless said. Empty if nothing like that.
- "period": "started" if her period begins in these messages, "ongoing" if they plainly show she has it now (she says so, blood, pads, he knows it is her period); null if it is only a guess, PMS, or not shown.
- "diagnoses": only what a doctor finds in these messages or what the story states as a fact, never a guess from symptoms. {{char}}: "varicocele"; "vasectomy" if he had one before; "vasectomy_now" if he has the operation in these messages. {{user}}: "pcos", "endometriosis". Empty if nothing like that.
- "people": how each of them is RIGHT NOW. energy and libido: compared with their usual level as the story shows it now (0 as usual, −3 drained or not in the mood at all, +3 full of energy or burning with desire); null if the messages show nothing about it.
- "note" is a conclusion, not a retelling. The reader has just read the scene: never repeat what happened or what the person did. Say what the text leaves out: why this person is like this now, from the body. Put together the tracker data (cycle phase and its hormones, period, PMS, ovulation, pregnancy week, testosterone by the time of day, tiredness, recovery after a climax, alcohol, lack of sleep, illness, stress) and what the messages show. If they are irritable, angry, tearful, tired, cold or aroused, explain the bodily reason in plain words anyone understands: hormones, oestrogen, progesterone, testosterone, adrenaline, blood sugar are fine; no Latin, no clinical jargon. Where the body explains nothing, say what the state will likely lead to: what the person will need or want next. 1-2 short sentences in Russian, concise. Never invent events or symptoms that neither the tracker nor the messages support. null if nothing new.
  Never guess about a pregnancy: whether she is pregnant is decided by the tracker, not by you. Mention it only if the tracker says she is pregnant and knows it; if it says she does not know, or says nothing, do not mention a pregnancy or its signs at all (no «possible pregnancy», no «toxicosis»), explain her state by her cycle and the scene.
  Bad, a retelling: "Отнёсся к началу месячных у Нины спокойно: принёс воду и предложил обезболивающее."
  Good, a conclusion: "Вечером тестостерон ниже, напора нет, поэтому забота даётся ему легко; рядом с ней он сейчас скорее нежен, чем страстен."
  Good, a conclusion: "Раздражительность от ПМС: перед месячными падают эстроген и прогестерон, нервы тоньше, мелочи задевают сильнее."`;
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

/** The error and what caused it («API request failed» says little without its cause). */
export const errorText = error => [error?.message ?? String(error), error?.cause?.message ?? (error?.cause ? String(error.cause) : '')].filter(Boolean).join(': ');

/**
 * One request about the newest messages. It is remembered for the problem report, whatever happens.
 * @param {string} profileId Connection Manager profile, or '' for the current connection
 */
export async function analyzeScene({ profileId: savedProfileId, ...input }) {
    const profileId = resolveProfileId(savedProfileId);
    const prompt = buildScenePrompt(input);
    const started = Date.now();
    const call = { kind: 'scene', profileId, maxTokens: SCENE_MAX_TOKENS, prompt: `${SYSTEM_PROMPT}\n\n${prompt}`, text: '' };
    try {
        call.text = await request(profileId, prompt, call);
        return parseJson(call.text);
    } catch (error) {
        call.error = errorText(error);
        throw error;
    } finally {
        call.ms = Date.now() - started;
        recordCall(call);
    }
}

async function request(profileId, prompt, call) {
    let text;
    if (profileId) {
        const response = await ConnectionManagerRequestService.sendRequest(profileId, [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
        ], SCENE_MAX_TOKENS, { stream: false, extractData: true, includePreset: false });
        call.response = response;
        text = response?.content ?? '';
    } else {
        text = await getContext().generateRaw({ prompt, systemPrompt: SYSTEM_PROMPT, responseLength: SCENE_MAX_TOKENS });
    }
    return String(text ?? '');
}
