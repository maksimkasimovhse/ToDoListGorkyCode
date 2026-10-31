// Клиент MAX Bot API через встроенный fetch: https://dev.max.ru/docs-api
// Токен передаётся заголовком «Authorization: <token>» (query-параметр больше не поддерживается).

export class MaxError extends Error {
  constructor(method, path, status, code, description) {
    super(`${method} ${path}: ${status} ${code || ''} ${description || ''}`.trim());
    this.status = status;
    this.code = code;
    this.description = description;
  }

  /** Пользователь заблокировал бота или диалога больше нет: слать бессмысленно */
  get unreachable() {
    return this.status === 403 || this.status === 404;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const TEXT_LIMIT = 4000;

/** Тело сообщения: HTML-текст и, если есть кнопки, inline-клавиатура. buttons — массив рядов */
export function messageBody({ text, buttons, notify }) {
  const body = { text: String(text || '').slice(0, TEXT_LIMIT), format: 'html', attachments: [] };
  if (buttons && buttons.length) body.attachments.push({ type: 'inline_keyboard', payload: { buttons } });
  if (notify === false) body.notify = false;
  return body;
}

export function createMax({ token, baseUrl = 'https://platform-api2.max.ru', fetchImpl = fetch, retries = 3, requestTimeoutMs = 20000 }) {
  async function request(method, path, { query, body, signal, timeoutMs = requestTimeoutMs } = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) if (value != null && value !== '') params.set(key, String(value));
    const qs = params.toString();
    const url = `${baseUrl}${path}${qs ? `?${qs}` : ''}`;
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        response = await fetchImpl(url, {
          method,
          headers: { Authorization: token, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        if (signal && signal.aborted) throw error;
        if (attempt >= retries) throw new MaxError(method, path, 0, 'network', error.cause ? `${error.message}: ${error.cause.code || error.cause.message}` : error.message);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const data = await response.json().catch(() => null);
      if (response.ok && !(data && data.success === false)) return data;
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        const retryAfter = Number(response.headers.get('retry-after')) || 2 ** attempt;
        await sleep(retryAfter * 1000);
        continue;
      }
      throw new MaxError(method, path, response.status, data && data.code, data && (data.message || data.error));
    }
  }

  return {
    request,
    me: () => request('GET', '/me'),
    /** Long polling. marker — с какого события продолжать; ответ { updates, marker } */
    updates: ({ marker, timeout = 30, types }, { signal } = {}) =>
      request('GET', '/updates', { query: { marker, timeout, limit: 100, types: types && types.join(',') }, signal, timeoutMs: (timeout + 15) * 1000 }),
    /** Сообщение пользователю в личный диалог; возвращает mid отправленного сообщения */
    async send(userId, message) {
      const result = await request('POST', '/messages', { query: { user_id: userId, disable_link_preview: true }, body: messageBody(message) });
      return result && result.message && result.message.body ? result.message.body.mid : null;
    },
    /** Редактирование: текст и клавиатура заменяются целиком; без buttons клавиатура убирается */
    edit: (messageId, message) => request('PUT', '/messages', { query: { message_id: messageId }, body: messageBody(message) }),
    remove: (messageId) => request('DELETE', '/messages', { query: { message_id: messageId } }),
    /** Ответ на нажатие кнопки: снимает индикатор загрузки; message — заменить сообщение с кнопкой */
    answer: (callbackId, { message, notification } = {}) =>
      request('POST', '/answers', {
        query: { callback_id: callbackId },
        body: { ...(message ? { message: messageBody(message) } : {}), ...(notification ? { notification } : {}) },
      }),
  };
}
