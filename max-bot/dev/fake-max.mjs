// Поддельный MAX Bot API для локальной проверки без настоящего токена.
// Запуск: node dev/fake-max.mjs (порт FAKE_MAX_PORT, по умолчанию 9900), бот — с MAX_API_URL=http://<хост>:9900.
//   POST /_push  — добавить событие, например {"update_type":"message_created","message":{...}}
//   GET  /_sent  — что бот отправил, отредактировал и ответил на нажатия
//   POST /_reset — очистить
import { createServer } from 'node:http';

const PORT = Number(process.env.FAKE_MAX_PORT || 9900);
let queue = [];
let marker = 0;
let mid = 0;
let log = { sent: [], edited: [], answers: [], removed: [] };
const waiters = [];

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const read = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    try {
      resolve(raw ? JSON.parse(raw) : null);
    } catch {
      resolve(null);
    }
  });
});

function flush() {
  while (waiters.length && queue.length) {
    const { res, timer } = waiters.shift();
    clearTimeout(timer);
    const updates = queue;
    queue = [];
    marker += updates.length;
    json(res, 200, { updates, marker });
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;
  if (!url.pathname.startsWith('/_') && !req.headers.authorization) return json(res, 401, { code: 'verify.token', message: 'Invalid access_token' });
  switch (route) {
    case 'GET /me':
      return json(res, 200, { user_id: 1, name: 'Fake planner', username: 'fake_planner_bot', is_bot: true });
    case 'GET /updates': {
      if (queue.length) {
        const updates = queue;
        queue = [];
        marker += updates.length;
        return json(res, 200, { updates, marker });
      }
      const timeout = Math.min(Number(url.searchParams.get('timeout') || 30), 5) * 1000;
      const timer = setTimeout(() => {
        const index = waiters.findIndex((w) => w.res === res);
        if (index >= 0) waiters.splice(index, 1);
        json(res, 200, { updates: [], marker });
      }, timeout);
      waiters.push({ res, timer });
      return undefined;
    }
    case 'POST /messages': {
      const body = await read(req);
      mid++;
      log.sent.push({ user_id: url.searchParams.get('user_id'), mid: `mid.${mid}`, ...body });
      return json(res, 200, { message: { body: { mid: `mid.${mid}`, text: body && body.text } } });
    }
    case 'PUT /messages':
      log.edited.push({ message_id: url.searchParams.get('message_id'), ...(await read(req)) });
      return json(res, 200, { success: true });
    case 'DELETE /messages':
      log.removed.push(url.searchParams.get('message_id'));
      return json(res, 200, { success: true });
    case 'POST /answers':
      log.answers.push({ callback_id: url.searchParams.get('callback_id'), ...(await read(req)) });
      return json(res, 200, { success: true });
    case 'POST /_push': {
      const update = await read(req);
      queue.push({ timestamp: Date.now(), ...update });
      flush();
      return json(res, 200, { queued: queue.length });
    }
    case 'GET /_sent':
      return json(res, 200, log);
    case 'POST /_reset':
      log = { sent: [], edited: [], answers: [], removed: [] };
      queue = [];
      return json(res, 200, { ok: true });
    default:
      return json(res, 404, { code: 'not.found', message: route });
  }
}).listen(PORT, () => console.log(JSON.stringify({ message: 'fake MAX API listening', port: PORT })));
