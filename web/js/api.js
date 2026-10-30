// Клиент API по contracts.md, раздел 2. Заглушка js/mock/server.js принимает те же пути и форматы,
// поэтому режим (CONFIG.MODE) меняет только то, кто отвечает, а не код вызовов.
import { CONFIG } from './config.js';
import { getTimeZone } from './time.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Маршрута нет в бэкенде или бэкенд недоступен — в режиме auto на это отвечает заглушка */
class RouteUnavailable extends ApiError {
  constructor(status, code, { permanent }) {
    super(status, code, 'Сервер недоступен');
    this.permanent = permanent;
  }
}

// Сообщает app.js, какие маршруты обслуживает заглушка: { detail: { route, reason } }
export const apiEvents = new EventTarget();

let mockModule = null;
const loadMock = () => (mockModule ??= import('./mock/server.js'));

// Маршруты, которых в бэкенде нет. Бэкенд при этом жив, так что до перезагрузки страницы не спрашиваем
const missingRoutes = new Set();

function authToken() {
  try {
    return localStorage.getItem('auth_token');
  } catch {
    return null;
  }
}

function toParams(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) continue;
    params.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  return params;
}

/** 'PATCH /api/items/7f3c…' → 'PATCH /api/items/:id' */
function routeKey(method, path) {
  const normalized = path
    .replace(/^\/api\/items\/(?!undated$|search$)[^/]+$/, '/api/items/:id')
    .replace(/^\/api\/messages\/[^/]+$/, '/api/messages/:id');
  return `${method} ${normalized}`;
}

/**
 * missing — что делать, если бэкенд жив, но маршрута в нём нет:
 * 'mock' — в режиме auto ответить заглушкой (в режиме backend это ошибка); 'error' — ошибка not_implemented
 * (действие над настоящей записью заглушка выполнить не может: она этой записи не знает);
 * функция — подставить её результат (профиль и сброс сессии без бэкенда не критичны).
 * Если бэкенд не запущен вовсе, в режиме auto отвечает заглушка: тогда все данные в ней и согласованы.
 */
async function request(method, path, { query, body, timeoutMs, missing = 'mock' } = {}) {
  const params = toParams(query);
  if (CONFIG.MODE === 'mock') return mockRequest(method, path, params, body);

  const route = routeKey(method, path);
  if (missingRoutes.has(route)) return whenMissing(missing, method, path, params, body, route);
  try {
    return await httpRequest(method, path, params, body, timeoutMs);
  } catch (error) {
    if (!(error instanceof RouteUnavailable)) throw error;
    if (error.permanent) missingRoutes.add(route);
    else if (CONFIG.MODE === 'auto') {
      apiEvents.dispatchEvent(new CustomEvent('fallback', { detail: { route, reason: error.code } }));
      return mockRequest(method, path, params, body);
    }
    if (typeof missing === 'function') return missing();
    if (CONFIG.MODE !== 'auto' || missing !== 'mock') throw error.permanent ? new ApiError(501, 'not_implemented', 'Бэкенд это пока не поддерживает') : error;
    return whenMissing(missing, method, path, params, body, route);
  }
}

function whenMissing(missing, method, path, params, body, route) {
  if (typeof missing === 'function') return missing();
  if (missing === 'mock' && CONFIG.MODE === 'auto') {
    apiEvents.dispatchEvent(new CustomEvent('fallback', { detail: { route, reason: 'not_implemented' } }));
    return mockRequest(method, path, params, body);
  }
  throw new ApiError(501, 'not_implemented', 'Бэкенд это пока не поддерживает');
}

async function mockRequest(method, path, params, body) {
  const mock = await loadMock();
  const result = await mock.handle(method, path, Object.fromEntries(params), body ?? null);
  if (result.status >= 400) {
    const error = result.body && result.body.error;
    throw new ApiError(result.status, error ? error.code : 'internal', error ? error.message : 'Ошибка сервера');
  }
  return result.body;
}

