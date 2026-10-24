/*
 * Reads the character card ({{char}}, always male) and the persona ({{user}}, always female).
 * Names come straight from SillyTavern; age is found in the text for free,
 * and an analysis of the cards and the story opening fills the rest through the chosen connection.
 */
import { getContext } from '../../../extensions.js';
import { requestModel } from './connection.js';
import { cleanRpText } from './engine.js';

export { getProfiles } from './connection.js';

export { guessAge } from './engine.js';

/** Card texts are capped so one analysis stays cheap. */
const MAX_CHARS_PER_FIELD = 6000;
// reasoning models think first, and the thinking counts against the limit: leave room for it
const ANALYSIS_MAX_TOKENS = 4000;

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
        ['Description', fields.description],
        ['Personality', fields.personality],
        ['Scenario', fields.scenario],
        ["Creator's notes", fields.creatorNotes],
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
Never guess health details, pregnancies or contraception the texts don't support. Reply with one JSON object and nothing else.`;

function buildPrompt(cards) {
    return `CHARACTER CARD ({{char}}, ${cards.charName}):
${cards.charText || '(empty)'}

PERSONA ({{user}}, ${cards.userName}):
${cards.userText || '(empty)'}

STORY OPENING (the first message of this chat):
${cards.opening || '(empty)'}

Return JSON exactly in this shape:
{
  "char": { "age": number|null, "fertility": "normal"|"low"|"sterile"|null, "smoker": boolean, "drinker": boolean, "varicocele": boolean, "vasectomy": boolean },
  "user": { "age": number|null, "smoker": boolean, "drinker": boolean, "pregnant": boolean, "pregnancy_weeks": number|null, "children": number, "contraception": "none"|"pill"|"ring"|"patch"|"injection"|"implant"|"iud"|"copper_iud"|null, "cycle_length": number|null, "cycle_day": number|null, "flow": "light"|"normal"|"heavy"|null, "pms_severe": boolean, "painful_periods": boolean, "pcos": boolean, "endometriosis": boolean },
  "start": { "time": "HH:MM"|null, "date": "YYYY-MM-DD"|null, "date_guessed": boolean, "place": "a short place name in Russian"|null },
  "family": [ { "name": "as written", "sex": "male" | "female" | null, "relation": "parent" | "child" | "sibling" | "spouse" | "partner" | "ex" | "grandparent" | "grandchild" | "auncle" | "niece" | "cousin", "of": "user" | "char" | "the name of another relative", "age": number | null } ],
  "story": { "relationship": "a short phrase in Russian", "trying_for_baby": boolean, "summary": "1-2 sentences in Russian about what matters for the tracker in this story", "era": "modern"|"past" }
}
Rules:
- Ages: only a number the texts give or clearly imply (a student, "in her thirties" — the middle of the range); null otherwise.
- Booleans are true only when the texts say so; habits count when they are part of who the person is (smokes, drinks often), not a single scene.
- contraception, cycle_length, cycle_day, flow: only if stated. cycle_day only if the texts say where she is in her cycle (period now, ovulation, period due soon).
- "start" is when and where the story opening takes place. time: if stated or clear (morning, late evening). date: if the opening or the card names it; if not, the most plausible date by the setting (year of the setting, season, holidays, school or work rhythm) with "date_guessed": true; null only if there is nothing to go on.
- "family": relatives of {{char}} and {{user}} the texts name: parents, siblings, children, a spouse or an ex, grandparents. "name is relation of of". If {{user}} and {{char}} are married or a couple: { "name": "char", "relation": "spouse" | "partner", "of": "user" }. A relative with no name: a short Russian description as the name («мать Игоря»). Empty if none.
- "summary": only what matters for the body and the relationship (are they a couple, living together, planning a child, any health facts); no retelling.`;
}

function parseJson(text) {
    const raw = String(text ?? '');
    if (!raw.trim()) throw new Error('Модель вернула пустой ответ. Попробуй ещё раз или выбери другой профиль.');
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('Модель не вернула данные. Попробуй ещё раз или выбери другой профиль.');
    try {
        return JSON.parse(raw.slice(start, end + 1));
    } catch {
        throw new Error('Модель ответила в неправильном формате. Попробуй ещё раз или выбери другой профиль.');
    }
}

/**
 * One request that reads both cards and the story opening, through the connection chosen in Stork.
 * @param {string} choice a Connection Manager profile id or 'current'
 * @param {string} [reason] why it is read now (goes into the log)
 */
export async function analyzeCards(choice, reason = 'настройка Stork в этом чате') {
    const text = await requestModel({ kind: 'cards', reason, choice, system: SYSTEM_PROMPT, prompt: buildPrompt(readCards()), maxTokens: ANALYSIS_MAX_TOKENS });
    return parseJson(text);
}
