flow({
  id: 'coding-agent-eval',
  title: 'Evaluating AI coding agents (SWE-bench style)',
  category: 'AI & machine learning',
  tags: ['Real GitHub issues', 'Isolated Docker environment', 'Agent produces a patch', 'Hidden tests', 'FAIL_TO_PASS / PASS_TO_PASS', '% resolved', 'Human-verified subset'],
  summary: 'How do labs measure whether a coding agent can actually fix bugs? SWE-bench takes real GitHub issues whose fix came with tests. The agent gets the repository at the commit before the fix and the issue text, works in a sandbox, and produces a patch. Hidden tests decide: the tests the real fix made pass must now pass, and the tests that already passed must still pass. Follow one task through the harness.',
  requirements: {
    functional: ['Run an agent on hundreds of real repository tasks.', 'Score each task automatically and report % resolved.'],
    nonFunctional: ['Reproducible: same environment every run.', 'Agent never sees the tests used to grade it.', 'Tasks must be solvable and fairly specified.']
  },
  grid: { cols: 5, rows: 3 },
  nodes: [
    { id: 'ds', label: 'Task dataset', sub: 'issue + repo + tests', kind: 'db', icon: 'db', x: 0, y: 1, desc: 'Each task: repository, base commit, issue text, the real fix (hidden), and its tests (hidden).' },
    { id: 'harness', label: 'Eval harness', sub: 'orchestrator', kind: 'service', icon: 'split', x: 1, y: 1, desc: 'Starts a container per task, runs the agent, applies its patch, runs the tests, records the result.' },
    { id: 'box', label: 'Sandbox', sub: 'Docker image per repo', kind: 'storage', icon: 'box', x: 2, y: 0, desc: 'The repository checked out at the base commit with dependencies installed.' },
    { id: 'agent', label: 'Coding agent', sub: 'LLM + tools', kind: 'ai', icon: 'robot', x: 2, y: 2, desc: 'Reads the issue, explores, edits files, may run its own tests, and outputs a diff.' },
    { id: 'tests', label: 'Hidden tests', sub: 'FAIL_TO_PASS + PASS_TO_PASS', kind: 'worker', icon: 'check', x: 3, y: 1, desc: 'Run after the agent finishes. Never shown to the agent.' },
    { id: 'board', label: 'Results', sub: '% resolved', kind: 'client', icon: 'chart', x: 4, y: 0, desc: 'Aggregates pass/fail across all tasks into a score.' }
  ],
  pseudo: `
for task in dataset:                          # e.g. 500 human-verified tasks
    box = docker.run(image_for(task.repo), checkout=task.base_commit)
    patch = agent.solve(box, task.issue_text, step_limit=250)
    box.apply(patch)
    f2p = box.run(task.FAIL_TO_PASS)   # tests the real fix made pass
    p2p = box.run(task.PASS_TO_PASS)   # tests that must keep passing
    resolved[task] = all(f2p) and all(p2p)
score = mean(resolved)`,
  steps: [
    {
      from: 'ds', to: 'harness', label: 'task astropy__astropy-12907', pc: ['for task in dataset'],
      title: 'Pick a task built from a real issue',
      caption: 'Each SWE-bench task comes from a resolved GitHub issue in one of 12 popular Python repositories. The pull request that fixed it included tests that failed before the fix and pass after.',
      text: ['The original SWE-bench has 2,294 tasks. OpenAI and the SWE-bench authors released SWE-bench Verified, 500 tasks that human annotators checked were well specified and fairly tested.'],
      payloadKind: 'Task',
      payload: { instance_id: 'astropy__astropy-12907', repo: 'astropy/astropy', base_commit: 'd16bfe0…', issue: 'Modeling\'s separability_matrix does not compute separability correctly for nested CompoundModels', hidden: ['patch', 'tests'] }
    },
    {
      from: 'harness', to: 'box', label: 'docker run, checkout base commit', pc: ['box = docker.run'],
      title: 'Start an isolated, reproducible sandbox',
      caption: 'A pre-built image has the repository at the base commit with the exact dependencies, so every agent is graded in the same environment.',
      text: [],
      payloadKind: 'Container',
      payload: { image: 'sweb.eval.x86_64.astropy__astropy-12907', network: 'restricted', cpu: 2, mem_gb: 8 }
    },
    {
      from: 'harness', to: 'agent', label: 'issue text + shell in the sandbox', pc: ['patch = agent.solve'],
      title: 'The agent works on the issue',
      caption: 'The agent reads the issue, searches the code, reproduces the bug with a small script, edits the function and re-runs its script. It never sees the hidden tests.',
      text: [],
      payloadKind: 'Agent trajectory (excerpt)',
      payload: [{ step: 3, action: 'grep -rn "def separability_matrix" astropy/modeling' }, { step: 7, action: 'python repro.py → wrong matrix' }, { step: 12, action: 'edit separable.py _cstack' }, { step: 14, action: 'python repro.py → correct' }]
    },
    {
      from: 'agent', to: 'harness', label: 'diff: 1 file, +1 −1', pc: ['box.apply(patch)'],
      title: 'The output is a patch',
      caption: 'Only the diff is graded, not the explanation. The harness applies it to a clean checkout.',
      text: [],
      payloadKind: 'Patch',
      payload: { files: ['astropy/modeling/separable.py'], diff: '-        cright[-right.shape[0]:, -right.shape[1]:] = 1\n+        cright[-right.shape[0]:, -right.shape[1]:] = right' },
      branch: { q: 'Does the patch apply cleanly?', options: [ { label: 'yes: run tests', goto: 'run' }, { label: 'no: task fails', goto: 'noapply' } ] }
    },
    {
      id: 'noapply', path: 'noapply', from: 'harness', to: 'board', label: 'patch failed to apply → unresolved', pc: ['resolved[task] ='],
      title: 'Other outcome: broken patch',
      caption: 'A malformed diff, or one against the wrong lines, counts as unresolved. No partial credit.',
      text: [],
      payloadKind: 'Result',
      payload: { instance_id: 'django__django-11099', resolved: false, reason: 'patch_apply_failed' },
      next: 'score'
    },
    {
      id: 'run', from: 'harness', to: 'tests', label: 'run FAIL_TO_PASS (2) + PASS_TO_PASS (13)', pc: ['f2p = box.run', 'p2p = box.run'],
      title: 'Run the hidden tests',
      caption: 'FAIL_TO_PASS tests failed before the real fix and passed after: they check the bug is fixed. PASS_TO_PASS tests passed before and after: they check nothing else broke.',
      text: [],
      payloadKind: 'Test results',
      payload: { FAIL_TO_PASS: { total: 2, passed: 2 }, PASS_TO_PASS: { total: 13, passed: 13 } },
      branch: { q: 'All tests pass?', options: [ { label: 'yes: resolved', goto: 'ok' }, { label: 'no: a regression', goto: 'reg' } ] }
    },
    {
      id: 'reg', path: 'reg', from: 'tests', to: 'board', label: 'F2P 2/2 but P2P 12/13 → unresolved', pc: ['all(f2p) and all(p2p)'],
      title: 'Other outcome: fixed the bug, broke something else',
      caption: 'Another agent\'s patch fixes the bug but breaks an existing test. That counts as unresolved, just like a real reviewer would reject it.',
      text: [],
      payloadKind: 'Result',
      payload: { FAIL_TO_PASS: '2/2', PASS_TO_PASS: '12/13', resolved: false },
      next: 'score'
    },
    {
      id: 'ok', from: 'tests', to: 'board', label: 'resolved ✓', pc: ['resolved[task] ='],
      title: 'Resolved',
      caption: 'Both groups pass: this task counts as resolved.',
      text: [],
      payloadKind: 'Result',
      payload: { instance_id: 'astropy__astropy-12907', resolved: true }
    },
    {
      id: 'score', from: 'harness', to: 'board', label: '500 tasks → % resolved', pc: ['score = mean(resolved)'],
      title: 'Aggregate into a score',
      caption: 'The headline number is the share of tasks resolved. Results depend on the whole agent (model, tools, step limit), so leaderboards list the scaffold too.',
      text: [],
      payloadKind: 'Score',
      payload: { tasks: 500, resolved: 311, score: '62.2%', note: 'illustrative number, not a real model\'s result' }
    }
  ],
  decisions: [
    { q: 'How to grade a coding agent?', options: [
      { name: 'Hidden execution tests (fail-to-pass + pass-to-pass)', verdict: 'good', why: 'Objective and close to what a reviewer checks.' },
      { name: 'Compare text with the reference patch', verdict: 'bad', why: 'Many correct fixes look different.' },
      { name: 'LLM-as-judge on the diff', verdict: 'ok', why: 'Useful for style and tasks without tests; less reliable for correctness.' } ] }
  ],
  refs: [
    { label: 'Jimenez et al., SWE-bench: Can Language Models Resolve Real-World GitHub Issues? (arXiv 2310.06770)', url: 'https://arxiv.org/abs/2310.06770' },
    { label: 'OpenAI: Introducing SWE-bench Verified', url: 'https://openai.com/index/introducing-swe-bench-verified/' },
    { label: 'SWE-bench site and leaderboards', url: 'https://www.swebench.com/' },
    { label: 'SWE-bench GitHub repository (harness, Docker images)', url: 'https://github.com/SWE-bench/SWE-bench' },
    { label: 'Hugging Face: SWE-bench Verified dataset', url: 'https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified' }
  ],
  verify: {
    checked: ['2,294 tasks from real GitHub issues and PRs: SWE-bench paper.', '500 human-verified tasks, 12 Python repositories, FAIL_TO_PASS and PASS_TO_PASS tests hidden from the agent: OpenAI SWE-bench Verified post.'],
    uncertain: ['The task, base commit, one-line fix and test counts (2 FAIL_TO_PASS, 13 PASS_TO_PASS) are the real astropy__astropy-12907 instance from the SWE-bench Verified dataset; the agent trajectory, the other two tasks\' outcomes and the final score are illustrative.']
  }
});
