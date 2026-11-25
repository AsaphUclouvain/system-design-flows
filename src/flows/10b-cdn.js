flow({
  id: 'cdn-delivery',
  title: 'CDN: edge caching, origin shield and purge',
  category: 'Infrastructure foundations',
  tags: ['Anycast', 'Edge cache', 'Origin shield', 'Cache-Control', 'Surrogate keys', 'stale-while-revalidate'],
  summary: 'A visitor in Brussels opens a Next.js page and its images. Follow the request to the nearest edge location, through a miss to the shield and the origin, then see the second visitor get a hit in 4 ms, a stale page refreshed in the background, and a deploy purge everything tagged with one key.',
  requirements: {
    functional: [
      'Static assets (JS, CSS, images) and cacheable HTML are served from edge locations near users.',
      'A deploy or content change can purge exactly the affected objects within seconds.',
      'Personalised responses (cart, account) are never cached and shown to another user.'
    ],
    nonFunctional: [
      'Time to first byte under 50 ms for cached objects in Europe and North America.',
      'Origin load stays small even during traffic spikes: target ≥ 95% offload.',
      'If the origin is down, users still get the last good copy of cached pages.'
    ]
  },
  estimates: [
    { label: 'Requests', value: '120,000 / s', note: 'Pages, assets and images at peak.' },
    { label: 'Offload target', value: '97%', note: 'So the origin serves about 3,600 req/s; the shield turns many edge misses into one origin fetch.' },
    { label: 'Egress', value: '≈ 30 Gbit/s', note: '120k req/s × ~30 KB average response.' },
    { label: 'Edge locations', value: '300+', note: 'Typical for a large CDN; anycast picks the nearest by network path.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'browser', label: 'Browser', sub: 'Brussels', kind: 'client', icon: 'phone', x: 0, y: 0, desc: 'A visitor opening /shoes/trail and the images on it.' },
    { id: 'dns', label: 'DNS', sub: 'anycast', kind: 'edge', icon: 'dns', x: 0, y: 1, desc: 'Answers the CDN hostname with an anycast IP that every edge location announces.' },
    { id: 'edge', label: 'Edge location', sub: 'BRU PoP', kind: 'edge', icon: 'cdn', x: 1, y: 0, desc: 'Terminates TLS, looks up the cache key, serves hits from memory or SSD.' },
    { id: 'edge2', label: 'Edge location', sub: 'AMS PoP', kind: 'edge', icon: 'cdn', x: 1, y: 2, desc: 'Another edge location. Without a shield, it would fetch the same object from the origin again.' },
    { id: 'shield', label: 'Origin shield', sub: 'FRA tier', kind: 'cache', icon: 'shield', x: 2, y: 1, desc: 'One regional cache that all edges ask before the origin.' },
    { id: 'origin', label: 'Next.js origin', sub: 'Node servers', kind: 'service', x: 3, y: 0, desc: 'Renders pages and sets Cache-Control and Surrogate-Key headers.' },
    { id: 'bucket', label: 'Asset bucket', sub: 'S3', kind: 'storage', x: 3, y: 2, desc: 'Build output (/_next/static) and product images, immutable files with a hash in their name.' },
    { id: 'ci', label: 'Deploy / CMS', sub: 'CI job', kind: 'worker', x: 2, y: 2, desc: 'After a deploy or a content edit, calls the CDN purge API by tag.' }
  ],
  steps: [
    {
      from: 'browser', to: 'dns', label: 'A? www.shop.example',
      title: 'Resolve the hostname',
      caption: 'The browser asks DNS for www.shop.example. It is a CNAME to the CDN, whose name servers return one anycast address.',
      text: ['With {{anycast}}, the same IP is announced from every edge location; Internet routing (BGP) delivers packets to the nearest one by network path. Some CDNs use GeoDNS instead and return a different IP per region.'],
      payloadKind: 'DNS answer',
      payloadLang: 'text',
      payload: String.raw`
www.shop.example.     300  IN CNAME  shop.example.cdn-provider.net.
shop.example.cdn-provider.net. 60 IN A 151.101.1.57     ; anycast, announced by 300+ PoPs`,
      fields: {}
    },
    {
      from: 'browser', to: 'edge', label: 'GET /shoes/trail (TLS)',
      title: 'TLS ends at the nearest edge',
      caption: 'The connection lands in the Brussels edge location, 3 ms away. TLS is terminated there with the site\'s certificate, so the handshake does not cross to the origin in Frankfurt.',
      text: ['A TLS 1.3 handshake costs one round trip; at 3 ms instead of 25 ms, the page starts loading noticeably faster even before any caching.'],
      payloadKind: 'HTTP request',
      payload: { method: 'GET', url: 'https://www.shop.example/shoes/trail', headers: { 'Accept-Encoding': 'br, gzip', 'Accept-Language': 'fr-BE,fr;q=0.9,en;q=0.8', Cookie: '_ga=GA1.1.33…; theme=dark' } },
      fields: { Cookie: 'The edge strips cookies that do not change the HTML (analytics, theme) from the cache key; otherwise every visitor would have their own cache entry.' }
    },
    {
      from: 'edge', to: 'edge', label: 'cache lookup: MISS',
      title: 'Build the cache key and look it up',
      caption: 'The edge builds the cache key from host, path, encoding and language. Nobody in Brussels asked for this page in the last minute, so it is a miss.',
      text: ['The {{cache key}} decides correctness. Leave out a header that changes the response (language) and users get the wrong page; include one that does not matter (a full cookie) and the hit ratio drops to zero.'],
      payloadKind: 'Cache key',
      payload: { key: 'www.shop.example|/shoes/trail|br|fr', varies_on: ['Accept-Encoding', 'Accept-Language (normalised to fr / en / nl)'], result: 'MISS', stored_objects_in_pop: 18400000 },
      fields: { varies_on: 'Accept-Language is normalised to a few values first. Raw headers have thousands of variants and would fragment the cache.' },
      code: [{ lang: 'ts', title: 'Edge function: normalise the key', src: String.raw`
// runs at the edge before the cache lookup
export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const lang = (req.headers.get("accept-language") || "").slice(0, 2);
    const norm = ["fr", "nl", "en"].includes(lang) ? lang : "en";
    url.searchParams.delete("utm_source");           // tracking params never change HTML
    url.searchParams.delete("fbclid");
    const h = new Headers(req.headers);
    h.set("x-lang", norm);
    h.delete("cookie");                                // public pages ignore cookies
    return fetch(new Request(url.toString(), { headers: h }), {
      cf: { cacheKey: url.host + url.pathname + url.search + "|" + norm },
    });
  },
};` }]
    },
    {
      from: 'edge', to: 'shield', label: 'GET (miss)',
      title: 'The miss goes to the origin shield',
      caption: 'Instead of contacting the origin, the edge asks the shield in Frankfurt. Every edge in Europe asks the same shield, so a popular page is fetched from the origin once, not 40 times.',
      text: ['The {{origin shield}} also coalesces requests: if 200 edges miss on the same object in the same second, the shield sends one request to the origin and answers all 200 from it.'],
      payloadKind: 'HTTP request',
      payload: { method: 'GET', url: 'https://origin.shop.example/shoes/trail', headers: { 'X-Lang': 'fr', 'CDN-Loop': 'edge-bru', Via: '1.1 edge-bru' } },
      fields: { 'CDN-Loop': 'Prevents request loops if a CDN is misconfigured to point at itself.' },
      failure: ['**Shield unreachable:** edges fall back to contacting the origin directly. Origin load jumps, which is why the origin is sized for some multiple of normal miss traffic.']
    },
    {
      from: 'shield', to: 'origin', label: 'GET /shoes/trail',
      title: 'The origin renders the page',
      caption: 'Next.js renders the category page and returns it with caching headers: shared caches may keep it for 60 s, then serve it stale for 10 minutes while revalidating, and the page carries two purge tags.',
      text: ['`s-maxage` applies to shared caches (CDN) only; `max-age=0` keeps browsers asking the CDN, which is cheap. {{stale-while-revalidate}} means no user ever waits for a re-render after the first one.'],
      payloadKind: 'HTTP response',
      payload: { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=600, stale-if-error=86400', 'Surrogate-Key': 'category:trail products-list', ETag: '"c7f1-9a2"', Vary: 'X-Lang' }, body: '<!doctype html>… (38 KB)' },
      fields: { 'Surrogate-Key': 'Tags for purging. Changing any trail shoe purges `category:trail`, without knowing every URL that shows it ({{surrogate key}}).', 'stale-if-error': 'If the origin returns 5xx or is down, the CDN may serve the stale copy for a day.' },
      code: [{ lang: 'ts', title: 'next.config.js + route headers', src: String.raw`
// app/shoes/[cat]/page.tsx
export const revalidate = 60;

// middleware.ts: add purge tags and shared-cache rules to public pages
export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const cat = req.nextUrl.pathname.split("/")[2];
  res.headers.set("Cache-Control",
    "public, max-age=0, s-maxage=60, stale-while-revalidate=600, stale-if-error=86400");
  res.headers.set("Surrogate-Key", "category:" + cat + " products-list");
  return res;
}
export const config = { matcher: ["/shoes/:path*"] };` }],
      failure: ['**Origin returns 500:** with `stale-if-error`, the shield serves its last good copy if it has one. With nothing cached, the error goes to the user, but is not cached (5xx are not cacheable by default here).']
    },
    {
      from: 'shield', to: 'edge', label: '200 + store', reply: true,
      title: 'Both tiers store the page',
      caption: 'The shield stores the response, then the Brussels edge stores it too. The visitor gets the page about 45 ms after the request; the next visitor in Brussels will not wait for Frankfurt.',
      payloadKind: 'HTTP response',
      payload: { status: 200, headers: { 'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=600', Age: '0', 'X-Cache': 'MISS, MISS', 'Server-Timing': 'cdn-cache;desc=MISS, edge;dur=2, origin;dur=38' } },
      text: ['`X-Cache: MISS, MISS` reads edge then shield. `Age` counts seconds since the origin produced the response.']
    },
    {
      from: 'browser', to: 'edge', label: 'GET /_next/static/…js',
      title: 'Assets are immutable and cached for a year',
      caption: 'The page pulls its JavaScript and images. Their file names contain a content hash, so they can be cached by browsers and the CDN for a year and never need a purge.',
      text: ['A new deploy produces new file names (`main-8c1e.js` becomes `main-41ab.js`), so the HTML points at new files and old ones simply stop being requested.', 'Images go through an image optimiser at the edge that resizes and converts to AVIF/WebP depending on the `Accept` header.'],
      payloadKind: 'HTTP response',
      payload: { request: 'GET /_next/static/chunks/main-8c1e2f.js', status: 200, headers: { 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Encoding': 'br', 'X-Cache': 'HIT', Age: '86211' } },
      fields: { immutable: 'Tells browsers not to revalidate even on reload. Safe only because the URL changes whenever the content does.' }
    },
    {
      from: 'shield', to: 'bucket', label: 'GET image (miss)',
      title: 'Images are fetched from the bucket, not the app servers',
      caption: 'The first request for a new product photo misses at the edge and the shield, and the shield fetches the original from the S3 bucket. Node servers never spend time streaming bytes.',
      text: ['The CDN has a second origin for `/images/*` and `/_next/static/*` that points at the bucket. The bucket only accepts requests signed by the CDN (origin access control), so nobody can bypass the cache and run up the S3 bill.', 'The image optimiser stores each variant (width 640, AVIF) as its own cached object; the original is fetched once.'],
      payloadKind: 'Origin request',
      payload: { method: 'GET', url: 'https://assets-shop.s3.eu-central-1.amazonaws.com/images/p_812/main.jpg', headers: { Authorization: 'AWS4-HMAC-SHA256 Credential=\u2026 (signed by the CDN)' }, response: { status: 200, 'Content-Length': 2381204, 'Cache-Control': 'public, max-age=86400, s-maxage=2592000' }, variant_served: { width: 640, format: 'avif', bytes: 48211 } },
      fields: { variant_served: 'The edge resized the 2.3 MB original to a 48 KB AVIF for this phone screen.' },
      failure: ['**Object missing (404):** cached briefly (negative caching, 60 s) so a broken image link does not hit S3 on every page view.']
    },
    {
      from: 'edge2', to: 'shield', label: 'GET (miss) → HIT',
      title: 'Another edge misses, the shield hits',
      caption: 'A visitor in Amsterdam requests the same page. The Amsterdam edge misses, but the shield has it: answered in 12 ms without touching the origin.',
      payloadKind: 'HTTP response',
      payload: { status: 200, headers: { Age: '14', 'X-Cache': 'MISS, HIT' } },
      text: ['This is the point of a shield: origin requests scale with the number of distinct objects, not with objects × edge locations.']
    },
    {
      from: 'edge', to: 'origin', label: 'stale → background refresh', async: true,
      title: 'A stale page is served instantly, refreshed behind the scenes',
      caption: '90 seconds later the Brussels copy is older than s-maxage. The next visitor still gets it immediately; the edge revalidates in the background with If-None-Match.',
      text: ['The origin compares the ETag. If the page did not change, it answers `304 Not Modified` with no body and the cached copy is fresh again for 60 s.'],
      payloadKind: 'Conditional request',
      payload: { request: { method: 'GET', path: '/shoes/trail', headers: { 'If-None-Match': '"c7f1-9a2"' } }, response: { status: 304, headers: { ETag: '"c7f1-9a2"', 'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=600' } }, user_saw: 'X-Cache: STALE (4 ms)' }
    },
    {
      from: 'ci', to: 'edge', label: 'POST /purge tag=category:trail',
      title: 'A price change purges by tag',
      caption: 'An editor changes a trail shoe\'s price. The CMS webhook calls the CDN purge API with the tag category:trail; every edge and the shield drop all objects with that tag within a couple of seconds.',
      text: ['Purging by tag replaces guessing URLs: the category page, page 2, the sorted variants and the French and Dutch versions all carry the same tag.', 'Most CDNs offer a soft purge that marks objects stale instead of deleting them, so the next request is served stale while revalidating, avoiding a burst on the origin.'],
      payloadKind: 'Purge API',
      payload: { method: 'POST', path: '/zones/z_41/purge_cache', body: { tags: ['category:trail'], soft: true }, response: { success: true, id: 'purge_9f1c', propagated_ms: 1800 } },
      code: [{ lang: 'python', title: 'FastAPI: purge after a product change', src: String.raw`
@router.post("/internal/cms/product-changed")
async def product_changed(ev: ProductChanged):
    tags = [f"product:{ev.id}", f"category:{ev.category}"]
    async with httpx.AsyncClient(timeout=5) as c:
        r = await c.post(f"{CDN_API}/zones/{ZONE}/purge_cache",
                         headers={"Authorization": f"Bearer {CDN_TOKEN}"},
                         json={"tags": tags, "soft": True})
        r.raise_for_status()
    return {"purged": tags}` }],
      failure: ['**Purge API call fails:** the job retries with {{exponential backoff}}. Worst case, `s-maxage=60` limits how long the old price shows; that short TTL is the backstop.', '**Purging everything after each deploy:** origin load spikes to 30× normal for a minute. Hashed asset names and tag purges avoid full purges entirely.']
    }
  ],
  api: [
    { verb: 'GET', path: '/{any public path}', desc: 'Served by the CDN; origin sets `Cache-Control`, `ETag`, `Surrogate-Key`.' },
    { verb: 'POST', path: '/zones/{zone}/purge_cache', desc: 'CDN purge by tags, URLs or prefix; soft purge marks stale.' },
    { verb: 'POST', path: '/internal/cms/product-changed', desc: 'CMS webhook that triggers the tag purge.' }
  ],
  schemaLang: 'text',
  schemaNote: 'Caching rules by path. The CDN stores objects; your systems only set headers.',
  schema: String.raw`
Path                      Cache-Control                                         Purge
/_next/static/*           public, max-age=31536000, immutable                    never (hashed names)
/images/*                 public, max-age=86400, s-maxage=2592000                tag product:{id}
/shoes/*, /p/*            public, max-age=0, s-maxage=60, swr=600, sie=86400      tag category:*, product:*
/api/products/*           public, s-maxage=30                                    tag product:{id}
/cart, /account, /api/me  private, no-store                                      n/a (never cached)`,
  decisions: [
    { q: 'How do you keep cached HTML fresh?', options: [
      { verdict: 'bad', name: 'Long TTL and full purge on every deploy', why: 'Origin stampede after each deploy; stale content between deploys.' },
      { verdict: 'good', name: 'Short s-maxage only', why: 'Simple, but every page re-renders every minute in every region.' },
      { verdict: 'great', name: 'Short s-maxage + stale-while-revalidate + tag purges', why: 'Instant responses, fresh within seconds of a change, and low origin load.' }
    ] },
    { q: 'Why add an origin shield?', options: [
      { verdict: 'ok', name: 'Edges go straight to origin', why: 'Fine for small sites; with 300 PoPs, each object can be fetched 300 times.' },
      { verdict: 'great', name: 'One shield region near the origin', why: 'Collapses misses from every edge into one origin request per object.' }
    ] }
  ],
  refs: [
    { label: 'MDN: Cache-Control', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control' },
    { label: 'RFC 5861: stale-while-revalidate and stale-if-error', url: 'https://www.rfc-editor.org/rfc/rfc5861' },
    { label: 'Cloudflare: What is anycast?', url: 'https://www.cloudflare.com/learning/cdn/glossary/anycast-network/' }
  ]
});
