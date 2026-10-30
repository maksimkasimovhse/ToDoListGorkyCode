// Пакет http реализует HTTP-транспорт приложения.
package http

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

func NewRouter() http.Handler {
	router := chi.NewRouter()
	router.Get("/healthz", health)
	return router
}

// health проверяет, что процесс работает; доступность БД и модели не проверяется.
func health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("{\"status\":\"ok\"}\n"))
}
