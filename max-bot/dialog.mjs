// Диалог с пользователем MAX: привязка аккаунта, меню, мастера создания записей кнопками,
// настройки уведомлений и свободный текст для ассистента (как чат на сайте).
// События одного пользователя обрабатываются строго по очереди.
import { isCancel, parseAnswer, parseConfirmation } from '../web/js/answer.js';
import { addDays, formatTime, now, startOfDayIso, todayKey } from '../web/js/time.js';
import { BackendError } from './backend.mjs';
import { agenda, backToMenu, escape, menu, plain, renderReply } from './render.mjs';
import { hourScreen, isSettingsField, minuteScreen, settingsScreen } from './settings.mjs';
import { button, MENU_BUTTONS } from './ui.mjs';
import { createWizard } from './wizard.mjs';

const AWAITING = new Set(['awaiting_input', 'awaiting_confirmation']);
const CODE = /^[0-9a-f]{20}$/i;

export const HELP = [
  '<b>Что я умею</b>',
  '',
  '• Создавать задачи, напоминания и встречи кнопками: /menu → «➕ Задача», «⏰ Напоминание», «👥 Встреча».',
  '• Понимать обычный текст: «Напомни завтра в 10 позвонить Ивану», «Что у меня в пятницу?».',
  '• Присылать уведомление за 15 минут до встречи или напоминания и в момент начала.',
  '• Каждое утро присылать план на день (по умолчанию в 07:30).',
  '',
  'Время сводки и тихие часы — в /settings.',
  'Команды: /menu, /today, /tomorrow, /week, /task, /reminder, /meeting, /settings, /new, /logout.',
].join('\n');

const LINK_TEXT = [
  '<b>Подключите аккаунт планировщика</b>',
  '',
  'Тогда я увижу ваши задачи, встречи и напоминания и буду присылать уведомления.',
  '',
  '1. На сайте откройте ⚙️ Настройки → «Подключить MAX» и перейдите по ссылке. Или отправьте сюда код с сайта.',
  '2. Или войдите по логину и паролю.',
].join('\n');
const LINK_BUTTONS = [[button('🔑 Войти по логину', 'a:login')]];

