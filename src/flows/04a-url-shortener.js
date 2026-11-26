flow({
  id: 'url-shortener',
  title: 'URL shortener',
  category: 'Product systems',
  tags: ['Base62', 'Snowflake IDs', 'Redis', 'PostgreSQL', 'CDN', 'Analytics'],
  summary: 'Paste a long link, get sho.rt/aZ3kP9x, and watch millions of clicks redirect in milliseconds. Key generation without collisions, the 301 vs 302 choice, cache-aside reads at the edge and in Redis, and click analytics that never slow the redirect down.',
  requirements: {
    functional: [
      'Signed-in users create a short link for a long URL, optionally with a custom alias and an expiry date.',
      'Anyone opening the short link is redirected to the long URL.',
      'Owners see click counts per day, country and referrer.'
    ],
    nonFunctional: [
      'Redirects are fast (p99 under 20 ms at the server) and keep working even if the write path is down.',
      'Short codes are unique, short (7 characters) and not guessable in sequence.',
      'Reads outnumber writes about 100 to 1; analytics may lag by a minute.'
    ]
  },
  estimates: [
    { label: 'New links', value: '100 / s', note: 'Assumption: about 8.6M a day.' },
    { label: 'Redirects', value: '10,000 / s', note: '100 reads per write. Peaks 3× higher; most absorbed by the CDN and Redis.' },
    { label: 'Code space', value: '62⁷ ≈ 3.5 × 10¹²', note: '7 Base62 characters. At 8.6M a day that lasts about 1,100 years.' },
    { label: 'Storage', value: '≈ 1.6 TB / 5 years', note: '15.7B links × about 100 bytes per row (plus indexes).' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'app', label: 'Next.js app', sub: 'dashboard', kind: 'client', x: 0, y: 0, desc: 'Where the owner pastes the long URL and later reads the analytics.' },
    { id: 'visitor', label: 'Visitor', sub: 'browser', kind: 'client', icon: 'user', x: 0, y: 2, desc: 'Anyone who clicks sho.rt/aZ3kP9x in a chat, an email or a post.' },
    { id: 'cdn', label: 'CDN edge', sub: 'cache', kind: 'edge', icon: 'cdn', x: 1, y: 2, desc: 'Caches redirect responses close to visitors. A hit never reaches your servers.' },
    { id: 'api', label: 'Links API', sub: 'FastAPI', kind: 'service', x: 1, y: 0, desc: 'Write path: validates the URL, generates the code, stores the link.' },
    { id: 'redir', label: 'Redirect service', sub: 'FastAPI', kind: 'service', x: 2, y: 2, desc: 'Read path, deployed separately so a write-path incident cannot break redirects. Looks up the code and answers 302.' },
    { id: 'idgen', label: 'ID generator', sub: 'Snowflake', kind: 'service', icon: 'dns', x: 0, y: 1, desc: 'Produces unique 64-bit ids with no coordination per request: timestamp + machine id + sequence.' },
    { id: 'redis', label: 'Redis', sub: 'code → URL', kind: 'cache', x: 2, y: 1, desc: 'Hot codes and their long URLs. A few GB covers the links that get most clicks.' },
    { id: 'db', label: 'Links DB', sub: 'PostgreSQL', kind: 'db', x: 1, y: 1, desc: 'Source of truth: one row per link, primary key on the code.' },
    { id: 'kafka', label: 'Click events', sub: 'Kafka', kind: 'queue', x: 3, y: 1, desc: 'Every redirect emits a small event here, fire-and-forget, so analytics never adds latency.' },
    { id: 'olap', label: 'Analytics', sub: 'ClickHouse', kind: 'db', icon: 'chart', x: 3, y: 0, desc: 'Column store that aggregates billions of clicks by day, country and referrer in milliseconds.' }
  ],
  steps: [
    {
      from: 'app', to: 'api', label: 'POST /v1/links',
      title: 'The owner submits a long URL',
      caption: 'The dashboard posts the long URL, an optional alias and an expiry. The request carries the session cookie and an Idempotency-Key so a double click does not create two links.',
      text: ['The API validates the URL strictly: scheme must be `http` or `https`, the host must resolve, and it is checked against a malware and phishing list. Shorteners are a favourite tool for hiding bad links, so this check is part of the product, not an extra.', 'The {{idempotency key}} is a UUID the client generates once per form render. A retry with the same key returns the first result.'],
      payloadKind: 'HTTP request',
      payload: { method: 'POST', path: '/v1/links', headers: { Cookie: 'session=…', 'Idempotency-Key': '6f1c0e9a-3b7d-4c55-9e1a-2d8f0b4c7a11' }, body: { long_url: 'https://www.example.com/blog/2026/11/how-we-cut-p99-latency-in-half?utm_source=newsletter', custom_alias: null, expires_at: '2027-11-25T00:00:00Z' } },
      fields: { 'body.custom_alias': 'Optional. If set, it is checked for availability instead of generating a code.', 'body.expires_at': 'After this moment the redirect answers 410 Gone.' },
      code: [{ lang: 'ts', title: 'Next.js server action', src: String.raw`
'use server';
import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';

export async function createLink(form: FormData) {
  const res = await fetch(process.env.API_URL + '/v1/links', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': String(form.get('idem') ?? randomUUID()), // hidden input, one per form render
      Cookie: (await cookies()).toString(),
    },
    body: JSON.stringify({
      long_url: form.get('url'),
      custom_alias: form.get('alias') || null,
      expires_at: form.get('expires') || null,
    }),
  });
  if (res.status === 409) return { error: 'That alias is taken' };
  if (!res.ok) return { error: 'Could not create the link' };
  return (await res.json()) as { code: string; short_url: string };
}` }]
    },
    {
      from: 'api', to: 'idgen', label: 'next_id()',
      title: 'Get a unique id without asking the database',
      caption: 'A Snowflake-style generator returns a 64-bit id: 41 bits of milliseconds, 10 bits of machine id, 12 bits of sequence. Unique across machines with no lock and no round trip.',
      text: ['Options for unique codes: hash the URL and truncate (collisions, needs a check), a database sequence (one bottleneck, and codes are guessable in order), or a {{snowflake id}} encoded in {{base62}}. The generator usually runs in-process as a library; it is drawn separately here to show its role.', 'Sequential ids leak your volume (aZ3kP9x then aZ3kP9y). Many shorteners pass the id through a reversible keyed permutation before encoding, so neighbours look unrelated.'],
      payloadKind: 'Snowflake id, bit layout',
      payload: { id: '7399411829406576640', layout: 'sign 0 | ms since epoch (41 bits) | machine 37 (10 bits) | seq 0 (12 bits)', epoch: '2024-01-01T00:00:00Z (custom epoch)', machine_id: 37, sequence: 0 },
      fields: { machine_id: 'Assigned at start-up (from the pod ordinal or a lease in Redis/etcd). Two machines must never share one.', sequence: 'Up to 4,096 ids per millisecond per machine; on overflow, wait for the next millisecond.' },
      code: [{ lang: 'python', title: 'Snowflake generator (single process)', src: String.raw`
import threading, time

EPOCH_MS = 1704067200000          # 2024-01-01

class Snowflake:
    def __init__(self, machine_id: int):
        assert 0 <= machine_id < 1024
        self.machine_id, self.seq, self.last = machine_id, 0, -1
        self.lock = threading.Lock()

    def next_id(self) -> int:
        with self.lock:
            now = int(time.time() * 1000)
            if now < self.last:                      # clock moved backwards
                raise RuntimeError("clock skew, refusing to issue ids")
            if now == self.last:
                self.seq = (self.seq + 1) & 0xFFF
                if self.seq == 0:                    # 4096 used this ms
                    while now <= self.last:
                        now = int(time.time() * 1000)
            else:
                self.seq = 0
            self.last = now
            return ((now - EPOCH_MS) << 22) | (self.machine_id << 12) | self.seq` }],
      failure: ['**Clock goes backwards (NTP step):** refuse to issue ids until the clock catches up, or duplicates are possible. Run NTP in slew mode so it never steps.']
    },
    {
      from: 'api', to: 'db', label: 'INSERT link',
      title: 'Encode to Base62 and store the link',
      caption: 'The scrambled id becomes a 7-character Base62 code. The row is inserted with the code as primary key; the unique constraint is the final safety net.',
      text: ['Base62 uses `0-9A-Za-z`: URL-safe, no padding, case-sensitive. Custom aliases live in the same table, so an alias that collides with an existing code gets a 409.', 'The idempotency record is written in the same transaction, so a retry finds it and returns this link.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
BEGIN;
INSERT INTO links (code, long_url, owner_id, expires_at)
VALUES ('aZ3kP9x', 'https://www.example.com/blog/2026/11/how-we-cut-p99-latency-in-half?utm_source=newsletter',
        'usr_0f3a', '2027-11-25T00:00:00Z');
INSERT INTO idempotency_keys (key, owner_id, response)
VALUES ('6f1c0e9a-…', 'usr_0f3a', '{"code":"aZ3kP9x"}');
COMMIT;`,
      code: [{ lang: 'python', title: 'FastAPI endpoint', src: String.raw`
ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

def base62(n: int, width: int = 7) -> str:
    s = []
    while n:
        n, r = divmod(n, 62)
        s.append(ALPHABET[r])
    return "".join(reversed(s)).rjust(width, "0")

@router.post("/v1/links", status_code=201)
async def create_link(body: LinkIn, user=Depends(current_user),
                      idem: str = Header(alias="Idempotency-Key"), db=Depends(get_db)):
    if prev := await db.fetchval("SELECT response FROM idempotency_keys WHERE key=$1 AND owner_id=$2", idem, user.id):
        return json.loads(prev)
    await check_url_safe(body.long_url)                     # scheme, DNS, blocklist
    code = body.custom_alias or base62(permute(snowflake.next_id() % 62**7))
    try:
        async with db.transaction():
            await db.execute("INSERT INTO links (code, long_url, owner_id, expires_at) VALUES ($1,$2,$3,$4)",
                             code, str(body.long_url), user.id, body.expires_at)
            out = {"code": code, "short_url": f"https://sho.rt/{code}"}
            await db.execute("INSERT INTO idempotency_keys (key, owner_id, response) VALUES ($1,$2,$3)",
                             idem, user.id, json.dumps(out))
    except UniqueViolationError:
        raise HTTPException(409, "alias taken")             # or retry with a new id
    return out` }],
      fields: { code: 'Primary key. Reducing modulo 62⁷ keeps it at 7 characters but can collide after wrap-around; the unique constraint catches that and the API retries with a fresh id.' }
    },
    {
      from: 'api', to: 'app', label: '201 short_url', reply: true,
      title: 'The owner gets the short link',
      caption: 'The response contains the code and the full short URL. Nothing is written to Redis yet: the cache fills on the first click.',
      text: ['Writing to the cache on create sounds helpful, but most links are clicked rarely or never. Filling on read keeps Redis full of links people actually open ({{cache-aside}}).'],
      payloadKind: 'HTTP response',
      payload: { status: 201, body: { code: 'aZ3kP9x', short_url: 'https://sho.rt/aZ3kP9x', long_url: 'https://www.example.com/blog/2026/11/how-we-cut-p99-latency-in-half?utm_source=newsletter', expires_at: '2027-11-25T00:00:00Z' } }
    },
    {
      from: 'visitor', to: 'cdn', label: 'GET /aZ3kP9x',
      title: 'A visitor clicks the short link',
      caption: 'DNS for sho.rt points at the CDN. The edge looks for a cached response for /aZ3kP9x; this is the first click, so it is a miss and the request goes to the origin.',
      text: ['The {{cdn}} terminates {{tls}} near the visitor, which alone saves tens of milliseconds on a cross-continent click. Popular links are then served entirely from the edge.'],
      payloadKind: 'HTTP request',
      payloadLang: 'http',
      payload: String.raw`
GET /aZ3kP9x HTTP/2
Host: sho.rt
User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) …
Referer: https://t.co/
Accept-Language: fr-BE,fr;q=0.9`
    },
    {
      from: 'cdn', to: 'redir', label: 'cache miss',
      title: 'The edge forwards to the redirect service',
      caption: 'The CDN adds the visitor\'s country and IP in headers and forwards. The redirect service is stateless and scaled separately from the Links API.',
      payloadKind: 'Forwarded request',
      payload: { path: '/aZ3kP9x', headers: { 'CF-IPCountry': 'BE', 'X-Forwarded-For': '81.164.12.7', Referer: 'https://t.co/' } },
      fields: { 'headers.CF-IPCountry': 'Added by the edge (the header name depends on the CDN). Saves a GeoIP lookup at the origin.' },
      text: ['Separating read and write paths means each scales on its own metric, and a bad deploy of the dashboard API cannot take every short link down with it.']
    },
    {
      from: 'redir', to: 'redis', label: 'GET link:aZ3kP9x',
      title: 'Look in Redis first',
      caption: 'Miss: the code is not cached yet. On a hit (the usual case for popular links) the whole lookup takes well under a millisecond.',
      text: ['Cache entries get a {{ttl}} of a day plus random {{jitter}}, so a batch of links created together does not expire together.', 'Unknown codes are cached too, as a short-lived "not found" marker. Otherwise a bot scanning random codes would turn every request into a database query.'],
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
> GET link:aZ3kP9x
(nil)                       -- miss`,
      failure: ['**Redis is down:** fall through to the database with a tight timeout and a {{circuit breaker}}, so a Redis outage becomes slower redirects, not failed ones.']
    },
    {
      from: 'redir', to: 'db', label: 'SELECT by code',
      title: 'Read the source of truth, then fill the cache',
      caption: 'A primary-key lookup on a read replica returns the long URL and expiry. The service writes it to Redis with a TTL and continues.',
      text: ['Reads go to a {{read replica}}: a link created a few milliseconds ago may not be there yet ({{replication lag}}). If the replica misses, retry once on the primary before answering 404.'],
      payloadKind: 'SQL + cache fill',
      payloadLang: 'sql',
      payload: String.raw`
SELECT long_url, expires_at, disabled FROM links WHERE code = 'aZ3kP9x';
-- → https://www.example.com/blog/2026/11/… | 2027-11-25 | false

SET link:aZ3kP9x '{"u":"https://www.example.com/blog/…","exp":1826928000}' EX 88412`,
      code: [{ lang: 'python', title: 'Redirect endpoint', src: String.raw`
@app.get("/{code}")
async def redirect(code: str, request: Request):
    if not CODE_RE.fullmatch(code):
        raise HTTPException(404)
    cached = await redis.get(f"link:{code}")
    if cached == b"-":                                   # negative cache
        raise HTTPException(404)
    if cached:
        link = json.loads(cached)
    else:
        q = "SELECT long_url, expires_at, disabled FROM links WHERE code=$1"
        row = await replica.fetchrow(q, code) or await primary.fetchrow(q, code)
        if not row or row["disabled"]:
            await redis.set(f"link:{code}", "-", ex=60)
            raise HTTPException(404)
        link = {"u": row["long_url"], "exp": row["expires_at"] and int(row["expires_at"].timestamp())}
        await redis.set(f"link:{code}", json.dumps(link), ex=86400 + random.randint(0, 3600))
    if link["exp"] and link["exp"] < time.time():
        raise HTTPException(410, "expired")
    emit_click(code, request)                            # non-blocking, next step
    return RedirectResponse(link["u"], status_code=302,
                            headers={"Cache-Control": "public, max-age=300"})` }]
    },
    {
      from: 'redir', to: 'kafka', label: 'click event', async: true,
      title: 'Record the click without waiting',
      caption: 'The service hands a click event to the local Kafka producer buffer and returns immediately. The producer batches events and sends them in the background.',
      text: ['If the analytics pipeline is slow or down, redirects must not notice. The producer has a bounded buffer; when it is full, events are dropped and a counter is incremented. Losing a few clicks during an outage is acceptable; slow redirects are not.', 'Clicks served entirely by the CDN never reach the origin. To count them, ship the CDN\'s access logs into the same topic.'],
      payloadKind: 'Kafka record',
      payload: { topic: 'link-clicks', key: 'aZ3kP9x', value: { code: 'aZ3kP9x', ts: '2026-11-25T10:41:07.311Z', country: 'BE', referrer_host: 't.co', ua_family: 'Mobile Safari', ip_hash: 'b3f1…(salted, rotated daily)' } },
      fields: { key: 'Keyed by code so all clicks of a link land in one {{partition}}.', 'value.ip_hash': 'A salted hash, not the raw IP: enough to count unique visitors without keeping personal data.' }
    },
    {
      from: 'redir', to: 'cdn', label: '302 Location', reply: true,
      title: 'The visitor is redirected',
      caption: 'A 302 with the long URL in Location goes back through the edge to the visitor\'s browser, which follows it. The CDN caches this response for five minutes, so the next clicks from that region never reach the origin.',
      text: ['**301 or 302?** A 301 (permanent) can be cached by browsers indefinitely: faster for repeat visitors, but you lose analytics for them and cannot change or disable the link for those browsers. Most commercial shorteners use 302 (or 307) and let the CDN cache it briefly.', 'Disabling a malicious link then takes effect within the CDN max-age, and you can purge the CDN path for urgent cases.'],
      payloadKind: 'HTTP response',
      payloadLang: 'http',
      payload: String.raw`
HTTP/2 302
Location: https://www.example.com/blog/2026/11/how-we-cut-p99-latency-in-half?utm_source=newsletter
Cache-Control: public, max-age=300
Content-Length: 0`,
      fields: { 'Cache-Control': 'Lets the CDN serve the next five minutes of clicks.' }
    },
    {
      from: 'kafka', to: 'olap', label: 'consume + insert batches', async: true,
      title: 'Clicks become analytics',
      caption: 'ClickHouse reads the topic with its Kafka engine and inserts batches. A materialized view keeps per-link, per-day counts up to date as rows arrive.',
      text: ['Inserting in batches of thousands is what {{columnar storage}} engines want. The {{materialized view}} turns raw clicks into small aggregate rows, so the dashboard query reads a few hundred rows instead of millions.'],
      payloadKind: 'ClickHouse SQL',
      payloadLang: 'sql',
      payload: String.raw`
CREATE TABLE clicks (code String, ts DateTime64(3), country LowCardinality(String),
                     referrer_host String, ip_hash String)
ENGINE = MergeTree ORDER BY (code, ts);

CREATE MATERIALIZED VIEW clicks_daily_mv TO clicks_daily AS
SELECT code, toDate(ts) AS day, country, count() AS clicks, uniqState(ip_hash) AS visitors
FROM clicks GROUP BY code, day, country;`,
      failure: ['**Consumer falls behind:** {{consumer lag}} grows and dashboards show slightly stale numbers; redirects are unaffected. Alert on lag, not on individual events.']
    },
    {
      from: 'api', to: 'olap', label: 'stats query',
      title: 'The owner reads the stats',
      caption: 'The dashboard calls GET /v1/links/aZ3kP9x/stats; the Links API checks ownership and queries the aggregate table. Numbers trail reality by seconds to a minute.',
      text: ['Reading the small `clicks_daily` table, not raw clicks, keeps this query in the low milliseconds even for links with millions of clicks. Unique visitors use `uniqMerge` over the stored HyperLogLog-style states.'],
      payloadKind: 'Response',
      payload: { code: 'aZ3kP9x', range: '2026-11-19..2026-11-25', total_clicks: 48213, unique_visitors: 31877, by_day: [{ day: '2026-11-24', clicks: 12034 }, { day: '2026-11-25', clicks: 30111 }], top_countries: [{ country: 'BE', clicks: 9120 }, { country: 'FR', clicks: 7766 }], top_referrers: [{ host: 't.co', clicks: 20410 }, { host: 'mail.google.com', clicks: 8113 }] }
    }
  ],
  api: [
    { verb: 'POST', path: '/v1/links', desc: 'Create a link. Body: long_url, custom_alias?, expires_at?. Requires Idempotency-Key.' },
    { verb: 'GET', path: '/{code}', desc: '302 to the long URL; 404 unknown; 410 expired.' },
    { verb: 'GET', path: '/v1/links/{code}/stats', desc: 'Clicks by day, country and referrer, owner only.' },
    { verb: 'DELETE', path: '/v1/links/{code}', desc: 'Disable the link; deletes the Redis key and purges the CDN path.' }
  ],
  schema: String.raw`
CREATE TABLE links (
  code        VARCHAR(16) PRIMARY KEY,      -- Base62 code or custom alias
  long_url    TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,
  disabled    BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX links_owner ON links (owner_id, created_at DESC);   -- "my links" page

CREATE TABLE idempotency_keys (
  key TEXT, owner_id TEXT, response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, key)
);  -- purge rows older than 24 h`,
  decisions: [
    { q: 'How do you generate unique short codes?', options: [
      { verdict: 'bad', name: 'Hash the long URL (MD5) and take 7 characters', why: 'Collisions are possible and must be checked and retried; the same URL from two owners collides on purpose.' },
      { verdict: 'good', name: 'Database sequence + Base62', why: 'Simple and unique, but one central counter and codes are guessable in order.' },
      { verdict: 'great', name: 'Snowflake ids (or counter ranges handed out per server) + permutation + Base62', why: 'No coordination per request, unique by construction, not enumerable.' }
    ] },
    { q: '301 or 302?', options: [
      { verdict: 'good', name: '301 Moved Permanently', why: 'Fewest requests, but browsers may cache it forever: no analytics and no way to disable the link.' },
      { verdict: 'great', name: '302 with a short CDN max-age', why: 'Edge caching for speed while keeping control and analytics.' }
    ] },
    { q: 'How do you keep analytics from slowing redirects?', options: [
      { verdict: 'bad', name: 'UPDATE links SET clicks = clicks + 1 on every redirect', why: 'A viral link becomes a hot row: lock contention and a write per read.' },
      { verdict: 'great', name: 'Fire-and-forget events to Kafka, aggregated in a column store', why: 'The redirect path stays read-only; analytics scale on their own.' }
    ] }
  ],
  refs: [
    { label: 'Twitter: Snowflake source code (2010 release)', url: 'https://github.com/twitter-archive/snowflake/tree/snowflake-2010', note: 'The original id layout.' },
    { label: 'MDN: 302 Found', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/302' },
    { label: 'MDN: 301 Moved Permanently', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/301' },
    { label: 'ClickHouse: Kafka table engine', url: 'https://clickhouse.com/docs/en/engines/table-engines/integrations/kafka' }
  ]
});
