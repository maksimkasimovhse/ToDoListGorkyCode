# Голосовой ассистент задач и встреч

## Структура

```text
backend/               Go-сервер: API, раздача фронта и бизнес-логика
  cmd/                 команды запуска
  internal/            код приложения
  migrations/          SQL-миграции
  Dockerfile           образ приложения с файлами web/
web/                   HTML, CSS и JavaScript
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

Для реального API в web/js/config.js установите USE_MOCKS: false и API_BASE: ''.
Режим заглушек фронта оставлен без изменений. Для сообщений фронт должен поддерживать
202 и polling по [асинхронному контракту](backend/docs/async-contract.md).
ML-обработчик подключается коллегами через Redis Streams; без него ручные операции работают,
а текстовые сообщения завершаются по тайм-ауту.

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
