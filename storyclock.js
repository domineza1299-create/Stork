/*
 * The story clock kept by the story model itself (the way of Almanac): every reply ends with a hidden line
 * <!-- AL 25.12.2026, пятница, 23:10 | +20м | умылась и почистила зубы -->
 * — the moment the reply ENDS, how much passed and what took the time. The model that writes the scene knows best
 * how long it took; a reader guessing minutes afterwards does worse. Stork cuts the line out of the chat, keeps it
 * on the message and moves its clock by it. Time never goes back.
 * The same line as Almanac's: with Almanac on, Stork adds no rule of its own and takes the time from it.
 * Pure: no SillyTavern imports, tested in Node.
 */

export const LINE_RE = /\s*<!--\s*AL\b([\s\S]*?)-->/gi;
const DAY = 1440;
const WD = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const WD_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = n => String(n).padStart(2, '0');

/** The rule for the story model, at the very end of the prompt. Almanac's wording. */
export function clockRule({ missed = false } = {}) {
    const lines = [`[Story clock — required]
Story time moves like real time. Before writing, settle the time in ONE short line of thought — no long deliberation:
- Every action takes time: cooking, washing, dressing, eating, travel, work, errands, sleep. A day spent in bed is a day; a cooked dinner is an hour or more even if nobody says so.
- Time passes for everyone at once: while {{user}} spent 3 hours on something, those same 3 hours passed for {{char}}, and he spent them on something of his own.
- Explicit jumps move the date: "woke up the next day at noon" → the next date, around 12:00; "a week later" → +7 days.
- Never move time backwards.
End the reply with one hidden line:
<!-- AL DD.MM.YYYY, день недели, HH:MM | +PASSED | WHY -->
DD.MM.YYYY, день недели (in Russian), HH:MM — the moment the reply ENDS. PASSED — time since the previous reply ended: +20м, +2ч30м, +1д4ч. WHY — at most 12 words in Russian: what took the time, for both of them.
Any other date or time this reply writes — a header, any other hidden line — must match this line exactly.`];
    if (missed) lines.push('Your previous reply had no AL line — include it now.');
    lines.push('Never mention or explain this line.');
    return lines.join('\n');
}

/** The time now for the story model: the source of truth, with the weekday. */
export function clockNow(iso, minutes) {
    const d = new Date(`${iso}T12:00:00Z`);
    if (Number.isNaN(d.getTime())) return '';
    const wd = d.getUTCDay();
    return `[Story clock — the source of truth for the date and time]
Now: ${WD[wd]} (${WD_EN[wd]}), ${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}, ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)} — the moment the previous reply ended.`;
}

/** «+20м», «+2ч30м», «+1д4ч», «+0» → minutes; null when there is nothing to read. */
export function parseSpan(s) {
    const src = String(s ?? '').toLowerCase().replace(',', '.');
    let total = 0, hit = false;
    const re = /(\d+(?:\.\d+)?)\s*(д|дн|дня|дней|сут|d|day|days|ч|час|часа|часов|h|hr|hrs|hour|hours|м|мин|минут|минуты|m|min|mins|minute|minutes)(?![a-zа-яё])\.?/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        hit = true;
        const v = parseFloat(m[1]);
        const u = m[2];
        total += /^(д|дн|дня|дней|сут|d|day|days)$/.test(u) ? v * DAY : /^(ч|час|часа|часов|h|hr|hrs|hour|hours)$/.test(u) ? v * 60 : v;
    }
    if (!hit) {
        const hm = src.match(/(\d{1,3}):(\d{2})/);
        if (hm) { hit = true; total = Number(hm[1]) * 60 + Number(hm[2]); } else if (/^\s*\+?\s*0\s*$/.test(src)) hit = true;
    }
    return hit ? Math.round(total) : null;
}

/**
 * The last time line in a text.
 * @returns {null|{ raw: string, date: string|null, minutes: number|null, passed: number|null, why: string|null }} date as ISO
 */
export function parseClockLine(text) {
    const all = [...String(text ?? '').matchAll(LINE_RE)];
    if (!all.length) return null;
    const inner = all[all.length - 1][1].trim();
    // models sometimes keep the labels of the rule: «PASSED: +5м | WHY: …»
    const segs = inner.split('|').map(x => x.trim().replace(/^(passed|why|прошло|почему|на что)\s*[:=—-]\s*/i, ''));
    const head = segs[0] || '';
    const dm = head.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
    const tm = head.match(/(?:^|[^\d.])(\d{1,2}):(\d{2})(?!\d)/);
    let date = null;
    if (dm) {
        const y = dm[3].length === 2 ? 2000 + Number(dm[3]) : Number(dm[3]);
        const probe = new Date(Date.UTC(y, Number(dm[2]) - 1, Number(dm[1])));
        if (probe.getUTCMonth() === Number(dm[2]) - 1 && probe.getUTCDate() === Number(dm[1])) date = probe.toISOString().slice(0, 10);
    }
    const minutes = tm && Number(tm[1]) < 24 && Number(tm[2]) < 60 ? Number(tm[1]) * 60 + Number(tm[2]) : null;
    const spanSeg = segs.slice(1).find(x => /^[+\s]*\d/.test(x) || /^\+/.test(x));
    const passed = spanSeg !== undefined ? parseSpan(spanSeg) : null;
    const why = segs.slice(1).filter(x => x !== spanSeg).join(' | ').trim().slice(0, 160) || null;
    return { raw: inner.slice(0, 200), date, minutes, passed, why };
}

