/*
 * The family tree: who is who to {{user}} and {{char}}.
 * Pure functions over state.family (saved with the chat like the rest of the state): the analysis of the cards
 * and of the story, the births and the editor all go through here, and Node tests it.
 * This module imports nothing: the engine, the window and the tests all use it.
 *
 * state.family = { seq, people: { p1: { id, name, sex, age, avatar, born, source } }, links: [{ a, kind, b }] }
 * {{user}} and {{char}} are not in people: they are state.people.user / .char, ids 'user' and 'char'.
 * A link reads «a is <kind> of b» and is stored one way only (a child is stored as its parent's link).
 */

/** Every relation: its generation offset (a against b) and its words by sex. */
export const KINDS = {
    parent: { gen: -1, m: 'отец', f: 'мать', x: 'родитель', back: 'child' },
    child: { gen: 1, m: 'сын', f: 'дочь', x: 'ребёнок', back: 'parent' },
    sibling: { gen: 0, m: 'брат', f: 'сестра', x: 'брат / сестра', back: 'sibling' },
    spouse: { gen: 0, m: 'муж', f: 'жена', x: 'супруг(а)', back: 'spouse' },
    partner: { gen: 0, m: 'партнёр', f: 'партнёрша', x: 'партнёр', back: 'partner' },
    ex: { gen: 0, m: 'бывший', f: 'бывшая', x: 'бывший партнёр', back: 'ex' },
    grandparent: { gen: -2, m: 'дедушка', f: 'бабушка', x: 'дедушка / бабушка', back: 'grandchild' },
    grandchild: { gen: 2, m: 'внук', f: 'внучка', x: 'внук / внучка', back: 'grandparent' },
    auncle: { gen: -1, m: 'дядя', f: 'тётя', x: 'дядя / тётя', back: 'niece' },
    niece: { gen: 1, m: 'племянник', f: 'племянница', x: 'племянник / племянница', back: 'auncle' },
    cousin: { gen: 0, m: 'двоюродный брат', f: 'двоюродная сестра', x: 'двоюродный брат / сестра', back: 'cousin' },
};
/** Kinds the editor offers, in this order. */
export const KIND_ORDER = ['parent', 'child', 'sibling', 'spouse', 'partner', 'ex', 'grandparent', 'grandchild', 'auncle', 'niece', 'cousin'];
const CANON = { child: 'parent', grandchild: 'grandparent', niece: 'auncle' };
const SYMMETRIC = new Set(['sibling', 'spouse', 'partner', 'ex', 'cousin']);
export const COUPLE = new Set(['spouse', 'partner', 'ex']);
const MAX_PEOPLE = 60;

export const emptyFamily = () => ({ seq: 0, people: {}, links: [] });
export function ensureFamily(state) {
    state.family ??= emptyFamily();
    state.family.people ??= {};
    state.family.links ??= [];
    state.family.seq ??= 0;
    return state.family;
}

const sexKey = sex => (sex === 'male' ? 'm' : sex === 'female' ? 'f' : 'x');
export const kindLabel = (kind, sex) => KINDS[kind]?.[sexKey(sex)] ?? '';

/** Everyone on the tree: the two of them first, then the relatives. */
export function members(state) {
    const fam = state.family ?? emptyFamily();
    const fixed = ['user', 'char'].filter(k => state.people?.[k]).map(k => ({ id: k, name: state.people[k].name || (k === 'user' ? 'Она' : 'Он'), sex: state.people[k].sex, age: state.people[k].age ?? null, fixed: true }));
    return [...fixed, ...Object.values(fam.people)];
}
export const memberById = (state, id) => members(state).find(p => p.id === id) ?? null;

const norm = s => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"'.,!?()]/g, ' ').replace(/\s+/g, ' ').trim();
const firstWord = s => norm(s).split(' ')[0] ?? '';

