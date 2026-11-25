flow({
  id: 'observability-pipeline',
  title: 'Metrics, logs and traces pipeline',
  category: 'Data at scale',
  tags: ['OpenTelemetry', 'Prometheus', 'Structured logs', 'Tail sampling', 'SLO burn-rate alerts'],
  summary: 'A checkout request gets slow. Follow how one FastAPI request produces a trace, a log line and metric samples, how a collector batches, samples and routes them, and how an SLO burn-rate alert pages the on-call engineer, who jumps from the alert to the exact slow trace and its logs.',
  requirements: {
    functional: [
      'Every service emits metrics, structured logs and traces with shared ids.',
      'Engineers can go from an alert to the slow requests and their logs in a few clicks.',
      'Alerts fire on user-visible symptoms (SLOs), not on every CPU spike.'
    ],
    nonFunctional: [
      'Telemetry never slows down or breaks the request path.',
      'Keep 100% of error and slow traces, but only a few percent of normal ones, to control cost.',
      'Alert within 5 minutes of a serious SLO breach.'
    ]
  },
  estimates: [
    { label: 'Requests', value: '20,000 / s', note: 'Across all services.' },
    { label: 'Spans', value: '≈ 300,000 / s', note: '~15 spans per request before sampling; ~6% kept after tail sampling.' },
    { label: 'Log lines', value: '≈ 120,000 / s', note: 'About 60 MB/s raw JSON; compressed ~8× in storage.' },
    { label: 'Active series', value: '≈ 2 million', note: 'Kept under control by banning high-cardinality labels like user id.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'svc', label: 'Checkout API', sub: 'FastAPI + OTel SDK', kind: 'service', x: 0, y: 1, desc: 'Instrumented automatically (HTTP, SQL, Redis) plus a few business spans.' },
    { id: 'col', label: 'OTel Collector', sub: 'agent + gateway', kind: 'worker', icon: 'pulse', x: 1, y: 1, desc: 'Receives all telemetry, batches it, samples traces, adds metadata and routes each signal to its store.' },
    { id: 'prom', label: 'Metrics store', sub: 'Prometheus / Mimir', kind: 'db', icon: 'chart', x: 2, y: 0, desc: 'Time series: counters and histograms with labels.' },
    { id: 'logs', label: 'Log store', sub: 'Loki', kind: 'db', x: 2, y: 1, desc: 'Structured logs indexed by a few labels, searchable by trace id.' },
    { id: 'traces', label: 'Trace store', sub: 'Tempo / Jaeger', kind: 'db', x: 2, y: 2, desc: 'Spans grouped by trace id.' },
    { id: 'alert', label: 'Alert rules', sub: 'Alertmanager', kind: 'service', icon: 'bell', x: 3, y: 0, desc: 'Evaluates SLO burn-rate rules and routes alerts.' },
    { id: 'oncall', label: 'On-call engineer', sub: 'PagerDuty', kind: 'client', icon: 'user', x: 3, y: 1, desc: 'Gets paged and investigates.' },
    { id: 'graf', label: 'Dashboards', sub: 'Grafana', kind: 'client', icon: 'chart', x: 3, y: 2, desc: 'Graphs with exemplars linking to traces, and trace-to-logs links.' }
  ],
  steps: [
    {
      from: 'svc', to: 'svc', label: 'request → spans',
      title: 'One request produces a trace',
      caption: 'A checkout request enters the API. The OpenTelemetry middleware starts a root span, reads or creates the trace context, and every HTTP, SQL and Redis call inside becomes a child span.',
      text: ['A trace is a tree of spans sharing one trace id. The id travels between services in the `traceparent` header ({{trace context}}), so the payments service\'s spans join the same tree.', 'Here the SQL span for the inventory query took 1.84 s of a 2.1 s request: that is what the engineer will find later.'],
      payloadKind: 'Spans (simplified)',
      payload: { trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', spans: [{ span_id: '00f067aa0ba902b7', name: 'POST /v1/checkout', duration_ms: 2104, status: 'OK', attrs: { 'http.route': '/v1/checkout', 'http.status_code': 200 } }, { span_id: 'a1b2c3d4e5f60718', parent: '00f067aa0ba902b7', name: 'SELECT inventory', duration_ms: 1840, attrs: { 'db.system': 'postgresql', 'db.statement': 'SELECT … FROM stock WHERE sku = ANY($1) FOR UPDATE' } }, { span_id: 'b2c3d4e5f6071829', parent: '00f067aa0ba902b7', name: 'POST payments/charge', duration_ms: 212 }] },
      code: [{ lang: 'python', title: 'Instrument FastAPI', src: String.raw`
from opentelemetry import trace
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.asyncpg import AsyncPGInstrumentor
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

provider = TracerProvider(resource=Resource.create({"service.name": "checkout-api",
                                                    "deployment.environment": "prod"}))
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint="localhost:4317"),
                                               max_queue_size=8192))   # drops, never blocks
trace.set_tracer_provider(provider)
FastAPIInstrumentor.instrument_app(app)
AsyncPGInstrumentor().instrument()

tracer = trace.get_tracer("checkout")

@app.post("/v1/checkout")
async def checkout(body: CheckoutIn):
    with tracer.start_as_current_span("reserve_and_charge") as sp:
        sp.set_attribute("cart.items", len(body.items))       # low-cardinality only
        ...` }]
    },
    {
      from: 'svc', to: 'svc', label: 'log + metrics',
      title: 'The same request writes a log line and metric samples',
      caption: 'The handler logs one structured JSON line that includes the trace id, and the middleware records the duration in a histogram. Three signals, joined by the trace id.',
      text: ['Logs are JSON, not free text, so they can be filtered by field. Putting `trace_id` in every line is what makes "show me the logs of this trace" possible.', 'Metric labels must have few values. `route` and `status` are fine; `user_id` would create a time series per user and overwhelm the metrics store.'],
      payloadKind: 'Log line + metric',
      payload: { log: { ts: '2026-11-25T11:41:43.902Z', level: 'warning', service: 'checkout-api', msg: 'slow inventory lock', trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', span_id: 'a1b2c3d4e5f60718', order_id: 'ord_7731', wait_ms: 1840 }, metric: { name: 'http_server_duration_seconds', type: 'histogram', labels: { route: '/v1/checkout', method: 'POST', status: '200' }, observed: 2.104, bucket: 'le="2.5"', exemplar: { trace_id: '4bf92f3577b34da6a3ce929d0e0e4736' } } },
      fields: { exemplar: 'A sample trace id attached to a histogram bucket. On a latency graph you can click a dot and open that exact trace.' },
      code: [{ lang: 'python', title: 'JSON logs with trace ids', src: String.raw`
import structlog
from opentelemetry import trace

def add_trace(_, __, ev):
    ctx = trace.get_current_span().get_span_context()
    if ctx.is_valid:
        ev["trace_id"] = format(ctx.trace_id, "032x")
        ev["span_id"] = format(ctx.span_id, "016x")
    return ev

structlog.configure(processors=[structlog.processors.TimeStamper(fmt="iso"),
                                add_trace, structlog.processors.JSONRenderer()])
log = structlog.get_logger(service="checkout-api")
log.warning("slow inventory lock", order_id=oid, wait_ms=waited)` }]
    },
    {
      from: 'svc', to: 'col', label: 'OTLP/gRPC (batched)', async: true,
      title: 'Ship telemetry without slowing the request',
      caption: 'The SDK queues spans in memory and exports them in batches every second to a collector agent on the same node. If the collector is slow, the queue drops data instead of blocking requests.',
      text: ['This is the rule of observability plumbing: losing some telemetry is acceptable, slowing down users is not. Drops are counted in a metric so you know when it happens.'],
      payloadKind: 'OTLP export',
      payload: { endpoint: 'localhost:4317', protocol: 'OTLP/gRPC', batch: { spans: 512, bytes_compressed: 41820 }, queue: { size: 8192, used: 640, dropped_total: 0 }, every_ms: 1000 },
      failure: ['**Collector down:** the SDK retries briefly, then drops; `otel_exporter_dropped_spans_total` rises and has its own alert.']
    },
    {
      from: 'col', to: 'col', label: 'tail sampling',
      title: 'Decide which traces to keep',
      caption: 'The collector gateway waits about 10 s for all spans of a trace to arrive, then decides: keep every trace with an error or slower than 1 s, and 5% of the rest. This slow trace is kept.',
      text: ['With {{tail sampling}} the decision is made after seeing the whole trace. Head sampling (deciding at the first span) is cheaper but throws away most of the interesting slow and failed requests.', 'All spans of one trace must reach the same gateway instance, so agents route by trace id with consistent hashing.'],
      payloadKind: 'Collector config (excerpt)',
      payloadLang: 'text',
      payload: String.raw`
processors:
  tail_sampling:
    decision_wait: 10s
    policies:
      - { name: errors,  type: status_code, status_code: { status_codes: [ERROR] } }
      - { name: slow,    type: latency,     latency: { threshold_ms: 1000 } }
      - { name: baseline, type: probabilistic, probabilistic: { sampling_percentage: 5 } }

trace 4bf92f35…  spans=17  duration=2104ms  -> KEEP (policy: slow)`,
      code: [{ lang: 'text', title: 'Collector pipelines', src: String.raw`
receivers:  { otlp: { protocols: { grpc: {}, http: {} } } }
processors: [memory_limiter, k8sattributes, tail_sampling, batch]
exporters:
  prometheusremotewrite: { endpoint: http://mimir/api/v1/push }
  loki:                  { endpoint: http://loki:3100/loki/api/v1/push }
  otlp/tempo:            { endpoint: tempo:4317 }
service:
  pipelines:
    traces:  { receivers: [otlp], processors: [memory_limiter, k8sattributes, tail_sampling, batch], exporters: [otlp/tempo] }
    metrics: { receivers: [otlp], processors: [memory_limiter, k8sattributes, batch], exporters: [prometheusremotewrite] }
    logs:    { receivers: [otlp], processors: [memory_limiter, k8sattributes, batch], exporters: [loki] }` }]
    },
    {
      from: 'col', to: 'traces', label: 'kept spans',
      title: 'Store the trace',
      caption: 'Kept traces go to the trace store, which writes them to object storage in blocks indexed by trace id. Lookup by id is fast; searching by attributes uses a small extra index.',
      text: ['Traces are kept 14 days. Storing only ~6% of them is what makes keeping full detail affordable.'],
      payloadKind: 'Trace store write',
      payload: { trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', service: 'checkout-api', root: 'POST /v1/checkout', duration_ms: 2104, spans: 17, block: 's3://traces/tenant-shop/2026-11-25/blk_01JDQ…', retention_days: 14 }
    },
    {
      from: 'col', to: 'logs', label: 'log streams',
      title: 'Store the logs',
      caption: 'Logs go to Loki, which indexes only a few labels (service, environment, level) and stores the JSON compressed. A query filters by labels first, then scans for the trace id.',
      text: ['Indexing every field of every log line is expensive. Indexing a handful of labels and scanning compressed chunks is far cheaper and fast enough when you start from a trace id and a time window.'],
      payloadKind: 'Log query',
      payloadLang: 'text',
      payload: String.raw`
{service="checkout-api", env="prod"} | json | trace_id="4bf92f3577b34da6a3ce929d0e0e4736"

2026-11-25T11:41:43.902Z  warning  slow inventory lock   order_id=ord_7731 wait_ms=1840
2026-11-25T11:41:44.010Z  info     checkout completed    order_id=ord_7731 total=117.00`
    },
    {
      from: 'col', to: 'prom', label: 'remote write',
      title: 'Store the metrics',
      caption: 'Histogram buckets and counters are written to the metrics store every 15 s. From them, the SLO is computed: the share of checkout requests faster than 1 s and not 5xx.',
      text: ['An {{slo}} turns raw metrics into a promise: "99.5% of checkouts succeed in under 1 s over 30 days". The remaining 0.5% is the error budget.'],
      payloadKind: 'PromQL',
      payloadLang: 'text',
      payload: String.raw`
# good events / all events over 5 minutes
sum(rate(http_server_duration_seconds_bucket{route="/v1/checkout",le="1",status!~"5.."}[5m]))
/
sum(rate(http_server_duration_seconds_count{route="/v1/checkout"}[5m]))

=> 0.871      # 12.9% of checkouts are slow or failing right now`
    },
    {
      from: 'prom', to: 'alert', label: 'burn rate > 14.4',
      title: 'A burn-rate alert fires',
      caption: 'The error budget is being spent 25 times faster than allowed, over both the last hour and the last 5 minutes. That exceeds the paging threshold of 14.4, so the alert fires.',
      text: ['{{burn rate}} alerts page on user impact, not on causes. Two windows avoid both slow detection (long window alone) and flapping on short blips (short window alone).', 'Here the error ratio is 12.9% against a budget of 0.5%: a burn rate of about 26.'],
      payloadKind: 'Alert rule',
      payloadLang: 'text',
      payload: String.raw`
- alert: CheckoutSLOFastBurn
  expr: |
    (1 - slo:checkout_good:ratio_rate1h) / (1 - 0.995) > 14.4
    and
    (1 - slo:checkout_good:ratio_rate5m) / (1 - 0.995) > 14.4
  labels: { severity: page, team: checkout }
  annotations:
    summary: "Checkout SLO burning {{ $value | printf \"%.0f\" }}x budget"
    dashboard: https://grafana.example/d/checkout-slo

state: FIRING  value: 25.8  since: 2026-11-25T11:46:00Z`,
      failure: ['**Alertmanager down:** a "dead man\'s switch" alert that always fires stops arriving at PagerDuty, which pages about the monitoring itself.']
    },
    {
      from: 'alert', to: 'oncall', label: 'page',
      title: 'The on-call engineer is paged',
      caption: 'Alertmanager groups related alerts, routes by team label and pages the checkout on-call. The page links straight to the SLO dashboard.',
      text: ['Grouping matters: forty pods failing produce one page, not forty. Lower-severity budget burns (slow over days) create a ticket instead of waking someone.'],
      payloadKind: 'Page',
      payload: { to: 'checkout on-call (Sam)', title: '[FIRING] CheckoutSLOFastBurn: burning 26x budget', links: { dashboard: 'https://grafana.example/d/checkout-slo', runbook: 'https://runbooks.example/checkout-slo' }, grouped_alerts: 1 }
    },
    {
      from: 'graf', to: 'traces', label: 'exemplar → trace',
      title: 'From the graph to the slow trace',
      caption: 'On the latency panel, Sam clicks an exemplar dot in the 2.5 s bucket. Grafana opens trace 4bf92f35…, whose waterfall shows the inventory SELECT … FOR UPDATE taking 1.84 s.',
      text: ['This is why exemplars and trace ids matter: from "something is slow" to "this query waits on a lock" in one click, without guessing.'],
      payloadKind: 'Trace waterfall',
      payloadLang: 'text',
      payload: String.raw`
POST /v1/checkout                         ████████████████████  2104 ms
  redis GET cart:usr_ana                  ▏                       1 ms
  SELECT inventory … FOR UPDATE           █████████████████     1840 ms
  POST payments/charge                                     ██     212 ms
  INSERT orders                                              ▏     4 ms`
    },
    {
      from: 'graf', to: 'logs', label: 'trace → logs',
      title: 'From the trace to its logs, and the cause',
      caption: 'One more click shows the logs of that trace and of others in the same minute: a bulk stock import started at 11:45 and holds row locks on popular SKUs. Sam pauses the import; the burn rate drops within minutes.',
      text: ['The fix for the future is in the import job (smaller batches, `SKIP LOCKED`), tracked in the incident review. The pipeline\'s job was to make the cause visible in minutes.'],
      payloadKind: 'Logs around the incident',
      payloadLang: 'text',
      payload: String.raw`
11:45:02  stock-import  info     batch started  rows=180000 lock=row
11:46:10  checkout-api  warning  slow inventory lock  wait_ms=1840  trace_id=4bf92f35…
11:46:11  checkout-api  warning  slow inventory lock  wait_ms=2210  trace_id=9a0c11e2…
11:52:40  stock-import  info     paused by sam (incident INC-2291)
11:55:00  alertmanager  info     CheckoutSLOFastBurn resolved`
    }
  ],
  api: [
    { verb: 'GRPC', path: 'opentelemetry.proto.collector.trace.v1.TraceService/Export', desc: 'OTLP export from SDKs to collectors (also metrics and logs).' },
    { verb: 'POST', path: '/api/v1/push', desc: 'Prometheus remote write into the metrics store.' },
    { verb: 'GET', path: '/api/traces/{trace_id}', desc: 'Fetch a trace from the trace store.' }
  ],
  schemaLang: 'text',
  schemaNote: 'What each store keeps and for how long.',
  schema: String.raw`
Signal    Store           Indexed by                              Retention   Sampled
metrics   Mimir           metric name + labels (low cardinality)  13 months   no (aggregated)
logs      Loki            service, env, level labels only         30 days     no (debug off in prod)
traces    Tempo           trace id (+ small attribute index)      14 days     tail: errors, >1 s, 5% rest

Shared fields: service.name, deployment.environment, trace_id, span_id`,
  decisions: [
    { q: 'What do you alert on?', options: [
      { verdict: 'bad', name: 'CPU above 80%, every error log', why: 'Noisy pages that often have no user impact; people learn to ignore them.' },
      { verdict: 'great', name: 'Multi-window SLO burn rate', why: 'Pages only when users are hurt enough to threaten the objective.' }
    ] },
    { q: 'How do you sample traces?', options: [
      { verdict: 'ok', name: 'Head sampling 1%', why: 'Cheap, but 99% of slow and failed requests are lost.' },
      { verdict: 'great', name: 'Tail sampling: all errors and slow traces + a small baseline', why: 'Keeps the traces you actually need for debugging at a fraction of the cost.' }
    ] }
  ],
  refs: [
    { label: 'OpenTelemetry: Python instrumentation', url: 'https://opentelemetry.io/docs/languages/python/' },
    { label: 'Google SRE Workbook: Alerting on SLOs', url: 'https://sre.google/workbook/alerting-on-slos/' },
    { label: 'OpenTelemetry Collector: tail sampling processor', url: 'https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/tailsamplingprocessor' }
  ]
});
