# HTTPS на сервере

Caddy запускается через compose.override.yaml и передаёт запросы Go-сервису backend:8080.
Текущий адрес: https://51-250-90-230.sslip.io. Бесплатное DNS-имя sslip.io указывает на IP,
записанный в имени. При смене IP обновите имя в Caddyfile.

В группе безопасности ВМ должны быть доступны входящие TCP-порты 80 и 443.
Сертификаты сохраняются в Docker volume caddy_data, настройки — в caddy_config.
Не удаляйте эти volumes при обновлении контейнеров.

На Ubuntu из корня проекта:

```bash
sudo docker compose up -d caddy
sudo docker compose logs --tail=50 caddy
curl -fsS https://51-250-90-230.sslip.io/healthz
```

После изменения Caddyfile:

```bash
sudo docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

Compose автоматически подхватывает compose.override.yaml. Для локального запуска только
основного стека используйте `docker compose -f compose.yaml up -d --build --wait`.
