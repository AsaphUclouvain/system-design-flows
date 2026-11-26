flow({
  id: 'url-to-page',
  title: 'What happens when you type a URL: request to rendered page',
  category: 'Web & networking',
  tags: ['DNS', 'TCP + TLS', 'CDN', 'Reverse proxy', 'HTTP caching', 'Critical rendering path'],
  summary: 'The classic interview question, end to end. Type madgate.app/series/static-bloom and follow the request through DNS, a CDN edge, a reverse proxy, the Next.js server and the FastAPI backend, then back to the browser, which parses HTML, builds the DOM and CSSOM, and paints. Branch on whether the CDN already has the page.',
  requirements: {
    functional: ['Show the series page for a URL typed in the address bar.'],
    nonFunctional: ['First contentful paint under 1.5 s on a fast connection.', 'Static parts served from a cache near the user; dynamic data from the origin.']
  },
  grid: { cols: 5, rows: 3 },
  nodes: [
    { id: 'browser', label: 'Browser', sub: 'renderer + network', kind: 'client', icon: 'browser', x: 0, y: 1, desc: 'Parses the URL, resolves the name, opens a secure connection, sends the request, and turns the response into pixels.' },
    { id: 'dns', label: 'DNS', sub: 'resolver', kind: 'edge', icon: 'globe', x: 0, y: 0, desc: 'Turns madgate.app into the IP of the nearest CDN edge (see the DNS flow).' },
    { id: 'cdn', label: 'CDN edge', sub: 'Brussels PoP', kind: 'edge', icon: 'cloud', x: 1, y: 1, desc: 'A cache close to the user. Terminates TLS and answers cached responses without contacting the origin.' },
    { id: 'proxy', label: 'Reverse proxy', sub: 'nginx / load balancer', kind: 'edge', icon: 'split', x: 2, y: 1, desc: 'Entry point of the origin. Routes /api/* to FastAPI and pages to Next.js, and spreads load over instances.' },
    { id: 'next', label: 'Next.js server', sub: 'server-side render', kind: 'service', icon: 'server', x: 3, y: 1, desc: 'Renders the page\'s HTML on the server, fetching the data it needs from the API.' },
    { id: 'api', label: 'FastAPI', sub: '/api/series/{slug}', kind: 'service', icon: 'api', x: 4, y: 1, desc: 'Business logic. Reads the series and its first chapter range from PostgreSQL.' },
    { id: 'db', label: 'PostgreSQL', sub: 'series, chapters', kind: 'db', icon: 'db', x: 4, y: 2, desc: 'Source of truth for series metadata.' }
  ],
  pseudo: `
url = parse("https://madgate.app/series/static-bloom")
ip = dns.resolve(url.host)                       # nearest CDN edge
conn = tls_connect(ip, 443)                      # TCP + TLS 1.3
resp = conn.send(GET(url.path))
# at the CDN
if cache.fresh(url): return cache.get(url)       # HIT
resp = origin.fetch(url)                         # MISS -> proxy -> Next.js
#   Next.js: data = api.get("/api/series/static-bloom"); html = render(data)
cache.store(url, resp, max_age=resp.s_maxage)
# back in the browser
dom = parse_html(resp.body); cssom = parse_css(fetch_subresources(dom))
render_tree = combine(dom, cssom); layout(render_tree); paint()`,
  steps: [
    {
      from: 'browser', to: 'dns', label: 'A? madgate.app', pc: ['url = parse', 'dns.resolve'],
      title: 'Parse the URL and resolve the host',
      caption: 'The browser splits the URL into scheme (https), host (madgate.app) and path (/series/static-bloom), then asks DNS for the host\'s address.',
      text: ['The CDN\'s DNS answers with the address of an edge server near the user (by anycast or GeoDNS), not the origin\'s address. The full lookup is its own flow.'],
      payloadKind: 'Parsed URL',
      payload: { scheme: 'https', host: 'madgate.app', port: 443, path: '/series/static-bloom', dns_answer: '104.18.20.7 (CDN edge, Brussels)' }
    },
    {
      from: 'browser', to: 'cdn', label: 'TCP + TLS, then GET /series/static-bloom', pc: ['tls_connect', 'conn.send'],
      title: 'Connect securely and send the request',
      caption: 'TCP handshake, TLS 1.3 handshake (see the HTTPS flow), then an HTTP/2 GET with the browser\'s headers and cookies. Two round trips to an edge 8 ms away.',
      text: ['ByteByteGo\'s version of this question lists the same order: DNS lookup, TCP connection, HTTP request, server response, render.'],
      payloadKind: 'HTTP request',
      payload: { method: 'GET', ':path': '/series/static-bloom', ':authority': 'madgate.app', 'accept': 'text/html', 'accept-encoding': 'br, gzip', cookie: 'mg_fav=…' },
      branch: { q: 'Does the edge have a fresh copy of this page?', options: [ { label: 'no: cache miss', goto: 'miss' }, { label: 'yes: cache hit', goto: 'hit' } ] }
    },
    {
      id: 'miss', path: 'miss', from: 'cdn', to: 'proxy', label: 'GET /series/static-bloom (origin pull)', pc: ['origin.fetch'],
      title: 'Miss: the edge asks the origin',
      caption: 'The edge has no fresh copy, so it forwards the request to the origin\'s reverse proxy over a kept-alive connection.',
      text: ['The proxy matches the path: pages go to Next.js, /api/* would go to FastAPI directly. It also adds X-Forwarded-For so the app knows the real client IP.'],
      payloadKind: 'Forwarded request',
      payload: { upstream: 'next:3000', path: '/series/static-bloom', 'x-forwarded-for': '91.178.22.4', 'cdn-cache': 'MISS' }
    },
    {
      path: 'miss', from: 'proxy', to: 'next', label: 'route → next:3000', pc: ['Next.js: data'],
      title: 'The proxy routes to Next.js',
      caption: 'Next.js runs the page\'s server component for /series/[slug]. It needs data before it can produce HTML.',
      text: ['Server rendering sends real HTML on the first response, so the user sees content before any JavaScript runs and crawlers can index the page.'],
      payloadKind: 'Route match',
      payload: { route: '/series/[slug]', params: { slug: 'static-bloom' }, render: 'server component' }
    },
    {
      path: 'miss', from: 'next', to: 'api', label: 'GET /api/series/static-bloom', pc: ['Next.js: data'],
      title: 'Next.js fetches the data from FastAPI',
      caption: 'One internal HTTP call gets the series and the newest 50 chapters\' lightweight metadata.',
      text: ['Keeping business logic in FastAPI and rendering in Next.js gives one place that owns the rules; the page is just a client of the API.'],
      payloadKind: 'API call',
      payload: { method: 'GET', url: 'http://api:8000/api/series/static-bloom?chapters=newest&limit=50' }
    },
    {
      path: 'miss', from: 'api', to: 'db', label: 'SELECT series + 50 chapters', pc: ['Next.js: data'],
      title: 'FastAPI reads PostgreSQL',
      caption: 'Two indexed queries: the series by slug, and chapters ordered by number descending, limit 50.',
      text: ['An index on (series_id, number DESC) lets the database read just the 50 rows it returns.'],
      payloadKind: 'SQL',
      payload: { q1: "SELECT * FROM series WHERE slug = 'static-bloom'", q2: 'SELECT id, number, title, page_count FROM chapters WHERE series_id = 7 ORDER BY number DESC LIMIT 50', rows: 51, ms: 3 }
    },
    {
      path: 'miss', from: 'next', to: 'cdn', reply: true, label: '200 text/html  s-maxage=60', pc: ['html = render', 'cache.store'],
      title: 'HTML goes back and the edge keeps a copy',
      caption: 'Next.js renders the HTML and returns it with a Cache-Control header that lets shared caches keep it for 60 seconds. The edge stores it and forwards it.',
      text: ['s-maxage applies to shared caches like CDNs; max-age to the browser. The next visitor within 60 s in Brussels gets a cache hit.'],
      payloadKind: 'HTTP response',
      payload: { status: 200, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=0, s-maxage=60', 'content-encoding': 'br', bytes: 18400 },
      next: 'render'
    },
    {
      id: 'hit', path: 'hit', from: 'cdn', to: 'cdn', label: 'HIT age=23s', pc: ['cache.fresh'],
      title: 'Hit: the edge answers by itself',
      caption: 'Another reader loaded this page 23 seconds ago. The copy is still fresh (s-maxage 60), so the edge replies in a few milliseconds without touching the origin.',
      text: ['This is what keeps origin load low during a spike: a new chapter announcement can bring thousands of readers, but the origin renders the page once a minute per edge.'],
      payloadKind: 'Cache lookup',
      payload: { key: 'https://madgate.app/series/static-bloom', status: 'HIT', age_s: 23, s_maxage: 60 }
    },
    {
      id: 'render', from: 'cdn', to: 'browser', reply: true, label: '200 HTML (first 14 KB)', pc: ['parse_html', 'combine(dom'],
      title: 'The browser parses and paints',
      caption: 'HTML streams in. The browser builds the DOM, finds the CSS, fonts and scripts and fetches them, builds the CSSOM, combines both into a render tree, lays it out and paints.',
      text: ['MDN notes that the first response packet carries about 14 KB, and the browser starts parsing as soon as it arrives; a preload scanner fetches linked resources early. Render-blocking CSS and synchronous scripts delay the first paint, which is why critical CSS is inlined and scripts are deferred.'],
      payloadKind: 'Rendering pipeline',
      payload: { dom_nodes: 812, subresources: ['app.css', 'chunk-main.js (defer)', 'cover.webp'], steps: ['DOM', 'CSSOM', 'render tree', 'layout', 'paint', 'composite'], first_contentful_paint_ms: 640 }
    }
  ],
  refs: [
    { label: 'ByteByteGo newsletter: What happens when you type a URL into your browser?', url: 'https://blog.bytebytego.com/p/what-happens-when-you-type-a-url' },
    { label: 'MDN: How browsers work', url: 'https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/How_browsers_work', note: 'navigation, 14 KB first packet, parsing, preload scanner, render tree.' },
    { label: 'ByteByteGo newsletter: How does CDN work?', url: 'https://blog.bytebytego.com/p/how-does-cdn-work' },
    { label: 'MDN: Cache-Control', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control' }
  ],
  verify: {
    checked: ['Order DNS → TCP → HTTP → response → render and the DNS cache layers: ByteByteGo post.', 'Parsing on the first chunk, preload scanner, DOM/CSSOM/render tree/layout/paint: MDN.'],
    uncertain: ['IPs, sizes and timings are illustrative; the CDN in front of MadGate is hypothetical (the live MadGate runs on Render).']
  }
});
