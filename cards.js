/*
 * Reads the character card ({{char}}, always male) and the persona ({{user}}, always female).
 * Names come straight from SillyTavern; age is found in the text for free,
 * and an analysis of the cards and the story opening fills the rest through the chosen connection.
 */
import { getContext } from '../../../extensions.js';
import { ConnectionManagerRequestService } from '../../shared.js';

import { cleanRpText } from './engine.js';

export { guessAge } from './engine.js';

/** Card texts are capped so one analysis stays cheap. */
const MAX_CHARS_PER_FIELD = 6000;
const ANALYSIS_MAX_TOKENS = 900;

const clip = text => cleanRpText(text).slice(0, MAX_CHARS_PER_FIELD);

/** Everything Stork can read about both people. */
export function readCards() {
    const context = getContext();
    let fields = {};
    try {
        fields = context.getCharacterCardFields?.() ?? {};
    } catch (error) {
        console.warn('[Stork] Could not read the card', error);
    }
    const charText = [
        ['Описание', fields.description],
        ['Личность', fields.personality],
        ['Сценарий', fields.scenario],
        ['Заметки автора', fields.creatorNotes],
    ].filter(([, text]) => String(text ?? '').trim()).map(([title, text]) => `${title}:\n${clip(text)}`).join('\n\n');
    // The real start of this chat: the greeting actually chosen, not only the card's default one
    const first = (context.chat ?? []).find(m => !m.is_system);
    const opening = first && !first.is_user ? clip(first.mes) : clip(fields.firstMessage);
    return {
        opening,
        charName: context.name2 ?? '',
        userName: context.name1 ?? '',
        charText,
        userText: clip(fields.persona),
        hasCharacter: context.characterId !== undefined && context.characterId !== null,
    };
}

const SYSTEM_PROMPT = `You read role-play cards and extract facts for a reproductive health tracker.
{{char}} is the man, {{user}} is the woman. Use only what the texts state or clearly imply; use null when unknown.
Reply with one JSON object and nothing else.`;

function buildPrompt(cards) {
    return `CHARACTER CARD ({{char}}, ${cards.charName}):
${cards.charText || '(empty)'}

PERSONA ({{user}}, ${cards.userName}):
${cards.userText || '(empty)'}

STORY OPENING (the first message of this chat):
${cards.opening || '(empty)'}

Return JSON exactly in this shape:
{
  "char": { "age": number|null, "fertility": "normal"|"low"|"sterile"|null, "smoker": boolean, "drinker": boolean, "overweight": boolean, "varicocele": boolean, "vasectomy": boolean },
  "user": { "age": number|null, "pregnant": boolean, "pregnancy_weeks": number|null, "children": number, "contraception": "none"|"pill"|"ring"|"patch"|"injection"|"implant"|"iud"|"copper_iud"|null, "cycle_length": number|null, "cycle_day": number|null, "flow": "light"|"normal"|"heavy"|null, "pms_severe": boolean, "painful_periods": boolean, "pcos": boolean, "endometriosis": boolean },
  "start": { "time": "HH:MM"|null, "date": "YYYY-MM-DD"|null, "place": "short place in Russian"|null },
  "story": { "relationship": "short phrase in Russian", "trying_for_baby": boolean, "summary": "1-2 sentences in Russian about what matters for the tracker in this story" }
}
"start" is when and where the story opening takes place, if it says so. "cycle_day" only if the texts say where she is in her cycle (period now, ovulation, period due soon).`;
}

function parseJson(text) {
    const raw = String(text ?? '');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('Модель не вернула данные. Попробуй ещё раз или выбери другой профиль.');
    try {
        return JSON.parse(raw.slice(start, end + 1));
    } catch {
        throw new Error('Модель ответила в неправильном формате. Попробуй ещё раз или выбери другой профиль.');
    }
}

/** A saved profile may not exist on this device (the phone has its own): fall back to the current connection. */
export function resolveProfileId(profileId) {
    return profileId && getProfiles().some(p => p.id === profileId) ? profileId : '';
}

export function getProfiles() {
    try {
        return ConnectionManagerRequestService.getSupportedProfiles();
    } catch {
        return [];
    }
}

/**
 * One request that reads both cards.
 * @param {string} profileId Connection Manager profile, or '' for the current connection
 */
export async function analyzeCards(savedProfileId) {
    const profileId = resolveProfileId(savedProfileId);
    const cards = readCards();
    const prompt = buildPrompt(cards);
    let text;
    if (profileId) {
        const response = await ConnectionManagerRequestService.sendRequest(profileId, [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
        ], ANALYSIS_MAX_TOKENS, { stream: false, extractData: true, includePreset: false });
        text = response?.content ?? '';
    } else {
        text = await getContext().generateRaw({ prompt, systemPrompt: SYSTEM_PROMPT, responseLength: ANALYSIS_MAX_TOKENS });
    }
    return parseJson(text);
}
