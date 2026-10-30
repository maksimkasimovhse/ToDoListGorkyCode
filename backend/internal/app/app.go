// Package app wires application dependencies and manages their lifecycle.
package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"gorky/backend/internal/config"
	"gorky/backend/internal/migration"
	"gorky/backend/internal/repository/postgres"
	httptransport "gorky/backend/internal/transport/http"
)

type App struct {
	cfg    config.Config
	logger *slog.Logger
	server *http.Server
}

func New(cfg config.Config, logger *slog.Logger) *App {
	return &App{
		cfg:    cfg,
		logger: logger,
		server: &http.Server{
			Addr:              cfg.HTTPAddr,
			Handler:           httptransport.NewRouter(),
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       15 * time.Second,
			WriteTimeout:      30 * time.Second,
			IdleTimeout:       60 * time.Second,
		},
	}
}

func (a *App) Run(ctx context.Context) error {
	dbCtx, cancelDB := context.WithTimeout(ctx, a.cfg.DatabaseTimeout)
	db, err := postgres.Open(dbCtx, a.cfg.DatabaseURL)
	cancelDB()
	if err != nil {
		return fmt.Errorf("initialize database: %w", err)
	}
	defer db.Close()
	a.logger.Info("connected to PostgreSQL")

	provider, err := migration.NewProvider(db, a.cfg.MigrationsDir)
	if err != nil {
		return fmt.Errorf("initialize migrations: %w", err)
	}
	migrationCtx, cancelMigrations := context.WithTimeout(ctx, a.cfg.MigrationTimeout)
	results, err := provider.Up(migrationCtx)
	cancelMigrations()
	if err != nil {
		return fmt.Errorf("apply migrations: %w", err)
	}
	a.logger.Info("database migrations applied", "count", len(results))
	if err := ctx.Err(); err != nil {
		return err
	}

	serverErr := make(chan error, 1)
	go func() {
		serverErr <- a.server.ListenAndServe()
	}()
	a.logger.Info("starting HTTP server", "addr", a.cfg.HTTPAddr)

	select {
	case err := <-serverErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve HTTP: %w", err)
	case <-ctx.Done():
	}

	a.logger.Info("stopping HTTP server")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), a.cfg.ShutdownTimeout)
	defer cancel()
	if err := a.server.Shutdown(shutdownCtx); err != nil {
		_ = a.server.Close()
		return fmt.Errorf("shutdown HTTP server: %w", err)
	}
	return nil
}
