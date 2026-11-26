flow({
  id: 'multi-agent-research',
  title: 'Multi-agent orchestration: lead agent and parallel subagents',
  category: 'AI & machine learning',
  tags: ['Orchestrator–worker', 'Parallel subagents', 'Separate context windows', 'Plan saved to memory', 'Citation pass', 'Token cost'],
  summary: 'One agent with one context window runs out of room on broad questions. Follow a research request through an orchestrator–worker system like Anthropic\'s Research feature: a lead agent writes a plan, saves it, starts subagents that search in parallel with their own context windows, merges their condensed findings, and hands the report to a citation agent.',
  requirements: {
    functional: ['Answer broad research questions that need many independent searches.', 'Every claim in the report is linked to a source.'],
    nonFunctional: ['Wall-clock time close to the slowest subagent, not the sum of all searches.', 'Spend is bounded: a cap on subagents and on tool calls per subagent.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'user', label: 'User', sub: 'research request', kind: 'client', icon: 'user', x: 0, y: 1, desc: 'Asks a question with many parts.' },
    { id: 'lead', label: 'Lead agent', sub: 'large model, plans', kind: 'ai', icon: 'robot', x: 1, y: 1, desc: 'Breaks the question into subtasks, writes clear instructions for each subagent, merges results and decides whether more research is needed.' },
    { id: 'mem', label: 'Memory store', sub: 'plan + notes', kind: 'cache', icon: 'doc', x: 1, y: 0, desc: 'Persists the plan outside the context window, so it survives truncation of a long session.' },
    { id: 'sa', label: 'Subagent A', sub: 'smaller model', kind: 'ai', icon: 'robot', x: 2, y: 0, desc: 'Gets one subtask, an output format and a tool budget. Searches in its own context window and returns only a condensed summary.' },
    { id: 'sb', label: 'Subagent B', sub: 'smaller model', kind: 'ai', icon: 'robot', x: 2, y: 2, desc: 'Same as A, on another subtask, at the same time.' },
    { id: 'web', label: 'Search + fetch tools', sub: 'web, docs, MCP', kind: 'external', icon: 'globe', x: 3, y: 1, desc: 'The tools the subagents call, often several in parallel.' },
    { id: 'cite', label: 'Citation agent', sub: 'post-processing', kind: 'ai', icon: 'check', x: 0, y: 2, desc: 'Reads the report and the collected documents and attaches each claim to the exact source passage.' }
  ],
  pseudo: `
plan = lead.think(query)
memory.save("plan", plan)                 # survives context truncation
while True:
    tasks = lead.split(plan, max_subagents=5)
    results = await gather(*[subagent(t, tool_budget=15) for t in tasks])
    lead.add(condensed(results))
    if lead.enough(): break
    plan = lead.refine(plan, results)
report = lead.write()
return citation_agent(report, sources=all_documents)`,
  steps: [
    {
      from: 'user', to: 'lead', label: '"Compare EU and US rules for AI in hiring"', pc: ['plan = lead.think'],
      title: 'A broad question',
      caption: 'The question has independent parts (EU law, US federal guidance, state laws such as New York City\'s). A single agent would search them one after another and fill its context with raw pages.',
      text: ['Anthropic reports that agents use about 4× the tokens of a chat, and multi-agent systems about 15×. The pattern pays off only for valuable, parallelizable tasks.'],
      payloadKind: 'Request',
      payload: { query: 'Compare EU and US rules for using AI in hiring decisions', mode: 'research' }
    },
    {
      from: 'lead', to: 'mem', label: 'save plan', pc: ['memory.save'],
      title: 'Plan first, and save it',
      caption: 'The lead thinks through the approach and writes the plan to memory. Long sessions can exceed the context window; the saved plan is what keeps the job on track if earlier turns get truncated.',
      text: [],
      payloadKind: 'Plan',
      payload: { subtasks: [{ id: 'A', goal: 'EU AI Act: how hiring systems are classified and what obligations follow', sources: 'official EU texts' }, { id: 'B', goal: 'US: federal guidance + NYC Local Law 144 on automated employment decision tools', sources: 'agency and city sites' }], output: 'bullet findings with URLs' }
    },
    {
      from: 'lead', to: 'sa', label: 'task A + format + budget', pc: ['tasks = lead.split', 'gather('],
      title: 'Delegate with precise instructions',
      caption: 'Each subagent gets an objective, an output format, which tools and sources to use, and clear boundaries. Vague delegation was a main failure mode: subagents duplicated each other\'s work.',
      text: ['Anthropic\'s lead agent starts 3–5 subagents in parallel, and subagents call 3+ tools in parallel; they report this cut research time by up to 90% on complex queries.'],
      payloadKind: 'Subagent brief',
      payload: { objective: 'How does the EU AI Act classify AI used in recruitment, and what must providers and deployers do?', tools: ['web_search', 'fetch'], prefer: 'eur-lex.europa.eu', budget: { tool_calls: 15 }, return: '≤ 300 words, every claim with URL' }
    },
    {
      from: 'lead', to: 'sb', async: true, label: 'task B (in parallel)', pc: ['gather('],
      title: 'A second subagent starts at the same time',
      caption: 'Subagent B gets the US half. The two run concurrently, each with its own fresh context window.',
      text: [],
      payloadKind: 'Subagent brief',
      payload: { objective: 'US federal guidance and NYC Local Law 144 (bias audits for automated employment decision tools)', budget: { tool_calls: 15 } }
    },
    {
      from: 'sa', to: 'web', label: 'search ×3 in parallel, fetch 4 pages', pc: ['subagent(t, tool_budget=15)'],
      title: 'Subagents search widely, then narrow',
      caption: 'Subagent A starts with short broad queries, reads the results, then fetches the official text. Its context fills with raw pages, the lead\'s does not.',
      text: [],
      payloadKind: 'Tool calls',
      payload: { calls: ['web_search("AI Act recruitment high-risk")', 'web_search("AI Act Annex III employment")', 'fetch(eur-lex …)'], tokens_read: 41000 }
    },
    {
      from: 'sa', to: 'lead', reply: true, label: 'condensed findings (≈300 words)', pc: ['lead.add(condensed'],
      title: 'Return a summary, not the pages',
      caption: 'Subagent A compresses 41,000 tokens of reading into a short summary with URLs. B does the same. The lead\'s context stays small enough to reason over both.',
      text: [],
      payloadKind: 'Findings',
      payload: { subtask: 'A', findings: ['AI systems used for recruitment or selection are listed as high-risk (Annex III).', 'Deployers must follow instructions for use and ensure human oversight.'], urls: ['https://eur-lex.europa.eu/…'] },
      branch: { q: 'Is there enough to answer?', options: [ { label: 'yes: write the report', goto: 'write' }, { label: 'gap found: refine and spawn again', goto: 'more' } ] }
    },
    {
      id: 'more', path: 'another round', from: 'lead', to: 'sb', label: 'new subtask: state laws beyond NYC', pc: ['plan = lead.refine'],
      title: 'Other outcome: another research round',
      caption: 'If the lead finds a gap (for example other US states), it refines the plan and starts new subagents. The loop is bounded by the subagent cap.',
      text: [],
      payloadKind: 'Refinement',
      payload: { gap: 'US state laws other than NYC', new_subtasks: 1 },
      next: 'write'
    },
    {
      id: 'write', from: 'lead', to: 'cite', label: 'draft report + all documents', pc: ['report = lead.write()', 'citation_agent('],
      title: 'Write, then cite',
      caption: 'The lead writes the comparison. A separate citation agent reads it alongside every collected document and attaches each claim to a specific passage.',
      text: [],
      payloadKind: 'Citation pass',
      payload: { claims: 14, cited: 14, unsupported_removed: 0 }
    },
    {
      from: 'cite', to: 'user', reply: true, label: 'report with citations', pc: ['return citation_agent'],
      title: 'Deliver',
      caption: 'The user gets one report. Behind it: 1 lead, 2 subagents, 31 tool calls, roughly 15× the tokens of a plain chat answer.',
      text: [],
      payloadKind: 'Run summary',
      payload: { subagents: 2, tool_calls: 31, wall_clock_s: 140, tokens_total: 310000 }
    }
  ],
  decisions: [
    { q: 'One agent or many?', options: [
      { name: 'Single agent', verdict: 'good', why: 'Cheaper, simpler, better when steps depend tightly on each other (most coding tasks).' },
      { name: 'Orchestrator + subagents', verdict: 'good', why: 'Wins on breadth-first tasks with independent parts; Anthropic measured 90.2% better than a single agent on their internal research eval, at much higher token cost.' } ] },
    { q: 'How do agents hand work over?', options: [
      { name: 'Subagents as tools (results return to the lead)', verdict: 'great', why: 'The lead keeps control and context; the pattern in this flow.' },
      { name: 'Handoffs (control moves to another agent)', verdict: 'good', why: 'Good for routing a conversation to a specialist, as in the OpenAI Agents SDK.' } ] }
  ],
  refs: [
    { label: 'Anthropic: How we built our multi-agent research system', url: 'https://www.anthropic.com/engineering/multi-agent-research-system' },
    { label: 'ByteByteGo: How Anthropic built a multi-agent research system', url: 'https://blog.bytebytego.com/p/how-anthropic-built-a-multi-agent' },
    { label: 'OpenAI Agents SDK: Handoffs', url: 'https://openai.github.io/openai-agents-python/handoffs/' },
    { label: 'Anthropic: Building effective agents (orchestrator–workers)', url: 'https://www.anthropic.com/engineering/building-effective-agents' }
  ],
  verify: {
    checked: ['Orchestrator–worker design, plan saved to Memory because context over 200,000 tokens is truncated, CitationAgent, 3–5 parallel subagents, up to 90% faster, 4× and 15× token use, 90.2% eval gain: Anthropic engineering post (read in full).', 'AI for recruitment listed as high-risk in Annex III of the EU AI Act: used only as example content.'],
    uncertain: ['The query, budgets, token counts and timings are illustrative.', 'The legal findings are a simplified example, not legal guidance.']
  }
});
