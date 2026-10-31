# Голосовой ассистент задач и встреч

## Структура

```text
backend/               Go-сервер: API, раздача фронта и бизнес-логика
  cmd/                 команды запуска
  internal/            код приложения
  migrations/          SQL-миграции
  Dockerfile           образ приложения с файлами web/
web/                   HTML, CSS и JavaScript
ml-worker/             GigaChat + Embeddings-2, обработчик Redis Streams
ml-stub/               отдельная заглушка для тестов без внешней модели
max-bot/               бот MAX (Node.js): уведомления, утренняя сводка, создание записей кнопками
compose.yaml           приложение, ML worker, PostgreSQL и Redis
.env.example           настройки общего запуска
.dockerignore          исключения общего контекста сборки
```

Go отдаёт страницу и API с одного адреса. Отдельные nginx и Python не нужны.

## Запуск

Из корня, с запущенным Docker Desktop:

```powershell
Copy-Item .env.example .env
docker compose up -d --build --wait
```

Копировать .env нужно только при первом запуске. В `.env` задайте `GIGACHAT_AUTH_KEY`
или `GIGACHAT_ACCESS_TOKEN`, затем откройте http://localhost:8080.
Порт настраивается через APP_PORT. После изменения Go или web/ пересоберите приложение:

```powershell
docker compose up -d --build backend
docker compose logs -f backend
```

Фронт по умолчанию работает с настоящим API (`MODE: 'backend'` в web/js/config.js), для сообщений
он использует 202 и polling по [асинхронному контракту](backend/docs/async-contract.md).

## Чат и смысловой поиск

`ml-worker` входит в общий Compose: он читает задания из Redis Streams, вызывает GigaChat и
возвращает структурированные команды. SQL, проверка пользователя, конфликты и изменения задач
остаются в Go. Поиск объединяет совпадения слов с `Embeddings-2`; при недоступности embeddings
автоматически остаётся поиск по словам. Подробнее: [интеграция модели](backend/docs/model-integration.md).

`ml-stub` сохранён только для автономных тестов, когда ключа GigaChat нет. Корневой
`docker compose up` его не запускает. Не запускайте его одновременно с `ml-worker`: оба читают
одну consumer group и делят сообщения между собой. Если заглушка запущена, перед
`docker compose up` в корне остановите её: `cd ml-stub && docker compose down`.

Примеры фраз: «Напомни завтра в 10 утра позвонить Ивану», «Поставь встречу с Иваном завтра»
(ассистент спросит время), «Что у меня завтра?», «Найди задачу про билеты».

## Вход

Бэкенд требует вход. Тестовые аккаунты (создаёт миграция, см. [backend/docs/auth.md](backend/docs/auth.md)):
`demo1` / `DemoPass1!` и `demo2` / `DemoPass2!`. На странице входа две кнопки подставляют их данные.
У каждого пользователя свои записи и свои чаты. Старые записи демопользователя принадлежат `demo1`.

## Бот MAX

Уведомления за 15 минут до встреч и напоминаний и в момент начала, утренняя сводка, тихие часы и создание
записей кнопками. Расписание уведомлений считает бэкенд, бот доставляет: [max-bot](max-bot/README.md).

С токеном бота в `max-bot/.env` и общим `BOT_SERVICE_TOKEN` в корневом `.env`:

```bash
cd max-bot
docker compose up -d
```

## Если не работает

- **Чат отвечает ошибкой.** Проверьте `GIGACHAT_AUTH_KEY` и `docker compose logs ml-worker`.
- **Ошибка `declared as external, but could not be found` при запуске ml-stub.** Приложение не
  запущено или проект Compose назван иначе. Сначала `docker compose up -d --build --wait` в корне.
- **Сборка падает на `go mod download` или `apk add` с таймаутом DNS.** Контейнеры сборки не видят
  интернет (часто из-за VPN с пересекающейся подсетью Docker). `compose.override.yaml` уже занят
  настройкой Caddy для сервера, поэтому создайте отдельный локальный файл `compose.local.yaml`
  в корне (в git он не нужен) и добавьте в `.env` строку
  `COMPOSE_FILE=compose.yaml:compose.local.yaml` (заодно локально не запустится Caddy):

  ```yaml
  services:
    backend:
      build:
        network: host
    ml-worker:
      build:
        network: host
  ```

- **Страница просит войти снова.** Войдите заново. Техническая диагностика авторизации — в [README бэкенда](backend/README.md#диагностика).
- **Чат отвечает дважды или через раз.** Одновременно запущены `ml-worker` и `ml-stub`. Остановите заглушку: `cd ml-stub && docker compose down`.
- **Заглушка ML не запускается или зависла** (`docker ps` не показывает `ml-stub-ml-stub-1` или в логах нет `ml-stub started`). Она ставит npm-пакеты при старте; при сбое сети пересоздайте: `cd ml-stub && docker compose up -d --force-recreate`.
- **Порт занят** (8080, 55432, 6379): измените `APP_PORT`, `POSTGRES_PORT`, `REDIS_PORT` в `.env`.
- **Микрофон.** Голосовой ввод работает в Chrome, Edge и Safari по адресу `localhost` (или по https).
  В Firefox, а также по IP-адресу в сети по http доступен только текстовый ввод.
- **Изменили файлы в web/, а страница старая.** Файлы попадают в образ при сборке:
  `docker compose up -d --build backend`, затем Ctrl+Shift+R в браузере.

## Документация

Архитектура Go-бэкенда, работа с БД и Redis, конфигурация, отдельный запуск и тесты описаны в [backend/README.md](backend/README.md).
Документация интерфейса — [web/README.md](web/README.md).
