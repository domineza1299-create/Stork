/*
 * The «Генеалогическое древо» tab: the family tree as in the Sims — generations as rows, faces in frames, lines between them —
 * and the editor under it: names, photos and every link can be fixed by hand.
 * The data and the layout are in family.js; the buttons come here through handleAction in ui.js.
 */
import { getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { analyzeCards } from './cards.js';
import { avatarUrl, esc, icon, initials, years } from './common.js';
import { ensureProfileChoice } from './connection.js';
import {
    addPerson, applyFindings, ensureFamily, KIND_ORDER, KINDS, kindLabel, labelOf, layoutFamily, link, linksOf, memberById, members, NODE_W, removePerson,
    unlink, updatePerson,
} from './family.js';
import { notify, notifyDone, notifyWarn } from './notify.js';
import { settings, updateCurrentState } from './store.js';

/** A stored photo choice → the picture's address: a character card, a persona, or a link. */
export function avatarSrc(avatar) {
    const a = String(avatar ?? '');
    if (a.startsWith('char:')) return `/thumbnail?type=avatar&file=${encodeURIComponent(a.slice(5))}`;
    if (a.startsWith('persona:')) return `/thumbnail?type=persona&file=${encodeURIComponent(a.slice(8))}`;
    if (a.startsWith('url:')) {
        const url = a.slice(4).trim();
        return /^https?:\/\//i.test(url) || (url.startsWith('/') && !url.startsWith('//')) ? url : null;
    }
    return null;
}

function faceHtml(n) {
    const src = n.fixed ? avatarUrl(n.id) : avatarSrc(n.avatar);
    if (src) return `<img src="${esc(src)}" alt="" loading="lazy">`;
    if (n.source === 'birth' && (n.age ?? 0) < 3) return icon('fa-baby');
    return `<b>${esc(initials(n.name))}</b>`;
}

function nodeHtml(state, n, picked) {
    const sub = n.fixed ? (n.age ? years(n.age) : '') : labelOf(state, n.id);
    const cls = ['stk-fnode', n.fixed ? 'is-fixed' : '', n.sex === 'female' ? 'is-f' : n.sex === 'male' ? 'is-m' : '', picked ? 'is-on' : ''].filter(Boolean).join(' ');
    return `<button type="button" class="${cls}" data-stk-act="fam-pick" data-id="${esc(n.id)}" style="left:${n.x}px;top:${n.y}px" aria-pressed="${picked}">
        <span class="stk-fnode-img">${faceHtml(n)}</span><b>${esc(n.name.split(/\s+/)[0])}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</button>`;
}

/** The photo picker: a character card or a persona from SillyTavern, or a link to a picture. */
function avatarFields(current) {
    const ctx = getContext();
    const chars = (ctx.characters ?? []).filter(c => c?.avatar && c.avatar !== 'none').map(c => [c.avatar, c.name]).sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'ru'));
    const personas = Object.entries(ctx.powerUserSettings?.personas ?? {});
    const cur = String(current ?? '');
    const opt = (value, label) => `<option value="${esc(value)}" ${cur === value ? 'selected' : ''}>${esc(label)}</option>`;
    return `<label class="stk-field"><span>Фото</span>
            <select class="text_pole" data-f="avatar">
                ${opt('', 'без фото')}
                ${chars.length ? `<optgroup label="Персонажи">${chars.map(([file, name]) => opt(`char:${file}`, name)).join('')}</optgroup>` : ''}
                ${personas.length ? `<optgroup label="Персоны">${personas.map(([file, name]) => opt(`persona:${file}`, name)).join('')}</optgroup>` : ''}
            </select></label>
        <label class="stk-field"><span>или ссылка на картинку</span><input class="text_pole" data-f="avatarUrl" type="url" placeholder="https://…" value="${esc(cur.startsWith('url:') ? cur.slice(4) : '')}"></label>`;
}

const sexSelect = sex => `<select class="text_pole" data-f="sex">
        <option value="" ${!sex ? 'selected' : ''}>пол не указан</option>
        <option value="female" ${sex === 'female' ? 'selected' : ''}>женский</option>
        <option value="male" ${sex === 'male' ? 'selected' : ''}>мужской</option></select>`;

const kindSelect = (sex, name = 'kind') => `<select class="text_pole" data-f="${name}">${KIND_ORDER.map(k => `<option value="${k}">${esc(sex ? kindLabel(k, sex) : KINDS[k].x)}</option>`).join('')}</select>`;

