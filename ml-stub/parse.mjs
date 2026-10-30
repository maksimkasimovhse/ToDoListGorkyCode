// Разбор фразы правилами вместо LLM: задание бэкенда (request) → результат модели (result).
// Формат — backend/docs/async-contract.md, параметры намерений — contracts.md, раздел 3.3.
// Правила общие с браузерной заглушкой: web/js/mock/nlu.js.
import { addDays, addMinutes, setNow, toIso, today, weekday } from '../web/js/mock/clock.js';
import {
  NO,
  YES,
  cleanTitle,
  detectIntent,
  listRange,
  listTypes,
  meetingTitle,
  normalize,
  parseBareTime,
  parseChanges,
  parseDate,
  parseDuration,
  parseOrdinal,
  parsePeriod,
  parseTime,
  resolveWhen,
  searchTerms,
  targetTerms,
} from '../web/js/mock/nlu.js';

const CREATE = { create_task: 'task', create_reminder: 'reminder', create_meeting: 'meeting' };
const CANCEL_RE = /^(отмена|отмени|не надо|забудь|стоп|хватит)$/;
// «Добавь встречу с Иваном в 15 и напомни купить хлеб вечером» — две команды создания [ФТ 4]
const SPLIT_RE = /\s+и\s+(?=(?:напомни|добавь|поставь|создай|запиши)\s)/i;

const ready = (actions) => ({ status: 'ready', actions, missing: [], question: null, options: [] });
const notUnderstood = () => ({ status: 'not_understood', actions: [], missing: [], question: null, options: [] });
const action = (intent, params = {}) => ({ intent, params });

/** request: { text, now, timezone, expects, draft, choice, … } → { status, actions, missing, question, options } */
export function parseRequest(request) {
  setNow(request.now);
  const raw = (request.text || '').trim();
  const t = normalize(raw);

  if (request.expects) {
    const answer = parseAnswer(request.expects, t, raw, request.choice);
    if (answer) return ready([answer]);
  }

  const intent = detectIntent(t);
  if (intent in CREATE) return parseCreate(raw);
  switch (intent) {
    case 'cancel':
    case 'help':
    case 'undo':
      return ready([action(intent)]);
    case 'list':
      return ready([action('list', listParams(t))]);
    case 'search': {
      const params = searchParams(t);
      return params ? ready([action('search', params)]) : notUnderstood();
    }
    case 'update':
      return ready([action('update', { target: target(t, 'update'), changes: parseChanges(t, raw) })]);
    case 'delete':
      return ready([action('delete', { target: target(t, 'delete') })]);
    case 'complete':
    case 'reopen':
      return ready([action('complete', { target: target(t, 'complete'), done: intent === 'complete' })]);
    default:
      return notUnderstood();
  }
}

// ---------- Ответ на вопрос ассистента [ФТ 11] ----------

/** Действие answer или null, если фраза — не ответ, а новая команда */
function parseAnswer(expects, t, raw, choice) {
  if (expects === 'yes_no') {
    if (choice && (choice.option_id === 'yes' || choice.option_id === 'no')) return action('answer', { value: choice.option_id === 'yes' });
    if (YES.test(t)) return action('answer', { value: true });
    if (NO.test(t)) return action('answer', { value: false });
    return null;
  }
  if (CANCEL_RE.test(t)) return null;

  const value = {};
  const date = parseDate(t);
  const time = parseBareTime(t) || parseTime(t);
  if (date) {
    value.date = date.date;
    if (date.time) value.time = date.time;
  }
  if (time) value.time = time.time;
  const duration = parseDuration(t);
  if (duration) value.duration_min = duration;
  if (expects === 'title' && !Object.keys(value).length && detectIntent(t) === 'unknown') value.title = cleanTitle(raw);

  if (Object.keys(value).length) return action('answer', { value });
  // Непонятный ответ: бэкенд переспросит. Явную новую команду обрабатываем как команду
  return detectIntent(t) === 'unknown' ? action('answer', { value: {} }) : null;
}

// ---------- Создание [ФТ 6, 7] ----------

function parseCreate(raw) {
  const parts = raw.split(SPLIT_RE).filter(Boolean);
  const parsed = parts.map(createAction);
  if (parsed.length > 1) return ready(parsed.map((p) => p.action));
  const [{ action: single, missing }] = parsed;
  if (!missing.length) return ready([single]);
  return { status: 'needs_clarification', actions: [single], missing, question: null, options: [] };
}