/** Someone on the tree by name: the full name, or the first name when only one person has it. */
export function findByName(state, name) {
    const n = norm(name);
    if (!n) return null;
    const all = members(state);
    const exact = all.find(p => norm(p.name) === n);
    if (exact) return exact.id;
    const first = firstWord(n);
    const same = all.filter(p => firstWord(p.name) === first);
    return same.length === 1 ? same[0].id : null;
}

/** «Нина» → «Нины», «Игорь» → «Игоря»: the genitive of a first name, for «мать Нины». Good for most Russian names. */
export function genitive(name, sex) {
    const w = String(name ?? '').trim().split(/\s+/)[0] ?? '';
    if (!/[а-яё]$/i.test(w)) return w;
    const low = w.toLowerCase();
    const last = low.slice(-1);
    const prev = low.slice(-2, -1);
    if (last === 'а') return w.slice(0, -1) + (/[гкхжшщч]/.test(prev) ? 'и' : 'ы');
    if (last === 'я') return w.slice(0, -1) + 'и';
    if (last === 'й') return w.slice(0, -1) + 'я';
    if (last === 'ь') return w.slice(0, -1) + (sex === 'female' ? 'и' : 'я');
    if (/[бвгджзклмнпрстфхцчшщ]/.test(last)) return sex === 'female' ? w : `${w}а`;
    return w;
}

export function addPerson(state, { name, sex = null, age = null, avatar = null, born = null, source = 'hand' }) {
    const fam = ensureFamily(state);
    if (Object.keys(fam.people).length >= MAX_PEOPLE) return null;
    const id = `p${++fam.seq}`;
    fam.people[id] = {
        id,
        name: String(name ?? '').trim().slice(0, 60) || 'Без имени',
        sex: sex === 'male' || sex === 'female' ? sex : null,
        age: Number.isFinite(Number(age)) && age !== null && age !== '' ? Math.max(0, Math.min(120, Math.round(Number(age)))) : null,
        avatar: avatar || null,
        born,
        source,
    };
    return id;
}

export function updatePerson(state, id, patch) {
    const p = ensureFamily(state).people[id];
    if (!p) return false;
    if (patch.name !== undefined) p.name = String(patch.name).trim().slice(0, 60) || p.name;
    if (patch.sex !== undefined) p.sex = patch.sex === 'male' || patch.sex === 'female' ? patch.sex : null;
    if (patch.age !== undefined) p.age = patch.age === '' || patch.age === null || !Number.isFinite(Number(patch.age)) ? null : Math.max(0, Math.min(120, Math.round(Number(patch.age))));
    if (patch.avatar !== undefined) p.avatar = patch.avatar || null;
    return true;
}

export function removePerson(state, id) {
    const fam = ensureFamily(state);
    if (!fam.people[id]) return false;
    delete fam.people[id];
    fam.links = fam.links.filter(l => l.a !== id && l.b !== id);
    return true;
}

/** The one link between two people, whichever way it is stored. */
const linkIndex = (fam, x, y) => fam.links.findIndex(l => (l.a === x && l.b === y) || (l.a === y && l.b === x));

/**
 * «a is kind of b». One relation per pair: a new one replaces the old (a partner becomes a spouse, a spouse an ex).
 * With soft: an existing spouse is not turned back into a partner (the story calling him «her man» again).
 */
export function link(state, a, kind, b, { soft = false } = {}) {
    if (!KINDS[kind] || !a || !b || a === b) return false;
    const ids = new Set(members(state).map(p => p.id));
    if (!ids.has(a) || !ids.has(b)) return false;
    const fam = ensureFamily(state);
    let entry = CANON[kind] ? { a: b, kind: CANON[kind], b: a } : { a, kind, b };
    if (SYMMETRIC.has(entry.kind) && entry.a > entry.b) entry = { a: entry.b, kind: entry.kind, b: entry.a };
    const at = linkIndex(fam, a, b);
    if (at >= 0) {
        const old = fam.links[at];
        if (old.a === entry.a && old.kind === entry.kind && old.b === entry.b) return false;
        if (soft && old.kind === 'spouse' && entry.kind === 'partner') return false;
        fam.links.splice(at, 1);
    }
    fam.links.push(entry);
    return true;
}

