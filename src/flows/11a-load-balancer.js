flow({
  id: 'load-balancing',
  title: 'Load balancing, health checks and service discovery',
  category: 'Infrastructure foundations',
  tags: ['L4 / L7', 'Envoy', 'Service registry', 'Health checks', 'Outlier detection', 'Connection draining'],
  summary: 'A request for /api/orders reaches one of many FastAPI instances that come and go all day. Follow how new instances register, how the proxy learns about them, how it picks one per request, what happens when an instance starts failing, and how a deploy removes instances without dropping a single request.',
  requirements: {
    functional: [
      'Spread requests across all healthy instances of a service.',
      'New instances receive traffic within seconds of becoming ready; dead ones stop receiving it within seconds.',
      'Deploys and scale-downs do not fail in-flight requests.'
    ],
    nonFunctional: [
      'The load balancer adds under 1 ms of latency.',
      'No single point of failure: the balancer tier itself is redundant.',
      'Survives a whole availability zone going down.'
    ]
  },
  estimates: [
    { label: 'Requests', value: '25,000 / s', note: 'Peak across all API routes.' },
    { label: 'Instances', value: '40 → 120', note: 'Autoscaled on CPU and request rate over the day.' },
    { label: 'Per instance', value: '≈ 300 req/s', note: '4 Uvicorn workers × ~75 req/s with 20 ms average handler time and I/O waits.' },
    { label: 'Detection time', value: '≤ 10 s', note: 'Health check every 2 s, 3 failures to eject; outlier detection is faster for 5xx bursts.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'client', label: 'Client', sub: 'Next.js app', kind: 'client', x: 0, y: 0, desc: 'Browser or server component calling api.shop.example.' },
    { id: 'l4', label: 'Network LB', sub: 'L4, per AZ', kind: 'edge', icon: 'lb', x: 1, y: 0, desc: 'Forwards TCP connections to the proxy fleet by flow hash. Very fast, knows nothing about HTTP.' },
    { id: 'envoy', label: 'L7 proxy', sub: 'Envoy fleet', kind: 'edge', icon: 'lb', x: 2, y: 0, desc: 'Terminates TLS, reads HTTP, routes by path and picks a backend per request.' },
    { id: 'cp', label: 'Control plane', sub: 'xDS server', kind: 'service', icon: 'cpu', x: 2, y: 1, desc: 'Watches the registry and pushes endpoint lists to every Envoy over gRPC.' },
    { id: 'registry', label: 'Service registry', sub: 'Consul / k8s', kind: 'db', icon: 'dns', x: 1, y: 1, desc: 'Which instances of which service exist, where, and whether they are healthy.' },
    { id: 'a', label: 'orders-api #a', sub: 'FastAPI, AZ-1', kind: 'service', icon: 'server', x: 3, y: 0, desc: 'One instance of the orders service.' },
    { id: 'b', label: 'orders-api #b', sub: 'FastAPI, AZ-2', kind: 'service', icon: 'server', x: 3, y: 1, desc: 'Another instance; this one is about to start failing.' },
    { id: 'c', label: 'orders-api #c', sub: 'new, AZ-3', kind: 'service', icon: 'server', x: 3, y: 2, desc: 'A freshly started instance during a scale-up or deploy.' },
    { id: 'orch', label: 'Orchestrator', sub: 'Kubernetes', kind: 'worker', icon: 'cpu', x: 1, y: 2, desc: 'Starts and stops instances for deploys and autoscaling, and runs their probes.' }
  ],
  steps: [
    {
      from: 'orch', to: 'c', label: 'start instance',
      title: 'A new instance starts',
      caption: 'The autoscaler adds an instance of orders-api in availability zone 3. It boots, opens its database pool, and warms its caches before it says it is ready.',
      text: ['Two different probes matter. **Liveness**: is the process stuck? If it fails, restart it. **Readiness**: can it serve traffic right now? Until it passes, no traffic is sent. Confusing the two causes restart loops under load.'],
      payloadKind: 'Pod spec (excerpt)',
      payloadLang: 'text',
      payload: String.raw`
containers:
- name: orders-api
  image: registry.example/orders-api:2026.11.25-3
  readinessProbe:  { httpGet: { path: /readyz, port: 8000 }, periodSeconds: 2, failureThreshold: 3 }
  livenessProbe:   { httpGet: { path: /livez,  port: 8000 }, periodSeconds: 10, failureThreshold: 6 }
  lifecycle:
    preStop: { exec: { command: ["sleep", "10"] } }     # see the draining step
terminationGracePeriodSeconds: 40`,
      code: [{ lang: 'python', title: 'Readiness and liveness endpoints', src: String.raw`
ready = asyncio.Event()

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.pool = await asyncpg.create_pool(DSN, min_size=5, max_size=20)
    await warm_caches(app)
    ready.set()                       # only now accept traffic
    yield
    ready.clear()
    await app.state.pool.close()

@app.get("/livez")
async def livez():
    return {"ok": True}               # cheap: the event loop is responding

@app.get("/readyz")
async def readyz():
    if not ready.is_set():
        raise HTTPException(503, "warming up")
    await app.state.pool.fetchval("SELECT 1")   # can I reach my dependency?
    return {"ok": True}` }]
    },
    {
      from: 'c', to: 'registry', label: 'register (ready)',
      title: 'It appears in the registry',
      caption: 'When /readyz passes, the instance is marked ready and its IP and port become an endpoint of the orders-api service in the registry.',
      text: ['In Kubernetes, the EndpointSlice controller does this automatically from readiness. With Consul, an agent next to the instance registers it together with its health check. Either way, the registry is the single place that knows "orders-api = these 41 addresses".'],
      payloadKind: 'Registry entry',
      payload: { service: 'orders-api', endpoint: { ip: '10.3.14.27', port: 8000, zone: 'eu-west-1c' }, conditions: { ready: true, serving: true, terminating: false }, labels: { version: '2026.11.25-3' } },
      fields: { zone: 'Used for zone-aware routing: proxies prefer endpoints in their own zone to save latency and cross-zone transfer costs.', terminating: 'Becomes true during shutdown (see the draining step).' }
    },
    {
      from: 'registry', to: 'cp', label: 'watch: endpoints changed', async: true,
      title: 'The control plane notices',
      caption: 'The control plane holds a watch on the registry. Within about a second it receives the new endpoint list for orders-api.',
      text: ['{{service discovery}} can be client-side (each caller looks up the registry) or server-side (a proxy does it). Here a proxy fleet does it, so FastAPI code just calls a hostname.'],
      payloadKind: 'Watch event',
      payload: { type: 'MODIFIED', service: 'orders-api', resource_version: '88213901', endpoints_ready: 41, added: ['10.3.14.27:8000'], removed: [] }
    },
    {
      from: 'cp', to: 'envoy', label: 'xDS push (EDS)',
      title: 'Every proxy gets the new endpoint list',
      caption: 'The control plane pushes an updated cluster load assignment to all Envoy proxies over their long-lived gRPC streams. The new instance starts receiving requests on the next pick.',
      text: ['{{xds}} pushes are incremental and versioned; a proxy acknowledges each version, or rejects a bad config and keeps the last good one.', 'New instances get a slow start: their share ramps up over 30 s, so a cold JIT, cache or connection pool is not hit with full load immediately.'],
      payloadKind: 'EDS update',
      payload: { cluster_name: 'orders-api', version_info: 'v8821', endpoints: [{ locality: { zone: 'eu-west-1a' }, lb_endpoints: 14 }, { locality: { zone: 'eu-west-1b' }, lb_endpoints: 13 }, { locality: { zone: 'eu-west-1c' }, lb_endpoints: 14, new: '10.3.14.27:8000 (slow start 30 s)' }] },
      failure: ['**Control plane down:** proxies keep routing with the last endpoint list they received. Nothing breaks immediately; only changes stop propagating. That "static stability" is a key property.']
    },
    {
      from: 'client', to: 'l4', label: 'TCP SYN :443',
      title: 'A client connects',
      caption: 'The client resolves api.shop.example to the network load balancer\'s addresses (one per zone) and opens a TCP connection. The L4 balancer picks a proxy by hashing the connection\'s 5-tuple.',
      text: ['An L4 balancer forwards packets, not requests: every request on this keep-alive connection goes to the same proxy. That is fine because the proxies are identical and stateless; the per-request choice happens at L7.'],
      payloadKind: 'Connection',
      payload: { proto: 'TCP', src: '81.244.12.9:53122', dst: '52.18.40.11:443', flow_hash: '0x7c1e', chosen_proxy: 'envoy-eu-west-1a-07' },
      fields: { flow_hash: 'Hash of source IP, source port, destination IP, destination port and protocol. Same connection, same proxy.' }
    },
    {
      from: 'l4', to: 'envoy', label: 'forward TCP',
      title: 'The proxy terminates TLS and routes',
      caption: 'Envoy completes the TLS handshake, decodes the HTTP/2 request and matches the route: /api/orders goes to the orders-api cluster with a 3 s timeout and one retry on connect failure.',
      text: ['Timeouts and retries live in the proxy\'s route config, so every service gets the same safe defaults without writing them in Python. The proxy adds `x-request-id` if the client did not send one.'],
      payloadKind: 'HTTP request',
      payload: { method: 'GET', path: '/api/orders?limit=20', authority: 'api.shop.example', headers: { authorization: 'Bearer eyJ…', 'x-request-id': 'b7e1c0d2-…', 'x-forwarded-for': '81.244.12.9' } },
      fields: { 'x-forwarded-for': 'Added by the proxy so the backend sees the real client IP, not the proxy\'s.' }
    },
    {
      from: 'envoy', to: 'a', label: 'least request: pick #a',
      title: 'Pick a backend for this request',
      caption: 'Envoy uses "power of two choices": it picks two random healthy endpoints and sends the request to the one with fewer requests in flight. #a has 3 active, #b has 9, so #a wins.',
      text: ['Round robin ignores that some requests are slow; least-request adapts. Checking just two random endpoints instead of all 41 gets almost the same balance at much lower cost, and avoids every proxy herding to the same "least loaded" instance.'],
      payloadKind: 'LB decision',
      payload: { policy: 'LEAST_REQUEST (choice_count=2)', candidates: [{ ep: '10.1.7.4:8000 (#a)', active: 3 }, { ep: '10.2.9.13:8000 (#b)', active: 9 }], chosen: '#a', zone_aware: 'same zone preferred (eu-west-1a)' },
      code: [{ lang: 'python', title: 'Power of two choices (the idea)', src: String.raw`
def pick(endpoints: list[Endpoint]) -> Endpoint:
    healthy = [e for e in endpoints if e.healthy and not e.ejected]
    a, b = random.sample(healthy, 2)
    return a if a.active_requests <= b.active_requests else b` }]
    },
    {
      from: 'a', to: 'envoy', label: '200 OK', reply: true,
      title: 'The instance answers',
      caption: 'orders-api #a handles the request in 18 ms. Envoy records latency and status per endpoint; these numbers feed both load balancing and outlier detection.',
      payloadKind: 'HTTP response',
      payload: { status: 200, headers: { 'content-type': 'application/json', 'x-envoy-upstream-service-time': '18', server: 'envoy' }, body: { items: '[20 orders]', next_cursor: 'c_01JDQ…' } },
      text: ['The proxy also emits an access log line and a span with the request id, so a slow request can be traced to the exact instance that handled it.']
    },
    {
      from: 'envoy', to: 'b', label: '5xx × 5 → eject',
      title: 'An instance starts failing: outlier detection ejects it',
      caption: 'orders-api #b lost its database connections and returns 503 to every request. Its /readyz is cached and still passes, but Envoy sees five consecutive 5xx and ejects #b from its pool for 30 seconds.',
      text: ['Active {{health check}}s ask "are you OK?" every few seconds. {{outlier detection}} watches real traffic and reacts within a handful of requests. You want both: health checks catch dead instances with no traffic, outlier detection catches sick ones quickly.', 'Ejection is capped (`max_ejection_percent: 30`) so a shared failure, like the database being down, does not eject everything and leave nothing to serve.'],
      payloadKind: 'Envoy config (excerpt)',
      payloadLang: 'text',
      payload: String.raw`
outlier_detection:
  consecutive_5xx: 5
  interval: 5s
  base_ejection_time: 30s          # doubles on each repeated ejection
  max_ejection_percent: 30

[2026-11-25T11:52:14Z] outlier_detection: eject 10.2.9.13:8000 (consecutive_5xx=5, ejections=1)`,
      failure: ['**The request that got the 503:** retried once on another instance because the route allows `retry_on: 5xx` for GET. POSTs are only retried on connect failure unless they carry an {{idempotency key}}.', '**Retry storms:** a retry budget (at most 20% extra requests) stops retries from doubling load during an outage.']
    },
    {
      from: 'registry', to: 'cp', label: '#b not ready', async: true,
      title: 'Health checks confirm, and the registry drops #b',
      caption: 'Three readiness probes later, #b reports 503 on /readyz too. It is marked not ready, removed from the endpoint list, and the control plane pushes the change to every proxy.',
      text: ['If #b also fails liveness, the orchestrator restarts it. Restarting on readiness failure would be wrong: a dependency outage would turn into restart loops across the whole fleet.'],
      payloadKind: 'Watch event',
      payload: { type: 'MODIFIED', service: 'orders-api', endpoints_ready: 40, not_ready: ['10.2.9.13:8000'], reason: 'readiness probe failed 3/3: HTTP 503' }
    },
    {
      from: 'orch', to: 'a', label: 'SIGTERM (deploy)',
      title: 'A deploy stops #a without dropping requests',
      caption: 'A rolling deploy replaces #a. It is first marked terminating and removed from endpoints; preStop sleeps 10 s while every proxy learns about it; then SIGTERM lets Uvicorn finish in-flight requests.',
      text: ['The ordering is the whole trick of {{connection draining}}. Removal from endpoints and SIGTERM happen in parallel in Kubernetes, so without the preStop sleep the process could exit while proxies still send it new requests.'],
      payloadKind: 'Shutdown timeline',
      payload: [
        { t: '0 s', event: 'Pod marked terminating; endpoint condition terminating=true, ready=false' },
        { t: '0–1 s', event: 'Control plane pushes removal; proxies stop picking #a for new requests' },
        { t: '0–10 s', event: 'preStop: sleep 10 (process still serves anything already in flight)' },
        { t: '10 s', event: 'SIGTERM: Uvicorn stops accepting, finishes 7 in-flight requests, closes keep-alives' },
        { t: '11.2 s', event: 'Process exits 0; new pod #d already ready and receiving traffic' }
      ],
      failure: ['**A request longer than the grace period (40 s):** cut off. Long work belongs in a background job, not in a request handler.']
    },
    {
      from: 'envoy', to: 'c', label: 'traffic to #c',
      title: 'Traffic settles on the healthy set',
      caption: 'Requests now spread across 40 healthy instances, including the new #c, whose share has finished ramping up. #b rejoins after it reconnects to the database and passes readiness again.',
      payloadKind: 'Cluster stats',
      payload: { cluster: 'orders-api', healthy: 40, ejected: 0, not_ready: 1, rq_per_s: 24810, p50_ms: 14, p99_ms: 61, retries_per_s: 3 },
      text: ['Dashboards per endpoint (request rate, error rate, latency) make an unbalanced fleet obvious, for example one zone receiving more than its share.']
    }
  ],
  api: [
    { verb: 'GET', path: '/readyz', desc: 'Readiness: 200 when the instance can serve (dependencies reachable, warmed).' },
    { verb: 'GET', path: '/livez', desc: 'Liveness: 200 while the process is responsive.' },
    { verb: 'GRPC', path: 'envoy.service.endpoint.v3.EndpointDiscoveryService', desc: 'xDS stream from control plane to proxies.' }
  ],
  schemaLang: 'text',
  schemaNote: 'What the registry stores per service (Kubernetes EndpointSlice shape).',
  schema: String.raw`
EndpointSlice  orders-api-x7k2p
  addressType: IPv4
  ports: [{ name: http, port: 8000 }]
  endpoints:
  - addresses: [10.1.7.4]   zone: eu-west-1a  conditions: { ready: true,  serving: true,  terminating: false }
  - addresses: [10.2.9.13]  zone: eu-west-1b  conditions: { ready: false, serving: false, terminating: false }
  - addresses: [10.3.14.27] zone: eu-west-1c  conditions: { ready: true,  serving: true,  terminating: false }`,
  decisions: [
    { q: 'Which balancing algorithm?', options: [
      { verdict: 'ok', name: 'Round robin', why: 'Even counts, uneven load when request costs vary.' },
      { verdict: 'good', name: 'Least connections over all endpoints', why: 'Adapts to load but every proxy herds to the same idle instance.' },
      { verdict: 'great', name: 'Least request with two random choices, zone-aware, slow start', why: 'Near-optimal balance, no herding, gentle on new instances.' }
    ] },
    { q: 'How do you notice a broken instance?', options: [
      { verdict: 'bad', name: 'Liveness probe restarts on any dependency error', why: 'A database blip restarts the whole fleet.' },
      { verdict: 'great', name: 'Readiness for routing, liveness for restarts, outlier detection on real traffic', why: 'Fast reaction, no restart storms.' }
    ] }
  ],
  refs: [
    { label: 'Envoy: Outlier detection', url: 'https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/outlier' },
    { label: 'Kubernetes: Liveness, readiness and startup probes', url: 'https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/' },
    { label: 'Mitzenmacher: The power of two choices in randomized load balancing', url: 'https://www.eecs.harvard.edu/~michaelm/postscripts/mythesis.pdf' }
  ]
});
