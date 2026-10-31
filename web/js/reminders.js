// Срабатывание напоминаний [ФТ 13] на стороне фронта: у бэкенда нет потока событий, поэтому открытая
// страница сама следит за открытыми напоминаниями из GET /api/items и в нужный момент сообщает о них.
//  — remind_at наступил, пока страница открыта: onFire(item);
//  — наступил, пока страницы не было (после прошлого визита): один раз onMissed(items).
// Какие напоминания уже показаны, помнит localStorage: после перезагрузки они не повторяются.
import * as api from './api.js';
import { now } from './time.js';

const FIRED_KEY = 'fired_reminders';
const HORIZON_MS = 24 * 60 * 60 * 1000; // дальше суток не планируем: список обновится сам
const MAX_MISSED_MS = 7 * 24 * 60 * 60 * 1000;
const RESYNC_MS = 60 * 1000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function loadFired() {
  try {
    return JSON.parse(localStorage.getItem(FIRED_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveFired(map) {
  // Хранить все id вечно незачем: оставляем последние 200
  const entries = Object.entries(map).slice(-200);
  try {
    localStorage.setItem(FIRED_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // приватный режим — повторы возможны только после перезагрузки
  }
}

/**
 * lastSeen() — ISO-время прошлого визита или null. onFire(item), onMissed(items).
 * start() — первая синхронизация с учётом пропущенных, stop() — при выходе, sync() — после изменения записей.
 */
export function createReminders({ lastSeen, onFire, onMissed }) {
  let timers = new Map();
  let ticker = null;
  let syncing = false;
  let again = false;

  function clearTimers() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers = new Map();
  }

  function markFired(items) {
    const fired = loadFired();
    for (const item of items) fired[item.id] = item.remind_at;
    saveFired(fired);
  }

  /** Время вышло: запись могли удалить, выполнить или перенести — спрашиваем актуальное состояние */
  async function fire(id) {
    timers.delete(id);
    try {
      const item = await api.getItem(id);
      const fired = loadFired();
      if (!item || item.status !== 'open' || !item.remind_at || fired[item.id] === item.remind_at) return;
      if (Date.parse(item.remind_at) > now().getTime() + 1000) return sync(); // перенесли на позже
      markFired([item]);
      onFire(item);
    } catch (error) {
      console.warn('Напоминание не проверено', error);
    }
  }

  async function sync({ initial = false } = {}) {
    if (syncing) {
      again = true;
      return;
    }
    syncing = true;
    try {
      const nowMs = now().getTime();
      const since = initial && lastSeen() ? Math.max(Date.parse(lastSeen()), nowMs - MAX_MISSED_MS) : nowMs - 2 * 60 * 1000;
      const result = await api.getItems({
        from: new Date(since).toISOString(),
        to: new Date(nowMs + HORIZON_MS).toISOString(),
        types: ['reminder'],
        status: 'open',
      });
      const fired = loadFired();
      const missed = [];
      const due = [];
      const upcoming = [];
      for (const item of (result && result.items) || []) {
        if (item.status !== 'open' || !item.remind_at || fired[item.id] === item.remind_at) continue;
        const at = Date.parse(item.remind_at);
        if (at > nowMs) upcoming.push(item);
        else (initial ? missed : due).push(item);
      }

      clearTimers();
      for (const item of upcoming) {
        const delay = Math.min(Math.max(Date.parse(item.remind_at) - nowMs, 0), MAX_TIMEOUT_MS);
        timers.set(item.id, setTimeout(() => fire(item.id), delay));
      }
      if (missed.length) {
        markFired(missed);
        onMissed(missed);
      }
      if (due.length) {
        markFired(due);
        due.forEach(onFire);
      }
    } catch (error) {
      console.warn('Напоминания не обновились', error);
    } finally {
      syncing = false;
      if (again) {
        again = false;
        sync();
      }
    }
  }

  return {
    async start() {
      await sync({ initial: true });
      clearInterval(ticker);
      ticker = setInterval(() => sync(), RESYNC_MS);
    },
    stop() {
      clearInterval(ticker);
      ticker = null;
      clearTimers();
    },
    sync: () => sync(),
  };
}