export const stripClockLine = text => String(text ?? '').replace(LINE_RE, '').replace(/\s+$/, '');

/** Almanac's own record of a reply (minutes since 1970, UTC) as a time line. */
export function fromAlmanac(snap) {
    // the model wrote no line and Almanac only kept its old time: Stork's own reading counts instead
    if (!snap || snap.noTag || snap.bad || snap.t === null || snap.t === undefined || !Number.isFinite(Number(snap.t))) return null;
    const d = new Date(Number(snap.t) * 60000);
    return {
        raw: 'Almanac',
        date: d.toISOString().slice(0, 10),
        minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
        passed: Number.isFinite(snap.passed) ? snap.passed : null,
        why: snap.why ? String(snap.why).split('|').map(x => x.trim().replace(/^(passed|why|прошло|почему)\s*[:=—-]\s*/i, '')).filter(x => x && !/^\+?\s*\d+\s*[дчмdhm]/i.test(x)).join(' · ') || null : null,
        from: 'almanac',
    };
}

const dayNumber = iso => Math.round(new Date(`${iso}T12:00:00Z`).getTime() / 86400000);

/**
 * How far the clock moves by the line, from the moment now (story day `day` of a calendar starting `startDate`,
 * `minutes` into it). Never back: a line earlier than now takes its «+passed», or nothing.
 * `anchor`: the calendar is only a guess yet (dateSure false) — then the line's date re-dates it instead of moving
 * days, the way a date in a header does.
 * @returns {{ advance: number, anchorIso: string|null, note: string|null }}
 */
export function advanceByLine({ startDate, day, minutes, dateSure }, line) {
    if (!line) return { advance: 0, anchorIso: null, note: null };
    const passed = Math.max(0, line.passed ?? 0);
    // to the next moment the clock shows the line's time, keeping the whole days of «+passed»
    const toClock = () => {
        let delta = (line.minutes - minutes + DAY) % DAY;
        // «a few minutes earlier» than now and nothing long passed: the same moment, not tomorrow
        if (delta > 20 * 60 && passed < 4 * 60) delta = 0;
        return Math.floor(passed / DAY) * DAY + delta;
    };
    if (line.minutes === null) {
        return line.passed !== null ? { advance: passed, anchorIso: null, note: null } : { advance: 0, anchorIso: null, note: 'в строке нет времени' };
    }
    // no date, or a calendar that is only a guess yet: move by the clock; the line's date re-dates the calendar
    if (!line.date || !startDate || !dateSure) return { advance: toClock(), anchorIso: line.date ?? null, note: null };
    const target = (dayNumber(line.date) - dayNumber(startDate)) * DAY + line.minutes;
    const now = day * DAY + minutes;
    // the date runs far ahead of its own «+passed» («+13м» and nine months later): the calendar was wrong — the
    // story's date re-dates it, only the time of day moves
    const jump = target - now;
    if (line.passed !== null && jump - passed > 2 * DAY && passed < jump / 2) {
        return { advance: toClock(), anchorIso: line.date, note: `дата сверена с историей: ${line.date.split('-').reverse().join('.')} — это не скачок времени` };
    }
    if (target >= now) return { advance: target - now, anchorIso: null, note: null };
    // Almanac keeps the clock: an earlier moment of the same day means Stork had drifted ahead — it follows
    if (line.from === 'almanac' && Math.floor(target / DAY) === day) return { advance: 0, setMinutes: line.minutes, anchorIso: null, note: 'часы сверены с Almanac' };
    return { advance: passed, anchorIso: null, note: `модель повела время назад (${line.raw.split('|')[0].trim()}) — взято только «+${passed} мин»` };
}

/** «+20 мин», «+2 ч 30 мин», «+1 д 4 ч» */
export function spanText(min) {
    if (min === null || min === undefined) return '';
    let m = Math.max(0, Math.round(min));
    const d = Math.floor(m / DAY); m -= d * DAY;
    const h = Math.floor(m / 60); m -= h * 60;
    return `+${[d && `${d} д`, h && `${h} ч`, (m || (!d && !h)) && `${m} мин`].filter(Boolean).join(' ')}`;
}
