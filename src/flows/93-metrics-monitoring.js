flow({
  id: 'metrics-monitoring',
  title: 'Metrics monitoring and alerting (Prometheus-style)',
  category: 'Infrastructure foundations',
  tags: ['Pull (scrape) model', 'Time-series DB', 'WAL + 2 h blocks', 'Compression', 'Downsampling', 'Alert rules', 'Grouping / silences'],
  summary: 'Every service exposes counters like http_requests_total. A collector scrapes them every 15 s, stores them in a time-series database built for append-heavy numbers, evaluates alert rules, and pages someone when a rule stays true. Follow one scrape, a firing alert, and the downsampling that keeps a year of data cheap.',
  requirements: {
    functional: ['Collect metrics from thousands of hosts.', 'Query them for dashboards (rates, percentiles).', 'Alert on rules and route alerts to the right team.'],
    nonFunctional: ['Writes vastly outnumber reads.', 'Recent data is queried most; old data can be lower resolution.', 'Monitoring must stay up when the system it watches is down.']
  },
  estimates: ['Illustrative: 5 000 hosts × 1 000 series × 1 sample / 15 s ≈ 333 k samples/s.'],
  grid: { cols: 5, rows: 3 },
  nodes: [
    { id: 'svc', label: 'Checkout service', sub: '/metrics endpoint', kind: 'service', icon: 'server', x: 0, y: 1, desc: 'Keeps counters and histograms in memory and prints them as text on GET /metrics.' },
    { id: 'disc', label: 'Service discovery', sub: 'Kubernetes / Consul', kind: 'service', icon: 'search', x: 1, y: 0, desc: 'Tells the collector which targets exist right now.' },
    { id: 'prom', label: 'Collector', sub: 'Prometheus server', kind: 'worker', icon: 'pulse', x: 1, y: 1, desc: 'Scrapes targets on a schedule, writes samples, evaluates rules.' },
    { id: 'tsdb', label: 'Time-series DB', sub: 'WAL + blocks', kind: 'db', icon: 'chart', x: 2, y: 1, desc: 'Recent samples in memory and a write-ahead log; every 2 hours they are compacted into an immutable block on disk.' },
    { id: 'long', label: 'Long-term store', sub: 'object storage', kind: 'storage', icon: 'storage', x: 3, y: 2, desc: 'Old blocks uploaded to cheap object storage and downsampled (e.g. Thanos).' },
    { id: 'alert', label: 'Alertmanager', sub: 'group, dedupe, route', kind: 'service', icon: 'bell', x: 3, y: 0, desc: 'Groups related alerts, removes duplicates, applies silences, routes to the right receiver.' },
    { id: 'oncall', label: 'On-call engineer', sub: 'pager / Slack', kind: 'client', icon: 'phone', x: 4, y: 0, desc: 'Gets one page for the incident, not 200.' },
    { id: 'dash', label: 'Dashboard', sub: 'Grafana', kind: 'client', icon: 'laptop', x: 2, y: 2, desc: 'Runs queries like rate() and histogram_quantile() over a time range.' }
  ],
  pseudo: `
targets = discovery.list(job="checkout")
every 15s: samples = http_get(target + "/metrics")
tsdb.append(samples)          # WAL first, then in-memory head
every 2h: compact head -> immutable block; later upload + downsample (5m, 1h)
rule: rate(http_requests_total{code=~"5.."}[5m]) / rate(http_requests_total[5m]) > 0.05 for 10m
if rule true for 10m: alertmanager.send(alert)
alertmanager: group_by [service], wait 30s, apply silences, route -> pager`,
  steps: [
    {
      from: 'prom', to: 'disc', label: 'list targets job=checkout → 12 pods', pc: ['targets = discovery.list'],
      title: 'Find what to scrape',
      caption: 'Pods come and go. The collector asks service discovery for the current list instead of using a fixed config.',
      text: [],
      payloadKind: 'Targets',
      payload: { job: 'checkout', targets: ['10.2.0.14:9100', '10.2.0.15:9100', '…'], count: 12 }
    },
    {
      from: 'prom', to: 'svc', label: 'GET /metrics (every 15 s)', pc: ['every 15s'],
      title: 'Scrape: the collector pulls',
      caption: 'In the pull model the collector decides the pace, and a target that stops answering is itself a signal (up = 0). Short batch jobs that cannot be scraped push to a gateway instead.',
      text: [],
      payloadKind: 'Scrape response (text format)',
      payload: { body: 'http_requests_total{code="200",route="/pay"} 1027331\nhttp_requests_total{code="500",route="/pay"} 6120\nhttp_request_duration_seconds_bucket{le="0.25"} 990120', series: 1043 }
    },
    {
      from: 'prom', to: 'tsdb', label: 'append 1 043 samples @ 15:20:15', pc: ['tsdb.append'],
      title: 'Write to the time-series DB',
      caption: 'Each series is a metric name plus labels. Samples are (timestamp, float). They go to a write-ahead log for crash safety, then to an in-memory head block.',
      text: ['Facebook\'s Gorilla paper showed how timestamps and values compress very well with delta-of-delta and XOR encoding, about 1.37 bytes per sample instead of 16. Prometheus uses a similar approach.'],
      payloadKind: 'Samples',
      payload: { series: 'http_requests_total{code="500",route="/pay",pod="checkout-7"}', ts: 1764170415000, value: 6120 }
    },
    {
      from: 'tsdb', to: 'long', label: 'block 13:00–15:00 → object store', pc: ['every 2h'],
      title: 'Compact and ship old data',
      caption: 'Every 2 hours the head becomes an immutable block with an index. Long-term setups upload blocks to object storage and downsample them to 5-minute and 1-hour resolution for year-long dashboards.',
      text: [],
      payloadKind: 'Block',
      payload: { block: '01JDX…', range: '13:00–15:00', samples: 2400000000, size_mb: 3100, downsampled: ['5m', '1h'] }
    },
    {
      from: 'prom', to: 'prom', label: 'error ratio /pay = 7.8% (>5%)', pc: ['rule: rate'],
      title: 'Evaluate the alert rule',
      caption: 'Every evaluation interval the collector runs the rule query. 5xx share on /pay is 7.8%, above 5%. The alert becomes "pending" until it has been true for 10 minutes, so short blips do not page anyone.',
      text: [],
      payloadKind: 'Rule result',
      payload: { alert: 'CheckoutHighErrorRate', value: 0.078, state: 'pending', for: '10m' },
      branch: { q: 'Still true after 10 minutes?', options: [ { label: 'yes: fire', goto: 'fire' }, { label: 'no: resolves, nobody paged', goto: 'dash1' } ] }
    },
    {
      id: 'fire', from: 'prom', to: 'alert', label: 'FIRING CheckoutHighErrorRate × 12 pods', pc: ['alertmanager.send'],
      title: 'Fire: send to Alertmanager',
      caption: 'Twelve pods each produce an alert. Alertmanager groups them by service, waits 30 s for more to arrive, and checks silences (none: no maintenance window).',
      text: [],
      payloadKind: 'Alerts',
      payload: { labels: { alertname: 'CheckoutHighErrorRate', service: 'checkout', severity: 'page' }, count: 12, group_wait: '30s', silenced: false }
    },
    {
      from: 'alert', to: 'oncall', label: '1 page: checkout 5xx 7.8% for 10 min', pc: ['route -> pager'],
      title: 'One page reaches the right person',
      caption: 'The route for severity=page sends it to the checkout team\'s pager with a link to the dashboard and runbook.',
      text: [],
      payloadKind: 'Notification',
      payload: { receiver: 'checkout-pager', summary: 'Checkout 5xx rate 7.8% (>5%) for 10m', runbook: 'wiki/runbooks/checkout-5xx', grouped_alerts: 12 }
    },
    {
      id: 'dash1', from: 'dash', to: 'tsdb', label: 'histogram_quantile(0.99, …[5m])', pc: ['tsdb.append'],
      title: 'Dashboards read the same data',
      caption: 'The engineer opens Grafana: p99 latency and error rate over the last 6 hours, computed from the stored histograms and counters.',
      text: [],
      payloadKind: 'Query',
      payload: { query: 'histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{job="checkout"}[5m])))', range: '6h', step: '30s', p99_s: 1.84 }
    }
  ],
  decisions: [
    { q: 'Pull or push?', options: [
      { name: 'Pull (scrape)', verdict: 'good', why: 'Collector controls load; missing target is visible; easy to scrape by hand when debugging.' },
      { name: 'Push', verdict: 'ok', why: 'Better for short-lived jobs and across firewalls; needs auth and back-pressure on the receiver.' } ] },
    { q: 'General DB or TSDB?', options: [
      { name: 'Purpose-built TSDB', verdict: 'good', why: 'Append-only, compressed, time-range queries and retention built in.' },
      { name: 'Relational table', verdict: 'bad', why: 'Hundreds of thousands of inserts/s and rollups become painful.' } ] }
  ],
  refs: [
    { label: 'Prometheus docs: Overview (pull model, Pushgateway)', url: 'https://prometheus.io/docs/introduction/overview/' },
    { label: 'Prometheus docs: Storage (WAL, 2-hour blocks, compaction)', url: 'https://prometheus.io/docs/prometheus/latest/storage/' },
    { label: 'Prometheus docs: Alertmanager (grouping, inhibition, silences)', url: 'https://prometheus.io/docs/alerting/latest/alertmanager/' },
    { label: 'Pelkonen et al., Gorilla: A Fast, Scalable, In-Memory Time Series Database (VLDB 2015)', url: 'https://www.vldb.org/pvldb/vol8/p1816-teller.pdf' },
    { label: 'Thanos docs: Compactor and downsampling', url: 'https://thanos.io/tip/components/compact.md/' },
    { label: 'ByteByteGo: System Design Interview Vol. 2, chapter "Metrics Monitoring and Alerting System" (book)', url: 'https://bytebytego.com/courses/system-design-interview/metrics-monitoring-and-alerting-system' }
  ],
  verify: {
    checked: ['Pull model and Pushgateway for short jobs: Prometheus overview.', 'WAL and 2-hour blocks: Prometheus storage docs.', 'Grouping, silences, routing: Alertmanager docs.', '1.37 bytes per point: Gorilla paper.', '5m and 1h downsampling: Thanos compactor docs.'],
    uncertain: ['Host counts, values, the 5% threshold and block sizes are illustrative.']
  }
});
