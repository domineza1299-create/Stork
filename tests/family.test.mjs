// Run from the extension folder: node --test tests/*.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createState } from '../engine.js';
import { addBirths, addPerson, applyFindings, ensureFamily, findByName, genitive, labelOf, layoutFamily, link, linksOf, removePerson } from '../family.js';

const couple = () => {
    const state = createState({ userName: 'Нина', charName: 'Игорь Малеев', startDate: '2026-01-01' });
    ensureFamily(state);
    return state;
};

describe('family tree', () => {
    it('declines first names for the labels', () => {
        assert.equal(genitive('Нина', 'female'), 'Нины');
        assert.equal(genitive('Игорь Малеев', 'male'), 'Игоря');
        assert.equal(genitive('Маша', 'female'), 'Маши');
        assert.equal(genitive('Олег', 'male'), 'Олега');
        assert.equal(genitive('Любовь', 'female'), 'Любови');
    });

    it('takes relatives from the analysis, by name, without doubles', () => {
        const state = couple();
        const added = applyFindings(state, [
            { name: 'Мария Петровна', sex: 'female', relation: 'parent', of: 'char' },
            { name: 'Лена', sex: 'female', relation: 'sibling', of: 'user' },
            { name: 'Мария Петровна', sex: 'female', relation: 'parent', of: 'char' },
            { name: 'Кто-то', relation: 'friend', of: 'user' },
        ], 'card');
        assert.equal(added.length, 2);
        assert.equal(Object.keys(state.family.people).length, 2);
        const mom = findByName(state, 'Мария');
        assert.equal(labelOf(state, mom), 'мать Игоря');
        assert.equal(labelOf(state, findByName(state, 'Лена')), 'сестра Нины');
    });

    it('marries the two of them and does not step back to partners', () => {
        const state = couple();
        applyFindings(state, [{ name: 'Игорь', relation: 'partner', of: 'user' }]);
        applyFindings(state, [{ name: 'Игорь', relation: 'spouse', of: 'user' }]);
        applyFindings(state, [{ name: 'Игорь', relation: 'partner', of: 'user' }]);
        assert.deepEqual(state.family.links, [{ a: 'char', kind: 'spouse', b: 'user' }]);
        assert.deepEqual(linksOf(state, 'user').map(x => x.text), ['жена Игоря']);
    });

    it('adds babies born in the story as children of both', () => {
        const state = couple();
        const ids = addBirths(state, ['девочка', 'мальчик'], 300);
        assert.equal(ids.length, 2);
        assert.equal(labelOf(state, ids[0]), 'дочь Нины');
        assert.equal(state.family.links.filter(l => l.kind === 'parent').length, 4);
        addBirths(state, ['девочка'], 700);
        assert.equal(state.family.people.p3.name, 'Малышка 2');
    });

    it('lays out parents above, children below, a couple side by side', () => {
        const state = couple();
        link(state, 'char', 'spouse', 'user');
        const mom = addPerson(state, { name: 'Мария', sex: 'female' });
        const dad = addPerson(state, { name: 'Пётр', sex: 'male' });
        link(state, mom, 'parent', 'char');
        link(state, dad, 'parent', 'char');
        link(state, mom, 'spouse', dad);
        const [kid] = addBirths(state, ['мальчик'], 10);
        const L = layoutFamily(state);
        const at = Object.fromEntries(L.nodes.map(n => [n.id, n]));
        assert.ok(at[mom].y < at.char.y && at[kid].y > at.char.y, 'three rows');
        assert.equal(at.user.y, at.char.y);
        const kidMid = at[kid].x, coupleMid = (at.user.x + at.char.x) / 2;
        assert.ok(Math.abs(kidMid - coupleMid) < 1, 'the child under the middle of the couple');
        const momMid = (at[mom].x + at[dad].x) / 2;
        assert.ok(Math.abs(momMid - at.char.x) < 1, 'his parents over him');
        assert.equal(L.hearts.length, 2);
        assert.ok(new Set(L.nodes.map(n => `${n.x}:${n.y}`)).size === L.nodes.length, 'nobody on top of another');
    });

    it('removes a person with their links', () => {
        const state = couple();
        const id = addPerson(state, { name: 'Лена', sex: 'female' });
        link(state, id, 'sibling', 'user');
        removePerson(state, id);
        assert.equal(state.family.links.length, 0);
    });
});

