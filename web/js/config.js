export const CONFIG = {
  // true — фронт работает с заглушкой из js/mock/, бэкенд не нужен.
  // false — запросы идут на API_BASE по контрактам (contracts.md, раздел 2).
  USE_MOCKS: true,
  API_BASE: '',
  // Сервер ждёт LLM до 15 секунд [ФТ 15], фронт ждёт чуть дольше
  MESSAGE_TIMEOUT_MS: 20000,
};
