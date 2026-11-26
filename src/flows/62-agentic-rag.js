flow({
  id: 'agentic-rag',
  title: 'Agentic RAG: route, grade, rewrite, retry',
  category: 'AI & machine learning',
  tags: ['Query routing', 'Retrieval grading', 'Query rewriting', 'Multiple sources', 'Corrective RAG', 'Bounded loop'],
  summary: 'Plain RAG runs once in a straight line and answers from whatever it retrieved. Agentic RAG puts an LLM-driven decision loop in the middle: it decides which source to search, grades whether the results really answer the question, rewrites the query or falls back to web search when they do not, and only then generates.',
  requirements: {
    functional: ['Answer questions that may need internal docs, a SQL database, or the public web.', 'Detect weak retrieval and try again before answering.'],
    nonFunctional: ['Bounded: at most 3 retrieval rounds, so cost and latency stay predictable.', 'Every answer still cites its sources.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'user', label: 'User', sub: 'support chat', kind: 'client', icon: 'user', x: 0, y: 1, desc: 'Asks a question that may be ambiguous or need several sources.' },
    { id: 'agent', label: 'RAG agent', sub: 'LLM + state machine', kind: 'ai', icon: 'robot', x: 1, y: 1, desc: 'An LLM with tools, run inside a small graph of states (route, retrieve, grade, rewrite, generate). The graph caps the number of loops.' },
    { id: 'docs', label: 'Docs vector index', sub: 'product manuals', kind: 'db', icon: 'vector', x: 2, y: 0, desc: 'The standard RAG index from the RAG flow.' },
    { id: 'sql', label: 'Orders DB', sub: 'read-only SQL tool', kind: 'db', icon: 'db', x: 3, y: 0, desc: 'Structured data the agent can query through a restricted tool.' },
    { id: 'grader', label: 'Relevance grader', sub: 'small LLM / classifier', kind: 'ai', icon: 'check', x: 2, y: 2, desc: 'Judges each retrieved chunk: does it actually answer the question? Corrective RAG calls this a retrieval evaluator.' },
    { id: 'web', label: 'Web search API', sub: 'fallback source', kind: 'external', icon: 'globe', x: 3, y: 2, desc: 'Used when internal sources do not have a good answer.' }
  ],
  pseudo: `
def agentic_rag(q, max_rounds=3):
    source = llm.route(q, options=["docs", "orders_sql", "web"])
    for round in range(max_rounds):
        chunks = retrieve(source, q)
        graded = [c for c in chunks if grader.relevant(q, c)]
        if len(graded) >= 2:
            return llm.generate(q, graded)             # enough evidence
        q = llm.rewrite(q, feedback=chunks)            # sharpen the query
        if round == 1: source = "web"                  # corrective fallback
    return "I couldn't find a reliable answer."`,
  steps: [
    {
      from: 'user', to: 'agent', label: '"Does the X2 work with the old dock?"', pc: ['def agentic_rag'],
      title: 'An ambiguous question arrives',
      caption: 'A customer asks whether the X2 headset works with "the old dock". There are three docks; the question does not say which.',
      text: ['ByteByteGo\'s point about standard RAG: it takes the query as-is, retrieves whatever scores highest, and hopes for the best. Nothing in the middle checks whether retrieval was good enough.'],
      payloadKind: 'Question',
      payload: { question: 'Does the X2 work with the old dock?', customer_id: 'c_5521' }
    },
    {
      from: 'agent', to: 'agent', label: 'route → docs', pc: ['llm.route'],
      title: 'Route: which source fits?',
      caption: 'The agent first decides where to look. Compatibility is a product-manual question, not an order lookup, so it picks the docs index.',
      text: ['Routing is a single LLM call with a constrained output (one of the source names). It saves calls to sources that cannot help.'],
      payloadKind: 'Routing decision',
      payload: { options: ['docs', 'orders_sql', 'web'], chosen: 'docs', reason: 'hardware compatibility question' },
      branch: { q: 'What kind of question is it?', options: [ { label: 'product question → docs', goto: 'r1' }, { label: 'order question → SQL tool', goto: 'sqlq' } ] }
    },
    {
      id: 'sqlq', path: 'order question', from: 'agent', to: 'sql', label: 'SELECT status FROM orders WHERE id = 88125', pc: ['llm.route'],
      title: 'Other route: a structured lookup',
      caption: 'Had the customer asked "Where is my order 88125?", the router would pick the read-only SQL tool instead of the vector index. A vector search is the wrong tool for an exact lookup.',
      text: ['The SQL tool runs with a read-only database role and a row filter on the customer\'s own orders, so a bad generated query cannot change data or read other people\'s orders.'],
      payloadKind: 'Tool result',
      payload: { sql: 'SELECT status, carrier, eta FROM orders WHERE id = 88125 AND customer_id = \'c_5521\'', rows: [{ status: 'shipped', carrier: 'bpost', eta: '2026-11-28' }] },
      next: 'gen'
    },
    {
      id: 'r1', from: 'agent', to: 'docs', label: 'search "X2 old dock compatible"', pc: ['chunks = retrieve'],
      title: 'Round 1: retrieve',
      caption: 'The query is searched as written. The top results are about the X2\'s battery and a generic dock page, scored high by similarity because they share words.',
      text: [],
      payloadKind: 'Retrieved',
      payload: { results: [{ id: 'x2-manual#12', text: 'X2 battery lasts 30 h…', sim: 0.81 }, { id: 'docks#1', text: 'Our docks charge all headsets…', sim: 0.78 }, { id: 'x1-dock#4', text: 'D1 dock firmware 2.1…', sim: 0.74 }] }
    },
    {
      from: 'agent', to: 'grader', label: 'grade 3 chunks', pc: ['grader.relevant'],
      title: 'Grade: is this actually an answer?',
      caption: 'The grader reads each chunk with the question. None states whether the X2 works with a specific older dock: relevant topic, no answer. 0 of 3 pass.',
      text: ['Corrective RAG (Yan et al., 2024) uses a lightweight retrieval evaluator to score retrieved documents and trigger different actions depending on its confidence. This is the checkpoint that plain RAG lacks.'],
      payloadKind: 'Grades',
      payload: { 'x2-manual#12': 'not relevant (battery)', 'docks#1': 'partially (too generic)', 'x1-dock#4': 'not relevant (X1)', passed: 0, needed: 2 },
      branch: { q: 'Enough relevant chunks?', options: [ { label: 'no: rewrite and retry', goto: 'rw' }, { label: 'yes: generate', goto: 'gen' } ] }
    },
    {
      id: 'rw', path: 'retry', from: 'agent', to: 'agent', label: 'rewrite → "X2 compatibility D1 dock D2 dock"', pc: ['llm.rewrite'],
      title: 'Rewrite the query',
      caption: 'The agent uses what it saw: "old dock" probably means the D1 or D2 (the current one is D3). It rewrites the query with the real product names.',
      text: ['ByteByteGo describes this as the move from a pipeline to a control loop: before searching, rewrite an ambiguous query; after searching, if results look weak, reformulate and try again.'],
      payloadKind: 'Rewritten query',
      payload: { before: 'X2 old dock compatible', after: 'X2 headset compatibility with D1 dock and D2 dock', round: 2 }
    },
    {
      path: 'retry', from: 'agent', to: 'docs', label: 'round 2 search', pc: ['chunks = retrieve'],
      title: 'Round 2: retrieve again',
      caption: 'Now the compatibility matrix and a release note come back.',
      text: [],
      payloadKind: 'Retrieved',
      payload: { results: [{ id: 'compat#2', text: 'X2: D2 and D3 docks supported. D1 not supported (no USB-C).' }, { id: 'release-x2#5', text: 'X2 requires D2 firmware 3.0 or later.' }] }
    },
    {
      path: 'retry', from: 'agent', to: 'grader', label: 'grade: 2 of 2 relevant', pc: ['grader.relevant', 'if len(graded) >= 2'],
      title: 'Grade again: enough evidence',
      caption: 'Both chunks directly answer the question. The loop ends.',
      text: ['If round 2 had also failed, the corrective step would switch to web search (as CRAG does for static corpora) before giving up after round 3.'],
      payloadKind: 'Grades',
      payload: { 'compat#2': 'relevant', 'release-x2#5': 'relevant', passed: 2 },
      branch: { q: 'Did round 2 find enough?', options: [ { label: 'yes: generate', goto: 'gen' }, { label: 'still weak: web fallback', goto: 'webq' } ] }
    },
    {
      id: 'webq', path: 'web fallback', from: 'agent', to: 'web', label: 'web search "X2 headset D1 dock"', pc: ['source = "web"'],
      title: 'Corrective fallback: search the web',
      caption: 'If the internal index still had nothing useful, the agent would switch source to a web search API, grade those results the same way, and answer only from what passes.',
      text: ['CRAG uses large-scale web search to extend retrieval when the internal results are judged wrong or ambiguous. The answer should then say that it comes from outside sources.'],
      payloadKind: 'Web results',
      payload: { results: [{ url: 'https://forum.example.com/x2-d1', snippet: 'D1 dock does not charge the X2…' }], graded_relevant: 1, note: 'answer flagged as based on external sources' },
      next: 'gen'
    },
    {
      id: 'gen', from: 'agent', to: 'user', reply: true, label: 'answer with both cases + citations', pc: ['return llm.generate'],
      title: 'Generate a precise answer',
      caption: 'The answer covers the ambiguity instead of guessing: "With the D2 dock, yes, after updating it to firmware 3.0. The D1 is not supported [1][2]."',
      text: ['The extra rounds cost latency and tokens, so production systems keep the loop bounded and use small, fast models for routing and grading.'],
      payloadKind: 'Answer',
      payload: { text: 'If your old dock is the D2: yes, after updating it to firmware 3.0. The D1 is not supported because it has no USB-C [1][2].', rounds: 2, llm_calls: 6 }
    }
  ],
  decisions: [
    { q: 'Plain RAG or agentic RAG?', options: [
      { name: 'Plain RAG', verdict: 'good', why: 'One retrieval, one LLM call: cheap and fast. Fine for clear questions over one corpus.' },
      { name: 'Agentic RAG', verdict: 'good', why: 'Handles ambiguity, multiple sources and weak retrieval. 3–10× the LLM calls; needs a loop limit.' } ] }
  ],
  refs: [
    { label: 'ByteByteGo newsletter: How agentic RAG works', url: 'https://blog.bytebytego.com/p/how-agentic-rag-works' },
    { label: 'ByteByteGo: RAG vs agentic RAG', url: 'https://blog.bytebytego.com/p/ep230-rag-vs-agentic-rag' },
    { label: 'Yan et al. (2024): Corrective Retrieval Augmented Generation (CRAG)', url: 'https://arxiv.org/abs/2401.15884' },
    { label: 'Asai et al. (2023): Self-RAG: learning to retrieve, generate and critique', url: 'https://arxiv.org/abs/2310.11511' },
    { label: 'LangGraph docs: Build an agentic RAG (retriever tool, grade documents, rewrite the question)', url: 'https://docs.langchain.com/oss/python/langgraph/agentic-rag' }
  ],
  verify: {
    checked: ['Standard RAG has no checkpoint; agentic RAG adds rewrite-before and reformulate-after: ByteByteGo post (free part).', 'Retrieval evaluator with confidence-based actions and web search fallback: CRAG abstract.'],
    uncertain: ['The 2-chunk threshold, 3-round cap and product names are illustrative.']
  }
});
