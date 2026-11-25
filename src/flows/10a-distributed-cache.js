flow({
  id: 'distributed-cache',
  title: 'Distributed cache (Redis cache-aside with invalidation)',
  category: 'Infrastructure foundations',
  tags: ['Cache-aside', 'Redis Cluster', 'Stampede protection', 'CDC invalidation', 'Two-level cache'],
  summary: 'A product page is read 40,000 times a second but changes a few times a day. Follow one read through an in-process cache, Redis and PostgreSQL, see how a stampede on an expired hot key is stopped, then follow a price change as it invalidates every copy within a second.',
  requirements: {
    functional: [
      'GET /v1/products/{id} returns the product with price and stock.',
      'After an admin changes a price, readers see the new price within about one second.',
      'A missing product returns 404 quickly, without hitting the database every time.'
    ],
    nonFunctional: [
      'p99 read latency under 15 ms at 40,000 reads per second.',
      'The database must survive the cache being cold or a hot key expiring.',
      'The cache is an optimisation: if Redis is down, reads still work (slower).'
    ]
  },
  estimates: [
    { label: 'Reads', value: '40,000 / s', note: 'Peak, all product pages together.' },
    { label: 'Hit ratio target', value: '≥ 99%', note: '1% of 40,000 = 400 database reads/s, which two replicas handle easily.' },
    { label: 'Hot set size', value: '≈ 2 GB', note: '500k products × ~4 KB JSON; fits in a 3-shard Redis Cluster with room to spare.' },
    { label: 'Hottest key', value: '≈ 6,000 / s', note: 'One product on the home page. That is why a small in-process L1 cache sits in front of Redis.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'web', label: 'Product page', sub: 'Next.js', kind: 'client', icon: 'phone', x: 0, y: 0, desc: 'Server component that renders the product page and calls the API.' },
    { id: 'api', label: 'Catalog API', sub: 'FastAPI pods', kind: 'service', x: 1, y: 0, desc: 'Implements cache-aside: L1 in memory, then Redis, then the database.' },
    { id: 'l1', label: 'L1 cache', sub: 'in-process LRU', kind: 'cache', x: 1, y: 1, desc: 'A few thousand entries per pod with a 5 s TTL. Absorbs hot keys without a network hop.' },
    { id: 'redis', label: 'Redis Cluster', sub: '3 shards × 2', kind: 'cache', x: 2, y: 0, desc: '16,384 hash slots split across 3 primaries, each with a replica. Keys are product JSON with a TTL.' },
    { id: 'replica', label: 'Read replica', sub: 'PostgreSQL', kind: 'db', x: 3, y: 0, desc: 'Serves cache misses so the primary only handles writes.' },
    { id: 'admin', label: 'Admin console', sub: 'Next.js', kind: 'client', icon: 'user', x: 0, y: 2, desc: 'Where the merchandising team changes prices.' },
    { id: 'primary', label: 'Primary DB', sub: 'PostgreSQL', kind: 'db', x: 2, y: 2, desc: 'Source of truth for products. Writes go here.' },
    { id: 'cdc', label: 'Invalidator', sub: 'CDC consumer', kind: 'worker', x: 3, y: 2, desc: 'Reads the database change stream and deletes the matching cache keys, then tells every pod to drop its L1 copy.' },
    { id: 'bus', label: 'Pub/Sub channel', sub: 'Redis', kind: 'queue', x: 3, y: 1, desc: 'Broadcasts "drop key X" to all API pods so their L1 caches stay in step.' }
  ],
  steps: [
    {
      from: 'web', to: 'api', label: 'GET /v1/products/p_812',
      title: 'The page asks for a product',
      caption: 'The Next.js server component fetches the product. The API answers from the fastest place that holds a fresh copy.',
      text: ['The Next.js data cache could also hold the response, but then it becomes one more copy to invalidate. Here it is disabled with `cache: "no-store"` and the API owns caching in one place.'],
      payloadKind: 'HTTP request',
      payload: { method: 'GET', path: '/v1/products/p_812', headers: { Accept: 'application/json', 'X-Request-Id': 'req_7f3a91' } },
      code: [{ lang: 'ts', title: 'app/products/[id]/page.tsx', src: String.raw`
export default async function ProductPage({ params }: { params: { id: string } }) {
  const res = await fetch(process.env.API_URL + "/v1/products/" + params.id, {
    cache: "no-store",                  // one cache layer to reason about: the API's
    signal: AbortSignal.timeout(800),
  });
  if (res.status === 404) notFound();
  const p: Product = await res.json();
  return <ProductView product={p} />;
}` }]
    },
    {
      from: 'api', to: 'l1', label: 'L1 lookup', 
      title: 'Check the in-process cache first',
      caption: 'Each API pod keeps a tiny LRU map with a 5-second TTL. For the hottest products this answers in microseconds and Redis never sees the request.',
      text: ['The L1 TTL is short on purpose: it bounds how stale a pod can be if an invalidation message is lost. Five seconds of staleness on a product page is acceptable; on a bank balance it would not be.', 'Here the entry for p_812 is missing (the pod just started), so the API goes to Redis.'],
      payloadKind: 'L1 state',
      payload: { key: 'product:p_812:v3', hit: false, size: 1834, capacity: 5000, ttl_s: 5 },
      fields: { 'key': 'The `v3` suffix is the cache schema version. Changing the JSON shape bumps it, so old and new pods never read each other\'s format.' },
      code: [{ lang: 'python', title: 'Two-level cache', src: String.raw`
from cachetools import TTLCache
l1: TTLCache[str, bytes] = TTLCache(maxsize=5000, ttl=5)

def key(pid: str) -> str:
    return f"product:{pid}:v3"

async def get_product(pid: str) -> bytes | None:
    k = key(pid)
    if (v := l1.get(k)) is not None:
        return v                                   # microseconds, no network
    v = await redis_get_or_load(k, pid)            # next steps
    if v is not None:
        l1[k] = v
    return v` }]
    },
    {
      from: 'api', to: 'redis', label: 'GET product:p_812:v3',
      title: 'Ask Redis: the key has expired',
      caption: 'The client hashes the key to one of 16,384 slots and sends GET to the shard that owns it. The entry expired a moment ago, so Redis returns nil.',
      text: ['In Redis Cluster the slot is CRC16(key) mod 16384. The client library caches the slot map and follows a `MOVED` reply if a slot has migrated.', 'This product is on the home page: about 6,000 requests a second share this key. If they all go to the database now, that is a {{cache stampede}}.'],
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
> CLUSTER KEYSLOT product:p_812:v3
(integer) 9132                 -- owned by shard B (slots 5461–10922)
> GET product:p_812:v3
(nil)                          -- TTL ran out 40 ms ago`,
      failure: ['**Redis shard down or slow:** the client has a 50 ms timeout and a {{circuit breaker}}. When it opens, the API skips Redis and reads the replica directly with a concurrency limit, serving slower pages instead of errors.', '**MOVED / ASK reply during resharding:** the client refreshes its slot map and retries on the right node; the caller does not notice.']
    },
    {
      from: 'api', to: 'redis', label: 'SET lock NX PX 3000',
      title: 'Only one request reloads the key',
      caption: 'The request tries to take a short lock for this key. One pod wins and loads from the database; the others wait a few milliseconds and read the value it writes.',
      text: ['This is {{single-flight}} across pods. Inside one pod, an asyncio future per key does the same for concurrent coroutines, so at most one request per pod even tries the lock.', 'An alternative is probabilistic early refresh: each read near the end of the TTL has a small chance to refresh early, so the key rarely expires under load at all.'],
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
> SET lock:product:p_812:v3 pod-api-7f9c:req_7f3a91 NX PX 3000
OK                             -- this request loads

(other pods, same millisecond)
> SET lock:product:p_812:v3 pod-api-2b11:req_19c0 NX PX 3000
(nil)                          -- wait 20 ms, then GET again`,
      code: [{ lang: 'python', title: 'Stampede-safe load', src: String.raw`
async def redis_get_or_load(k: str, pid: str) -> bytes | None:
    if (v := await redis.get(k)) is not None:
        return None if v == NEG else v
    token = f"{POD}:{uuid4().hex}"
    if await redis.set("lock:" + k, token, nx=True, px=3000):
        try:
            row = await load_from_replica(pid)
            v = NEG if row is None else row.json_bytes()
            ttl = 60 if row is None else 3600 + random.randint(0, 600)   # jitter
            await redis.set(k, v, ex=ttl)
            return None if v == NEG else v
        finally:
            await release("lock:" + k, token)      # Lua: delete only if still ours
    for _ in range(10):                            # someone else is loading
        await asyncio.sleep(0.02)
        if (v := await redis.get(k)) is not None:
            return None if v == NEG else v
    return (await load_from_replica(pid)).json_bytes()   # give up waiting, still correct` }],
      failure: ['**The loader crashes while holding the lock:** the 3-second expiry frees it ({{lease}}); the next request reloads.', '**Waiters time out (database slow):** after 200 ms they read the replica themselves. Correct but heavier; a concurrency limit on replica reads keeps it from collapsing.']
    },
    {
      from: 'api', to: 'replica', label: 'SELECT … WHERE id = $1',
      title: 'Load the row from a read replica',
      caption: 'The winning request reads the product, its current price and stock from a replica, using the primary key index. About 2 ms.',
      text: ['A replica can be a few hundred milliseconds behind the primary ({{replication lag}}). That matters for the invalidation path later: an invalidator that deletes the key too early could let a reader re-cache the old row from a lagging replica.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
SELECT p.id, p.title, p.brand, p.price_minor, p.currency, p.version,
       COALESCE(s.available, 0) AS stock
FROM products p LEFT JOIN stock s ON s.product_id = p.id
WHERE p.id = 'p_812';

-- Index Scan using products_pkey on products  (cost=0.42..8.44 rows=1)
-- Execution Time: 0.211 ms`,
      failure: ['**Product does not exist:** the loader caches a short-lived tombstone (`NEG`, 60 s). This is {{negative caching}}: bots probing random ids cannot hammer the database.']
    },
    {
      from: 'api', to: 'redis', label: 'SET … EX 3600+jitter',
      title: 'Write the value back with a jittered TTL',
      caption: 'The JSON goes into Redis for about an hour, plus a random 0–10 minutes. Keys loaded together then expire at different moments instead of all at once.',
      text: ['The TTL is a safety net, not the main freshness mechanism: invalidation on change keeps the data fresh, and the TTL only limits damage if an invalidation is ever missed.'],
      payloadKind: 'Cached value',
      payload: { key: 'product:p_812:v3', ttl_s: 3913, value: { id: 'p_812', title: 'Speedgoat 6 trail shoe', brand: 'HOKA', price_minor: 11900, currency: 'EUR', stock: 37, version: 17, cached_at: '2026-11-25T11:40:02Z' } },
      fields: { version: 'Row version from the database. Used in the invalidation step to refuse writing an older version over a newer one.', ttl_s: '3600 + random(0..600). Without jitter, a cache warmed in one burst expires in one burst.' }
    },
    {
      from: 'api', to: 'web', label: '200 OK', reply: true,
      title: 'Respond, and remember it locally',
      caption: 'The API stores the bytes in its L1 cache and answers. The next 6,000 requests this second are served from L1 or Redis.',
      payloadKind: 'HTTP response',
      payload: { status: 200, headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS-L1, MISS-REDIS, LOAD', 'Server-Timing': 'redis;dur=0.6, db;dur=2.1, total;dur=4.3' }, body: { id: 'p_812', title: 'Speedgoat 6 trail shoe', price: { amount: 119.0, currency: 'EUR' }, stock: 37 } },
      text: ['The response carries timing headers so the page team can see in DevTools which layer answered and how long each took.'],
      fields: { 'X-Cache': 'Debug header showing which layer answered. Hits read `HIT-L1` or `HIT-REDIS`.' },
      details: ['Steady state: about 70% of reads hit L1, 29% hit Redis (~0.5 ms), under 1% reach the replica.', 'Values are stored as already-serialised JSON bytes, so a hit costs no Pydantic work at all.']
    },
    {
      from: 'admin', to: 'primary', label: 'UPDATE price',
      title: 'An admin lowers the price',
      caption: 'The merchandising team sets p_812 to €89. The update goes to the primary and bumps the row version in the same statement.',
      text: ['The admin API does **not** delete the cache key itself after the update. Doing both from application code is a {{dual write}}: a crash between them leaves the old price cached for an hour. The change stream does it instead.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
UPDATE products
SET price_minor = 8900, version = version + 1, updated_at = now()
WHERE id = 'p_812' AND version = 17          -- optimistic lock
RETURNING version;                            -- 18`,
      failure: ['**Version mismatch (0 rows):** someone else edited the product in the meantime; the console reloads and shows their change ({{optimistic locking}}).']
    },
    {
      from: 'primary', to: 'cdc', label: 'WAL change event', async: true,
      title: 'The change stream reports the commit',
      caption: 'Debezium reads PostgreSQL\'s write-ahead log and emits the committed change. The invalidator consumes it, typically 100–500 ms after the commit.',
      text: ['{{cdc}} sees every committed change, including ones made by scripts, migrations or a support engineer in psql, which app-level invalidation would miss.'],
      payloadKind: 'CDC event',
      payload: { op: 'u', source: { table: 'products', lsn: 98322109456, txId: 7713091 }, before: { id: 'p_812', price_minor: 11900, version: 17 }, after: { id: 'p_812', price_minor: 8900, version: 18 }, ts_ms: 1764069702301 },
      fields: { lsn: 'Position in the WAL. The invalidator waits until replicas have replayed past this {{lsn}} before deleting, so no reader can re-cache the old row from a lagging replica.' }
    },
    {
      from: 'cdc', to: 'redis', label: 'DEL product:p_812:v3',
      title: 'Delete the key, after replicas caught up',
      caption: 'The invalidator checks that the replicas have replayed LSN 98322109456, then deletes the Redis key. The next reader reloads the new price.',
      text: ['Deleting beats overwriting: the invalidator does not need to know how the API builds the JSON, and a delete is idempotent if the event is redelivered.', 'Without the LSN wait there is a classic race: delete → a reader misses → reads the replica that has not replayed yet → caches €119 again for an hour.'],
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
-- replica check (on each replica)
SELECT pg_last_wal_replay_lsn() >= '16/E4A1B6D0'::pg_lsn;   -- true

> DEL product:p_812:v3
(integer) 1                    -- next reader reloads version 18`,
      code: [{ lang: 'python', title: 'Invalidator', src: String.raw`
async def on_change(ev: ChangeEvent):
    if ev.source.table != "products":
        return
    k = f"product:{ev.after['id'] if ev.after else ev.before['id']}:v3"
    await wait_replicas_past(ev.source.lsn, timeout_s=5)   # avoid stale re-fill
    await redis.delete(k)
    await redis.publish("cache-invalidate", k)
    await consumer.commit(ev)            # at-least-once: a redelivery just deletes again` }],
      failure: ['**Invalidator is down:** events wait in Kafka, so nothing is lost; keys are deleted when it comes back. Meanwhile the TTL bounds staleness to about an hour; an alert on consumer lag pages someone long before that.', '**Replica check times out:** delete anyway, then delete again 2 s later (a "delayed double delete") to catch a re-fill from the lagging replica.']
    },
    {
      from: 'cdc', to: 'bus', label: 'PUBLISH cache-invalidate', async: true,
      title: 'Announce the key to every pod',
      caption: 'Deleting from Redis is not enough: 24 API pods each hold an L1 copy. The invalidator publishes the key name on a Redis pub/sub channel that all pods subscribe to.',
      text: ['The message is just the key name. Pods do not need the new value; they drop the entry and reload it on the next request.'],
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
> PUBLISH cache-invalidate "product:p_812:v3"
(integer) 24                   -- number of subscribers that received it`
    },
    {
      from: 'bus', to: 'api', label: 'drop L1 key',
      title: 'Every pod drops its local copy',
      caption: 'All 24 API pods receive the pub/sub message and evict the key from their L1 map. Without this, a pod could keep serving €119 for up to 5 more seconds.',
      text: ['Redis pub/sub is fire-and-forget: a pod that is reconnecting misses the message. That is acceptable only because the L1 TTL is 5 seconds; the design never relies on pub/sub alone.'],
      payloadKind: 'Pub/Sub message',
      payload: { channel: 'cache-invalidate', message: 'product:p_812:v3', receivers: 24 },
      code: [{ lang: 'python', title: 'L1 eviction listener', src: String.raw`
async def l1_invalidation_loop():
    async with redis.pubsub() as ps:
        await ps.subscribe("cache-invalidate")
        async for msg in ps.listen():
            if msg["type"] == "message":
                l1.pop(msg["data"].decode(), None)

# started from FastAPI's lifespan:
# app.state.l1_task = asyncio.create_task(l1_invalidation_loop())` }]
    },
    {
      from: 'api', to: 'replica', label: 'reload v18',
      title: 'The next read loads the new price',
      caption: 'The next request misses L1 and Redis, takes the reload lock and reads version 18 (€89) from the replica, which has already replayed it. Total time from the admin\'s click to every reader seeing €89: under a second.',
      payloadKind: 'Cached value',
      payload: { key: 'product:p_812:v3', ttl_s: 4120, value: { id: 'p_812', title: 'Speedgoat 6 trail shoe', brand: 'HOKA', price_minor: 8900, currency: 'EUR', stock: 37, version: 18, cached_at: '2026-11-25T11:41:43Z' } },
      text: ['If a slow request that started before the change tries to write version 17 back after this, a small Lua script compares versions and refuses to overwrite 18 with 17.']
    }
  ],
  api: [
    { verb: 'GET', path: '/v1/products/{id}', desc: 'Cache-aside read through L1 → Redis → replica.' },
    { verb: 'PATCH', path: '/admin/v1/products/{id}', desc: 'Admin update with `If-Match: <version>`; never touches the cache directly.' },
    { verb: 'POST', path: '/admin/v1/cache/purge', desc: 'Emergency purge by key prefix, rate-limited and audited.' }
  ],
  schema: String.raw`
CREATE TABLE products (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, brand TEXT,
  price_minor INT NOT NULL, currency CHAR(3) NOT NULL DEFAULT 'EUR',
  version INT NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE stock (product_id TEXT PRIMARY KEY REFERENCES products, available INT NOT NULL);

-- Redis
-- product:{id}:v3        JSON bytes, TTL 3600–4200 s (or "NEG" for 60 s)
-- lock:product:{id}:v3   reload lock, PX 3000
-- channel cache-invalidate  L1 evictions`,
  decisions: [
    { q: 'Which caching pattern?', options: [
      { verdict: 'good', name: '{{write-through}}: the API writes the cache on every update', why: 'Fresh, but every write path (scripts, migrations) must remember to do it.' },
      { verdict: 'great', name: '{{cache-aside}} for reads, CDC-driven deletes for writes', why: 'Reads fill lazily; every committed change invalidates, whoever made it.' }
    ] },
    { q: 'How do you survive a hot key expiring?', options: [
      { verdict: 'bad', name: 'Nothing: every miss reads the database', why: '6,000 identical queries in the same second.' },
      { verdict: 'good', name: 'TTL jitter', why: 'Spreads expiries of different keys, but one hot key still expires.' },
      { verdict: 'great', name: 'Single-flight lock + L1 cache + jitter', why: 'One database read per expiry, and the hottest keys rarely reach Redis.' }
    ] },
    { q: 'Delete or update the cache on change?', options: [
      { verdict: 'ok', name: 'Overwrite with the new value', why: 'Two concurrent updates can land in the wrong order and leave the older value.' },
      { verdict: 'great', name: 'Delete and let the next read reload', why: 'Idempotent, order-insensitive, and the invalidator needs no knowledge of the format.' }
    ] }
  ],
  refs: [
    { label: 'Redis: Cluster specification (hash slots)', url: 'https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/' },
    { label: 'Facebook: Scaling Memcache at Facebook (NSDI 2013)', url: 'https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/nishtala' },
    { label: 'Debezium PostgreSQL connector', url: 'https://debezium.io/documentation/reference/stable/connectors/postgresql.html' }
  ]
});
