flow({
  id: 'vector-search',
  title: 'Embeddings and semantic search (HNSW vector index)',
  category: 'AI & machine learning',
  tags: ['Embedding model', 'Cosine similarity', 'Approximate nearest neighbours', 'HNSW layers', 'Metadata filters', 'Recall vs speed'],
  summary: 'How a search for "cozy mystery set in a bakery" finds books that never use those words. Text becomes a vector; similar meanings become nearby vectors; and an HNSW graph index finds the nearest ones among millions without comparing against all of them. Branch on exact brute force versus the approximate index.',
  requirements: {
    functional: ['Search 5 million book descriptions by meaning, not keywords.', 'Filter by language and availability.'],
    nonFunctional: ['p95 under 50 ms.', 'Recall@10 above 0.95 compared with exact search.']
  },
  estimates: [
    { label: 'Vectors', value: '5M × 768 dims', note: 'float32: 5M × 768 × 4 B ≈ 15.4 GB, plus graph links.' },
    { label: 'Brute force', value: '5M dot products / query', note: '≈ 3.8 billion multiply-adds per query.' },
    { label: 'HNSW', value: 'a few thousand distance checks', note: 'Logarithmic scaling, per the HNSW paper.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'user', label: 'Reader', sub: 'search box', kind: 'client', icon: 'user', x: 0, y: 1, desc: 'Types a description of what they feel like reading.' },
    { id: 'api', label: 'Search API', sub: 'FastAPI', kind: 'service', icon: 'api', x: 1, y: 1, desc: 'Embeds the query, calls the vector index with filters, and hydrates results from the catalogue.' },
    { id: 'emb', label: 'Embedding model', sub: 'sentence encoder', kind: 'ai', icon: 'vector', x: 1, y: 0, desc: 'A neural network trained so that texts with similar meaning map to vectors pointing in similar directions.' },
    { id: 'top', label: 'HNSW top layer', sub: 'few nodes, long links', kind: 'cache', icon: 'layers', x: 2, y: 0, desc: 'Only a small random subset of vectors appear here, linked across long distances. Search starts here to cross the space quickly.' },
    { id: 'bottom', label: 'HNSW layer 0', sub: 'all 5M vectors, short links', kind: 'db', icon: 'vector', x: 3, y: 1, desc: 'Every vector, each linked to its closest neighbours. The final, fine-grained search happens here.' },
    { id: 'cat', label: 'Catalogue DB', sub: 'titles, covers, stock', kind: 'db', icon: 'db', x: 2, y: 2, desc: 'The source of truth for book details. The index only stores ids, vectors and filterable metadata.' }
  ],
  pseudo: `
qv = normalize(embed("cozy mystery set in a bakery"))   # 768 floats, length 1

def brute_force(qv, k):
    return top_k(all_vectors, key=lambda v: dot(qv, v))  # exact, O(N)

def hnsw_search(qv, k, ef=64):
    node = entry_point                                   # top layer
    for layer in range(max_layer, 0, -1):
        node = greedy_closest(node, qv, layer)           # long hops
    cands = beam_search(node, qv, layer=0, width=ef)     # short hops
    return [c for c in cands if passes_filter(c)][:k]

results = catalogue.hydrate(hnsw_search(qv, k=10))`,
  steps: [
    {
      from: 'user', to: 'api', label: 'q="cozy mystery set in a bakery"', pc: ['qv = normalize'],
      title: 'A search by meaning',
      caption: 'The reader wants something like a cozy bakery mystery. The best match in the catalogue is described as "an amateur sleuth who runs a pastry shop": no shared keywords.',
      text: ['Keyword search (BM25) would miss it. Semantic search compares meanings instead, by comparing vectors.'],
      payloadKind: 'Request',
      payload: { q: 'cozy mystery set in a bakery', filters: { language: 'en', in_stock: true }, k: 10 }
    },
    {
      from: 'api', to: 'emb', label: 'embed(q) → 768 floats', pc: ['embed(', 'normalize'],
      title: 'Turn the query into a vector',
      caption: 'The same model that embedded every book description embeds the query. The vector is normalised to length 1, so the dot product equals cosine similarity.',
      text: ['Queries and documents must use the same model and version: vectors from two different models live in unrelated spaces. Re-embedding the whole corpus is the cost of changing models.'],
      payloadKind: 'Embedding',
      payload: { model: 'all-mpnet-base-v2 (example)', dims: 768, vector_head: [0.031, -0.112, 0.067, 0.004, '…'], norm: 1.0 },
      fields: { norm: 'Length 1. Then cosine similarity = dot product, which indexes compute fastest.' },
      branch: { q: 'How is the nearest-neighbour search done?', options: [ { label: 'HNSW (approximate)', goto: 'hnsw' }, { label: 'brute force (exact)', goto: 'bf' } ] }
    },
    {
      id: 'bf', path: 'brute force', from: 'api', to: 'bottom', label: 'dot(q, v) for all 5M vectors', pc: ['def brute_force', 'top_k(all_vectors'],
      title: 'Exact search: compare with everything',
      caption: 'Compute the similarity with all 5 million vectors and keep the 10 best. Always correct, but about 3.8 billion multiply-adds per query: hundreds of milliseconds on CPU.',
      text: ['Fine for thousands of vectors, or offline on GPUs (Faiss provides exact and approximate indexes). For live search at millions of vectors, an approximate index is used, and exact search becomes the ground truth to measure its recall.'],
      payloadKind: 'Exact top 3',
      payload: { compared: 5000000, ms: 420, top: [{ id: 'bk_88123', title: 'Death by Croissant', cos: 0.71 }, { id: 'bk_10422', title: 'The Sourdough Alibi', cos: 0.69 }, { id: 'bk_55190', title: 'Murder at the Pastry Shop', cos: 0.68 }] },
      next: 'hydr'
    },
    {
      id: 'hnsw', path: 'HNSW', from: 'api', to: 'top', label: 'enter at top layer', pc: ['def hnsw_search', 'node = entry_point'],
      title: 'HNSW: start at the sparse top layer',
      caption: 'The index is a stack of graphs. Each vector was placed on a random number of layers, with exponentially fewer vectors on higher layers. Search enters at the top, where a few nodes have long links.',
      text: ['The HNSW paper (Malkov and Yashunin): the maximum layer of each element is chosen randomly with an exponentially decaying probability; starting from the upper layer gives logarithmic complexity scaling. Pinecone compares it to a skip list.'],
      payloadKind: 'Index structure',
      payload: { layers: { '3': '~80 nodes', '2': '~5k nodes', '1': '~300k nodes', '0': '5M nodes' }, M: 16, entry_point: 'bk_00017' },
      fields: { M: 'Links per node. More links: better recall, more memory and slower inserts.' }
    },
    {
      path: 'HNSW', from: 'top', to: 'bottom', label: 'greedy hops down layers 3 → 1', pc: ['for layer in range', 'greedy_closest'],
      title: 'Greedy hops, one layer at a time',
      caption: 'On each layer, the search keeps moving to whichever neighbour is closer to the query, until no neighbour is closer. Then it drops one layer and continues from the same node.',
      text: ['Long links on top cross the space in a few hops (from "space opera" to "crime fiction"); shorter links lower down narrow it to "cozy mysteries".'],
      payloadKind: 'Search trace',
      payload: { layer3: ['bk_00017 (0.12)', 'bk_31002 (0.33)'], layer2: ['bk_31002', 'bk_40981 (0.52)'], layer1: ['bk_40981', 'bk_10422 (0.69)'], distance_checks_so_far: 210 }
    },
    {
      path: 'HNSW', from: 'bottom', to: 'api', reply: true, label: 'beam search ef=64 → top 10 (filtered)', pc: ['beam_search', 'passes_filter'],
      title: 'Fine search on layer 0, then filters',
      caption: 'On the bottom layer it explores a wider beam of 64 candidates around the landing point, keeps the closest, and drops those that fail the filters (out of stock, wrong language).',
      text: ['ef is the speed/recall dial: larger beams find more true neighbours but check more vectors. Heavy filtering is a known weakness: if most neighbours are filtered out, results run short, so vector databases offer filtered-graph traversal or pre-filtering.'],
      payloadKind: 'Results',
      payload: { distance_checks: 2930, ms: 6, top: [{ id: 'bk_88123', cos: 0.71 }, { id: 'bk_10422', cos: 0.69 }, { id: 'bk_55190', cos: 0.68 }], recall_at_10_vs_exact: 0.97 }
    },
    {
      id: 'hydr', from: 'api', to: 'cat', label: 'SELECT … WHERE id IN (10 ids)', pc: ['catalogue.hydrate'],
      title: 'Hydrate results from the catalogue',
      caption: 'The index returns ids and scores. The API loads titles, covers and prices from the catalogue and returns the list.',
      text: ['Keeping the index lean (ids, vectors, a few filter fields) keeps it in memory. The same retrieval step is the core of RAG and of candidate generation in recommendation systems.'],
      payloadKind: 'Response',
      payload: { results: [{ title: 'Death by Croissant', author: 'M. Laurent', score: 0.71 }, { title: 'The Sourdough Alibi', author: 'K. Abara', score: 0.69 }], total_ms: 19 }
    }
  ],
  decisions: [
    { q: 'Which index?', options: [
      { name: 'HNSW', verdict: 'great', why: 'High recall and low latency; the default in most vector databases. Memory-hungry (vectors + links in RAM).' },
      { name: 'IVF + product quantization', verdict: 'good', why: 'Compresses vectors heavily for billions of items; lower recall per byte of memory. Common in Faiss.' },
      { name: 'Brute force', verdict: 'good', why: 'Exact. Fine below ~100k vectors or on GPU batches.' } ] }
  ],
  refs: [
    { label: 'Malkov & Yashunin: Efficient and robust approximate nearest neighbor search using HNSW graphs', url: 'https://arxiv.org/abs/1603.09320' },
    { label: 'Pinecone: Hierarchical Navigable Small Worlds (HNSW) explained', url: 'https://www.pinecone.io/learn/series/faiss/hnsw/' },
    { label: 'Faiss (Meta): library for similarity search of dense vectors', url: 'https://github.com/facebookresearch/faiss' },
    { label: 'ByteByteGo newsletter: MCP vs RAG vs AI agents (where vector search sits)', url: 'https://blog.bytebytego.com/p/ep224-mcp-vs-rag-vs-ai-agents' }
  ],
  verify: {
    checked: ['Random max layer with exponentially decaying probability, search from the upper layer, logarithmic scaling: HNSW paper abstract.', 'Greedy routing, degree vs recall trade-off: Pinecone article. Faiss scope: its README.'],
    uncertain: ['Layer sizes, distance-check counts and timings are illustrative orders of magnitude, not benchmarks.', 'The embedding model name is an example.']
  }
});
