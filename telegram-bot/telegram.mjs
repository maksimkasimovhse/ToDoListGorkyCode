// Клиент Telegram Bot API через встроенный fetch: боту нужно всего несколько методов.
// https://core.telegram.org/bots/api

export class TelegramError extends Error {
  constructor(method, code, description) {
    super(`${method}: ${code} ${description}`);
    this.code = code;
    this.description = description;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** call(method, params) — запрос к Bot API. 429 и сетевые сбои повторяются с паузой */
export function createTelegram({ token, baseUrl = 'https://api.telegram.org', fetchImpl = fetch, retries = 3 }) {
  async function call(method, params = {}, { signal } = {}) {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
          signal,
        });
      } catch (error) {
        if (signal && signal.aborted) throw error;
        if (attempt >= retries) throw error;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const body = await response.json().catch(() => ({ ok: false, error_code: response.status, description: 'invalid JSON' }));
      if (body.ok) return body.result;
      const retryAfter = body.parameters && body.parameters.retry_after;
      if ((body.error_code === 429 || response.status >= 500) && attempt < retries) {
        await sleep((retryAfter || 2 ** attempt) * 1000);
        continue;
      }
      throw new TelegramError(method, body.error_code, body.description);
    }
  }

  return {
    call,
    send: (chatId, { text, reply_markup }, extra = {}) =>
      call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup, ...extra }),
  };
}
