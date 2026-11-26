flow({
  id: 'graphrag',
  title: 'GraphRAG: knowledge graph + community summaries for global questions',
  category: 'AI & machine learning',
  tags: ['Entity + relation extraction', 'Knowledge graph', 'Community detection (Leiden)', 'Community summaries', 'Global vs local search', 'Map-reduce answering'],
  summary: 'Plain RAG retrieves a few chunks, which fails for questions about a whole collection, such as "what are the main themes in these 800 support tickets?". GraphRAG builds a knowledge graph from the documents with an LLM, groups it into communities, pre-writes a summary for each, and answers global questions by map-reducing over those summaries. Follow indexing, then a global and a local query.',
  requirements: {
    functional: ['Answer questions about the whole corpus (themes, trends) and about specific entities.', 'Cite which documents support each claim.'],
    nonFunctional: ['Indexing is a one-time LLM cost per corpus update, paid offline.', 'Query time stays in seconds.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'docs', label: 'Corpus', sub: '800 tickets', kind: 'storage', icon: 'doc', x: 0, y: 0, desc: 'Source documents, chunked into text units.' },
    { id: 'ex', label: 'Extraction LLM', sub: 'indexing', kind: 'ai', icon: 'brain', x: 1, y: 0, desc: 'Reads each chunk and outputs entities (people, products, issues) and relationships with short descriptions.' },
    { id: 'kg', label: 'Knowledge graph', sub: 'nodes + edges', kind: 'db', icon: 'tree', x: 2, y: 0, desc: 'Merged entities and relationships across all chunks, each linked back to its source chunks.' },
    { id: 'comm', label: 'Communities', sub: 'Leiden, hierarchical', kind: 'worker', icon: 'layers', x: 3, y: 1, desc: 'Clusters of densely connected entities at several levels; each gets an LLM-written summary report.' },
    { id: 'q', label: 'Query engine', sub: 'global / local', kind: 'service', icon: 'search', x: 1, y: 2, desc: 'Global search map-reduces over community summaries; local search starts from matching entities and their neighbours.' },
    { id: 'user', label: 'Analyst', sub: 'asks questions', kind: 'client', icon: 'user', x: 0, y: 2, desc: 'Asks broad and specific questions.' }
  ],
  pseudo: `
# indexing (offline)
for chunk in chunks(corpus, 600):
    ents, rels = llm.extract(chunk)            # with source ids
    graph.merge(ents, rels)
levels = leiden(graph, hierarchical=True)
for c in levels.all(): c.report = llm.summarize(c.entities, c.relations)
# global query
partials = [llm(q, c.report) for c in levels[1]]      # map
answer = llm.reduce(q, top(partials, by="helpfulness"))
# local query
seeds = graph.match(q); ctx = seeds + neighbors(seeds) + source_chunks(seeds)`,
  steps: [
    {
      from: 'docs', to: 'ex', label: 'chunk 0412 → extract entities + relations', pc: ['for chunk in chunks', 'llm.extract(chunk)'],
      title: 'Indexing: extract a graph with an LLM',
      caption: 'Each chunk is read by an LLM that lists entities and how they relate, with short descriptions. This is the expensive part: one or more LLM calls per chunk.',
      text: ['Edge et al. (2024) describe two stages: derive an entity knowledge graph from the documents, then pregenerate community summaries for groups of closely related entities.'],
      payloadKind: 'Extraction',
      payload: { chunk: '0412', entities: [{ name: 'MadGate reader', type: 'product' }, { name: 'scroll bug', type: 'issue' }, { name: 'iOS Safari', type: 'platform' }], relations: [{ src: 'scroll bug', dst: 'iOS Safari', desc: 'only reproduces on' }] }
    },
    {
      from: 'ex', to: 'kg', label: 'merge: "scroll bug" now in 37 tickets', pc: ['graph.merge'],
      title: 'Merge into one graph',
      caption: 'The same entity found in many chunks is merged; its descriptions are combined and every edge keeps links to its source chunks for citations.',
      text: [],
      payloadKind: 'Graph',
      payload: { nodes: 2140, edges: 6890, example: { node: 'scroll bug', mentions: 37, sources: ['t_12', 't_88', '…'] } }
    },
    {
      from: 'kg', to: 'comm', label: 'Leiden → 3 levels, 64 communities at level 1', pc: ['levels = leiden', 'c.report = llm.summarize'],
      title: 'Cluster and summarise communities',
      caption: 'A community-detection algorithm groups tightly linked entities; an LLM writes a report for each group: title, key entities, main claims with sources.',
      text: [],
      payloadKind: 'Community report',
      payload: { id: 'C1-07', title: 'Mobile reader scrolling failures', entities: ['scroll bug', 'iOS Safari', 'reader'], summary: 'A cluster of 37 tickets after the Nov 25 release…', rating: 8.5 }
    },
    {
      from: 'user', to: 'q', label: '"What are the main complaint themes?"', pc: ['# global query'],
      title: 'A global question',
      caption: 'No single chunk answers this. Retrieving the top 5 chunks would just return 5 random complaints.',
      text: [],
      payloadKind: 'Query',
      payload: { q: 'What are the main complaint themes this month?', mode: 'global', level: 1 },
      branch: { q: 'Global or specific question?', options: [ { label: 'global: map-reduce summaries', goto: 'map' }, { label: 'specific entity: local search', goto: 'local' } ] }
    },
    {
      id: 'map', from: 'q', to: 'comm', label: 'map: answer from each of 64 reports', pc: ['partials = [llm(q, c.report)'],
      title: 'Map over community summaries',
      caption: 'Each community report produces a partial answer with a helpfulness score, in parallel. Irrelevant communities score 0 and are dropped.',
      text: ['The paper reports substantial improvements in comprehensiveness and diversity over conventional RAG for global sensemaking questions over ~1 million token datasets.'],
      payloadKind: 'Partials',
      payload: [{ community: 'C1-07', partial: 'Mobile scrolling broke after a release', score: 92 }, { community: 'C1-21', partial: 'Slow first load of the manga list', score: 81 }, { community: 'C1-40', score: 0 }]
    },
    {
      from: 'comm', to: 'user', reply: true, label: 'reduce → 3 themes with ticket citations', pc: ['answer = llm.reduce'],
      title: 'Reduce into one answer',
      caption: 'The best partial answers are combined into a final summary, each theme citing the communities and tickets behind it.',
      text: [],
      payloadKind: 'Answer',
      payload: { themes: [{ theme: 'Mobile scrolling broke after Nov 25 release', tickets: 37 }, { theme: 'Slow first load of the manga list', tickets: 22 }, { theme: 'Wish for downloads', tickets: 15 }] },
      next: 'end'
    },
    {
      id: 'local', path: 'local search', from: 'q', to: 'kg', label: '"Which platforms have the scroll bug?" → entity + neighbours', pc: ['seeds = graph.match(q)'],
      title: 'Other outcome: a local question',
      caption: 'For a specific entity, the engine finds it in the graph and gathers its neighbours, relations and source chunks as context: precise and cheap.',
      text: [],
      payloadKind: 'Local context',
      payload: { seed: 'scroll bug', neighbors: ['iOS Safari', 'reader v2.3'], source_chunks: 6, answer: 'Only iOS Safari 17+ (6 tickets)' },
      next: 'end'
    },
    {
      id: 'end', from: 'q', to: 'q', label: 'cost: index once, query cheap', pc: ['# indexing (offline)'],
      title: 'The trade-off',
      caption: 'Indexing used thousands of LLM calls; queries reuse the precomputed reports. When documents change, the graph and affected reports must be updated.',
      text: [],
      payloadKind: 'Cost',
      payload: { indexing_llm_calls: 3900, global_query_calls: 65, local_query_calls: 1 }
    }
  ],
  decisions: [
    { q: 'Vector RAG or GraphRAG?', options: [
      { name: 'Vector RAG', verdict: 'good', why: 'Cheap, fresh; best for "find the passage that answers X".' },
      { name: 'GraphRAG', verdict: 'good', why: 'For whole-corpus questions and multi-hop relations; high indexing cost.' } ] }
  ],
  refs: [
    { label: 'Edge et al. (2024): From local to global, a GraphRAG approach', url: 'https://arxiv.org/abs/2404.16130' },
    { label: 'Microsoft GraphRAG documentation', url: 'https://microsoft.github.io/graphrag/' },
    { label: 'Microsoft GraphRAG on GitHub', url: 'https://github.com/microsoft/graphrag' }
  ],
  verify: {
    checked: ['Entity graph from documents, pregenerated community summaries, partial responses combined, improvement in comprehensiveness and diversity at ~1M token scale: Edge et al. abstract.', 'Global and local search, Leiden communities: Microsoft GraphRAG docs (read).'],
    uncertain: ['Tickets, counts and call totals are illustrative.']
  }
});
