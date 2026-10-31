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

## Если не работает

- **Чат отвечает ошибкой.** Проверьте `GIGACHAT_AUTH_KEY` и `docker compose logs ml-worker`.
- **Ошибка 500 на любое сообщение или запись, в логах бэкенда ошибки SQL.** В вашей базе осталась
  схема от прежней версии: миграции менялись. Пересоздайте базу (данные будут удалены):
  `docker compose down -v`, затем снова `docker compose up -d --build --wait`.
- **Ошибка `declared as external, but could not be found` при запуске ml-stub.** Приложение не
  запущено или проект Compose назван иначе. Сначала `docker compose up -d --build --wait` в корне.
- **Сборка падает на `go mod download` или `apk add` с таймаутом DNS.** Контейнеры сборки не видят
  интернет (часто из-за VPN с пересекающейся подсетью Docker). Создайте локальный файл
  `compose.override.yaml` в корне (в git он не нужен):

  ```yaml
  services:
    backend:
      build:
        network: host
    ml-worker:
      build:
        network: host
  ```

- **Страница просит войти снова.** Срок сессии 7 дней, а также токены сбрасываются при очистке Redis (`docker compose down -v`). Войдите заново.
- **Чат отвечает дважды или через раз.** Одновременно запущены `ml-worker` и `ml-stub`. Остановите заглушку: `cd ml-stub && docker compose down`.
- **Заглушка ML не запускается или зависла** (`docker ps` не показывает `ml-stub-ml-stub-1` или в логах нет `ml-stub started`). Она ставит npm-пакеты при старте; при сбое сети пересоздайте: `cd ml-stub && docker compose up -d --force-recreate`.
- **Порт занят** (8080, 55432, 6379): измените `APP_PORT`, `POSTGRES_PORT`, `REDIS_PORT` в `.env`.
- **Микрофон.** Голосовой ввод работает в Chrome, Edge и Safari по адресу `localhost` (или по https).
  В Firefox, а также по IP-адресу в сети по http доступен только текстовый ввод.
- **Изменили файлы в web/, а страница старая.** Файлы попадают в образ при сборке:
  `docker compose up -d --build backend`, затем Ctrl+Shift+R в браузере.

## Запуск Go без сборки контейнера

Из корня:

```powershell
docker compose up -d --wait postgres redis
cd backend
$env:DATABASE_URL = 'postgres://gorky:gorky@localhost:55432/gorky?sslmode=disable'
$env:REDIS_URL = 'redis://localhost:6379/0'
go run ./cmd/api
```

Страница и API также доступны на localhost:8080. WEB_DIR по умолчанию ../web относительно
рабочей директории процесса; в контейнере указан /app/web. Прямой запуск Go не читает .env.
Не запускайте контейнер приложения и локальный Go одновременно на одном порту.

`docker compose down` останавливает приложение и сохраняет данные. Сохранено имя
Compose-проекта backend для совместимости с прежними volumes PostgreSQL и Redis.
Пароль в примере предназначен для локальной разработки; изменение .env не меняет пароль
уже созданной БД. Для публичного доступа и микрофона нужен HTTPS.

Подробности API и миграций — [backend/README.md](backend/README.md).
Фронтенд — [web/README.md](web/README.md).

## Вход пользователей

Бэкенд предоставляет POST /api/auth/login: demo1 / DemoPass1! или demo2 / DemoPass2!.
Каждый аккаунт видит свои записи и диалоги. Сессия действует 7 дней (SESSION_TTL=168h).
Подробности API и хранения сессий — [контракт авторизации](backend/docs/auth.md).

Форму входа и обработку 401 подключает фронтендер по контракту. Изменения авторизации во фронте отменены.
