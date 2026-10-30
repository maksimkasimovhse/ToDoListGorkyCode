// Пакет postgres реализует подключение к PostgreSQL и хранение данных.
package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

// Open возвращает пул соединений только после успешной проверки подключения к БД.
func Open(ctx context.Context, databaseURL string) (*sql.DB, error) {
	cfg, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		// Ошибка разбора драйвера может содержать учётные данные из исходного URL.
		return nil, fmt.Errorf("invalid DATABASE_URL")
	}
	cfg.RuntimeParams["timezone"] = "UTC"
	db := stdlib.OpenDB(*cfg)
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)
	db.SetConnMaxIdleTime(5 * time.Minute)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return db, nil
}
