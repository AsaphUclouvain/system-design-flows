flow({
  id: 'ad-click-aggregation',
  title: 'Ad click event aggregation',
  category: 'Data at scale',
  tags: ['Click log to Kafka', 'Event-time windows', 'Watermarks / late events', 'Deduplication', 'Exactly-once sinks', 'Batch reconciliation', 'Top-N ads'],
  summary: 'Advertisers are billed per click, so click counts must be correct, not just fast. Clicks flow into a log, a stream job deduplicates them and counts per ad per minute using the time the click happened, results go to an OLAP store for dashboards, and a nightly batch job recomputes from the raw log to catch any drift. Follow a click, a duplicate, and a late event.',
  requirements: {
    functional: ['Count clicks per ad per minute; return the last M minutes for an ad.', 'Top 100 most-clicked ads in the last minute.', 'Filter by country, device, etc.'],
    nonFunctional: ['Correct counts: billing depends on them.', 'Dashboards a few minutes behind real time at most.', 'Handle duplicates and late events.']
  },
  estimates: ['Illustrative: 1 billion clicks/day ≈ 11.6 k/s average, peaks of ~5×.'],
  grid: { cols: 5, rows: 3 },
  nodes: [
    { id: 'user', label: 'User clicks an ad', sub: 'browser', kind: 'client', icon: 'browser', x: 0, y: 1, desc: 'Clicks a sponsored link; the click goes through a redirect that records it.' },
    { id: 'track', label: 'Click tracker', sub: 'redirect + log', kind: 'service', icon: 'server', x: 1, y: 1, desc: 'Logs the click with a unique click_id and redirects to the advertiser.' },
    { id: 'kafka', label: 'Raw click log', sub: 'Kafka topic', kind: 'queue', icon: 'log', x: 2, y: 1, desc: 'Immutable record of every click; also archived to object storage for replay.' },
    { id: 'flink', label: 'Stream aggregator', sub: 'Flink job', kind: 'worker', icon: 'cpu', x: 3, y: 1, desc: 'Deduplicates by click_id, counts per (ad, minute) by event time, and computes the top 100.' },
    { id: 'olap', label: 'Aggregates DB', sub: 'OLAP (Druid / ClickHouse)', kind: 'db', icon: 'chart', x: 4, y: 1, desc: 'Stores per-minute counts with filter columns; serves dashboards and billing queries.' },
    { id: 'batch', label: 'Nightly batch', sub: 'Spark on archive', kind: 'worker', icon: 'clock', x: 3, y: 2, desc: 'Recomputes yesterday\'s counts from the raw archive and compares with the stream results.' },
    { id: 'adv', label: 'Advertiser dashboard', sub: 'reads aggregates', kind: 'client', icon: 'laptop', x: 4, y: 0, desc: 'Shows clicks per minute and spend.' }
  ],
  pseudo: `
kafka.produce("clicks", key=ad_id, {click_id, ad_id, ts_event, country})
stream = read("clicks").assign_watermark(ts_event - 30s)
dedup: keep first row per click_id (ROW_NUMBER() = 1)
counts = TUMBLE(ts_event, 1 min) GROUP BY ad_id, country -> count(*)
top100 = counts per window ORDER BY count DESC LIMIT 100
events later than watermark + allowed_lateness -> side output for batch
sink to OLAP with exactly-once (checkpoint + transactional/upsert writes)
nightly: batch_counts = recompute(archive); diff vs stream; fix + alert`,
  steps: [
    {
      from: 'user', to: 'track', label: 'GET /c?ad=ad_7781 → 302', pc: ['kafka.produce'],
      title: 'A click is recorded and redirected',
      caption: 'The tracker gives the click a unique id and records the time on the user\'s side of the event, then sends the user on to the advertiser.',
      text: [],
      payloadKind: 'Click event',
      payload: { click_id: 'c_01JDXK7Q', ad_id: 'ad_7781', ts_event: '2026-11-26T15:31:07.420Z', country: 'BE', device: 'mobile', ip_hash: 'a3f…' }
    },
    {
      from: 'track', to: 'kafka', label: 'produce clicks key=ad_7781', pc: ['kafka.produce'],
      title: 'Append to the raw log',
      caption: 'The raw log is the source of truth. Everything downstream can be recomputed from it.',
      text: [],
      payloadKind: 'Kafka record',
      payload: { topic: 'clicks', partition: 17, offset: 9921043, key: 'ad_7781' }
    },
    {
      from: 'kafka', to: 'flink', label: 'consume, watermark = max ts − 30 s', pc: ['assign_watermark', 'dedup: keep first row'],
      title: 'Deduplicate by click_id',
      caption: 'Retries and double-clicks produce the same click_id twice. The job keeps only the first row per click_id (Flink SQL\'s deduplication pattern with ROW_NUMBER).',
      text: [],
      payloadKind: 'Dedup state',
      payload: { click_id: 'c_01JDXK7Q', seen_before: false },
      branch: { q: 'Seen this click_id before?', options: [ { label: 'no: count it', goto: 'count' }, { label: 'yes: drop the duplicate', goto: 'dup' } ] }
    },
    {
      id: 'dup', path: 'dup', from: 'flink', to: 'flink', label: 'c_01JDXK7Q again (retry) → dropped', pc: ['dedup: keep first row'],
      title: 'Other outcome: a duplicate',
      caption: 'The tracker retried after a timeout and the same click arrived twice. It is dropped; the advertiser is not billed twice.',
      text: [],
      payloadKind: 'Dropped',
      payload: { click_id: 'c_01JDXK7Q', reason: 'duplicate', counted: false },
      next: 'late'
    },
    {
      id: 'count', from: 'flink', to: 'flink', label: 'window 15:31–15:32 ad_7781 BE += 1', pc: ['counts = TUMBLE', 'top100 ='],
      title: 'Count in one-minute event-time windows',
      caption: 'The click goes into the 15:31 window because that is when it happened, not when it arrived. When the watermark passes 15:32, the window closes and emits its counts plus the top 100.',
      text: [],
      payloadKind: 'Window result',
      payload: { window: '15:31:00–15:32:00', ad_id: 'ad_7781', country: 'BE', clicks: 412, top100_rank: 37 }
    },
    {
      id: 'late', path: 'late', from: 'kafka', to: 'flink', label: 'click from 15:24 arrives at 15:33 (phone was offline)', pc: ['events later than watermark'],
      title: 'Other outcome: a late event',
      caption: 'The window for 15:24 already closed. Small lateness can update the window; very late events go to a side output and the nightly batch includes them.',
      text: [],
      payloadKind: 'Late event',
      payload: { click_id: 'c_01JDXH2M', ts_event: '15:24:51', arrived: '15:33:10', handled_by: 'side output → batch' }
    },
    {
      from: 'flink', to: 'olap', label: 'upsert (ad_7781, 15:31, BE) = 412', pc: ['sink to OLAP with exactly-once'],
      title: 'Write aggregates exactly once',
      caption: 'Flink checkpoints its state and Kafka offsets together. Writes are idempotent upserts keyed by (ad, minute, filters), so a replay after a crash overwrites instead of double-counting.',
      text: [],
      payloadKind: 'Aggregate row',
      payload: { ad_id: 'ad_7781', minute: '2026-11-26T15:31Z', country: 'BE', device: 'mobile', clicks: 412 }
    },
    {
      from: 'adv', to: 'olap', label: 'clicks ad_7781 last 30 min', pc: ['sink to OLAP'],
      title: 'The advertiser sees it',
      caption: 'The dashboard query reads 30 pre-aggregated rows instead of scanning raw clicks.',
      text: [],
      payloadKind: 'Query',
      payload: { ad_id: 'ad_7781', from: '15:02', to: '15:32', total_clicks: 11840 }
    },
    {
      from: 'batch', to: 'olap', label: 'nightly diff: stream 1 000 214 vs batch 1 000 397', pc: ['nightly:'],
      title: 'Reconcile with a nightly batch',
      caption: 'A batch job recomputes yesterday from the raw archive, including very late events. Differences are corrected and, above a threshold, raise an alert. This is what makes the numbers billable.',
      text: [],
      payloadKind: 'Reconciliation',
      payload: { date: '2026-11-25', ad_id: 'ad_7781', stream: 1000214, batch: 1000397, diff: 183, action: 'overwrite with batch' }
    }
  ],
  decisions: [
    { q: 'Event time or processing time?', options: [
      { name: 'Event time + watermark', verdict: 'good', why: 'Counts land in the right minute even with delays and replays.' },
      { name: 'Processing time', verdict: 'bad', why: 'A backlog or replay moves clicks into the wrong minute.' } ] },
    { q: 'Stream only, or stream + batch?', options: [
      { name: 'Stream for speed + batch for correctness', verdict: 'good', why: 'Fast dashboards and an auditable daily number.' },
      { name: 'Stream only', verdict: 'ok', why: 'Simpler (Kappa), but needs perfect exactly-once and late-data handling.' } ] }
  ],
  refs: [
    { label: 'Apache Flink docs: Deduplication (SQL)', url: 'https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/table/sql/queries/deduplication/' },
    { label: 'Apache Flink docs: Windowing table-valued functions (TUMBLE)', url: 'https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/dev/table/sql/queries/window-tvf/' },
    { label: 'Apache Flink docs: Timely stream processing (event time, watermarks)', url: 'https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/concepts/time/' },
    { label: 'ByteByteGo: System Design Interview Vol. 2, chapter "Ad Click Event Aggregation" (book)', url: 'https://bytebytego.com/courses/system-design-interview/ad-click-event-aggregation' }
  ],
  verify: {
    checked: ['Deduplication with ROW_NUMBER keeping the first row: Flink deduplication docs.', 'TUMBLE windows: Flink window TVF docs.', 'Event time and watermarks: Flink timely stream processing docs.'],
    uncertain: ['Click volumes, counts and the reconciliation diff are illustrative.', 'The exact sink strategy (upsert vs two-phase commit) depends on the OLAP store.']
  }
});
