// Состояние бота в Redis приложения, ключи с префиксом max:. Бот работает только в личных
// диалогах, поэтому ключом служит user_id пользователя MAX.

const WIZARD_SECONDS = 30 * 60;
const AUTH_SECONDS = 5 * 60;
const SENT_SECONDS = 3 * 24 * 60 * 60;

export function createRedisStore(client) {
  const json = async (key) => {
    const raw = await client.get(key);
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  return {
    async sessionId(user) {
      return (await client.get(`max:session:${user}`)) || `max_${user}_1`;
    },
    async newSession(user) {
      const n = await client.incr(`max:session_n:${user}`);
      const id = `max_${user}_${n + 1}`;
      await client.set(`max:session:${user}`, id);
      return id;
    },
    token: (user) => client.get(`max:auth:${user}`),
    setToken: (user, token) => client.set(`max:auth:${user}`, token),
    clearToken: (user) => client.del(`max:auth:${user}`),
    /** Мастер создания записи или настройки: { id, kind, step, data, mid } */
    wizard: (user) => json(`max:wizard:${user}`),
    setWizard: (user, state) => client.set(`max:wizard:${user}`, JSON.stringify(state), { EX: WIZARD_SECONDS }),
    clearWizard: (user) => client.del(`max:wizard:${user}`),
    /** Шаг входа по логину: { step: 'login' } → { step: 'password', login } */
    authStep: (user) => json(`max:login:${user}`),
    setAuthStep: (user, step) => client.set(`max:login:${user}`, JSON.stringify(step), { EX: AUTH_SECONDS }),
    clearAuthStep: (user) => client.del(`max:login:${user}`),
    /** Отправлено ли уведомление: защищает от дублей при повторной доставке из потока */
    isSent: async (id) => (await client.exists(`max:sent:${id}`)) === 1,
    markSent: (id) => client.set(`max:sent:${id}`, '1', { EX: SENT_SECONDS }),
    marker: async () => {
      const value = await client.get('max:marker');
      return value ? Number(value) : null;
    },
    setMarker: (marker) => client.set('max:marker', String(marker)),
  };
}

/** То же в памяти — для тестов */
export function createMemoryStore() {
  const values = new Map();
  const get = (key) => (values.has(key) ? structuredClone(values.get(key)) : null);
  return {
    values,
    async sessionId(user) {
      return get(`session:${user}`) || `max_${user}_1`;
    },
    async newSession(user) {
      const n = (get(`session_n:${user}`) || 1) + 1;
      values.set(`session_n:${user}`, n);
      values.set(`session:${user}`, `max_${user}_${n}`);
      return values.get(`session:${user}`);
    },
    token: async (user) => get(`auth:${user}`),
    setToken: async (user, token) => values.set(`auth:${user}`, token),
    clearToken: async (user) => values.delete(`auth:${user}`),
    wizard: async (user) => get(`wizard:${user}`),
    setWizard: async (user, state) => values.set(`wizard:${user}`, structuredClone(state)),
    clearWizard: async (user) => values.delete(`wizard:${user}`),
    authStep: async (user) => get(`login:${user}`),
    setAuthStep: async (user, step) => values.set(`login:${user}`, step),
    clearAuthStep: async (user) => values.delete(`login:${user}`),
    isSent: async (id) => values.has(`sent:${id}`),
    markSent: async (id) => values.set(`sent:${id}`, true),
    marker: async () => get('marker'),
    setMarker: async (marker) => values.set('marker', marker),
  };
}
