flow({
  id: 'llm-search-ranking',
  title: 'LLM-powered search ranking (retrieve, rerank, answer)',
  category: 'AI & machine learning',
  tags: ['Query understanding', 'Hybrid retrieval (BM25 + vectors)', 'Cross-encoder rerank', 'LLM listwise rerank', 'Distillation to small ranker', 'Generated answer with citations'],
  summary: 'Modern search keeps the classic cheap first stage (find 1 000 candidates fast) and adds expensive learned stages on fewer and fewer results: a cross-encoder scores the top 100, an LLM can reorder the top 20 by reading them together, and an answer is written from the best few with citations. Because LLM ranking is slow, it is often distilled into a small model for production. Follow one query down the funnel.',
  requirements: {
    functional: ['Return the most relevant documents for a query.', 'Optionally write a short answer with citations.'],
    nonFunctional: ['Total latency within a few hundred milliseconds for the ranking part.', 'Cost per query bounded: expensive models only see a few candidates.']
  },
  grid: { cols: 5, rows: 3 },
  nodes: [
    { id: 'user', label: 'Searcher', sub: 'query', kind: 'client', icon: 'search', x: 0, y: 1, desc: 'Types "why does my manga reader not scroll".' },
    { id: 'qu', label: 'Query understanding', sub: 'rewrite + embed', kind: 'service', icon: 'brain', x: 1, y: 1, desc: 'Spelling fix, synonyms, and a query embedding for vector search.' },
    { id: 'bm25', label: 'Keyword index', sub: 'BM25', kind: 'db', icon: 'search', x: 2, y: 0, desc: 'Inverted index; great at exact terms and rare words.' },
    { id: 'ann', label: 'Vector index', sub: 'ANN (HNSW)', kind: 'db', icon: 'vector', x: 2, y: 2, desc: 'Finds semantically similar documents even without shared words.' },
    { id: 'ce', label: 'Cross-encoder', sub: 'reranker, top 100', kind: 'ai', icon: 'filter', x: 3, y: 1, desc: 'Reads query and document together and outputs a relevance score. Much more accurate than the first stage, much slower.' },
    { id: 'llm', label: 'LLM ranker', sub: 'listwise, top 20', kind: 'ai', icon: 'robot', x: 3, y: 0, desc: 'Reads several candidates at once and outputs an ordering (e.g. [3] > [1] > [7]).' },
    { id: 'ans', label: 'Answer writer', sub: 'LLM + citations', kind: 'ai', icon: 'spark', x: 4, y: 1, desc: 'Writes a short answer from the top 5 and cites them.' }
  ],
  pseudo: `
q = rewrite(query); qv = embed(q)
cands = rrf(bm25.search(q, 500), ann.search(qv, 500))        # ~1000 -> fused
top100 = sorted(cands[:100], key=lambda d: cross_encoder(q, d), reverse=True)
# listwise LLM rerank with a sliding window, back to front
for window in sliding(top100[:20], size=8, step=4, reverse=True):
    window.reorder(llm_rank(q, window))   # "[3] > [1] > [7] ..."
answer = llm_answer(q, top5, cite=True)
offline: distill(llm_rank -> small_ranker)  # serve the small one at scale`,
  steps: [
    {
      from: 'user', to: 'qu', label: '"why does my manga reader not scroll"', pc: ['q = rewrite(query)'],
      title: 'Understand the query',
      caption: 'The query is normalised and expanded ("scroll" → "scrolling, wheel, overflow") and turned into an embedding.',
      text: [],
      payloadKind: 'Query',
      payload: { raw: 'why does my manga reader not scroll', rewritten: 'manga reader page not scrolling wheel overflow', embedding_dims: 1024 }
    },
    {
      from: 'qu', to: 'bm25', label: 'BM25 top 500', pc: ['bm25.search'],
      title: 'Cheap first stage: keywords',
      caption: 'BM25 finds documents containing the words, ranked by term frequency and rarity. Milliseconds over millions of documents.',
      text: [],
      payloadKind: 'Candidates',
      payload: { engine: 'BM25', returned: 500, top: ['css overflow hidden blocks scroll', 'react scroll container height…'] }
    },
    {
      from: 'qu', to: 'ann', label: 'vector top 500 → fuse with RRF', pc: ['ann.search', 'rrf('],
      title: 'Cheap first stage: meaning',
      caption: 'Vector search adds results that share meaning without sharing words. The two lists are merged with reciprocal rank fusion.',
      text: [],
      payloadKind: 'Fused list',
      payload: { bm25: 500, vector: 500, overlap: 180, fused: 820, kept_for_rerank: 100 }
    },
    {
      from: 'ann', to: 'ce', label: 'score 100 (query, doc) pairs', pc: ['top100 = sorted'],
      title: 'Rerank the top 100 with a cross-encoder',
      caption: 'A cross-encoder reads the query and each document together, which catches things like negation and exact intent. Doing this for 100 documents is affordable; for a million it would not be.',
      text: [],
      payloadKind: 'Scores',
      payload: [{ doc: 'd_4410 "Scroll stops after removing vertical mode"', score: 0.93 }, { doc: 'd_1187 "overflow: hidden on body"', score: 0.88 }, { doc: 'd_9020 "Manga reader app review"', score: 0.12 }]
    },
    {
      from: 'ce', to: 'llm', label: 'top 20, windows of 8, step 4', pc: ['for window in sliding', 'window.reorder'],
      title: 'Optional: LLM listwise rerank of the top 20',
      caption: 'The LLM sees a numbered window of candidates and outputs a permutation. Windows slide from the bottom of the list to the top so good documents can bubble up. RankGPT showed this beats supervised rerankers on standard benchmarks.',
      text: ['The RankGPT paper reranked BM25\'s top 100 with a window of 20 and a step of 10; the sizes here are smaller for the example.'],
      payloadKind: 'LLM output',
      payload: { prompt_end: 'Rank the 8 passages by relevance to the query. Output: [a] > [b] > …', output: '[2] > [1] > [5] > [3] > [8] > [4] > [7] > [6]' },
      branch: { q: 'Is the LLM step affordable at this traffic?', options: [ { label: 'yes: keep it for hard queries', goto: 'answer' }, { label: 'no: distil it', goto: 'distil' } ] }
    },
    {
      id: 'distil', path: 'distil', from: 'llm', to: 'ce', label: 'LLM orderings → train small ranker', pc: ['offline: distill'],
      title: 'Other outcome: distil the LLM into a small ranker',
      caption: 'Offline, the LLM ranks many queries; a small model is trained to reproduce those orderings and is served instead. RankGPT reports a distilled 440M-parameter model beating a 3B supervised model.',
      text: [],
      payloadKind: 'Distillation',
      payload: { teacher: 'LLM listwise ranker', student: 'cross-encoder 440M', training_queries: 10000, served: 'student' }
    },
    {
      id: 'answer', from: 'llm', to: 'ans', label: 'top 5 → answer with [1][2]', pc: ['answer = llm_answer'],
      title: 'Write an answer from the best results',
      caption: 'For queries that deserve it, an LLM writes a short answer grounded only in the top 5 documents, each claim with a citation the user can click.',
      text: [],
      payloadKind: 'Answer',
      payload: { answer: 'If you removed the vertical reading mode, the reader may show one fitted page with nothing to scroll [1]. Also check that the body does not have overflow: hidden [2].', citations: ['d_4410', 'd_1187'] }
    },
    {
      from: 'ans', to: 'user', label: 'answer + 10 ranked links', pc: ['answer = llm_answer'],
      title: 'Results page',
      caption: 'The funnel: ~1 000 candidates → 100 reranked → 20 reordered → 5 used for the answer → 10 shown.',
      text: [],
      payloadKind: 'Response',
      payload: { answer: true, results: 10, latency_ms: { retrieval: 25, cross_encoder: 60, llm_rank: 400, answer_stream_first_token: 350 } }
    }
  ],
  decisions: [
    { q: 'Where to spend the expensive model?', options: [
      { name: 'Only on the top of a funnel', verdict: 'good', why: 'Cost and latency grow with candidates; quality is decided at the top.' },
      { name: 'LLM over the whole index', verdict: 'bad', why: 'Impossible cost and latency.' } ] }
  ],
  refs: [
    { label: 'Sun et al., Is ChatGPT Good at Search? LLMs as Re-Ranking Agents (RankGPT, arXiv 2304.09542)', url: 'https://arxiv.org/abs/2304.09542' },
    { label: 'Nogueira & Cho, Passage Re-ranking with BERT (arXiv 1901.04085)', url: 'https://arxiv.org/abs/1901.04085' },
    { label: 'Cormack et al., Reciprocal Rank Fusion (SIGIR 2009, PDF)', url: 'https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf' },
    { label: 'Cohere docs: Rerank overview', url: 'https://docs.cohere.com/docs/rerank-overview' }
  ],
  verify: {
    checked: ['Listwise permutation generation with sliding windows (window 20, step 10 in their experiments) over BM25 top 100, and a distilled 440M model outperforming a 3B supervised model: RankGPT paper.', 'Cross-encoder reranking of BM25 candidates: Nogueira & Cho.', 'Reciprocal rank fusion: Cormack et al.'],
    uncertain: ['Candidate counts, scores, latencies and window sizes in the example are illustrative.']
  }
});
