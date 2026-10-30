package migration_test

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"gorky/backend/internal/migration"
	"gorky/backend/internal/repository/postgres"
)

func TestMigrationsPostgres(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run PostgreSQL integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("migration_test_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := admin.ExecContext(cleanupCtx, "DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Errorf("cleanup: %v", err)
		}
	}()
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := u.Query()
	query.Set("search_path", schema)
	u.RawQuery = query.Encode()
	db, err := postgres.Open(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	provider, err := migration.NewProvider(db, filepath.Join("..", "..", "migrations"))
	if err != nil {
		t.Fatal(err)
	}
	results, err := provider.Up(ctx)
	if err != nil || len(results) != 1 {
		t.Fatalf("first up: count=%d, err=%v", len(results), err)
	}
	results, err = provider.Up(ctx)
	if err != nil || len(results) != 0 {
		t.Fatalf("repeated up: count=%d, err=%v", len(results), err)
	}
	const userID = "00000000-0000-0000-0000-000000000001"
	for _, dueDate := range []any{nil, "2026-10-30"} {
		_, err := db.ExecContext(ctx, `INSERT INTO items (user_id, type, title, source_text, status, due_date)
			VALUES ($1, 'task', 'отправить отчёт', 'исходный запрос', 'open', $2)`, userID, dueDate)
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO items (user_id, type, title, source_text, status)
		VALUES ($1, 'meeting', 'встреча', 'исходный запрос', 'scheduled')`, userID); err == nil {
		t.Fatal("meeting without start/end was accepted")
	}
	if _, err := provider.Down(ctx); err != nil {
		t.Fatal(err)
	}
	var exists bool
	if err := db.QueryRowContext(ctx, "SELECT to_regclass('items') IS NOT NULL").Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if exists {
		t.Fatal("items table still exists after down")
	}
	if _, err := provider.Up(ctx); err != nil {
		t.Fatalf("up after down: %v", err)
	}
}
