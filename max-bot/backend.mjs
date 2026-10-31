// Клиент API ассистента: тот же контракт, что у сайта (backend/docs/async-contract.md),
// плюс внутренние маршруты бота /internal/* (привязка аккаунта, подтверждение доставки).

export class BackendError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CHANNEL = 'max';

export function createBackend({ baseUrl, botToken, timezone, fetchImpl = fetch, pollMs = 1000, requestTimeoutMs = 20000 }) {
  async function request(method, path, { token, bot = false, query, body } = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) if (value != null && value !== '') params.set(key, value);
    const qs = params.toString();
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (bot) headers.Authorization = `Bot ${botToken}`;
    else if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}${qs ? `?${qs}` : ''}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw new BackendError(0, 'network', 'Сервер ассистента недоступен');
    }
    if (response.status === 204) return null;
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (data && data.error) || {};
      throw new BackendError(response.status, error.code || 'internal', error.message || 'Ошибка сервера', error);
    }
    return data;
  }

  /** Ждёт, пока бэкенд закончит этап: processing → ответ или ожидание ответа пользователя */
  async function wait(message, token) {
    const deadline = Math.max(Date.parse(message.deadline_at) || 0, Date.now()) + 10000;
    let current = message;
    while (current.status === 'processing') {
      if (Date.now() > deadline) throw new BackendError(0, 'timeout', 'Сервер не ответил вовремя');
      await sleep(pollMs);
      current = await request('GET', `/api/messages/${encodeURIComponent(current.message_id)}`, { token });
    }
    return current;
  }

  const id = (value) => encodeURIComponent(value);

  return {
    request,
    wait,
    // --- ассистент ---
    async send({ token, sessionId, clientMessageId, text = null, choice = null }) {
      const accepted = await request('POST', '/api/message', {
        token,
        body: { client_message_id: clientMessageId, session_id: sessionId, text: choice ? null : text, input: 'text', timezone, choice, context: { selected_item_id: null } },
      });
      return wait(accepted, token);
    },
    get: (token, messageId) => request('GET', `/api/messages/${id(messageId)}`, { token }),
    answer: async (token, messageId, inputToken, fields) =>
      wait(await request('POST', `/api/messages/${id(messageId)}/answer`, { token, body: { input_token: inputToken, ...fields } }), token),
    cancel: async (token, messageId) => wait(await request('POST', `/api/messages/${id(messageId)}/cancel`, { token }), token),
    history: (token, sessionId) => request('GET', '/api/history', { token, query: { session_id: sessionId } }),
    // --- записи ---
    items: (token, { from, to, types, status }) => request('GET', '/api/items', { token, query: { from, to, types, status, timezone } }),
    item: (token, itemId) => request('GET', `/api/items/${id(itemId)}`, { token }),
    createItem: (token, item) => request('POST', '/api/items', { token, body: item }),
    patch: (token, itemId, changes) => request('PATCH', `/api/items/${id(itemId)}`, { token, body: changes }),
    remove: (token, itemId) => request('DELETE', `/api/items/${id(itemId)}`, { token }),
    undo: (token, undoToken) => request('POST', '/api/undo', { token, body: { undo_token: undoToken } }),
    me: (token) => request('GET', '/api/me', { token }),
    // --- настройки уведомлений ---
    settings: (token) => request('GET', '/api/notification-settings', { token }),
    updateSettings: (token, patch) => request('PATCH', '/api/notification-settings', { token, body: patch }),
    // --- маршруты бота ---
    link: (externalId, credentials) => request('POST', `/internal/channels/${CHANNEL}/link`, { bot: true, body: { external_id: String(externalId), ...credentials } }),
    channel: (externalId) => request('GET', `/internal/channels/${CHANNEL}/${id(externalId)}`, { bot: true }),
    setEnabled: (externalId, enabled) => request('PATCH', `/internal/channels/${CHANNEL}/${id(externalId)}`, { bot: true, body: { enabled } }),
    unlink: (externalId) => request('DELETE', `/internal/channels/${CHANNEL}/${id(externalId)}`, { bot: true }),
    ack: (notificationId, body) => request('POST', `/internal/notifications/${id(notificationId)}/ack`, { bot: true, body: { channel: CHANNEL, ...body } }),
  };
}
