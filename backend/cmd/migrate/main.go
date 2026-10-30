package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"gorky/backend/internal/config"
	"gorky/backend/internal/repository/postgres"
	"gorky/backend/migrations"
)

func main() {
	if err := run(); err != nil {
		slog.Error("migration failed", "error", err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) != 2 || (os.Args[1] != "up" && os.Args[1] != "down") {
		return fmt.Errorf("usage: migrate up|down (down rolls back one migration)")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	dbCtx, cancelDB := context.WithTimeout(ctx, cfg.DatabaseTimeout)
	db, err := postgres.Open(dbCtx, cfg.DatabaseURL)
	cancelDB()
	if err != nil {
		return err
	}
	defer db.Close()
	provider, err := migrations.NewProvider(db)
	if err != nil {
		return err
	}
	migrationCtx, cancel := context.WithTimeout(ctx, cfg.MigrationTimeout)
	defer cancel()
	if os.Args[1] == "up" {
		results, err := provider.Up(migrationCtx)
		if err != nil {
			return err
		}
		slog.Info("migrations applied", "count", len(results))
		return nil
	}
	_, err = provider.Down(migrationCtx)
	return err
}
