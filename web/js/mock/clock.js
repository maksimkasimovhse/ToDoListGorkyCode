// Часы заглушки: время заморожено на моменте из критериев приёмки [ФТ 16].
// Пояс — Москва, +03:00 круглый год, поэтому даты считаются простой арифметикой.

export const TIMEZONE = 'Europe/Moscow';
export const NOW = '2026-10-29T12:00:00+03:00';

const OFFSET = '+03:00';
const OFFSET_MS = 3 * 60 * 60 * 1000;

const WEEKDAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const WEEKDAYS_ON = ['в понедельник', 'во вторник', 'в среду', 'в четверг', 'в пятницу', 'в субботу', 'в воскресенье'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function shifted(ms) {
  return new Date(ms + OFFSET_MS).toISOString();
}

export function toIso(date, time = '00:00') {
  return `${date}T${time}:00${OFFSET}`;
}

/** Дата и время по Москве: { date: '2026-10-29', time: '12:00' } */
export function wall(iso) {
  const s = shifted(Date.parse(iso));
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}

export function addMinutes(iso, minutes) {
  const s = shifted(Date.parse(iso) + minutes * 60000);
  return toIso(s.slice(0, 10), s.slice(11, 16));
}

export function minutesBetween(fromIso, toIso_) {
  return Math.round((Date.parse(toIso_) - Date.parse(fromIso)) / 60000);
}

export function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 0 — понедельник */
export function weekday(date) {
  const [y, m, d] = date.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export function lastDayOfMonth(date) {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Метка времени «сейчас + n секунд», чтобы created_at у новых записей шли по порядку */
export function stamp(seconds) {
  return `${shifted(Date.parse(NOW) + seconds * 1000).slice(0, 19)}${OFFSET}`;
}

export const nowMs = () => Date.parse(NOW);
export const today = () => wall(NOW).date;
export const nowTime = () => wall(NOW).time;
export const mondayOf = (date) => addDays(date, -weekday(date));

export function weekdayName(date) {
  return WEEKDAYS[weekday(date)];
}

/** «30 октября» */
export function dayMonth(date) {
  const [, m, d] = date.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/** «сегодня» / «завтра» / «послезавтра» или null */
export function relativeDay(date) {
  const t = today();
  if (date === t) return 'сегодня';
  if (date === addDays(t, 1)) return 'завтра';
  if (date === addDays(t, 2)) return 'послезавтра';
  return null;
}

/** «завтра, пятница 30 октября» или «четверг 5 ноября» [ФТ 14] */
export function dayPhrase(date) {
  const base = `${weekdayName(date)} ${dayMonth(date)}`;
  const relative = relativeDay(date);
  return relative ? `${relative}, ${base}` : base;
}

/** «во вторник, 20 октября» */
export function onDay(date) {
  return `${WEEKDAYS_ON[weekday(date)]}, ${dayMonth(date)}`;
}
