package config

import (
	"fmt"
	"net"
	"os"
	"time"
)

type Config struct {
	HTTPAddr         string
	ShutdownTimeout  time.Duration
	DatabaseURL      string
	DatabaseTimeout  time.Duration
	MigrationTimeout time.Duration
	MigrationsDir    string
}

// Load читает переменные окружения. Файл .env автоматически не загружается.
func Load() (Config, error) {
	cfg := Config{
		HTTPAddr: ":8080", ShutdownTimeout: 10 * time.Second,
		DatabaseURL:     os.Getenv("DATABASE_URL"),
		DatabaseTimeout: 10 * time.Second, MigrationTimeout: time.Minute,
		MigrationsDir: "migrations",
	}
	if cfg.DatabaseURL == "" {
		return Config{}, fmt.Errorf("DATABASE_URL is required")
	}
	if value, ok := os.LookupEnv("MIGRATIONS_DIR"); ok {
		if value == "" {
			return Config{}, fmt.Errorf("MIGRATIONS_DIR must not be empty")
		}
		cfg.MigrationsDir = value
	}
	if value, ok := os.LookupEnv("HTTP_ADDR"); ok {
		cfg.HTTPAddr = value
	}
	if _, _, err := net.SplitHostPort(cfg.HTTPAddr); err != nil {
		return Config{}, fmt.Errorf("invalid HTTP_ADDR: %w", err)
	}
	if value, ok := os.LookupEnv("SHUTDOWN_TIMEOUT"); ok {
		duration, err := time.ParseDuration(value)
		if err != nil || duration <= 0 {
			return Config{}, fmt.Errorf("SHUTDOWN_TIMEOUT must be a positive duration")
		}
		cfg.ShutdownTimeout = duration
	}
	for name, target := range map[string]*time.Duration{
		"DATABASE_TIMEOUT":  &cfg.DatabaseTimeout,
		"MIGRATION_TIMEOUT": &cfg.MigrationTimeout,
	} {
		if value, ok := os.LookupEnv(name); ok {
			duration, err := time.ParseDuration(value)
			if err != nil || duration <= 0 {
				return Config{}, fmt.Errorf("%s must be a positive duration", name)
			}
			*target = duration
		}
	}
	return cfg, nil
}
