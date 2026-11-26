flow({
  id: 'context-engineering',
  title: 'Context engineering for long-running agents',
  category: 'AI & machine learning',
  tags: ['Context as a finite budget', 'System prompt + tools', 'Just-in-time retrieval', 'Tool result trimming', 'Compaction', 'Structured notes', 'Sub-agents'],
  summary: 'An agent working for an hour would overflow any context window if it kept everything. Context engineering decides, at each turn, which tokens the model sees: a stable system prompt and tool list, only the files it fetched just in time, trimmed tool outputs, a compacted summary of old turns, notes it wrote to itself, and short reports from sub-agents. Follow one coding task as its context fills up.',
  requirements: {
    functional: ['Keep the agent on task across many tool calls.', 'Recall decisions made long ago.'],
    nonFunctional: ['Stay within the context window with room to spare.', 'Fewer, more relevant tokens: quality drops as context grows ("context rot").']
  },
  grid: { cols: 5, rows: 3 },
  nodes: [
    { id: 'user', label: 'Developer', sub: 'task', kind: 'client', icon: 'user', x: 0, y: 1, desc: 'Asks: "Add pagination to the chapter list."' },
    { id: 'harness', label: 'Agent harness', sub: 'builds each prompt', kind: 'service', icon: 'split', x: 1, y: 1, desc: 'Assembles the context for every model call and decides what to keep, trim or summarise.' },
    { id: 'llm', label: 'LLM', sub: '200k window', kind: 'ai', icon: 'brain', x: 2, y: 1, desc: 'Sees only what the harness puts in front of it.' },
    { id: 'tools', label: 'Tools', sub: 'grep, read, run tests', kind: 'service', icon: 'tool', x: 2, y: 0, desc: 'Load data on demand by reference (paths, queries) instead of pasting everything up front.' },
    { id: 'notes', label: 'Notes file', sub: 'NOTES.md', kind: 'storage', icon: 'pen', x: 3, y: 2, desc: 'Persistent memory outside the window: progress, decisions, open questions.' },
    { id: 'sub', label: 'Sub-agent', sub: 'clean context', kind: 'ai', icon: 'robot', x: 3, y: 0, desc: 'Explores a side question with its own fresh window and returns a short summary.' },
    { id: 'budget', label: 'Context budget', sub: 'token counter', kind: 'service', icon: 'gauge', x: 1, y: 2, desc: 'Tracks how full the window is and triggers compaction.' }
  ],
  pseudo: `
ctx = [system_prompt, tool_defs, NOTES.md, user_task]
loop:
    reply = llm(ctx)
    if reply.tool_call: out = run(reply.tool_call); ctx += trim(out, max=2k tokens)
    if side_question: summary = sub_agent(question); ctx += summary   # ~1k tokens
    if decision_made: notes.append(decision)
    if tokens(ctx) > 0.8 * window:
        ctx = [system_prompt, tool_defs, NOTES.md, user_task, summarize(old_turns), last_5_turns]`,
  steps: [
    {
      from: 'user', to: 'harness', label: '"Add pagination to the chapter list"', pc: ['ctx = [system_prompt'],
      title: 'Start small',
      caption: 'The first context holds a clear system prompt, a compact set of tools with distinct purposes, the notes file and the task. Not the whole repository.',
      text: [],
      payloadKind: 'Context at turn 1',
      payload: { system_prompt: 1800, tool_defs: 2400, notes: 300, task: 40, total_tokens: 4540, window: 200000 }
    },
    {
      from: 'llm', to: 'tools', label: 'grep "getChapters" → 3 paths', pc: ['if reply.tool_call'],
      title: 'Load just in time, by reference',
      caption: 'Instead of pre-loading every file, the agent searches and gets file paths, then reads only the two files that matter. Anthropic describes this as the "just in time" approach, the way Claude Code explores codebases.',
      text: [],
      payloadKind: 'Tool result',
      payload: { tool: 'grep', query: 'getChapters', results: ['backend/routes/series.py:41', 'frontend/lib/api.ts:88', 'frontend/app/series/[id]/page.tsx:23'] }
    },
    {
      from: 'tools', to: 'harness', label: 'test log 38 000 tokens → trimmed to 1 200', pc: ['ctx += trim(out'],
      title: 'Trim noisy tool output',
      caption: 'Running the test suite prints 38 000 tokens. The harness keeps the failing test names, the assertion and the last lines; the full log stays on disk if needed.',
      text: [],
      payloadKind: 'Trimmed result',
      payload: { raw_tokens: 38000, kept_tokens: 1200, kept: ['FAILED test_pagination_offset', 'AssertionError: expected 50 got 63', 'last 20 lines'], full_log: '/tmp/test.log' }
    },
    {
      from: 'llm', to: 'sub', label: '"How does Mealie paginate?" → 1k summary', pc: ['if side_question'],
      title: 'Delegate a side question to a sub-agent',
      caption: 'Reading another codebase would burn 60 000 tokens. A sub-agent does it in its own clean window and returns a 1 000-token summary.',
      text: [],
      payloadKind: 'Sub-agent report',
      payload: { spent_tokens_in_subagent: 61000, returned_tokens: 950, summary: 'Uses page + perPage query params, returns total and next URL…' }
    },
    {
      from: 'llm', to: 'notes', label: 'append decision to NOTES.md', pc: ['notes.append'],
      title: 'Write decisions to notes',
      caption: 'Decisions and progress go to a file outside the window, so they survive compaction and even a restart.',
      text: [],
      payloadKind: 'Note',
      payload: { file: 'NOTES.md', added: '- Chosen: limit/offset, 50 per page, newest first. Done: API. Todo: tabs UI, tests.' }
    },
    {
      from: 'budget', to: 'harness', label: '164 000 / 200 000 tokens (82%)', pc: ['if tokens(ctx) > 0.8 * window'],
      title: 'The window is filling up',
      caption: 'After 40 tool calls the context is at 82%. Past the threshold, the harness compacts instead of waiting to overflow.',
      text: [],
      payloadKind: 'Budget',
      payload: { used: 164000, window: 200000, threshold: 0.8 },
      branch: { q: 'Over the threshold?', options: [ { label: 'yes: compact', goto: 'compact' }, { label: 'no: keep going', goto: 'cont' } ] }
    },
    {
      id: 'cont', path: 'cont', from: 'harness', to: 'llm', label: 'next turn with full history', pc: ['reply = llm(ctx)'],
      title: 'Other outcome: under budget',
      caption: 'Below the threshold, nothing is dropped and the next turn sees the full history.',
      text: [],
      payloadKind: 'Context',
      payload: { used: 92000, action: 'none' },
      next: 'end'
    },
    {
      id: 'compact', from: 'harness', to: 'llm', label: 'summarize turns 1–35 → 3 000 tokens', pc: ['ctx = [system_prompt, tool_defs, NOTES.md'],
      title: 'Compact: summarise and restart the window',
      caption: 'The model writes a summary of old turns that keeps decisions, open bugs and file names and drops raw tool outputs. The new context is system prompt + tools + notes + task + summary + the last 5 turns.',
      text: [],
      payloadKind: 'Context after compaction',
      payload: { before: 164000, after: 21000, kept: ['decisions', 'failing test', 'files touched'], dropped: ['old tool outputs', 'superseded plans'] }
    },
    {
      id: 'end', from: 'llm', to: 'user', label: 'PR ready: pagination + tests pass', pc: ['loop:'],
      title: 'The task finishes coherently',
      caption: 'Because decisions lived in notes and the summary, the agent still remembers "50 per page, newest first" two hours in.',
      text: [],
      payloadKind: 'Result',
      payload: { files_changed: 6, tests: '47 passed', total_model_calls: 58, peak_context: 164000 }
    }
  ],
  decisions: [
    { q: 'Load everything up front or just in time?', options: [
      { name: 'Just in time via tools', verdict: 'good', why: 'Only relevant tokens; the agent navigates like a person.' },
      { name: 'Pre-load whole repo / all docs', verdict: 'bad', why: 'Fills the window with noise and degrades attention.' },
      { name: 'Hybrid (a few key files up front)', verdict: 'ok', why: 'Faster start for small, known contexts.' } ] }
  ],
  refs: [
    { label: 'Anthropic Engineering: Effective context engineering for AI agents', url: 'https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents' },
    { label: 'Anthropic Engineering: Building effective agents', url: 'https://www.anthropic.com/engineering/building-effective-agents' },
    { label: 'Liu et al., Lost in the Middle: How Language Models Use Long Contexts (arXiv 2307.03172)', url: 'https://arxiv.org/abs/2307.03172' }
  ],
  verify: {
    checked: ['Context as a finite resource, context rot, just-in-time loading by reference, compaction, structured note-taking and sub-agents: Anthropic context engineering post.', 'Models use information in the middle of long contexts less well: Lost in the Middle.'],
    uncertain: ['Token counts, the 80% threshold and the task details are illustrative; harnesses choose their own thresholds.']
  }
});
