flow({
  id: 'search-autocomplete',
  title: 'Search autocomplete (typeahead)',
  category: 'Search & discovery',
  tags: ['Trie', 'Top-K', 'Debounce', 'Redis', 'Spark'],
  summary: 'Leo types "conc" and, before he types the next letter, sees "concert tickets brussels" at the top. Debounced requests, an in-memory prefix index with precomputed top suggestions, edge caching of popular prefixes, and a daily pipeline that rebuilds rankings from the query log.',
  requirements: {
    functional: [
      'As the user types, show up to 8 suggestions that start with what they typed, ranked by popularity.',
      'Suggestions can be personalised (recent searches) and are filtered for unsafe terms.',
      'Rankings follow trends within a day.'
    ],
    nonFunctional: [
      'Suggestions appear within 100 ms of a keystroke (end to end), so the server budget is about 20 ms.',
      'Extremely read-heavy: every keystroke is a request.',
      'Stale by a few hours is fine; missing a brand-new trending term for a while is acceptable.'
    ]
  },
  estimates: [
    { label: 'Searches', value: '≈ 1,150 / s', note: 'Assumption: 100M searches a day.' },
    { label: 'Suggest requests', value: '≈ 7,000 / s', note: 'About 6 keystrokes sent per search after debouncing (peaks ×3).' },
    { label: 'Index size', value: '≈ 1–2 GB', note: '10M distinct queries kept × ~20 bytes + top-8 lists per prefix node. Fits in RAM on every server.' },
    { label: 'Edge hit rate', value: '≈ 60–80%', note: 'Short prefixes (1–3 characters) are shared by everyone and cache very well.' }
  ],
  grid: { cols: 5, rows: 2 },
  nodes: [
    { id: 'input', label: 'Search box', sub: 'Next.js', kind: 'client', icon: 'search', x: 0, y: 0, desc: 'Debounces keystrokes, cancels stale requests, renders the dropdown with keyboard navigation.' },
    { id: 'cdn', label: 'CDN edge', sub: 'cache by prefix', kind: 'edge', icon: 'cdn', x: 1, y: 0, desc: 'Caches responses for /suggest?q=co for a few minutes. Popular prefixes never reach the origin.' },
    { id: 'svc', label: 'Suggest service', sub: 'FastAPI', kind: 'service', x: 2, y: 0, desc: 'Holds the prefix index in memory. Looks up the node for the prefix and returns its precomputed top list.' },
    { id: 'trie', label: 'Prefix index', sub: 'in-memory trie', kind: 'cache', icon: 'tree', x: 3, y: 0, desc: 'A trie where every node stores the top 8 completions below it, so a lookup is O(prefix length).' },
    { id: 'personal', label: 'Recent searches', sub: 'Redis', kind: 'cache', x: 4, y: 0, desc: 'Per-user list of the last 20 searches, merged in for signed-in users.' },
    { id: 'log', label: 'Query log', sub: 'Kafka', kind: 'queue', x: 2, y: 1, desc: 'Every submitted search (not every keystroke) is logged as an event.' },
    { id: 'batch', label: 'Aggregation job', sub: 'Spark, daily + hourly', kind: 'worker', icon: 'chart', x: 3, y: 1, desc: 'Counts queries with time decay, removes blocked terms, and builds a new trie snapshot.' },
    { id: 'snap', label: 'Index snapshots', sub: 'S3', kind: 'storage', x: 4, y: 1, desc: 'Versioned serialized tries. Suggest servers download the newest and swap it in.' },
    { id: 'results', label: 'Search page', sub: 'Next.js', kind: 'client', x: 0, y: 1, desc: 'Where the user lands after picking a suggestion or pressing Enter.' }
  ],
  steps: [
    {
      from: 'input', to: 'cdn', label: 'GET /suggest?q=conc',
      title: 'Leo types "conc"',
      caption: 'The box waits 120 ms after the last keystroke before sending, and aborts the previous request if it is still in flight. Typing "c-o-n-c" quickly sends one request, not four.',
      text: ['{{debounce}} trades a little latency for far fewer requests. 100–150 ms feels instant to most people; fast typists produce no requests until they pause.', 'The prefix is normalised on the client and the server the same way (lowercase, trimmed, accents folded), so "Conc" and "conc" share one cache entry.'],
      payloadKind: 'HTTP request',
      payloadLang: 'http',
      payload: String.raw`
GET /suggest?q=conc&locale=fr-BE HTTP/2
Host: api.example.com
Accept: application/json`,
      code: [{ lang: 'ts', title: 'Debounced, cancellable search box (client component)', src: String.raw`
'use client';
export function SearchBox() {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<string[]>([]);
  const [active, setActive] = useState(-1);
  useEffect(() => {
    const prefix = normalise(q);
    if (prefix.length < 1) { setItems([]); return; }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await fetch('/suggest?q=' + encodeURIComponent(prefix) + '&locale=fr-BE', { signal: ctrl.signal });
        if (r.ok) setItems((await r.json()).suggestions.map((s: { text: string }) => s.text));
      } catch { /* aborted: a newer keystroke won */ }
    }, 120);
    return () => { clearTimeout(t); ctrl.abort(); };             // runs on every new keystroke
  }, [q]);
  return <Combobox value={q} onChange={setQ} items={items} active={active} onActive={setActive}
                   onPick={(s) => router.push('/search?q=' + encodeURIComponent(s))} />;
}` }],
      fields: { q: 'Normalised prefix. Requests for prefixes over 30 characters skip the CDN: they are too unique to cache.' }
    },
    {
      from: 'cdn', to: 'svc', label: 'miss → origin',
      title: 'The edge cache misses on "conc"',
      caption: '"c" and "co" were edge hits a moment ago; "conc" is rarer in Leo\'s region at this minute, so the request goes to the suggest service.',
      text: ['The cache key is path + `q` + `locale`. Anonymous responses are cacheable (`Cache-Control: public, max-age=300`); personalised ones are not, so signed-in users get the shared part from the edge and the personal part from a second small request, or the merge is done on the server with `private` caching.'],
      payloadKind: 'Cache decision',
      payload: { cache_key: '/suggest?q=conc&locale=fr-BE', edge_pop: 'BRU', result: 'MISS', forwarded_to: 'suggest-eu-3' }
    },
    {
      from: 'svc', to: 'trie', label: 'walk c→o→n→c',
      title: 'Walk the trie to the prefix node',
      caption: 'Four steps down the trie reach the node for "conc". It already stores its top 8 completions with scores, computed offline. No subtree search happens at request time.',
      text: ['A plain {{trie}} would need to explore every word below "conc" and sort them on each request. Storing the top K at every node trades memory for a constant-time answer, which is the classic design for typeahead.', 'Memory is kept down by storing ids into a string table rather than full strings at each node, and by not storing lists at deep nodes with few descendants (compute those on the fly).'],
      payloadKind: 'Trie node',
      payload: { prefix: 'conc', children: ['e', 'i', 'o', 'l', 'r'], top: [{ text: 'concert tickets brussels', score: 98120 }, { text: 'concerts november 2026', score: 61400 }, { text: 'concours fonction publique', score: 33950 }, { text: 'conclusion', score: 31010 }, { text: 'concentration exercises', score: 18200 }, { text: 'concorde', score: 9100 }, { text: 'concealer', score: 8800 }, { text: 'concrete mix ratio', score: 7600 }] },
      code: [{ lang: 'python', title: 'Trie with top-K per node', src: String.raw`
class Node:
    __slots__ = ("kids", "top")
    def __init__(self):
        self.kids: dict[str, "Node"] = {}
        self.top: list[tuple[int, str]] = []          # (score, text), best first, max K

K = 8

def build(counts: dict[str, int]) -> Node:
    root = Node()
    for text, score in counts.items():
        node = root
        for ch in text:
            node = node.kids.setdefault(ch, Node())
            # keep only the K best at each node on the path
            if len(node.top) < K or score > node.top[-1][0]:
                node.top.append((score, text))
                node.top.sort(reverse=True)
                del node.top[K:]
    return root

def suggest(root: Node, prefix: str) -> list[tuple[int, str]]:
    node = root
    for ch in prefix:
        node = node.kids.get(ch)
        if node is None:
            return []
    return node.top` }]
    },
    {
      from: 'svc', to: 'personal', label: 'LRANGE recent:usr_leo',
      title: 'Mix in Leo\'s own recent searches',
      caption: 'Leo is signed in, so his recent searches that start with "conc" are put first, marked with a clock icon.',
      text: ['Personal items are boosted but capped (at most 2 of the 8) so the list still shows what is popular. Users can delete them; deletion removes the Redis list entry immediately.'],
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
> LRANGE recent:usr_leo 0 19
1) "concert angele forest national"
2) "python asyncio gather"
3) "concert tickets brussels"
…`
    },
    {
      from: 'svc', to: 'input', label: '200 suggestions', reply: true,
      title: 'The dropdown shows eight suggestions',
      caption: 'The response arrives about 40 ms after the keystroke pause. The matched prefix is highlighted; arrow keys move through the list.',
      text: ['If an older request answers after a newer one (networks reorder), the abort in the client makes sure only the latest prefix\'s answer is shown.'],
      payloadKind: 'HTTP response',
      payload: { q: 'conc', suggestions: [{ text: 'concert angele forest national', kind: 'recent' }, { text: 'concert tickets brussels', kind: 'popular' }, { text: 'concerts november 2026', kind: 'popular' }, { text: 'concours fonction publique', kind: 'popular' }, { text: 'conclusion', kind: 'popular' }, { text: 'concentration exercises', kind: 'popular' }, { text: 'concorde', kind: 'popular' }, { text: 'concealer', kind: 'popular' }], index_version: '2026-11-25T06:00Z' },
      fields: { index_version: 'Which snapshot answered. Useful when debugging "why does it suggest X".', 'suggestions[].kind': 'Lets the UI show a clock icon for recent searches.' },
      code: [{ lang: 'python', title: 'Suggest endpoint', src: String.raw`
@app.get("/suggest")
async def suggest_ep(q: str, locale: str = "en", user=Depends(optional_user), response: Response = None):
    prefix = normalise(q)[:30]
    popular = [t for _, t in suggest(INDEX[locale], prefix)]
    items = [{"text": t, "kind": "popular"} for t in popular]
    if user:
        recent = [t for t in await redis.lrange(f"recent:{user.id}", 0, 19) if t.startswith(prefix)][:2]
        items = [{"text": t, "kind": "recent"} for t in recent] + [i for i in items if i["text"] not in recent]
        response.headers["Cache-Control"] = "private, max-age=30"
    else:
        response.headers["Cache-Control"] = "public, max-age=300"
    return {"q": prefix, "suggestions": items[:8], "index_version": INDEX_VERSION}` }]
    },
    {
      from: 'input', to: 'results', label: 'pick suggestion',
      title: 'Leo picks "concert tickets brussels"',
      caption: 'The browser navigates to the results page. That submitted search, not the keystrokes, is what feeds future rankings.',
      text: ['Choosing a suggestion also does an LPUSH of the query onto `recent:usr_leo` (then LTRIM to 20), so it shows up as a recent search next time.'],
      payloadKind: 'Navigation',
      payload: { url: '/search?q=concert+tickets+brussels&src=suggest&pos=2', note: 'src and pos tell analytics that a suggestion was used and which position.' }
    },
    {
      from: 'results', to: 'log', label: 'search.submitted', async: true,
      title: 'The submitted search is logged',
      caption: 'The search backend publishes one event per submitted query. Keystroke prefixes are not logged as queries, or half-typed words would become suggestions.',
      text: ['Logging the position of the chosen suggestion makes it possible to measure the feature: if people keep picking position 6, the ranking is off.'],
      payloadKind: 'Kafka record',
      payload: { topic: 'search-submitted', value: { q: 'concert tickets brussels', locale: 'fr-BE', user_hash: 'u_9f…', src: 'suggest', pos: 2, ts: '2026-11-25T11:21:40Z', results: 1240 } },
      fields: { results: 'Queries with zero results are kept out of suggestions: suggesting a dead end is worse than nothing.' }
    },
    {
      from: 'log', to: 'batch', label: 'hourly + daily aggregation', async: true,
      title: 'Rebuild the rankings',
      caption: 'A Spark job counts queries over the last 30 days with exponential decay (yesterday counts more than last month), filters blocked and personal-looking terms, and keeps the top 10M.',
      text: ['Decay makes trends rise quickly: a score halves every 7 days, so a sudden burst of "concert tickets brussels" outranks a term that was popular a month ago.', 'Filtering matters as much as counting: blocklists for hate and adult terms, minimum distinct-user thresholds (a query typed by 3 people may contain someone\'s phone number), and a manual override list.'],
      payloadKind: 'Spark SQL',
      payloadLang: 'sql',
      payload: String.raw`
SELECT q, locale,
       SUM(POW(0.5, DATEDIFF(current_date(), to_date(ts)) / 7.0)) AS score,
       COUNT(DISTINCT user_hash) AS users
FROM search_submitted
WHERE ts >= current_date() - INTERVAL 30 DAYS AND results > 0
GROUP BY q, locale
HAVING users >= 20
   AND q NOT IN (SELECT term FROM blocked_terms)
ORDER BY score DESC
LIMIT 10000000;`
    },
    {
      from: 'batch', to: 'snap', label: 'write trie snapshot',
      title: 'Publish a new index snapshot',
      caption: 'The job builds the trie with top-K lists, serialises it (a few hundred MB compressed per locale) and uploads it with a version. A small "latest" pointer file is updated last.',
      payloadKind: 'Snapshot manifest',
      payload: { locale: 'fr-BE', version: '2026-11-25T12:00Z', key: 'suggest/fr-BE/2026-11-25T12-00Z.trie.zst', terms: 9874120, nodes: 61203877, size_bytes: 412339201, sha256: 'e3b0…1a9f' },
      text: ['Writing the pointer last is what makes the publish atomic: servers never see a half-uploaded snapshot.']
    },
    {
      from: 'snap', to: 'svc', label: 'download + atomic swap',
      title: 'Servers swap in the new index without downtime',
      caption: 'Each suggest server polls the pointer, downloads the new snapshot in the background, verifies the checksum, loads it, and swaps a single reference. Requests in flight finish on the old index.',
      text: ['Servers swap at slightly different times (random delay up to 5 minutes) so the fleet never reloads all at once. During the window, two users may see slightly different rankings, which is fine.', 'Brand-new trending terms (breaking news) can be injected faster through a small "hot terms" overlay updated every few minutes from a streaming job, merged at query time.'],
      payloadKind: 'Reload log',
      payload: { server: 'suggest-eu-3', old_version: '2026-11-25T06:00Z', new_version: '2026-11-25T12:00Z', download_s: 6.1, load_s: 14.8, rss_before_mb: 2210, rss_peak_mb: 4180, swapped_at: '2026-11-25T12:03:41Z' },
      fields: { rss_peak_mb: 'Two indexes live in memory during the swap: size servers for twice the index.' },
      failure: ['**Corrupt or partial snapshot:** checksum fails, the server keeps serving the previous version and alerts. A bad index is never worse than a slightly stale one.']
    }
  ],
  api: [
    { verb: 'GET', path: '/suggest?q=&locale=', desc: 'Up to 8 suggestions for a prefix. Public, cacheable when anonymous.' },
    { verb: 'DELETE', path: '/v1/me/recent-searches/{text}', desc: 'Remove one recent search.' }
  ],
  schema: String.raw`
-- Offline (data lake)
search_submitted(q STRING, locale STRING, user_hash STRING, src STRING, pos INT, ts TIMESTAMP, results INT)
blocked_terms(term STRING, reason STRING, added_by STRING)

-- Online
-- In-memory trie per locale, loaded from s3://…/suggest/{locale}/{version}.trie.zst
-- Redis  recent:{user_id}  LIST (LPUSH + LTRIM 0 19)`,
  decisions: [
    { q: 'Where do you compute the top suggestions?', options: [
      { verdict: 'bad', name: 'SQL LIKE \'conc%\' ORDER BY count LIMIT 8 per keystroke', why: 'A scan-and-sort on every keystroke; collapses at thousands of requests per second.' },
      { verdict: 'good', name: 'Search engine prefix query (Elasticsearch completion suggester)', why: 'Works well and supports fuzziness; another cluster to run.' },
      { verdict: 'great', name: 'Offline-built trie with top-K per node, in memory on every server', why: 'Microsecond lookups, no network hop, trivially horizontally scalable.' }
    ] },
    { q: 'How do you limit request volume?', options: [
      { verdict: 'bad', name: 'A request per keystroke', why: 'Wasteful, and responses arrive out of order.' },
      { verdict: 'great', name: 'Debounce + abort stale requests + CDN cache for short prefixes', why: 'Most traffic never reaches the service.' }
    ] }
  ],
  refs: [
    { label: 'MDN: AbortController', url: 'https://developer.mozilla.org/en-US/docs/Web/API/AbortController' },
    { label: 'WAI-ARIA Authoring Practices: Combobox pattern', url: 'https://www.w3.org/WAI/ARIA/apg/patterns/combobox/', note: 'Keyboard and screen-reader behaviour for the dropdown.' },
    { label: 'Elasticsearch: Completion suggester', url: 'https://www.elastic.co/guide/en/elasticsearch/reference/current/search-suggesters.html#completion-suggester' }
  ]
});

flow({
  id: 'full-text-search',
  title: 'Full-text search with Elasticsearch',
  category: 'Search & discovery',
  tags: ['Elasticsearch', 'Inverted index', 'CDC', 'BM25', 'Facets'],
  summary: 'A product edit in PostgreSQL shows up in search results within two seconds, and "chaussure running femme 42" finds "Women\'s trail running shoe" with facets for brand and price. CDC indexing, analyzers, BM25 scoring, filters and the read path.',
  requirements: {
    functional: [
      'Users search a catalogue of products by free text, with typo tolerance, filters (brand, size, price) and facet counts.',
      'Edits to products (price, stock, title) appear in search within seconds.',
      'Results are relevant: title matches count more than description matches; in-stock items rank higher.'
    ],
    nonFunctional: [
      'Search p95 under 150 ms.',
      'PostgreSQL stays the source of truth; the search index can be rebuilt from it at any time.',
      'Indexing never blocks or slows writes to the main database.'
    ]
  },
  estimates: [
    { label: 'Documents', value: '20M products', note: 'Assumption. About 2 KB each as JSON: 40 GB source.' },
    { label: 'Index size', value: '≈ 60–80 GB', note: 'Inverted index + doc values + source, before replicas.' },
    { label: 'Shards', value: '4 primaries × 1 replica', note: 'Common guidance: aim for shards of roughly 10–50 GB.' },
    { label: 'Updates', value: '≈ 500 / s', note: 'Price and stock changes dominate.' },
    { label: 'Queries', value: '≈ 2,000 / s peak', note: 'Served from replicas and primaries alike.' }
  ],
  grid: { cols: 5, rows: 2 },
  nodes: [
    { id: 'admin', label: 'Back office', sub: 'Next.js', kind: 'client', icon: 'user', x: 0, y: 0, desc: 'A merchant edits a product title and price.' },
    { id: 'api', label: 'Catalog API', sub: 'FastAPI', kind: 'service', x: 1, y: 0, desc: 'Writes products to PostgreSQL. Knows nothing about search.' },
    { id: 'pg', label: 'Catalog DB', sub: 'PostgreSQL', kind: 'db', x: 2, y: 0, desc: 'Source of truth. Logical replication exposes every committed change.' },
    { id: 'cdc', label: 'Debezium', sub: 'CDC connector', kind: 'worker', x: 3, y: 0, desc: 'Reads the write-ahead log and publishes one change event per row change to Kafka.' },
    { id: 'kafka', label: 'Change topic', sub: 'Kafka', kind: 'queue', x: 4, y: 0, desc: 'catalog.public.products, keyed by product id: changes to one product stay in order.' },
    { id: 'indexer', label: 'Indexer', sub: 'Python consumer', kind: 'worker', x: 4, y: 1, desc: 'Turns change events into search documents (joins brand names, computes fields) and bulk-indexes them.' },
    { id: 'es', label: 'Search cluster', sub: 'Elasticsearch', kind: 'db', icon: 'search', x: 3, y: 1, desc: 'Inverted indexes over analysed text plus columnar doc values for filters, sorting and facets.' },
    { id: 'search', label: 'Search API', sub: 'FastAPI', kind: 'service', x: 2, y: 1, desc: 'Builds the query (text + filters + boosts + aggregations), calls Elasticsearch, shapes the response.' },
    { id: 'shop', label: 'Shop', sub: 'Next.js', kind: 'client', icon: 'search', x: 1, y: 1, desc: 'Search page with results, facets and filters in the URL.' }
  ],
  steps: [
    {
      from: 'admin', to: 'api', label: 'PATCH /v1/products/p_812',
      title: 'A merchant edits a product',
      caption: 'The price drops from €119 to €89 and the title gains "trail". The API validates and writes to PostgreSQL. It does not call Elasticsearch.',
      text: ['Updating the search index from the API ("write to DB, then write to ES") is a {{dual write}}: if the second write fails or two edits race, the index silently drifts from the database. CDC avoids that by deriving the index from the database log.'],
      payloadKind: 'HTTP request',
      payload: { method: 'PATCH', path: '/v1/products/p_812', headers: { Authorization: 'Bearer eyJ…', 'If-Match': 'W/"v17"' }, body: { title: 'Women\'s trail running shoe Speedgoat', price_minor: 8900 } },
      fields: { 'If-Match': 'Version check ({{optimistic locking}}): fails with 412 if someone else edited the product meanwhile.' }
    },
    {
      from: 'api', to: 'pg', label: 'UPDATE products',
      title: 'The change commits in PostgreSQL',
      caption: 'The UPDATE commits and is written to the write-ahead log, like every change. With wal_level=logical, that log can be decoded into row-level change events.',
      text: ['Every change is recorded in the {{write-ahead log}} before the commit returns; that log exists for crash recovery and replication, and CDC reuses it for free.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
UPDATE products
SET title = 'Women''s trail running shoe Speedgoat', price_minor = 8900,
    version = version + 1, updated_at = now()
WHERE id = 'p_812' AND version = 17;

-- once, for CDC:
-- ALTER SYSTEM SET wal_level = logical;
-- CREATE PUBLICATION search_pub FOR TABLE products, brands, stock;`
    },
    {
      from: 'pg', to: 'cdc', label: 'logical replication',
      title: 'Debezium reads the change from the WAL',
      caption: 'Debezium holds a replication slot and receives the decoded change with the row before and after. Nothing queries the products table.',
      text: ['{{cdc}} through the {{write-ahead log}} sees every committed change, in commit order, including changes made by scripts and migrations that bypass the API.', 'A replication slot keeps WAL until the consumer confirms it. If Debezium stops for a day, WAL piles up on the database disk: monitor slot lag.'],
      payloadKind: 'Debezium change event (value)',
      payload: { before: { id: 'p_812', title: 'Women\'s running shoe Speedgoat', price_minor: 11900, version: 17 }, after: { id: 'p_812', title: 'Women\'s trail running shoe Speedgoat', price_minor: 8900, version: 18, brand_id: 'b_hoka', category: 'running-shoes', sizes: [38, 39, 40, 41, 42], updated_at: 1764069702113 }, source: { connector: 'postgresql', db: 'catalog', table: 'products', lsn: 98322109456, txId: 7713091 }, op: 'u', ts_ms: 1764069702301 },
      fields: { op: 'c = create, u = update, d = delete, r = snapshot read.', 'source.lsn': 'Log position. Increases with every commit; useful to order and to resume.' },
      failure: ['**Slot lag grows (connector down):** alert at a few GB of retained WAL. If it cannot recover, drop the slot and re-snapshot, rather than fill the database disk.']
    },
    {
      from: 'cdc', to: 'kafka', label: 'publish (key = p_812)',
      title: 'The change is published to Kafka',
      caption: 'The event goes to catalog.public.products with the product id as key, so every change to p_812 lands in the same partition, in order.',
      text: ['Other consumers (recommendations, the data warehouse, cache invalidation) read the same topic. CDC turns the database into an event source without changing the Catalog API.'],
      payloadKind: 'Kafka record',
      payload: { topic: 'catalog.public.products', partition: 5, offset: 3310927, key: { id: 'p_812' }, value: '…change event above…' }
    },
    {
      from: 'kafka', to: 'indexer', label: 'consume batch',
      title: 'The indexer builds the search document',
      caption: 'The indexer reads a batch, loads related data (brand name, stock per size), computes derived fields, and creates one search document per product.',
      text: ['The search document is {{denormalization}} on purpose: brand name, category path and in-stock flags are copied in, because Elasticsearch has no joins worth using at query time.', 'Using `version` as an external version in Elasticsearch means an older event processed late cannot overwrite a newer document.'],
      payloadKind: 'Search document',
      payload: { _id: 'p_812', _version: 18, title: 'Women\'s trail running shoe Speedgoat', title_fr: 'Chaussure de trail running femme Speedgoat', brand: 'HOKA', category: ['shoes', 'running-shoes', 'trail'], gender: 'women', price: 89.0, sizes_in_stock: [38, 40, 41, 42], in_stock: true, rating: 4.6, sales_30d: 412, updated_at: '2026-11-25T11:21:42Z' },
      fields: { sizes_in_stock: 'Computed from the stock table: size 39 is sold out, so it is left out and the size filter will not match it.', _version: 'External version from PostgreSQL. ES rejects writes with a lower version.' }
    },
    {
      from: 'indexer', to: 'es', label: '_bulk index',
      title: 'Bulk-index into Elasticsearch',
      caption: 'The indexer sends up to 1,000 documents per _bulk request, then commits its Kafka offsets. The change becomes searchable after the next refresh (1 s by default).',
      text: ['Elasticsearch is near-real-time: new documents become visible when the shard refreshes and opens a new segment. 1 s is the default; raising it to 30 s during a full reindex speeds indexing a lot.', 'Text fields are run through an analyzer at index time: the title is split into tokens, lowercased, accents folded, and stemmed ("running" → "run"). Those tokens fill the {{inverted index}}.'],
      payloadKind: 'Bulk request (NDJSON)',
      payloadLang: 'json',
      payload: String.raw`
POST /products/_bulk
{ "index": { "_id": "p_812", "version": 18, "version_type": "external" } }
{ "title": "Women's trail running shoe Speedgoat", "title_fr": "Chaussure de trail running femme Speedgoat", "brand": "HOKA", "price": 89.0, "sizes_in_stock": [38,40,41,42], "in_stock": true, ... }
{ "delete": { "_id": "p_120", "version": 9, "version_type": "external" } }`,
      code: [{ lang: 'python', title: 'Indexer loop (aiokafka + elasticsearch-py)', src: String.raw`
async def run():
    async for batch in consumer.getmany_batches(timeout_ms=500, max_records=1000):
        actions = []
        for msg in batch:
            ev = json.loads(msg.value)
            pid = ev["after"]["id"] if ev["after"] else ev["before"]["id"]
            if ev["op"] == "d":
                actions.append({"_op_type": "delete", "_index": "products", "_id": pid,
                                "version": ev["before"]["version"] + 1, "version_type": "external"})
            else:
                doc = await build_document(ev["after"])          # joins brand, stock
                actions.append({"_op_type": "index", "_index": "products", "_id": pid,
                                "version": ev["after"]["version"], "version_type": "external", "_source": doc})
        ok, errors = await async_bulk(es, actions, raise_on_error=False)
        real = [e for e in errors if not is_version_conflict(e)]  # conflicts = stale event, fine
        if real:
            await dlq.send_many(real)
        await consumer.commit()` }],
      failure: ['**Version conflict (409):** an older event arrived after a newer one; skipping it is correct.', '**Cluster rejects (429, queue full):** retry the bulk with {{exponential backoff}}; Kafka buffers the changes meanwhile, so search is just a little more stale.']
    },
    {
      from: 'shop', to: 'search', label: 'GET /v1/search?q=…',
      title: 'A shopper searches',
      caption: 'The shopper types "chaussure running femme" and ticks size 42 and brand HOKA. Filters live in the URL so results can be shared and the back button works.',
      text: ['The Next.js page renders on the server, so search pages are indexable by search engines and fast on slow phones.'],
      payloadKind: 'HTTP request',
      payload: { method: 'GET', path: '/v1/search?q=chaussure%20running%20femme&size=42&brand=HOKA&sort=relevance&page=1', headers: { 'Accept-Language': 'fr-BE' } },
      code: [{ lang: 'ts', title: 'Search page (Next.js App Router, server component)', src: String.raw`
export default async function SearchPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const params = new URLSearchParams(await searchParams);
  const res = await fetch(process.env.API_URL + '/v1/search?' + params, { next: { revalidate: 30 } });
  const data: SearchResponse = await res.json();
  return (
    <div className="grid grid-cols-[240px_1fr] gap-8">
      <Facets facets={data.facets} active={params} />         {/* links that toggle URL params */}
      <Results hits={data.hits} total={data.total} />
    </div>
  );
}` }]
    },
    {
      from: 'search', to: 'es', label: 'bool query + aggs',
      title: 'Build the query: text, filters, boosts, facets',
      caption: 'Free text goes into a scored multi_match across title fields; size and brand go into non-scoring filters (cached by ES); in-stock and popularity boost the score; aggregations compute facet counts.',
      text: ['Filters do not affect relevance and are cached as bitsets, so they are cheap. Putting "size 42" in a `must` clause instead would wrongly change scores.', 'Facet counts for brand must ignore the brand filter itself (otherwise selecting HOKA hides every other brand\'s count). That is what `post_filter` is for: aggregations run before it, results after.', '`fuzziness: AUTO` tolerates one typo in words of 3–5 characters and two in longer words, so "chausure" still matches.'],
      payloadKind: 'Elasticsearch query',
      payload: { query: { function_score: { query: { bool: { must: [{ multi_match: { query: 'chaussure running femme', fields: ['title_fr^3', 'title^2', 'category', 'description'], type: 'best_fields', fuzziness: 'AUTO' } }], filter: [{ term: { sizes_in_stock: 42 } }] } }, functions: [{ filter: { term: { in_stock: true } }, weight: 1.5 }, { field_value_factor: { field: 'sales_30d', modifier: 'log1p', factor: 0.1 } }], boost_mode: 'multiply' } }, post_filter: { term: { brand: 'HOKA' } }, aggs: { brands: { terms: { field: 'brand', size: 20 } }, price: { range: { field: 'price', ranges: [{ to: 50 }, { from: 50, to: 100 }, { from: 100 }] } } }, size: 24, from: 0 },
      fields: { 'title_fr^3': 'Matches in the French title count three times as much.', post_filter: 'Applied after aggregations, so the brand facet still shows counts for all brands.', 'functions[1]': 'Log of recent sales gently favours popular products without drowning text relevance.' }
    },
    {
      from: 'es', to: 'search', label: 'hits + aggregations', reply: true,
      title: 'Elasticsearch scores and returns hits',
      caption: 'Each shard scores its matching documents with BM25, returns its top 24, and the coordinating node merges them. p_812 ranks first: title match, in stock, size 42 available.',
      text: ['BM25 scores a term higher when it is rare across the catalogue (IDF) and when it appears in a short field, with diminishing returns for repeated words. "femme" is common, "trail" less so.', 'Deep pagination (`from: 10000`) is expensive because every shard must return from+size hits; use `search_after` for "load more".'],
      payloadKind: 'Response (trimmed)',
      payload: { took: 23, hits: { total: { value: 318, relation: 'eq' }, hits: [{ _id: 'p_812', _score: 21.4, _source: { title_fr: 'Chaussure de trail running femme Speedgoat', brand: 'HOKA', price: 89.0 } }, { _id: 'p_640', _score: 18.9, _source: { title_fr: 'Chaussure running femme Clifton 9', brand: 'HOKA', price: 139.0 } }] }, aggregations: { brands: { buckets: [{ key: 'HOKA', doc_count: 41 }, { key: 'Asics', doc_count: 77 }, { key: 'Salomon', doc_count: 52 }] }, price: { buckets: [{ key: '*-50.0', doc_count: 64 }, { key: '50.0-100.0', doc_count: 151 }, { key: '100.0-*', doc_count: 103 }] } } },
      fields: { took: 'Milliseconds inside Elasticsearch.', 'hits.total.value': 'All matching products before the HOKA post_filter (318); HOKA alone has 41.' }
    },
    {
      from: 'search', to: 'shop', label: '200 results + facets', reply: true,
      title: 'The shopper sees results and facets',
      caption: 'The API returns a clean, stable shape (not raw Elasticsearch), so the search engine can change without touching the frontend.',
      payloadKind: 'HTTP response',
      payload: { total: 41, page: 1, hits: [{ id: 'p_812', title: 'Chaussure de trail running femme Speedgoat', brand: 'HOKA', price: { amount: 89.0, currency: 'EUR', was: 119.0 }, image: 'https://cdn.example.com/p/p_812/400.webp', in_stock_sizes: [38, 40, 41, 42] }], facets: { brand: [{ value: 'HOKA', count: 41, selected: true }, { value: 'Asics', count: 77 }, { value: 'Salomon', count: 52 }], price: [{ label: '< €50', count: 64 }, { label: '€50–100', count: 151 }, { label: '> €100', count: 103 }] } },
      text: ['From the merchant\'s save to this result took about 1.5 s: commit, WAL decode, Kafka, indexer batch, ES refresh.']
    }
  ],
  api: [
    { verb: 'GET', path: '/v1/search?q=&brand=&size=&sort=&page=', desc: 'Search with filters, sort and facets.' },
    { verb: 'POST', path: '/admin/reindex', desc: 'Full rebuild into a new index, then switch the alias atomically.' }
  ],
  schema: String.raw`
PUT /products_v7
{
  "settings": {
    "number_of_shards": 4, "number_of_replicas": 1,
    "analysis": { "analyzer": {
      "fr_text": { "tokenizer": "standard",
                   "filter": ["lowercase", "asciifolding", "french_elision", "french_stemmer"] } } }
  },
  "mappings": { "properties": {
    "title":          { "type": "text", "analyzer": "english" },
    "title_fr":       { "type": "text", "analyzer": "fr_text" },
    "brand":          { "type": "keyword" },
    "category":       { "type": "keyword" },
    "price":          { "type": "scaled_float", "scaling_factor": 100 },
    "sizes_in_stock": { "type": "integer" },
    "in_stock":       { "type": "boolean" },
    "sales_30d":      { "type": "integer" },
    "updated_at":     { "type": "date" }
  } }
}
POST /_aliases { "actions": [ { "add": { "index": "products_v7", "alias": "products" } } ] }
-- (french_elision / french_stemmer are custom filters defined in the same settings block)`,
  decisions: [
    { q: 'How do you keep the index in sync?', options: [
      { verdict: 'bad', name: 'API writes to PostgreSQL then to Elasticsearch', why: 'Dual write: partial failures and races make the index drift silently.' },
      { verdict: 'good', name: 'Periodic batch reindex (cron)', why: 'Simple and consistent, but minutes to hours stale.' },
      { verdict: 'great', name: 'CDC from the WAL into Kafka, with external versions', why: 'Seconds of lag, ordered per product, replayable, and rebuildable from scratch.' }
    ] },
    { q: 'How do you change mappings without downtime?', options: [
      { verdict: 'bad', name: 'Delete and recreate the index', why: 'Search is empty during the rebuild.' },
      { verdict: 'great', name: 'Build products_v8 alongside, replay, then swap the alias', why: 'Atomic switch, instant rollback.' }
    ] }
  ],
  refs: [
    { label: 'Elasticsearch: Boolean query', url: 'https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-bool-query.html' },
    { label: 'Elasticsearch: Post filter', url: 'https://www.elastic.co/guide/en/elasticsearch/reference/current/filter-search-results.html#post-filter' },
    { label: 'Elasticsearch: Size your shards', url: 'https://www.elastic.co/guide/en/elasticsearch/reference/current/size-your-shards.html' },
    { label: 'Debezium: PostgreSQL connector', url: 'https://debezium.io/documentation/reference/stable/connectors/postgresql.html' }
  ]
});
