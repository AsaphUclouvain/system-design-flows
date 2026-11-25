flow({
  id: 'web-crawler',
  title: 'Web crawler and search indexing pipeline',
  category: 'Search & discovery',
  tags: ['URL frontier', 'Politeness per host', 'robots.txt', 'Content dedup (SimHash)', 'Inverted index build', 'Recrawl scheduling'],
  summary: 'A search engine must find, fetch and index billions of pages without overloading any site. Follow one URL from the frontier through robots.txt and per-host rate limits, the fetch, parsing and link extraction, near-duplicate detection, and into an inverted index segment that search servers load.',
  requirements: {
    functional: [
      'Discover new pages by following links and sitemaps; refetch pages as they change.',
      'Respect robots.txt and never send a site more requests than it can handle.',
      'Turn fetched pages into searchable index segments.'
    ],
    nonFunctional: [
      'Fetch about 1 billion pages a day.',
      'Skip near-duplicate pages so the index is not filled with copies.',
      'A crawler machine dying loses no URLs.'
    ]
  },
  estimates: [
    { label: 'Fetches', value: '≈ 11,600 / s', note: '1 billion pages / 86,400 s.' },
    { label: 'Bandwidth', value: '≈ 7 Gbit/s', note: '11,600 × ~75 KB compressed HTML.' },
    { label: 'Hosts in flight', value: '≈ 1 million', note: 'Politeness allows ~1 request per host every few seconds, so parallelism must come from many hosts.' },
    { label: 'Duplicates', value: '≈ 25–30%', note: 'Mirrors, tracking parameters, print versions. Detecting them saves index space.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'frontier', label: 'URL frontier', sub: 'priority + host queues', kind: 'queue', icon: 'queue', x: 0, y: 1, desc: 'Every URL to fetch, ordered by priority and grouped by host for politeness.' },
    { id: 'robots', label: 'robots.txt cache', sub: 'Redis', kind: 'cache', icon: 'shield', x: 0, y: 0, desc: 'Parsed robots rules per host, refreshed daily.' },
    { id: 'fetch', label: 'Fetcher', sub: 'async workers', kind: 'worker', icon: 'download', x: 1, y: 1, desc: 'Thousands of concurrent HTTP fetches per machine with httpx/asyncio.' },
    { id: 'dns', label: 'DNS resolver', sub: 'local cache', kind: 'external', icon: 'dns', x: 1, y: 0, desc: 'Caching resolver; DNS would otherwise be a bottleneck.' },
    { id: 'site', label: 'Website', sub: 'example-blog.be', kind: 'external', icon: 'globe', x: 2, y: 0, desc: 'Somebody else\'s server, to be treated gently.' },
    { id: 'parse', label: 'Parser', sub: 'extract + dedup', kind: 'worker', icon: 'cpu', x: 2, y: 1, desc: 'Extracts text, links and metadata; computes fingerprints.' },
    { id: 'store', label: 'Page store', sub: 'S3 (WARC)', kind: 'storage', x: 2, y: 2, desc: 'Raw fetched pages in WARC files, for reprocessing.' },
    { id: 'seen', label: 'Seen URLs', sub: 'Bloom + KV', kind: 'db', icon: 'hash', x: 1, y: 2, desc: 'Which URLs are already known, and fingerprints of content.' },
    { id: 'indexer', label: 'Indexer', sub: 'segment builder', kind: 'worker', icon: 'search', x: 3, y: 1, desc: 'Builds inverted index segments from parsed documents.' },
    { id: 'search', label: 'Search servers', sub: 'load segments', kind: 'service', icon: 'search', x: 3, y: 2, desc: 'Serve queries from the index (the full-text search flow).' }
  ],
  steps: [
    {
      from: 'frontier', to: 'fetch', label: 'next URL for a ready host',
      title: 'The frontier hands out a URL',
      caption: 'The frontier keeps one queue per host and a heap of hosts ordered by when they may next be contacted. example-blog.be\'s time has come, so its highest-priority URL goes to a fetcher.',
      text: ['The {{url frontier}} solves two problems at once: priority (important pages first) and politeness (no host gets hammered). Front queues sort by priority; back queues hold one host each; a heap of "next allowed time" picks the host.', 'Hosts are assigned to fetcher machines by hashing the host name, so one machine owns all requests to a given site and can enforce its rate.'],
      payloadKind: 'Frontier entry',
      payload: { url: 'https://example-blog.be/2026/11/velo-cargo-test', host: 'example-blog.be', priority: 0.71, reason: 'new link from 3 pages', host_next_allowed_at: '2026-11-25T11:41:44.000Z', host_delay_s: 5, assigned_fetcher: 'fetch-17 (hash(host) mod 64)' },
      fields: { priority: 'From link signals, site importance and how often the page changes.', host_delay_s: 'Seconds between requests to this host; from robots.txt Crawl-delay or adaptive from response times.' }
    },
    {
      from: 'fetch', to: 'robots', label: 'allowed? /2026/11/…',
      title: 'Check robots.txt',
      caption: 'The fetcher checks the host\'s cached robots.txt rules. /2026/11/ is allowed for our user agent; /wp-admin/ and /search would not be.',
      text: ['{{robots.txt}} is fetched once a day per host and cached. If it returns 5xx, the crawler assumes everything is disallowed for a while, which is the safe reading.'],
      payloadKind: 'robots.txt',
      payloadLang: 'text',
      payload: String.raw`
# https://example-blog.be/robots.txt (cached 6 h ago)
User-agent: *
Disallow: /wp-admin/
Disallow: /search
Crawl-delay: 5
Sitemap: https://example-blog.be/sitemap.xml

check("/2026/11/velo-cargo-test", agent="ExampleBot") -> ALLOWED`,
      code: [{ lang: 'python', title: 'robots check with cache', src: String.raw`
from urllib.robotparser import RobotFileParser

async def allowed(url: str) -> bool:
    host = urlsplit(url).netloc
    raw = await redis.get(f"robots:{host}")
    if raw is None:
        raw = await fetch_robots(host)          # 404 -> "" (allow all); 5xx -> "Disallow: /"
        await redis.set(f"robots:{host}", raw, ex=86400)
    rp = RobotFileParser()
    rp.parse(raw.decode().splitlines())
    return rp.can_fetch("ExampleBot", url)` }]
    },
    {
      from: 'fetch', to: 'dns', label: 'resolve host',
      title: 'Resolve the host name',
      caption: 'The fetcher resolves example-blog.be through a local caching resolver. At 11,600 fetches a second, uncached DNS lookups would add latency and overload upstream resolvers.',
      payloadKind: 'DNS',
      payload: { host: 'example-blog.be', a: ['185.42.117.20'], ttl_s: 3600, cache: 'HIT', took_ms: 0.2 },
      text: ['The resolved IP is also used for politeness: several host names on one shared server are rate-limited together by IP, so a hosting provider is not overloaded through many small sites.']
    },
    {
      from: 'fetch', to: 'site', label: 'GET (conditional)',
      title: 'Fetch the page politely',
      caption: 'The fetcher sends a GET with an identifying user agent and, because this is a recrawl candidate, If-Modified-Since. It enforces a 10 s timeout and a 5 MB size cap.',
      text: ['An honest user agent with a contact URL lets site owners reach you instead of blocking you. Conditional requests turn unchanged pages into tiny 304 responses.'],
      payloadKind: 'HTTP exchange',
      payload: { request: { method: 'GET', url: 'https://example-blog.be/2026/11/velo-cargo-test', headers: { 'User-Agent': 'ExampleBot/2.1 (+https://search.example/bot)', 'Accept-Encoding': 'br, gzip', 'If-Modified-Since': 'Mon, 23 Nov 2026 08:00:00 GMT' } }, response: { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Last-Modified': 'Wed, 25 Nov 2026 09:12:00 GMT', 'Content-Length': 84211 }, took_ms: 312 } },
      code: [{ lang: 'python', title: 'Polite async fetch', src: String.raw`
limits = httpx.Limits(max_connections=2000, max_keepalive_connections=500)
client = httpx.AsyncClient(http2=True, timeout=10, limits=limits, follow_redirects=False,
                           headers={"User-Agent": "ExampleBot/2.1 (+https://search.example/bot)"})

async def fetch(entry: FrontierEntry) -> FetchResult:
    h = {"If-Modified-Since": entry.last_modified} if entry.last_modified else {}
    async with client.stream("GET", entry.url, headers=h) as r:
        body = b""
        async for chunk in r.aiter_bytes():
            body += chunk
            if len(body) > 5_000_000:
                break                                    # size cap
    await host_clock.schedule_next(entry.host, delay=adaptive_delay(entry.host, r))
    return FetchResult(entry.url, r.status_code, dict(r.headers), body)` }],
      failure: ['**429 or 503 from the site:** the host\'s delay doubles (honouring `Retry-After`), and the URL goes back to its host queue.', '**Redirect (301):** the target URL is added to the frontier as a new URL, deduplicated like any other, instead of being followed blindly (redirect loops, traps).', '**Timeout:** retried later with backoff; after 3 failures the URL\'s priority drops.']
    },
    {
      from: 'fetch', to: 'store', label: 'write WARC record',
      title: 'Keep the raw page',
      caption: 'The raw response is appended to a WARC file on S3. Parsing and indexing can then be re-run (with a better parser, a new language model) without fetching the web again.',
      payloadKind: 'WARC record',
      payloadLang: 'text',
      payload: String.raw`
WARC/1.1
WARC-Type: response
WARC-Target-URI: https://example-blog.be/2026/11/velo-cargo-test
WARC-Date: 2026-11-25T11:41:44Z
WARC-Record-ID: <urn:uuid:3f1c2b9e-…>
Content-Length: 84903

HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
…`,
      text: ['WARC is the standard web archive format (used by the Internet Archive and Common Crawl). Files of ~1 GB with many records each keep S3 object counts manageable.']
    },
    {
      from: 'fetch', to: 'parse', label: 'page → parser',
      title: 'Parse text, links and metadata',
      caption: 'The parser removes navigation and boilerplate, keeps the main text, title, language and canonical URL, and extracts 63 outgoing links, normalised to absolute URLs.',
      text: ['URL normalisation (lowercase host, remove default ports, sort query parameters, strip tracking parameters like utm_*) prevents the same page being queued under ten spellings.', '`rel=canonical` tells the crawler which URL the site considers the real one; `noindex` meta tags are honoured here.'],
      payloadKind: 'Parsed document',
      payload: { url: 'https://example-blog.be/2026/11/velo-cargo-test', canonical: 'https://example-blog.be/2026/11/velo-cargo-test', lang: 'fr', title: 'Test : vélo cargo électrique pour la ville', text_chars: 9412, meta_robots: 'index, follow', out_links: 63, sample_links: ['https://example-blog.be/2026/10/velo-pliant', 'https://vendor.example/cargo-x?utm_source=blog → https://vendor.example/cargo-x'] },
      fields: { sample_links: 'The second link shows normalisation: the utm parameter is removed before deduplication.' }
    },
    {
      from: 'parse', to: 'seen', label: 'SimHash: near-dup?',
      title: 'Detect near-duplicate content',
      caption: 'The parser computes a 64-bit SimHash of the text. Pages whose fingerprints differ in 3 bits or fewer are near-duplicates. This page differs from everything known by at least 6 bits: it is new content.',
      text: ['An exact hash only catches identical bytes; one changed date in a footer defeats it. SimHash maps similar texts to similar fingerprints, so near-copies (print versions, mirrors) are found by counting differing bits.', 'Finding all fingerprints within 3 bits uses the pigeonhole trick: split the 64 bits into 4 blocks; any match within 3 bits shares at least one identical block, so 4 exact lookups find the candidates.'],
      payloadKind: 'Fingerprints',
      payload: { simhash: '0x9f3a61c2e07b4d15', nearest_known: { url: 'https://example-blog.be/2026/10/velo-pliant', simhash: '0x9f3a71c6a17b4c95', hamming_distance: 6 }, threshold: 3, verdict: 'unique' },
      code: [{ lang: 'python', title: 'SimHash', src: String.raw`
def simhash(tokens: list[str]) -> int:
    v = [0] * 64
    for shingle, weight in shingle_weights(tokens, n=3):     # word 3-grams, tf-idf weights
        h = xxhash.xxh64_intdigest(shingle)
        for i in range(64):
            v[i] += weight if (h >> i) & 1 else -weight
    return sum(1 << i for i in range(64) if v[i] > 0)

def near_dup(a: int, b: int, k: int = 3) -> bool:
    return (a ^ b).bit_count() <= k` }],
      failure: ['**Near-duplicate found:** the page is recorded as a duplicate of its cluster\'s best URL (prefer canonical, HTTPS, shorter); only that one is indexed.']
    },
    {
      from: 'parse', to: 'frontier', label: 'new links (Bloom check)',
      title: 'Queue the links nobody has seen',
      caption: 'Each of the 63 links is checked against a Bloom filter of known URLs. 51 were seen before; 12 are probably new, confirmed against the key-value store and added to the frontier with a priority.',
      text: ['A {{bloom filter}} answers "definitely not seen" or "probably seen" using a few bits per URL. For tens of billions of URLs it fits in memory where an exact set would not. Its rare false positives mean a few new URLs are skipped, which is acceptable.'],
      payloadKind: 'Link processing',
      payload: { links: 63, bloom_probably_seen: 51, new: 12, enqueued: [{ url: 'https://example-blog.be/2026/11/antivol-test', priority: 0.55 }, { url: 'https://vendor.example/cargo-x', priority: 0.48 }], skipped: { disallowed_by_robots: 0, nofollow: 2 } }
    },
    {
      from: 'parse', to: 'indexer', label: 'document → index batch',
      title: 'Build an index segment',
      caption: 'The indexer collects parsed documents into batches, tokenises and stems the text per language, and writes an immutable inverted index segment: for each term, the sorted list of documents and positions.',
      text: ['Segments are built offline in bulk and are immutable. That is the same structure as Lucene/Elasticsearch: many segments, periodically merged into larger ones.', 'Link signals (how many pages link here and with what anchor text) are computed in a separate batch job over the link graph and stored as per-document features.'],
      payloadKind: 'Segment (excerpt)',
      payloadLang: 'text',
      payload: String.raw`
segment seg_2026-11-25_1140_eu-fr_0042   docs=1,200,000  size=2.1 GB

term "velo"     df=18,240   postings: [d_88123:{pos 3,41,77}, d_91002:{pos 12}, …]
term "cargo"    df= 6,511   postings: [d_88123:{pos 4,42}, …]
term "electr"   df=40,330   postings: [d_88123:{pos 5}, …]      (stemmed électrique)
doc d_88123 -> url https://example-blog.be/2026/11/velo-cargo-test, lang fr, len 1,402 tokens`
    },
    {
      from: 'indexer', to: 'search', label: 'publish segment',
      title: 'Search servers load the new segment',
      caption: 'The finished segment is uploaded and announced. Search servers download it, open it alongside existing segments, and the page becomes searchable, about 30 minutes after it was fetched.',
      text: ['The query side is the full-text search flow: a query for "vélo cargo" now intersects postings from this segment too and ranks the page with BM25 plus link and freshness signals.'],
      payloadKind: 'Publish',
      payload: { segment: 'seg_2026-11-25_1140_eu-fr_0042', shards: 'eu-fr-07', replicas_loaded: '3/3', live_at: '2026-11-25T12:12:30Z', fetch_to_searchable_min: 31 }
    },
    {
      from: 'frontier', to: 'frontier', label: 'schedule recrawl',
      title: 'Decide when to come back',
      caption: 'The page changed since the last visit, so its change-rate estimate goes up and its next visit is scheduled sooner: in 2 days instead of 7. Pages that never change drift towards monthly visits.',
      text: ['Recrawl scheduling spends the fetch budget where change happens: news front pages every few minutes, old blog posts every few months. Sitemaps with `lastmod` and conditional requests make each revisit cheap.'],
      payloadKind: 'Recrawl decision',
      payload: { url: 'https://example-blog.be/2026/11/velo-cargo-test', visits: 4, changes_detected: 2, estimated_change_interval_days: 3.1, next_fetch_at: '2026-11-27T11:41:44Z', last_modified: 'Wed, 25 Nov 2026 09:12:00 GMT' }
    }
  ],
  api: [
    { verb: 'GET', path: '/{robots.txt, sitemap.xml}', desc: 'Read from each site before crawling.' },
    { verb: 'POST', path: '/internal/frontier/urls', desc: 'Add URLs (from links, sitemaps, submissions) with a priority.' },
    { verb: 'GET', path: '/internal/crawl/{url_hash}', desc: 'Crawl status of a URL: last fetch, status, duplicate cluster, next fetch.' }
  ],
  schema: String.raw`
-- URL state (wide-column KV, keyed by url hash)
url_hash BYTES PRIMARY KEY, url TEXT, host TEXT,
status SMALLINT, last_fetch TIMESTAMP, last_modified TEXT, etag TEXT,
simhash BIGINT, dup_of BYTES, change_interval_days REAL, next_fetch TIMESTAMP, priority REAL

-- Host state
host TEXT PRIMARY KEY, ip TEXT, delay_s REAL, next_allowed TIMESTAMP,
robots_fetched TIMESTAMP, error_streak INT

-- Storage
s3://crawl/warc/2026/11/25/fetch-17-000123.warc.gz
s3://index/segments/eu-fr/seg_2026-11-25_1140_eu-fr_0042/`,
  decisions: [
    { q: 'How do you stay polite at 11,600 fetches a second?', options: [
      { verdict: 'bad', name: 'One global queue, fetch as fast as possible', why: 'Popular sites get hundreds of requests a second and block you.' },
      { verdict: 'great', name: 'Per-host queues, host ownership by hash, adaptive delays', why: 'High total throughput from many hosts, gentle on each one.' }
    ] },
    { q: 'How do you avoid indexing copies?', options: [
      { verdict: 'ok', name: 'Exact content hash', why: 'Misses pages that differ by a date or an ad.' },
      { verdict: 'great', name: 'URL normalisation + canonical tags + SimHash near-dup detection', why: 'Catches spelling variants of URLs and near-identical content.' }
    ] }
  ],
  refs: [
    { label: 'RFC 9309: Robots Exclusion Protocol', url: 'https://www.rfc-editor.org/rfc/rfc9309' },
    { label: 'Manning, Raghavan, Schütze: Introduction to IR, ch. 20 (Web crawling)', url: 'https://nlp.stanford.edu/IR-book/html/htmledition/web-crawling-and-indexes-1.html' },
    { label: 'Manku et al.: Detecting near-duplicates for web crawling (SimHash)', url: 'https://research.google/pubs/detecting-near-duplicates-for-web-crawling/' }
  ]
});