export function unlink(state, index) {
    const fam = ensureFamily(state);
    if (!fam.links[index]) return false;
    fam.links.splice(index, 1);
    return true;
}

/** What `id` is to `other` through a link, in words: «мать». */
function relationWord(state, linkEntry, id) {
    const me = memberById(state, id);
    const kind = linkEntry.a === id ? linkEntry.kind : KINDS[linkEntry.kind].back;
    return kindLabel(kind, me?.sex);
}

/** Every link of one person, in words from their side: «мать Нины». */
export function linksOf(state, id) {
    const fam = state.family ?? emptyFamily();
    return fam.links.map((l, index) => ({ l, index })).filter(({ l }) => l.a === id || l.b === id).map(({ l, index }) => {
        const otherId = l.a === id ? l.b : l.a;
        const other = memberById(state, otherId);
        return { index, otherId, text: `${relationWord(state, l, id)} ${genitive(other?.name, other?.sex)}`.trim() };
    });
}

/** The short label under a relative on the tree: their link to her or to him first. */
export function labelOf(state, id) {
    if (id === 'user' || id === 'char') return '';
    const all = linksOf(state, id);
    const main = all.find(x => x.otherId === 'user') ?? all.find(x => x.otherId === 'char') ?? all[0];
    return main?.text ?? '';
}

/**
 * What the analysis found: relatives the cards or the story name, and a marriage of the two of them.
 * item: { name, sex, relation, of, age? } — «name is relation of `of`»; `of` is "user", "char" or a name.
 * @returns {string[]} what was added or changed, in words for the log
 */
export function applyFindings(state, items, source = 'story') {
    if (!Array.isArray(items) || !items.length) return [];
    ensureFamily(state);
    const done = [];
    for (const item of items.slice(0, 12)) {
        const kind = String(item?.relation ?? '').toLowerCase();
        if (!KINDS[kind]) continue;
        const ofRaw = String(item?.of ?? '').trim();
        const of = ofRaw === 'user' || ofRaw === 'char' ? ofRaw : findByName(state, ofRaw);
        if (!of) continue;
        const name = String(item?.name ?? '').trim();
        if (!name || name.length > 60) continue;
        const sex = item.sex === 'male' || item.sex === 'female' ? item.sex : null;
        let id = name === 'user' || name === 'char' ? name : findByName(state, name);
        const isNew = !id;
        if (isNew) id = addPerson(state, { name, sex, age: item.age ?? null, source });
        if (!id || id === of) continue;
        const person = memberById(state, id);
        if (!isNew && !person.fixed && !person.sex && sex) person.sex = sex;
        const changedLink = link(state, id, kind, of, { soft: true });
        const ofPerson = memberById(state, of);
        if (isNew || changedLink) done.push(`${person.name} — ${kindLabel(kind, person.sex)} ${genitive(ofPerson?.name, ofPerson?.sex)}`);
    }
    return done;
}

/** A baby born in the story: a child of both of them on the tree. sexes: ['девочка', 'мальчик'] */
export function addBirths(state, sexes, day) {
    const mother = ['user', 'char'].find(k => state.people?.[k]?.sex === 'female');
    const father = ['user', 'char'].find(k => state.people?.[k]?.sex === 'male');
    const ids = [];
    for (const s of sexes ?? []) {
        const sex = s === 'девочка' ? 'female' : 'male';
        const base = sex === 'female' ? 'Малышка' : 'Малыш';
        const taken = members(state).filter(p => firstWord(p.name) === norm(base)).length;
        const id = addPerson(state, { name: taken ? `${base} ${taken + 1}` : base, sex, age: 0, born: day, source: 'birth' });
        if (!id) continue;
        if (mother) link(state, mother, 'parent', id);
        if (father) link(state, father, 'parent', id);
        ids.push(id);
    }
    return ids;
}

// #region Layout

