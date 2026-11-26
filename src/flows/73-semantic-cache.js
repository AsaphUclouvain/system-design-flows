flow({
  id: 'semantic-cache',
  title: 'Semantic caching for LLM responses',
  category: 'AI & machine learning',
  tags: ['Embedding similarity', 'Similarity threshold', 'Exact-match first', 'Cache scoping', 'TTL / invalidation', 'False hits'],
  summary: 'Many users ask the same thing in different words. A semantic cache embeds each question, looks for a stored question with a close enough meaning, and returns the saved answer in milliseconds instead of paying for a new LLM call. Follow a hit, a near miss that must not be served, and a miss that fills the cache.',
  requirements: {
    functional: ['Return a stored answer when a new question means the same as an earlier one.'],
    nonFunctional: ['Hits in < 30 ms.', 'Almost no false hits: a wrong cached answer is worse than a slow right one.', 'Never share cached answers across tenants or for personalised prompts.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'user', label: 'User', sub: 'help bot', kind: 'client', icon: 'user', x: 0, y: 1, desc: 'Asks a support question.' },
    { id: 'app', label: 'Bot backend', sub: 'cache layer', kind: 'service', icon: 'server', x: 1, y: 1, desc: 'Tries the exact cache, then the semantic cache, then the LLM.' },
    { id: 'exact', label: 'Exact cache', sub: 'Redis, hash key', kind: 'cache', icon: 'cache', x: 1, y: 0, desc: 'Key = hash of normalised prompt + model + tenant. Cheapest check, zero false hits.' },
    { id: 'emb', label: 'Embedding model', sub: 'small, fast', kind: 'ai', icon: 'vector', x: 2, y: 0, desc: 'Turns the question into a vector so similar meanings land close together.' },
    { id: 'vec', label: 'Semantic cache', sub: 'vector index', kind: 'db', icon: 'vector', x: 3, y: 1, desc: 'Stores (question vector, question, answer, tenant, created_at). Finds the nearest stored question.' },
    { id: 'llm', label: 'LLM', sub: 'slow + paid', kind: 'ai', icon: 'brain', x: 2, y: 2, desc: 'Called only on a miss.' }
  ],
  pseudo: `
key = sha256(tenant + model + normalize(q))
if (a := redis.get(key)): return a                 # exact hit
v = embed(q)
hit = vec.search(v, k=1, filter={"tenant": tenant})
if hit and hit.similarity >= 0.95 and not personal(q):
    return hit.answer                              # semantic hit
a = llm(q)
vec.insert(v, q, a, tenant, ttl=7*86400)
redis.set(key, a, ex=7*86400)
return a`,
  steps: [
    {
      from: 'user', to: 'app', label: '"how can I reset my password?"', pc: ['key = sha256'],
      title: 'A question comes in',
      caption: 'Yesterday someone asked "How do I change my password?". Same meaning, different words, so an exact cache would miss.',
      text: [],
      payloadKind: 'Question',
      payload: { tenant: 'madshop', q: 'how can I reset my password?' }
    },
    {
      from: 'app', to: 'exact', label: 'GET llm:9f1c… → nil', pc: ['redis.get(key)'],
      title: 'Exact cache first',
      caption: 'The cheapest check: a hash of the normalised text. No entry, because nobody typed exactly this.',
      text: [],
      payloadKind: 'Exact lookup',
      payload: { key: 'llm:9f1c…', result: null }
    },
    {
      from: 'app', to: 'emb', label: 'embed(q) → 384-d vector', pc: ['v = embed(q)'],
      title: 'Embed the question',
      caption: 'A small embedding model turns the question into a vector in about 5 ms.',
      text: [],
      payloadKind: 'Vector',
      payload: { dims: 384, v: '[0.021, -0.113, …]' }
    },
    {
      from: 'app', to: 'vec', label: 'nearest within tenant madshop', pc: ['hit = vec.search'],
      title: 'Find the closest stored question',
      caption: 'The index returns the nearest stored question for this tenant only, with its cosine similarity.',
      text: ['GPTCache, an open-source semantic cache, is built from the same parts: an embedding step, a vector store, a similarity evaluator with a threshold, and cache storage with eviction.'],
      payloadKind: 'Nearest',
      payload: { stored_q: 'How do I change my password?', similarity: 0.962, answer_id: 'a_771' },
      branch: { q: 'Similarity ≥ 0.95 and not personal?', options: [ { label: 'yes: serve cached answer', goto: 'hit' }, { label: 'no: call the LLM', goto: 'miss' } ] }
    },
    {
      id: 'hit', from: 'vec', to: 'user', reply: true, label: 'cached answer, 18 ms, €0', pc: ['return hit.answer'],
      title: 'Semantic hit',
      caption: '0.962 is above the threshold. The saved answer is returned in 18 ms with no LLM cost.',
      text: ['The danger is the opposite case: "How do I delete my account?" can score close to "How do I delete my order?". The threshold is tuned on labelled pairs to keep false hits near zero.'],
      payloadKind: 'Response',
      payload: { answer: 'Go to Settings → Security → Reset password…', source: 'semantic_cache', similarity: 0.962, latency_ms: 18 },
      next: 'end'
    },
    {
      id: 'miss', path: 'miss', from: 'app', to: 'llm', label: '"cancel my order 88125" (personal) → LLM', pc: ['a = llm(q)'],
      title: 'Other outcome: a miss',
      caption: 'A question about the user\'s own order is personal: it must never be answered from someone else\'s cache, whatever the similarity. It goes to the LLM.',
      text: [],
      payloadKind: 'LLM call',
      payload: { q: 'cancel my order 88125', personal: true, latency_ms: 1900, cost_eur: 0.004 }
    },
    {
      from: 'llm', to: 'vec', label: 'store non-personal answers with TTL 7 d', pc: ['vec.insert', 'redis.set'],
      title: 'Fill the cache (when allowed)',
      caption: 'General answers are stored in both caches with a 7-day TTL, so a changed policy is not served forever. Personal answers are not stored.',
      text: [],
      payloadKind: 'Insert',
      payload: { stored: false, reason: 'personal', example_stored: { q: 'What are your delivery times?', ttl_days: 7 } }
    },
    {
      id: 'end', from: 'app', to: 'app', label: 'metrics: hit rate 31%', pc: ['return a'],
      title: 'Measure it',
      caption: 'Track hit rate, saved cost and reported wrong answers. If a support article changes, delete cache entries that came from it.',
      text: [],
      payloadKind: 'Daily stats',
      payload: { requests: 42000, exact_hits: 4100, semantic_hits: 8900, hit_rate: 0.31, user_flagged_wrong: 3 }
    }
  ],
  decisions: [
    { q: 'Threshold?', options: [
      { name: 'Low (0.85)', verdict: 'bad', why: 'More hits but serves wrong answers to different questions.' },
      { name: 'High (0.95+) with exact-match first', verdict: 'good', why: 'Fewer hits, near-zero false hits. Tune on real pairs.' } ] },
    { q: 'Semantic cache or provider prompt caching?', options: [
      { name: 'Prompt caching (provider)', verdict: 'good', why: 'Reuses a shared prompt prefix; still runs the model, always correct.' },
      { name: 'Semantic cache (yours)', verdict: 'good', why: 'Skips the model entirely; can be wrong. They solve different problems.' } ] }
  ],
  refs: [
    { label: 'GPTCache on GitHub (semantic cache for LLMs)', url: 'https://github.com/zilliztech/GPTCache' },
    { label: 'Redis docs: Semantic caching with RedisVL', url: 'https://redis.io/docs/latest/develop/ai/redisvl/user_guide/llmcache/' },
    { label: 'Anthropic docs: Prompt caching', url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching' }
  ],
  verify: {
    checked: ['Semantic cache modules (embedding, vector store, similarity evaluator, cache storage, eviction): GPTCache README.'],
    uncertain: ['The 0.95 threshold, TTL, dims and hit rates are illustrative; real thresholds depend on the embedding model.']
  }
});