function createAction(raw) {
  const t = normalize(raw);
  let intent = detectIntent(t);
  if (!(intent in CREATE)) intent = 'create_task';

  // «Напомни про встречу с Иваном в 15» — встреча и напоминание к ней за 15 минут [ФТ 2]
  const reminderForMeeting = intent === 'create_reminder' && /про (встреч|созвон|совещани|собрани|планерк)/.test(t);
  if (reminderForMeeting) intent = 'create_meeting';

  const { date, time, endTime } = when(t);
  const params = { date, time };
  if (intent === 'create_meeting') {
    Object.assign(params, meetingTitle(raw), { end_time: endTime, duration_min: parseDuration(t), all_day: /весь день/.test(t) });
    if (reminderForMeeting) params.remind_before_min = 15;
  } else {
    params.title = cleanTitle(raw);
  }
  if (intent === 'create_task') {
    const period = parsePeriod(t);
    if (['this_week', 'next_week', 'month'].includes(period) && !date) params.period = period;
  }

  const missing = [];
  if (!params.title) missing.push('title');
  if (intent !== 'create_task') {
    if (!date && !time) missing.push('date');
    if (!time && !params.all_day) missing.push('time');
  }
  return { action: action(intent, params), missing };
}

/** Дата и время по правилам [ФТ 5]. Дата без времени при известном времени выбирает бэкенд */
function when(t) {
  const date = parseDate(t);
  const time = parseTime(t);
  const endTime = time && time.end_time ? time.end_time : null;
  if (!date) return { date: null, time: time ? time.time : null, endTime };
  // «через два часа» уже содержит время; явное «в 15» важнее
  const at = time && !date.relative ? time.time : date.time || null;
  if (!at) return { date: date.date, time: null, endTime };
  const resolved = resolveWhen({ date: date.date, time: at, sameWeekday: date.sameWeekday, relative: date.relative });
  return { date: resolved.date, time: resolved.time, endTime };
}

// ---------- Список [ФТ 8] ----------

function listParams(t) {
  const types = listTypes(t);
  const base = today();

  if (/следующ\S* встреч|когда следующ/.test(t)) {
    return { from: toIso(base), to: toIso(addDays(base, 366)), types: ['meeting'], kind: 'next' };
  }
  if (/все задачи|без срока/.test(t)) {
    return { from: toIso(addDays(base, -366)), to: toIso(addDays(base, 366)), types: ['task'], status: 'open', kind: 'list' };
  }
  if (/вчера/.test(t)) {
    const done = /сделал|выполнил|закрыл/.test(t);
    return { from: toIso(addDays(base, -1)), to: toIso(base), types, status: done ? 'done' : null, kind: 'list' };
  }

  const date = parseDate(t);
  const period = parsePeriod(t);
  let from;
  let to;
  if (date) [from, to] = [toIso(date.date), toIso(addDays(date.date, 1))];
  else if (period) [from, to] = listRange(period);
  else if (/выходн/.test(t)) {
    const saturday = addDays(base, (5 - weekday(base) + 7) % 7);
    [from, to] = [toIso(saturday), toIso(addDays(saturday, 2))];
  } else [from, to] = [toIso(base), toIso(addDays(base, 1))];

  // «Я свободен завтра в 15?» — есть ли встреча, пересекающая этот момент
  const time = parseTime(t);
  if (/свобод/.test(t) && time) {
    const at = toIso(date ? date.date : base, time.time);
    return { from: at, to: addMinutes(at, 1), types: ['meeting'], kind: 'free_check', yes_no: true };
  }
  return { from, to, types, kind: 'list', yes_no: /^есть ли|свобод/.test(t) };
}

// ---------- Поиск [ФТ 9] ----------

/** Бэкенд ищет подстрокой без морфологии, поэтому отдаём основу слова: «договору» → «догово» */
function stem(word) {
  return word.length <= 4 ? word : word.slice(0, Math.max(4, word.length - 2));
}

function searchParams(t) {
  const { words, participant, types, direction } = searchTerms(t);
  if (!words.length && !participant) return null;
  const longest = words.reduce((best, word) => (word.length > best.length ? word : best), '');
  const params = { query: longest ? stem(longest) : '', participant, types, direction, status: null };
  const period = parsePeriod(t);
  const bounds = period ? listRange(period) : null;
  if (bounds) [params.from, params.to] = bounds;
  return params;
}

// ---------- Цель изменения, удаления, выполнения [ФТ 10] ----------

function target(t, intent) {
  const number = parseOrdinal(t);
  if (number) return { ref: 'candidate', numbers: [number] };
  const terms = targetTerms(t, intent === 'complete' ? 'complete' : intent);
  if (terms.pronoun) return { ref: 'focus' };
  return {
    ref: 'filter',
    query: terms.words.join(' ') || null,
    participant: terms.participant,
    types: terms.types,
    from: null,
    to: null,
    status: 'open',
    all: terms.all,
  };
}