export const NODE_W = 78;
export const NODE_H = 120;
export const PORTRAIT_H = 76;
const GAP_X = 16;
const ROW_H = 160;
const PAD = 20;
const SLOT = NODE_W + GAP_X;

/**
 * Where everyone stands: generations as rows (parents above, children below), a couple side by side,
 * children centred under their parents. Positions in px, plus the lines between them as SVG paths.
 * Small families of a role-play: a few passes of «stand near your own, then make room» are enough.
 */
export function layoutFamily(state) {
    const fam = state.family ?? emptyFamily();
    const list = members(state);
    const byId = Object.fromEntries(list.map(p => [p.id, p]));
    const links = fam.links.filter(l => byId[l.a] && byId[l.b] && KINDS[l.kind]);

    // generations: a is kind of b → gen(a) = gen(b) + offset
    const adj = Object.fromEntries(list.map(p => [p.id, []]));
    for (const l of links) {
        const d = KINDS[l.kind].gen;
        adj[l.b].push([l.a, d]);
        adj[l.a].push([l.b, -d]);
    }
    const gen = {};
    const walk = start => {
        const queue = [start];
        while (queue.length) {
            const id = queue.shift();
            for (const [next, d] of adj[id]) if (gen[next] === undefined) { gen[next] = gen[id] + d; queue.push(next); }
        }
    };
    for (const p of list) {
        if (gen[p.id] !== undefined) continue;
        gen[p.id] = 0;
        walk(p.id);
    }

    // rows outward from the two of them: 0, -1, 1, -2, 2…
    const gens = [...new Set(Object.values(gen))].sort((x, y) => Math.abs(x) - Math.abs(y) || x - y);
    const x = {};
    const sideOf = id => (id === 'user' ? -1 : 1);
    // a relative in another row (a child, a parent) says where to stand; one in the same row only says «next to me»
    const desiredOf = id => {
        const across = [], beside = [];
        for (const l of links) {
            if (l.a !== id && l.b !== id) continue;
            const other = l.a === id ? l.b : l.a;
            if (x[other] === undefined) continue;
            if (gen[other] === gen[id]) beside.push(x[other] + sideOf(other));
            else across.push(x[other]);
        }
        const wants = across.length ? across : beside;
        return wants.length ? wants.reduce((s, v) => s + v, 0) / wants.length : null;
    };
    for (const g of gens) {
        const row = list.filter(p => gen[p.id] === g).map(p => p.id);
        const want = {};
        if (g === 0) {
            if (row.includes('user')) { want.user = 0; x.user = 0; }
            if (row.includes('char')) { want.char = 1; x.char = 1; }
        }
        // place the ones with a placed relative first; each placed one helps the next
        let left = row.filter(id => want[id] === undefined);
        for (let pass = 0; pass < 3 && left.length; pass++) {
            for (const id of left) {
                const d = desiredOf(id);
                if (d !== null) { want[id] = d; x[id] = d; }
            }
            left = left.filter(id => want[id] === undefined);
        }
        let end = Math.max(0, ...Object.values(x).filter(Number.isFinite)) + 1;
        for (const id of left) { want[id] = end; x[id] = end; end += 1; }
        // make room: keep the order of the wishes, at least one slot apart, then centre on the wishes
        const order = row.map((id, n) => ({ id, w: want[id], n })).sort((p, q) => p.w - q.w || p.n - q.n);
        let prev = -Infinity;
        for (const o of order) { o.x = Math.max(o.w, prev + 1); prev = o.x; }
        const shift = order.reduce((s, o) => s + (o.w - o.x), 0) / (order.length || 1);
        for (const o of order) x[o.id] = o.x + shift;
    }

    const minX = Math.min(...Object.values(x));
    const minG = Math.min(...Object.values(gen));
    const pos = id => ({ x: PAD + (x[id] - minX) * SLOT, y: PAD + (gen[id] - minG) * ROW_H });
    const nodes = list.map(p => ({ ...p, gen: gen[p.id], ...pos(p.id) }));
    const at = Object.fromEntries(nodes.map(n => [n.id, n]));
    const cx = n => n.x + NODE_W / 2;
    const midY = n => n.y + PORTRAIT_H / 2;

    const paths = [];
    const hearts = [];
    // couples: a line between them at the height of the faces
    for (const l of links) {
        if (!COUPLE.has(l.kind)) continue;
        const p = at[l.a], q = at[l.b];
        if (p.gen !== q.gen) continue;
        const [lt, rt] = p.x < q.x ? [p, q] : [q, p];
        const y = midY(lt);
        paths.push({ d: `M${lt.x + NODE_W} ${y}H${rt.x}`, cls: `is-${l.kind}` });
        if (l.kind === 'spouse') hearts.push({ x: (lt.x + NODE_W + rt.x) / 2, y });
    }
    // children: from their parents (the middle of the couple, or one parent) down to a bus, then to each child
    const parentsOf = {};
    for (const l of links) if (l.kind === 'parent') (parentsOf[l.b] ??= []).push(l.a);
    const groups = {};
    for (const [child, ps] of Object.entries(parentsOf)) {
        const key = [...ps].sort().slice(0, 2).join('+');
        (groups[key] ??= []).push(child);
    }
    for (const [key, kids] of Object.entries(groups)) {
        const ps = key.split('+').map(id => at[id]);
        const sameRow = ps.length === 2 && ps[0].gen === ps[1].gen;
        const ox = sameRow ? (cx(ps[0]) + cx(ps[1])) / 2 : cx(ps[0]);
        const oy = sameRow ? midY(ps[0]) : ps[0].y + NODE_H;
        const top = Math.min(...kids.map(k => at[k].y));
        const busY = top - 24;
        const xs = kids.map(k => cx(at[k]));
        let d = `M${ox} ${oy}V${busY}H${Math.min(ox, ...xs)}H${Math.max(ox, ...xs)}`;
        for (const k of kids) d += `M${cx(at[k])} ${busY}V${at[k].y}`;
        paths.push({ d, cls: 'is-blood' });
        // two parents who are not a couple on the tree: a thin dotted line ties them
        if (ps.length === 2 && sameRow && !links.some(l => COUPLE.has(l.kind) && [l.a, l.b].includes(ps[0].id) && [l.a, l.b].includes(ps[1].id))) {
            const [lt, rt] = ps[0].x < ps[1].x ? [ps[0], ps[1]] : [ps[1], ps[0]];
            paths.push({ d: `M${lt.x + NODE_W} ${midY(lt)}H${rt.x}`, cls: 'is-coparent' });
        }
    }
    // siblings with no parents on the tree: a bracket over them
    for (const l of links) {
        if (l.kind !== 'sibling') continue;
        const p = at[l.a], q = at[l.b];
        if (parentsOf[l.a]?.some(id => parentsOf[l.b]?.includes(id))) continue;
        const y = Math.min(p.y, q.y) - 12;
        paths.push({ d: `M${cx(p)} ${p.y}V${y}H${cx(q)}V${q.y}`, cls: 'is-sibling' });
    }
    // the rest (grandparents, uncles, cousins): a dashed line
    for (const l of links) {
        if (['parent', 'sibling'].includes(l.kind) || COUPLE.has(l.kind)) continue;
        const p = at[l.a], q = at[l.b];
        const [up, down] = p.y <= q.y ? [p, q] : [q, p];
        const d = up.y === down.y
            ? `M${cx(up)} ${up.y}V${up.y - 8}H${cx(down)}V${down.y}`
            : `M${cx(up)} ${up.y + NODE_H}L${cx(down)} ${down.y}`;
        paths.push({ d, cls: 'is-far' });
    }
    const width = Math.max(...nodes.map(n => n.x)) + NODE_W + PAD;
    const height = Math.max(...nodes.map(n => n.y)) + NODE_H + PAD;
    return { nodes, paths, hearts, width, height };
}

// #endregion
