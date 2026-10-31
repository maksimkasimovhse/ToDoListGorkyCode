package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPEmbedder(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/embeddings" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"vectors": [][]float64{{1, 0}, {0.8, 0.6}}})
	}))
	defer server.Close()
	vectors, err := NewHTTPEmbedder(server.URL).Encode(context.Background(), []string{"query", "item"})
	if err != nil || len(vectors) != 2 {
		t.Fatalf("Encode() vectors=%v err=%v", vectors, err)
	}
	if got := cosine(vectors[0], vectors[1]); got < 0.79 || got > 0.81 {
		t.Fatalf("cosine=%v", got)
	}
}

func TestHTTPEmbedderRejectsDimensions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"vectors": [][]float64{{1}, {1, 2}}})
	}))
	defer server.Close()
	if _, err := NewHTTPEmbedder(server.URL).Encode(context.Background(), []string{"a", "b"}); err == nil {
		t.Fatal("expected dimension validation error")
	}
}
