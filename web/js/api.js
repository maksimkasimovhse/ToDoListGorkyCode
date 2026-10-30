// Клиент API по contracts.md, раздел 2. С USE_MOCKS запросы уходят в заглушку js/mock/server.js
// с теми же путями и форматами, так что переход на настоящий бэкенд — смена одного флага.
import { CONFIG } from './config.js';

const mock = CONFIG.USE_MOCKS ? await import('./mock/server.js') : null;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

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

async function request(method, path, { query, body, timeoutMs } = {}) {
  const params = toParams(query);

  if (mock) {
    const result = await mock.handle(method, path, Object.fromEntries(params), body ?? null);
    if (result.status >= 400) {
      const error = result.body && result.body.error;
      throw new ApiError(result.status, error ? error.code : 'internal', error ? error.message : 'Ошибка сервера');
    }
    return result.body;
  }

  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = authToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const qs = params.toString();
  try {
    const response = await fetch(`${CONFIG.API_BASE}${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = data && data.error;
      throw new ApiError(response.status, error ? error.code : `http_${response.status}`, error ? error.message : 'Ошибка сервера');
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
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

/** События сервера (2.5). handlers: { reminder(payload), items_changed(payload) }. Возвращает функцию отписки. */
export function subscribe(handlers) {
  if (mock) return mock.subscribe(handlers);
  if (!('EventSource' in window)) return () => {};
  // EventSource не умеет заголовок Authorization — токен передаём в query (предложено добавить в контракт)
  const token = authToken();
  const source = new EventSource(`${CONFIG.API_BASE}/api/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`);
  for (const [event, handler] of Object.entries(handlers)) {
    source.addEventListener(event, (message) => {
      try {
        handler(JSON.parse(message.data));
      } catch (error) {
        console.warn('Не разобрали событие', event, error);
      }
    });
  }
  return () => source.close();
}
