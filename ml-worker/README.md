# ML worker

Сервис заменяет `ml-stub`: читает `planner:ml:requests`, вызывает GigaChat и публикует
ответы текущего backend-контракта в `planner:ml:results`. На порту 8090 он также даёт
внутренний endpoint `/v1/embeddings`; наружу порт не публикуется.

Нужен `GIGACHAT_AUTH_KEY` либо короткоживущий `GIGACHAT_ACCESS_TOKEN`. Секрет из XLSX
не копируется в образ и не должен попадать в git. Модель не получает авторизационный токен,
`user_id` и доступ к PostgreSQL. Любая команда повторно проверяется и исполняется Go-бэкендом.

Проверка адаптера без обращения к API:

```sh
python -m unittest test_adapter.py
```
