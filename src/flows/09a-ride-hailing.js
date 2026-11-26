flow({
  id: 'ride-hailing',
  title: 'Ride matching with geo indexing',
  category: 'Real-time',
  tags: ['Geohash / H3', 'Redis GEO', 'Location stream', 'Matching', 'Distributed lock'],
  summary: 'Ana requests a ride in Louvain-la-Neuve; within three seconds the nearest free driver is offered the trip, and no two riders ever get the same driver. 4-second location pings, a geo index, candidate search by ETA, offers with timeouts, and a lock that makes assignment exclusive.',
  requirements: {
    functional: [
      'Drivers share their location while online; riders see nearby cars on a map.',
      'A ride request is matched with a nearby available driver, who can accept or decline.',
      'During the trip both apps see live positions and the ETA.'
    ],
    nonFunctional: [
      'Matching completes in a few seconds at p95.',
      'A driver is never assigned to two trips at once.',
      'Location writes are very high volume; losing an occasional ping is acceptable.'
    ]
  },
  estimates: [
    { label: 'Online drivers', value: '1M', note: 'Assumption, worldwide peak.' },
    { label: 'Location pings', value: '250,000 / s', note: '1M drivers ÷ one ping every 4 s.' },
    { label: 'Ride requests', value: '≈ 230 / s', note: '20M trips a day ÷ 86,400 (peaks ×3).' },
    { label: 'Geo index memory', value: '≈ 100 MB', note: '1M members × about 100 bytes in a Redis GEO set; split by city anyway for load.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'driver', label: 'Driver app', sub: 'mobile', kind: 'client', icon: 'car', x: 0, y: 0, desc: 'Sends location every 4 s while online; receives trip offers.' },
    { id: 'loc', label: 'Location service', sub: 'FastAPI WS', kind: 'edge', icon: 'globe', x: 1, y: 0, desc: 'Ingests pings over WebSocket, updates the geo index, forwards to the stream.' },
    { id: 'geo', label: 'Geo index', sub: 'Redis GEO (per city)', kind: 'cache', icon: 'globe', x: 1, y: 1, desc: 'Available drivers as a geospatial sorted set: GEOSEARCH by radius in milliseconds.' },
    { id: 'stream', label: 'Location stream', sub: 'Kafka', kind: 'queue', x: 2, y: 0, desc: 'All pings, for trip tracking, ETAs, surge pricing and analytics.' },
    { id: 'eta', label: 'ETA / routing', sub: 'road graph', kind: 'service', icon: 'gauge', x: 3, y: 0, desc: 'Computes driving time on the road network (straight-line distance lies: rivers, one-way streets).' },
    { id: 'rider', label: 'Rider app', sub: 'Next.js PWA', kind: 'client', icon: 'phone', x: 0, y: 2, desc: 'Ana requests a ride from Place de l\'Université to Ottignies station.' },
    { id: 'trips', label: 'Trip service', sub: 'FastAPI', kind: 'service', x: 1, y: 2, desc: 'Owns the trip state machine: requested → offered → accepted → arriving → on_trip → completed.' },
    { id: 'match', label: 'Matcher', sub: 'Python workers', kind: 'worker', icon: 'cpu', x: 2, y: 1, desc: 'Finds candidates, ranks them by ETA, offers the trip to one driver at a time.' },
    { id: 'lock', label: 'Driver locks', sub: 'Redis', kind: 'cache', icon: 'lock', x: 3, y: 1, desc: 'SET NX with a TTL: the first matcher to lock a driver wins; others skip that driver.' },
    { id: 'db', label: 'Trips DB', sub: 'PostgreSQL', kind: 'db', x: 2, y: 2, desc: 'Durable trip records, fares and history.' }
  ],
  steps: [
    {
      from: 'driver', to: 'loc', label: 'ping every 4 s',
      title: 'Drivers stream their location',
      caption: 'Each online driver sends a small frame every 4 seconds over a WebSocket: position, heading, speed, accuracy and status.',
      text: ['At 250,000 pings a second, the write path must be lean: no database write per ping. The latest position goes to an in-memory index; the full history goes to a stream.', 'Phones batch and drop pings when the signal is weak; the server treats each ping as "latest known", not as a must-deliver event.'],
      payloadKind: 'WebSocket frame',
      payload: { t: 'loc', driver_id: 'drv_4471', lat: 50.66873, lng: 4.61182, heading: 212, speed_kmh: 18.4, accuracy_m: 6, status: 'available', ts: '2026-11-25T11:40:02.004Z' },
      fields: { accuracy_m: 'GPS accuracy. Pings worse than ~50 m are ignored for matching.', status: 'available | on_trip | offline. Only available drivers sit in the matching index.' }
    },
    {
      from: 'loc', to: 'geo', label: 'GEOADD drivers:lln',
      title: 'Update the geo index',
      caption: 'The location service writes the driver\'s position to the city\'s geo set and refreshes a heartbeat key. A driver whose heartbeat expires is removed from matching.',
      text: ['Redis stores GEO members in a sorted set whose score is a 52-bit {{geohash}}: nearby points have nearby scores, so a radius search becomes a few range scans. Uber built its own hexagonal grid (H3) for the same purpose with more even cell sizes.'],
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
GEOADD drivers:lln 4.61182 50.66873 drv_4471     -- note: longitude first
SET hb:drv_4471 1 EX 15                          -- 3 missed pings ⇒ stale

-- a sweeper removes members whose hb:* key has expired:
ZREM drivers:lln drv_9012`,
      code: [{ lang: 'python', title: 'Location ingest', src: String.raw`
async def on_ping(p: Ping):
    if p.accuracy_m > 50:
        return
    city = city_of(p.lat, p.lng)                       # precomputed polygons
    pipe = redis.pipeline(transaction=False)
    if p.status == "available":
        pipe.geoadd(f"drivers:{city}", (p.lng, p.lat, p.driver_id))
    else:
        pipe.zrem(f"drivers:{city}", p.driver_id)
    pipe.set(f"hb:{p.driver_id}", city, ex=15)
    pipe.hset(f"drv:{p.driver_id}", mapping={"lat": p.lat, "lng": p.lng, "ts": p.ts})
    await pipe.execute()
    producer.send_nowait("driver-locations", key=p.driver_id, value=p.model_dump_json())` }]
    },
    {
      from: 'loc', to: 'stream', label: 'publish ping', async: true,
      title: 'Pings go to the location stream',
      caption: 'Every ping is also published to Kafka, keyed by driver. Trip tracking, ETA models and surge pricing consume it independently.',
      payloadKind: 'Kafka record',
      payload: { topic: 'driver-locations', key: 'drv_4471', value: { lat: 50.66873, lng: 4.61182, heading: 212, speed_kmh: 18.4, ts: '2026-11-25T11:40:02.004Z' } },
      text: ['Surge pricing counts open requests and available drivers per hexagon over the last few minutes from this stream; it never queries the matching index.']
    },
    {
      from: 'rider', to: 'trips', label: 'POST /v1/trips',
      title: 'Ana requests a ride',
      caption: 'The request carries the pickup and destination, the product, and the fare quote she accepted. The trip is created in state requested.',
      text: ['The quote id ties the request to a price shown seconds earlier (with its surge multiplier), so the fare does not change between the screen and the request.'],
      payloadKind: 'HTTP request',
      payload: { method: 'POST', path: '/v1/trips', headers: { Authorization: 'Bearer eyJ…(sub=usr_ana)', 'Idempotency-Key': 'trp_req_1b7c…' }, body: { pickup: { lat: 50.66936, lng: 4.61204, label: 'Place de l\'Université' }, dropoff: { lat: 50.66915, lng: 4.58789, label: 'Gare d\'Ottignies' }, product: 'standard', quote_id: 'q_88f1', payment_method: 'pm_card_visa_4242' } }
    },
    {
      from: 'trips', to: 'match', label: 'match(trip_id)',
      title: 'The trip is handed to the matcher',
      caption: 'The trip service stores the trip and enqueues a matching job. Matching runs per city, so one busy city cannot slow another.',
      text: ['Jobs are partitioned by city so one matcher process owns a city\'s requests at a time. That keeps the candidate set small and makes batching possible: with many requests per second, the matcher can solve a small assignment problem every second instead of greedily matching one rider at a time.'],
      payloadKind: 'Job',
      payload: { trip_id: 'trp_01JDQB', city: 'lln', pickup: [4.61204, 50.66936], product: 'standard', attempt: 1, deadline: '2026-11-25T11:42:10Z' },
      fields: { deadline: 'If no driver accepts by then, Ana sees "No drivers available" and is not charged.' }
    },
    {
      from: 'match', to: 'geo', label: 'GEOSEARCH 2 km',
      title: 'Find nearby available drivers',
      caption: 'One GEOSEARCH returns the 20 nearest available drivers within 2 km of the pickup, sorted by straight-line distance.',
      text: ['If fewer than 3 candidates come back, the matcher widens the radius (2 → 4 → 6 km). Straight-line distance is only a pre-filter; ranking uses road ETA in the next step.'],
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
> GEOSEARCH drivers:lln FROMLONLAT 4.61204 50.66936 BYRADIUS 2 km ASC COUNT 20 WITHDIST
1) 1) "drv_4471"  2) "0.0751"
2) 1) "drv_2208"  2) "0.4130"
3) 1) "drv_7350"  2) "1.2207"
… (9 results)`
    },
    {
      from: 'match', to: 'eta', label: 'ETA for 9 candidates',
      title: 'Rank candidates by real driving time',
      caption: 'The routing service computes road ETAs from each candidate to the pickup in one batch call. The closest by air is not always the fastest: drv_4471 is 75 m away but on the other side of a pedestrian zone.',
      text: ['Routing engines precompute shortcuts on the road graph (contraction hierarchies) so a one-to-many ETA query takes milliseconds. Live traffic adjusts edge weights.', 'The score can include more than ETA: driver rating, acceptance rate, and how long the driver has been idle (fairness).'],
      payloadKind: 'ETA results',
      payload: [{ driver: 'drv_2208', air_km: 0.41, eta_s: 95 }, { driver: 'drv_4471', air_km: 0.08, eta_s: 240, note: 'pedestrian zone detour' }, { driver: 'drv_7350', air_km: 1.22, eta_s: 210 }]
    },
    {
      from: 'match', to: 'lock', label: 'SET lock NX EX 15',
      title: 'Lock the best driver before offering',
      caption: 'The matcher tries to lock drv_2208 with SET NX and a 15-second TTL. Another matcher handling a different rider nearby may want the same driver; only one SET succeeds.',
      text: ['Without this lock, two riders a few metres apart could both be offered the same driver at the same moment. The TTL means a crashed matcher never keeps a driver locked for long ({{lease}}).', 'If the lock fails, the matcher moves to the next candidate immediately.'],
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
> SET lock:drv_2208 trp_01JDQB NX EX 15
OK                                   -- we hold the driver for 15 s

(another matcher, same moment)
> SET lock:drv_2208 trp_01JDQC NX EX 15
(nil)                                -- taken: try the next candidate`,
      code: [{ lang: 'python', title: 'Offer loop', src: String.raw`
async def match(job: MatchJob):
    for radius in (2, 4, 6):
        cands = await redis.geosearch(f"drivers:{job.city}", longitude=job.pickup[0], latitude=job.pickup[1],
                                      radius=radius, unit="km", sort="ASC", count=20)
        if len(cands) >= 3:
            break
    ranked = sorted(await eta.batch(cands, job.pickup), key=lambda c: c.eta_s)
    for c in ranked:
        if not await redis.set(f"lock:{c.driver}", job.trip_id, nx=True, ex=15):
            continue                                         # someone else is offering this driver
        await trips.set_state(job.trip_id, "offered", driver=c.driver)
        answer = await offer(c.driver, job, timeout_s=12)    # waits for accept / decline / timeout
        if answer == "accept" and await trips.assign(job.trip_id, c.driver):
            return
        await release_lock(c.driver, job.trip_id)            # only if we still own it
    await trips.set_state(job.trip_id, "no_drivers")` }]
    },
    {
      from: 'match', to: 'driver', label: 'trip offer (12 s)',
      title: 'The driver gets an offer',
      caption: 'The offer goes down drv_2208\'s WebSocket (with a push as backup). The app shows the pickup, the estimated fare, and a 12-second countdown.',
      text: ['The offer is drawn going straight to the driver; in practice it travels down the driver\'s socket on [[loc]].'],
      payloadKind: 'WebSocket frame',
      payload: { t: 'offer', offer_id: 'off_5512', trip_id: 'trp_01JDQB', pickup: { label: 'Place de l\'Université', eta_s: 95 }, dropoff_area: 'Ottignies', est_fare: { amount: 11.40, currency: 'EUR' }, expires_at: '2026-11-25T11:40:21Z' },
      fields: { dropoff_area: 'Only the area, not the exact address, until accepted (protects riders and reduces cherry-picking).' },
      failure: ['**No answer in 12 s:** treated as a decline. The lock is released and the next candidate is offered. Repeated timeouts set the driver to "paused".']
    },
    {
      from: 'driver', to: 'trips', label: 'accept',
      title: 'The driver accepts; assignment is made durable',
      caption: 'The accept goes to the trip service, which assigns the driver in PostgreSQL with a guarded update and removes the driver from the available index.',
      text: ['The database update checks both sides: the trip must still be `offered` to this driver, and the driver must not be on another trip. Redis locks reduce races; the database constraint is the final guarantee.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
BEGIN;
UPDATE trips SET state = 'accepted', driver_id = 'drv_2208', accepted_at = now()
WHERE id = 'trp_01JDQB' AND state = 'offered' AND offered_driver = 'drv_2208';
-- unique partial index guarantees one active trip per driver:
-- CREATE UNIQUE INDEX one_active_trip ON trips (driver_id)
--   WHERE state IN ('accepted','arriving','on_trip');
COMMIT;
-- then: ZREM drivers:lln drv_2208 ; DEL lock:drv_2208`
    },
    {
      from: 'trips', to: 'rider', label: 'driver assigned + live position',
      title: 'Ana sees her driver coming',
      caption: 'Ana\'s app gets the driver, car and ETA. The trip service subscribes her to drv_2208\'s positions from the location stream, throttled to one update every 2 s.',
      payloadKind: 'Server push',
      payload: { t: 'trip.update', trip_id: 'trp_01JDQB', state: 'accepted', driver: { name: 'Karim', rating: 4.93, car: 'Toyota Corolla, grey', plate: '2-ABC-123' }, driver_pos: { lat: 50.67202, lng: 4.60911, heading: 140 }, eta_s: 95 },
      text: ['The app animates the car smoothly between updates (interpolation) so it does not jump every 2 seconds. Map tiles come from a CDN; only positions come from your servers.']
    },
    {
      from: 'trips', to: 'db', label: 'trip completed',
      title: 'The trip completes and is billed',
      caption: 'At drop-off the driver ends the trip. The fare is computed from the recorded route (from the stream), the trip is stored, and payment is captured against the saved card.',
      payloadKind: 'Trip record',
      payload: { id: 'trp_01JDQB', state: 'completed', rider: 'usr_ana', driver: 'drv_2208', distance_km: 3.1, duration_s: 512, fare: { base: 2.50, distance: 4.65, time: 2.56, surge: 1.0, total: 9.71, currency: 'EUR' }, route_polyline: 'qd~uHa`ib@…', payment: { status: 'captured', intent: 'pi_3QJA…' } },
      fields: { route_polyline: 'Encoded path, built from the driver\'s pings during the trip. Used for the receipt map and fare disputes.' },
      text: ['The fare (€9.71) is lower than the quote (€11.40) because the trip was faster than predicted; many services cap the fare at the quote and charge the lower of the two.']
    }
  ],
  api: [
    { verb: 'WS', path: '/driver/ws', desc: 'Driver pings up, offers and trip updates down.' },
    { verb: 'POST', path: '/v1/quotes', desc: 'Fare estimate for pickup/dropoff, with surge; valid a few minutes.' },
    { verb: 'POST', path: '/v1/trips', desc: 'Request a ride with a quote id.' },
    { verb: 'POST', path: '/v1/offers/{id}/accept', desc: 'Driver accepts (or /decline).' }
  ],
  schema: String.raw`
CREATE TABLE trips (
  id TEXT PRIMARY KEY, rider_id TEXT NOT NULL, driver_id TEXT, offered_driver TEXT,
  state TEXT NOT NULL,      -- requested|offered|accepted|arriving|on_trip|completed|cancelled|no_drivers
  pickup GEOGRAPHY(POINT), dropoff GEOGRAPHY(POINT),
  quote_id TEXT, fare_minor INT, created_at TIMESTAMPTZ DEFAULT now(), accepted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX one_active_trip ON trips (driver_id)
  WHERE state IN ('accepted','arriving','on_trip');

-- Redis
-- drivers:{city}  GEO set of available drivers
-- hb:{driver}     heartbeat, TTL 15 s
-- lock:{driver}   matcher lease, TTL 15 s`,
  decisions: [
    { q: 'How do you find nearby drivers?', options: [
      { verdict: 'bad', name: 'SELECT … ORDER BY distance in PostgreSQL on every request, with a write per ping', why: '250k writes/s into a relational table and a scan per request.' },
      { verdict: 'good', name: 'PostGIS with a GiST index', why: 'Correct and expressive, but the write rate is the problem, not the query.' },
      { verdict: 'great', name: 'In-memory geo index (Redis GEO or H3 cells) per city, history in a stream', why: 'Fast writes and millisecond radius queries.' }
    ] },
    { q: 'How do you stop double assignment?', options: [
      { verdict: 'bad', name: 'Check "is driver free?" then assign', why: 'Two matchers can both see "free" (a race).' },
      { verdict: 'great', name: 'Redis lease before offering + unique partial index in the DB', why: 'Fast exclusion, with a hard guarantee underneath.' }
    ] }
  ],
  refs: [
    { label: 'Redis: GEOSEARCH', url: 'https://redis.io/docs/latest/commands/geosearch/' },
    { label: 'Uber: H3, hexagonal hierarchical spatial index', url: 'https://www.uber.com/us/en/blog/h3/' },
    { label: 'PostgreSQL: Partial indexes', url: 'https://www.postgresql.org/docs/current/indexes-partial.html' }
  ]
});