export function createDialog({ max, backend, store, log = () => {}, allowed = new Set() }) {
  const wizard = createWizard({ backend, store, log });
  const flows = new Map();
  const queues = new Map();

  function enqueue(user, task) {
    const next = (queues.get(user) || Promise.resolve()).then(task).catch((error) => failure(user, error).catch(() => {}));
    queues.set(user, next);
    next.finally(() => {
      if (queues.get(user) === next) queues.delete(user);
    });
    return next;
  }

  const send = (user, message) => max.send(user, message);

  async function failure(user, error) {
    if (error instanceof BackendError) {
      if (error.status === 401) {
        await store.clearToken(user);
        await store.clearWizard(user);
        return send(user, { text: `Вход устарел или аккаунт отключён.\n\n${LINK_TEXT}`, buttons: LINK_BUTTONS });
      }
      if (error.code === 'conversation_busy') {
        flows.delete(user);
        return send(user, plain('Подождите, ещё обрабатываю предыдущее сообщение.'));
      }
      if (error.status === 400 || error.status === 409 || error.status === 404) return send(user, plain(error.message));
    }
    log('request failed', { user, error: error.message });
    return send(user, plain('Не получилось выполнить запрос. Попробуйте ещё раз.', backToMenu));
  }

  // ---------- Привязка аккаунта ----------

  async function linked(user, result) {
    await store.setToken(user, result.token);
    await store.clearAuthStep(user);
    const login = result.user && result.user.login;
    return send(user, menu(`Готово${login ? `, вы вошли как ${login}` : ''}. Теперь я буду присылать уведомления за 15 минут и в момент начала встреч и напоминаний, а утром — план на день.`));
  }

  async function linkByCode(user, code) {
    try {
      return await linked(user, await backend.link(user, { code: code.toLowerCase() }));
    } catch (error) {
      if (error instanceof BackendError && (error.status === 410 || error.status === 400)) {
        return send(user, { text: 'Код недействителен или устарел. Получите новый на сайте: ⚙️ Настройки → «Подключить MAX».', buttons: LINK_BUTTONS });
      }
      throw error;
    }
  }

  async function authText(user, step, text, mid) {
    if (step.step === 'login') {
      await store.setAuthStep(user, { step: 'password', login: text.trim() });
      return send(user, plain('Теперь пароль. Сообщение с паролем я сразу удалю.'));
    }
    if (mid) await max.remove(mid).catch(() => {});
    try {
      return await linked(user, await backend.link(user, { login: step.login, password: text }));
    } catch (error) {
      await store.clearAuthStep(user);
      if (error instanceof BackendError && error.status === 401) return send(user, { text: 'Неверный логин или пароль.', buttons: LINK_BUTTONS });
      if (error instanceof BackendError && error.status === 429) return send(user, plain('Слишком много попыток. Подождите минуту и попробуйте снова.'));
      throw error;
    }
  }

  // ---------- Ассистент (свободный текст) ----------

  async function context(user) {
    return { token: await store.token(user), sessionId: await store.sessionId(user) };
  }

  async function currentFlow(user, ctx) {
    if (flows.has(user)) return flows.get(user);
    let flow = null;
    try {
      const history = await backend.history(ctx.token, ctx.sessionId);
      flow = ((history && history.pending_messages) || []).find((m) => AWAITING.has(m.status) || m.status === 'processing') || null;
    } catch (error) {
      if (error instanceof BackendError && error.status === 401) throw error;
      log('history failed', { user, error: error.message });
    }
    flows.set(user, flow);
    return flow;
  }

  async function show(user, message) {
    flows.set(user, AWAITING.has(message.status) ? message : null);
    return send(user, renderReply(message.response || { type: 'error', reply: 'Сервер не прислал ответ. Попробуйте ещё раз.' }));
  }

  async function ask(user, ctx, clientMessageId, payload) {
    return show(user, await backend.send({ token: ctx.token, sessionId: ctx.sessionId, clientMessageId, ...payload }));
  }

  async function continueFlow(user, ctx, flow, call) {
    let message;
    try {
      message = await call();
    } catch (error) {
      if (!(error instanceof BackendError && error.status === 409 && ['stale_input', 'message_state'].includes(error.code))) throw error;
      message = await backend.wait(await backend.get(ctx.token, flow.message_id), ctx.token);
    }
    return show(user, message);
  }

  async function settledFlow(user, ctx) {
    const flow = await currentFlow(user, ctx);
    if (!flow || flow.status !== 'processing') return flow;
    await show(user, await backend.wait(flow, ctx.token));
    return flows.get(user);
  }

  async function assistantText(user, text, clientMessageId) {
    const ctx = await context(user);
    const flow = await settledFlow(user, ctx);
    if (!flow) return ask(user, ctx, clientMessageId, { text });
    if (isCancel(text)) return continueFlow(user, ctx, flow, () => backend.cancel(ctx.token, flow.message_id));
    if (flow.status === 'awaiting_confirmation') {
      const confirmed = parseConfirmation(text);
      if (confirmed === null) return send(user, plain('Ответьте «да» или «нет».'));
      return continueFlow(user, ctx, flow, () => backend.answer(ctx.token, flow.message_id, flow.input_token, { confirmed }));
    }
    const expects = (flow.response && flow.response.data && flow.response.data.expects) || 'time';
    const fields = parseAnswer(expects, text);
    if (!fields) return send(user, plain('Не понял. Скажите, например: «завтра в 17». Отменить — «отмена».'));
    return continueFlow(user, ctx, flow, () => backend.answer(ctx.token, flow.message_id, flow.input_token, fields));
  }

  // ---------- Экраны ----------

  async function agendaScreen(user, offset, days = 1) {
    const token = await store.token(user);
    const fromKey = addDays(todayKey(), offset);
    const toKey = addDays(fromKey, days);
    const result = await backend.items(token, { from: startOfDayIso(fromKey), to: startOfDayIso(toKey), types: 'meeting,reminder,task' });
    const items = ((result && result.items) || []).filter((item) => item.status === 'open' || item.status === 'scheduled');
    const title = days > 1 ? 'План на неделю' : offset === 0 ? 'Сегодня' : 'Завтра';
    return agenda(title, items, fromKey, toKey);
  }

  async function settingsView(user, notice) {
    const token = await store.token(user);
    const [settings, channel] = await Promise.all([backend.settings(token), backend.channel(user)]);
    return settingsScreen(settings, channel, notice);
  }

  async function startWizard(user, kind, replaceMid = null) {
    const { state, screen } = await wizard.start(user, kind);
    if (replaceMid) {
      state.mid = replaceMid;
      await store.setWizard(user, state);
      return { replace: screen };
    }
    state.mid = await send(user, screen);
    await store.setWizard(user, state);
    return null;
  }

  /** Экран мастера после текстового ввода: новое сообщение внизу, у прежнего убираем кнопки */
  async function wizardReply(user, state, result) {
    if (state.mid) await max.edit(state.mid, { text: '✏️ Продолжаем ниже ↓' }).catch(() => {});
    const mid = await send(user, result.screen);
    if (!result.done) {
      const fresh = await store.wizard(user);
      if (fresh) {
        fresh.mid = mid;
        await store.setWizard(user, fresh);
      }
    }
  }

  // ---------- Сообщения ----------

  async function onCommand(user, command, arg, clientMessageId) {
    switch (command) {
      case 'start':
      case 'link':
        if (arg && CODE.test(arg)) return linkByCode(user, arg);
        return send(user, menu('Привет! Я ваш планировщик. Что сделать?'));
      case 'help':
        return send(user, { text: HELP, buttons: MENU_BUTTONS });
      case 'menu':
        await store.clearWizard(user);
        return send(user, menu());
      case 'today':
        return send(user, await agendaScreen(user, 0));
      case 'tomorrow':
        return send(user, await agendaScreen(user, 1));
      case 'week':
        return send(user, await agendaScreen(user, 0, 7));
      case 'task':
      case 'reminder':
      case 'meeting':
        return startWizard(user, command);
      case 'settings':
      case 'notify':
        return send(user, await settingsView(user));
      case 'cancel': {
        if (await store.wizard(user)) {
          await store.clearWizard(user);
          return send(user, menu('Отменено.'));
        }
        const ctx = await context(user);
        const flow = await settledFlow(user, ctx);
        if (!flow) return send(user, plain('Сейчас нечего отменять.', backToMenu));
        return continueFlow(user, ctx, flow, () => backend.cancel(ctx.token, flow.message_id));
      }
      case 'new': {
        const ctx = await context(user);
        const flow = await currentFlow(user, ctx);
        if (flow) await backend.cancel(ctx.token, flow.message_id).catch(() => {});
        await store.newSession(user);
        await store.clearWizard(user);
        flows.set(user, null);
        return send(user, menu('Начинаем новый диалог. Записи остались на месте.'));
      }
      case 'logout':
        await backend.unlink(user).catch((error) => log('unlink failed', { user, error: error.message }));
        await store.clearToken(user);
        await store.clearWizard(user);
        flows.delete(user);
        return send(user, { text: 'Аккаунт отключён, уведомления сюда больше не придут.', buttons: LINK_BUTTONS });
      default:
        return assistantText(user, `/${command}${arg ? ` ${arg}` : ''}`, clientMessageId);
    }
  }

  async function onMessage(update) {
    const message = update.message;
    const user = message.sender.user_id;
    if (message.recipient && message.recipient.chat_type && message.recipient.chat_type !== 'dialog') return null;
    if (allowed.size && !allowed.has(user)) return send(user, plain('Доступ закрыт.'));
    const text = ((message.body && message.body.text) || '').trim();
    const mid = message.body && message.body.mid;
    const clientMessageId = `max_${mid || update.timestamp}`;
    const command = /^\/([a-z_]+)(?:@\S+)?(?:\s+(.*))?$/is.exec(text);

    const token = await store.token(user);
    if (!token) {
      const step = await store.authStep(user);
      if (command && command[1].toLowerCase() === 'login') {
        await store.setAuthStep(user, { step: 'login' });
        return send(user, plain('Введите логин.'));
      }
      if (command && ['start', 'link'].includes(command[1].toLowerCase()) && command[2] && CODE.test(command[2].trim())) return linkByCode(user, command[2].trim());
      if (CODE.test(text)) return linkByCode(user, text);
      if (step && text && !command) return authText(user, step, text, mid);
      return send(user, { text: LINK_TEXT, buttons: LINK_BUTTONS });
    }

    if (!text) return send(user, plain('Пока понимаю только текст. Голосовые и файлы не поддерживаю.', backToMenu));
    if (command) return onCommand(user, command[1].toLowerCase(), (command[2] || '').trim(), clientMessageId);

    const state = await store.wizard(user);
    if (state && state.kind !== 'settings') {
      if (isCancel(text)) {
        await store.clearWizard(user);
        return send(user, menu('Отменено. Ничего не сохранил.'));
      }
      return wizardReply(user, state, await wizard.text(user, state, text));
    }
    return assistantText(user, text, clientMessageId);
  }

  async function onStarted(update) {
    const user = update.user.user_id;
    if (allowed.size && !allowed.has(user)) return send(user, plain('Доступ закрыт.'));
    const payload = (update.payload || '').trim();
    if (payload && CODE.test(payload)) return linkByCode(user, payload);
    if (await store.token(user)) return send(user, menu('С возвращением! Что сделать?'));
    return send(user, { text: `Привет! Я помогу с задачами, напоминаниями и встречами.\n\n${LINK_TEXT}`, buttons: LINK_BUTTONS });
  }

  // ---------- Кнопки ----------

  /** Обработчик кнопки возвращает { replace } — заменить сообщение с кнопкой, или { notification } */
  async function press(user, payload, original, after) {
    const [kind, action = '', ...rest] = payload.split(':');
    const value = rest.join(':');
    if (kind === 'x') return { notification: 'Выберите вариант кнопкой ниже.' };

    if (kind === 'a' && action === 'login') {
      await store.setAuthStep(user, { step: 'login' });
      return { replace: plain('Введите логин сообщением.') };
    }
    const token = await store.token(user);
    if (!token) return { replace: { text: LINK_TEXT, buttons: LINK_BUTTONS } };

    if (kind === 'm') {
      switch (action) {
        case 'menu':
          await store.clearWizard(user);
          return { replace: menu() };
        case 'help':
          return { replace: { text: HELP, buttons: MENU_BUTTONS } };
        case 'new':
          return startWizard(user, value, original.mid);
        case 'day':
          return { replace: await agendaScreen(user, Number(value)) };
        case 'week':
          return { replace: await agendaScreen(user, 0, 7) };
        case 'settings':
          return { replace: await settingsView(user) };
      }
    }

    if (kind === 'w') {
      const [step = '', ...values] = rest;
      const state = await store.wizard(user);
      if (!state || state.id !== action) return { notification: 'Этот мастер уже закрыт. Начните заново из меню.' };
      const result = await wizard.press(user, state, step, values.join(':'));
      if (result.stale) return { notification: 'Этот шаг уже пройден.' };
      if (!result.done) {
        const fresh = await store.wizard(user);
        if (fresh && fresh.mid !== original.mid) {
          fresh.mid = original.mid;
          await store.setWizard(user, fresh);
        }
      }
      return { replace: result.screen };
    }

    if (kind === 's') {
      if (action === 'open') return { replace: await settingsView(user) };
      if (action === 'toggle') {
        if (value === 'channel') {
          const channel = await backend.channel(user);
          await backend.setEnabled(user, !channel.enabled);
          return { replace: await settingsView(user, channel.enabled ? 'Уведомления выключены.' : 'Уведомления включены.') };
        }
        if (value === 'digest_enabled' || value === 'quiet_enabled') {
          const settings = await backend.settings(token);
          await backend.updateSettings(token, { [value]: !settings[value] });
          return { replace: await settingsView(user) };
        }
      }
      const [field, ...time] = rest;
      if (!isSettingsField(field)) return { notification: 'Неизвестная настройка' };
      if (action === 'time') return { replace: hourScreen(field) };
      if (action === 'h') return { replace: minuteScreen(field, time[0]) };
      if (action === 'm') {
        try {
          await backend.updateSettings(token, { [field]: time.join(':') });
        } catch (error) {
          if (error instanceof BackendError && error.status === 400) return { replace: await settingsView(user, error.message) };
          throw error;
        }
        return { replace: await settingsView(user, 'Сохранено.') };
      }
    }

    if (kind === 'n') {
      const itemId = value;
      const keep = escape(original.text || '');
      if (action === 'done') {
        const item = await backend.patch(token, itemId, { status: 'done' });
        return { replace: { text: `${keep}\n\n✅ Отметил выполненным: ${escape(item.title)}` } };
      }
      if (action === 'snooze15' || action === 'snooze60') {
        const at = new Date(now().getTime() + (action === 'snooze15' ? 15 : 60) * 60000);
        at.setSeconds(0, 0);
        const item = await backend.patch(token, itemId, { remind_at: at.toISOString() });
        return { replace: { text: `${keep}\n\n⏰ Хорошо, напомню в ${formatTime(at)}.`, buttons: [[button('✅ Сделано', `n:done:${item.id}`)]] } };
      }
      if (action === 'cancel') {
        const item = await backend.patch(token, itemId, { status: 'cancelled' });
        return { replace: { text: `${keep}\n\n❌ Встреча отменена: ${escape(item.title)}`, buttons: [[button('↩️ Вернуть', `n:restore:${item.id}`)]] } };
      }
      if (action === 'restore') {
        const item = await backend.patch(token, itemId, { status: 'scheduled' });
        return { replace: { text: `${keep}\n\n↩️ Встреча снова в расписании: ${escape(item.title)}` } };
      }
    }

    if (kind === 'u') {
      const result = await backend.undo(token, [action, ...rest].join(':'));
      return { replace: { text: `${escape(original.text || '')}\n\n${escape((result && result.reply) || 'Отменил.')}`, buttons: backToMenu } };
    }

    if (kind === 'o' || kind === 't') {
      // Кнопки ответа ассистента: убираем их, чтобы повторное нажатие не отправило ответ дважды
      const choice = [action, ...rest].join(':');
      after.push(async () => {
        const ctx = await context(user);
        if (kind === 't') return assistantText(user, choice, `max_t_${original.mid}_${choice}`.slice(0, 128));
        const flow = await settledFlow(user, ctx);
        if (flow && flow.status === 'awaiting_confirmation') {
          return continueFlow(user, ctx, flow, () => backend.answer(ctx.token, flow.message_id, flow.input_token, { confirmed: choice === 'yes' }));
        }
        return ask(user, ctx, `max_o_${original.mid}_${choice}`.slice(0, 128), { choice: { option_id: choice } });
      });
      return { replace: { text: keepOriginal(original) } };
    }
    return { notification: 'Кнопка устарела.' };
  }

  const keepOriginal = (original) => escape(original.text || '…');

  async function onCallback(update) {
    const callback = update.callback;
    const user = callback.user.user_id;
    const message = update.message || {};
    const original = { mid: message.body && message.body.mid, text: message.body && message.body.text };
    if (allowed.size && !allowed.has(user)) return max.answer(callback.callback_id, { notification: 'Доступ закрыт.' });
    // Действия, которые нужно выполнить уже после ответа на нажатие (запрос к ассистенту долгий)
    const after = [];
    let result;
    try {
      result = await press(user, callback.payload || '', original, after);
    } catch (error) {
      await max.answer(callback.callback_id, { notification: 'Не получилось. Попробуйте ещё раз.' }).catch(() => {});
      throw error;
    }
    if (result && result.replace) await max.answer(callback.callback_id, { message: result.replace });
    else await max.answer(callback.callback_id, { notification: (result && result.notification) || 'Готово' });
    for (const task of after) await task();
    return null;
  }

  return {
    handleUpdate(update) {
      switch (update.update_type) {
        case 'message_created':
          if (!update.message || !update.message.sender) return Promise.resolve();
          return enqueue(update.message.sender.user_id, () => onMessage(update));
        case 'message_callback':
          if (!update.callback || !update.callback.user) return Promise.resolve();
          return enqueue(update.callback.user.user_id, () => onCallback(update));
        case 'bot_started':
          if (!update.user) return Promise.resolve();
          return enqueue(update.user.user_id, () => onStarted(update));
        default:
          return Promise.resolve();
      }
    },
    idle: (user) => queues.get(user) || Promise.resolve(),
  };
}
