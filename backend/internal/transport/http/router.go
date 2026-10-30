// Пакет http реализует HTTP-транспорт приложения.
package http

import (
	"net/http"
	"strings"

	"gorky/backend/internal/service"

	"github.com/go-chi/chi/v5"
)

func NewRouter(messages *service.Messages, items *service.Items, webDir string) http.Handler {
	router := chi.NewRouter()
	router.Get("/healthz", health)
	handler := &Handler{messages: messages, items: items}
	router.Post("/api/message", handler.submit)
	router.Get("/api/messages/{id}", handler.poll)
	router.Post("/api/messages/{id}/answer", handler.answer)
	router.Post("/api/messages/{id}/cancel", handler.cancel)
	router.Get("/api/history", handler.history)
	router.Post("/api/items", handler.createItem)
	router.Get("/api/items", handler.listItems)
	router.Get("/api/items/undated", handler.listItems)
	router.Get("/api/items/search", handler.listItems)
	router.Get("/api/items/{id}", handler.getItem)
	router.Patch("/api/items/{id}", handler.updateItem)
	router.Delete("/api/items/{id}", handler.deleteItem)
	files := http.FileServer(http.Dir(webDir))
	// Неизвестные API-маршруты не должны попадать в обработчик файлов.
	router.Get("/*", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		files.ServeHTTP(w, r)
	})
	return router
}

// health проверяет, что процесс работает; доступность БД и модели не проверяется.
func health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("{\"status\":\"ok\"}\n"))
}
