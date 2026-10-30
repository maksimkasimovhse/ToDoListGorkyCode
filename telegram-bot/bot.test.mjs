// Сценарии бота с поддельными Telegram и бэкендом в памяти. Запуск: node --test
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { configureClock } from '../web/js/time.js';
import { createAuth } from './auth.mjs';
import { createBackend } from './backend.mjs';
import { createDialog } from './dialog.mjs';
import { createNotifier } from './notify.mjs';
import { escape, renderReply } from './render.mjs';
import { createMemoryStore } from './store.mjs';

configureClock({ timezone: 'Europe/Moscow' });

const CHAT = 42;
const reply = (type, text, extra = {}) => ({ type, reply: text, speak: null, items: [], options: [], data: {}, undo_token: null, suggestions: [], ...extra });

/** Бэкенд в памяти по async-contract.md: 202 processing → GET → итог, /answer, /cancel, /history */
function fakeBackend() {
  const state = { messages: new Map(), byClient: new Map(), answers: [], cancels: 0, created: 0, items: [], patches: [], busy: false };
  const json = (status, body) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const finish = (message, status, response, inputToken = null) => Object.assign(message, { status, response, input_token: inputToken });

  function script(message, text) {
    if (/с иваном завтра/i.test(text)) return finish(message, 'awaiting_input', reply('clarify', 'На какое время поставить встречу с Иваном?', { data: { expects: 'time' } }), 't1');
    if (/удали/i.test(text)) {
      return finish(message, 'awaiting_confirmation', reply('confirm', 'Удалить встречу с дизайнером?', { options: [{ id: 'yes', label: 'Да, удалить' }, { id: 'no', label: 'Нет' }] }), 't2');
    }
    if (/что у меня/i.test(text)) {
      return finish(message, 'completed', reply('results', 'Завтра две записи.', {
        data: { kind: 'list', from: '2026-10-30T00:00:00+03:00', to: '2026-10-31T00:00:00+03:00' },
        items: [
          { id: 'a', type: 'meeting', title: 'Встреча <команды>', start_at: '2026-10-30T15:00:00+03:00', end_at: '2026-10-30T16:00:00+03:00', status: 'scheduled', participants: [] },
          { id: 'b', type: 'reminder', title: 'позвонить Ивану', remind_at: '2026-10-30T10:00:00+03:00', status: 'open', participants: [] },
        ],
      }));
    }
    return finish(message, 'completed', reply('done', `Добавил: ${text}`));
  }

  async function fetchImpl(url, { method, body }) {
    const { pathname } = new URL(url);
    const data = body ? JSON.parse(body) : null;
    if (method === 'POST' && pathname === '/api/message') {
      if (state.busy) return json(409, { error: { code: 'conversation_busy', message: 'Дождитесь завершения предыдущего сообщения.' } });
      const existing = state.byClient.get(data.client_message_id);
      if (existing) return json(200, existing);
      state.created++;
      const message = { message_id: `m${state.created}`, status: 'processing', response: null, input_token: null, deadline_at: new Date(Date.now() + 15000).toISOString(), text: data.text, choice: data.choice };
      state.messages.set(message.message_id, message);
      state.byClient.set(data.client_message_id, message);
      return json(202, { ...message });
    }
    let match = /^\/api\/messages\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && match) {
      const message = state.messages.get(match[1]);
      if (message.status === 'processing') script(message, message.text || `choice ${message.choice.option_id}`);
      return json(200, message);
    }
    match = /^\/api\/messages\/([^/]+)\/(answer|cancel)$/.exec(pathname);
    if (method === 'POST' && match) {
      const message = state.messages.get(match[1]);
      if (match[2] === 'cancel') {
        state.cancels++;
        return json(200, finish(message, 'cancelled', reply('info', 'Хорошо, не добавляю.')));
      }
      if (data.input_token !== message.input_token) return json(409, { error: { code: 'stale_input', message: 'Окно уточнения устарело.' } });
      state.answers.push(data);
      return json(200, finish(message, 'completed', reply('done', 'Готово.')));
    }
    if (method === 'GET' && pathname === '/api/history') {
      return json(200, { history: [], pending_messages: [...state.messages.values()].filter((m) => m.status.startsWith('awaiting')) });
    }
    if (method === 'GET' && pathname === '/api/items') return json(200, { items: state.items, total: state.items.length });
    match = /^\/api\/items\/([^/]+)$/.exec(pathname);
    if (method === 'PATCH' && match) {
      state.patches.push({ id: match[1], ...data });
      return json(200, { ...state.items.find((item) => item.id === match[1]), ...data });
    }
    return json(404, { error: { code: 'not_found', message: 'нет такого маршрута' } });
  }
  return { state, fetchImpl };
}

