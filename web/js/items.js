// Работа с моделью записи (contracts.md, раздел 1): какое у записи время, в какой день её показывать, как подписать.
import { addDays, dayKey, formatDay, formatDayMonth, formatTime } from './time.js';

export const TYPES = {
  meeting: { label: 'Встреча', plural: 'Встречи' },
  task: { label: 'Задача', plural: 'Задачи' },
  reminder: { label: 'Напоминание', plural: 'Напоминания' },
};

/** Момент со временем, к которому привязана запись, или null */
export function itemMoment(item) {
  if (item.type === 'meeting') return item.start_at;
  if (item.type === 'reminder') return item.remind_at;
  return item.due_at;
}

export function hasDate(item) {
  return Boolean(itemMoment(item) || item.due_date || item.period_end);
}

/**
 * День, в котором показывать запись. Срок-период прижимается к показанному диапазону [fromKey, toKey):
 * в списке на завтра «купить билеты до воскресенья» видна завтра, в списке на неделю — в воскресенье.
 */
export function itemDayKey(item, fromKey = null, toKey = null) {
  const moment = itemMoment(item);
  if (moment) return dayKey(moment);
  if (item.due_date) return item.due_date;
  if (item.period_end) {
    let key = dayKey(item.period_end);
    if (toKey && key >= toKey) key = addDays(toKey, -1);
    if (fromKey && key < fromKey) key = fromKey;
    return key;
  }
  return null;
}

/** «15:00–16:00», «10:00», «весь день» или '' */
export function timeLabel(item) {
  if (item.type === 'meeting') {
    if (item.all_day) return 'весь день';
    return item.end_at ? `${formatTime(item.start_at)}–${formatTime(item.end_at)}` : formatTime(item.start_at);
  }
  const moment = itemMoment(item);
  return moment ? formatTime(moment) : '';
}

/** Пометка срока задачи: «до 1 ноября», «без срока» */
export function dueNote(item) {
  if (item.type !== 'task' || item.due_at || item.due_date) return '';
  if (item.period_end) return `до ${formatDayMonth(dayKey(item.period_end))}`;
  return 'без срока';
}

/** «пятница, 30 октября, 15:00–16:00» */
export function whenLabel(item) {
  const moment = itemMoment(item);
  if (moment) return `${formatDay(dayKey(moment))}, ${timeLabel(item)}`;
  if (item.due_date) return formatDay(item.due_date);
  return dueNote(item);
}

/** Коротко для списка «Последнее»: «30 октября в 15:00» */
export function shortWhen(item) {
  const moment = itemMoment(item);
  if (moment) return `${formatDayMonth(dayKey(moment))} в ${formatTime(moment)}`;
  if (item.due_date) return formatDayMonth(item.due_date);
  return dueNote(item);
}

export function statusLabel(item) {
  if (item.status === 'done') {
    const word = item.type === 'reminder' ? 'выполнено' : 'выполнена';
    return item.completed_at ? `${word} ${formatDayMonth(dayKey(item.completed_at))}` : word;
  }
  if (item.status === 'cancelled') return 'отменена';
  if (item.computed && item.computed.overdue) return 'просрочена';
  return '';
}

/** Порядок внутри дня [ФТ 8]: сначала записи со временем по возрастанию, затем задачи на день, затем периоды */
export function compareItems(a, b) {
  const rank = (item) => (itemMoment(item) ? 0 : item.due_date ? 1 : 2);
  const diff = rank(a) - rank(b);
  if (diff) return diff;
  if (rank(a) === 0) return Date.parse(itemMoment(a)) - Date.parse(itemMoment(b));
  return a.title.localeCompare(b.title, 'ru');
}

/** [{ key, items }] по дням; записи без даты — в группе с key '' в конце */
export function groupByDay(items, fromKey = null, toKey = null) {
  const groups = new Map();
  for (const item of items) {
    const key = itemDayKey(item, fromKey, toKey) || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.keys()]
    .sort((a, b) => (a === '') - (b === '') || a.localeCompare(b))
    .map((key) => ({ key, items: groups.get(key).sort(compareItems) }));
}

const FIELD_LABELS = {
  start_at: 'Время',
  end_at: 'Окончание',
  remind_at: 'Напоминание',
  due_at: 'Срок',
  due_date: 'Срок',
  period_end: 'Срок',
  title: 'Название',
  participants: 'Участники',
  location: 'Место',
  type: 'Тип',
  status: 'Статус',
};

function fieldText(key, value, source) {
  if (value == null || (Array.isArray(value) && !value.length)) return '—';
  if (key === 'start_at') {
    const end = source.end_at ? `–${formatTime(source.end_at)}` : '';
    return `${formatDay(dayKey(value))}, ${formatTime(value)}${end}`;
  }
  if (key.endsWith('_at')) return `${formatDay(dayKey(value))}, ${formatTime(value)}`;
  if (key === 'due_date') return formatDay(value);
  if (key === 'period_end') return `до ${formatDayMonth(dayKey(value))}`;
  if (key === 'type') return TYPES[value] ? TYPES[value].label : value;
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

/** Строки «было → стало» для data.actions[].before / after */
export function describeChanges(before = {}, after = {}) {
  const rows = [];
  for (const key of Object.keys(after)) {
    if (key === 'period_start' || (key === 'end_at' && 'start_at' in after)) continue;
    const from = fieldText(key, before[key], before);
    const to = fieldText(key, after[key], after);
    if (from !== to) rows.push({ label: FIELD_LABELS[key] || key, from, to });
  }
  return rows;
}
