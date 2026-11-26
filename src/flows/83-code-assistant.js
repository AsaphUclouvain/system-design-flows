flow({
  id: 'code-assistant',
  title: 'Code assistant: inline completion and the coding agent loop',
  category: 'AI & machine learning',
  tags: ['Prompt assembly from IDE context', 'Fill-in-the-middle (prefix/suffix)', 'Neighboring tabs', 'Debounce + cancel', 'Repo indexing', 'Agent edits + tests', 'Sandboxed execution'],
  summary: 'Two products share one engine. Inline completion must answer in a few hundred milliseconds from whatever is around the cursor; a coding agent can take minutes, search the repo, edit files and run tests. Follow a keystroke through Copilot-style completion (prefix, suffix, snippets from open tabs), then a "fix this failing test" request through an agent that reads, edits, runs and retries in a sandbox.',
  requirements: {
    functional: ['Suggest the rest of a line or block as the developer types.', 'Carry out a multi-file change on request and prove it with tests.'],
    nonFunctional: ['Completion visible within ~300 ms; stale requests cancelled.', 'Agent runs code only in a sandbox; never pushes without the developer.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'ide', label: 'IDE extension', sub: 'VS Code', kind: 'client', icon: 'laptop', x: 0, y: 1, desc: 'Watches edits, open tabs and cursor position; shows ghost text and agent diffs.' },
    { id: 'ctx', label: 'Prompt builder', sub: 'context selection', kind: 'service', icon: 'filter', x: 1, y: 1, desc: 'Chooses what fits in the prompt: code before and after the cursor, matching snippets from other open files, imports, file path and language.' },
    { id: 'cm', label: 'Completion model', sub: 'small, fast, FIM', kind: 'ai', icon: 'spark', x: 2, y: 0, desc: 'A model trained for fill-in-the-middle: given a prefix and a suffix, generate what goes between.' },
    { id: 'idx', label: 'Repo index', sub: 'embeddings + symbols', kind: 'db', icon: 'vector', x: 1, y: 2, desc: 'Chunks of the codebase with embeddings and a symbol table, so the agent can find relevant files by meaning or by name.' },
    { id: 'agent', label: 'Agent model', sub: 'large, tool use', kind: 'ai', icon: 'brain', x: 2, y: 2, desc: 'Plans and calls tools: search, read_file, edit_file, run_command.' },
    { id: 'box', label: 'Sandbox', sub: 'container, no secrets', kind: 'worker', icon: 'box', x: 3, y: 1, desc: 'Where commands and tests run, isolated from the developer\'s credentials and the network where possible.' }
  ],
  pseudo: `
# inline completion
on_keystroke(debounce_ms=75):
    cancel(pending)
    prompt = {path, lang, snippets: jaccard_top(open_tabs, window), prefix, suffix}
    pending = complete(fim(prompt), max_tokens=64, stop=["\\n\\n"])
# agent
def agent(task):
    while not done:
        act = llm(task, history, tools=[search, read_file, edit_file, run])
        obs = sandbox.exec(act)            # tests, linters
        history.append((act, obs))
    return diff_for_review()`,
  steps: [
    {
      from: 'ide', to: 'ctx', label: 'keystroke in pagination.py line 41', pc: ['on_keystroke(debounce_ms=75)', 'cancel(pending)'],
      title: 'A keystroke, debounced',
      caption: 'Sending a request on every key would waste money and return stale text. The extension waits ~75 ms of quiet and cancels any request still in flight.',
      text: [],
      payloadKind: 'Editor state',
      payload: { file: 'api/pagination.py', cursor: { line: 41, col: 8 }, typed: 'offset = ', open_tabs: ['api/chapters.py', 'tests/test_pagination.py'] }
    },
    {
      from: 'ctx', to: 'cm', label: 'FIM prompt: <prefix> … <suffix> … <middle>', pc: ['prompt = {path', 'fim(prompt)'],
      title: 'Assemble the prompt: prefix, suffix, neighbors',
      caption: 'The builder sends the code before the cursor (prefix), the code after it (suffix), and snippets from open tabs that look similar to the code near the cursor. The model fills the middle.',
      text: ['GitHub describes this: a "prompt library" that selects and prioritises context, neighboring tabs to include matching code from other open files, and Fill-in-the-Middle so the model knows the prefix and the suffix.'],
      payloadKind: 'Prompt (abridged)',
      payload: { path: 'api/pagination.py', snippet_from: 'api/chapters.py: page_size = 50', prefix: 'def page_bounds(page: int, size: int = 50):\n    offset = ', suffix: '\n    return offset, offset + size' }
    },
    {
      from: 'cm', to: 'ide', reply: true, label: 'ghost text: "(page - 1) * size"', pc: ['pending = complete'],
      title: 'Show the suggestion',
      caption: '14 tokens in 180 ms. The suggestion appears in grey; Tab accepts it. Acceptance and later edits are logged (anonymously) to measure quality.',
      text: [],
      payloadKind: 'Completion',
      payload: { text: '(page - 1) * size', latency_ms: 180, accepted: true }
    },
    {
      from: 'ide', to: 'agent', label: '"test_last_page fails, fix it"', pc: ['def agent(task)'],
      title: 'Now a bigger request for the agent',
      caption: 'The developer asks the agent mode to fix a failing test. This needs the repo, not just the open file, and proof that the fix works.',
      text: [],
      payloadKind: 'Task',
      payload: { task: 'tests/test_pagination.py::test_last_page fails, fix it', repo: 'madgate', branch: 'fix/last-page' }
    },
    {
      from: 'agent', to: 'idx', label: 'search("page_bounds usages")', pc: ['act = llm(task'],
      title: 'Find the relevant code',
      caption: 'The agent searches the index by meaning and by symbol, then reads the three files that matter instead of the whole repo.',
      text: [],
      payloadKind: 'Search result',
      payload: { hits: ['api/pagination.py:page_bounds', 'api/chapters.py:list_chapters', 'tests/test_pagination.py:test_last_page'] }
    },
    {
      from: 'agent', to: 'box', label: 'run: pytest -q tests/test_pagination.py', pc: ['obs = sandbox.exec(act)'],
      title: 'Reproduce in the sandbox',
      caption: 'Before editing, the agent runs the test to see the real failure: the last page returns an empty list when the total is a multiple of 50.',
      text: [],
      payloadKind: 'Observation',
      payload: 'FAILED tests/test_pagination.py::test_last_page\nassert len(chapters) == 50\nE  assert 0 == 50\n1 failed, 7 passed in 0.41s',
      branch: { q: 'After editing, do the tests pass?', options: [ { label: 'first try: no, edit again', goto: 'retry' }, { label: 'yes: show diff', goto: 'review' } ] }
    },
    {
      id: 'retry', from: 'agent', to: 'box', label: 'edit_file(chapters.py) → pytest: 8 passed', pc: ['history.append((act, obs))'],
      title: 'Edit, run, read, repeat',
      caption: 'The first edit fixes one off-by-one but breaks another test; the agent reads the new failure and corrects the page-count formula to ceil(total / size). Second run: 8 passed.',
      text: ['Running tests is what turns a plausible edit into a verified one. Agents that cannot execute code can only guess.'],
      payloadKind: 'Runs',
      payload: [{ edit: 'pages = total // size', result: '1 failed' }, { edit: 'pages = -(-total // size)', result: '8 passed' }]
    },
    {
      id: 'review', from: 'agent', to: 'ide', reply: true, label: 'diff for review (+2 −1), not pushed', pc: ['return diff_for_review()'],
      title: 'Hand back a diff, not a push',
      caption: 'The developer sees the diff, the test output and the reasoning, and decides whether to commit. The agent never had push rights.',
      text: [],
      payloadKind: 'Diff',
      payload: '--- a/api/chapters.py\n+++ b/api/chapters.py\n-    pages = total // size\n+    pages = -(-total // size)  # ceil\n'
    }
  ],
  decisions: [
    { q: 'Which model for which job?', options: [
      { name: 'Small FIM model for completion', verdict: 'great', why: 'Latency matters more than depth; runs on every pause.' },
      { name: 'Large tool-using model for agent tasks', verdict: 'great', why: 'Minutes are fine; needs planning and tool use.' } ] }
  ],
  refs: [
    { label: 'GitHub blog: How GitHub Copilot is getting better at understanding your code', url: 'https://github.blog/ai-and-ml/github-copilot/how-github-copilot-is-getting-better-at-understanding-your-code/' },
    { label: 'Bavarian et al. (2022): Efficient training of LMs to fill in the middle', url: 'https://arxiv.org/abs/2207.14255' },
    { label: 'Claude Code docs: Best practices', url: 'https://code.claude.com/docs/en/best-practices' },
    { label: 'Jimenez et al. (2023): SWE-bench', url: 'https://arxiv.org/abs/2310.06770' }
  ],
  verify: {
    checked: ['Prompt library, neighboring tabs, prefix/suffix and FIM: GitHub blog post (read).', 'FIM training by moving a span from the middle to the end: Bavarian et al. abstract.'],
    uncertain: ['Debounce time, latencies and the example bug are illustrative.']
  }
});
