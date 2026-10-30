// Привязка Telegram к пользователю бэкенда (contracts.md, 2.6): /login — логин и пароль, /guest — новый
// тестовый пользователь. Токен хранится в Redis и уходит в каждый запрос как Bearer.
// Пока в бэкенде нет /api/auth/*, бот работает без токена — как общий демо-пользователь сайта.
import { plain } from './render.mjs';

const NOT_READY = 'Вход пока не поддерживается сервером. Сейчас вы работаете как общий демо-пользователь — те же записи, что на сайте.';

export function createAuth({ tg, backend, store, log }) {
  // Шаг диалога входа по чату: { step: 'login' } → { step: 'password', login }
  const pending = new Map();

  const unsupported = (error) => error.status === 404 || error.status === 405 || error.status === 501;

  async function finish(chat, call) {
    try {
      const result = await call();
      if (!result || !result.token) throw new Error('no token');
      await store.setToken(chat, result.token);
      const name = result.user && (result.user.login || result.user.id);
      await tg.send(chat, plain(name ? `Готово, вы вошли как ${name}.` : 'Готово, вы вошли.'));
    } catch (error) {
      if (unsupported(error)) return tg.send(chat, plain(NOT_READY));
      if (error.status === 401 || error.status === 400) return tg.send(chat, plain('Неверный логин или пароль. Попробуйте ещё раз: /login'));
      log('auth failed', { chat, error: error.message });
      await tg.send(chat, plain('Не получилось войти. Попробуйте позже.'));
    }
  }

  return {
    active: (chat) => pending.has(chat),
    async start(chat) {
      pending.set(chat, { step: 'login' });
      await tg.send(chat, plain('Введите логин. Отменить — /cancel'));
    },
    async guest(chat) {
      await finish(chat, () => backend.guest());
    },
    async logout(chat) {
      pending.delete(chat);
      await store.clearToken(chat);
      await tg.send(chat, plain('Вы вышли. Пока не войдёте снова, бот работает как демо-пользователь.'));
    },
    /** Следующая реплика в диалоге входа. Сообщение с паролем удаляется из чата */
    async handle(chat, message) {
      const state = pending.get(chat);
      const text = (message.text || '').trim();
      if (text === '/cancel') {
        pending.delete(chat);
        return tg.send(chat, plain('Хорошо, вход отменён.'));
      }
      if (state.step === 'login') {
        if (!text) return tg.send(chat, plain('Введите логин текстом.'));
        pending.set(chat, { step: 'password', login: text });
        return tg.send(chat, plain('Теперь пароль. Сообщение с ним я сразу удалю.'));
      }
      pending.delete(chat);
      await tg.call('deleteMessage', { chat_id: chat, message_id: message.message_id }).catch(() => {});
      await finish(chat, () => backend.login(state.login, text));
    },
  };
}
