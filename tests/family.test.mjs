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
