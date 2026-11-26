flow({
  id: 'llm-guardrails',
  title: 'Guardrails: input and output checks around an LLM',
  category: 'AI & machine learning',
  tags: ['Input classification', 'Safety taxonomy', 'PII redaction', 'Output moderation', 'Schema validation', 'Fail closed vs open', 'Latency budget'],
  summary: 'A production LLM call is wrapped in checks that run before and after the model. Follow a message through a guardrail pipeline: cheap rules and a PII redactor first, a safety classifier such as Llama Guard on the input, the LLM, then the same classifier and a JSON schema check on the output, with a block, a rewrite and a pass shown as branches.',
  requirements: {
    functional: ['Refuse unsafe requests by category (self-harm, weapons, hate, …) per the product\'s policy.', 'Never send raw personal data to a third-party model.', 'Only return output that matches the expected format.'],
    nonFunctional: ['Guardrails add < 150 ms at p95.', 'Every block is logged with its category for review.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'user', label: 'User', sub: 'chat', kind: 'client', icon: 'user', x: 0, y: 1, desc: 'Sends a message.' },
    { id: 'rules', label: 'Rules + PII redactor', sub: 'regex, NER', kind: 'edge', icon: 'filter', x: 1, y: 1, desc: 'Fast deterministic checks: size limits, blocked terms, and detection of emails, phone numbers and card numbers, which are replaced with placeholders.' },
    { id: 'cls', label: 'Safety classifier', sub: 'Llama Guard-style', kind: 'ai', icon: 'shield', x: 1, y: 0, desc: 'A small LLM fine-tuned to label a prompt or a response as safe or unsafe, with the violated categories from a taxonomy.' },
    { id: 'llm', label: 'Main LLM', sub: 'the product model', kind: 'ai', icon: 'brain', x: 2, y: 1, desc: 'Generates the answer. Has its own safety training, but the app does not rely on it alone.' },
    { id: 'val', label: 'Output validator', sub: 'schema + moderation', kind: 'worker', icon: 'check', x: 3, y: 1, desc: 'Checks the answer against a JSON Schema and runs the safety classifier on the response.' },
    { id: 'log', label: 'Review queue', sub: 'trust & safety', kind: 'db', icon: 'log', x: 3, y: 2, desc: 'Blocked items with category and score, sampled for human review to tune thresholds.' }
  ],
  pseudo: `
text, pii = redact(msg)                       # "email me at <EMAIL_1>"
if rules.blocked(text): return refuse("rules")
v = guard.classify(role="user", text=text)
if v.unsafe: log(v); return refuse(v.categories)
out = llm(SYSTEM, text)
v2 = guard.classify(role="agent", text=out, context=text)
if v2.unsafe: log(v2); return refuse(v2.categories)
if not schema.valid(out): out = llm.repair(out, schema)   # one retry
return restore(out, pii)                      # put the email back`,
  steps: [
    {
      from: 'user', to: 'rules', label: '"What\'s the max dose of X? I\'m j.doe@mail.be"', pc: ['text, pii = redact(msg)'],
      title: 'Deterministic checks and redaction',
      caption: 'Cheap checks go first because they cost microseconds. The email address is replaced with a placeholder and kept server-side, so it never reaches the model provider.',
      text: [],
      payloadKind: 'After redaction',
      payload: { text: 'What\'s the max dose of X? I\'m <EMAIL_1>', pii_map: { EMAIL_1: '(kept server-side)' }, rules_hit: [] }
    },
    {
      from: 'rules', to: 'cls', label: 'classify(role=user)', pc: ['v = guard.classify(role="user"'],
      title: 'Classify the input',
      caption: 'The safety classifier reads the prompt with the policy\'s category list and answers "safe" or "unsafe" plus categories. Here: safe, a medical-information question.',
      text: ['Llama Guard is a Llama 2 7B model instruction-tuned on a safety risk taxonomy; it classifies both prompts and responses, and its categories can be customised through the instructions.'],
      payloadKind: 'Classifier output',
      payload: { verdict: 'safe', categories: [], p_unsafe: 0.04, latency_ms: 38 },
      branch: { q: 'Input unsafe?', options: [ { label: 'no: call the model', goto: 'gen' }, { label: 'yes: refuse', goto: 'block' } ] }
    },
    {
      id: 'block', path: 'blocked input', from: 'cls', to: 'log', label: 'unsafe: S9 weapons → refuse + log', pc: ['if v.unsafe: log(v); return refuse'],
      title: 'Other outcome: block before the model',
      caption: 'A request for weapon instructions would be labelled unsafe with its category. The user gets a fixed refusal; the main model is never called, which also saves its cost.',
      text: [],
      payloadKind: 'Block record',
      payload: { verdict: 'unsafe', categories: ['S9'], action: 'refuse', model_called: false },
      next: 'end'
    },
    {
      id: 'gen', from: 'cls', to: 'llm', label: 'system prompt + redacted text', pc: ['out = llm(SYSTEM, text)'],
      title: 'Generate',
      caption: 'The main model answers in the required JSON shape. It sees <EMAIL_1>, not the real address.',
      text: [],
      payloadKind: 'Model output',
      payload: { answer: 'The label says the maximum is 3 g per day for adults…', see_doctor: true, sources: ['leaflet'] }
    },
    {
      from: 'llm', to: 'val', label: 'classify(role=agent) + JSON Schema', pc: ['v2 = guard.classify(role="agent"', 'schema.valid(out)'],
      title: 'Check the output',
      caption: 'The response is classified in the context of the prompt (a response can be unsafe even when the prompt was not), then validated against the schema.',
      text: ['Libraries such as NVIDIA NeMo Guardrails and Guardrails AI package these input and output "rails" so they can be configured instead of hand-coded.'],
      payloadKind: 'Checks',
      payload: { safety: 'safe', schema_errors: ['missing required field "disclaimer"'] },
      branch: { q: 'Valid?', options: [ { label: 'schema error: repair once', goto: 'fix' }, { label: 'unsafe: refuse', goto: 'block2' } ] }
    },
    {
      id: 'block2', path: 'blocked output', from: 'val', to: 'log', label: 'unsafe response → refuse + log', pc: ['if v2.unsafe'],
      title: 'Other outcome: block the answer',
      caption: 'If the model had produced unsafe content despite a safe prompt, the response is dropped and logged; the user sees a refusal.',
      text: [],
      payloadKind: 'Block record',
      payload: { stage: 'output', categories: ['S6'], action: 'refuse' },
      next: 'end'
    },
    {
      id: 'fix', from: 'val', to: 'llm', label: 'repair: add "disclaimer" field', pc: ['out = llm.repair(out, schema)'],
      title: 'Repair the format once',
      caption: 'The validator sends the error back for one repair attempt. If it fails again, the app returns a safe generic error instead of broken JSON.',
      text: [],
      payloadKind: 'Repaired',
      payload: { answer: '…', see_doctor: true, disclaimer: 'Not medical advice.', valid: true }
    },
    {
      id: 'end', from: 'val', to: 'user', reply: true, label: 'answer with email restored', pc: ['return restore(out, pii)'],
      title: 'Return',
      caption: 'Placeholders are swapped back for the real values before the answer reaches the user. Total guardrail time: 38 + 41 ms plus the redactor.',
      text: [],
      payloadKind: 'Timing',
      payload: { redact_ms: 2, input_guard_ms: 38, llm_ms: 1650, output_guard_ms: 41, repair_ms: 900 }
    }
  ],
  decisions: [
    { q: 'If the classifier is down?', options: [
      { name: 'Fail closed (refuse)', verdict: 'good', why: 'Safest for high-risk products (health, kids).' },
      { name: 'Fail open (skip check)', verdict: 'ok', why: 'Keeps the product up; acceptable only for low-risk use, with alerts.' } ] },
    { q: 'Run guards in series or in parallel with the LLM?', options: [
      { name: 'Series', verdict: 'good', why: 'Never pays for a blocked call; adds latency.' },
      { name: 'Parallel, cancel on block', verdict: 'good', why: 'Hides input-guard latency; wastes some LLM calls.' } ] }
  ],
  refs: [
    { label: 'Inan et al. (2023): Llama Guard, LLM-based input-output safeguard', url: 'https://arxiv.org/abs/2312.06674' },
    { label: 'NVIDIA NeMo Guardrails on GitHub', url: 'https://github.com/NVIDIA-NeMo/Guardrails' },
    { label: 'OpenAI docs: Moderation', url: 'https://platform.openai.com/docs/guides/moderation' },
    { label: 'OWASP Top 10 for LLM applications', url: 'https://genai.owasp.org/llm-top-10/' }
  ],
  verify: {
    checked: ['Prompt and response classification against a safety taxonomy; Llama2-7b instruction-tuned; customisable categories: Llama Guard abstract.'],
    uncertain: ['Category codes (S6, S9) follow the later Llama Guard 3 style and are illustrative.', 'Latencies, scores and the dosage example are illustrative, not medical information.']
  }
});
