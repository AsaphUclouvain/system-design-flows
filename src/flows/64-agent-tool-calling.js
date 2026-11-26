flow({
  id: 'agent-tool-calling',
  title: 'AI agent with tool calling: the agent loop',
  category: 'AI & machine learning',
  tags: ['Agent loop', 'Tool schemas (JSON Schema)', 'tool_use / tool_result', 'Human approval', 'Idempotent side effects', 'Max-turn limit'],
  summary: 'An LLM cannot touch your database or call your payment API. It can only ask. Follow a support agent as the model asks for an order lookup, your backend runs it, the model asks for a refund, a human approves it, and the loop ends with a final answer. The model decides what to do next; your code decides what is allowed.',
  requirements: {
    functional: ['Answer a customer and take actions (look up an order, refund it) through tools.', 'Money-moving actions above a limit need a human approval.'],
    nonFunctional: ['The model never gets credentials: tools run in your backend with your permissions.', 'Bounded: at most 10 model turns per request.', 'Every tool call is logged and side effects are idempotent, so a retry cannot refund twice.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'user', label: 'Customer', sub: 'support chat', kind: 'client', icon: 'user', x: 0, y: 1, desc: 'Types a request in the help widget.' },
    { id: 'app', label: 'Agent runtime', sub: 'your FastAPI backend', kind: 'service', icon: 'robot', x: 1, y: 1, desc: 'Runs the loop: send messages + tool definitions to the model, execute the tool calls it asks for, send the results back, repeat until the model stops asking. Holds the credentials and the policy.' },
    { id: 'llm', label: 'LLM', sub: 'Messages API', kind: 'ai', icon: 'brain', x: 1, y: 0, desc: 'Reads the conversation and the tool list, and replies either with text or with a structured request to call a tool. It never executes anything.' },
    { id: 'db', label: 'Orders DB', sub: 'PostgreSQL', kind: 'db', icon: 'db', x: 3, y: 0, desc: 'Behind the lookup_order tool, through a read-only role.' },
    { id: 'pay', label: 'Payments API', sub: 'Stripe-like', kind: 'external', icon: 'card', x: 3, y: 2, desc: 'Behind the issue_refund tool. Accepts an Idempotency-Key header.' },
    { id: 'human', label: 'Support lead', sub: 'approval queue', kind: 'client', icon: 'check', x: 1, y: 2, desc: 'Approves or rejects actions that policy says a human must see.' }
  ],
  pseudo: `
def run_agent(messages, max_turns=10):
    for turn in range(max_turns):
        resp = llm.create(model=M, messages=messages, tools=TOOLS)
        messages.append({"role": "assistant", "content": resp.content})
        if resp.stop_reason != "tool_use":
            return resp.text                       # final answer
        results = []
        for call in resp.tool_calls:
            if needs_approval(call): wait_for_human(call)
            out = TOOL_IMPL[call.name](**call.input)  # your code runs it
            results.append({"type": "tool_result", "tool_use_id": call.id, "content": out})
        messages.append({"role": "user", "content": results})
    raise TooManyTurns()`,
  steps: [
    {
      from: 'user', to: 'app', label: '"Order 88125 arrived broken. Refund?"', pc: ['def run_agent'],
      title: 'A request that needs actions',
      caption: 'The customer asks for a refund. Answering needs data (the order) and an action (the refund), neither of which the model can reach by itself.',
      text: ['Anthropic\'s "Building effective agents" describes an agent as an LLM using tools in a loop, based on feedback from the environment. This flow is that loop, written out.'],
      payloadKind: 'Chat message',
      payload: { session: 's_19f2', customer_id: 'c_5521', text: 'Order 88125 arrived broken. Can I get a refund?' }
    },
    {
      from: 'app', to: 'llm', label: 'messages + 2 tool schemas', pc: ['resp = llm.create'],
      title: 'Send the conversation and the tool definitions',
      caption: 'Each tool is a name, a description the model reads, and a JSON Schema for its input. The descriptions are prompts: they say when to use the tool.',
      text: [],
      payloadKind: 'Request',
      payload: { model: 'claude-…', system: 'You are MadShop support. Refund only damaged or missing items.', tools: [{ name: 'lookup_order', description: 'Get an order by id, with items, total and delivery status.', input_schema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } }, { name: 'issue_refund', description: 'Refund an order. Use only after checking the order.', input_schema: { type: 'object', properties: { order_id: { type: 'string' }, amount_eur: { type: 'number' }, reason: { type: 'string' } }, required: ['order_id', 'amount_eur', 'reason'] } }], messages: [{ role: 'user', content: 'Order 88125 arrived broken…' }] }
    },
    {
      from: 'llm', to: 'app', reply: true, label: 'stop_reason: tool_use → lookup_order', pc: ['if resp.stop_reason != "tool_use"'],
      title: 'The model asks for a tool',
      caption: 'Instead of text, the reply contains a tool_use block with an id, the tool name and arguments that match the schema. stop_reason "tool_use" tells the loop to keep going.',
      text: ['OpenAI\'s API has the same shape under other names: a tool_calls array whose function.arguments is a JSON string.'],
      payloadKind: 'Response',
      payload: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Let me check that order.' }, { type: 'tool_use', id: 'toolu_01A', name: 'lookup_order', input: { order_id: '88125' } }] }
    },
    {
      from: 'app', to: 'db', label: 'SELECT … WHERE id=88125 AND customer_id=c_5521', pc: ['TOOL_IMPL[call.name]'],
      title: 'Your code runs the tool',
      caption: 'The runtime maps the name to a Python function and runs it with the customer\'s scope added by the server, not by the model. The model cannot widen it to someone else\'s order.',
      text: [],
      payloadKind: 'Tool output',
      payload: { order_id: '88125', items: [{ sku: 'MUG-RED', qty: 1, price_eur: 59.9 }], status: 'delivered', delivered_at: '2026-11-24' }
    },
    {
      from: 'app', to: 'llm', label: 'tool_result → model asks issue_refund 59.90', pc: ['"tool_result"', 'messages.append({"role": "user"'],
      title: 'Feed the result back; the model picks the next action',
      caption: 'The result goes back as a tool_result linked by tool_use_id. The model reads it and asks for the second tool: issue_refund for €59.90, reason "damaged".',
      text: ['The whole history is resent on every turn. Long tool outputs make each turn slower and more expensive, so tools should return only what the model needs.'],
      payloadKind: 'Turn 2',
      payload: { sent: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01A', content: '{"status":"delivered","total":59.9}' }] }, received: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_02B', name: 'issue_refund', input: { order_id: '88125', amount_eur: 59.9, reason: 'damaged' } }] } },
      branch: { q: 'Does policy require a human for this call?', options: [ { label: 'yes: refunds need approval', goto: 'ask' }, { label: 'no: run it', goto: 'refund' } ] }
    },
    {
      id: 'ask', path: 'human in the loop', from: 'app', to: 'human', label: 'approve refund €59.90 for 88125?', pc: ['needs_approval(call)'],
      title: 'Pause for a human',
      caption: 'needs_approval() is plain code: any issue_refund call waits in the support lead\'s queue with the order and the model\'s reason. Approved after 40 seconds.',
      text: ['Keep the gate outside the model. A prompt that says "always ask first" can be talked around; an if-statement in the runtime cannot.'],
      payloadKind: 'Approval request',
      payload: { tool: 'issue_refund', input: { order_id: '88125', amount_eur: 59.9 }, decision: 'approved', by: 'lead_07', after_s: 40 }
    },
    {
      id: 'refund', from: 'app', to: 'pay', label: 'POST /refunds  Idempotency-Key: toolu_02B', pc: ['TOOL_IMPL[call.name]'],
      title: 'Run the side effect, safely',
      caption: 'The tool_use id doubles as the idempotency key. If the runtime crashes and replays this turn, the payments API returns the first refund instead of making a second one.',
      text: [],
      payloadKind: 'API call',
      payload: { request: { charge: 'ch_3Pq…', amount: 5990, currency: 'eur' }, headers: { 'Idempotency-Key': 'toolu_02B' }, response: { id: 're_1Qa…', status: 'succeeded' } },
      failure: 'If the API times out, retry with the same key. Return errors to the model as a tool_result with is_error: true so it can explain or try something else instead of inventing success.'
    },
    {
      from: 'app', to: 'llm', label: 'tool_result → stop_reason: end_turn', pc: ['return resp.text'],
      title: 'The model stops asking',
      caption: 'With the refund confirmed, the model replies with text only. stop_reason "end_turn" ends the loop. Turns used: 3 of 10.',
      text: [],
      payloadKind: 'Final response',
      payload: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sorry about the broken mug. I\'ve refunded €59.90 to your card; it shows in 5–10 days.' }], usage: { input_tokens: 1840, output_tokens: 62 } }
    },
    {
      from: 'app', to: 'user', reply: true, label: 'answer + audit log', pc: ['return resp.text'],
      title: 'Answer the customer',
      caption: 'The text goes to the chat. The runtime also stores every tool call, its input, output and approver, so a person can audit what the agent did.',
      text: [],
      payloadKind: 'Audit record',
      payload: { session: 's_19f2', turns: 3, tools: ['lookup_order', 'issue_refund'], approvals: ['lead_07'], refund: 're_1Qa…' }
    }
  ],
  decisions: [
    { q: 'Workflow or agent?', options: [
      { name: 'Fixed workflow', verdict: 'good', why: 'Your code calls the LLM at fixed points. Predictable and cheap; Anthropic recommends starting here.' },
      { name: 'Agent loop', verdict: 'good', why: 'The model chooses the steps. Use it when the steps cannot be known in advance, with limits and approvals.' } ] },
    { q: 'Where do permissions live?', options: [
      { name: 'In the prompt', verdict: 'bad', why: 'The model can be persuaded or confused into ignoring it.' },
      { name: 'In the tool code', verdict: 'great', why: 'Scope by the authenticated user, read-only roles, approval gates and idempotency keys.' } ] }
  ],
  refs: [
    { label: 'Anthropic: Building effective agents (workflows vs agents)', url: 'https://www.anthropic.com/engineering/building-effective-agents' },
    { label: 'Anthropic docs: Tool use with Claude (tool_use, tool_result, stop_reason)', url: 'https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview' },
    { label: 'OpenAI docs: Function calling', url: 'https://platform.openai.com/docs/guides/function-calling' },
    { label: 'ByteByteGo: The agent loop, how AI goes from answering to acting', url: 'https://blog.bytebytego.com/p/the-agent-loop-how-ai-goes-from-answering' },
    { label: 'Stripe docs: Idempotent requests', url: 'https://docs.stripe.com/api/idempotent_requests' }
  ],
  verify: {
    checked: ['Agent = LLM using tools in a loop with environment feedback; start with workflows: Anthropic\'s post.', 'Block names tool_use / tool_result, tool_use_id and stop_reason "tool_use": Anthropic tool-use docs.', 'Idempotency-Key behaviour: Stripe docs.'],
    uncertain: ['Using the tool_use id as the idempotency key is a design choice of this example, not an API feature.', 'Token counts, amounts and the 10-turn cap are illustrative.']
  }
});
