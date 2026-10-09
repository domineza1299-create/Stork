/*
 * Reads what happened in the role-play after each reply, through a chosen connection,
 * so the story model never has to know about Stork.
 */
import { getContext } from '../../../extensions.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { resolveProfileId } from './cards.js';
import { cleanRpText, SCENE_LIFESTYLE_TYPES as LIFESTYLE_TYPES } from './engine.js';

export { sceneToTag } from './engine.js';

const SCENE_MAX_TOKENS = 400;
/** Only the newest part of long messages matters for what just happened. */
const MAX_MESSAGE_CHARS = 5000;

const SYSTEM_PROMPT = `You track a role-play story for a reproductive health tracker.
{{user}} is the woman, {{char}} is the man. Read the newest messages and report only what actually happened in them.
Reply with one JSON object and nothing else.`;


function buildPrompt({ userName, charName, dateText, userMessage, reply }) {
    return `Story time before these messages: ${dateText}.
{{user}} = ${userName} (woman), {{char}} = ${charName} (man).

USER MESSAGE:
${cleanRpText(userMessage).slice(-MAX_MESSAGE_CHARS) || '(none)'}

REPLY:
${cleanRpText(reply).slice(-MAX_MESSAGE_CHARS)}

Return JSON:
{
  "minutes": how many minutes of story time passed in these messages (0 if a continuous scene; a night is about 480; "the next morning" about 720; "a week later" 10080),
  "clock": "HH:MM" time of day at the end of these messages if the text states it (for example a header like 22:40), otherwise null,
  "intimacy": null or { "protection": "none" | "condom" | "pill_only", "finished_inside": true | false, "condom_broke": true | false },
  "orgasm": [ "user" and/or "char" ],
  "lifestyle": [ { "type": ${LIFESTYLE_TYPES.map(t => `"${t}"`).join(' | ')}, "who": "user" | "char" } ],
  "pregnancy_test": true | false,
  "doctor_visit": true | false,
  "ultrasound": true | false,
  "missed_pill": true | false,
  "emergency_pill": true | false
}
Count intimacy only for actual intercourse between {{user}} and {{char}} in these messages.`;
}

function parseJson(text) {
    const raw = String(text ?? '');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('пустой ответ анализа');
    return JSON.parse(raw.slice(start, end + 1));
}

/**
 * One request about the newest messages.
 * @param {string} profileId Connection Manager profile, or '' for the current connection
 */
export async function analyzeScene({ profileId: savedProfileId, userName, charName, dateText, userMessage, reply }) {
    const profileId = resolveProfileId(savedProfileId);
    const prompt = buildPrompt({ userName, charName, dateText, userMessage, reply });
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
