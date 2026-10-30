// Уведомления браузера: за 15 минут до напоминания или встречи и в момент начала.
// Работают, пока страница открыта (хотя бы в фоновой вкладке): пушей с сервера пока нет.
import { plural } from './dom.js';
import { formatTime, now } from './time.js';

const KEY = 'notifications_enabled';
const FIRED_KEY = 'notifications_fired';
const SOON_MS = 15 * 60 * 1000;
// Момент начала ещё показываем, если вкладка проснулась с опозданием до двух минут
const LATE_MS = 2 * 60 * 1000;
const CHECK_MS = 15 * 1000;
const RELOAD_MS = 5 * 60 * 1000;
const LOOKAHEAD_MS = 2 * 60 * 60 * 1000;
const MINUTES = ['минуту', 'минуты', 'минут'];

export const notificationsSupported = 'Notification' in window && window.isSecureContext;

const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // приватный режим — живём без сохранения
    }
  },
};

/** Момент события: время напоминания или начало встречи. Встречи на весь день не уведомляют */
function momentOf(item) {
  if (item.type === 'reminder' && item.status === 'open' && item.remind_at) return Date.parse(item.remind_at);
  if (item.type === 'meeting' && item.status === 'scheduled' && item.start_at && !item.all_day) return Date.parse(item.start_at);
  return null;
}

function describe(item, kind, at) {
  const time = formatTime(new Date(at));
  const range = item.type === 'meeting' && item.end_at ? `${time}–${formatTime(item.end_at)}` : time;
  const place = item.location ? ` · ${item.location}` : '';
  if (kind === 'soon') {
    const minutes = Math.max(1, Math.round((at - now().getTime()) / 60000));
    const what = item.type === 'meeting' ? 'Встреча' : 'Напоминание';
    return { title: `Через ${minutes} ${plural(minutes, MINUTES)}: ${item.title}`, body: `${what} в ${range}${place}` };
  }
  if (item.type === 'meeting') return { title: `Начинается встреча: ${item.title}`, body: `${range}${place}` };
  return { title: `Напоминаю: ${item.title}`, body: `Напоминание на ${time}` };
}

/**
 * loadItems() — ближайшие записи; onDue(item, kind, text) — вызывается в момент срабатывания,
 * shown — показано ли системное уведомление (если нет, страница должна сообщить сама).
 * toggle и note — переключатель и подсказка в окне настроек.
 */
export function createNotifier({ loadItems, onDue, toggle, note }) {
  let items = [];
  let fired = loadFired();

  function loadFired() {
    try {
      return new Map(Object.entries(JSON.parse(storage.get(FIRED_KEY) || '{}')));
    } catch {
      return new Map();
    }
  }

  // Помним сработавшие уведомления сутки: перезагрузка страницы не должна показать их снова
  function remember(key) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    fired.set(key, Date.now());
    for (const [old, at] of fired) if (at < cutoff) fired.delete(old);
    storage.set(FIRED_KEY, JSON.stringify(Object.fromEntries(fired)));
  }

  const permitted = () => notificationsSupported && Notification.permission === 'granted';
  const enabled = () => permitted() && storage.get(KEY) !== 'off';

  function render() {
    toggle.checked = enabled();
    toggle.disabled = !notificationsSupported || Notification.permission === 'denied';
    if (!notificationsSupported) note.textContent = 'Этот браузер не показывает уведомления (или страница открыта не по https).';
    else if (Notification.permission === 'denied') note.textContent = 'Уведомления запрещены. Разрешите их в настройках сайта в браузере и обновите страницу.';
    else note.textContent = 'За 15 минут до встречи или напоминания и в момент начала. Страница должна оставаться открытой.';
  }

  async function enable() {
    if (!notificationsSupported) return false;
    if (Notification.permission === 'default') await Notification.requestPermission();
    storage.set(KEY, 'on');
    render();
    return permitted();
  }

  toggle.addEventListener('change', async () => {
    if (toggle.checked) await enable();
    else storage.set(KEY, 'off');
    render();
  });

  function show(item, kind, at) {
    const text = describe(item, kind, at);
    let shown = false;
    if (enabled()) {
      try {
        // Одинаковый tag не даёт двум открытым вкладкам показать уведомление дважды.
        // requireInteraction не используем: Chrome на macOS показывает такие уведомления как
        // «предупреждения», а их система по умолчанию скрывает.
        const notification = new Notification(text.title, { body: text.body, tag: `${item.id}:${kind}:${at}` });
        notification.addEventListener('click', () => {
          window.focus();
          notification.close();
        });
        shown = true;
      } catch (error) {
        console.warn('Уведомление не показано', error);
      }
    }
    onDue(item, kind, text, shown);
  }

  function check() {
    const current = now().getTime();
    for (const item of items) {
      const at = momentOf(item);
      if (at == null) continue;
      const left = at - current;
      let kind = null;
      // Меньше минуты до начала — «скоро» уже не нужно, сработает момент начала
      if (left > 60 * 1000 && left <= SOON_MS) kind = 'soon';
      else if (left <= 0 && left > -LATE_MS) kind = 'now';
      if (!kind) continue;
      const key = `${item.id}:${kind}:${at}`;
      if (fired.has(key)) continue;
      remember(key);
      show(item, kind, at);
    }
  }

  async function reload() {
    const current = now().getTime();
    try {
      const result = await loadItems({
        from: new Date(current - LATE_MS).toISOString(),
        to: new Date(current + LOOKAHEAD_MS).toISOString(),
      });
      items = (result && result.items) || [];
      check();
    } catch (error) {
      console.warn('Ближайшие записи для уведомлений не загрузились', error);
    }
  }

  render();
  reload();
  setInterval(check, CHECK_MS);
  setInterval(reload, RELOAD_MS);
  // Фоновые вкладки браузер «усыпляет»: при возвращении сразу проверяем, не пропущено ли что-то
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reload();
  });

  return {
    /** Вызывать после любого изменения записей, чтобы новое время учитывалось сразу */
    refresh: reload,
    render,
    enable,
    /** Предложить включить можно, только если пользователь ещё не отвечал браузеру */
    get canAsk() {
      return notificationsSupported && Notification.permission === 'default' && storage.get(KEY) !== 'off';
    },
  };
}