describe('the same relative is never added twice', async () => {
    const { applyFindings, familyOptions, labelOf, layoutFamily, members, mergeDuplicates } = await import('../family.js');
    const { createState: fresh } = await import('../engine.js');
    const base = () => fresh({ userName: 'Нина', charName: 'Игорь' });
    const relatives = state => members(state).filter(p => !p.fixed);

    it('finds a name in another case and inside a relation word', () => {
        const state = base();
        applyFindings(state, [{ name: 'Галина Петровна', sex: 'female', relation: 'parent', of: 'char' }]);
        applyFindings(state, [{ name: 'Галина', sex: 'female', relation: 'parent', of: 'char' }]);
        applyFindings(state, [{ name: 'мама Галина', sex: 'female', relation: 'parent', of: 'char' }]);
        applyFindings(state, [{ name: 'Тамара', sex: 'female', relation: 'grandparent', of: 'char' }, { name: 'Галину', relation: 'parent', of: 'char' }]);
        assert.deepEqual(relatives(state).map(p => p.name), ['Галина Петровна', 'Тамара']);
        applyFindings(state, [{ name: 'Anya', sex: 'female', relation: 'sibling', of: 'char' }]);
        applyFindings(state, [{ name: 'Аня', sex: 'female', relation: 'sibling', of: 'char' }, { name: 'Ани', relation: 'sibling', of: 'char' }]);
        assert.deepEqual(relatives(state).filter(p => p.name === 'Anya' || p.name === 'Аня').map(p => p.name), ['Аня'], 'the card\'s «Anya» is the story\'s «Аня»');
    });

    it('adds nobody without a name, and names a nameless one from older versions when the story does', () => {
        const state = base();
        applyFindings(state, [{ name: 'бабушка Игоря', sex: 'female', relation: 'grandparent', of: 'char' }, { name: null, relation: 'parent', of: 'char' }]);
        assert.equal(relatives(state).length, 0, 'no «Бабушка», no «Родитель»');
        // a nameless grandmother saved by an older version
        state.family.people.p9 = { id: 'p9', name: 'Бабушка', sex: 'female' };
        state.family.links.push({ a: 'p9', kind: 'grandparent', b: 'char' });
        let rel = relatives(state);
        assert.equal(labelOf(state, 'p9'), 'Игоря', 'under «Бабушка» only whose, not «бабушка Игоря» again');
        applyFindings(state, [{ name: 'Зинаида', sex: 'female', relation: 'grandparent', of: 'char' }]);
        rel = relatives(state);
        assert.equal(rel.length, 1);
        assert.equal(rel[0].name, 'Зинаида');
        assert.equal(labelOf(state, rel[0].id), 'бабушка Игоря');
    });

    it('merges doubles saved by older versions', () => {
        const state = base();
        const fam = state.family;
        fam.people = {
            p1: { id: 'p1', name: 'Бабушка', sex: 'female' }, p2: { id: 'p2', name: 'Зинаида', sex: 'female' },
            p3: { id: 'p3', name: 'Олег', sex: 'male' }, p4: { id: 'p4', name: 'Олега', sex: 'male', age: 40 },
        };
        fam.links = [{ a: 'p1', kind: 'grandparent', b: 'char' }, { a: 'p2', kind: 'grandparent', b: 'char' }, { a: 'p3', kind: 'sibling', b: 'char' }, { a: 'char', kind: 'sibling', b: 'p4' }];
        fam.seq = 4;
        assert.equal(mergeDuplicates(state), 2);
        assert.deepEqual(relatives(state).map(p => [p.name, p.age ?? null]), [['Зинаида', null], ['Олег', 40]]);
    });

    it('leaves exes off the tree when they are not tracked', () => {
        const state = base();
        applyFindings(state, [{ name: 'char', relation: 'partner', of: 'user' }, { name: 'Вика', sex: 'female', relation: 'ex', of: 'char' }]);
        familyOptions.trackExes = false;
        try {
            applyFindings(state, [{ name: 'Денис', sex: 'male', relation: 'ex', of: 'user' }]);
            assert.ok(!relatives(state).some(p => p.name === 'Денис'), 'no new exes');
            assert.ok(!layoutFamily(state).nodes.some(n => n.name === 'Вика'), 'the old ones are hidden');
            applyFindings(state, [{ name: 'char', relation: 'ex', of: 'user' }]);
            assert.ok(!state.family.links.some(l => ['user', 'char'].includes(l.a) && ['user', 'char'].includes(l.b)), 'a break-up removes their line');
        } finally {
            familyOptions.trackExes = true;
        }
        assert.ok(layoutFamily(state).nodes.some(n => n.name === 'Вика'), 'shown again when tracked');
    });
});
