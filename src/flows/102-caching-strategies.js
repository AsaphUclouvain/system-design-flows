flow({
  id: 'caching-strategies',
  title: 'Caching strategies: cache-aside, write-through, TTL',
  category: 'Infrastructure foundations',
  tags: ['Cache-aside (lazy loading)', 'Write-through', 'TTL', 'Invalidate on write', 'Stampede protection', 'Eviction (LRU)'],
  summary: 'A cache answers reads from memory so the database does not have to. The hard part is keeping it correct. Follow a cache-aside read (hit and miss), a write that invalidates the key, the write-through alternative, and a hot key expiring under load where only one request may rebuild it.',
  requirements: {
    functional: ['Serve product pages fast.', 'Reflect price changes quickly.'],
    nonFunctional: ['Most reads served from cache.', 'Stale data bounded (TTL).', 'A cache failure or expiry must not take down the database.']
  },
  grid: { cols: 5, rows: 3 },
  nodes: [
    { id: 'user', label: 'Shopper', sub: 'product page', kind: 'client', icon: 'browser', x: 0, y: 1, desc: 'Opens /product/42.' },
    { id: 'app', label: 'App server', sub: 'owns caching logic', kind: 'service', icon: 'server', x: 1, y: 1, desc: 'In cache-aside, the application decides when to read, fill and invalidate the cache.' },
    { id: 'cache', label: 'Cache', sub: 'Redis, LRU, TTL', kind: 'cache', icon: 'cache', x: 2, y: 0, desc: 'In-memory key-value store. When full, it evicts the least recently used keys.' },
    { id: 'db', label: 'Database', sub: 'source of truth', kind: 'db', icon: 'db', x: 3, y: 1, desc: 'Always correct, slower, and must be protected from cache misses in bulk.' },
    { id: 'admin', label: 'Admin tool', sub: 'changes price', kind: 'client', icon: 'user', x: 2, y: 2, desc: 'Updates the price of product 42.' }
  ],
  pseudo: `
def get_product(id):
    v = cache.get(f"product:{id}")
    if v: return v                       # hit
    if not cache.set(f"lock:{id}", 1, nx=True, ex=5): sleep(50ms); return get_product(id)
    v = db.query(id); cache.set(f"product:{id}", v, ex=300 + jitter); return v
def update_price(id, p):                 # cache-aside write
    db.update(id, p); cache.delete(f"product:{id}")
def update_price_wt(id, p):              # write-through
    db.update(id, p); cache.set(f"product:{id}", load(id), ex=300)`,
  steps: [
    {
      from: 'user', to: 'app', label: 'GET /product/42', pc: ['def get_product'],
      title: 'A read request',
      caption: 'The app checks the cache before the database.',
      text: [],
      payloadKind: 'Request',
      payload: { method: 'GET', path: '/product/42' }
    },
    {
      from: 'app', to: 'cache', label: 'GET product:42', pc: ['v = cache.get'],
      title: 'Look in the cache',
      caption: 'A hit returns in well under a millisecond inside the data center.',
      text: [],
      payloadKind: 'Cache read',
      payload: { key: 'product:42' },
      branch: { q: 'Is it cached?', options: [ { label: 'hit', goto: 'hit' }, { label: 'miss', goto: 'miss' } ] }
    },
    {
      id: 'hit', path: 'hit', from: 'cache', to: 'app', reply: true, label: 'HIT {name, price 24.99}', pc: ['if v: return v'],
      title: 'Hit: done',
      caption: 'The database is not touched. With a good hit rate, the database only sees a small share of reads.',
      text: [],
      payloadKind: 'Cache value',
      payload: { key: 'product:42', value: { name: 'Static Bloom vol. 1', price_eur: 24.99 }, ttl_left_s: 212 },
      next: 'write'
    },
    {
      id: 'miss', from: 'app', to: 'db', label: 'MISS → SELECT * FROM products WHERE id=42', pc: ['v = db.query(id)'],
      title: 'Miss: load from the database (lazy loading)',
      caption: 'Only data that is actually requested ends up in the cache. AWS calls this lazy loading.',
      text: [],
      payloadKind: 'Query',
      payload: { sql: 'SELECT id, name, price FROM products WHERE id = 42', ms: 9 }
    },
    {
      from: 'app', to: 'cache', label: 'SET product:42 … EX 300 (+jitter)', pc: ['cache.set(f"product:{id}", v'],
      title: 'Fill the cache with a TTL',
      caption: 'The TTL caps how stale the value can get even if an invalidation is missed. A little random jitter stops thousands of keys from expiring at the same second.',
      text: [],
      payloadKind: 'Cache write',
      payload: { key: 'product:42', ttl_s: 317, value: { price_eur: 24.99 } }
    },
    {
      id: 'write', from: 'admin', to: 'db', label: 'UPDATE price = 19.99', pc: ['def update_price', 'db.update(id, p)'],
      title: 'A write: update the database first',
      caption: 'The price drops to €19.99. The database is updated first, so it stays the source of truth.',
      text: [],
      payloadKind: 'Update',
      payload: { sql: 'UPDATE products SET price = 19.99 WHERE id = 42' },
      branch: { q: 'Which write strategy?', options: [ { label: 'cache-aside: delete the key', goto: 'del' }, { label: 'write-through: update the cache', goto: 'wt' } ] }
    },
    {
      id: 'del', from: 'app', to: 'cache', label: 'DEL product:42', pc: ['cache.delete'],
      title: 'Cache-aside: delete the key',
      caption: 'Deleting (instead of writing the new value) avoids races where two writers leave the older value in the cache. The next read misses and loads €19.99.',
      text: [],
      payloadKind: 'Invalidate',
      payload: { key: 'product:42', deleted: true },
      next: 'storm'
    },
    {
      id: 'wt', path: 'wt', from: 'app', to: 'cache', label: 'SET product:42 price 19.99', pc: ['def update_price_wt'],
      title: 'Other outcome: write-through',
      caption: 'Every write also updates the cache, so reads right after a write hit fresh data. The cost: you cache data that may never be read, which is why it is usually combined with a TTL.',
      text: [],
      payloadKind: 'Cache write',
      payload: { key: 'product:42', value: { price_eur: 19.99 }, ttl_s: 300 }
    },
    {
      id: 'storm', from: 'cache', to: 'app', label: '2 000 requests miss hot key at once → 1 lock', pc: ['if not cache.set(f"lock:{id}"'],
      title: 'A hot key expires under load',
      caption: 'Product 42 is on the homepage. When it expires, 2 000 requests miss in the same instant. Without care they all hit the database (a stampede). With a short lock, one request rebuilds; the others wait 50 ms and then hit the fresh value.',
      text: [],
      payloadKind: 'Stampede guard',
      payload: { key: 'product:42', concurrent_misses: 2000, lock_holder: 'req_8812', db_queries: 1 }
    }
  ],
  decisions: [
    { q: 'Read strategy?', options: [
      { name: 'Cache-aside (lazy loading)', verdict: 'good', why: 'Only requested data cached; cache failure just means slower reads.' },
      { name: 'Read-through (cache library loads on miss)', verdict: 'ok', why: 'Cleaner code; the cache layer must know how to load.' } ] },
    { q: 'Write strategy?', options: [
      { name: 'Update DB, then delete key', verdict: 'good', why: 'Simple and safe with a TTL as a backstop.' },
      { name: 'Write-through', verdict: 'ok', why: 'Fresh reads after writes; caches unread data.' },
      { name: 'Write-behind (cache first, DB later)', verdict: 'bad', why: 'Fast writes, but data is lost if the cache dies before flushing. Only for data you can afford to lose.' } ] }
  ],
  refs: [
    { label: 'AWS ElastiCache docs: Caching strategies (lazy loading, write-through, TTL)', url: 'https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Strategies.html' },
    { label: 'Redis docs: Key eviction (LRU policies)', url: 'https://redis.io/docs/latest/develop/reference/eviction/' },
    { label: 'Redis docs: SET (NX, EX options)', url: 'https://redis.io/docs/latest/commands/set/' },
    { label: 'Nishtala et al., Scaling Memcache at Facebook (NSDI 2013)', url: 'https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/nishtala' }
  ],
  verify: {
    checked: ['Lazy loading, write-through and adding TTL as the three strategies: AWS ElastiCache docs.', 'SET with NX/EX for a short lock: Redis SET docs.', 'Deleting instead of updating on write, and leases against thundering herds: Scaling Memcache at Facebook.'],
    uncertain: ['Request counts, TTLs and timings are illustrative.']
  }
});
