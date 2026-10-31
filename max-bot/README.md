# max-bot — техническая документация

Бот MAX и серверная часть уведомлений: модули, работа с БД, ключевые решения, тесты, запуск и конфигурация.
Пользовательские сценарии описаны в [общем README](../README.md).

- [Архитектура](#архитектура)
- [Структура](#структура)
- [Взаимодействие модулей бота](#взаимодействие-модулей-бота)
- [Потоки данных](#потоки-данных)
- [Работа с БД и Redis](#работа-с-бд-и-redis)
- [Ключевые решения](#ключевые-решения)
- [API](#api)
- [Стек](#стек)
- [Тесты](#тесты)

---

## Архитектура

Бот — тонкий клиент. Записи, правила дат, проверку конфликтов и **расписание уведомлений** ведёт Go-бэкенд, а бот только переводит события MAX в вызовы API и доставляет готовые уведомления.

```mermaid
flowchart TD
    A["Пользователь в MAX:<br/>сообщение или нажатие кнопки"] --> B["MAX Bot API:<br/>событие в очереди обновлений"]
    B --> C["max-bot: long polling<br/>GET /updates"]
    C --> D["max-bot: диалог, мастер<br/>или экран настроек"]
    D --> E["backend: HTTP API<br/>/api/* с Bearer · /internal/* с Bot-токеном"]
    D --> O["MAX Bot API:<br/>ответ пользователю"]
    E --> F[("Транзакция PostgreSQL:<br/>записи, каналы, настройки")]
    F --> G["Триггер на items:<br/>пересчитать расписание"]
    G --> H[("PostgreSQL:<br/>notifications")]
    H --> I["backend: диспетчер<br/>раз в NOTIFY_INTERVAL забирает наступившие"]
    I --> J[["Redis Streams:<br/>planner:notify:max"]]
    J --> K["max-bot: доставка<br/>XREADGROUP"]
    K --> L["MAX Bot API:<br/>POST /messages"]
    K -.-> M["backend: подтверждение доставки<br/>POST /internal/notifications/{id}/ack"]
    M -.-> H
```

Верхняя часть схемы — команды пользователя: бот переводит события MAX в вызовы того же API, что у сайта. Нижняя — уведомления: расписание пересчитывает триггер в той же транзакции, что и изменение записи, диспетчер забирает наступившие строки, бот только доставляет готовое сообщение и подтверждает доставку.

---

## Структура

```text
max-bot/                         Node.js, без фреймворков; единственная зависимость — redis
├── bot.mjs                      точка входа: long polling, запуск потребителя, SIGTERM
├── dialog.mjs                   маршрутизация событий: привязка, команды, кнопки, ассистент
├── wizard.mjs                   конечный автомат мастеров: задача / напоминание / встреча
├── settings.mjs                 экран «Уведомления»: вкл/выкл, время сводки, тихие часы
├── ui.mjs                       кнопки, меню, календарь, сетки часов и минут
├── render.mjs                   тексты: ответы ассистента, уведомления, сводка (HTML)
├── delivery.mjs                 чтение planner:notify:max, отправка, ack
├── max.mjs                      клиент MAX Bot API: fetch, повтор при 429/5xx
├── backend.mjs                  клиент API бэкенда: Bearer для /api, Bot для /internal
├── store.mjs                    состояние в Redis (max:*) + версия в памяти для тестов
├── bot.test.mjs                 сценарии с поддельными MAX и бэкендом
├── dev/fake-max.mjs             поддельный MAX API для локальной проверки
├── certs/                       Russian Trusted Root CA (сертификат MAX API)
└── compose.yaml, compose.dev.yaml

backend/                         серверная часть бота
├── migrations/00006_notifications.sql        таблицы, триггер, функция момента
└── internal/
    ├── domain/notification.go                настройки, тихие часы, окно сводки (чистые функции)
    ├── repository/notification.go            интерфейс хранилища
    ├── repository/postgres/notifications.go  SQL: настройки, каналы, коды, очередь
    ├── service/notifications.go              Channels (привязка, ack) и Dispatcher
    ├── queue/notify.go                        XADD в planner:notify:<канал>
    ├── transport/http/notifications.go       маршруты /api/* и /internal/*
    └── service/auth.go                        Verify + Issue: долгая сессия для бота

web/js/max-link.js               блок «Подключить MAX» в настройках сайта
```

Бот переиспользует модули сайта `web/js` (`time.js`, `items.js`, `answer.js`, `dom.js`): даты, подписи записей и разбор «завтра в 15:30» совпадают с сайтом без дублирования кода. В контейнер они монтируются только для чтения.

---

## Взаимодействие модулей бота

Событие MAX проходит через очередь пользователя и по типу попадает в нужный модуль. Ответ на нажатие кнопки заменяет сообщение с кнопкой, ответ на текст приходит новым сообщением.

```mermaid
flowchart TD
    A["bot.mjs: событие<br/>из GET /updates"] --> B["dialog.mjs: очередь пользователя<br/>события одного user_id по порядку"]
    B --> C{"Тип события"}

    C -->|"bot_started"| D{"payload —<br/>код привязки?"}
    D -->|"Да"| E["backend.mjs:<br/>POST /internal/channels/max/link"]
    D -->|"Нет"| F["render.mjs:<br/>приветствие и меню"]

    C -->|"message_created"| G{"Аккаунт привязан?<br/>store.mjs: max:auth"}
    G -->|"Нет"| H["Привязка: код с сайта<br/>или логин и пароль"]
    G -->|"Да"| I{"Активен мастер?<br/>store.mjs: max:wizard"}
    I -->|"Да"| J["wizard.mjs: текстовый шаг<br/>название, участники, место, «15:30»"]
    I -->|"Нет"| K["backend.mjs: POST /api/message<br/>ассистент и polling результата"]

    C -->|"message_callback"| L{"Префикс payload"}
    L -->|"m — меню"| M["Мастер, план дня<br/>или экран настроек"]
    L -->|"w — мастер"| N["wizard.mjs: следующий шаг<br/>проверка id мастера и шага"]
    L -->|"s — настройки"| O["settings.mjs:<br/>PATCH /api/notification-settings"]
    L -->|"n — уведомление"| P["PATCH /api/items/{id}:<br/>сделано, отложить, отменить"]
    L -->|"o, u, t"| Q["Ответ ассистенту<br/>или отмена действия"]

    E --> R["max.mjs: POST /messages<br/>новое сообщение"]
    F --> R
    H --> R
    J --> R
    K --> R
    M --> S["max.mjs: POST /answers<br/>заменить сообщение с кнопкой"]
    N --> S
    O --> S
    P --> S
    Q --> S
```

Сетевые запросы делают только `max.mjs`, `backend.mjs` и `store.mjs`. Остальные модули получают их через параметры, поэтому в тестах все три заменяются подделками в памяти.

**Маршрутизация кнопок.** Нажатие приходит как `message_callback` с `payload` вида `префикс:действие:значение`:

| Префикс | Модуль | Пример |
|---|---|---|
| `m` | меню | `m:new:meeting`, `m:day:1` |
| `w` | мастер (с id мастера) | `w:k3x9ab:minute:15:30` |
| `s` | настройки | `s:toggle:quiet_enabled`, `s:m:digest_time:07:45` |
| `n` | кнопки уведомления | `n:snooze15:<item_id>` |
| `o` / `u` / `t` | ответ ассистента, отмена, подсказка | `u:<undo_token>` |

Ответ на нажатие (`POST /answers`) **заменяет сообщение с кнопкой**, поэтому мастер идёт в одном сообщении, а не засоряет чат. События одного пользователя обрабатываются строго по очереди, разных пользователей — параллельно.

---

## Потоки данных

### Создание встречи кнопками

```mermaid
flowchart TD
    A["Кнопка «Встреча»:<br/>callback m:new:meeting"] --> B["wizard.mjs: создать мастер<br/>max:wizard, TTL 30 минут"]
    B --> C["Шаги: название → дата → час → минуты<br/>→ длительность → участники → место"]
    C --> D{"Время<br/>уже прошло?"}
    D -->|"Да"| C
    D -->|"Нет"| E["Экран подтверждения:<br/>сводка и время уведомлений"]
    E --> F["«Сохранить»: POST /api/items<br/>напрямую, без LLM"]
    F --> G{"Ответ backend"}
    G -->|"409 meeting_conflict"| H["Показать пересечения:<br/>сохранить всё равно или другое время"]
    H -->|"allow_conflicts: true"| F
    H -->|"Другое время"| C
    G -->|"201 Created"| I[("Транзакция PostgreSQL:<br/>items + триггер notifications")]
    I --> J["Карточка записи и undo_token:<br/>«Уведомлю в 14:45 и в 15:00»"]
```

При пересечении бэкенд отвечает `409 meeting_conflict` со списком конфликтов. Мастер показывает их и предлагает «Сохранить всё равно» (`allow_conflicts: true`).

### Доставка уведомления

```mermaid
flowchart TD
    A["Запись создана, изменена или удалена:<br/>сайт, ассистент, бот, undo"] --> B["Триггер items_sync_notifications:<br/>отменить pending, создать soon и now"]
    B --> C[("notifications: pending")]

    D["Диспетчер: тик<br/>каждые NOTIFY_INTERVAL"] --> E["Вернуть в pending queued<br/>без ack дольше NOTIFY_ACK_TIMEOUT"]
    D --> F["Запланировать утреннюю сводку,<br/>если наступило её время"]
    E -.-> C
    F -.-> C
    D --> G["Забрать наступившие:<br/>UPDATE … FOR UPDATE SKIP LOCKED"]
    C --> G
    G --> H[("notifications: queued")]

    H --> I{"Запись актуальна<br/>и «скоро» не опоздало?"}
    I -->|"Нет"| X[("cancelled")]
    I -->|"Да"| J{"Сейчас<br/>тихие часы?"}
    J -->|"Да"| K["held = true,<br/>fire_at = конец тихих часов"]
    K -.-> C
    J -->|"Нет"| L{"Есть включённый<br/>канал MAX?"}
    L -->|"Нет"| Y[("skipped")]
    L -->|"Да"| M[["Redis Streams:<br/>XADD planner:notify:max"]]

    M --> N["max-bot: XREADGROUP<br/>группа max-bot"]
    N --> O{"max:sent:{id}<br/>уже есть?"}
    O -->|"Да"| R
    O -->|"Нет"| P["max.mjs: POST /messages"]
    P --> Q{"Ответ MAX"}
    Q -->|"сеть, 429, 5xx"| T["Строка остаётся в Stream:<br/>повтор через 30 секунд"]
    T -.-> N
    Q -->|"403 / 404"| U["ack failed + disable_channel:<br/>канал выключается"]
    U --> W[("failed")]
    Q -->|"200"| V["SET max:sent:{id}"]
    V --> R["POST /internal/notifications/{id}/ack"]
    R --> Z[("sent")]
    R --> XA["XACK строки потока"]
```

Статусы строки `notifications`: `pending` → `queued` → `sent`, либо `cancelled`, `skipped`, `failed`. Отложенное тихими часами и неподтверждённое возвращаются в `pending` и уходят снова. Повторная доставка той же строки не создаёт второго сообщения: её отсекает отметка `max:sent:{id}`. Если запись вернули отменой действия к тому же моменту, триггер снова переводит `cancelled` в `pending`.

### Привязка аккаунта

```mermaid
flowchart TD
    A["Сайт: настройки → «Подключить MAX»"] --> B["POST /api/channels/max/link-code<br/>с Bearer пользователя"]
    B --> C[("channel_link_codes:<br/>одноразовый код на 10 минут")]
    C --> D["Ссылка https://max.ru/{бот}?start={код}"]
    D --> E["MAX: «Начать» →<br/>bot_started с payload"]
    E --> F["max-bot: POST /internal/channels/max/link<br/>external_id + code"]
    F --> G{"Код действителен?"}
    G -->|"Нет: 410"| H["Попросить новый код на сайте"]
    G -->|"Да"| J[("Транзакция: сжечь код,<br/>user_channels, отозвать прежнюю сессию")]

    K["Запасной путь: логин и пароль в боте,<br/>сообщение с паролем удаляется"] --> L["max-bot: POST /internal/channels/max/link<br/>external_id + login + password"]
    L --> M{"Пароль верный?"}
    M -->|"Нет: 401"| N["Повторить вход"]
    M -->|"Да"| J

    J --> P["Выдать сессию<br/>на CHANNEL_SESSION_TTL"]
    P --> Q["max-bot: max:auth:{user} = token"]
```

Код одноразовый: он удаляется при любой попытке, просроченный не принимается. Повторная привязка того же аккаунта MAX и `/logout` отзывают прежнюю сессию бота.

---

## Работа с БД и Redis

### Таблицы (миграция `00006_notifications.sql`)

```mermaid
flowchart TD
    U[("users")] --> S[("notification_settings<br/>digest_enabled · digest_time 07:30<br/>quiet_enabled · quiet_start · quiet_end<br/>digest_planned_on")]
    U --> C[("user_channels<br/>PK channel + external_id<br/>user_id · enabled · session_key")]
    U --> L[("channel_link_codes<br/>code · user_id · expires_at")]
    U --> I[("items")]
    I -->|"триггер"| N[("notifications<br/>item_id · kind soon / now / digest<br/>event_at · fire_at · status · held · attempts")]
    S -.->|"план сводки"| N
```

### Как устроено

| Механизм | Где | Зачем |
|---|---|---|
| Триггер `items_sync_notifications` | `AFTER INSERT/UPDATE/DELETE ON items` | любой путь изменения записи (сайт, ассистент, undo, бот) пересчитывает расписание в **той же транзакции** |
| `item_notification_moment(items)` | SQL-функция | одно определение «о каком моменте уведомлять»: `remind_at` у открытого напоминания, `start_at` у назначенной встречи (не на весь день); то же правило продублировано в Go для проверки при отправке |
| `UNIQUE (item_id, kind, event_at)` | индекс | одно и то же уведомление не создаётся дважды; отправленное при повторном сохранении записи не повторяется |
| `FOR UPDATE SKIP LOCKED` | `ClaimDue` | несколько экземпляров бэкенда разбирают очередь без двойной отправки |
| Частичные индексы | `WHERE status='pending'`, `WHERE status='queued'` | выборка наступивших и зависших не сканирует историю |
| Redis Stream + consumer group | `planner:notify:max`, группа `max-bot` | доставка «хотя бы один раз»: строка подтверждается `XACK` только после отправки; `MAXLEN ~10000` |

Ключи бота в Redis:

| Ключ | Что | TTL |
|---|---|---|
| `max:auth:<user>` | токен сессии пользователя | — |
| `max:session:<user>` | id диалога с ассистентом | — |
| `max:wizard:<user>` | состояние мастера или экрана | 30 мин |
| `max:login:<user>` | шаг входа по паролю | 5 мин |
| `max:sent:<notification_id>` | отметка отправки (защита от дублей) | 3 дня |
| `max:marker` | позиция long polling | — |

---

## Ключевые решения

| Решение | Почему |
|---|---|
| **Расписание считает БД, а не бот** | «Уведомлять всегда» нельзя гарантировать опросом с клиента: бот может лежать, токен — истечь, запись — измениться на сайте. Триггер видит каждое изменение, а неподтверждённое уведомление возвращается в очередь |
| **Outbox-подобная очередь в PostgreSQL + Redis Stream** | Postgres — источник истины и транзакции, Stream — быстрая доставка с consumer group. Потеря сообщения в Redis не страшна: через `NOTIFY_ACK_TIMEOUT` уведомление переотправится из БД |
| **At-least-once + идемпотентность** | Лучше повторить, чем потерять. Дубли отсекает `max:sent:<id>`, а в БД `ack` повторяем без вреда |
| **Проверка актуальности при отправке** | Между постановкой в очередь и отправкой запись могли перенести. Диспетчер сравнивает `event_at` с текущей записью; устаревшее — `cancelled` (для нового момента триггер уже создал строку) |
| **Тихие часы откладывают, а не отменяют** | Требование «не терять»: `held=true`, `fire_at` = конец тихих часов. «Скоро» о событии, которое начнётся раньше, отменяется — придёт «началось» |
| **Отдельная сессия бота на год** | Обычная сессия сайта — 7 дней; бот должен работать без повторного входа. Ключ сессии хранится в `user_channels`: отвязка и повторная привязка её отзывают |
| **`/internal/*` под общим секретом** | Привязка и `ack` не должны быть доступны пользователю. `Authorization: Bot <BOT_SERVICE_TOKEN>`, сравнение за постоянное время; без секрета маршруты отвечают 401 |
| **Мастера — конечный автомат в Redis** | Переживают перезапуск бота; id мастера в `payload` отсекает нажатия на старые кнопки |
| **Создание кнопками идёт мимо LLM** | `POST /api/items` напрямую: результат детерминирован и не зависит от доступности GigaChat; правила проверки те же, что у формы на сайте |
| **Long polling** | Не нужен публичный HTTPS-адрес для бота; переход на webhook (`POST /subscriptions`) не меняет `dialog.mjs` |
| **Без фреймворка** | Боту нужны 6 методов MAX API — `fetch` проще и прозрачнее SDK; одна зависимость (`redis`) |

---

## API

**Сайт и бот, `Authorization: Bearer <token>`**

| Метод | Путь | Тело / ответ |
|---|---|---|
| `GET` | `/api/notification-settings` | `{digest_enabled, digest_time, quiet_enabled, quiet_start, quiet_end}` |
| `PATCH` | `/api/notification-settings` | частичное изменение тех же полей; время — `ЧЧ:ММ` |
| `GET` | `/api/channels` | `{channels: [...], bots: {max: url}}` |
| `POST` | `/api/channels/max/link-code` | `{code, expires_at, url}` |

**Только бот, `Authorization: Bot <BOT_SERVICE_TOKEN>`**

| Метод | Путь | Тело / ответ |
|---|---|---|
| `POST` | `/internal/channels/max/link` | `{external_id, code}` или `{external_id, login, password}` → `{token, user, expires_at}`; `410` — код недействителен |
| `GET` | `/internal/channels/max/{external_id}` | `{linked, enabled, login, timezone}` |
| `PATCH` | `/internal/channels/max/{external_id}` | `{enabled}` |
| `DELETE` | `/internal/channels/max/{external_id}` | отвязка + отзыв сессии |
| `POST` | `/internal/notifications/{id}/ack` | `{status: sent \| failed, external_id, disable_channel}` |

Формат доставки в `planner:notify:max` (поле `payload`):

```json
{
  "version": 1, "id": "…", "kind": "soon | now | digest",
  "channel": "max", "external_id": "507858002", "user_id": "…",
  "timezone": "Europe/Moscow", "event_at": "2026-11-02T15:00:00+03:00", "held": false,
  "item": { "…": "запись для soon/now" },
  "items": [ "… записи дня для digest" ], "day": "2026-11-02"
}
```

---

## Стек

| Слой | Технология | Зачем |
|---|---|---|
| Бот | **Node.js 22**, ES-модули, встроенный `fetch`, `node:test` | один язык с фронтендом → общие модули `web/js` |
| Клиент Redis | `redis` 4.7 | Streams, consumer group, TTL-ключи |
| Бэкенд | **Go 1.26**, `chi`, `pgx`, `go-redis`, `goose` | диспетчер — горутина в том же процессе, что и API |
| БД | **PostgreSQL 17** | транзакции, триггеры, `SKIP LOCKED` |
| Очередь | **Redis 7 Streams** | доставка уведомлений боту |
| Мессенджер | **MAX Bot API** | `platform-api2.max.ru`, сертификат Russian Trusted Root CA |
| Запуск | **Docker Compose** | бот подключается к сети `backend_default` |

---

## Тесты

Локально Go и Node не нужны — всё запускается в контейнерах.

```bash
# Бот: мастера, настройки, доставка, клиенты MAX и бэкенда (без сети, ~1 с)
docker run --rm -v "$PWD/max-bot":/src/max-bot:ro -v "$PWD/web/js":/src/web/js:ro node:22-alpine \
  sh -c "cp -r /src /app && cd /app/max-bot && npm ci --no-audit --no-fund >/dev/null && node --test"

# Бэкенд: юнит-тесты (тихие часы, окно сводки, валидация) — без БД
docker run --rm -v "$PWD/backend":/src -w /src golang:1.26-alpine go test ./internal/domain ./internal/service

# Бэкенд: интеграционные (триггер, диспетчер, тихие часы, сводка, привязка) — нужны Postgres и Redis
docker compose -f compose.yaml up -d postgres redis
docker run --rm -v "$PWD/backend":/src -w /src \
  -e TEST_DATABASE_URL='postgres://gorky:gorky@host.docker.internal:55432/gorky?sslmode=disable' \
  -e TEST_REDIS_URL='redis://host.docker.internal:6379/0' \
  golang:1.26-alpine go test -run 'Notification|Dispatcher|QuietHours|MorningDigest|ChannelLinking' ./internal/integration
```

Интеграционные тесты создают отдельную схему на каждый тест и удаляют её после себя.

| Набор | Что проверяет |
|---|---|
| `bot.test.mjs` (17) | привязка по коду и паролю, три мастера, конфликт встреч, ввод времени текстом, устаревшие кнопки, настройки, тексты уведомлений и сводки, доставка без дублей, блокировка бота, заголовки клиентов |
| `domain/notification_test.go` | тихие часы через полночь, окно сводки, валидация времени |
| `integration/notifications_test.go` | триггер при создании, переносе, отмене; доставка один раз и повтор без ack; тихие часы; сводка один раз в день; API привязки и настроек |

---