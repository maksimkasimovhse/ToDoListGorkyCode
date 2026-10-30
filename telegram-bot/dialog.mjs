// Диалог одного чата: текст и кнопки Telegram → вызовы API ассистента → ответ в чат.
// Повторяет поведение чата на сайте (web/js/app.js): уточнения разбираются в поля формы
// (web/js/answer.js), «да/нет» — подтверждение, кнопки без активного сценария — choice.
import { isCancel, parseAnswer, parseConfirmation } from '../web/js/answer.js';
import { formatTime, now } from '../web/js/time.js';
import { BackendError } from './backend.mjs';
import { plain, renderReply } from './render.mjs';

const AWAITING = new Set(['awaiting_input', 'awaiting_confirmation']);
const SNOOZE_MS = 15 * 60 * 1000;

const ASK = {
  today: 'Что у меня сегодня?',
  tomorrow: 'Что у меня завтра?',
  week: 'Что запланировано на эту неделю?',
};

export const COMMANDS = [
  { command: 'today', description: 'Что у меня сегодня' },
  { command: 'tomorrow', description: 'Что у меня завтра' },
  { command: 'week', description: 'Планы на неделю' },
  { command: 'new', description: 'Начать новый диалог' },
  { command: 'notify', description: 'Включить или выключить уведомления' },
  { command: 'login', description: 'Войти' },
  { command: 'guest', description: 'Войти как новый гость' },
  { command: 'logout', description: 'Выйти' },
  { command: 'help', description: 'Что умеет бот' },
];

const HELP = [
  'Я помогаю с задачами, напоминаниями и встречами. Пишите как обычно:',
  '• «Напомни завтра в 10 позвонить Ивану»',
  '• «Добавь встречу с командой в пятницу в 15:00»',
  '• «Что у меня завтра?»',
  '• «Найди задачу про презентацию»',
  '',
  'За 15 минут до встречи или напоминания и в момент начала пришлю уведомление (/notify — выключить).',
  'Голосовые сообщения пока не понимаю — только текст.',
].join('\n');

