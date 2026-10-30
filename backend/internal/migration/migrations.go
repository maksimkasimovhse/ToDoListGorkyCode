// Пакет migration выполняет версионированные SQL-миграции из указанной папки.
package migration

import (
	"database/sql"
	"fmt"
	"os"

	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

func NewProvider(db *sql.DB, dir string) (*goose.Provider, error) {
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return nil, fmt.Errorf("create migration lock: %w", err)
	}
	return goose.NewProvider(goose.DialectPostgres, db, os.DirFS(dir),
		goose.WithSessionLocker(locker),
		goose.WithDisableGlobalRegistry(true),
	)
}