async function httpRequest(method, path, params, body, timeoutMs) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = authToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const qs = params.toString();
  let response;
  try {
    response = await fetch(`${CONFIG.API_BASE}${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new ApiError(0, 'timeout', 'Сервер не ответил вовремя');
    throw new RouteUnavailable(0, 'network', { permanent: false });
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => null);
  if (response.ok) return data;

  const error = data && data.error;
  // 404/405 без ошибки по контракту (2.7) — это ответ роутера chi «нет такого маршрута», а не «нет записи»
  if ((response.status === 404 || response.status === 405) && !error) {
    throw new RouteUnavailable(response.status, 'not_implemented', { permanent: true });
  }
  // Прокси перед бэкендом (если он есть) отвечает 502/503/504 без тела ошибки, когда бэкенд не запущен
  if ([502, 503, 504].includes(response.status) && !error) {
    throw new RouteUnavailable(response.status, 'backend_unavailable', { permanent: false });
  }
  throw new ApiError(response.status, error ? error.code : `http_${response.status}`, error ? error.message : 'Ошибка сервера');
}

const POLL_INTERVAL_MS = 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Сообщение ассистенту. Бэкенд принимает его асинхронно (backend/docs/async-contract.md):
 * POST отвечает 202 с message_id, а ответ ассистента приходит в GET /api/messages/{id}.
 * Заглушка отвечает сразу. Наружу в обоих случаях — готовый ответ в формате contracts.md 2.1.
 */
export async function sendMessage(payload) {
  // Бэкенд принимает text или choice, не оба сразу; подпись кнопки фронт уже показал в чате сам
  const body = { ...payload, text: payload.choice ? null : payload.text, timezone: getTimeZone() };
  const accepted = await request('POST', '/api/message', { body, timeoutMs: CONFIG.MESSAGE_TIMEOUT_MS });
  return waitForReply(accepted);
}

const DRAFT_TYPES = { create_task: 'task', create_reminder: 'reminder', create_meeting: 'meeting' };

/**
 * Ответ бэкенда → форма, которую рисует чат. Черновик уточнения бэкенд отдаёт как своё состояние
 * диалога ({ intent, params, missing, … }), а чат ждёт запись: { type, title, participants, date_hint }.
 */
function adaptReply(response) {
  if (!response) return null;
  const draft = response && response.data && response.data.draft;
  if (!draft || !draft.intent) return response;
  const params = draft.params || {};
  const card = DRAFT_TYPES[draft.intent]
    ? { type: DRAFT_TYPES[draft.intent], title: params.title || 'Без названия', participants: params.participants || [], date_hint: params.date || null }
    : null;
  return { ...response, data: { ...response.data, draft: card } };
}

const AWAITING = new Set(['awaiting_input', 'awaiting_confirmation']);

/**
 * Ответ ассистента из состояния сообщения бэкенда. Пока сценарий ждёт ответа пользователя
 * (awaiting_input / awaiting_confirmation), к ответу добавляется flow: чем продолжать диалог.
 */
export function replyFrom(message) {
  const reply = adaptReply(message.response);
  if (!reply) return null;
  if (!AWAITING.has(message.status)) return reply;
  return { ...reply, flow: { message_id: message.message_id, status: message.status, input_token: message.input_token, deadline_at: message.deadline_at } };
}

/**
 * Ждёт, пока бэкенд закончит этап: processing → ответ или ожидание формы. Заглушка отвечает сразу.
 * Состояния сценария: backend/docs/async-contract.md и dialogue-flow.md.
 */
export async function waitForReply(message) {
  if (!message || !('message_id' in message)) return message;
  // Срок задаёт сервер (MESSAGE_TIMEOUT, 15 с). Ждём чуть дольше, чтобы получить его собственную ошибку
  const deadline = Math.max(Date.parse(message.deadline_at) || 0, Date.now()) + 10000;
  let current = message;
  while (current.status === 'processing') {
    if (Date.now() > deadline) throw new ApiError(0, 'timeout', 'Сервер не ответил вовремя');
    await sleep(POLL_INTERVAL_MS);
    current = await request('GET', `/api/messages/${encodeURIComponent(current.message_id)}`);
  }
  const reply = replyFrom(current);
  if (reply) return reply;
  throw new ApiError(0, 'internal', 'Сервер не прислал ответ');
}

/** Продолжение сценария из формы: поля { date, time, title, duration_min } или { confirmed } */
export async function answerFlow(flow, fields) {
  const message = await request('POST', `/api/messages/${encodeURIComponent(flow.message_id)}/answer`, {
    body: { input_token: flow.input_token, ...fields },
    missing: 'error',
  });
  return waitForReply(message);
}

export async function cancelFlow(flow) {
  const message = await request('POST', `/api/messages/${encodeURIComponent(flow.message_id)}/cancel`, { missing: 'error' });
  return waitForReply(message);
}

/** Актуальное состояние сценария — после 409 stale_input / message_state */
export async function refreshFlow(flow) {
  return waitForReply(await request('GET', `/api/messages/${encodeURIComponent(flow.message_id)}`, { missing: 'error' }));
}

// Запросы записей тоже несут пояс: бэкенд по нему переводит даты без времени в моменты
export const getItems = ({ from, to, types, status, include_overdue } = {}) =>
  request('GET', '/api/items', { query: { from, to, types, status, include_overdue, timezone: getTimeZone() } });

// [не в контракте] Для панели «Последнее»: последние созданные записи. Предложено добавить в 2.3.
// Бэкенд sort пока не понимает и сортирует по сроку — список всё равно показывается.
export const getRecentItems = ({ types, limit = 20 } = {}) =>
  request('GET', '/api/items', { query: { sort: '-created_at', limit, types, timezone: getTimeZone() } });

export const getUndatedItems = (types) => request('GET', '/api/items/undated', { query: { types, timezone: getTimeZone() } });
export const searchItems = (q, limit = 20) => request('GET', '/api/items/search', { query: { q, limit, timezone: getTimeZone() } });
export const getItem = (id) => request('GET', `/api/items/${encodeURIComponent(id)}`);
export const patchItem = (id, changes) =>
  request('PATCH', `/api/items/${encodeURIComponent(id)}`, { body: changes, missing: 'error' });
export const deleteItem = (id) => request('DELETE', `/api/items/${encodeURIComponent(id)}`, { missing: 'error' });
export const undo = (undoToken) => request('POST', '/api/undo', { body: { undo_token: undoToken }, missing: 'error' });

export async function getHistory(sessionId) {
  const result = await request('GET', '/api/history', { query: { session_id: sessionId } });
  const entries = Array.isArray(result) ? result : (result && result.history) || [];
  for (const entry of entries) if (entry.response) entry.response = adaptReply(entry.response);
  return result;
}
// Сбрасывать в бэкенде нечего, если он этого не умеет: фронт всё равно начинает новую сессию
export const resetSession = (sessionId) =>
  request('POST', '/api/session/reset', { body: { session_id: sessionId }, missing: () => ({ ok: true }) });

// Без /api/me в бэкенде берём часы и пояс браузера: часы заглушки заморожены и с записями бэкенда не совпадут
export const getMe = () =>
  request('GET', '/api/me', { missing: () => ({ id: null, login: null, timezone: getTimeZone(), settings: {} }) });
export const getMissedReminders = (since) => request('GET', '/api/reminders/missed', { query: { since } });

/** Проверка жизни бэкенда (GET /healthz). В режиме mock бэкенда нет — false */
export async function checkHealth() {
  if (CONFIG.MODE === 'mock') return false;
  try {
    const response = await fetch(`${CONFIG.API_BASE}/healthz`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** События сервера (2.5). handlers: { reminder(payload), items_changed(payload) }. Возвращает функцию отписки. */
export function subscribe(handlers) {
  let unsubscribe = () => {};
  let closed = false;

  const useMock = async () => {
    const mock = await loadMock();
    if (!closed) unsubscribe = mock.subscribe(handlers);
  };

  if (CONFIG.MODE === 'mock' || !('EventSource' in window)) {
    if (CONFIG.MODE !== 'backend') useMock();
    return () => {
      closed = true;
      unsubscribe();
    };
  }

  // EventSource не умеет заголовок Authorization — токен передаём в query (предложено добавить в контракт)
  const token = authToken();
  const source = new EventSource(`${CONFIG.API_BASE}/api/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`);
  let opened = false;
  source.addEventListener('open', () => {
    opened = true;
  });
  // Поток ни разу не открылся — в бэкенде его нет. После обрыва открытого потока EventSource переподключается сам
  source.addEventListener('error', () => {
    if (opened) return;
    source.close();
    if (CONFIG.MODE !== 'auto') return;
    apiEvents.dispatchEvent(new CustomEvent('fallback', { detail: { route: 'GET /api/stream', reason: 'not_implemented' } }));
    useMock();
  });
  for (const [event, handler] of Object.entries(handlers)) {
    source.addEventListener(event, (message) => {
      try {
        handler(JSON.parse(message.data));
      } catch (error) {
        console.warn('Не разобрали событие', event, error);
      }
    });
  }
  unsubscribe = () => source.close();
  return () => {
    closed = true;
    unsubscribe();
  };
}