function fakeTelegram() {
  const sent = [];
  const calls = [];
  return {
    sent,
    calls,
    async call(method, params) {
      calls.push({ method, ...params });
      return true;
    },
    async send(chat, message) {
      sent.push({ chat, ...message });
      return { message_id: sent.length };
    },
  };
}

let fake;
let tg;
let store;
let dialog;
let update;

function makeDialog() {
  const backend = createBackend({ baseUrl: 'http://backend', timezone: 'Europe/Moscow', fetchImpl: fake.fetchImpl, pollMs: 1 });
  const log = () => {};
  return createDialog({ tg, backend, store, auth: createAuth({ tg, backend, store, log }), log });
}

async function say(text, d = dialog) {
  update++;
  await d.handleUpdate({ update_id: update, message: { message_id: update, chat: { id: CHAT, type: 'private' }, from: { id: CHAT }, text } });
  return tg.sent.at(-1);
}

async function press(data) {
  update++;
  await dialog.handleUpdate({ update_id: update, callback_query: { id: `cb${update}`, data, from: { id: CHAT }, message: { message_id: 1, chat: { id: CHAT, type: 'private' } } } });
  return tg.sent.at(-1);
}

beforeEach(() => {
  fake = fakeBackend();
  tg = fakeTelegram();
  store = createMemoryStore();
  dialog = makeDialog();
  update = 100;
});

test('сообщение уходит ассистенту, ответ приходит в чат', async () => {
  const last = await say('Купить хлеб <срочно>');
  assert.equal(last.text, 'Добавил: Купить хлеб &lt;срочно&gt;');
  assert.equal(fake.state.created, 1);
});

test('уточнение: «в 17» превращается в поле time', async () => {
  assert.match((await say('Поставь встречу с Иваном завтра')).text, /На какое время/);
  assert.equal((await say('в 17')).text, 'Готово.');
  assert.deepEqual(fake.state.answers, [{ input_token: 't1', time: '17:00' }]);
});

test('непонятный ответ не отправляется, «отмена» отменяет сценарий', async () => {
  await say('Поставь встречу с Иваном завтра');
  assert.match((await say('когда-нибудь')).text, /Не понял/);
  assert.equal(fake.state.answers.length, 0);
  assert.equal((await say('отмена')).text, 'Хорошо, не добавляю.');
  assert.equal(fake.state.cancels, 1);
});

test('кнопка «Да» подтверждает, а кнопки после нажатия убираются', async () => {
  const question = await say('Удали встречу с дизайнером');
  assert.deepEqual(question.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['o:yes', 'o:no']);
  await press('o:yes');
  assert.deepEqual(fake.state.answers, [{ input_token: 't2', confirmed: true }]);
  assert.ok(tg.calls.some((c) => c.method === 'editMessageReplyMarkup'));
});

test('повтор того же апдейта не создаёт второе сообщение', async () => {
  const same = { update_id: 7, message: { message_id: 7, chat: { id: CHAT, type: 'private' }, from: { id: CHAT }, text: 'Купить молоко' } };
  await dialog.handleUpdate(same);
  await dialog.handleUpdate(same);
  assert.equal(fake.state.created, 1);
  assert.equal(tg.sent.length, 2);
});

test('занятый диалог', async () => {
  fake.state.busy = true;
  assert.match((await say('Что у меня завтра?')).text, /Подождите/);
});

