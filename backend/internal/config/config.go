package config

import (
	"fmt"
	"net"
	"os"
	"time"
)

type Config struct {
	SessionTTL       time.Duration
	HTTPAddr         string
	WebDir           string
	ShutdownTimeout  time.Duration
	DatabaseURL      string
	DatabaseTimeout  time.Duration
	MigrationTimeout time.Duration
	MigrationsDir    string
	RedisURL         string
	MLRequestStream  string
	MLResultStream   string
	MLResultGroup    string
	MessageTimeout   time.Duration
}

// Load читает переменные окружения. Файл .env автоматически не загружается.
func Load() (Config, error) {
	cfg := Config{
		SessionTTL: 7 * 24 * time.Hour, WebDir: "../web", HTTPAddr: ":8080", ShutdownTimeout: 10 * time.Second,
		DatabaseURL:     os.Getenv("DATABASE_URL"),
		DatabaseTimeout: 10 * time.Second, MigrationTimeout: time.Minute,
		MigrationsDir:   "migrations",
		RedisURL:        "redis://localhost:6379/0",
		MLRequestStream: "planner:ml:requests", MLResultStream: "planner:ml:results",
		MLResultGroup: "planner-backend", MessageTimeout: 15 * time.Second,
	}
	if cfg.DatabaseURL == "" {
		return Config{}, fmt.Errorf("DATABASE_URL is required")
	}
	for name, target := range map[string]*string{
		"WEB_DIR": &cfg.WebDir, "REDIS_URL": &cfg.RedisURL, "ML_REQUEST_STREAM": &cfg.MLRequestStream,
		"ML_RESULT_STREAM": &cfg.MLResultStream, "ML_RESULT_GROUP": &cfg.MLResultGroup,
	} {
		if value, ok := os.LookupEnv(name); ok {
			if value == "" {
				return Config{}, fmt.Errorf("%s must not be empty", name)
			}
			*target = value
		}
	}
	if cfg.MLRequestStream == cfg.MLResultStream {
		return Config{}, fmt.Errorf("request and result streams must differ")
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
		"SESSION_TTL":       &cfg.SessionTTL,
		"DATABASE_TIMEOUT":  &cfg.DatabaseTimeout,
		"MIGRATION_TIMEOUT": &cfg.MigrationTimeout,
		"MESSAGE_TIMEOUT":   &cfg.MessageTimeout,
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
