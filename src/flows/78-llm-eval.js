flow({
  id: 'llm-evaluation',
  title: 'LLM evaluation pipeline: offline evals, LLM-as-judge, CI gate',
  category: 'AI & machine learning',
  tags: ['Golden dataset', 'Code-based graders', 'LLM-as-judge', 'Position bias', 'Regression gate in CI', 'Online feedback'],
  summary: 'Changing a prompt or a model can silently break answers that worked yesterday. Follow a pull request that edits a support bot\'s prompt: CI runs it against a golden dataset, deterministic graders check format and facts, an LLM judge compares old and new answers (in both orders, to cancel position bias), and the merge is blocked because one category regressed.',
  requirements: {
    functional: ['Score every prompt, model or retrieval change on a fixed dataset before it ships.', 'Show which cases got better and worse.'],
    nonFunctional: ['Run in CI in under 10 minutes.', 'Judge agrees with humans on a calibration set before it is trusted.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'dev', label: 'Developer', sub: 'pull request', kind: 'client', icon: 'laptop', x: 0, y: 1, desc: 'Changes the system prompt.' },
    { id: 'ci', label: 'CI eval job', sub: 'GitHub Actions', kind: 'worker', icon: 'tool', x: 1, y: 1, desc: 'Runs the app with the old and new prompt on every case and collects scores.' },
    { id: 'gold', label: 'Golden dataset', sub: '320 cases', kind: 'db', icon: 'doc', x: 1, y: 0, desc: 'Real anonymised questions with expected facts, tags and sometimes reference answers. Grows from production failures.' },
    { id: 'app', label: 'App under test', sub: 'prompt + RAG + LLM', kind: 'ai', icon: 'robot', x: 2, y: 0, desc: 'The real pipeline, not the bare model.' },
    { id: 'grade', label: 'Code graders', sub: 'deterministic', kind: 'worker', icon: 'check', x: 3, y: 1, desc: 'Exact checks: valid JSON, required fact present, no forbidden phrase, latency, cost.' },
    { id: 'judge', label: 'LLM judge', sub: 'pairwise, rubric', kind: 'ai', icon: 'gauge', x: 2, y: 2, desc: 'A strong model compares two answers against a rubric. Each pair is judged in both orders.' }
  ],
  pseudo: `
for case in golden:
    old, new = app(case.q, prompt=MAIN), app(case.q, prompt=PR)
    case.code = graders(new, case.expect)          # json, facts, latency
    v1 = judge(case.q, A=old, B=new, rubric)
    v2 = judge(case.q, A=new, B=old, rubric)       # swap order
    case.pref = combine(v1, v2)                    # tie if they disagree
report = by_tag(golden)
if any(t.delta < -0.05 for t in report): fail("regression")`,
  steps: [
    {
      from: 'dev', to: 'ci', label: 'PR #212: shorter system prompt', pc: ['for case in golden'],
      title: 'A change triggers evals',
      caption: 'The developer shortens the system prompt to save tokens. CI starts the eval job, like unit tests for behaviour.',
      text: [],
      payloadKind: 'Diff',
      payload: { file: 'prompts/support.md', lines_removed: 14, tokens_saved_per_call: 310 }
    },
    {
      from: 'ci', to: 'gold', label: 'load 320 cases', pc: ['for case in golden'],
      title: 'Load the golden set',
      caption: 'Each case has a question, what a good answer must contain, and tags for slicing results.',
      text: [],
      payloadKind: 'Case',
      payload: { id: 'c_117', q: 'Can I return a mug after 40 days?', expect: { must_include: ['30 days'], must_not: ['yes'] }, tags: ['returns', 'policy'] }
    },
    {
      from: 'ci', to: 'app', label: 'run old + new prompt × 320', pc: ['old, new = app(case.q'],
      title: 'Run both versions',
      caption: 'The whole pipeline runs twice per case (retrieval included), with temperature 0 to reduce noise.',
      text: [],
      payloadKind: 'Outputs',
      payload: { case: 'c_117', old: 'Returns are accepted within 30 days, so after 40 days…', new: 'Sure, you can return it!' }
    },
    {
      from: 'app', to: 'grade', label: 'check facts, JSON, latency', pc: ['case.code = graders'],
      title: 'Deterministic graders first',
      caption: 'Cheap exact checks catch the obvious: the new answer misses "30 days" and says "yes". Code graders are fast and never disagree with themselves.',
      text: [],
      payloadKind: 'Grades',
      payload: { case: 'c_117', must_include_30_days: false, forbidden_yes: true, json_valid: true, pass: false }
    },
    {
      from: 'grade', to: 'judge', label: 'judge(A=old,B=new) and (A=new,B=old)', pc: ['v1 = judge', 'v2 = judge'],
      title: 'LLM-as-judge for what code cannot check',
      caption: 'Tone, helpfulness and completeness need judgment. The judge sees both answers and a rubric, twice with the order swapped; if the two verdicts disagree, it counts as a tie.',
      text: ['Zheng et al. (2023) found strong LLM judges such as GPT-4 match human preferences over 80% of the time, about the level of agreement between humans, and documented position, verbosity and self-enhancement biases.'],
      payloadKind: 'Judge verdicts',
      payload: { case: 'c_117', order_1: 'A (old) better: correct policy', order_2: 'B (old) better', combined: 'old wins' }
    },
    {
      from: 'judge', to: 'ci', label: 'report by tag', pc: ['report = by_tag'],
      title: 'Slice results by tag',
      caption: 'Averages hide regressions. Per tag: tone improved, but the "returns" category dropped 11 points, because the deleted lines held the return policy.',
      text: [],
      payloadKind: 'Report',
      payload: { overall_win_rate_new: 0.49, by_tag: { tone: '+0.06', shipping: '0.00', returns: '−0.11' }, cost_per_call: '−12%' },
      branch: { q: 'Any tag worse than −5 points?', options: [ { label: 'yes: block merge', goto: 'block' }, { label: 'no: allow merge', goto: 'ok' } ] }
    },
    {
      id: 'block', from: 'ci', to: 'dev', reply: true, label: '❌ returns −11 pts (7 failing cases)', pc: ['fail("regression")'],
      title: 'Block the merge with evidence',
      caption: 'The PR check fails and links the 7 failing cases side by side. The developer puts the return policy back in a shorter form and reruns.',
      text: [],
      payloadKind: 'PR check',
      payload: { status: 'failure', failing_cases: ['c_117', 'c_118', 'c_140', '…'] },
      next: 'online'
    },
    {
      id: 'ok', path: 'passes', from: 'ci', to: 'dev', reply: true, label: '✅ no regressions', pc: ['if any(t.delta'],
      title: 'Other outcome: merge allowed',
      caption: 'If every tag stays within the threshold, the check passes and the cheaper prompt ships.',
      text: [],
      payloadKind: 'PR check',
      payload: { status: 'success' },
      next: 'online'
    },
    {
      id: 'online', from: 'dev', to: 'gold', label: 'thumbs-down in prod → new golden cases', pc: ['for case in golden'],
      title: 'Close the loop with production',
      caption: 'After release, thumbs-down answers and support escalations are reviewed; real failures become new golden cases, so the same bug cannot come back silently.',
      text: [],
      payloadKind: 'New case',
      payload: { from: 'thumbs_down #8812', q: 'Do you ship to Switzerland?', added_tag: 'shipping' }
    }
  ],
  decisions: [
    { q: 'Absolute scores or pairwise?', options: [
      { name: 'Score 1–10', verdict: 'ok', why: 'Easy to track over time; judges drift and cluster scores.' },
      { name: 'Pairwise old vs new', verdict: 'good', why: 'More reliable for "is this change better?"; swap order to cancel position bias.' } ] }
  ],
  refs: [
    { label: 'Zheng et al. (2023): Judging LLM-as-a-judge with MT-Bench and Chatbot Arena', url: 'https://arxiv.org/abs/2306.05685' },
    { label: 'OpenAI Evals on GitHub', url: 'https://github.com/openai/evals' },
    { label: 'Anthropic docs: Create strong empirical evaluations', url: 'https://platform.claude.com/docs/en/test-and-evaluate/develop-tests' }
  ],
  verify: {
    checked: ['Over 80% agreement with humans, same as human–human; position, verbosity and self-enhancement biases: Zheng et al. abstract.'],
    uncertain: ['Thresholds, dataset size and scores are illustrative.']
  }
});
