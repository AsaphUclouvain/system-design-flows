flow({
  id: 'nearby-places',
  title: 'Nearby places search (PostGIS, Yelp-style)',
  category: 'Search & discovery',
  tags: ['PostGIS', 'GiST index', 'KNN ordering', 'Tile caching', 'Ranking by distance + rating', 'Map viewport queries'],
  summary: 'Someone in Louvain-la-Neuve searches "pizza open now" on a map. Unlike ride matching, these places barely move, so the system uses a spatial index in PostgreSQL. Follow the query from the map viewport through a geography index, filters for opening hours, a ranking that mixes distance and rating, cached results per map tile, and a new restaurant appearing after it is added.',
  requirements: {
    functional: [
      'Find places near a point or inside the visible map area, filtered by category and "open now".',
      'Rank by a mix of distance, rating and popularity; show distance on each result.',
      'New or edited places appear in search within a minute.'
    ],
    nonFunctional: [
      'p95 under 120 ms at 8,000 searches per second.',
      'Correct distances on a sphere (metres, not degrees).',
      'Panning the map must not trigger a database query for every pixel moved.'
    ]
  },
  estimates: [
    { label: 'Places', value: '200 million', note: 'Worldwide; a few KB each with hours and attributes.' },
    { label: 'Searches', value: '8,000 / s', note: 'Peak around lunch and dinner time.' },
    { label: 'Write rate', value: '≈ 50 / s', note: 'New places, hours changes, closures. Very read-heavy: 160 reads per write.' },
    { label: 'Index', value: '≈ 15 GB', note: 'GiST index on 200M points; sharded by region so each shard\'s index fits in memory.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'map', label: 'Map search', sub: 'Next.js + MapLibre', kind: 'client', icon: 'globe', x: 0, y: 0, desc: 'Map with a search box and a results list that follows the viewport.' },
    { id: 'api', label: 'Places API', sub: 'FastAPI', kind: 'service', icon: 'pin', x: 1, y: 0, desc: 'Parses the query, picks the region shard, runs the spatial query and ranks.' },
    { id: 'cache', label: 'Tile cache', sub: 'Redis', kind: 'cache', x: 1, y: 1, desc: 'Results per (map tile, query, hour) so panning back and forth is free.' },
    { id: 'geo', label: 'Places DB', sub: 'PostGIS, EU shard', kind: 'db', icon: 'db', x: 2, y: 0, desc: 'Places with a geography(Point) column and a GiST index.' },
    { id: 'hours', label: 'Opening hours', sub: 'same DB', kind: 'db', icon: 'clock', x: 2, y: 1, desc: 'Weekly opening intervals per place, in the place\'s time zone.' },
    { id: 'owner', label: 'Owner portal', sub: 'Next.js', kind: 'client', icon: 'user', x: 3, y: 2, desc: 'A restaurant owner adds their place.' },
    { id: 'geocode', label: 'Geocoder', sub: 'address → point', kind: 'external', icon: 'pin', x: 3, y: 1, desc: 'Turns an address into latitude and longitude.' },
    { id: 'tiles', label: 'Vector tiles', sub: 'CDN', kind: 'edge', icon: 'cdn', x: 0, y: 1, desc: 'Base map tiles; static and cached at the edge.' }
  ],
  steps: [
    {
      from: 'map', to: 'tiles', label: 'GET /tiles/14/8401/5508.pbf',
      title: 'The map loads its base tiles',
      caption: 'The map is drawn from vector tiles identified by zoom, x and y. They are the same for everyone, so they come from a CDN. The search only adds pins on top.',
      text: ['At zoom 14 a tile is about 2.4 km wide at the equator and about 1.55 km wide at Louvain-la-Neuve\'s latitude. The same tile grid is reused later to cache search results.'],
      payloadKind: 'Tile request',
      payload: { url: 'https://tiles.example/v3/14/8401/5508.pbf', 'Cache-Control': 'public, max-age=604800', size_kb: 61, x_cache: 'HIT' }
    },
    {
      from: 'map', to: 'api', label: 'GET /v1/search?q=pizza',
      title: 'Search inside the visible area',
      caption: 'The person types "pizza" and ticks "Open now". The client sends the map centre and bounding box. Requests are debounced: only after the map stops moving for 300 ms.',
      text: ['Sending the viewport, not just a radius, matches what the person sees: a tall phone screen covers a different area than a wide desktop map.'],
      payloadKind: 'HTTP request',
      payload: { method: 'GET', path: '/v1/search', query: { q: 'pizza', open_now: true, lat: 50.6681, lng: 4.6118, bbox: '4.5951,50.6600,4.6285,50.6762', zoom: 14, limit: 20 }, headers: { 'Accept-Language': 'fr-BE' } },
      fields: { bbox: 'min longitude, min latitude, max longitude, max latitude of the visible map.' },
      code: [{ lang: 'ts', title: 'Debounced viewport search', src: String.raw`
"use client";
export function useViewportSearch(map: maplibregl.Map, q: string, openNow: boolean) {
  const [results, setResults] = useState<Place[]>([]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    let ctrl = new AbortController();
    const run = () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        ctrl.abort(); ctrl = new AbortController();      // cancel the stale request
        const b = map.getBounds(), c = map.getCenter();
        const p = new URLSearchParams({ q, open_now: String(openNow), lat: String(c.lat),
          lng: String(c.lng), bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(","),
          zoom: String(Math.round(map.getZoom())) });
        const r = await fetch("/api/search?" + p, { signal: ctrl.signal });
        setResults((await r.json()).results);
      }, 300);
    };
    map.on("moveend", run); run();
    return () => { map.off("moveend", run); ctrl.abort(); };
  }, [map, q, openNow]);
  return results;
}` }]
    },
    {
      from: 'api', to: 'cache', label: 'GET tile results',
      title: 'Check cached results for this tile',
      caption: 'The API maps the viewport centre to its zoom-14 tile and builds a key from tile, query, filters and the current hour. Nobody searched pizza here this hour yet: a miss.',
      text: ['Including the hour in the key handles "open now" without invalidation: results for 12:00–12:59 are computed once and expire on their own.', 'Snapping to tiles is the trick that makes caching work for maps: thousands of slightly different viewports fall on the same few tiles.'],
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
> GET srch:t14:8401:5508:pizza:open:2026-11-25T12
(nil)`,
      failure: ['**Redis down:** the API skips the cache and queries the database, protected by a concurrency limit.']
    },
    {
      from: 'api', to: 'geo', label: 'ST_DWithin + KNN',
      title: 'Spatial query on the GiST index',
      caption: 'PostGIS finds pizza places within 2 km of the centre using the GiST index, computing true distances on the sphere in metres, and orders candidates by distance with the KNN operator.',
      text: ['A plain B-tree cannot answer "near this point" because closeness is two-dimensional. A {{spatial index}} (GiST, an R-tree variant) groups places into nested bounding boxes, so the query only opens boxes that touch the search area.', 'The `geography` type measures in metres on the Earth\'s spheroid; with `geometry` in degrees, 0.01° of longitude is a different distance in Brussels than in Lisbon.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
SELECT p.id, p.name, p.rating, p.review_count,
       ST_Distance(p.geog, ST_MakePoint(4.6118, 50.6681)::geography) AS dist_m
FROM places p
WHERE p.category_ids && ARRAY[412]                         -- pizza
  AND p.status = 'active'
  AND ST_DWithin(p.geog, ST_MakePoint(4.6118, 50.6681)::geography, 2000)
ORDER BY p.geog <-> ST_MakePoint(4.6118, 50.6681)::geography
LIMIT 200;

-- Index Scan using places_geog_gist on places p  (rows=37)
-- Execution Time: 3.8 ms`,
      code: [{ lang: 'python', title: 'Query with asyncpg', src: String.raw`
NEARBY = """
SELECT id, name, rating, review_count, price_level, tz,
       ST_Distance(geog, ST_MakePoint($1, $2)::geography) AS dist_m
FROM places
WHERE category_ids && $3 AND status = 'active'
  AND ST_DWithin(geog, ST_MakePoint($1, $2)::geography, $4)
ORDER BY geog <-> ST_MakePoint($1, $2)::geography
LIMIT 200"""

async def candidates(lng: float, lat: float, cats: list[int], radius_m: int):
    pool = shard_for(lng, lat)                       # EU, NA, APAC… by region
    rows = await pool.fetch(NEARBY, lng, lat, cats, radius_m)
    if len(rows) < 20 and radius_m < 16000:          # sparse area: widen the circle
        return await candidates(lng, lat, cats, radius_m * 2)
    return rows` }],
      failure: ['**Too few results (countryside):** the API doubles the radius up to 16 km so a village still gets results.', '**Query near a shard border (e.g. on the France–Belgium line):** the API queries both shards in parallel and merges.']
    },
    {
      from: 'api', to: 'hours', label: 'open now? (local time)',
      title: 'Filter by "open now" in each place\'s time zone',
      caption: 'For the 37 candidates, the API checks opening intervals against the current time in the place\'s own time zone (Europe/Brussels): Wednesday 12:41. 24 are open.',
      text: ['Opening hours are stored as local times with the place\'s time zone, never as UTC. Converting to UTC once would break twice a year when daylight saving time changes.', 'Intervals that cross midnight (18:00–02:00) are stored as two intervals so the check stays simple.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
SELECT h.place_id
FROM opening_hours h JOIN places p ON p.id = h.place_id
WHERE h.place_id = ANY($1)
  AND h.weekday = EXTRACT(ISODOW FROM now() AT TIME ZONE p.tz)        -- 3 (Wednesday)
  AND (now() AT TIME ZONE p.tz)::time BETWEEN h.opens AND h.closes;   -- 12:41
-- 24 of 37 open`
    },
    {
      from: 'api', to: 'api', label: 'rank: distance × rating',
      title: 'Rank: close, good and well-reviewed',
      caption: 'Pure distance ordering would put a 2.9-star place 200 m away above a 4.7-star one 600 m away. The API scores each place with distance decay, a rating adjusted for review count, and text relevance.',
      text: ['A rating with 3 reviews is less trustworthy than one with 900. A Bayesian average pulls ratings with few reviews toward the global mean (here 3.9) until they collect more.', 'Distance decay uses a half-distance that depends on zoom: zoomed in, people want very close; zoomed out, they accept further.'],
      payloadKind: 'Ranking',
      payload: [
        { name: 'Pizzeria Il Forno', dist_m: 610, rating: 4.7, reviews: 912, bayes: 4.68, distance_factor: 0.79, score: 4.11 },
        { name: 'Napoli Express', dist_m: 210, rating: 4.1, reviews: 233, bayes: 4.08, distance_factor: 0.97, score: 4.01 },
        { name: 'Slice Corner', dist_m: 180, rating: 2.9, reviews: 41, bayes: 3.23, distance_factor: 0.98, score: 3.19 }
      ],
      code: [{ lang: 'python', title: 'Scoring', src: String.raw`
GLOBAL_MEAN, PRIOR = 3.9, 20          # as if every place had 20 extra average reviews

def score(p, half_m: float) -> float:
    bayes = (p.rating * p.review_count + GLOBAL_MEAN * PRIOR) / (p.review_count + PRIOR)
    distance_factor = 1 / (1 + (p.dist_m / half_m) ** 2)      # 0.5 at half_m
    return bayes * (0.4 + 0.6 * distance_factor) + 0.2 * p.text_match

half_m = {16: 400, 15: 700, 14: 1200, 13: 2500}.get(zoom, 1200)
ranked = sorted(open_places, key=lambda p: score(p, half_m), reverse=True)[:20]` }]
    },
    {
      from: 'api', to: 'cache', label: 'SET tile results EX 900',
      title: 'Cache the ranked list for this tile',
      caption: 'The top 50 ids with their distances from the tile centre are cached for 15 minutes. The next person searching pizza nearby, or this person panning back, gets results without a database query.',
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
> SET srch:t14:8401:5508:pizza:open:2026-11-25T12 "[\"pl_88\",\"pl_19\",…]" EX 900
OK`,
      text: ['Only ids are cached; names, ratings and photos come from a per-place cache, so a renamed restaurant shows its new name even in cached results.']
    },
    {
      from: 'api', to: 'map', label: '20 results + pins', reply: true,
      title: 'Pins on the map, list beside it',
      caption: 'The response has 20 places with coordinates, distance and whether they are open. The map drops pins; at low zoom, nearby pins are clustered client-side so the map stays readable.',
      payloadKind: 'HTTP response',
      payload: { status: 200, headers: { 'X-Cache': 'MISS', 'Server-Timing': 'db;dur=3.8, hours;dur=1.2, total;dur=14' }, body: { results: [{ id: 'pl_88', name: 'Pizzeria Il Forno', lat: 50.6722, lng: 4.6177, dist_m: 610, rating: 4.7, open_until: '14:00' }, { id: 'pl_19', name: 'Napoli Express', lat: 50.6669, lng: 4.6141, dist_m: 210, rating: 4.1, open_until: '14:30' }], total_in_area: 24 } },
      text: ['Distances are shown rounded (210 m, 0.6 km). The coordinates let the map draw pins without another request.']
    },
    {
      from: 'owner', to: 'geocode', label: 'address → lat/lng',
      title: 'A new restaurant is added',
      caption: 'An owner registers "Forno Verde, Grand-Place 12, 1348 Louvain-la-Neuve". The portal geocodes the address and shows a pin the owner can drag to the exact entrance.',
      text: ['Geocoders return the centre of a building or a street segment; letting the owner adjust the pin avoids places shown on the wrong side of a pedestrian square.'],
      payloadKind: 'Geocoder response',
      payload: { query: 'Grand-Place 12, 1348 Louvain-la-Neuve, Belgium', result: { lat: 50.66871, lng: 4.61204, precision: 'rooftop', confidence: 0.93 }, adjusted_by_owner: { lat: 50.66866, lng: 4.61221 } }
    },
    {
      from: 'geocode', to: 'geo', label: 'INSERT place (geog)',
      title: 'Insert the place; the index updates itself',
      caption: 'The place is inserted with its point as a geography value. The GiST index is updated in the same transaction, so the place is searchable immediately in the database; cached tiles show it within 15 minutes, or sooner after a targeted purge.',
      text: ['After insert, the API deletes cached result keys for the zoom-14 tile containing the new point and its eight neighbours, for common categories, so it appears in under a minute.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
INSERT INTO places (id, name, category_ids, geog, tz, status, rating, review_count)
VALUES ('pl_9012', 'Forno Verde', ARRAY[412, 77],
        ST_MakePoint(4.61221, 50.66866)::geography, 'Europe/Brussels', 'active', NULL, 0);
INSERT INTO opening_hours (place_id, weekday, opens, closes) VALUES
  ('pl_9012', 3, '11:30', '14:30'), ('pl_9012', 3, '18:00', '22:30');   -- Wednesday

-- then: UNLINK srch:t14:8401:5508:pizza:* and the 8 neighbouring tiles`
    }
  ],
  api: [
    { verb: 'GET', path: '/v1/search?q&lat&lng&bbox&zoom&open_now', desc: 'Ranked places in the viewport.' },
    { verb: 'GET', path: '/v1/places/{id}', desc: 'Place details, hours, photos.' },
    { verb: 'POST', path: '/v1/owner/places', desc: 'Create a place (geocoded, pin adjustable).' }
  ],
  schema: String.raw`
CREATE EXTENSION postgis;
CREATE TABLE places (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, category_ids INT[] NOT NULL,
  geog geography(Point, 4326) NOT NULL, tz TEXT NOT NULL,
  rating NUMERIC(2,1), review_count INT DEFAULT 0, price_level SMALLINT,
  status TEXT NOT NULL DEFAULT 'active', updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX places_geog_gist ON places USING GIST (geog);
CREATE INDEX places_cat_gin   ON places USING GIN (category_ids);
CREATE TABLE opening_hours (
  place_id TEXT REFERENCES places, weekday SMALLINT CHECK (weekday BETWEEN 1 AND 7),
  opens TIME NOT NULL, closes TIME NOT NULL
);
CREATE INDEX ON opening_hours (place_id, weekday);`,
  decisions: [
    { q: 'How do you index places?', options: [
      { verdict: 'bad', name: 'B-tree on latitude and longitude separately', why: 'A box query uses one index and scans a whole stripe of the world.' },
      { verdict: 'good', name: 'Geohash prefixes in a key-value store', why: 'Simple and fast, but cell edges need neighbour lookups and distances are approximate.' },
      { verdict: 'great', name: 'PostGIS geography + GiST, sharded by region', why: 'Exact metres, KNN ordering, and normal SQL filters alongside.' }
    ] },
    { q: 'How do you rank?', options: [
      { verdict: 'ok', name: 'Distance only', why: 'Shows the nearest bad place first.' },
      { verdict: 'great', name: 'Distance decay × Bayesian rating + text match', why: 'Balances close and good, and does not over-trust places with few reviews.' }
    ] }
  ],
  refs: [
    { label: 'PostGIS: ST_DWithin', url: 'https://postgis.net/docs/ST_DWithin.html' },
    { label: 'PostGIS: KNN <-> operator', url: 'https://postgis.net/docs/geometry_distance_knn.html' },
    { label: 'OpenStreetMap wiki: Slippy map tilenames', url: 'https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames' }
  ]
});
