flow({
  id: 'stream-analytics',
  title: 'Real-time analytics: clickstream to live dashboard',
  category: 'Data at scale',
  tags: ['Event collection', 'Kafka partitions', 'Event-time windows', 'Watermarks', 'Exactly-once sinks', 'ClickHouse'],
  summary: 'A shop wants a live dashboard of views, add-to-carts and revenue per minute during a sale. Follow a click from the browser through a collector and Kafka into a stream job that counts by event-time windows, handles events that arrive late from a phone on a train, and writes results exactly once to a column store the dashboard queries.',
  requirements: {
    functional: [
      'Count page views, add-to-carts and orders per product per minute, live.',
      'Results are correct by the time the event happened, even when events arrive late.',
      'Analysts can query raw events afterwards for ad-hoc questions.'
    ],
    nonFunctional: [
      'Dashboard lag under 10 seconds from the click.',
      'Ingest 200,000 events per second at peak without dropping data.',
      'No double counting after a job restart.'
    ]
  },
  estimates: [
    { label: 'Events', value: '200,000 / s', note: 'Peak during a sale; ~17 billion per day.' },
    { label: 'Event size', value: '≈ 400 B', note: 'JSON before compression: 80 MB/s, about 15 MB/s compressed in Kafka.' },
    { label: 'Partitions', value: '96', note: 'Each partition comfortably handles ~2,000 events/s per consumer thread.' },
    { label: 'Late events', value: '≈ 1%', note: 'Mobile clients batching while offline; most arrive within 2 minutes.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'browser', label: 'Shop pages', sub: 'Next.js tracker', kind: 'client', icon: 'phone', x: 0, y: 0, desc: 'Sends events in batches with sendBeacon.' },
    { id: 'collector', label: 'Collector', sub: 'FastAPI', kind: 'edge', icon: 'download', x: 1, y: 0, desc: 'Validates, enriches and writes events to Kafka; nothing else.' },
    { id: 'kafka', label: 'events.raw', sub: 'Kafka, 96 partitions', kind: 'queue', x: 2, y: 0, desc: 'Durable buffer of every event, kept 7 days.' },
    { id: 'flink', label: 'Stream job', sub: 'Flink', kind: 'worker', icon: 'pulse', x: 2, y: 1, desc: 'Keyed by product, counts per event-time minute with watermarks.' },
    { id: 'state', label: 'Checkpoints', sub: 'RocksDB + S3', kind: 'storage', x: 3, y: 2, desc: 'Window state and Kafka offsets, snapshotted every 10 s.' },
    { id: 'ch', label: 'Column store', sub: 'ClickHouse', kind: 'db', icon: 'chart', x: 3, y: 1, desc: 'Per-minute aggregates for the dashboard, and raw events for analysts.' },
    { id: 'dash', label: 'Live dashboard', sub: 'Next.js', kind: 'client', icon: 'chart', x: 3, y: 0, desc: 'Charts refreshed every 5 seconds.' },
    { id: 'phone', label: 'Phone on a train', sub: 'mobile app', kind: 'client', icon: 'phone', x: 0, y: 2, desc: 'Buffers events while offline and sends them later.' },
    { id: 'lake', label: 'Raw archive', sub: 'S3 Parquet', kind: 'storage', x: 1, y: 2, desc: 'Every event, partitioned by date, for reprocessing and long-term analysis.' }
  ],
  steps: [
    {
      from: 'browser', to: 'collector', label: 'POST /e (batch)',
      title: 'The page sends a batch of events',
      caption: 'A shopper views a product and adds it to the cart. The tracker queues both events and sends them together with sendBeacon, which survives the page closing.',
      text: ['Each event has its own id (for deduplication) and the client\'s timestamp of when it happened: the {{event time}}. The server adds its own receive time too, because client clocks can be wrong.'],
      payloadKind: 'HTTP request',
      payload: { method: 'POST', path: '/e', body: { anon_id: 'a_7f3c19', session: 's_1764069', events: [{ id: 'ev_01JDQK0A', type: 'product_view', product: 'p_812', ts: '2026-11-25T11:41:43.120Z' }, { id: 'ev_01JDQK0B', type: 'add_to_cart', product: 'p_812', qty: 1, price_minor: 8900, ts: '2026-11-25T11:41:51.904Z' }] } },
      code: [{ lang: 'ts', title: 'Tracker (client)', src: String.raw`
const queue: TrackEvent[] = [];
export function track(type: string, props: Record<string, unknown>) {
  queue.push({ id: ulid(), type, ...props, ts: new Date().toISOString() });
  if (queue.length >= 20) flush();
}
export function flush() {
  if (!queue.length) return;
  const body = JSON.stringify({ anon_id: anonId(), session: sessionId(), events: queue.splice(0) });
  navigator.sendBeacon("/e", new Blob([body], { type: "application/json" }));
}
setInterval(flush, 5000);
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());` }]
    },
    {
      from: 'collector', to: 'kafka', label: 'produce (key = product)',
      title: 'Validate, enrich, produce to Kafka',
      caption: 'The collector checks the schema, drops bot traffic, adds server time and country from the IP, then produces each event to Kafka with the product id as key. It answers 204 as soon as Kafka acknowledges.',
      text: ['Keying by product puts all events of one product in the same partition, so the stream job can count it without shuffling data between machines.', 'The collector does nothing slow: no database, no joins. Its only job is to get events durably into Kafka fast.'],
      payloadKind: 'Kafka record',
      payload: { topic: 'events.raw', partition: 41, key: 'p_812', value: { id: 'ev_01JDQK0B', type: 'add_to_cart', product: 'p_812', qty: 1, price_minor: 8900, ts: '2026-11-25T11:41:51.904Z', recv_ts: '2026-11-25T11:41:52.030Z', country: 'BE', device: 'desktop', anon_id: 'a_7f3c19' }, producer: { acks: 'all', enable_idempotence: true, linger_ms: 5, compression: 'zstd' } },
      fields: { recv_ts: 'Server receive time. If the client clock is off by more than a few minutes, the job uses this instead.', acks: 'Wait for all in-sync replicas: an event acknowledged to the browser is never lost.' },
      code: [{ lang: 'python', title: 'Collector endpoint', src: String.raw`
producer = AIOKafkaProducer(bootstrap_servers=KAFKA, acks="all", enable_idempotence=True,
                            linger_ms=5, compression_type="zstd")

@app.post("/e", status_code=204)
async def collect(batch: EventBatch, req: Request):
    if is_bot(req.headers.get("user-agent", "")):
        return
    now = datetime.now(UTC)
    country = geoip(req.client.host)
    futs = []
    for ev in batch.events[:100]:
        rec = ev.model_dump() | {"recv_ts": now.isoformat(), "country": country,
                                 "anon_id": batch.anon_id}
        futs.append(await producer.send("events.raw", key=ev.product.encode(),
                                        value=orjson.dumps(rec)))
    await asyncio.gather(*futs)            # 204 only after Kafka acknowledged` }],
      failure: ['**Kafka slow or unavailable:** the collector buffers briefly in memory, then returns 503; the tracker keeps the batch and retries later. Events carry ids, so a retried batch is deduplicated downstream.']
    },
    {
      from: 'kafka', to: 'lake', label: 'archive to Parquet', async: true,
      title: 'Every event is archived',
      caption: 'A separate consumer group writes all raw events to S3 as Parquet files every 5 minutes, partitioned by date and hour. This is independent of the live job.',
      text: ['The archive makes the live pipeline replaceable: if a bug is found in the stream job, results can be recomputed from the raw events.'],
      payloadKind: 'Archive file',
      payload: { path: 's3://events-lake/raw/dt=2026-11-25/hr=11/part-0041-00017.parquet', rows: 612340, size_mb: 41.2, consumer_group: 'lake-writer' }
    },
    {
      from: 'kafka', to: 'flink', label: 'consume partition 41',
      title: 'The stream job reads by partition',
      caption: 'The Flink job has 96 parallel readers, one per partition. Each assigns events to one-minute windows by their event time, not by when they arrive.',
      text: ['A {{tumbling window}} of one minute: 11:41:00–11:42:00, then 11:42:00–11:43:00. The add-to-cart at 11:41:51 belongs to the 11:41 window whenever it arrives.'],
      payloadKind: 'Window assignment',
      payload: { event: 'ev_01JDQK0B', event_time: '11:41:51.904', window: '[11:41:00, 11:42:00)', key: 'p_812', window_state_before: { views: 1840, carts: 211, revenue_minor: 1877900 }, after: { views: 1840, carts: 212, revenue_minor: 1886800 } }
    },
    {
      from: 'flink', to: 'flink', label: 'watermark 11:42:05 - 30s',
      title: 'Watermarks decide when a minute is complete',
      caption: 'The job cannot know if more events for 11:41 will still come. A watermark says "no more events older than this are expected": the latest event time seen minus 30 seconds. When it passes 11:42:00, the 11:41 window is emitted.',
      text: ['A {{watermark}} trades latency for completeness. A 30 s delay means the dashboard number for a minute appears 30 s after the minute ends, but includes almost all slightly-late events.'],
      payloadKind: 'Watermark',
      payload: { max_event_time_seen: '11:42:31.200', allowed_out_of_orderness_s: 30, watermark: '11:42:01.200', windows_fired: ['[11:41:00, 11:42:00)'], emitted: { product: 'p_812', minute: '11:41', views: 1912, carts: 219, orders: 61, revenue_minor: 5428900 } },
      code: [{ lang: 'python', title: 'PyFlink job (excerpt)', src: String.raw`
wm = (WatermarkStrategy
      .for_bounded_out_of_orderness(Duration.of_seconds(30))
      .with_timestamp_assigner(EventTimeAssigner())       # ts, or recv_ts if skewed
      .with_idleness(Duration.of_seconds(60)))            # quiet partitions do not stall time

events = env.from_source(kafka_source("events.raw"), wm, "events")
per_min = (events
    .key_by(lambda e: e["product"])
    .window(TumblingEventTimeWindows.of(Time.minutes(1)))
    .allowed_lateness(Time.minutes(10))                   # late events update the result
    .side_output_late_data(TOO_LATE)
    .aggregate(Counts(), WindowResult()))
per_min.sink_to(clickhouse_sink("product_minute"))` }]
    },
    {
      from: 'flink', to: 'ch', label: 'INSERT product_minute',
      title: 'Write the minute to the column store',
      caption: 'The 11:41 result for p_812 is written to ClickHouse. The table keeps the latest version per (product, minute), so a later correction replaces the number instead of adding to it.',
      text: ['A ReplacingMergeTree table plus a version column makes the write idempotent: writing the same window twice (after a restart) leaves one row.'],
      payloadKind: 'SQL (ClickHouse)',
      payloadLang: 'sql',
      payload: String.raw`
INSERT INTO product_minute (product, minute, views, carts, orders, revenue_minor, version)
VALUES ('p_812', '2026-11-25 11:41:00', 1912, 219, 61, 5428900, 1);

-- table engine: ReplacingMergeTree(version) ORDER BY (product, minute)`
    },
    {
      from: 'phone', to: 'collector', label: 'late batch (2 min)',
      title: 'A late batch arrives from a train',
      caption: 'A phone that lost signal in a tunnel sends 14 events from 11:41, two minutes late. The 11:41 window already fired, but allowed lateness keeps its state for 10 minutes, so the count is updated.',
      text: ['Without event-time windows, these 14 events would be counted in the 11:43 minute, making 11:41 too low and 11:43 too high. With them, the right minute is corrected.', 'Events later than 10 minutes go to a side output and are only included in the nightly batch recomputation from the archive.'],
      payloadKind: 'Late update',
      payload: { events: 14, event_times: '11:41:05–11:41:58', arrived: '11:43:57', window: '[11:41:00, 11:42:00)', result: { carts: '219 → 221', views: '1912 → 1924' }, version: 2 }
    },
    {
      from: 'flink', to: 'state', label: 'checkpoint (offsets + state)',
      title: 'Checkpoint: offsets and window state together',
      caption: 'Every 10 seconds Flink snapshots the open windows and the Kafka offsets of every partition to S3, as one consistent checkpoint. Sink writes are committed with the same checkpoint.',
      text: ['This is how {{exactly-once}} works in practice: if the job crashes, it restarts from the last checkpoint, re-reads Kafka from the saved offsets, and rebuilds the same windows. Idempotent sink writes make the replayed output harmless.'],
      payloadKind: 'Checkpoint',
      payload: { checkpoint_id: 88213, duration_ms: 640, state_size_mb: 412, offsets: { 'events.raw-41': 1029384712, 'events.raw-42': 1029101998, '…': '94 more' }, location: 's3://flink-ckpt/clickstream/chk-88213' },
      failure: ['**TaskManager crashes:** Flink restarts the job from checkpoint 88213; up to 10 s of events are processed again, producing the same window results, which overwrite identical rows.']
    },
    {
      from: 'dash', to: 'ch', label: 'SELECT last 30 min',
      title: 'The dashboard queries the last half hour',
      caption: 'Every 5 seconds, the dashboard asks ClickHouse for the last 30 minutes of totals and top products. FINAL collapses corrected rows to their latest version. The query scans a few thousand rows in milliseconds.',
      text: ['A column store reads only the columns a query uses and keeps them compressed, which is why aggregating thousands of rows takes milliseconds. Raw events stay queryable in `events_raw` for ad-hoc analysis.'],
      payloadKind: 'SQL (ClickHouse)',
      payloadLang: 'sql',
      payload: String.raw`
SELECT minute, sum(views) AS views, sum(carts) AS carts,
       sum(orders) AS orders, sum(revenue_minor) / 100 AS revenue_eur
FROM product_minute FINAL
WHERE minute >= now() - INTERVAL 30 MINUTE
GROUP BY minute ORDER BY minute;

-- 30 rows in set. Elapsed: 0.012 sec. Processed 41,220 rows.`,
      code: [{ lang: 'ts', title: 'Dashboard data (route handler)', src: String.raw`
// app/api/live/route.ts
export const dynamic = "force-dynamic";
export async function GET() {
  const rows = await clickhouse.query({ query: LAST_30_MIN, format: "JSONEachRow" }).then(r => r.json());
  return Response.json(rows, { headers: { "Cache-Control": "private, max-age=5" } });
}` }]
    },
    {
      from: 'ch', to: 'dash', label: 'chart update', reply: true,
      title: 'The chart moves',
      caption: 'The revenue line extends by one point and the 11:41 bar grows slightly as the late events are included. From click to chart: about 35 seconds, mostly the deliberate watermark delay.',
      text: ['The dashboard shades the most recent minute as "still settling", because late events can still change it for a few minutes.'],
      payloadKind: 'Chart data',
      payload: [{ minute: '11:40', views: 182400, carts: 20110, orders: 5822, revenue_eur: 512340 }, { minute: '11:41', views: 190210, carts: 21004, orders: 6040, revenue_eur: 533910, settling: true }]
    }
  ],
  api: [
    { verb: 'POST', path: '/e', desc: 'Event collector; batches of up to 100 events; 204 when durable.' },
    { verb: 'GET', path: '/api/live', desc: 'Last 30 minutes of per-minute totals for the dashboard.' }
  ],
  schema: String.raw`
-- ClickHouse
CREATE TABLE product_minute (
  product String, minute DateTime,
  views UInt64, carts UInt64, orders UInt64, revenue_minor UInt64,
  version UInt32
) ENGINE = ReplacingMergeTree(version)
PARTITION BY toDate(minute) ORDER BY (product, minute) TTL minute + INTERVAL 90 DAY;

CREATE TABLE events_raw (
  id String, type LowCardinality(String), product String, ts DateTime64(3),
  recv_ts DateTime64(3), country LowCardinality(String), anon_id String, props String
) ENGINE = MergeTree PARTITION BY toDate(ts) ORDER BY (type, ts);`,
  decisions: [
    { q: 'Which time do you count by?', options: [
      { verdict: 'bad', name: 'Processing time (when the job sees the event)', why: 'Restarts and late batches shift counts into the wrong minutes.' },
      { verdict: 'great', name: 'Event time with watermarks and allowed lateness', why: 'Each event counts in the minute it happened, and late data corrects the result.' }
    ] },
    { q: 'How do you avoid double counting?', options: [
      { verdict: 'ok', name: 'At-least-once and accept small errors', why: 'Fine for rough trends, wrong for revenue.' },
      { verdict: 'great', name: 'Checkpointed offsets + state, idempotent upserts in the sink', why: 'Replays after a crash produce identical rows.' }
    ] }
  ],
  refs: [
    { label: 'Apache Flink: Timely stream processing (event time, watermarks)', url: 'https://nightlies.apache.org/flink/flink-docs-stable/docs/concepts/time/' },
    { label: 'Tyler Akidau: Streaming 101', url: 'https://www.oreilly.com/radar/the-world-beyond-batch-streaming-101/' },
    { label: 'ClickHouse: ReplacingMergeTree', url: 'https://clickhouse.com/docs/engines/table-engines/mergetree-family/replacingmergetree' }
  ]
});
