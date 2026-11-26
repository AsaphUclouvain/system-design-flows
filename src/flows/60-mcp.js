flow({
  id: 'mcp',
  title: 'Model Context Protocol (MCP): host, client, server, tools',
  category: 'AI & machine learning',
  tags: ['Host / client / server', 'JSON-RPC 2.0', 'initialize + capabilities', 'tools/list, tools/call', 'Resources, prompts', 'stdio vs Streamable HTTP'],
  summary: 'MCP is the open protocol that lets an AI app plug into tools and data the same way every time. Follow Claude Desktop (the host) as it starts an MCP client per server, negotiates capabilities, lists a GitHub server\'s tools, lets the model call one, and feeds the result back. Branch on the two transports: a local process over stdio, or a remote server over Streamable HTTP.',
  requirements: {
    functional: ['An AI application discovers what tools, data (resources) and prompt templates a server offers.', 'The model can call a tool with JSON arguments and get a structured result.', 'Servers can notify clients when their tool list changes.'],
    nonFunctional: ['One protocol for every integration: write a server once, use it in any MCP host.', 'A human can approve or deny tool calls.', 'Works for local processes and remote services.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'user', label: 'User', sub: 'types a request', kind: 'client', icon: 'user', x: 0, y: 1, desc: 'Asks the assistant something that needs outside data or actions.' },
    { id: 'host', label: 'MCP host', sub: 'Claude Desktop / VS Code', kind: 'service', icon: 'laptop', x: 1, y: 1, desc: 'The AI application. It owns the conversation, the LLM calls and the user\'s consent. It creates one MCP client per server it connects to.' },
    { id: 'llm', label: 'LLM', sub: 'Claude / GPT', kind: 'ai', icon: 'brain', x: 1, y: 0, desc: 'Sees the tool definitions the host passes in and decides when to call one. It never talks to MCP servers directly.' },
    { id: 'client', label: 'MCP client', sub: 'one per server', kind: 'edge', icon: 'plug', x: 2, y: 1, desc: 'A connection object inside the host that speaks JSON-RPC 2.0 to exactly one server and keeps that session.' },
    { id: 'gh', label: 'GitHub MCP server', sub: 'remote, Streamable HTTP', kind: 'service', icon: 'server', x: 3, y: 0, desc: 'Exposes tools (search_issues, create_pr…), resources and prompts. Remote servers usually serve many clients.' },
    { id: 'fs', label: 'Filesystem server', sub: 'local process, stdio', kind: 'service', icon: 'folder', x: 3, y: 2, desc: 'Launched by the host as a subprocess. Messages go over its stdin and stdout. Typically serves a single client.' },
    { id: 'api', label: 'GitHub API', sub: 'api.github.com', kind: 'external', icon: 'globe', x: 3, y: 1, desc: 'The real system behind the server. The MCP server translates tool calls into API requests.' }
  ],
  pseudo: `
# host start-up: one client per configured server
for cfg in mcp_servers:
    c = Client(transport=StdioTransport(cfg.cmd) if cfg.local else HttpTransport(cfg.url))
    init = c.request("initialize", {protocolVersion: "2025-06-18", capabilities: {...}})
    c.notify("notifications/initialized")
    tools += c.request("tools/list").tools        # name, description, inputSchema

# each user turn
reply = llm.chat(messages, tools=tools)
while reply.tool_calls:
    for call in reply.tool_calls:
        if not user_approves(call): result = denied(call)
        else: result = client_for(call.name).request("tools/call", {name: call.name, arguments: call.args})
        messages.append(tool_result(call.id, result.content, result.isError))
    reply = llm.chat(messages, tools=tools)
show(reply.text)`,
  steps: [
    {
      from: 'host', to: 'client', label: 'create client for "github"', pc: ['for cfg in mcp_servers', 'c = Client'],
      title: 'The host creates one MCP client per server',
      caption: 'When Claude Desktop starts, it reads its MCP config: a remote GitHub server and a local filesystem server. It creates a separate MCP client object for each.',
      text: ['The MCP docs define the three roles: the host (the AI application) creates one MCP client for each MCP server, and each client keeps a dedicated connection with its server. VS Code connecting to the Sentry server is their example.'],
      payloadKind: 'Host config',
      payload: { mcpServers: { github: { url: 'https://api.githubcopilot.com/mcp/', transport: 'streamable-http' }, filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/ana/notes'] } } }
    },
    {
      from: 'client', to: 'gh', label: 'initialize (protocolVersion 2025-06-18)', pc: ['c.request("initialize"', 'notifications/initialized'],
      title: 'Handshake: initialize and capabilities',
      caption: 'The client sends initialize with the protocol version and what it supports. The server answers with its own version and capabilities (tools, resources, prompts). The client then sends notifications/initialized.',
      text: ['Every message is JSON-RPC 2.0: requests have an id and expect a response; notifications have no id. Capability negotiation means neither side uses a feature the other did not announce.'],
      payloadKind: 'JSON-RPC',
      payload: { request: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'claude-desktop', version: '1.0' } } }, response: { id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} }, serverInfo: { name: 'github-mcp', version: '0.9' } } } },
      fields: { listChanged: 'The server will send notifications/tools/list_changed if its tools change, so the client can list them again.' },
      branch: { q: 'Which transport carries these messages?', options: [ { label: 'Streamable HTTP (remote)', goto: 'http' }, { label: 'stdio (local process)', goto: 'stdio' } ] }
    },
    {
      id: 'http', path: 'Streamable HTTP', from: 'gh', to: 'client', reply: true, label: '200 + Mcp-Session-Id: 1868a…', pc: ['HttpTransport'],
      title: 'Remote: one HTTP endpoint, a session header',
      caption: 'For remote servers, every client message is an HTTP POST to a single MCP endpoint. The server returns JSON, or opens a text/event-stream (SSE) to stream several messages. It may assign a session id the client sends on later requests.',
      text: ['Remote servers also need authorization: the 2025-06-18 spec uses OAuth 2.1, so the user signs in to GitHub and the client sends a bearer token. Local stdio servers take credentials from their environment instead.'],
      payloadKind: 'HTTP',
      payload: { request: 'POST /mcp  Accept: application/json, text/event-stream  Authorization: Bearer gho_…', response_headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': '1868a90c-…' }, later_requests_include: 'Mcp-Session-Id: 1868a90c-…' },
      next: 'list'
    },
    {
      id: 'stdio', path: 'stdio', from: 'client', to: 'fs', label: 'spawn npx … ; JSON lines on stdin/stdout', pc: ['StdioTransport'],
      title: 'Local: a subprocess talking over stdin and stdout',
      caption: 'For the filesystem server, the host launches a child process. The client writes JSON-RPC messages to its stdin, one per line, and reads replies from its stdout. Logs go to stderr.',
      text: ['No network, no ports, no auth handshake: the process runs with the user\'s permissions and only sees the folders it was given.'],
      payloadKind: 'stdio frames',
      payload: { stdin: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{…}}\\n', stdout: '{"jsonrpc":"2.0","id":1,"result":{"capabilities":{"tools":{},"resources":{}}}}\\n', stderr: '[fs] allowed: /Users/ana/notes' }
    },
    {
      id: 'list', from: 'client', to: 'gh', label: 'tools/list', pc: ['tools += c.request("tools/list")'],
      title: 'Discover the server\'s tools',
      caption: 'The client asks for the tool list. Each tool has a name, a description for the model, and a JSON Schema for its arguments. The host merges the tools from all its servers.',
      text: ['MCP servers offer three primitives. Tools are model-controlled actions. Resources are data the application can read by URI (a file, a repo README). Prompts are user-chosen templates, often surfaced as slash commands.'],
      payloadKind: 'tools/list result',
      payload: { tools: [{ name: 'search_issues', description: 'Search issues and PRs in a repository', inputSchema: { type: 'object', properties: { repo: { type: 'string' }, query: { type: 'string' } }, required: ['repo', 'query'] } }, { name: 'create_pull_request', description: 'Open a PR', inputSchema: '{…}' }], also_available: ['resources/list → repo://madgate/README.md', 'prompts/list → review_pr'] }
    },
    {
      from: 'user', to: 'host', label: '"Any open bugs about the reader?"', pc: ['reply = llm.chat'],
      title: 'The user asks a question',
      caption: 'Ana asks about open reader bugs in her MadGate repo. The host sends her message to the model together with the tool definitions it collected.',
      text: [],
      payloadKind: 'Chat request',
      payload: { messages: [{ role: 'user', content: 'Any open bugs about the reader in swampi/madgate?' }], tools: ['github.search_issues', 'github.create_pull_request', 'filesystem.read_file', '…'] }
    },
    {
      from: 'host', to: 'llm', label: 'messages + tool schemas', pc: ['reply = llm.chat', 'while reply.tool_calls'],
      title: 'The model decides to call a tool',
      caption: 'The model reads the tool descriptions and answers not with text but with a tool call: search_issues with JSON arguments matching the schema.',
      text: ['This is ordinary function calling (see the tool-calling flow). MCP standardises where the tool definitions come from and how the call reaches the system behind them.'],
      payloadKind: 'Model output',
      payload: { stop_reason: 'tool_use', tool_calls: [{ id: 'call_1', name: 'search_issues', arguments: { repo: 'swampi/madgate', query: 'is:open label:bug reader' } }] }
    },
    {
      from: 'host', to: 'user', label: 'Allow search_issues?', pc: ['user_approves'],
      title: 'Human in the loop',
      caption: 'Before running it, the host shows Ana which tool will run with which arguments. The spec says there should always be a human in the loop with the ability to deny tool invocations.',
      text: ['Hosts often let users "always allow" read-only tools and keep asking for tools that write (create_pull_request).'],
      payloadKind: 'Consent prompt',
      payload: { tool: 'github.search_issues', arguments: { repo: 'swampi/madgate', query: 'is:open label:bug reader' }, choices: ['Allow once', 'Always allow', 'Deny'], chosen: 'Allow once' }
    },
    {
      from: 'client', to: 'gh', label: 'tools/call search_issues', pc: ['request("tools/call"'],
      title: 'The client sends tools/call',
      caption: 'The host routes the call to the client that owns this tool. The GitHub server turns it into a GitHub API search and wraps the answer as MCP content.',
      text: [],
      payloadKind: 'JSON-RPC',
      payload: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'search_issues', arguments: { repo: 'swampi/madgate', query: 'is:open label:bug reader' } } }
    },
    {
      from: 'gh', to: 'api', label: 'GET /search/issues?q=repo:swampi/madgate+…', pc: ['request("tools/call"'],
      title: 'The server calls the real API',
      caption: 'The MCP server is an adapter: it validates the arguments, calls api.github.com with the user\'s token, and keeps only what the model needs.',
      text: ['Trimming results matters: every byte returned ends up in the model\'s context window and costs tokens.'],
      payloadKind: 'Upstream request',
      payload: { method: 'GET', url: 'https://api.github.com/search/issues?q=repo:swampi/madgate+is:open+label:bug+reader', results: 2 }
    },
    {
      from: 'gh', to: 'client', reply: true, label: 'result: content[], isError=false', pc: ['messages.append(tool_result'],
      title: 'The result comes back as content',
      caption: 'The server answers with a list of content items (text here; images, audio and resource links are possible) and isError. A failed call returns isError: true with a message the model can read and react to.',
      text: ['Tool errors are part of the result, not protocol errors, so the model can see "rate limited, retry later" and decide what to do.'],
      payloadKind: 'tools/call result',
      payload: { id: 7, result: { content: [{ type: 'text', text: '#142 Scrolling stops on mobile (open)\\n#139 First page spinner too long (open)' }], isError: false } }
    },
    {
      from: 'host', to: 'llm', label: 'tool_result → final answer', pc: ['reply = llm.chat(messages, tools=tools)', 'show(reply.text)'],
      title: 'The model writes the answer',
      caption: 'The host appends the tool result to the conversation and calls the model again. Now it has the facts and answers Ana in plain language.',
      text: ['If the model needed more (for example the issue bodies), it would call another tool and the loop would continue. That loop is the agent loop in the ReAct flow.'],
      payloadKind: 'Final reply',
      payload: { text: 'Two open reader bugs: #142 "Scrolling stops on mobile" and #139 "First page spinner too long".', tool_calls: [] }
    }
  ],
  decisions: [
    { q: 'Local stdio server or remote HTTP server?', options: [
      { name: 'stdio', verdict: 'good', why: 'For tools that touch the user\'s machine (files, git, a local database). No network exposure; one client per process.' },
      { name: 'Streamable HTTP', verdict: 'good', why: 'For SaaS integrations shared by many users. Needs OAuth, session handling and the usual web security.' } ] },
    { q: 'MCP or a direct API integration in your app?', options: [
      { name: 'MCP', verdict: 'good', why: 'Any MCP host can use the integration; tools are discovered at runtime.' },
      { name: 'Direct function calling', verdict: 'good', why: 'Simpler for one app with a few fixed tools you control.' } ] }
  ],
  refs: [
    { label: 'MCP docs: Architecture overview (host, client, server; data and transport layers)', url: 'https://modelcontextprotocol.io/docs/learn/architecture' },
    { label: 'MCP specification 2025-06-18: Lifecycle (initialize, capabilities)', url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle' },
    { label: 'MCP specification 2025-06-18: Transports (stdio, Streamable HTTP, Mcp-Session-Id)', url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports' },
    { label: 'MCP specification 2025-06-18: Tools (tools/list, tools/call, isError, human in the loop)', url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/tools' },
    { label: 'MCP specification 2025-06-18: Resources', url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/resources' },
    { label: 'MCP specification 2025-06-18: Prompts', url: 'https://modelcontextprotocol.io/specification/2025-06-18/server/prompts' },
    { label: 'ByteByteGo newsletter: MCP vs RAG vs AI agents', url: 'https://blog.bytebytego.com/p/ep224-mcp-vs-rag-vs-ai-agents' }
  ],
  verify: {
    checked: ['One client per server, dedicated connection, VS Code + Sentry example, stdio usually single-client and HTTP many: MCP architecture page.', 'initialize / notifications/initialized, capabilities, listChanged, tools/call result with isError, human in the loop: spec pages listed.', 'Single HTTP endpoint, SSE responses, Mcp-Session-Id: transports page.'],
    uncertain: ['The GitHub server URL and tool names are illustrative; check the server\'s own README for its real tool list.']
  }
});
