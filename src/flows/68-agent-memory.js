flow({
  id: 'agent-memory',
  title: 'Agent memory: short-term context and long-term recall',
  category: 'AI & machine learning',
  tags: ['Context window budget', 'Summarize / compact', 'Memory extraction', 'Vector recall', 'Memory tiers (MemGPT)', 'User controls'],
  summary: 'An LLM remembers nothing between calls: "memory" is whatever your app puts back into the prompt. Follow a study assistant that keeps a running chat within its token budget, compacts old turns into a summary, extracts durable facts into a long-term store, and weeks later recalls the right ones for a new question.',
  requirements: {
    functional: ['Continue long conversations without losing the thread.', 'Remember durable facts across sessions (exam date, preferences).', 'Let the user see and delete what is remembered.'],
    nonFunctional: ['Prompt stays under a token budget (here 24k of a 200k window) for cost and focus.', 'Recall adds < 50 ms.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'user', label: 'Student', sub: 'chat app', kind: 'client', icon: 'user', x: 0, y: 1, desc: 'Talks to the assistant over many sessions.' },
    { id: 'app', label: 'Assistant backend', sub: 'context builder', kind: 'service', icon: 'robot', x: 1, y: 1, desc: 'Assembles each prompt: system prompt + recalled memories + summary of old turns + recent turns. Decides what to keep, compress or drop.' },
    { id: 'llm', label: 'LLM', sub: 'stateless', kind: 'ai', icon: 'brain', x: 1, y: 0, desc: 'Sees only the prompt it is given on each call.' },
    { id: 'hist', label: 'Session store', sub: 'Redis / Postgres', kind: 'cache', icon: 'layers', x: 2, y: 2, desc: 'Raw turns of the current session plus the rolling summary. Short-term memory.' },
    { id: 'ext', label: 'Memory extractor', sub: 'small LLM, async', kind: 'worker', icon: 'filter', x: 3, y: 2, desc: 'After a session, pulls out durable facts and decides to add, update or ignore each one.' },
    { id: 'ltm', label: 'Long-term memory', sub: 'vector + rows', kind: 'db', icon: 'vector', x: 3, y: 0, desc: 'Facts as rows (user_id, text, created_at) with an embedding, searchable by meaning. The user can list and delete them.' }
  ],
  pseudo: `
def build_prompt(user, msg):
    mems = ltm.search(user, embed(msg), k=5)       # long-term recall
    s = session.load(user)
    if tokens(s.turns) > 16_000:                   # short-term budget
        s.summary = llm("Summarize, keep decisions:", s.summary, s.turns[:-6])
        s.turns = s.turns[-6:]
    return [SYSTEM, *mems, s.summary, *s.turns, msg]

on_session_end(user):
    for fact in extractor(session.turns):
        old = ltm.nearest(user, fact)
        ltm.update(old, fact) if conflicts(old, fact) else ltm.add(fact)`,
  steps: [
    {
      from: 'user', to: 'app', label: '"Quiz me on Dijkstra again"', pc: ['def build_prompt'],
      title: 'A new message in a long session',
      caption: 'The session already has 140 turns. Sending all of them would cost about 31,000 tokens per call and bury the important parts.',
      text: ['"Lost in the Middle" (Liu et al., 2023) found that models use information at the start and end of a long context better than information in the middle, one reason to keep prompts lean.'],
      payloadKind: 'Message',
      payload: { user: 'u_swampi', session: 's_88', text: 'Quiz me on Dijkstra again', session_turns: 140 }
    },
    {
      from: 'app', to: 'ltm', label: 'search(u_swampi, embed(msg), k=5)', pc: ['mems = ltm.search'],
      title: 'Recall long-term memories',
      caption: 'The message is embedded and compared with this user\'s stored facts. The top matches come back with their dates.',
      text: [],
      payloadKind: 'Recalled',
      payload: { memories: [{ text: 'Graph theory exam on 2026-12-08', score: 0.71, saved: '2026-11-24' }, { text: 'Confuses Dijkstra with Prim when edges tie', score: 0.69, saved: '2026-11-25' }, { text: 'Prefers questions before explanations', score: 0.52 }] }
    },
    {
      from: 'app', to: 'hist', label: 'load session s_88', pc: ['s = session.load'],
      title: 'Load short-term memory',
      caption: 'The session store returns the rolling summary and the raw turns. The raw turns are over the 16,000-token budget.',
      text: [],
      payloadKind: 'Session',
      payload: { summary: '(summary of turns 1–80)', raw_turns: 60, raw_tokens: 18400, budget: 16000 },
      branch: { q: 'Raw turns over budget?', options: [ { label: 'yes: compact old turns', goto: 'compact' }, { label: 'no: use as is', goto: 'call' } ] }
    },
    {
      id: 'compact', from: 'app', to: 'llm', label: 'summarize turns 81–134, keep decisions', pc: ['s.summary = llm("Summarize'],
      title: 'Compact: fold old turns into the summary',
      caption: 'Everything except the last 6 turns is summarized into the running summary. Decisions and open questions are kept; small talk is dropped.',
      text: ['Anthropic calls this "compaction" in its context-engineering guide; MemGPT treats it like an OS moving data between fast memory (the context) and slow memory (storage).'],
      payloadKind: 'Summary update',
      payload: { before_tokens: 18400, after_tokens: 2100, summary_excerpt: 'Covered BFS/DFS, Dijkstra (2 mistakes on ties), started Prim. Next: mixed quiz.' }
    },
    {
      id: 'call', from: 'app', to: 'llm', label: 'prompt ≈ 6k tokens', pc: ['return [SYSTEM, *mems'],
      title: 'Call the model with the assembled context',
      caption: 'Order matters: system prompt, recalled facts, summary, recent turns, new message. The model now "remembers" the exam date and the tie mistake.',
      text: [],
      payloadKind: 'Prompt layout',
      payload: { system: 420, memories: 90, summary: 2100, recent_turns: 3300, message: 8, total_tokens: 5918 }
    },
    {
      from: 'llm', to: 'user', reply: true, label: 'quiz with an equal-weight edge trap', pc: ['return [SYSTEM'],
      title: 'A personalised answer',
      caption: 'The quiz targets the known weakness: a graph with tied edges, 12 days before the exam.',
      text: [],
      payloadKind: 'Answer',
      payload: { text: 'Exam in 12 days, so mixed practice. Q1: Dijkstra from A on this graph; edges A–B and A–C both weigh 3…' }
    },
    {
      from: 'app', to: 'ext', async: true, label: 'session ended → extract facts', pc: ['on_session_end', 'for fact in extractor'],
      title: 'After the session: extract durable facts',
      caption: 'A background job reads the finished session and proposes facts worth keeping beyond today.',
      text: [],
      payloadKind: 'Extracted',
      payload: { candidates: ['Graph theory exam moved to 2026-12-10', 'Now gets Dijkstra ties right', 'Ate pasta for lunch'], kept: 2, ignored: ['Ate pasta for lunch (not durable)'] }
    },
    {
      from: 'ext', to: 'ltm', label: 'UPDATE exam date, ADD progress', pc: ['ltm.update(old, fact) if conflicts'],
      title: 'Update, don\'t just append',
      caption: 'The new exam date conflicts with the stored one, so the old fact is replaced rather than kept beside it. Two contradicting memories would confuse the next recall.',
      text: ['Memory layers such as Mem0 run this add / update / delete decision with an LLM; ChatGPT shows saved memories to the user, who can delete them.'],
      payloadKind: 'Writes',
      payload: { update: { id: 'm_31', old: 'exam on 2026-12-08', new: 'exam on 2026-12-10' }, add: { text: 'Dijkstra ties: fixed on 2026-11-26' } },
      failure: 'If the extractor wrongly stores something sensitive or false, the user must be able to see and delete it; store memories per user and never mix them across accounts.'
    }
  ],
  decisions: [
    { q: 'How to keep the session in budget?', options: [
      { name: 'Sliding window (drop oldest)', verdict: 'ok', why: 'Simple, but forgets early decisions.' },
      { name: 'Rolling summary + recent turns', verdict: 'great', why: 'Keeps decisions in few tokens; the pattern shown here.' } ] },
    { q: 'Long-term memory store?', options: [
      { name: 'Vector search over facts', verdict: 'good', why: 'Finds facts by meaning.' },
      { name: 'Structured profile fields', verdict: 'good', why: 'Exact and editable (exam_date). Many systems use both.' } ] }
  ],
  refs: [
    { label: 'Packer et al. (2023): MemGPT, LLMs as operating systems', url: 'https://arxiv.org/abs/2310.08560' },
    { label: 'Liu et al. (2023): Lost in the middle, how LMs use long contexts', url: 'https://arxiv.org/abs/2307.03172' },
    { label: 'Anthropic: Effective context engineering for AI agents', url: 'https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents' },
    { label: 'Mem0 documentation (memory layer for agents)', url: 'https://docs.mem0.ai/' },
    { label: 'OpenAI: Memory and new controls for ChatGPT', url: 'https://openai.com/index/memory-and-new-controls-for-chatgpt/' }
  ],
  verify: {
    checked: ['Virtual context management between memory tiers, multi-session chat: MemGPT abstract.', 'Performance highest when information is at the beginning or end of the context: Lost in the Middle abstract.'],
    uncertain: ['Budgets, token counts, scores and the 6-turn window are illustrative.', 'Details of compaction (Anthropic guide), Mem0\'s update logic and ChatGPT\'s memory controls are summarized from their pages, not tested.']
  }
});
