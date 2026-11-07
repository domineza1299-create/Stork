/*
 * Them as a couple: how long they have known each other, how long they have been together, what they are to each
 * other now — and how each of them feels about having children, which the other knows only once it is said.
 * Pure: no SillyTavern imports, tested in Node.
 */

const DAY = 1440;
const absNow = state => state.clock.day * DAY + state.clock.minutes;

export const REL = {
    strangers: { ru: 'незнакомцы', en: 'strangers' },
    acquaintances: { ru: 'знакомые', en: 'acquaintances' },
    friends: { ru: 'друзья', en: 'friends' },
    dating: { ru: 'встречаются', en: 'dating', together: true },
    couple: { ru: 'пара', en: 'a couple', together: true },
    engaged: { ru: 'помолвлены', en: 'engaged', together: true },
    married: { ru: 'в браке', en: 'married', together: true },
    separated: { ru: 'в ссоре, порознь', en: 'separated' },
    divorced: { ru: 'в разводе', en: 'divorced' },
    exes: { ru: 'бывшие', en: 'exes' },
};
export const KIDS = {
    wants: { ru: 'хочет детей', en: 'wants children' },
    open: { ru: 'не против детей', en: 'open to children' },
    not_now: { ru: 'пока не хочет детей', en: 'does not want children yet' },
    against: { ru: 'против детей', en: 'does not want children' },
};

export function ensureBond(state) {
    state.bond ??= { status: null, metAt: null, togetherAt: null, statusAt: null };
    state.kids ??= { char: { view: null, known: false }, user: { view: null, known: false } };
    return state.bond;
}

const days = v => {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 && n < 365 * 80 ? n : null;
};

/** What the cards say: who they are to each other, since when; what each thinks of children. */
export function bondFromCards(state, a) {
    const b = ensureBond(state);
    const r = a?.relation ?? {};
    const now = absNow(state);
    if (REL[r.status]) { b.status = r.status; b.statusAt = now; }
    const met = days(r.met_days_ago);
    const together = days(r.together_days_ago);
    // they met no later than they got together
    if (met !== null) b.metAt = now - Math.max(met, together ?? 0) * DAY;
    else if (together !== null) b.metAt = now - together * DAY;
    else if (b.status && b.status !== 'strangers') b.metAt = now;
    if (REL[b.status]?.together) b.togetherAt = together !== null ? now - together * DAY : (b.metAt ?? now);
    const kids = a?.children_view ?? {};
    for (const key of ['char', 'user']) if (KIDS[kids[key]]) state.kids[key] = { view: kids[key], known: !!REL[b.status]?.together && b.status !== 'dating' };
}

/**
 * What a reading says changed: their status (a first meeting, a first date, a wedding, a breakup); someone's view
 * on children, and whether it was said to the other.
 * @returns {string[]} lines for Stork's journal
 */
export function applyBond(state, scene) {
    const b = ensureBond(state);
    const now = absNow(state);
    const out = [];
    const r = scene?.relation;
    if (r && typeof r === 'object') {
        if (r.met_now === true && b.metAt === null) {
            b.metAt = now;
            if (!b.status || b.status === 'strangers') { b.status = 'acquaintances'; b.statusAt = now; }
            out.push('познакомились');
        }
        if (REL[r.status] && r.status !== b.status) {
            const was = b.status;
            b.status = r.status;
            b.statusAt = now;
            if (was === null) {
                // the first reading of a chat Stork did not know them in: how long, only if the story makes it clear
                const known = days(r.known_days), together = days(r.together_days);
                if (REL[r.status].together) b.togetherAt = now - (together ?? 0) * DAY;
                // how long they have known each other only when the story says it (or since they got together);
                // a guess from the chat's start would be wrong for friends of years — then the line is not shown
                if (r.status !== 'strangers' && (known !== null || together !== null)) b.metAt = Math.min(known !== null ? now - known * DAY : Infinity, b.togetherAt ?? Infinity);
            } else {
                if (r.status !== 'strangers' && b.metAt === null) b.metAt = now;
                if (REL[r.status].together && !REL[was]?.together) b.togetherAt = now;
                out.push(`теперь ${REL[r.status].ru}`);
            }
            if (!REL[r.status].together) b.togetherAt = null;
        }
    }
    for (const k of Array.isArray(scene?.kids_view) ? scene.kids_view : []) {
        if ((k?.who !== 'char' && k?.who !== 'user') || !KIDS[k.view]) continue;
        const cur = state.kids[k.who];
        const changed = cur.view !== k.view;
        state.kids[k.who] = { view: k.view, known: cur.known || k.said_to_other === true };
        if (changed) out.push({ who: k.who, text: KIDS[k.view].ru });
    }
    return out;
}

/** «2 ч», «5 дн.», «3 мес.», «2 г. 4 мес.» */
export function spanRu(minutes) {
    const m = Math.max(0, Math.round(minutes));
    if (m < 60) return `${Math.max(1, m)} мин`;
    if (m < DAY) return `${Math.round(m / 60)} ч`;
    const d = Math.floor(m / DAY);
    if (d < 31) return `${d} дн.`;
    const months = Math.floor(d / 30.4);
    if (months < 12) return `${months} мес.`;
    const y = Math.floor(months / 12), rest = months % 12;
    return `${y} г.${rest ? ` ${rest} мес.` : ''}`;
}
const spanEn = minutes => spanRu(minutes).replace(' мин', ' min').replace(' ч', ' h').replace(' дн.', ' d').replace(' мес.', ' mo').replace(' г.', ' y');

/** For the windows: the lines that exist — no «together» while they are not. */
export function bondRows(state) {
    const b = state.bond;
    if (!b) return [];
    const now = absNow(state);
    const rows = [];
    if (b.status) rows.push({ icon: 'fa-user-group', label: 'Статус', value: REL[b.status].ru });
    if (b.metAt !== null && b.metAt !== undefined) rows.push({ icon: 'fa-handshake', label: 'Знакомы', value: spanRu(now - b.metAt) });
    if (b.togetherAt !== null && b.togetherAt !== undefined && REL[b.status]?.together) rows.push({ icon: 'fa-heart', label: 'Вместе', value: spanRu(now - b.togetherAt) });
    return rows;
}

/**
 * For the story model, very short: who they are to each other and since when; his own view on children and whether
 * he knows hers (her view itself is never told — the user writes her).
 */
export function bondLine(state) {
    const b = state.bond;
    const now = absNow(state);
    const parts = [];
    if (b?.status) parts.push(REL[b.status].en);
    if (b?.metAt !== null && b?.metAt !== undefined) parts.push(`met ${spanEn(now - b.metAt)} ago`);
    if (b?.togetherAt !== null && b?.togetherAt !== undefined && REL[b?.status]?.together) parts.push(`together ${spanEn(now - b.togetherAt)}`);
    const kids = state.kids;
    const his = kids?.char?.view ? `{{char}} ${KIDS[kids.char.view].en}` : '';
    const hers = kids?.user?.view ? (kids.user.known ? `he knows {{user}} ${KIDS[kids.user.view].en}` : "he does not know her view on children") : '';
    const all = [parts.join(', '), his, hers].filter(Boolean);
    return all.length ? `[Them: ${all.join('; ')}.]` : '';
}

/** How many of the two views on children each knows of the other: for «сыгранность». */
export function kidsKnowledge(state) {
    const k = state.kids;
    if (!k) return { known: 0, total: 0 };
    const items = ['char', 'user'].filter(key => k[key]?.view);
    return { known: items.filter(key => k[key].known).length, total: items.length };
}
