# Голосовой ассистент задач и встреч

## Структура

```text
backend/               Go-сервер: API, раздача фронта и бизнес-логика
  cmd/                 команды запуска
  internal/            код приложения
  migrations/          SQL-миграции
  Dockerfile           образ приложения с файлами web/
web/                   HTML, CSS и JavaScript
ml-stub/               временная ML-заглушка (Node.js): разбор фраз правилами через Redis
compose.yaml           приложение, PostgreSQL и Redis
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

Копировать .env нужно только при первом запуске. Открыть http://localhost:8080.
Порт настраивается через APP_PORT. После изменения Go или web/ пересоберите приложение:

```powershell
docker compose up -d --build backend
docker compose logs -f backend
```

Фронт по умолчанию работает с настоящим API (`MODE: 'backend'` в web/js/config.js), для сообщений
он использует 202 и polling по [асинхронному контракту](backend/docs/async-contract.md).

## Чат: ML-заглушка

Сообщения ассистенту разбирает ML-обработчик, который читает задания из Redis Streams. Настоящего
пока нет, поэтому есть временная заглушка на правилах: [ml-stub](ml-stub/README.md). **Без неё чат
отвечает «Не получилось обработать запрос» через 15 секунд**; панели, галочки, удаление и ручное
создание записей работают и без неё.

Сначала запустите приложение (шаги выше), затем заглушку:

```powershell
cd ml-stub
docker compose up -d
```

Заглушку нужно запускать после приложения: она подключается к его сети `backend_default`.
Остановить: `docker compose down` в папке ml-stub. Когда появится настоящий ML-модуль, заглушку
останавливают, одновременно их запускать нельзя.

Примеры фраз: «Напомни завтра в 10 утра позвонить Ивану», «Поставь встречу с Иваном завтра»
(ассистент спросит время), «Что у меня завтра?», «Найди задачу про билеты».

## Если не работает

- **Чат отвечает ошибкой через 15 секунд.** Не запущена ML-заглушка (раздел выше). Проверка:
  `docker ps` должен показывать `ml-stub-ml-stub-1`, а `docker compose logs` в папке ml-stub — строки `answered`.
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
  ```

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
