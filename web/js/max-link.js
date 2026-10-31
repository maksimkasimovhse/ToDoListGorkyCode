// Блок «Бот в MAX» в настройках: показывает, подключён ли бот, и выдаёт одноразовую ссылку
// https://max.ru/<бот>?start=<код>. Код действует 10 минут; без ссылки на бота показываем код для /link.
import * as api from './api.js';

export function createMaxLink({ button, note }) {
  const DEFAULT_NOTE = note.textContent;

  async function render() {
    try {
      const { channels } = await api.getChannels();
      const linked = (channels || []).find((c) => c.channel === 'max');
      button.textContent = linked ? 'Подключить заново' : 'Подключить MAX';
      note.textContent = linked
        ? `Подключён${linked.enabled ? '' : ', уведомления выключены в боте'}. Настройки сводки и тихих часов — в боте: /settings.`
        : DEFAULT_NOTE;
    } catch {
      // Бэкенд без поддержки каналов или заглушка: блок остаётся с подсказкой по умолчанию
    }
  }

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const code = await api.createLinkCode('max');
      if (code.url) {
        window.open(code.url, '_blank', 'noopener');
        note.textContent = `Откройте бота по ссылке и нажмите «Начать»: ${code.url}. Ссылка действует 10 минут.`;
      } else {
        note.textContent = `Отправьте боту в MAX сообщение: /link ${code.code} — код действует 10 минут.`;
      }
    } catch (error) {
      note.textContent = error && error.code === 'not_implemented' ? 'Сервер пока не поддерживает подключение MAX.' : 'Не получилось получить код. Попробуйте ещё раз.';
    } finally {
      button.disabled = false;
    }
  });

  return { render };
}