test('после перезапуска бот продолжает начатое уточнение', async () => {
  await say('Поставь встречу с Иваном завтра');
  const restarted = makeDialog();
  assert.equal((await say('в 17', restarted)).text, 'Готово.');
  assert.deepEqual(fake.state.answers, [{ input_token: 't1', time: '17:00' }]);
});

test('голосовые и групповые чаты', async () => {
  await dialog.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: CHAT, type: 'private' }, from: { id: CHAT }, voice: {} } });
  assert.match(tg.sent.at(-1).text, /текстом/);
  await dialog.handleUpdate({ update_id: 2, message: { message_id: 2, chat: { id: -5, type: 'group' }, from: { id: CHAT }, text: 'привет' } });
  assert.match(tg.sent.at(-1).text, /личных сообщениях/);
  assert.equal(fake.state.created, 0);
});

test('/login без поддержки на сервере честно говорит про демо-пользователя', async () => {
  await say('/login');
  await say('ivan');
  const last = await say('secret');
  assert.ok(tg.calls.some((c) => c.method === 'deleteMessage'), 'сообщение с паролем удалено');
  assert.match(last.text, /демо-пользователь/);
  assert.equal(await store.token(CHAT), null);
});

test('список на день сгруппирован, HTML экранирован', () => {
  const { text } = renderReply({
    type: 'results', reply: 'Завтра:', data: { kind: 'list', from: '2026-10-30T00:00:00+03:00', to: '2026-10-31T00:00:00+03:00' },
    items: [
      { id: 'a', type: 'meeting', title: 'Встреча <команды>', start_at: '2026-10-30T15:00:00+03:00', end_at: '2026-10-30T16:00:00+03:00', status: 'scheduled', participants: [] },
      { id: 'b', type: 'reminder', title: 'позвонить Ивану', remind_at: '2026-10-30T10:00:00+03:00', status: 'open', participants: [] },
    ],
  });
  assert.match(text, /<b>.*30 октября<\/b>/);
  assert.ok(text.indexOf('10:00') < text.indexOf('15:00–16:00'), 'по времени внутри дня');
  assert.ok(text.includes('Встреча &lt;команды&gt;'));
  assert.equal(escape('a & b'), 'a &amp; b');
});

test('уведомления: за 15 минут и в момент начала, без повторов', async () => {
  const backend = createBackend({ baseUrl: 'http://backend', timezone: 'Europe/Moscow', fetchImpl: fake.fetchImpl, pollMs: 1 });
  const notifier = createNotifier({ tg, backend, store, log: () => {} });
  const at = (minutes) => new Date(Date.now() + minutes * 60000).toISOString();
  fake.state.items = [
    { id: 'm1', type: 'meeting', status: 'scheduled', title: 'Планёрка', start_at: at(10), end_at: at(70), all_day: false },
    { id: 'r1', type: 'reminder', status: 'open', title: 'позвонить Ивану', remind_at: at(-0.5) },
    { id: 'r2', type: 'reminder', status: 'done', title: 'уже сделано', remind_at: at(5) },
  ];
  await store.addChat(CHAT);
  await notifier.check();
  await notifier.check();
  assert.equal(tg.sent.length, 2);
  const soon = tg.sent.find((m) => m.text.includes('Планёрка'));
  assert.match(soon.text, /Через 10 минут/);
  const now = tg.sent.find((m) => m.text.includes('позвонить Ивану'));
  assert.deepEqual(now.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['d:r1', 's:r1']);

  await press('d:r1');
  assert.deepEqual(fake.state.patches, [{ id: 'r1', status: 'done' }]);

  await store.setNotify(CHAT, false);
  fake.state.items = [{ id: 'm2', type: 'meeting', status: 'scheduled', title: 'Обед', start_at: at(5), end_at: at(65), all_day: false }];
  const before = tg.sent.length;
  await notifier.check();
  assert.equal(tg.sent.length, before, 'выключенные уведомления не приходят');
});