const whoSelect = (state, except, name = 'to', selected = 'user') => `<select class="text_pole" data-f="${name}">${members(state).filter(m => m.id !== except)
    .map(m => `<option value="${esc(m.id)}" ${m.id === selected ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`;

function editorHtml(state, id) {
    const p = memberById(state, id);
    if (!p) return '';
    const rel = linksOf(state, id);
    return `<div class="stk-card stk-edit stk-fam-edit" data-key="fam">
        <div class="stk-card-title">${icon(p.sex === 'male' ? 'fa-mars' : p.sex === 'female' ? 'fa-venus' : 'fa-user')}${esc(p.name)}
            <button type="button" class="stk-pen" data-stk-act="fam-close" title="Закрыть" aria-label="Закрыть">${icon('fa-xmark')}</button></div>
        ${p.fixed ? `<div class="stk-row stk-muted">${icon('fa-circle-info')}Имя и фото — из SillyTavern. Здесь можно поправить связи.</div>` : `
        <label class="stk-field"><span>Имя</span><input class="text_pole" data-f="name" value="${esc(p.name)}"></label>
        <div class="stk-fam-pair">
            <label class="stk-field"><span>Пол</span>${sexSelect(p.sex)}</label>
            <label class="stk-field"><span>Возраст</span><input class="text_pole" data-f="age" type="number" min="0" max="120" value="${p.age ?? ''}"></label>
        </div>
        ${avatarFields(p.avatar)}`}
        <div class="stk-sub">Связи</div>
        ${rel.length ? rel.map(r => `<div class="stk-flink"><span>${esc(r.text)}</span><button type="button" class="stk-pen" data-stk-act="fam-unlink" data-i="${r.index}" title="Убрать связь" aria-label="Убрать связь">${icon('fa-xmark')}</button></div>`).join('')
        : `<div class="stk-row stk-muted">связей пока нет</div>`}
        <div class="stk-flink-add">${kindSelect(p.sex, 'lkind')}<span>для</span>${whoSelect(state, id, 'lto', id === 'user' ? 'char' : 'user')}
            <button type="button" class="stk-btn is-ghost" data-stk-act="fam-link">${icon('fa-link')}Связать</button></div>
        <div class="stk-actions">
            ${p.fixed ? '' : `<button type="button" class="stk-btn is-primary" data-stk-act="fam-save">${icon('fa-check')}Сохранить</button>
            <button type="button" class="stk-btn is-ghost" data-stk-act="fam-del" data-confirm="${esc(p.name)}">${icon('fa-trash')}Удалить</button>`}
        </div>
    </div>`;
}

function addFormHtml(state) {
    return `<div class="stk-card stk-edit stk-fam-edit" data-key="fam-add">
        <div class="stk-card-title">${icon('fa-user-plus')}Новый родственник</div>
        <label class="stk-field"><span>Имя</span><input class="text_pole" data-f="name" placeholder="Например, Галина Петровна"></label>
        <div class="stk-fam-pair">
            <label class="stk-field"><span>Пол</span>${sexSelect(null)}</label>
            <label class="stk-field"><span>Возраст</span><input class="text_pole" data-f="age" type="number" min="0" max="120"></label>
        </div>
        <div class="stk-flink-add"><span>Кем приходится</span>${kindSelect(null)}${whoSelect(state, null)}</div>
        ${avatarFields(null)}
        <div class="stk-actions">
            <button type="button" class="stk-btn is-primary" data-stk-act="fam-add-save">${icon('fa-check')}Добавить</button>
            <button type="button" class="stk-btn is-ghost" data-stk-act="fam-add-cancel">${icon('fa-xmark')}Отмена</button>
        </div>
    </div>`;
}

export function renderFamily(state, view = {}) {
    const L = layoutFamily(state);
    const lonely = L.nodes.length <= 2;
    const lines = `<svg class="stk-tree-lines" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}" aria-hidden="true">
        ${L.paths.map(p => `<path d="${p.d}" class="${p.cls}"/>`).join('')}</svg>`;
    const hearts = L.hearts.map(h => `<span class="stk-fheart" style="left:${h.x}px;top:${h.y}px">${icon('fa-heart')}</span>`).join('');
    return `<div class="stk-tree-scroll"><div class="stk-tree" style="width:${L.width}px;height:${L.height}px;--node-w:${NODE_W}px">
            ${lines}${hearts}${L.nodes.map(n => nodeHtml(state, n, view.famPick === n.id)).join('')}
        </div></div>
        ${lonely && !view.famAdd ? `<div class="stk-row stk-muted">${icon('fa-circle-info')}Родственники появятся сами, когда о них скажут карточки или история. Можно добавить и вручную.</div>` : ''}
        <div class="stk-actions stk-tree-tools">
            <button type="button" class="stk-btn" data-stk-act="fam-add">${icon('fa-user-plus')}Добавить</button>
            <button type="button" class="stk-btn is-ghost" data-stk-act="fam-cards" ${view.famBusy ? 'disabled' : ''}>${icon(view.famBusy ? 'fa-spinner fa-spin' : 'fa-address-card')}${view.famBusy ? 'Читаю карточки…' : 'Найти в карточках'}</button>
        </div>
        ${view.famAdd ? addFormHtml(state) : view.famPick ? editorHtml(state, view.famPick) : ''}`;
}

const avatarOf = v => (String(v.avatarUrl ?? '').trim() ? `url:${String(v.avatarUrl).trim()}` : v.avatar || null);

/**
 * The tab's buttons. values() reads the form the button is in.
 * @returns {boolean} the click was ours
 */
export function handleFamilyAction(act, target, view, values, rerender) {
    switch (act) {
        case 'fam-pick': {
            const id = target.dataset.id;
            view.famPick = view.famPick === id ? null : id;
            view.famAdd = false;
            break;
        }
        case 'fam-close': view.famPick = null; break;
        case 'fam-add': view.famAdd = true; view.famPick = null; break;
        case 'fam-add-cancel': view.famAdd = false; break;
        case 'fam-add-save': {
            const v = values();
            if (!String(v.name ?? '').trim()) {
                notifyWarn('Напиши имя', { timeOut: 2500 });
                return true;
            }
            let id = null;
            updateCurrentState(state => {
                ensureFamily(state);
                id = addPerson(state, { name: v.name, sex: v.sex, age: v.age, avatar: avatarOf(v), source: 'hand' });
                if (id) link(state, id, v.kind, v.to);
            });
            if (!id) {
                notifyWarn('Не получилось добавить: в древе уже слишком много людей', { timeOut: 3500 });
                return true;
            }
            view.famAdd = false;
            view.famPick = id;
            notifyDone('Добавлено в древо', { icon: 'fa-people-roof' });
            break;
        }
        case 'fam-save': {
            const v = values();
            updateCurrentState(state => updatePerson(state, view.famPick, { name: v.name, sex: v.sex, age: v.age, avatar: avatarOf(v) }));
            notifyDone('Сохранено', { icon: 'fa-people-roof' });
            break;
        }
        case 'fam-del': {
            // two taps: the first only asks
            if (target.dataset.armed !== '1') {
                target.dataset.armed = '1';
                target.innerHTML = `${icon('fa-trash')}Точно удалить?`;
                return true;
            }
            updateCurrentState(state => removePerson(state, view.famPick));
            view.famPick = null;
            notify('Удалено из древа', { icon: 'fa-trash', tone: 'calm', timeOut: 2500 });
            break;
        }
        case 'fam-link': {
            const v = values();
            let ok = false;
            updateCurrentState(state => { ok = link(state, view.famPick, v.lkind, v.lto); });
            if (!ok) notifyWarn('Такая связь уже есть', { timeOut: 2500 });
            break;
        }
        case 'fam-unlink': updateCurrentState(state => unlink(state, Number(target.dataset.i))); break;
        case 'fam-cards': {
            if (view.famBusy) return true;
            view.famBusy = true;
            rerender();
            (async () => {
                try {
                    ensureProfileChoice(settings(), saveSettingsDebounced);
                    const data = await analyzeCards(settings().readProfile, 'вкладка «Генеалогическое древо»: родственники из карточек');
                    let found = [];
                    updateCurrentState(state => { found = applyFindings(state, data?.family, 'card'); });
                    if (found.length) notifyDone(`Нашла в карточках: ${found.join('; ')}`, { icon: 'fa-people-roof', timeOut: 7000 });
                    else notify('В карточках новых родственников нет', { icon: 'fa-people-roof', tone: 'calm', timeOut: 4000 });
                } catch (error) {
                    notifyWarn(`Не получилось прочитать карточки: ${error?.message ?? error}`, { timeOut: 8000 });
                } finally {
                    view.famBusy = false;
                    rerender();
                }
            })();
            return true;
        }
        default: return false;
    }
    rerender();
    return true;
}
