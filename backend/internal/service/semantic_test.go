package service

import (
	"strings"
	"testing"

	"gorky/backend/internal/domain"
)

func TestSemanticTypeAndTitleSignals(t *testing.T) {
	if kind := requestedType("найди задачу про презентацию"); kind == nil || *kind != domain.ItemTask {
		t.Fatalf("unexpected requested type: %v", kind)
	}
	if kind := requestedType("найди встречу с дизайнером"); kind == nil || *kind != domain.ItemMeeting {
		t.Fatalf("unexpected requested type: %v", kind)
	}
	text := itemSearchText(domain.Item{Type: domain.ItemTask, Title: "Подготовить слайды", SourceText: "поставь задачу"})
	if strings.Count(text, "Подготовить слайды") != 2 || !strings.Contains(text, "Тип: задача") {
		t.Fatalf("unexpected embedding text: %q", text)
	}
}
