// Пакет http реализует HTTP-транспорт приложения.
package http

import (
	"net/http"
	"strings"

	"gorky/backend/internal/service"

	"github.com/go-chi/chi/v5"
)

// channels необязателен: без него маршруты уведомлений и ботов не подключаются.
func NewRouter(messages *service.Messages, items *service.Items, auth *service.Auth, webDir string, channels ...Channels) http.Handler {
	router := chi.NewRouter()
	router.Get("/healthz", health)
	handler := &Handler{messages: messages, items: items, auth: auth}
	router.Post("/api/auth/login", handler.login)
	router.Group(func(protected chi.Router) {
		protected.Use(handler.requireAuth)
		protected.Post("/api/auth/logout", handler.logout)
		protected.Get("/api/me", handler.me)
		protected.Post("/api/session/reset", handler.resetSession)
		protected.Post("/api/undo", handler.undo)
		protected.Post("/api/message", handler.submit)
		protected.Get("/api/messages/{id}", handler.poll)
		protected.Post("/api/messages/{id}/answer", handler.answer)
		protected.Post("/api/messages/{id}/cancel", handler.cancel)
		protected.Get("/api/history", handler.history)
		protected.Post("/api/items", handler.createItem)
		protected.Get("/api/items", handler.listItems)
		protected.Get("/api/items/undated", handler.listItems)
		protected.Get("/api/items/search", handler.listItems)
		protected.Get("/api/items/{id}", handler.getItem)
		protected.Patch("/api/items/{id}", handler.updateItem)
		protected.Delete("/api/items/{id}", handler.deleteItem)
	})
	if len(channels) > 0 && channels[0].Service != nil {
		(&channelHandler{Channels: channels[0]}).mount(router, handler.requireAuth)
	}
	files := http.FileServer(http.Dir(webDir))
	// Неизвестные API-маршруты не должны попадать в обработчик файлов.
	router.Get("/*", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/internal/") {
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
