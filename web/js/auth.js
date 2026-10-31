// Сессия входа в браузере: токен Bearer, срок и пользователь из ответа POST /api/auth/login
// (backend/docs/auth.md). Токен лежит в localStorage: при перезагрузке страницы вход сохраняется.
const KEY = 'auth_session';

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}

/** { token, user, expires_at } или null, если не входили или срок вышел */
export function getSession() {
  const session = read();
  if (!session || !session.token) return null;
  if (session.expires_at && Date.parse(session.expires_at) <= Date.now()) {
    clearSession();
    return null;
  }
  return session;
}

export const getToken = () => (getSession() || {}).token || null;

export function saveSession(result) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ token: result.token, user: result.user, expires_at: result.expires_at }));
  } catch {
    // приватный режим — вход живёт до перезагрузки страницы
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // нечего очищать
  }
}
