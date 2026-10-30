// Выборки по записям: периоды, просроченные, поиск, пересечения встреч.
import { addMinutes, nowMs, toIso, today, wall } from './clock.js';
import { getDb } from './store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ms = (iso) => Date.parse(iso);

export const alive = () => getDb().items.filter((item) => !item.deleted_at);
export const isActive = (item) => item.status === 'open' || item.status === 'scheduled';

export function isOverdue(item) {
  if (item.type !== 'task' || item.status !== 'open' || item.deleted_at) return false;
  if (item.due_at) return ms(item.due_at) < nowMs();
  if (item.due_date) return item.due_date < today();
  if (item.period_end) return ms(item.period_end) < nowMs();
  return false;
}

/** Запись в ответ API: с вычисляемыми полями (contracts.md, 1) */
export function present(item) {
  return { ...item, computed: { overdue: isOverdue(item), occurrence: null } };
}

/** Момент, к которому привязана запись: для сортировки и «была / будет» */
export function anchor(item) {
  if (item.type === 'meeting') return item.start_at;
  if (item.type === 'reminder') return item.remind_at;
  return item.due_at || (item.due_date ? toIso(item.due_date) : null) || item.period_end;
}

export function compareByTime(a, b) {
  const key = (item) => {
    const at = anchor(item);
    const rank = item.type === 'task' && !item.due_at ? (item.due_date ? 1 : 2) : 0;
    return [at ? wall(at).date : '9999-12-31', rank, at ? ms(at) : 0];
  };
  const [ka, kb] = [key(a), key(b)];
  return ka[0].localeCompare(kb[0]) || ka[1] - kb[1] || ka[2] - kb[2];
}

/** Попадает ли запись в [fromMs, toMs) [ФТ 8] */
export function overlaps(item, fromMs, toMs) {
  if (item.type === 'meeting') {
    const start = ms(item.start_at);
    const end = Math.max(ms(item.end_at || item.start_at), start + 1);
    return start < toMs && end > fromMs;
  }
  if (item.type === 'reminder') return ms(item.remind_at) >= fromMs && ms(item.remind_at) < toMs;
  if (item.due_at) return ms(item.due_at) >= fromMs && ms(item.due_at) < toMs;
  if (item.due_date) {
    const start = ms(toIso(item.due_date));
    return start < toMs && start + DAY_MS > fromMs;
  }
  if (item.period_end) return ms(item.period_start || item.created_at) < toMs && ms(item.period_end) >= fromMs;
  return false;
}

function matchesStatus(item, status) {
  if (!status) return isActive(item);
  if (status === 'all') return true;
  return item.status === status;
}

export function listItems({ fromMs = -Infinity, toMs = Infinity, types = null, status = null } = {}) {
  return alive()
    .filter((item) => (!types || types.includes(item.type)) && matchesStatus(item, status) && overlaps(item, fromMs, toMs))
    .sort(compareByTime);
}

export function overdueItems() {
  return alive().filter(isOverdue).sort(compareByTime);
}

export function undatedTasks() {
  return alive().filter((item) => item.type === 'task' && isActive(item) && !item.due_at && !item.due_date && !item.period_end);
}

// Поиск словами: основа слова + словарь синонимов. Заглушка вместо смыслового поиска на эмбеддингах [ФТ 9].
const SYNONYMS = [
  ['презентац', 'слайд', 'доклад'],
  ['договор', 'контракт'],
  ['билет', 'поезд', 'самолет', 'перелет'],
  ['зуб', 'стоматолог'],
  ['врач', 'доктор', 'прием'],
  ['почт', 'письм'],
];

export function stem(word) {
  const w = word.toLowerCase().replace(/ё/g, 'е');
  return w.length <= 4 ? w : w.slice(0, Math.max(4, w.length - 2));
}

function variants(word) {
  const s = stem(word);
  const group = SYNONYMS.find((g) => g.some((v) => v.startsWith(s) || s.startsWith(v)));
  return group ? [s, ...group] : [s];
}

function haystack(item) {
  return [item.title, item.source_text, ...(item.participants || [])].join(' ').toLowerCase().replace(/ё/g, 'е');
}

/** status: null — только открытые, 'all' — все, 'done' — выполненные. direction: 'past' | 'future' | 'any' */
export function searchItems({ words = [], participant = null, types = null, status = 'all', direction = 'any', fromMs = null, toMs = null }) {
  const forms = words.map(variants);
  const who = participant ? stem(participant) : null;
  const found = [];
  for (const item of alive()) {
    if (types && !types.includes(item.type)) continue;
    if (!matchesStatus(item, status)) continue;
    const text = haystack(item);
    if (who && !text.includes(who)) continue;
    if (!forms.every((f) => f.some((v) => text.includes(v)))) continue;
    const at = anchor(item);
    if (direction === 'past' && !(at && ms(at) < nowMs())) continue;
    if (direction === 'future' && !(at && ms(at) >= nowMs())) continue;
    if (fromMs != null && !overlaps(item, fromMs, toMs)) continue;
    found.push({ item, distance: at ? Math.abs(ms(at) - nowMs()) : Infinity });
  }
  // При равной релевантности — ближайшие по дате к сегодняшнему дню [ФТ 9]
  return found.sort((a, b) => a.distance - b.distance).map((entry) => entry.item);
}

/** Встречи, пересекающие интервал. Касание краёв — не конфликт [ФТ 12] */
export function conflicts(startIso, endIso, excludeId = null) {
  const start = ms(startIso);
  const end = ms(endIso);
  return alive()
    .filter((item) => item.type === 'meeting' && item.status === 'scheduled' && item.id !== excludeId)
    .filter((item) => ms(item.start_at) < end && start < ms(item.end_at))
    .sort(compareByTime);
}

/** Ближайшее свободное время того же дня или null */
export function freeSlot(startIso, durationMin, excludeId = null) {
  let start = startIso;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const clash = conflicts(start, addMinutes(start, durationMin), excludeId);
    if (!clash.length) return wall(start).date === wall(startIso).date ? start : null;
    start = clash.reduce((latest, item) => (ms(item.end_at) > ms(latest) ? item.end_at : latest), start);
  }
  return null;
}
