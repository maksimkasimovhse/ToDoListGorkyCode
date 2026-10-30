package service

import (
	"context"
	"math"
	"sort"
	"strings"
	"unicode"

	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
)

// Embeddings-2 is normalized by the worker. Cosine similarity is therefore
// stable across request lengths and is the distance metric used for nearest
// neighbours (cosine distance = 1 - cosine similarity).
const (
	semanticThreshold = 0.50
	semanticWeight    = 0.78
	lexicalWeight     = 0.16
	rankWeight        = 0.06
	maxNeighbours     = 99 // plus the query: worker accepts at most 100 texts
)

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

var searchStopWords = map[string]struct{}{
	"и": {}, "в": {}, "во": {}, "на": {}, "по": {}, "с": {}, "со": {}, "за": {}, "к": {}, "ко": {},
	"о": {}, "об": {}, "от": {}, "до": {}, "для": {}, "про": {}, "мой": {}, "моя": {}, "мои": {},
	"мне": {}, "у": {}, "что": {}, "это": {}, "задача": {}, "задачи": {}, "встреча": {}, "встречи": {},
}

func tokens(text string) map[string]struct{} {
	result := map[string]struct{}{}
	for _, token := range strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	}) {
		if len([]rune(token)) < 2 {
			continue
		}
		if _, stop := searchStopWords[token]; !stop {
			result[token] = struct{}{}
		}
	}
	return result
}

// lexicalAffinity adds an explainable signal for named entities and words the
// vector model may smooth over. Title matches count more than source-text-only
// matches: a task title is normally the best identity of a neighbour.
func lexicalAffinity(query map[string]struct{}, item domain.Item) float64 {
	if len(query) == 0 {
		return 0
	}
	all := tokens(itemSearchText(item))
	title := tokens(item.Title)
	var matched, titleMatched int
	for token := range query {
		if _, ok := all[token]; ok {
			matched++
		}
		if _, ok := title[token]; ok {
			titleMatched++
		}
	}
	return 0.70*float64(matched)/float64(len(query)) + 0.30*float64(titleMatched)/float64(len(query))
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
	candidateFilter.Limit = maxNeighbours
	broadCandidates, err := s.repo.List(ctx, user, candidateFilter)
	if err != nil {
		return lexical, false, err
	}
	// Put direct textual matches into the embedding batch first. Otherwise a
	// chronologically limited List can omit the exact task we ought to compare.
	candidates := make([]domain.Item, 0, maxNeighbours)
	seen := make(map[string]struct{}, maxNeighbours)
	for _, group := range [][]domain.Item{lexical, broadCandidates} {
		for _, item := range group {
			if len(candidates) == maxNeighbours {
				break
			}
			if _, exists := seen[item.ID]; exists {
				continue
			}
			seen[item.ID] = struct{}{}
			candidates = append(candidates, item)
		}
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
	queryTokens := tokens(filter.Query)
	type scored struct {
		item  domain.Item
		score float64
	}
	ranked := make([]scored, 0, len(candidates))
	for index, item := range candidates {
		semantic := cosine(vectors[0], vectors[index+1])
		rank, exact := lexicalRank[item.ID]
		affinity := lexicalAffinity(queryTokens, item)
		// A lexical hit is always retained. A semantic-only neighbour needs a
		// meaningful cosine score, or strong token evidence for names/abbreviations.
		if !exact && semantic < semanticThreshold && affinity < 0.60 {
			continue
		}
		score := semanticWeight*semantic + lexicalWeight*affinity
		if exact {
			score += rankWeight / float64(rank)
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
