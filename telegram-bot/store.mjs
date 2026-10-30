// Состояние бота в Redis приложения, ключи с префиксом tg:. Работаем только в личных чатах,
// поэтому id чата совпадает с id пользователя Telegram.

const DAY_SECONDS = 24 * 60 * 60;

export function createRedisStore(client) {
  return {
    async sessionId(chat) {
      const id = await client.get(`tg:session:${chat}`);
      return id || `tg_${chat}_1`;
    },
    /** Новый диалог, как кнопка «Новый диалог» на сайте: записи остаются, контекст начинается заново */
    async newSession(chat) {
      const n = await client.incr(`tg:session_n:${chat}`);
      const id = `tg_${chat}_${n + 1}`;
      await client.set(`tg:session:${chat}`, id);
      return id;
    },
    token: (chat) => client.get(`tg:auth:${chat}`),
    setToken: (chat, token) => client.set(`tg:auth:${chat}`, token),
    clearToken: (chat) => client.del(`tg:auth:${chat}`),
    /** Чаты, писавшие боту: им отправляются уведомления */
    addChat: (chat) => client.sAdd('tg:chats', String(chat)),
    chats: async () => (await client.sMembers('tg:chats')).map(Number),
    notifyEnabled: async (chat) => (await client.get(`tg:notify:${chat}`)) !== 'off',
    setNotify: (chat, enabled) => client.set(`tg:notify:${chat}`, enabled ? 'on' : 'off'),
    /** true — уведомление ещё не отправлялось. Помним сутки, переживает перезапуск бота */
    markFired: async (chat, key) => (await client.set(`tg:fired:${chat}:${key}`, '1', { NX: true, EX: DAY_SECONDS })) === 'OK',
    offset: async () => Number(await client.get('tg:offset')) || 0,
    setOffset: (offset) => client.set('tg:offset', String(offset)),
  };
}

/** То же в памяти — для тестов */
export function createMemoryStore() {
  const values = new Map();
  const chats = new Set();
  const fired = new Set();
  return {
    async sessionId(chat) {
      return values.get(`session:${chat}`) || `tg_${chat}_1`;
    },
    async newSession(chat) {
      const n = (values.get(`session_n:${chat}`) || 1) + 1;
      values.set(`session_n:${chat}`, n);
      values.set(`session:${chat}`, `tg_${chat}_${n}`);
      return values.get(`session:${chat}`);
    },
    token: async (chat) => values.get(`auth:${chat}`) || null,
    setToken: async (chat, token) => values.set(`auth:${chat}`, token),
    clearToken: async (chat) => values.delete(`auth:${chat}`),
    addChat: async (chat) => chats.add(chat),
    chats: async () => [...chats],
    notifyEnabled: async (chat) => values.get(`notify:${chat}`) !== 'off',
    setNotify: async (chat, enabled) => values.set(`notify:${chat}`, enabled ? 'on' : 'off'),
    markFired: async (chat, key) => {
      const id = `${chat}:${key}`;
      if (fired.has(id)) return false;
      fired.add(id);
      return true;
    },
    offset: async () => values.get('offset') || 0,
    setOffset: async (offset) => values.set('offset', offset),
  };
}