export function createDialog({ tg, backend, store, auth, log, allowed = new Set() }) {
  // Сценарий, ждущий ответа, по чату: сообщение бэкенда или null. После перезапуска
  // восстанавливается из GET /api/history (pending_messages)
  const flows = new Map();
  const queues = new Map();

  /** Сообщения одного чата обрабатываются строго по очереди: ответ на уточнение не обгонит вопрос */
  function enqueue(chat, task) {
    const next = (queues.get(chat) || Promise.resolve()).then(task).catch((error) => failure(chat, error).catch(() => {}));
    queues.set(chat, next);
    next.finally(() => {
      if (queues.get(chat) === next) queues.delete(chat);
    });
    return next;
  }

  async function context(chat) {
    return { token: await store.token(chat), sessionId: await store.sessionId(chat) };
  }

  async function currentFlow(chat, ctx) {
    if (flows.has(chat)) return flows.get(chat);
    let flow = null;
    try {
      const history = await backend.history(ctx.token, ctx.sessionId);
      const pending = (history && history.pending_messages) || [];
      flow = pending.find((m) => AWAITING.has(m.status) || m.status === 'processing') || null;
    } catch (error) {
      log('history failed', { chat, error: error.message });
    }
    flows.set(chat, flow);
    return flow;
  }

  async function show(chat, message) {
    flows.set(chat, AWAITING.has(message.status) ? message : null);
    await tg.send(chat, renderReply(message.response || { type: 'error', reply: 'Сервер не прислал ответ. Попробуйте ещё раз.' }));
  }

  async function failure(chat, error) {
    if (error instanceof BackendError) {
      if (error.status === 401) {
        await store.clearToken(chat);
        return tg.send(chat, plain('Вход устарел. Войдите снова: /login'));
      }
      if (error.code === 'conversation_busy') {
        flows.delete(chat);
        return tg.send(chat, plain('Подождите, ещё обрабатываю предыдущее сообщение.'));
      }
      if (error.status === 400 || error.status === 409) return tg.send(chat, plain(error.message));
    }
    log('request failed', { chat, error: error.message });
    return tg.send(chat, plain('Не получилось обработать запрос. Попробуйте ещё раз.'));
  }

  const typing = (chat) => tg.call('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {});

  /** Новое сообщение ассистенту. clientMessageId из update_id: повтор апдейта не создаст запись дважды */
  async function ask(chat, ctx, clientMessageId, payload) {
    await typing(chat);
    await show(chat, await backend.send({ token: ctx.token, sessionId: ctx.sessionId, clientMessageId, ...payload }));
  }

  /** Продолжение сценария. Если окно устарело, показываем актуальное состояние, как сайт */
  async function continueFlow(chat, ctx, flow, call) {
    await typing(chat);
    let message;
    try {
      message = await call();
    } catch (error) {
      if (!(error instanceof BackendError && error.status === 409 && ['stale_input', 'message_state'].includes(error.code))) throw error;
      message = await backend.wait(await backend.get(ctx.token, flow.message_id), ctx.token);
    }
    await show(chat, message);
  }

  /** Сценарий, начатый до перезапуска и ещё обрабатывающийся: дожидаемся и показываем ответ */
  async function settledFlow(chat, ctx) {
    const flow = await currentFlow(chat, ctx);
    if (!flow || flow.status !== 'processing') return flow;
    await show(chat, await backend.wait(flow, ctx.token));
    return flows.get(chat);
  }

  async function onText(chat, text, updateId) {
    const ctx = await context(chat);
    const flow = await settledFlow(chat, ctx);
    if (!flow) return ask(chat, ctx, `tg_${updateId}`, { text });
    if (isCancel(text)) return continueFlow(chat, ctx, flow, () => backend.cancel(ctx.token, flow.message_id));
    if (flow.status === 'awaiting_confirmation') {
      const confirmed = parseConfirmation(text);
      if (confirmed === null) return tg.send(chat, plain('Ответьте «да» или «нет».'));
      return continueFlow(chat, ctx, flow, () => backend.answer(ctx.token, flow.message_id, flow.input_token, { confirmed }));
    }
    const expects = (flow.response && flow.response.data && flow.response.data.expects) || 'time';
    const fields = parseAnswer(expects, text);
    if (!fields) return tg.send(chat, plain('Не понял. Скажите, например: «завтра в 17». Отменить — «отмена».'));
    return continueFlow(chat, ctx, flow, () => backend.answer(ctx.token, flow.message_id, flow.input_token, fields));
  }

  async function onCommand(chat, command, updateId) {
    const ctx = await context(chat);
    switch (command) {
      case 'start':
      case 'help':
        return tg.send(chat, plain(HELP));
      case 'today':
      case 'tomorrow':
      case 'week': {
        const flow = await settledFlow(chat, ctx);
        if (flow) return tg.send(chat, plain('Сначала ответьте на вопрос выше или скажите «отмена».'));
        return ask(chat, ctx, `tg_${updateId}`, { text: ASK[command] });
      }
      case 'cancel': {
        const flow = await settledFlow(chat, ctx);
        if (!flow) return tg.send(chat, plain('Сейчас нечего отменять.'));
        return continueFlow(chat, ctx, flow, () => backend.cancel(ctx.token, flow.message_id));
      }
      case 'new': {
        const flow = await currentFlow(chat, ctx);
        if (flow) await backend.cancel(ctx.token, flow.message_id).catch(() => {});
        await store.newSession(chat);
        flows.set(chat, null);
        return tg.send(chat, plain('Начинаем новый диалог. Записи остались на месте.', { remove_keyboard: true }));
      }
      case 'notify': {
        const enabled = !(await store.notifyEnabled(chat));
        await store.setNotify(chat, enabled);
        return tg.send(chat, plain(enabled ? 'Уведомления включены: за 15 минут и в момент начала.' : 'Уведомления выключены. Включить снова — /notify'));
      }
      case 'login':
        return auth.start(chat);
      case 'guest':
        return auth.guest(chat);
      case 'logout':
        return auth.logout(chat);
      default:
        return tg.send(chat, plain(HELP));
    }
  }

  async function onMessage(message, updateId) {
    const chat = message.chat.id;
    if (message.chat.type !== 'private') return tg.send(chat, plain('Я работаю только в личных сообщениях.'));
    if (allowed.size && !allowed.has(message.from.id)) return tg.send(chat, plain('Доступ закрыт.'));
    await store.addChat(chat);
    if (auth.active(chat)) return auth.handle(chat, message);
    if (!message.text) {
      const voice = message.voice || message.audio || message.video_note;
      return tg.send(chat, plain(voice ? 'Голосовые пока не понимаю — напишите, пожалуйста, текстом.' : 'Пока понимаю только текст.'));
    }
    const text = message.text.trim();
    const command = /^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i.exec(text);
    if (command) return onCommand(chat, command[1].toLowerCase(), updateId);
    return onText(chat, text, updateId);
  }

  async function onCallback(query) {
    const chat = query.message.chat.id;
    await tg.call('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
    if (allowed.size && !allowed.has(query.from.id)) return;
    // Кнопки убираем сразу, чтобы второе нажатие не отправило ответ ещё раз
    await tg.call('editMessageReplyMarkup', { chat_id: chat, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    const split = query.data.indexOf(':');
    const kind = query.data.slice(0, split);
    const value = query.data.slice(split + 1);
    const ctx = await context(chat);

    if (kind === 'o') {
      const flow = await settledFlow(chat, ctx);
      if (flow) return continueFlow(chat, ctx, flow, () => backend.answer(ctx.token, flow.message_id, flow.input_token, { confirmed: value === 'yes' }));
      return ask(chat, ctx, `tg_cb_${query.id}`, { choice: { option_id: value } });
    }
    if (kind === 'u') {
      try {
        const result = await backend.undo(ctx.token, value);
        return tg.send(chat, plain((result && result.reply) || 'Отменил.'));
      } catch (error) {
        if (error.status === 404) return tg.send(chat, plain('Отмена действия пока не поддерживается сервером.'));
        throw error;
      }
    }
    if (kind === 'd') {
      const item = await backend.patch(ctx.token, value, { status: 'done' });
      return tg.send(chat, plain(`Отметил выполненным: ${item.title}`));
    }
    if (kind === 's') {
      const at = new Date(now().getTime() + SNOOZE_MS);
      const item = await backend.patch(ctx.token, value, { remind_at: at.toISOString() });
      return tg.send(chat, plain(`Хорошо, напомню в ${formatTime(at)}: ${item.title}`));
    }
  }

  return {
    handleUpdate(update) {
      if (update.message) return enqueue(update.message.chat.id, () => onMessage(update.message, update.update_id));
      if (update.callback_query && update.callback_query.message) {
        return enqueue(update.callback_query.message.chat.id, () => onCallback(update.callback_query));
      }
      return Promise.resolve();
    },
    /** Для тестов и уведомлений: ждёт, пока чат обработает накопленные сообщения */
    idle: (chat) => queues.get(chat) || Promise.resolve(),
  };
}
