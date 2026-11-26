flow({
  id: 'llm-observability',
  title: 'LLM observability: tracing an agent run end to end',
  category: 'AI & machine learning',
  tags: ['OpenTelemetry GenAI conventions', 'Spans per model and tool call', 'Token + cost metrics', 'TTFT', 'Prompt versions', 'Sampling + PII'],
  summary: 'When an agent gives a bad answer, you need to see every model call, tool call, prompt version and token count that led to it. Follow one request as each step emits an OpenTelemetry span with GenAI attributes, the spans form a trace, metrics roll up cost and latency, and an engineer finds the slow, failing tool call in the trace view.',
  requirements: {
    functional: ['See the full tree of model and tool calls for any request.', 'Cost and latency per model, per feature, per customer.'],
    nonFunctional: ['Tracing overhead < 1%.', 'Prompt and response content captured only when allowed, with PII redacted.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'user', label: 'User', sub: 'support chat', kind: 'client', icon: 'user', x: 0, y: 1, desc: 'Sends a message; gets a slow answer.' },
    { id: 'agent', label: 'Agent service', sub: 'OTel SDK', kind: 'service', icon: 'robot', x: 1, y: 1, desc: 'Instrumented: every LLM call and tool call is wrapped in a span.' },
    { id: 'llm', label: 'LLM provider', sub: 'chat API', kind: 'ai', icon: 'brain', x: 1, y: 0, desc: 'Returns usage (tokens) with each response.' },
    { id: 'tool', label: 'Tool: order API', sub: 'internal', kind: 'external', icon: 'api', x: 2, y: 2, desc: 'An internal API called by the agent.' },
    { id: 'col', label: 'OTel Collector', sub: 'batch, redact, sample', kind: 'worker', icon: 'filter', x: 2, y: 1, desc: 'Receives spans over OTLP, removes sensitive attributes, samples, forwards.' },
    { id: 'ui', label: 'Trace backend', sub: 'Jaeger / Langfuse', kind: 'db', icon: 'chart', x: 3, y: 1, desc: 'Stores traces, shows the span tree and dashboards.' }
  ],
  pseudo: `
with tracer.start_as_current_span("invoke_agent support") as root:
    with tracer.start_as_current_span(f"chat {model}") as s:
        s.set_attribute("gen_ai.operation.name", "chat")
        s.set_attribute("gen_ai.request.model", model)
        r = llm(messages, tools)
        s.set_attribute("gen_ai.usage.input_tokens", r.usage.input_tokens)
        s.set_attribute("gen_ai.usage.output_tokens", r.usage.output_tokens)
    with tracer.start_as_current_span("execute_tool lookup_order") as t:
        out = lookup_order("88125")                # child span, same trace_id`,
  steps: [
    {
      from: 'user', to: 'agent', label: 'message → root span, trace_id 4bf9…', pc: ['tracer.start_as_current_span("invoke_agent support")'],
      title: 'Start a trace',
      caption: 'The request opens a root span. Every span created inside it shares its trace id, so the whole run can be reassembled later.',
      text: [],
      payloadKind: 'Root span',
      payload: { trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', name: 'invoke_agent support', attributes: { 'gen_ai.operation.name': 'invoke_agent', 'app.customer_tier': 'pro' } }
    },
    {
      from: 'agent', to: 'llm', label: 'span "chat gpt-4o": tokens, finish reason', pc: ['f"chat {model}"', 'gen_ai.usage.input_tokens'],
      title: 'A span per model call',
      caption: 'The model call is a child span named "{operation} {model}" with standard attributes: provider, requested model, token usage, finish reasons. Standard names let any backend chart them.',
      text: ['OpenTelemetry\'s GenAI semantic conventions (status: Development) recommend the span name "{gen_ai.operation.name} {gen_ai.request.model}" and define attributes such as gen_ai.usage.input_tokens.'],
      payloadKind: 'Span',
      payload: { name: 'chat gpt-4o', duration_ms: 1210, attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'openai', 'gen_ai.request.model': 'gpt-4o', 'gen_ai.usage.input_tokens': 1840, 'gen_ai.usage.output_tokens': 41, 'gen_ai.response.finish_reasons': ['tool_calls'] } }
    },
    {
      from: 'agent', to: 'tool', label: 'span "execute_tool lookup_order": 6.2 s, timeout', pc: ['execute_tool lookup_order'],
      title: 'A span per tool call',
      caption: 'The tool call is its own child span. This one took 6.2 s and ended in a timeout: the reason the user waited.',
      text: [],
      payloadKind: 'Span',
      payload: { name: 'execute_tool lookup_order', duration_ms: 6200, status: 'ERROR', attributes: { 'gen_ai.tool.name': 'lookup_order', 'error.type': 'timeout' } }
    },
    {
      from: 'agent', to: 'col', async: true, label: 'OTLP export (batched)', pc: ['tracer.start_as_current_span'],
      title: 'Export to a collector',
      caption: 'Spans are batched and sent asynchronously over OTLP, so tracing does not slow the request.',
      text: [],
      payloadKind: 'Export',
      payload: { protocol: 'OTLP/gRPC', spans: 5, batch_ms: 5000 },
      branch: { q: 'Capture prompt and response text?', options: [ { label: 'no: metadata only (default)', goto: 'meta' }, { label: 'yes, redacted, for sampled traces', goto: 'content' } ] }
    },
    {
      id: 'content', path: 'content capture', from: 'col', to: 'col', label: 'redact emails/cards in gen_ai.input.messages', pc: ['tracer.start_as_current_span'],
      title: 'Other outcome: capture content carefully',
      caption: 'Prompt and completion text helps debugging but may contain personal data. If enabled, it is captured only for a sample and passed through redaction in the collector.',
      text: [],
      payloadKind: 'Redaction',
      payload: { attribute: 'gen_ai.input.messages', before: 'my email is j.doe@mail.be', after: 'my email is <EMAIL>', sample_rate: 0.05 },
      next: 'meta'
    },
    {
      id: 'meta', from: 'col', to: 'ui', label: 'store trace + roll up metrics', pc: ['gen_ai.usage.output_tokens'],
      title: 'Store and aggregate',
      caption: 'The backend stores the trace tree and aggregates token counts into cost per model and per feature, plus latency percentiles.',
      text: [],
      payloadKind: 'Dashboard',
      payload: { today: { requests: 41200, cost_eur: 312.4, p95_latency_s: 4.1 }, top_slow_span: 'execute_tool lookup_order (p95 5.8 s)' }
    },
    {
      from: 'ui', to: 'agent', label: 'engineer: add 2 s timeout + cache to lookup_order', pc: ['out = lookup_order'],
      title: 'Find and fix',
      caption: 'An engineer opens the slow trace, sees the tool span dominating, and fixes the tool, not the prompt. Without traces this looked like "the AI is slow".',
      text: [],
      payloadKind: 'Fix',
      payload: { change: 'timeout 2 s, cache 60 s', p95_after_s: 2.3 }
    }
  ],
  decisions: [
    { q: 'Generic APM or LLM-specific tool?', options: [
      { name: 'OTel + your APM', verdict: 'good', why: 'One trace across web, DB and LLM calls.' },
      { name: 'LLM tools (Langfuse, LangSmith)', verdict: 'good', why: 'Prompt versions, evals and content views built in; many accept OTel.' } ] }
  ],
  refs: [
    { label: 'OpenTelemetry: Semantic conventions for generative AI', url: 'https://opentelemetry.io/docs/specs/semconv/gen-ai/' },
    { label: 'OpenTelemetry GenAI conventions source (inference spans)', url: 'https://github.com/open-telemetry/semantic-conventions-genai' },
    { label: 'W3C Trace Context', url: 'https://www.w3.org/TR/trace-context/' },
    { label: 'Langfuse docs: Observability overview', url: 'https://langfuse.com/docs/observability/overview' }
  ],
  verify: {
    checked: ['Span name {gen_ai.operation.name} {gen_ai.request.model}; gen_ai.provider.name, gen_ai.request.model, gen_ai.usage.input_tokens/output_tokens, gen_ai.response.finish_reasons, gen_ai.input.messages; status Development: OTel GenAI inference conventions source file (read).'],
    uncertain: ['invoke_agent / execute_tool span names follow the agent and tool conventions in the same repo, not re-read in detail; values and timings are illustrative.']
  }
});
