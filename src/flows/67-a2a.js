flow({
  id: 'a2a-protocol',
  title: 'Agent2Agent (A2A): one agent delegating a task to another',
  category: 'AI & machine learning',
  tags: ['Agent Card discovery', 'JSON-RPC over HTTP', 'Task lifecycle', 'input-required', 'SSE streaming', 'Push notifications', 'Artifacts'],
  summary: 'MCP connects an agent to tools. A2A connects an agent to another agent, owned by someone else, that it cannot see inside. Follow a travel assistant as it discovers a hotel agent through its Agent Card, sends a booking task, answers a follow-up question when the task becomes input-required, streams progress, and receives the booking as an artifact.',
  requirements: {
    functional: ['Discover what a remote agent can do and how to authenticate.', 'Send it a task, follow its progress, answer its questions, receive results.', 'Support long tasks that finish after the client disconnects.'],
    nonFunctional: ['Opaque: neither agent exposes its prompts, tools or memory.', 'Built on HTTP, JSON-RPC 2.0, SSE and standard auth schemes.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'user', label: 'Traveller', sub: 'chat app', kind: 'client', icon: 'user', x: 0, y: 1, desc: 'Asks their assistant to book a hotel.' },
    { id: 'client', label: 'Travel assistant', sub: 'A2A client agent', kind: 'ai', icon: 'robot', x: 1, y: 1, desc: 'The user\'s agent. It decides to delegate the hotel part to a specialist agent.' },
    { id: 'card', label: 'Agent Card', sub: '/.well-known/agent-card.json', kind: 'edge', icon: 'doc', x: 2, y: 0, desc: 'A public JSON document: the agent\'s name, skills, endpoint URL, supported bindings, capabilities (streaming, push) and security schemes.' },
    { id: 'server', label: 'Hotel agent', sub: 'A2A server agent', kind: 'ai', icon: 'robot', x: 2, y: 1, desc: 'A remote agent run by a hotel chain. Internally it may use its own LLM, tools and MCP servers; the client never sees them.' },
    { id: 'pms', label: 'Booking system', sub: 'the chain\'s backend', kind: 'db', icon: 'building', x: 3, y: 1, desc: 'Where rooms are actually held and booked.' },
    { id: 'hook', label: 'Webhook endpoint', sub: 'push notifications', kind: 'service', icon: 'bell', x: 1, y: 2, desc: 'The client\'s HTTPS endpoint that the server calls when a long task changes state.' }
  ],
  pseudo: `
card = GET("https://hotels.example/.well-known/agent-card.json")
token = oauth(card.securitySchemes)
resp = rpc(card.url, "SendMessage", {message: {role: "ROLE_USER", parts: [{text: ask}]}})
task = resp.task
while task.status.state == "TASK_STATE_INPUT_REQUIRED":
    answer = ask_user(task.status.message)
    task = rpc(card.url, "SendMessage", {message: {taskId: task.id, contextId: task.contextId, parts: [{text: answer}]}}).task
for event in rpc_stream(card.url, "SubscribeToTask", {id: task.id}):  # SSE
    show(event)
booking = task.artifacts[0]`,
  steps: [
    {
      from: 'user', to: 'client', label: '"Book me a hotel in Lyon, 3–5 Dec"', pc: ['card = GET'],
      title: 'The user asks their own agent',
      caption: 'The travel assistant has no hotel inventory. It knows of a hotel chain\'s agent and decides to delegate.',
      text: ['ByteByteGo contrasts the layers: MCP gives one agent its tools and data; A2A lets independent agents talk as peers.'],
      payloadKind: 'Request',
      payload: { text: 'Book me a hotel in Lyon, 3 to 5 December, near Part-Dieu station.' }
    },
    {
      from: 'client', to: 'card', label: 'GET /.well-known/agent-card.json', pc: ['card = GET'],
      title: 'Discover: read the Agent Card',
      caption: 'The card says what the agent can do (skills), where to call it, which protocol binding and version it speaks, whether it streams, and how to authenticate.',
      text: [],
      payloadKind: 'Agent Card',
      payload: { name: 'Hotel booking agent', url: 'https://hotels.example/a2a/v1', protocolBinding: 'JSONRPC', capabilities: { streaming: true, pushNotifications: true }, skills: [{ id: 'book-room', name: 'Book a room', description: 'Find and book rooms by city, dates and budget' }], securitySchemes: { oauth: { type: 'oauth2' } } }
    },
    {
      from: 'client', to: 'server', label: 'SendMessage (JSON-RPC 2.0)', pc: ['token = oauth', 'resp = rpc(card.url, "SendMessage"'],
      title: 'Send a task',
      caption: 'After getting a token for the declared scheme, the client sends a message. The server creates a Task with an id and a contextId that groups related messages.',
      text: [],
      payloadKind: 'JSON-RPC request',
      payload: { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { role: 'ROLE_USER', messageId: 'm-1', parts: [{ text: 'Room in Lyon near Part-Dieu, check-in 3 Dec, check-out 5 Dec, 1 adult, max €140/night' }] } } }
    },
    {
      from: 'server', to: 'client', reply: true, label: 'task state: INPUT_REQUIRED', pc: ['TASK_STATE_INPUT_REQUIRED'],
      title: 'The remote agent needs more information',
      caption: 'Two rooms fit. The hotel agent pauses the task in the input-required state with a question: breakfast included (€138) or not (€119)?',
      text: ['input-required and auth-required are interrupted states: the task is not finished, it waits for the client.'],
      payloadKind: 'Task',
      payload: { task: { id: 't-7781', contextId: 'c-12', status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { role: 'ROLE_AGENT', parts: [{ text: 'Room with breakfast €138/night or without €119/night?' }] } } } }
    },
    {
      from: 'client', to: 'user', label: '"With breakfast (€138) or without (€119)?"', pc: ['answer = ask_user'],
      title: 'Ask the human',
      caption: 'The travel assistant cannot decide a price for the user, so it relays the question. The user picks "without".',
      text: [],
      payloadKind: 'Question / answer',
      payload: { asked: 'With breakfast (€138) or without (€119)?', answer: 'Without' }
    },
    {
      from: 'client', to: 'server', label: 'SendMessage (same taskId, contextId)', pc: ['taskId: task.id'],
      title: 'Continue the same task',
      caption: 'The answer goes back as a new message carrying the same taskId and contextId, so the server resumes instead of starting over.',
      text: [],
      payloadKind: 'JSON-RPC request',
      payload: { method: 'SendMessage', params: { message: { taskId: 't-7781', contextId: 'c-12', role: 'ROLE_USER', parts: [{ text: 'Without breakfast' }] } } }
    },
    {
      from: 'server', to: 'pms', label: 'hold + book room 412', pc: ['task = rpc(card.url'],
      title: 'The remote agent works with its own tools',
      caption: 'Inside, the hotel agent books through its own backend. The client sees only state changes, not the steps.',
      text: [],
      payloadKind: 'Internal (not visible to the client)',
      payload: { hotel: 'Lyon Part-Dieu', room: 412, nights: 2, rate_eur: 119 },
      branch: { q: 'Is the client still connected?', options: [ { label: 'yes: stream updates (SSE)', goto: 'sse' }, { label: 'no: push to webhook', goto: 'push' } ] }
    },
    {
      id: 'sse', from: 'server', to: 'client', reply: true, label: 'SSE: WORKING … COMPLETED + artifact', pc: ['rpc_stream'],
      title: 'Stream progress',
      caption: 'With streaming, the server keeps an HTTP response open (text/event-stream) and sends status and artifact updates as they happen.',
      text: [],
      payloadKind: 'SSE events',
      payload: 'data: {"result":{"statusUpdate":{"taskId":"t-7781","status":{"state":"TASK_STATE_WORKING"}}}}\n\ndata: {"result":{"statusUpdate":{"taskId":"t-7781","status":{"state":"TASK_STATE_COMPLETED"}}}}',
      next: 'done'
    },
    {
      id: 'push', path: 'disconnected client', from: 'server', to: 'hook', label: 'POST webhook: task completed', pc: ['rpc_stream'],
      title: 'Other outcome: push notification',
      caption: 'For long tasks the client registers a push-notification config (URL + token). When the state changes the server POSTs to it; the client then fetches the task with GetTask.',
      text: [],
      payloadKind: 'Webhook',
      payload: { url: 'https://travel-assistant.example/a2a/hook', headers: { Authorization: 'Bearer …' }, body: { taskId: 't-7781', state: 'TASK_STATE_COMPLETED' } },
      next: 'done'
    },
    {
      id: 'done', from: 'client', to: 'user', reply: true, label: 'artifact → "Booked: room 412, €238"', pc: ['booking = task.artifacts[0]'],
      title: 'Use the artifact',
      caption: 'The result arrives as an artifact (the task\'s output, made of parts such as text or structured data). The assistant confirms the booking to the user.',
      text: [],
      payloadKind: 'Artifact',
      payload: { artifactId: 'booking-1', name: 'Booking confirmation', parts: [{ data: { confirmation: 'LYN-58Q2', room: 412, total_eur: 238, cancel_until: '2026-12-02' } }] }
    }
  ],
  decisions: [
    { q: 'MCP or A2A?', options: [
      { name: 'MCP', verdict: 'good', why: 'Your agent calls a tool or reads data: one request, one structured result.' },
      { name: 'A2A', verdict: 'good', why: 'Your agent delegates to another autonomous agent that may ask questions, run for hours and return artifacts. Many systems use both.' } ] }
  ],
  refs: [
    { label: 'A2A Protocol specification (latest)', url: 'https://a2a-protocol.org/latest/specification/' },
    { label: 'A2A project on GitHub', url: 'https://github.com/a2aproject/A2A' },
    { label: 'Google Developers Blog: Announcing the Agent2Agent protocol', url: 'https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/' },
    { label: 'ByteByteGo: MCP vs A2A vs ACP, how AI agents actually talk', url: 'https://blog.bytebytego.com/p/mcp-vs-a2a-vs-acp-how-ai-agents-actually' }
  ],
  verify: {
    checked: ['Agent Card at /.well-known/agent-card.json with capabilities and securitySchemes; SendMessage, SendStreamingMessage, GetTask, SubscribeToTask; TASK_STATE_* names; input-required continued with same taskId and contextId; SSE (text/event-stream); push notification configs; parts as {text}: A2A specification v1.0 pages read on Nov 26, 2026.'],
    uncertain: ['The exact shape of SSE events and the webhook body are simplified.', 'Hotel, prices and ids are illustrative. Earlier A2A versions used other method names (message/send) and a "kind" field.']
  }
});
