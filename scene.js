/*
 * Reads what happened in the role-play after each reply, through a chosen connection,
 * so the story model never has to know about Stork.
 */
import { getContext } from '../../../extensions.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { resolveProfileId } from './cards.js';
import { cleanRpText, SCENE_LIFESTYLE_TYPES as LIFESTYLE_TYPES } from './engine.js';

export { sceneToTag } from './engine.js';

// Room for the notes about both people; models with reasoning need more
const SCENE_MAX_TOKENS = 1200;
/** Only the newest part of long messages matters for what just happened. */
const MAX_MESSAGE_CHARS = 5000;
const MAX_EARLIER_CHARS = 1500;

const SYSTEM_PROMPT = `You track a role-play story for a reproductive health tracker.
{{user}} is the woman, {{char}} is the man. Read the newest messages and report only what actually happened in them.
Reply with one JSON object and nothing else.`;

export function buildScenePrompt({ userName, charName, dateText, status, earlier, userMessage, reply }) {
    return `Story time before these messages: ${dateText}.
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
  "intimacy": null or { "protection": "none" | "condom" | "pill_only", "finished_inside": true | false, "condom_broke": true | false, "after_time_skip": true | false },
  "orgasm": [ "user" and/or "char" ],
  "lifestyle": [ { "type": ${LIFESTYLE_TYPES.map(t => `"${t}"`).join(' | ')}, "who": "user" | "char", "fever": true | false } ],
  "injury": [ { "who": "user" | "char", "what": "a few words in Russian" } ],
  "pregnancy_test": true | false,
  "doctor_visit": true | false,
  "ultrasound": true | false,
  "partner_learns_pregnancy": true | false,
  "missed_pill": true | false,
  "emergency_pill": true | false,
  "people": {
    "user": { "energy": -3..3 or null, "libido": -3..3 or null, "mood": "1-3 words in Russian" or null, "note": "Russian, 1-2 sentences" or null },
    "char": { the same }
  }
}
Rules:
- Count intimacy only for actual intercourse between {{user}} and {{char}} in these messages.
- "after_time_skip": true when the messages first jump forward in time and the intercourse comes after the jump ("a week later they made love"); false when it happens first and the time passes after it (they made love, then slept till morning), or when there is no jump.
- "illness" only for a sickness with a raised temperature (flu, an infection, a cold with fever) — then "fever": true. Injuries, bruises, cuts, pain, a hangover or tiredness are NOT an illness: put an injury into "injury", tiredness into "energy".
- "partner_learns_pregnancy": true only when {{char}} learns in these messages that {{user}} is pregnant (she tells him, he sees a positive test, a doctor says it with him there); false if he already knew, if it is only a guess or a fear, or if nothing like that happened.
- "people": how each of them is RIGHT NOW by these messages. energy and libido: compared with their usual level as the story shows it now (0 as usual, −3 drained or not in the mood at all, +3 full of energy or burning with desire); null if the messages show nothing about it. note: how this person feels in body and mood now and why — what the story showed (tiredness, pain, arousal, calm after closeness, nausea, stress), written plainly; never invent what the messages don't show; null if nothing new.`;
}

function parseJson(text) {
    const raw = String(text ?? '');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('пустой ответ анализа');
    try {
        return JSON.parse(raw.slice(start, end + 1));
    } catch {
        throw new Error('анализ ответил не в том формате');
    }
}

/**
 * One request about the newest messages.
 * @param {string} profileId Connection Manager profile, or '' for the current connection
 */
export async function analyzeScene({ profileId: savedProfileId, ...input }) {
    const profileId = resolveProfileId(savedProfileId);
    const prompt = buildScenePrompt(input);
    let text;
    if (profileId) {
        const response = await ConnectionManagerRequestService.sendRequest(profileId, [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
        ], SCENE_MAX_TOKENS, { stream: false, extractData: true, includePreset: false });
        text = response?.content ?? '';
    } else {
        text = await getContext().generateRaw({ prompt, systemPrompt: SYSTEM_PROMPT, responseLength: SCENE_MAX_TOKENS });
    }
    return parseJson(text);
}
