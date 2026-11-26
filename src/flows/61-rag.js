flow({
  id: 'rag',
  title: 'Retrieval-augmented generation (RAG): ingestion to grounded answer',
  category: 'AI & machine learning',
  tags: ['Chunking', 'Embeddings', 'Vector DB', 'Hybrid search (BM25 + vectors)', 'Reranking', 'Grounded generation + citations'],
  summary: 'An LLM does not know your private documents. RAG fixes that in two phases. Offline: split documents into chunks, embed them, and index them. Online: embed the question, retrieve candidate chunks with vector and keyword search, rerank them, and put the best few in the prompt so the model answers from them, with citations.',
  requirements: {
    functional: ['Answer employee questions from 40,000 internal docs (HR policies, runbooks, wikis).', 'Cite the passages each answer is based on.', 'New or edited docs searchable within minutes.'],
    nonFunctional: ['Answers grounded in retrieved text, not the model\'s memory.', 'Under 3 s to first token.', 'Respect document permissions.']
  },
  estimates: [
    { label: 'Corpus', value: '40k docs → ~1.2M chunks', note: 'At ~300 tokens per chunk with overlap.' },
    { label: 'Index size', value: '≈ 7.4 GB', note: '1.2M × 1536 dims × 4 bytes (float32), before any compression.' },
    { label: 'Per query', value: '1 embed + 2 searches + 1 rerank + 1 LLM call', note: 'The LLM call dominates latency and cost.' }
  ],
  grid: { cols: 5, rows: 3 },
  nodes: [
    { id: 'docs', label: 'Document sources', sub: 'Confluence, Drive, PDFs', kind: 'storage', icon: 'doc', x: 0, y: 0, desc: 'Where the knowledge lives. Connectors pull new and changed documents with their permissions.' },
    { id: 'ingest', label: 'Ingestion worker', sub: 'parse → chunk', kind: 'worker', icon: 'gear', x: 1, y: 0, desc: 'Extracts text, cleans it, splits it into chunks, and attaches metadata (title, URL, section, ACL).' },
    { id: 'embed', label: 'Embedding model', sub: 'text → 1536-d vector', kind: 'ai', icon: 'vector', x: 2, y: 0, desc: 'Turns text into a vector so that texts with similar meaning are close together. Used for chunks offline and for questions online.' },
    { id: 'vdb', label: 'Vector + keyword index', sub: 'HNSW + BM25', kind: 'db', icon: 'db', x: 3, y: 0, desc: 'Stores each chunk\'s vector (approximate nearest-neighbour index) and its words (BM25 inverted index), plus metadata filters.' },
    { id: 'user', label: 'Employee', sub: 'chat UI', kind: 'client', icon: 'user', x: 0, y: 2, desc: 'Asks a question in natural language.' },
    { id: 'app', label: 'RAG service', sub: 'orchestrator', kind: 'service', icon: 'server', x: 1, y: 2, desc: 'Runs the online steps: embed, retrieve, rerank, build the prompt, call the LLM, attach citations.' },
    { id: 'rerank', label: 'Reranker', sub: 'cross-encoder', kind: 'ai', icon: 'filter', x: 3, y: 2, desc: 'Scores each (question, chunk) pair together. Slower but much more accurate than vector similarity, so it runs only on the top candidates.' },
    { id: 'llm', label: 'LLM', sub: 'generator', kind: 'ai', icon: 'brain', x: 4, y: 1, desc: 'Writes the answer using only the supplied passages and cites them.' }
  ],
  pseudo: `
# offline: ingestion
for doc in connector.changed_since(last_sync):
    text = parse(doc)                                # PDF/HTML -> text
    for i, chunk in enumerate(split(text, size=300, overlap=50)):
        ctx = llm.summarize_position(doc, chunk)     # optional contextual prefix
        vec = embed(ctx + chunk)
        index.upsert(id=f"{doc.id}#{i}", vector=vec, text=chunk,
                     meta={"url": doc.url, "acl": doc.acl})

# online: answer a question
def answer(q, user):
    qv = embed(q)
    dense = index.vector_search(qv, k=50, filter={"acl": user.groups})
    sparse = index.bm25_search(q, k=50, filter={"acl": user.groups})
    cands = reciprocal_rank_fusion(dense, sparse)[:50]
    top = reranker.rank(q, cands)[:5]
    prompt = SYSTEM + format_sources(top) + q
    return llm.generate(prompt, stream=True), cite(top)`,
  steps: [
    {
      from: 'docs', to: 'ingest', label: 'changed: "Parental leave policy v7.pdf"', pc: ['for doc in connector', 'text = parse'],
      title: 'Offline: a changed document is pulled in',
      caption: 'HR updates the parental leave policy. The connector notices the change and hands the PDF and its permissions to the ingestion worker, which extracts clean text.',
      text: ['Ingestion runs continuously or on a schedule. Keeping permissions (ACLs) with every chunk is what later stops the assistant from quoting a document the user cannot open.'],
      payloadKind: 'Document',
      payload: { id: 'hr-0193', title: 'Parental leave policy v7', url: 'https://wiki.acme.internal/hr/parental-leave', acl: ['all-employees-be'], pages: 6, updated: '2026-11-20' }
    },
    {
      from: 'ingest', to: 'ingest', label: 'split: 300 tokens, 50 overlap → 14 chunks', pc: ['split(text'],
      title: 'Chunk the text',
      caption: 'The text is split into 14 chunks of about 300 tokens, overlapping by 50 so a sentence cut at a boundary still appears whole in one chunk.',
      text: ['ByteByteGo lists the common strategies: fixed-size with overlap, recursive (paragraphs, then lines, then words), document-based (one chunk per heading or section), semantic (start a new chunk when sentence similarity drops), and agentic (a model picks the method per document). Chunks too big blur the meaning of the vector; too small lose context.'],
      payloadKind: 'Chunk #3',
      payload: { id: 'hr-0193#3', section: '2. Duration', text: 'Employees in Belgium are entitled to 20 weeks of paid parental leave, which can be taken in blocks of at least two weeks before the child\'s second birthday…', tokens: 297 }
    },
    {
      from: 'ingest', to: 'embed', label: 'embed(context + chunk)', pc: ['summarize_position', 'vec = embed'],
      title: 'Add context, then embed',
      caption: 'A chunk like "20 weeks…" loses meaning on its own. A cheap LLM call writes a one-line context (which document, which section), which is prepended before embedding.',
      text: ['Anthropic calls this Contextual Retrieval: a 50–100 token context prepended to each chunk before embedding and before BM25 indexing. In their tests it cut failed retrievals by 49%, and by 67% with reranking added.'],
      payloadKind: 'Embedding input',
      payload: { input: 'This chunk is from Acme\'s Belgian parental leave policy (v7, Nov 2026), section "Duration". | Employees in Belgium are entitled to 20 weeks…', model: 'text-embedding-3-small', output_dims: 1536, vector_head: [0.0123, -0.0441, 0.0870, '…'] }
    },
    {
      from: 'embed', to: 'vdb', label: 'upsert hr-0193#3 (vector + text + meta)', pc: ['index.upsert'],
      title: 'Index the chunk two ways',
      caption: 'The chunk is stored with its vector in the ANN index and its words in a BM25 keyword index, together with metadata used for filtering and citation.',
      text: ['Upsert by a stable id (doc id + chunk number) so re-ingesting a document replaces its old chunks instead of duplicating them. See the vector search flow for how the HNSW index finds neighbours fast.'],
      payloadKind: 'Index record',
      payload: { id: 'hr-0193#3', vector: '[1536 floats]', text: 'Employees in Belgium are entitled to 20 weeks…', meta: { url: 'https://wiki.acme.internal/hr/parental-leave#duration', acl: ['all-employees-be'], updated: '2026-11-20' } }
    },
    {
      from: 'user', to: 'app', label: '"How long is parental leave here?"', pc: ['def answer'],
      title: 'Online: an employee asks',
      caption: 'Lucas, an employee in the Brussels office, asks how much parental leave he gets. The RAG service knows his groups from his login.',
      text: [],
      payloadKind: 'Question',
      payload: { user: 'lucas@acme.com', groups: ['all-employees-be', 'eng'], question: 'How long is parental leave here?' }
    },
    {
      from: 'app', to: 'vdb', label: 'vector top-50 + BM25 top-50 (acl filter)', pc: ['qv = embed(q)', 'vector_search', 'bm25_search', 'reciprocal_rank_fusion'],
      title: 'Hybrid retrieval: meaning and exact words',
      caption: 'The question is embedded with the same model and searched for nearest vectors; in parallel, BM25 matches keywords like "parental leave". Both are filtered to documents Lucas may see, and fused into one candidate list.',
      text: ['Anthropic\'s write-up explains why both: embeddings capture meaning but can miss exact matches (an error code, a product name); BM25 catches those. Reciprocal rank fusion merges the two rankings without needing comparable scores.'],
      payloadKind: 'Candidates',
      payload: { dense_top: ['hr-0193#3 (0.83)', 'hr-0102#1 (0.79)', 'hr-0193#4 (0.77)'], bm25_top: ['hr-0193#3', 'hr-0088#2 (US policy)', 'hr-0193#1'], fused: 50, filtered_out_by_acl: 6 }
    },
    {
      from: 'app', to: 'rerank', label: 'rank 50 (question, chunk) pairs', pc: ['reranker.rank'],
      title: 'Rerank the candidates',
      caption: 'A cross-encoder reads the question and each candidate together and scores relevance. It pushes the US policy chunk down (wrong country) and keeps the five best.',
      text: ['Pinecone\'s explanation: the first stage (bi-encoder vectors) compresses meaning into one vector per text and loses information; a reranker sees the pair together, so it is much more accurate, but far too slow to run on millions of chunks. Hence two stages: retrieve broadly, rerank narrowly.'],
      payloadKind: 'Reranked',
      payload: { top5: [{ id: 'hr-0193#3', score: 0.97 }, { id: 'hr-0193#4', score: 0.91 }, { id: 'hr-0193#1', score: 0.66 }, { id: 'hr-0102#1', score: 0.42 }, { id: 'hr-0088#2', score: 0.11 }] }
    },
    {
      from: 'app', to: 'llm', label: 'system + 5 sources + question', pc: ['prompt = SYSTEM', 'llm.generate'],
      title: 'Build a grounded prompt',
      caption: 'The service puts the top passages into the prompt with numbered source tags and tells the model to answer only from them and cite them, or say it does not know.',
      text: ['This is the "augmented" part. The original RAG paper (Lewis et al., 2020) described it as combining the model\'s parametric memory with a non-parametric memory: a dense vector index searched by a neural retriever.'],
      payloadKind: 'Prompt',
      payload: { system: 'Answer using only the sources. Cite like [1]. If the sources do not answer, say so.', sources: ['[1] Parental leave policy v7 §2 Duration: "Employees in Belgium are entitled to 20 weeks…"', '[2] §3 Scheduling: "…blocks of at least two weeks…"'], question: 'How long is parental leave here?' },
      branch: { q: 'Did retrieval find passages that answer the question?', options: [ { label: 'yes', goto: 'gen' }, { label: 'no relevant passages', goto: 'none' } ] }
    },
    {
      id: 'gen', path: 'answered', from: 'llm', to: 'user', reply: true, label: 'streamed answer + [1][2]', pc: ['return llm.generate', 'cite(top)'],
      title: 'Answer with citations',
      caption: 'The model streams: "You get 20 weeks of paid parental leave, in blocks of at least two weeks, before your child turns two [1][2]." The UI turns [1] into a link to the exact section.',
      text: ['Citations let users check the answer, and let you measure faithfulness offline (see the evaluation flow). Without them, a fluent wrong answer looks the same as a right one.'],
      payloadKind: 'Answer',
      payload: { text: 'You get 20 weeks of paid parental leave, taken in blocks of at least two weeks before your child turns two [1][2].', citations: { '1': 'https://wiki.acme.internal/hr/parental-leave#duration', '2': 'https://wiki.acme.internal/hr/parental-leave#scheduling' }, first_token_ms: 1150 },
      end: true
    },
    {
      id: 'none', path: 'not found', from: 'llm', to: 'user', reply: true, label: '"I couldn\'t find this in the docs"', pc: ['return llm.generate'],
      title: 'Nothing relevant: say so',
      caption: 'If the reranker\'s best score is low, the service (or the model, following its instructions) answers that the documents do not cover it and suggests who to ask, instead of guessing.',
      text: ['A fixed pipeline cannot try again with a better query. Agentic RAG adds that loop: grade the retrieval, rewrite the question, or search elsewhere.'],
      payloadKind: 'Answer',
      payload: { text: 'I couldn\'t find this in the HR documents you have access to. HR Belgium (hr-be@acme.com) can confirm.', best_rerank_score: 0.18, threshold: 0.5 }
    }
  ],
  decisions: [
    { q: 'Vector search only, or hybrid with BM25?', options: [
      { name: 'Hybrid + rerank', verdict: 'great', why: 'Catches both paraphrases and exact terms; reranking fixes ordering. More moving parts.' },
      { name: 'Vector only', verdict: 'good', why: 'Simplest. Misses exact identifiers and rare names.' } ] },
    { q: 'RAG or fine-tuning to teach the model your documents?', options: [
      { name: 'RAG', verdict: 'great', why: 'Fresh data without retraining, citations, per-user permissions.' },
      { name: 'Fine-tuning', verdict: 'good', why: 'Teaches style and format, not reliable recall of facts; data goes stale. Often combined with RAG.' } ] }
  ],
  refs: [
    { label: 'Lewis et al. (2020): Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks', url: 'https://arxiv.org/abs/2005.11401' },
    { label: 'Anthropic engineering: Introducing Contextual Retrieval', url: 'https://www.anthropic.com/news/contextual-retrieval', note: 'chunk → embed → vector DB, BM25, contextual prefixes, reranking, measured gains.' },
    { label: 'ByteByteGo: 8 chunking strategies for RAG', url: 'https://blog.bytebytego.com/p/ep229-8-chunking-strategies-for-rag' },
    { label: 'Pinecone: Rerankers and two-stage retrieval', url: 'https://www.pinecone.io/learn/series/rag/rerankers/' },
    { label: 'Cohere docs: Rerank overview', url: 'https://docs.cohere.com/docs/rerank-overview' }
  ],
  verify: {
    checked: ['Two-phase RAG pipeline, BM25 + embeddings, contextual prefix of 50–100 tokens, 49% / 67% reduction in failed retrievals: Anthropic\'s post.', 'Chunking strategies: ByteByteGo. Why rerankers are slower but more accurate: Pinecone.', 'Parametric + non-parametric memory: Lewis et al. abstract.'],
    uncertain: ['Chunk size, k values, scores and the 0.5 threshold are illustrative defaults; teams tune them on their own evaluation sets.', 'The policy text is invented for the example.']
  }
});
