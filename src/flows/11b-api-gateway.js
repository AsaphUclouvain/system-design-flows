flow({
  id: 'api-gateway',
  title: 'API gateway and backend for frontend',
  category: 'Infrastructure foundations',
  tags: ['API gateway', 'JWT validation', 'BFF aggregation', 'Timeouts', 'Circuit breaker', 'Partial responses'],
  summary: 'The mobile home screen needs the user, their recent orders and recommendations. One request goes to the gateway, which authenticates it, applies limits, then a BFF calls three services in parallel with deadlines and returns a screen-shaped response, even when the recommendation service is down.',
  requirements: {
    functional: [
      'One public entry point for all clients, routing /v1/* to the right internal service.',
      'Authentication, rate limits, request ids and CORS handled once, not in every service.',
      'A home-screen endpoint that aggregates several services into one response.'
    ],
    nonFunctional: [
      'Gateway overhead under 5 ms; home screen p95 under 300 ms.',
      'A failing non-critical service degrades the screen instead of breaking it.',
      'Internal services are never reachable from the Internet directly.'
    ]
  },
  estimates: [
    { label: 'Gateway traffic', value: '18,000 req/s', note: 'All public API calls at peak.' },
    { label: 'Home screen calls', value: '2,500 / s', note: 'Each turns into 3 internal calls: 7,500 internal req/s.' },
    { label: 'Latency budget', value: '300 ms', note: 'Gateway 5 + BFF 10 + slowest parallel call ≤ 250 (deadline) + network.' },
    { label: 'JWKS fetches', value: '≈ 0 / s', note: 'Keys are cached for hours; signature checks are local CPU work (~50 µs).' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'app', label: 'Mobile app', sub: 'React Native', kind: 'client', icon: 'phone', x: 0, y: 0, desc: 'Opens the home screen.' },
    { id: 'gw', label: 'API gateway', sub: 'Kong / Envoy', kind: 'edge', icon: 'shield', x: 1, y: 0, desc: 'TLS, authentication, rate limits, routing, request ids, access logs.' },
    { id: 'idp', label: 'Identity provider', sub: 'JWKS endpoint', kind: 'external', icon: 'key', x: 1, y: 2, desc: 'Publishes the public keys that sign access tokens.' },
    { id: 'rl', label: 'Rate limit store', sub: 'Redis', kind: 'cache', x: 0, y: 2, desc: 'Token buckets per user and per API key.' },
    { id: 'bff', label: 'Mobile BFF', sub: 'FastAPI', kind: 'service', x: 2, y: 0, desc: 'Backend for the mobile app: one endpoint per screen, fans out to services.' },
    { id: 'users', label: 'Users service', sub: 'FastAPI', kind: 'service', icon: 'user', x: 3, y: 0, desc: 'Profile and settings.' },
    { id: 'orders', label: 'Orders service', sub: 'FastAPI', kind: 'service', icon: 'cart', x: 3, y: 1, desc: 'Order history.' },
    { id: 'recs', label: 'Recs service', sub: 'ML, recommendations', kind: 'service', icon: 'cpu', x: 3, y: 2, desc: 'Personalised products; slow sometimes, and not critical.' },
    { id: 'cache', label: 'BFF cache', sub: 'Redis', kind: 'cache', x: 2, y: 2, desc: 'Last good recommendations per user, used as a fallback.' }
  ],
  steps: [
    {
      from: 'app', to: 'gw', label: 'GET /v1/home',
      title: 'The app asks for the home screen',
      caption: 'One request, carrying the user\'s access token. Without a BFF, the app would make three calls over a mobile network, each paying its own latency.',
      text: ['On a 4G connection a round trip can be 80 ms or more. Three sequential calls cost a quarter of a second before any data arrives; one aggregated call costs one round trip.'],
      payloadKind: 'HTTP request',
      payload: { method: 'GET', path: '/v1/home', headers: { Authorization: 'Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6ImsyMDI2LTExIn0.eyJzdWIiOiJ1c3JfYW5hIi…', 'X-App-Version': 'ios/5.12.0', 'Accept-Language': 'fr-BE' } },
      fields: { 'X-App-Version': 'Lets the BFF shape responses for old app versions still in the wild.' }
    },
    {
      from: 'gw', to: 'idp', label: 'JWKS (cached)',
      title: 'Validate the token locally',
      caption: 'The gateway reads the token header (kid = k2026-11), takes the matching public key from its JWKS cache, and verifies the signature, expiry, issuer and audience. No call to the identity provider per request.',
      text: ['The JWKS is refreshed every few hours, or immediately when a token arrives with an unknown `kid` (key rotation), with a lower bound so a flood of forged kids cannot hammer the endpoint.', 'The gateway passes identity downstream as trusted headers and strips any such headers coming from the Internet, so a client cannot forge `X-User-Id`.'],
      payloadKind: 'Decoded JWT',
      payload: { header: { alg: 'RS256', kid: 'k2026-11' }, claims: { iss: 'https://auth.shop.example', aud: 'shop-api', sub: 'usr_ana', scope: 'orders:read profile:read', exp: 1764070502, iat: 1764069602 }, checks: { signature: 'ok', exp: 'ok (in 14 min)', aud: 'ok' } },
      fields: { kid: 'Key id: which key in the {{jwks}} signed this token.', scope: 'The gateway can reject a route early if the scope is missing (orders:read for /v1/orders).' },
      failure: ['**Expired or invalid token:** 401 with `WWW-Authenticate: Bearer error="invalid_token"`; the app refreshes its token and retries once.', '**JWKS endpoint down:** cached keys keep working; only tokens signed by a brand-new key fail until it recovers.']
    },
    {
      from: 'gw', to: 'rl', label: 'token bucket usr_ana',
      title: 'Apply rate limits',
      caption: 'The gateway takes one token from usr_ana\'s bucket (100 requests per minute for mobile users). Plenty left, so the request continues, with remaining quota in the response headers.',
      text: ['The rate-limiter flow covers the algorithm. At the gateway, the important choices are the key (user id after authentication, IP before) and failing open: if Redis is unreachable, requests pass rather than the whole API going down.'],
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
> EVALSHA 3f1c… 1 rl:usr_ana:mobile 100 60 1764069602
1) (integer) 1        -- allowed
2) (integer) 87       -- tokens left`,
      failure: ['**Over the limit:** 429 with `Retry-After`. The app backs off; the gateway never forwards the request.']
    },
    {
      from: 'gw', to: 'bff', label: 'route /v1/home → mobile-bff',
      title: 'Route to the mobile BFF',
      caption: 'The route table sends /v1/home to the mobile BFF. The gateway adds a request id, the verified user id, and a deadline header: the whole request must finish within 800 ms.',
      text: ['Each client type gets its own {{bff}} (mobile, web, partners) because screens differ. Shared logic stays in the domain services, not in the BFFs.'],
      payloadKind: 'Forwarded request',
      payload: { method: 'GET', path: '/home', upstream: 'mobile-bff.internal:8000', headers: { 'X-Request-Id': 'req_01JDQF3N', 'X-User-Id': 'usr_ana', 'X-Scopes': 'orders:read profile:read', 'X-Deadline-Ms': '800', traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' } },
      fields: { 'X-Deadline-Ms': 'Propagated so every downstream call knows how much time is left; work past the deadline is wasted.', traceparent: 'W3C {{trace context}}: ties all internal spans of this request together.' },
      code: [{ lang: 'text', title: 'Gateway route (Kong declarative, excerpt)', src: String.raw`
services:
- name: mobile-bff
  url: http://mobile-bff.internal:8000
  connect_timeout: 200
  read_timeout: 800
  routes:
  - name: home
    paths: [/v1/home]
    strip_path: true
  plugins:
  - name: jwt            # verify RS256 with cached JWKS
  - name: rate-limiting  # redis policy, fault_tolerant: true
  - name: correlation-id
    config: { header_name: X-Request-Id, generator: uuid }` }]
    },
    {
      from: 'bff', to: 'users', label: 'GET /users/usr_ana',
      title: 'Fan out: the user profile',
      caption: 'The BFF starts three calls at the same moment with asyncio. The profile is critical: without it the screen cannot render, so it gets a 300 ms timeout and one fast retry.',
      text: ['`asyncio.TaskGroup` starts the three calls together, so the screen costs the slowest call, not the sum. Each call carries its own timeout, all of them shorter than the deadline the gateway passed down.'],
      payloadKind: 'Internal call',
      payload: { method: 'GET', url: 'http://users.internal/users/usr_ana', timeout_ms: 300, response: { id: 'usr_ana', first_name: 'Ana', tier: 'gold', locale: 'fr-BE', avatar: 'https://img.shop.example/u/usr_ana/64.webp' }, took_ms: 21 },
      code: [{ lang: 'python', title: 'BFF home endpoint', src: String.raw`
@app.get("/home")
async def home(req: Request, user_id: str = Header(alias="X-User-Id")):
    deadline = time.monotonic() + int(req.headers.get("X-Deadline-Ms", 800)) / 1000 - 0.05
    async with asyncio.TaskGroup() as tg:          # run all three at once
        prof = tg.create_task(call(users, f"/users/{user_id}", timeout=0.3, retries=1))
        ords = tg.create_task(soft(call(orders, f"/orders?user={user_id}&limit=3", timeout=0.25)))
        recs = tg.create_task(soft(recs_with_fallback(user_id, deadline)))
    return HomeScreen(
        greeting=f"Bonjour {prof.result()['first_name']}",
        recent_orders=ords.result() or [],
        recommended=recs.result() or [],
        degraded=[n for n, t in (("orders", ords), ("recs", recs)) if t.result() is None],
    )

async def soft(coro):
    try:
        return await coro
    except (httpx.HTTPError, asyncio.TimeoutError, CircuitOpen):
        return None                                 # non-critical: degrade, do not fail` }],
      failure: ['**Users service fails after the retry:** the BFF returns 503 for the whole screen, because a home screen without the user makes no sense. The app shows its cached version from the last launch.']
    },
    {
      from: 'bff', to: 'orders', label: 'GET /orders?limit=3',
      title: 'Fan out: recent orders',
      caption: 'In parallel, the last three orders. Useful but not critical: on timeout the screen simply hides the "Recent orders" block.',
      text: ['The orders service reads from its own replica and returns a compact shape. The BFF trims it further to the three fields the screen shows, so the mobile payload stays small.'],
      payloadKind: 'Internal call',
      payload: { method: 'GET', url: 'http://orders.internal/orders?user=usr_ana&limit=3', timeout_ms: 250, response: [{ id: 'ord_7731', status: 'shipped', total: 89.0, eta: '2026-11-27' }, { id: 'ord_7604', status: 'delivered', total: 34.5 }], took_ms: 46 }
    },
    {
      from: 'bff', to: 'recs', label: 'circuit OPEN: skip',
      title: 'Fan out: recommendations, with the circuit open',
      caption: 'The recommendation service has been timing out for 40 seconds. Its circuit breaker is open, so the BFF does not even call it: no waiting 250 ms for a timeout that is almost certain.',
      text: ['A {{circuit breaker}} counts failures per dependency. Above 50% failures over 20 calls it opens; after 10 s it lets one trial call through (half-open) and closes again if it succeeds.', 'Without it, every home screen would wait the full timeout, BFF workers would pile up on a dead service, and the slowdown would spread to everything.'],
      payloadKind: 'Breaker state',
      payload: { dependency: 'recs', state: 'open', failure_rate: 0.86, window: 20, opened_at: '2026-11-25T11:41:22Z', next_trial_at: '2026-11-25T11:42:12Z' },
      code: [{ lang: 'python', title: 'Minimal circuit breaker', src: String.raw`
class Breaker:
    def __init__(self, threshold=0.5, window=20, cool_s=10):
        self.results: deque[bool] = deque(maxlen=window)
        self.state, self.opened, self.cool = "closed", 0.0, cool_s
        self.threshold = threshold

    async def run(self, fn):
        if self.state == "open":
            if time.monotonic() - self.opened < self.cool:
                raise CircuitOpen()
            self.state = "half_open"              # let one trial through
        try:
            r = await fn()
        except Exception:
            self._record(False); raise
        self._record(True)
        return r

    def _record(self, ok: bool):
        self.results.append(ok)
        if self.state == "half_open":
            self.state = "closed" if ok else "open"
            self.opened = time.monotonic()
        elif len(self.results) == self.results.maxlen and \
                self.results.count(False) / len(self.results) > self.threshold:
            self.state, self.opened = "open", time.monotonic()` }]
    },
    {
      from: 'bff', to: 'cache', label: 'GET recs:last:usr_ana',
      title: 'Fall back to the last good recommendations',
      caption: 'Instead of an empty block, the BFF serves the recommendations it cached for Ana two hours ago. They are slightly old, which is far better than nothing on a home screen.',
      text: ['Every successful recommendation response is written here with a 24 h TTL. This is a deliberate trade: stale but useful data for a non-critical block.'],
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
> GET recs:last:usr_ana
"[{\"id\":\"p_812\",\"title\":\"Speedgoat 6\"},{\"id\":\"p_455\",\"title\":\"Trail socks\"}, …]"
> TTL recs:last:usr_ana
(integer) 79012                -- cached about 2 hours ago`
    },
    {
      from: 'bff', to: 'gw', label: '200 (degraded: recs)', reply: true,
      title: 'One screen-shaped response',
      caption: 'The BFF returns exactly what the home screen renders, with a degraded marker so the app can show a subtle "recommendations may be out of date" hint. Total: 58 ms, limited by the orders call.',
      text: ['The response is shaped for the screen, not for the database: the app renders it directly without joining or reformatting anything.'],
      payloadKind: 'HTTP response',
      payload: { status: 200, headers: { 'Cache-Control': 'private, max-age=30', 'X-Request-Id': 'req_01JDQF3N' }, body: { greeting: 'Bonjour Ana', tier: 'gold', recent_orders: [{ id: 'ord_7731', status: 'shipped', eta: '2026-11-27' }, { id: 'ord_7604', status: 'delivered' }], recommended: [{ id: 'p_812', title: 'Speedgoat 6', price: 89.0 }, { id: 'p_455', title: 'Trail socks', price: 14.0 }], degraded: ['recs'] } },
      fields: { degraded: 'Lists blocks served from fallback. Monitoring counts these to see how often users get a degraded screen.', 'Cache-Control': '`private`: only the device may cache it, never a shared cache, since it is personal.' }
    },
    {
      from: 'gw', to: 'app', label: '200 + headers', reply: true,
      title: 'The gateway adds headers and logs the call',
      caption: 'On the way out the gateway adds rate-limit headers, removes internal headers, and writes one access-log line with the user, route, status and latency.',
      payloadKind: 'Access log',
      payload: { ts: '2026-11-25T11:41:43.118Z', request_id: 'req_01JDQF3N', route: 'home', user: 'usr_ana', status: 200, latency_ms: { gateway: 3, upstream: 58 }, bytes_out: 2214, ratelimit_remaining: 87, app_version: 'ios/5.12.0' },
      text: ['Internal headers like `X-User-Id` or `Server: uvicorn` are stripped so the response does not leak details of the internals.']
    }
  ],
  api: [
    { verb: 'GET', path: '/v1/home', desc: 'Mobile home screen: profile, recent orders, recommendations; may include `degraded`.' },
    { verb: 'GET', path: '/v1/orders', desc: 'Routed straight to the orders service (no aggregation needed).' },
    { verb: 'GET', path: '/.well-known/jwks.json', desc: 'Identity provider public keys, cached by the gateway.' }
  ],
  schemaLang: 'text',
  schemaNote: 'The gateway owns routing and cross-cutting rules; services own their data.',
  schema: String.raw`
Route          Upstream            Auth          Limit (per user)   Timeout   Retries
/v1/home       mobile-bff          JWT required  100/min            800 ms    0 (BFF retries)
/v1/orders/*   orders              JWT + scope   300/min            2 s       1 on connect
/v1/products/* catalog             optional      600/min (IP)       1 s       1 (GET)
/v1/webhooks/* payments-ingest     HMAC header   n/a                5 s       0

Redis (BFF)
  recs:last:{user}   last good recommendations, TTL 24 h`,
  decisions: [
    { q: 'Where does aggregation happen?', options: [
      { verdict: 'bad', name: 'The app calls each service directly', why: 'Many round trips on mobile, internals exposed, every client re-implements the joins.' },
      { verdict: 'ok', name: 'Aggregation plugins inside the gateway', why: 'Works, but business logic in gateway config is hard to test and version.' },
      { verdict: 'great', name: 'Thin gateway for cross-cutting concerns + a BFF per client', why: 'Gateway stays generic; screen logic lives in normal, tested FastAPI code.' }
    ] },
    { q: 'How do you handle a slow dependency?', options: [
      { verdict: 'bad', name: 'Wait for it', why: 'The slowest service sets the latency of every screen.' },
      { verdict: 'great', name: 'Deadline per call, circuit breaker, and fallback for non-critical blocks', why: 'Bounded latency, and partial screens instead of errors.' }
    ] }
  ],
  refs: [
    { label: 'Sam Newman: Backends for Frontends', url: 'https://samnewman.io/patterns/architectural/bff/' },
    { label: 'Martin Fowler: Circuit Breaker', url: 'https://martinfowler.com/bliki/CircuitBreaker.html' },
    { label: 'RFC 7517: JSON Web Key (JWK)', url: 'https://www.rfc-editor.org/rfc/rfc7517' }
  ]
});
