// Пункты «Подключить MAX» и «Отвязать MAX» в меню пользователя: показывают, подключён ли бот,
// выдают одноразовую ссылку https://max.ru/<бот>?start=<код> (код действует 10 минут; без ссылки на бота
// показываем код для /link) и отвязывают аккаунт.
import * as api from './api.js';

export function createMaxLink({ button, label, status, unlinkButton, toast, onPick }) {
  async function render() {
    try {
      const { channels } = await api.getChannels();
      const linked = (channels || []).find((c) => c.channel === 'max');
      label.textContent = linked ? 'MAX: подключить заново' : 'Подключить MAX';
      status.textContent = linked ? `Подключён${linked.enabled ? '' : ', уведомления выключены в боте'}` : '';
      status.hidden = !linked;
      unlinkButton.hidden = !linked;
    } catch {
      // Бэкенд без поддержки каналов или заглушка: пункт остаётся с подписью по умолчанию
    }
  }

  button.addEventListener('click', async () => {
    onPick();
    button.disabled = true;
    try {
      const code = await api.createLinkCode('max');
      if (code.url) {
        window.open(code.url, '_blank', 'noopener');
        toast('Откройте бота в MAX и нажмите «Начать». Ссылка действует 10 минут.');
      } else {
        toast(`Отправьте боту в MAX: /link ${code.code} — код действует 10 минут.`);
      }
    } catch (error) {
      toast(error && error.code === 'not_implemented' ? 'Сервер пока не поддерживает подключение MAX.' : 'Не получилось получить код. Попробуйте ещё раз.');
    } finally {
      button.disabled = false;
    }
  });

  unlinkButton.addEventListener('click', async () => {
    onPick();
    if (!window.confirm('Отвязать MAX? Бот перестанет присылать уведомления и отвечать от вашего имени.')) return;
    unlinkButton.disabled = true;
    try {
      await api.unlinkChannel('max');
      toast('MAX отвязан. Подключить снова можно в этом же меню.');
    } catch (error) {
      toast(error && error.code === 'not_implemented'
        ? 'Сервер пока не умеет отвязывать с сайта. В боте MAX отправьте команду /logout.'
        : 'Не получилось отвязать. Попробуйте ещё раз.');
    } finally {
      unlinkButton.disabled = false;
      render();
    }
  });

  return { render };
}
