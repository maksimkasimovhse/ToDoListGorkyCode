package service

import (
	"context"
	"math"
	"sort"
	"strings"

	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
)

const semanticThreshold = 0.50

func itemSearchText(item domain.Item) string {
	parts := []string{item.Title, item.SourceText, strings.Join(item.Participants, " ")}
	if item.Location != nil {
		parts = append(parts, *item.Location)
	}
	return strings.Join(parts, " | ")
}

func cosine(left, right []float64) float64 {
	if len(left) == 0 || len(left) != len(right) {
		return -1
	}
	var dot, a, b float64
	for index := range left {
		dot += left[index] * right[index]
		a += left[index] * left[index]
		b += right[index] * right[index]
	}
	if a == 0 || b == 0 {
		return -1
	}
	return dot / math.Sqrt(a*b)
}

// Search combines the existing lexical search with semantic similarity. If the
// embedding service is unavailable, callers still get the lexical result.
func (s *Items) Search(ctx context.Context, user string, filter repository.ItemFilter) ([]domain.Item, bool, error) {
	lexicalFilter := filter
	lexicalFilter.Limit = 100
	lexical, err := s.repo.Search(ctx, user, lexicalFilter)
	if err != nil || s.embedder == nil {
		return lexical, false, err
	}
	candidateFilter := filter
	candidateFilter.Query = ""
	// Вместе с запросом это не больше 100 строк за один вызов API.
	candidateFilter.Limit = 99
	candidates, err := s.repo.List(ctx, user, candidateFilter)
	if err != nil {
		return lexical, false, err
	}
	if len(candidates) == 0 {
		return lexical, false, nil
	}
	texts := make([]string, 1, len(candidates)+1)
	texts[0] = filter.Query
	for _, item := range candidates {
		texts = append(texts, itemSearchText(item))
	}
	vectors, err := s.embedder.Encode(ctx, texts)
	if err != nil {
		return lexical, false, nil
	}
	lexicalRank := make(map[string]int, len(lexical))
	for index, item := range lexical {
		lexicalRank[item.ID] = index + 1
	}
	type scored struct {
		item  domain.Item
		score float64
	}
	ranked := make([]scored, 0, len(candidates))
	for index, item := range candidates {
		score := cosine(vectors[0], vectors[index+1])
		rank, exact := lexicalRank[item.ID]
		if !exact && score < semanticThreshold {
			continue
		}
		if exact {
			score += 0.25 / float64(rank)
		}
		ranked = append(ranked, scored{item: item, score: score})
	}
	sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].score > ranked[j].score })
	limit := filter.Limit
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	if len(ranked) > limit {
		ranked = ranked[:limit]
	}
	items := make([]domain.Item, len(ranked))
	for index := range ranked {
		items[index] = ranked[index].item
	}
	return items, true, nil
}
