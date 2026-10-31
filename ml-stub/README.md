# ML-заглушка

Запасная замена ML-модуля для проверки без ключа GigaChat. Настоящий обработчик — [ml-worker](../ml-worker/README.md), его запускает корневой `docker compose up`. Заглушка читает те же задания бэкенда из Redis, разбирает фразу правилами (регулярные выражения) и возвращает результат в формате [backend/docs/async-contract.md](../backend/docs/async-contract.md).

**Запускайте её только вместо `ml-worker`, никогда вместе с ним:** оба читают одну consumer group (`planner-ml`) и делят сообщения между собой.

Правила общие с браузерной заглушкой фронта: [web/js/mock/nlu.js](../web/js/mock/nlu.js). Здесь только перевод их результата в формат намерений из contracts.md, раздел 3.3: [parse.mjs](parse.mjs).

## Запуск

Сначала поднимите приложение из корня репозитория без `ml-worker`, затем заглушку:

```bash
docker compose up -d --build --wait backend postgres redis   # в корне, без ml-worker
docker compose stop ml-worker                                # если он уже был запущен
cd ml-stub && docker compose up -d      # заглушка подключается к Redis приложения
docker compose logs -f                  # по строке на каждое сообщение
```

Заглушка подключается к сети `backend_default`, которую создаёт корневой `docker compose` (проект называется `backend`). Если проект назван иначе, задайте `BACKEND_NETWORK`. Без Docker нужен Node.js 22.12+:

```bash
npm ci
REDIS_URL=redis://localhost:6379/0 npm start
```

Остановить: `docker compose down`.

Чтобы работать на заглушке, остановите `ml-worker` (`docker compose stop ml-worker` в корне), затем запустите заглушку. Чтобы вернуться на GigaChat: `docker compose down` здесь, затем `docker compose up -d` в корне.

## Проверка

```bash
docker run --rm -v "$PWD/..":/app -w /app/ml-stub node:22-alpine node --test
```

Тесты в [parse.test.mjs](parse.test.mjs) — сценарии приёмки из ФТ, раздел 16, при «сейчас» = четверг, 29 октября 2026, 12:00.

## Что умеет и чего нет

- Создание задач, напоминаний и встреч, в том числе несколько в одной фразе; ответы на уточнения («в 17», «завтра»); «да» и «нет» словом и кнопкой; отмена; список за период; поиск по теме и участнику.
- Изменение, удаление и выполнение разбираются в намерения по контракту. Бэкенд разрешает цель и при нескольких совпадениях запрашивает выбор: см. backend/docs/selection.md.
- Понимает формулировки из ФТ и близкие к ним, а не любые. Непонятное — `not_understood`.
- Поиск: бэкенд ищет подстрокой без морфологии, поэтому заглушка отдаёт основу самого длинного слова («договору» → «догово»). Синонимов нет: «презентация» не найдёт «слайды».

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| REDIS_URL | redis://localhost:6379/0 (в compose — redis://redis:6379/0) | Redis бэкенда |
| ML_REQUEST_STREAM | planner:ml:requests | Задания от бэкенда |
| ML_RESULT_STREAM | planner:ml:results | Результаты для бэкенда |
| ML_REQUEST_GROUP | planner-ml | Группа чтения заданий |
| ML_CONSUMER | ml-stub | Имя читателя; постоянное, чтобы после перезапуска дочитать свои задания |
