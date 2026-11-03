/* Beta-only visual enhancer for the Settings tab. Core Stork remains untouched. */

const opened = new Map();
let scheduled = false;

const sections = [
    {
        id: 'reading', match: 'Чтение РП', title: 'Чтение РП', icon: 'fa-book-open-reader',
        note: 'Как Stork понимает каждый ответ',
        status: card => card.querySelector('[data-k="readMode"]')?.value === 'tag' ? 'Метка' : 'Анализ',
    },
    {
        id: 'view', match: 'Как показывать Stork в чате', title: 'Вид в чате', icon: 'fa-eye',
        note: 'Инфоблок, полоса или только окно',
        status: card => card.querySelector('.stk-tile.is-on b')?.textContent?.trim() || 'Настроено',
    },
    {
        id: 'model', match: 'Для модели', title: 'Для модели', icon: 'fa-comments',
        note: 'Что и куда Stork передаёт в контекст',
        status: card => card.querySelector('[data-k="detailed"]')?.checked ? 'Подробно' : 'Кратко',
    },
    {
        id: 'intimacy', match: 'Близость', title: 'Близость', icon: 'fa-fire-flame-curved',
        note: 'Режиссёр сцены и отдельный профиль',
        status: card => card.querySelector('[data-k="intimacy"]')?.checked ? 'Включена' : 'Выключена',
    },
    {
        id: 'realism', match: 'Реализм', title: 'Реализм', icon: 'fa-scale-balanced',
        note: 'Физиология и отслеживание бывших',
        status: card => {
            const toggles = [...card.querySelectorAll('input[type="checkbox"]')];
            const on = toggles.filter(x => x.checked).length;
            return toggles.length ? `${on} из ${toggles.length}` : 'Настроено';
        },
    },
    {
        id: 'notifications', match: 'Уведомления', title: 'Уведомления', icon: 'fa-bell',
        note: 'События цикла и беременности',
        status: card => card.querySelector('[data-k="toasts"]')?.checked ? 'Включены' : 'Выключены',
    },
    {
        id: 'chat', match: 'Этот чат', title: 'Этот чат', icon: 'fa-comment-dots',
        note: 'Шансы, персонажи и перечитывание',
        status: () => 'Активен',
    },
    {
        id: 'journal', match: 'Журнал Stork', title: 'Журнал Stork', icon: 'fa-file-lines',
        note: 'Запросы, события и ошибки',
        status: card => card.querySelector('.stk-log-count')?.textContent?.trim() || 'Журнал',
    },
];

function metaFor(card) {
    const title = card.querySelector(':scope > .stk-card-title')?.textContent?.trim() || '';
    return sections.find(item => title.startsWith(item.match)) || null;
}

function enhanceCard(card, meta) {
    if (card.dataset.stkSectionEnhanced) return;
    card.dataset.stkSectionEnhanced = meta.id;
    card.classList.add('stk-section-card');

    const oldTitle = card.querySelector(':scope > .stk-card-title');
    const iconHtml = oldTitle?.querySelector('.stk-ic')?.outerHTML || `<i class="fa-solid ${meta.icon} stk-ic" aria-hidden="true"></i>`;
    const status = meta.status(card);
    const isOpen = opened.get(meta.id) ?? false;

    const body = document.createElement('div');
    body.className = 'stk-section-body';
    body.hidden = !isOpen;

    const children = [...card.childNodes];
    for (const child of children) {
        if (child === oldTitle) continue;
        body.appendChild(child);
    }
    oldTitle?.remove();

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'stk-section-head';
    head.setAttribute('aria-expanded', String(isOpen));
    head.innerHTML = `
        <span class="stk-section-icon">${iconHtml}</span>
        <span class="stk-section-copy"><b>${meta.title}</b><small>${meta.note}</small></span>
        <span class="stk-section-status${/выключ/i.test(status) ? ' is-off' : ''}">${status}</span>
        <i class="fa-solid fa-chevron-down stk-section-chevron" aria-hidden="true"></i>`;

    const setOpen = open => {
        opened.set(meta.id, open);
        card.classList.toggle('is-open', open);
        body.hidden = !open;
        head.setAttribute('aria-expanded', String(open));
    };
    setOpen(isOpen);
    head.addEventListener('click', () => setOpen(!card.classList.contains('is-open')));

    card.append(head, body);
}

function enhanceSettings() {
    scheduled = false;
    const windows = document.querySelectorAll('.stk-window');
    for (const root of windows) {
        if (!root.querySelector('.stk-tab.is-on[data-tab="settings"]')) continue;
        const panel = root.querySelector('.stk-panel');
        if (!panel) continue;
        for (const card of panel.querySelectorAll(':scope > .stk-card:not(.stk-fold)')) {
            const meta = metaFor(card);
            if (meta) enhanceCard(card, meta);
        }
        const manual = panel.querySelector(':scope > details.stk-fold');
        if (manual) manual.classList.add('stk-section-manual');
    }
}

function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(enhanceSettings);
}

const observer = new MutationObserver(schedule);
observer.observe(document.documentElement, { childList: true, subtree: true });
schedule();
