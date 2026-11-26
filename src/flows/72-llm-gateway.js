flow({
  id: 'llm-gateway',
  title: 'LLM gateway: routing, budgets, retries and fallbacks',
  category: 'AI & machine learning',
  tags: ['One API for many providers', 'Virtual keys', 'Rate limits & budgets', 'Model routing', 'Retry + fallback', 'Cooldown', 'Cost logging'],
  summary: 'Once several teams call several model providers, companies put a gateway in front of them. Follow one request through a gateway like LiteLLM Proxy: the team\'s virtual key is checked against its budget, a router picks a deployment by load, the first provider returns 429, the gateway cools that deployment down and falls back to another model, and the token cost is logged to the team.',
  requirements: {
    functional: ['One OpenAI-compatible endpoint for every model the company uses.', 'Per-team keys, budgets and rate limits.', 'Automatic retry and fallback when a provider fails.'],
    nonFunctional: ['Adds < 20 ms of latency.', 'Provider API keys never leave the gateway.', 'Every call is attributed to a team for cost reports.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'app', label: 'Team app', sub: 'OpenAI SDK', kind: 'client', icon: 'laptop', x: 0, y: 1, desc: 'Calls the gateway exactly as if it were OpenAI, with a virtual key instead of a provider key.' },
    { id: 'gw', label: 'LLM gateway', sub: 'LiteLLM-style proxy', kind: 'edge', icon: 'shield', x: 1, y: 1, desc: 'Authenticates the virtual key, enforces limits, routes to a deployment, retries and falls back, translates request formats between providers.' },
    { id: 'redis', label: 'Redis', sub: 'limits + cooldowns', kind: 'cache', icon: 'cache', x: 1, y: 0, desc: 'Shared counters for requests/tokens per minute and the list of deployments currently cooling down, so all gateway replicas agree.' },
    { id: 'pa', label: 'Provider A', sub: 'gpt-4o, eu region', kind: 'external', icon: 'cloud', x: 3, y: 0, desc: 'Primary deployment for the "smart" model group.' },
    { id: 'pb', label: 'Provider B', sub: 'claude, fallback', kind: 'external', icon: 'cloud', x: 3, y: 2, desc: 'Fallback model group, configured for when the primary group fails.' },
    { id: 'logs', label: 'Spend DB', sub: 'Postgres', kind: 'db', icon: 'chart', x: 2, y: 2, desc: 'One row per call: team, model, tokens, cost, latency, status.' }
  ],
  pseudo: `
key = auth(req.headers["Authorization"])          # virtual key -> team
if spend[key.team] >= key.budget: return 400 "budget exceeded"
if not ratelimit.allow(key, tpm=req.est_tokens): return 429
for group in [req.model] + FALLBACKS[req.model]:
    for dep in router.pick(group, strategy="usage-based", skip=cooldown):
        try:
            resp = call(dep, translate(req, dep.provider))
            log_spend(key.team, dep, resp.usage); return resp
        except (RateLimit, Timeout, ServerError):
            fails[dep] += 1
            if fails[dep] > ALLOWED_FAILS: cooldown.add(dep, secs=60)
return 503`,
  steps: [
    {
      from: 'app', to: 'gw', label: 'POST /v1/chat/completions  model:"smart"', pc: ['key = auth'],
      title: 'A team calls one stable endpoint',
      caption: 'The app asks for the model alias "smart", not a provider model. The platform team can change what "smart" means without touching any app.',
      text: [],
      payloadKind: 'Request',
      payload: { headers: { Authorization: 'Bearer sk-team-search-…' }, body: { model: 'smart', messages: [{ role: 'user', content: 'Summarize this ticket…' }] } }
    },
    {
      from: 'gw', to: 'redis', label: 'check budget, RPM/TPM for team-search', pc: ['if spend[key.team] >= key.budget', 'ratelimit.allow'],
      title: 'Authenticate and enforce limits',
      caption: 'The virtual key maps to team-search: €2,000/month budget, €1,412 spent, 60k tokens per minute. Counters live in Redis so every gateway replica sees the same numbers.',
      text: [],
      payloadKind: 'Limits',
      payload: { team: 'search', budget_eur: 2000, spent_eur: 1412.3, tpm_limit: 60000, tpm_used: 18200, decision: 'allow' }
    },
    {
      from: 'gw', to: 'pa', label: 'route: least-used deployment of "smart"', pc: ['router.pick(group'],
      title: 'Pick a deployment',
      caption: '"smart" has two deployments of the same model in different regions. Usage-based routing picks the one with the most headroom under its own rate limit.',
      text: ['LiteLLM\'s router documents strategies such as simple-shuffle, least-busy, usage-based and latency-based routing.'],
      payloadKind: 'Routing',
      payload: { group: 'smart', deployments: [{ id: 'oai-eu', tpm_used: '71%' }, { id: 'oai-us', tpm_used: '93%' }], picked: 'oai-eu' }
    },
    {
      from: 'pa', to: 'gw', reply: true, label: '429 Too Many Requests', pc: ['except (RateLimit, Timeout, ServerError)'],
      title: 'The provider pushes back',
      caption: 'The provider returns 429. The gateway counts the failure for that deployment; after too many failures in a minute it puts the deployment in cooldown so no replica sends it traffic for a while.',
      text: [],
      payloadKind: 'Failure',
      payload: { status: 429, deployment: 'oai-eu', fails_this_minute: 4, allowed_fails: 3, action: 'cooldown 60 s' },
      branch: { q: 'Another deployment in the same group?', options: [ { label: 'no healthy one: fall back to next group', goto: 'fb' }, { label: 'yes: retry there', goto: 'retry' } ] }
    },
    {
      id: 'retry', path: 'retry same model', from: 'gw', to: 'pa', label: 'retry on oai-us', pc: ['for dep in router.pick'],
      title: 'Other outcome: retry another deployment',
      caption: 'If the other region had room, the gateway would retry the same model there and the app would never notice.',
      text: [],
      payloadKind: 'Retry',
      payload: { deployment: 'oai-us', attempt: 2 },
      next: 'log'
    },
    {
      id: 'fb', from: 'gw', to: 'pb', label: 'fallback "smart" → "smart-backup" (format translated)', pc: ['FALLBACKS[req.model]', 'translate(req, dep.provider)'],
      title: 'Fall back to another provider',
      caption: 'The other deployment is also near its limit, so the gateway moves to the configured fallback group on another provider, translating the OpenAI-format request into that provider\'s format.',
      text: [],
      payloadKind: 'Fallback request',
      payload: { from_group: 'smart', to_group: 'smart-backup', provider_format: 'Anthropic Messages', max_tokens_added: 1024 }
    },
    {
      id: 'log', from: 'gw', to: 'logs', async: true, label: 'INSERT spend row', pc: ['log_spend'],
      title: 'Attribute the cost',
      caption: 'The response usage is priced with the provider\'s rates and logged against the team. Budgets, dashboards and alerts read from this table.',
      text: [],
      payloadKind: 'Spend row',
      payload: { team: 'search', model: 'smart-backup', input_tokens: 1830, output_tokens: 210, cost_eur: 0.0087, latency_ms: 1420, fallback: true }
    },
    {
      from: 'gw', to: 'app', reply: true, label: '200, OpenAI format', pc: ['return resp'],
      title: 'The app gets a normal answer',
      caption: 'The reply is translated back to the OpenAI shape. A response header tells which model actually answered, for debugging.',
      text: [],
      payloadKind: 'Response',
      payload: { model: 'smart-backup', choices: [{ message: { role: 'assistant', content: 'The customer reports…' } }], headers: { 'x-litellm-model-group': 'smart-backup' } }
    }
  ],
  decisions: [
    { q: 'Build or buy?', options: [
      { name: 'Open-source proxy (LiteLLM, Envoy AI Gateway)', verdict: 'good', why: 'Self-hosted, keys stay in your network.' },
      { name: 'Managed (Cloudflare AI Gateway, Portkey)', verdict: 'good', why: 'Less to run; traffic goes through a third party.' } ] }
  ],
  refs: [
    { label: 'LiteLLM docs: Router, load balancing and routing strategies', url: 'https://docs.litellm.ai/docs/routing' },
    { label: 'LiteLLM docs: Proxy fallbacks, retries and timeouts', url: 'https://docs.litellm.ai/docs/proxy/reliability' },
    { label: 'Cloudflare AI Gateway docs', url: 'https://developers.cloudflare.com/ai-gateway/' },
    { label: 'ByteByteGo: Design a rate limiter (book chapter overview)', url: 'https://bytebytego.com/courses/system-design-interview/design-a-rate-limiter' }
  ],
  verify: {
    checked: ['Routing strategies, allowed_fails and cooldown of failing deployments, fallbacks between model groups, Redis for shared state across instances: LiteLLM routing and reliability docs (read).'],
    uncertain: ['Budgets, percentages, header names and costs are illustrative.']
  }
});
