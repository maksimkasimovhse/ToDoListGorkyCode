// Даты в часовом поясе пользователя. «Сейчас» берём с сервера (/api/me → now), чтобы фронт и бэкенд
// одинаково понимали «сегодня», даже когда на демо часы сервера заморожены.

const WEEKDAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

let timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow';
let clockOffsetMs = 0;
const formatters = new Map();

export function configureClock({ timezone, now: serverNow } = {}) {
  if (timezone) {
    timeZone = timezone;
    formatters.clear();
  }
  if (serverNow) clockOffsetMs = Date.parse(serverNow) - Date.now();
}

export function getTimeZone() {
  return timeZone;
}

export function now() {
  return new Date(Date.now() + clockOffsetMs);
}

function formatter(locale, options) {
  const key = locale + JSON.stringify(options);
  if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat(locale, { ...options, timeZone }));
  return formatters.get(key);
}

function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}

/** 'YYYY-MM-DD' в поясе пользователя */
export function dayKey(value) {
  return formatter('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(toDate(value));
}

export function todayKey() {
  return dayKey(now());
}

export function addDays(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 0 — понедельник [ФТ 5] */
export function weekdayIndex(key) {
  const [y, m, d] = key.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function utcOffset(date) {
  const part = formatter('en-US', { timeZoneName: 'longOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName');
  const match = /GMT([+-]\d{2}):?(\d{2})?/.exec(part ? part.value : '');
  return match ? `${match[1]}:${match[2] || '00'}` : '+00:00';
}

/** Начало дня в поясе пользователя: '2026-10-30T00:00:00+03:00' */
export function startOfDayIso(key) {
  return `${key}T00:00:00${utcOffset(new Date(`${key}T12:00:00Z`))}`;
}

export function formatTime(value) {
  return formatter('ru-RU', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(toDate(value));
}

/** «30 октября» */
export function formatDayMonth(key) {
  const [, m, d] = key.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/** «пятница, 30 октября» */
export function formatDay(key) {
  return `${WEEKDAYS[weekdayIndex(key)]}, ${formatDayMonth(key)}`;
}

/** «Сегодня, 29 октября», «Завтра, 30 октября», «Суббота, 31 октября» */
export function dayTitle(key) {
  const today = todayKey();
  let prefix = capitalize(WEEKDAYS[weekdayIndex(key)]);
  if (key === today) prefix = 'Сегодня';
  else if (key === addDays(today, 1)) prefix = 'Завтра';
  else if (key === addDays(today, -1)) prefix = 'Вчера';
  return `${prefix}, ${formatDayMonth(key)}`;
}

export function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
