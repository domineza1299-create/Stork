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
    // The real start of this chat: the greeting actually chosen, not only the card's default one — and her own first
    // message, which often sets the scene itself («[OOC: декабрь, ночь…]»): Stork starts on it
    const chat = (context.chat ?? []).filter(m => !m.is_system);
    const first = chat[0];
    const greeting = first && !first.is_user ? clip(first.mes) : clip(fields.firstMessage);
    const start = first && !first.is_user ? 1 : 0;
    const hers = [];
    for (let i = start; i < chat.length && chat[i].is_user; i++) hers.push(chat[i].mes);
    const herText = hers.length ? clip(hers.join('\n\n')) : '';
    const opening = herText ? `${greeting}\n\n{{user}}'s first message:\n${herText}` : greeting;
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

STORY OPENING (the greeting of this chat, then {{user}}'s first message when there is one — it may set the scene: the date, the season, the time):
${cards.opening || '(empty)'}

Return JSON exactly in this shape:
{
  "char": { "age": number|null, "libido": "low"|"normal"|"high"|null, "fertility": "normal"|"low"|"sterile"|null, "smoker": boolean, "drinker": boolean, "varicocele": boolean, "vasectomy": boolean },
  "user": { "age": number|null, "smoker": boolean, "drinker": boolean, "pregnant": boolean, "pregnancy_weeks": number|null, "pregnancy_sex": "girl"|"boy"|null, "children": number, "contraception": "none"|"pill"|"ring"|"patch"|"injection"|"implant"|"iud"|"copper_iud"|null, "cycle_length": number|null, "cycle_day": number|null, "flow": "light"|"normal"|"heavy"|null, "pms_severe": boolean, "painful_periods": boolean, "pcos": boolean, "endometriosis": boolean },
  "start": { "time": "HH:MM"|null, "time_guessed": boolean, "date": "YYYY-MM-DD"|null, "date_guessed": boolean, "place": "a short place name in Russian"|null },
  "kinks": [ { "name": "a few words in Russian", "from": "card" | "persona" } ],
  "in_bed": { "char": "2-3 sentences in English" | null, "user": "1-2 sentences in English" | null },
  "experience": { "char": "experienced" | "some" | "inexperienced" | null, "user": "experienced" | "some" | "inexperienced" | null },
  "intimate_before": boolean,
  "bed_focus": { "char": "giving" | "self" | "balanced" | null },
  "relation": { "status": "strangers" | "acquaintances" | "friends" | "dating" | "couple" | "engaged" | "married" | "separated" | "divorced" | "exes" | null, "met_days_ago": number | null, "together_days_ago": number | null },
  "last_sex_days_ago": { "char": number | null, "user": number | null },
  "children_view": { "char": "wants" | "open" | "not_now" | "against" | null, "user": "wants" | "open" | "not_now" | "against" | null },
  "voice": "one sentence in English: how {{char}} talks and thinks",
  "family": [ { "name": "the relative's own name, as written", "sex": "male" | "female" | null, "relation": "parent" | "child" | "sibling" | "spouse" | "partner" | "ex" | "grandparent" | "grandchild" | "auncle" | "niece" | "cousin", "of": "user" | "char" | "the name of another relative", "age": number | null } ],
  "story": { "relationship": "a short phrase in Russian", "trying_for_baby": boolean, "summary": "1-2 sentences in Russian about what matters for the tracker in this story", "era": "modern"|"past" }
}
Rules:
- Ages: only a number the texts give or clearly imply (a student, "in her thirties" — the middle of the range); null otherwise.
- pregnancy_sex: only if the texts state the baby's sex; null otherwise.
- char "libido": his sexual temperament as the card describes it (a high libido, insatiable, hot-blooded → "high"; cold, indifferent, low drive → "low"); null if the card says nothing about it.
- Booleans are true only when the texts say so; habits count when they are part of who the person is (smokes, drinks often), not a single scene.
- contraception, cycle_length, cycle_day, flow: only if stated. cycle_day only if the texts say where she is in her cycle (period now, ovulation, period due soon).
- "start" is when and where the story opening takes place. When {{user}}'s first message sets it (even out of character, «[OOC: …]»: a month, a season, a year, «ночь»), that wins over the greeting and the card. time: the time of day when the opening takes place — exact if stated; otherwise the most plausible one from the opening itself (darkness or daylight, a meal, "ночью", "после работы", a party in full swing, someone going to bed: late night ≈ 23:30, evening ≈ 19:00, morning ≈ 08:00) with "time_guessed": true; null only if nothing at all hints at it. date: if the opening or the card names it; if not, the most plausible date by the setting (year of the setting, season, holidays, school or work rhythm) with "date_guessed": true; null only if there is nothing to go on.
- "family": relatives of {{char}} and {{user}} the texts name: parents, siblings, children, a spouse or an ex, grandparents. "name is relation of of". If {{user}} and {{char}} are married or a couple: { "name": "char", "relation": "spouse" | "partner", "of": "user" }. "name" is the relative's own name exactly as the texts give it (a first name, with a patronymic or surname if given) — never a relation word or a description («мама», «бабушка», «мать Игоря»); a relative the texts never name is not listed. Names in the language the story opening is written in («Аня», not «Anya», for a story in Russian). Each relative once. Empty if none.
- "kinks": every kink, fetish, sexual preference or turn-on the card or the persona names or clearly implies ("оральный секс", "разные позы", "заводит её грудь", "доминирование"), "from" where it is written. Each a short name of the turn-on itself, in the texts' own sense — the thing, not what it does to them («женская грудь», not «заводит женская грудь»); how they behave (who leads, giving in, being shy) is not a kink. Each kink once. Never invent; never anything they name as a limit or a dislike. Empty if none.
- "in_bed": from the card and the persona only. "char": {{char}} in bed — libido, experience, who leads, pace, what turns him on, habits, what he says or does not say. "user": {{user}} the same way. null for one the texts say nothing about.
- "experience": how experienced each is in bed, as the card or the persona says or clearly implies (many partners, a seducer, years of marriage → "experienced"; a virgin, little or no experience → "inexperienced"; in between → "some"); null when the texts say nothing.
- "intimate_before": true only if the texts say {{char}} and {{user}} have already been lovers (married, a couple who sleep together); false for strangers, new acquaintances or a couple that has not been intimate yet.
- "bed_focus": what drives {{char}} in bed by his card — "giving" (pleasing her matters most), "self" (his own pleasure first), "balanced"; null when the card says nothing.
- "relation": who they are to each other at the start of the story, by the texts and the opening. "met_days_ago" / "together_days_ago": how long ago they met / became a couple, if stated or clear (years → days); null otherwise.
- "last_sex_days_ago": how many days ago each of them last had sex or release before the story begins — think it through from the cards, the persona and the opening: someone in a relationship or who treats sex as an easy release — days; a shy one, single for a long time, not mentioning a partner — months; a virgin — null. A best guess is better than nothing; null only if there is nothing at all to go on.
- "children_view": how each feels about having children, only if the texts say it (wants a family → "wants"; not against → "open"; not now, career first → "not_now"; childfree, against → "against"); null otherwise.
- "voice": how {{char}} talks and thinks — vocabulary, temper, manner of speech — from the card, one sentence in English.
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
