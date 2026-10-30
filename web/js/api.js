// Клиент API по contracts.md, раздел 2. Заглушка js/mock/server.js принимает те же пути и форматы,
// поэтому режим (CONFIG.MODE) меняет только то, кто отвечает, а не код вызовов.
import { CONFIG } from './config.js';

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
  return `${method} ${path.replace(/^\/api\/items\/(?!undated$|search$)[^/]+$/, '/api/items/:id')}`;
}

async function request(method, path, { query, body, timeoutMs } = {}) {
  const params = toParams(query);
  if (CONFIG.MODE === 'mock') return mockRequest(method, path, params, body);

  const route = routeKey(method, path);
  if (CONFIG.MODE === 'auto' && missingRoutes.has(route)) return mockRequest(method, path, params, body);
  try {
    return await httpRequest(method, path, params, body, timeoutMs);
  } catch (error) {
    if (CONFIG.MODE !== 'auto' || !(error instanceof RouteUnavailable)) throw error;
    if (error.permanent) missingRoutes.add(route);
    apiEvents.dispatchEvent(new CustomEvent('fallback', { detail: { route, reason: error.code } }));
    return mockRequest(method, path, params, body);
  }
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
  // dev_server.py отвечает так, когда бэкенд не запущен
  if (error && error.code === 'backend_unavailable') {
    throw new RouteUnavailable(response.status, error.code, { permanent: false });
  }
  throw new ApiError(response.status, error ? error.code : `http_${response.status}`, error ? error.message : 'Ошибка сервера');
}

export const sendMessage = (payload) =>
  request('POST', '/api/message', { body: payload, timeoutMs: CONFIG.MESSAGE_TIMEOUT_MS });

export const getItems = ({ from, to, types, status, include_overdue } = {}) =>
  request('GET', '/api/items', { query: { from, to, types, status, include_overdue } });

// [не в контракте] Для панели «Последнее»: последние созданные записи. Предложено добавить в 2.3.
export const getRecentItems = ({ types, limit = 20 } = {}) =>
  request('GET', '/api/items', { query: { sort: '-created_at', limit, types } });

export const getUndatedItems = (types) => request('GET', '/api/items/undated', { query: { types } });
export const searchItems = (q, limit = 20) => request('GET', '/api/items/search', { query: { q, limit } });
export const getItem = (id) => request('GET', `/api/items/${encodeURIComponent(id)}`);
export const patchItem = (id, changes) => request('PATCH', `/api/items/${encodeURIComponent(id)}`, { body: changes });
export const deleteItem = (id) => request('DELETE', `/api/items/${encodeURIComponent(id)}`);
export const undo = (undoToken) => request('POST', '/api/undo', { body: { undo_token: undoToken } });

export const getHistory = (sessionId) => request('GET', '/api/history', { query: { session_id: sessionId } });
export const resetSession = (sessionId) => request('POST', '/api/session/reset', { body: { session_id: sessionId } });

export const getMe = () => request('GET', '/api/me');
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
    if (opened || CONFIG.MODE !== 'auto') return;
    source.close();
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
