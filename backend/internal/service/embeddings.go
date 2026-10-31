package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"
)

type Embedder interface {
	Encode(context.Context, []string) ([][]float64, error)
}

type HTTPEmbedder struct {
	url    string
	client *http.Client
}

func NewHTTPEmbedder(url string) *HTTPEmbedder {
	return &HTTPEmbedder{url: strings.TrimRight(url, "/"), client: &http.Client{Timeout: 65 * time.Second}}
}

func (e *HTTPEmbedder) Encode(ctx context.Context, texts []string) ([][]float64, error) {
	payload, err := json.Marshal(map[string]any{"texts": texts, "kind": "search"})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.url+"/v1/embeddings", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := e.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("embeddings returned HTTP %d", response.StatusCode)
	}
	var result struct {
		Vectors [][]float64 `json:"vectors"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 32<<20))
	if err := decoder.Decode(&result); err != nil || len(result.Vectors) != len(texts) {
		return nil, fmt.Errorf("invalid embeddings response")
	}
	dimension := 0
	for _, vector := range result.Vectors {
		if dimension == 0 {
			dimension = len(vector)
		}
		if len(vector) == 0 || len(vector) != dimension {
			return nil, fmt.Errorf("invalid embeddings dimensions")
		}
		for _, value := range vector {
			if math.IsNaN(value) || math.IsInf(value, 0) {
				return nil, fmt.Errorf("invalid embedding value")
			}
		}
	}
	return result.Vectors, nil
}
