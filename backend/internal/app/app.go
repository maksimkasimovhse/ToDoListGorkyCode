// Пакет app собирает зависимости приложения и управляет их жизненным циклом.
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
	"gorky/backend/internal/queue"
	"gorky/backend/internal/repository/postgres"
	"gorky/backend/internal/service"
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
	redisCtx, cancelRedis := context.WithTimeout(ctx, a.cfg.DatabaseTimeout)
	bus, err := queue.Open(redisCtx, a.cfg.RedisURL, a.cfg.MLRequestStream, a.cfg.MLResultStream, a.cfg.MLResultGroup)
	cancelRedis()
	if err != nil {
		return fmt.Errorf("initialize Redis: %w", err)
	}
	defer bus.Close()
	store := postgres.NewMessages(db)
	messages := service.NewMessages(store, a.cfg.MessageTimeout)
	items := service.NewItems(postgres.NewItems(db))
	a.server.Handler = httptransport.NewRouter(messages, items, a.cfg.WebDir)
	workerCtx, cancelWorkers := context.WithCancel(ctx)
	waitWorkers := bus.Start(workerCtx, store, messages.HandleResult, a.logger)
	defer func() { cancelWorkers(); waitWorkers() }()

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
