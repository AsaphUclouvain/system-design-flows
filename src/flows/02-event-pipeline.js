flow({
  id: 'event-driven-pipeline',
  title: 'Event-driven pipeline with Kafka',
  category: 'Messaging & events',
  tags: ['Kafka', 'Partitions', 'Consumer groups', 'DLQ', 'Replay'],
  summary: 'An order is placed once and three independent services react to it: inventory, email and analytics. See how Kafka partitions, replicates and hands the same event to each consumer group, and how retries, dead letters and replays work.',
  requirements: {
    functional: [
      'When an order is placed, reserve stock, email a confirmation and record it for analytics.',
      'New consumers (fraud checks, loyalty points) can be added later without touching the order service.',
      'Any consumer can re-read history to rebuild its state or fix a bug.'
    ],
    nonFunctional: [
      'No event lost once the order is committed ({{at-least-once}}).',
      'Events about one order are processed in order (created before paid before shipped).',
      'A slow or broken consumer must not slow the producer or the other consumers.',
      'Throughput grows by adding partitions and consumer instances.'
    ]
  },
  estimates: [
    { label: 'Orders at peak', value: '2,000 / s', note: 'Assumption: a large shop during a sale.' },
    { label: 'Event size', value: '≈ 1 KB', note: 'JSON with ids and amounts; no images or HTML.' },
    { label: 'Write rate', value: '≈ 2 MB/s', note: '2,000 × 1 KB. Times 3 replicas = 6 MB/s of disk writes across the cluster.' },
    { label: 'Retention 7 days', value: '≈ 1.2 TB raw', note: 'At the peak rate all day: 2 MB/s × 604,800 s. Replicated 3× ≈ 3.6 TB.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'web', label: 'Checkout page', sub: 'Next.js', kind: 'client', x: 0, y: 0, desc: 'The shopper\'s browser. It only talks to the Orders API.' },
    { id: 'orders', label: 'Orders API', sub: 'FastAPI', kind: 'service', x: 1, y: 0, desc: 'Owns orders. Writes the order and an outbox row in one transaction, then forgets about who needs to know.' },
    { id: 'odb', label: 'Orders DB', sub: 'PostgreSQL + outbox', kind: 'db', x: 2, y: 0, desc: 'Source of truth for orders. Its `outbox` table is read by a relay (or Debezium {{cdc}}) that publishes to Kafka.' },
    { id: 'kafka', label: 'Kafka', sub: 'topic orders · 12 partitions', kind: 'queue', x: 2, y: 1, desc: 'A replicated, partitioned, append-only log. It keeps every event for the retention period whether or not anyone has read it. Consumers track their own position.' },
    { id: 'reg', label: 'Schema registry', sub: 'Avro / JSON Schema', kind: 'service', x: 3, y: 0, desc: 'Stores the versions of each event schema and rejects producers that would break existing consumers. Optional but valuable once many teams share topics.' },
    { id: 'inv', label: 'Inventory consumer', sub: 'group inventory', kind: 'worker', x: 1, y: 1, desc: 'Reserves stock for each order. Must be idempotent because it can see the same event twice.' },
    { id: 'idb', label: 'Inventory DB', sub: 'PostgreSQL', kind: 'db', x: 0, y: 1, desc: 'Stock levels plus a `processed_events` table used for deduplication.' },
    { id: 'mail', label: 'Email consumer', sub: 'group emails', kind: 'worker', x: 1, y: 2, icon: 'mail', desc: 'Sends the confirmation email. Calls an external provider, so it is the consumer most likely to fail transiently.' },
    { id: 'dlq', label: 'Retry + DLQ topics', sub: 'orders.emails.retry / .dlq', kind: 'queue', x: 0, y: 2, desc: 'Side topics where failing events wait before a retry, and where they finally rest when retries are exhausted.' },
    { id: 'ana', label: 'Analytics consumer', sub: 'group analytics', kind: 'worker', x: 2, y: 2, icon: 'chart', desc: 'Batches events and loads them into the warehouse. It tolerates minutes of delay but wants high throughput.' },
    { id: 'wh', label: 'Warehouse', sub: 'ClickHouse / BigQuery', kind: 'db', x: 3, y: 2, desc: 'A {{columnar storage}} database for {{olap}} queries such as revenue per hour.' }
  ],
  steps: [
    {
      from: 'web', to: 'orders', label: 'POST /orders',
      title: 'The shopper places the order',
      caption: 'The checkout page posts the cart. The Orders API validates it and owns the only write path to orders.',
      text: [
        'Nothing special yet: an authenticated `POST` with an {{idempotency key}}, validated with a Pydantic model. The interesting part is what the [[orders]] does **not** do: it does not call inventory, email or analytics. Each of those would add latency and a failure mode to checkout.'
      ],
      payloadKind: 'HTTP request',
      payload: {
        method: 'POST', path: '/v1/orders',
        headers: { 'idempotency-key': 'b3f1c9e2-7d44-4c1a-9f0e-1a2b3c4d5e6f', authorization: 'Bearer eyJ...' },
        body: { items: [{ sku: 'SKU-TSHIRT-M-BLK', qty: 2 }, { sku: 'SKU-MUG-01', qty: 1 }], shipping_address_id: 'addr_311', currency: 'EUR' }
      },
      fields: { 'items': 'Only ids and quantities. Prices are looked up server-side; never trust a price sent by the browser.' },
      code: [{ lang: 'python', title: 'Request model (Pydantic v2)', src: String.raw`
class OrderItem(BaseModel):
    sku: str = Field(pattern=r"^SKU-[A-Z0-9-]+$")
    qty: int = Field(gt=0, le=20)

class OrderIn(BaseModel):
    items: list[OrderItem] = Field(min_length=1, max_length=50)
    shipping_address_id: str
    currency: Literal["EUR", "USD", "GBP"]` }]
    },
    {
      from: 'orders', to: 'odb', label: 'order + outbox',
      title: 'Commit the order and its event together',
      caption: 'The order rows and an order.created outbox row commit in one transaction, so the event exists if and only if the order does.',
      text: [
        'This is the {{outbox pattern}}. It solves the {{dual write}} problem: writing to PostgreSQL and then to Kafka can fail between the two. Here the event is just another row in the same transaction.',
        'The event carries everything consumers need (items, totals, customer email). Consumers should not have to call the Orders API back; that would couple them again.'
      ],
      details: ['`event_id` is a UUID used for deduplication downstream.', '`aggregate_id` = order id. It becomes the Kafka key so all events of one order stay in order.'],
      payloadKind: 'Outbox row',
      payload: {
        event_id: 'evt_0c1d', aggregate_type: 'order', aggregate_id: 'ord_7781', event_type: 'order.created', schema_version: 2,
        payload: { order_id: 'ord_7781', customer_id: 'cus_19', email: 'sam@example.org', currency: 'EUR', total_cents: 4697,
          items: [{ sku: 'SKU-TSHIRT-M-BLK', qty: 2, unit_cents: 1999 }, { sku: 'SKU-MUG-01', qty: 1, unit_cents: 699 }] }
      },
      fields: { 'total_cents': 'Money as integer cents, never floats: 0.1 + 0.2 is not 0.3 in binary floating point.', 'schema_version': 'Lets consumers handle old and new shapes during a migration.' }
    },
    {
      from: 'odb', to: 'kafka', label: 'produce key=ord_7781', async: true,
      title: 'The relay produces the event to the orders topic',
      caption: 'The key ord_7781 is hashed to pick one of 12 partitions. The leader of that partition appends it and waits for the in-sync replicas before acknowledging.',
      text: [
        'Kafka\'s default partitioner hashes the record key (murmur2) modulo the number of partitions. Same key, same {{partition}}, so `order.created`, `order.paid` and `order.shipped` for `ord_7781` are always read in that order.',
        'Each partition has a leader broker and followers. With `acks=all`, the leader acknowledges only after every in-sync replica has the record. Combined with the topic setting `min.insync.replicas=2` and replication factor 3, one broker can die without losing acknowledged events.',
        '`enable.idempotence=true` gives each producer an id and sequence numbers, so a retried send after a network blip is not written twice into the log.'
      ],
      details: [
        'Order is guaranteed per partition only. Two different orders on two partitions have no ordering relation, and that is fine.',
        'Changing the partition count later remaps keys to new partitions, which breaks per-key ordering during the change. Choose generously up front.'
      ],
      payloadKind: 'Kafka record',
      payload: {
        topic: 'orders', key: 'ord_7781', partition: 5,
        headers: { 'event-id': 'evt_0c1d', 'event-type': 'order.created', 'schema-id': '42' },
        value: { event_id: 'evt_0c1d', type: 'order.created', occurred_at: '2026-11-25T10:12:03Z', data: { order_id: 'ord_7781', customer_id: 'cus_19', email: 'sam@example.org', currency: 'EUR', total_cents: 4697, items: [{ sku: 'SKU-TSHIRT-M-BLK', qty: 2, unit_cents: 1999 }, { sku: 'SKU-MUG-01', qty: 1, unit_cents: 699 }] } }
      },
      fields: { 'partition': 'hash(key) mod 12 for the default partitioner. Here it lands on 5.', 'schema-id': 'Points at the exact schema version in the registry.', 'event-type': 'Lets a consumer skip types it does not care about without parsing the body.' },
      code: [
        { lang: 'python', title: 'A safe producer (confluent-kafka)', src: String.raw`
from confluent_kafka import Producer

producer = Producer({
    "bootstrap.servers": "kafka-1:9092,kafka-2:9092,kafka-3:9092",
    "acks": "all",                 # wait for all in-sync replicas
    "enable.idempotence": True,    # no duplicates from producer retries
    "compression.type": "zstd",
    "linger.ms": 5,                # batch for 5 ms: more throughput
})

def publish(row):
    producer.produce(
        "orders", key=row["aggregate_id"], value=to_json(row),
        headers={"event-id": row["event_id"], "event-type": row["event_type"]},
        on_delivery=lambda err, msg: err and log.error("produce failed", err=err))
    producer.poll(0)

# topic created with: partitions=12, replication.factor=3, min.insync.replicas=2` }
      ],
      failure: [
        '**A broker dies:** a follower that is in sync becomes leader; producers and consumers fetch new metadata and carry on.',
        '**Too few replicas in sync:** with `acks=all` and `min.insync.replicas=2`, writes are refused (`NotEnoughReplicas`) rather than accepted unsafely. The relay retries; the outbox keeps the events meanwhile.'
      ]
    },
    {
      from: 'orders', to: 'reg', label: 'schema check',
      title: 'The schema registry guards the contract',
      caption: 'Before the first event of a new version is produced, its schema is registered. Incompatible changes are refused so consumers never receive a shape they cannot read.',
      text: [
        'Many teams read `orders`. If the order team renames `total_cents` to `amount`, every consumer breaks at once. A [[reg]] enforces a compatibility rule per topic, commonly **backward**: consumers using the new schema can still read old events. Adding an optional field passes; deleting or renaming a required field fails.',
        'Each record then carries a small schema id instead of the full schema.'
      ],
      payloadKind: 'Schema (JSON Schema, version 2)',
      payload: {
        subject: 'orders-value', version: 2, compatibility: 'BACKWARD',
        schema: { type: 'object', required: ['order_id', 'customer_id', 'currency', 'total_cents', 'items'],
          properties: { order_id: { type: 'string' }, customer_id: { type: 'string' }, email: { type: 'string' }, currency: { type: 'string' }, total_cents: { type: 'integer' }, items: { type: 'array' }, coupon: { type: 'string', description: 'new in v2, optional' } } }
      },
      fields: { 'compatibility': 'BACKWARD: new readers handle old data. FORWARD: old readers handle new data. FULL: both.', 'coupon': 'A new optional field is a compatible change.' }
    },
    {
      from: 'kafka', to: 'inv', label: 'poll (group inventory)', async: true,
      title: 'Inventory reads it in its own consumer group',
      caption: 'Each consumer group gets every event. Inside the inventory group, partition 5 is owned by exactly one instance, which processes it and then commits its offset.',
      text: [
        'Three groups (`inventory`, `emails`, `analytics`) read the same topic independently, each with its own committed {{offset}} per partition. Kafka does not delete an event when one group reads it; it keeps it for the retention period.',
        'Within a group, partitions are divided among instances. Twelve partitions allow up to twelve active inventory instances; a thirteenth would sit idle.'
      ],
      payloadKind: 'Consumer view',
      payload: { group: 'inventory', member: 'inventory-3', assigned_partitions: [4, 5, 6], record: { partition: 5, offset: 918273, key: 'ord_7781', event_id: 'evt_0c1d', type: 'order.created' }, committed_offset_before: 918273 },
      fields: { 'assigned_partitions': 'Decided by the group coordinator. It changes on a rebalance when members join or leave.', 'committed_offset_before': 'The next offset to read. After success the consumer commits 918274.' },
      failure: ['**Instance crashes:** after its session times out the group rebalances, and partition 5 goes to another instance, which resumes from the last committed offset. Events since then are processed again.']
    },
    {
      from: 'inv', to: 'idb', label: 'dedupe + reserve',
      title: 'Reserve stock exactly once in effect',
      caption: 'In one transaction the consumer records the event id and decrements stock. A repeated event hits the primary key and changes nothing.',
      text: [
        'This is the {{idempotent consumer}}. The `processed_events` insert and the stock update share a transaction, so either both happen or neither. If the same event comes back (after a rebalance), the insert conflicts and the handler skips the update.',
        'The stock update is guarded with `WHERE available >= qty`. If a row is not updated, there isn\'t enough stock, and the consumer emits `inventory.rejected` so the order service can cancel or backorder.'
      ],
      payloadKind: 'SQL transaction',
      payloadLang: 'sql',
      payload: String.raw`
BEGIN;
INSERT INTO processed_events (consumer, event_id) VALUES ('inventory', 'evt_0c1d')
ON CONFLICT DO NOTHING RETURNING event_id;     -- no row back = already done, ROLLBACK and skip

UPDATE stock SET available = available - 2, reserved = reserved + 2
WHERE sku = 'SKU-TSHIRT-M-BLK' AND available >= 2;   -- 1 row = ok, 0 rows = out of stock
UPDATE stock SET available = available - 1, reserved = reserved + 1
WHERE sku = 'SKU-MUG-01' AND available >= 1;

INSERT INTO outbox (event_id, aggregate_id, event_type, payload)
VALUES ('evt_51aa', 'ord_7781', 'inventory.reserved', '{"order_id":"ord_7781"}');
COMMIT;
-- then commit the Kafka offset 918274`,
      code: [{ lang: 'python', title: 'Idempotent handler (asyncpg)', src: String.raw`
async def on_order_created(conn, evt):
    async with conn.transaction():
        first = await conn.fetchval(
            "INSERT INTO processed_events (consumer, event_id) VALUES ('inventory', $1) "
            "ON CONFLICT DO NOTHING RETURNING event_id", evt["event_id"])
        if not first:
            return                                   # duplicate delivery
        for it in evt["data"]["items"]:
            ok = await conn.execute(
                "UPDATE stock SET available = available - $2, reserved = reserved + $2 "
                "WHERE sku = $1 AND available >= $2", it["sku"], it["qty"])
            if ok == "UPDATE 0":
                raise OutOfStock(it["sku"])          # whole transaction rolls back
        await add_outbox(conn, "inventory.reserved", evt["data"]["order_id"])` }]
    },
    {
      from: 'kafka', to: 'mail', label: 'poll (group emails)', async: true,
      title: 'The email consumer reads the same event',
      caption: 'The emails group reads the same record at its own pace. It renders the confirmation and calls the email provider.',
      text: [
        'Being a separate group, [[mail]] is unaffected by how fast inventory is. If the email provider is slow, only this group\'s {{consumer lag}} grows.',
        'It deduplicates the same way (a `sent_emails` table keyed by event id) so a re-read does not email Sam twice.'
      ],
      payloadKind: 'Consumer view',
      payload: { group: 'emails', member: 'emails-1', record: { partition: 5, offset: 918273, key: 'ord_7781', event_id: 'evt_0c1d', type: 'order.created' }, action: 'send template order_confirmation to sam@example.org' }
    },
    {
      from: 'mail', to: 'dlq', label: 'provider 503 → retry topic', async: true,
      title: 'A transient failure goes to a retry topic',
      caption: 'The provider answers 503. Rather than block partition 5 while it waits, the consumer copies the event to a retry topic with a not-before time and moves on.',
      text: [
        'Kafka has no per-message "retry later". If the consumer kept retrying in place, every later event on partition 5 would wait ({{head-of-line blocking}}). The common fix is **retry topics**: publish the event to `orders.emails.retry` with attempt count and a not-before time, commit the original offset, continue.',
        'A retry consumer reads that topic, waits until not-before, and tries again. After the last attempt the event goes to `orders.emails.dlq`, an alert fires, and a human decides.',
        'Trade-off: the retried email can now arrive after a later event for the same order. For a confirmation email that is acceptable; for stock updates it would not be, which is why inventory retries in place instead.'
      ],
      payloadKind: 'Retry record',
      payload: { topic: 'orders.emails.retry', key: 'ord_7781', headers: { 'event-id': 'evt_0c1d', attempt: '2', 'not-before': '2026-11-25T10:13:03Z', 'last-error': '503 Service Unavailable', 'original-topic': 'orders', 'original-offset': '5:918273' }, value: '(unchanged order.created body)' },
      fields: { attempt: 'Incremented each time. Past the maximum (say 5) the record goes to the DLQ.', 'not-before': 'Backoff: 1 min, 5 min, 30 min... with jitter.', 'original-offset': 'Where it came from, for debugging and replays.' },
      code: [{ lang: 'python', title: 'Route failures: retry topic or dead letter', src: String.raw`
MAX_ATTEMPTS = 5
BACKOFF_S = [60, 300, 1800, 7200, 21600]

def route_failure(msg, err):
    attempt = int(header(msg, "attempt", "0")) + 1
    topic = "orders.emails.retry" if attempt < MAX_ATTEMPTS else "orders.emails.dlq"
    not_before = time.time() + BACKOFF_S[min(attempt - 1, len(BACKOFF_S) - 1)] * random.uniform(0.8, 1.2)
    producer.produce(topic, key=msg.key(), value=msg.value(), headers={
        **dict(msg.headers() or []),
        "attempt": str(attempt), "not-before": str(int(not_before)),
        "last-error": str(err)[:200],
        "original-offset": f"{msg.partition()}:{msg.offset()}"})
    producer.flush()
    consumer.commit(msg)       # the main partition keeps moving` }],
      failure: ['**Poison message** (a bug makes it fail every time): it walks through the retries and lands in the DLQ instead of blocking everyone forever. Fix the bug, then replay the DLQ.']
    },
    {
      from: 'kafka', to: 'ana', label: 'poll batch (group analytics)', async: true,
      title: 'Analytics reads in large batches',
      caption: 'The analytics group polls hundreds of records at a time, buffers them for a few seconds and writes them to the warehouse in bulk.',
      text: [
        'Warehouses are built for big inserts, not single rows. [[ana]] accumulates up to N records or T seconds, writes one batch, then commits offsets for the whole batch.',
        'A crash before the commit means the batch is written again. Use a table engine or MERGE keyed by `event_id` so duplicates collapse.'
      ],
      payloadKind: 'Batch',
      payload: { group: 'analytics', batch_size: 500, partitions: [0, 1, 2, 3, 4, 5], first_offset_p5: 918100, last_offset_p5: 918300, flush_reason: 'size' }
    },
    {
      from: 'ana', to: 'wh', label: 'bulk insert',
      title: 'Load into the warehouse',
      caption: 'One bulk insert of 500 rows into a columnar table, deduplicated by event id. Revenue dashboards now include this order.',
      text: ['Analytical queries scan millions of rows but only a few columns (`total_cents`, `occurred_at`), which is exactly what {{columnar storage}} is good at.'],
      payloadKind: 'SQL (ClickHouse)',
      payloadLang: 'sql',
      payload: String.raw`
CREATE TABLE order_events (
  event_id String, order_id String, type LowCardinality(String),
  total_cents Int64, currency LowCardinality(String), occurred_at DateTime
) ENGINE = ReplacingMergeTree ORDER BY (event_id);     -- duplicates merge away

INSERT INTO order_events VALUES
  ('evt_0c1d', 'ord_7781', 'order.created', 4697, 'EUR', '2026-11-25 10:12:03'),
  ...;   -- 499 more rows

SELECT toStartOfHour(occurred_at) AS h, sum(total_cents) / 100 AS revenue
FROM order_events FINAL WHERE type = 'order.created' GROUP BY h ORDER BY h;`
    },
    {
      from: 'dlq', to: 'mail', label: 'replay after fix', async: true,
      title: 'Replay: the superpower of a log',
      caption: 'Once the provider is healthy (or the bug is fixed), the DLQ is replayed into the email consumer. A whole group can also rewind its offsets to reprocess history.',
      text: [
        'Because Kafka keeps events for the retention period, you can reset a group\'s offsets to a point in time and reprocess everything since then, for example after deploying a fix to the analytics consumer that was double-counting.',
        'Replays are only safe because every consumer is idempotent. That is the recurring theme of event-driven design: **at-least-once delivery + idempotent consumers**.'
      ],
      payloadKind: 'Command',
      payloadLang: 'bash',
      payload: String.raw`
# rewind the analytics group to yesterday 00:00 UTC (group must be stopped)
kafka-consumer-groups --bootstrap-server kafka-1:9092 --group analytics \
  --topic orders --reset-offsets --to-datetime 2026-11-24T00:00:00.000 --execute

# move dead letters back to the retry topic after the fix
kcat -C -b kafka-1:9092 -t orders.emails.dlq -e | kcat -P -b kafka-1:9092 -t orders.emails.retry`
    }
  ],
  api: [
    { verb: 'POST', path: '/v1/orders', desc: 'Creates the order and the `order.created` outbox row atomically.' },
    { verb: 'EVENT', path: 'orders → order.created | order.paid | order.cancelled | order.shipped', desc: 'Key = order id. Value has `event_id`, `type`, `occurred_at`, `data`.' },
    { verb: 'EVENT', path: 'inventory → inventory.reserved | inventory.rejected', desc: 'Published by the inventory service through its own outbox.' }
  ],
  schema: String.raw`
-- In every consumer's own database
CREATE TABLE processed_events (
  consumer   TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
-- Old rows can be deleted after the topic retention (7 days) has passed.

CREATE TABLE stock (
  sku       TEXT PRIMARY KEY,
  available INT NOT NULL CHECK (available >= 0),
  reserved  INT NOT NULL DEFAULT 0
);`,
  decisions: [
    { q: 'Kafka, RabbitMQ, or a Redis/SQS queue?', options: [
      { verdict: 'good', name: 'Work queue (RabbitMQ, SQS, Redis Streams)', why: 'Each message goes to one worker and is deleted when acknowledged. Great for jobs ("resize this image"). Weaker at many independent readers and replay.' },
      { verdict: 'great', name: 'Log (Kafka, Redpanda, Kinesis) for business events', why: 'Many groups read the same events independently, history can be replayed, ordering per key. More to operate, so use a managed service if you can.' }
    ] },
    { q: 'How do you keep events for the same order in order?', options: [
      { verdict: 'bad', name: 'Random or round-robin partitioning', why: 'order.paid can be processed before order.created on another partition.' },
      { verdict: 'great', name: 'Key by order id', why: 'All events of an order land on one partition and are read in order by one consumer. Different orders still spread across partitions for throughput.' }
    ] },
    { q: 'What do you do with a message that keeps failing?', options: [
      { verdict: 'bad', name: 'Retry forever in place', why: 'Blocks the partition: every later order waits behind one bad event.' },
      { verdict: 'bad', name: 'Log and skip', why: 'Silently loses business events.' },
      { verdict: 'great', name: 'Retry topics with backoff, then a DLQ with alerting and replay', why: 'The partition keeps flowing, nothing is lost, and humans get a clear queue of problems to fix.' }
    ] }
  ],
  refs: [
    { label: 'Apache Kafka documentation', url: 'https://kafka.apache.org/documentation/', note: 'Producers, acks, idempotence, consumer groups.' },
    { label: 'Confluent: Kafka consumer design', url: 'https://docs.confluent.io/platform/current/clients/consumer.html', note: 'Groups, offsets, rebalancing.' },
    { label: 'Confluent: Schema evolution and compatibility', url: 'https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html', note: 'BACKWARD, FORWARD, FULL.' },
    { label: 'Uber Engineering: Reliable reprocessing with Kafka', url: 'https://www.uber.com/blog/reliable-reprocessing/', note: 'The retry-topic and DLQ design.' },
    { label: 'microservices.io: Idempotent consumer', url: 'https://microservices.io/patterns/communication-style/idempotent-consumer.html' }
  ]
});

flow({
  id: 'webhook-delivery',
  title: 'Webhook delivery platform',
  category: 'Messaging & events',
  tags: ['HMAC signatures', 'Retries', 'SSRF', 'Fanout'],
  summary: 'Your platform tells customers\' servers when something happens, like Stripe or GitHub do. Follow one event from registration of the endpoint to a signed POST, the customer\'s verification, retries on failure, auto-disable and manual replay.',
  requirements: {
    functional: [
      'Customers register HTTPS endpoints and choose which event types they want.',
      'Each event is POSTed to every matching endpoint with a signature the customer can verify.',
      'Failed deliveries are retried for about three days with growing delays.',
      'Customers see every attempt (status code, latency, body excerpt) and can replay any event.'
    ],
    nonFunctional: [
      '{{at-least-once}}: an event is never silently dropped; customers deduplicate by webhook id.',
      'One slow or dead customer endpoint must not delay deliveries to others.',
      'The platform must not be usable to attack internal networks ({{ssrf|SSRF}} protection).',
      'Signatures must resist replay attacks (timestamp in the signed content).'
    ]
  },
  estimates: [
    { label: 'Events / day', value: '50 million', note: 'Assumption.' },
    { label: 'Endpoints per event', value: '≈ 1.5', note: 'Some customers register several.' },
    { label: 'Deliveries / s', value: '≈ 870', note: '75M ÷ 86,400. Plan for bursts of 10×.' },
    { label: 'Concurrency needed', value: '≈ 8,700 in flight', note: 'At peak 8,700 / s × 1 s average latency (Little\'s law: concurrency = rate × time).' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'dash', label: 'Developer dashboard', sub: 'Next.js', kind: 'client', x: 0, y: 0, desc: 'Where customers add endpoints, see delivery logs, rotate secrets and replay events.' },
    { id: 'api', label: 'Webhooks API', sub: 'FastAPI', kind: 'service', x: 1, y: 0, desc: 'Manages endpoints and secrets, validates URLs, serves delivery logs.' },
    { id: 'db', label: 'Webhooks DB', sub: 'PostgreSQL', kind: 'db', x: 2, y: 0, desc: 'Endpoints, subscriptions, events, and one row per delivery attempt.' },
    { id: 'src', label: 'Billing service', sub: 'event source', kind: 'service', x: 3, y: 0, desc: 'Any internal service that produces events (here: an invoice was paid). It publishes to the internal event bus and knows nothing about customer endpoints.' },
    { id: 'disp', label: 'Dispatcher', sub: 'fans out', kind: 'worker', x: 3, y: 1, desc: 'Consumes internal events, finds every endpoint subscribed to the event type, and creates one delivery task per endpoint.' },
    { id: 'q', label: 'Delivery queue', sub: 'per-endpoint lanes', kind: 'queue', x: 2, y: 1, desc: 'Tasks wait here. Partitioning by endpoint means one slow customer only backs up their own lane.' },
    { id: 'wk', label: 'Delivery workers', sub: 'async HTTP', kind: 'worker', x: 1, y: 1, desc: 'Sign and send the HTTP request through an egress proxy, record the result, schedule retries.' },
    { id: 'proxy', label: 'Egress proxy', sub: 'SSRF filter', kind: 'edge', x: 1, y: 2, desc: 'All outbound webhook traffic leaves through here. It resolves DNS itself and refuses private, loopback and metadata addresses.' },
    { id: 'cust', label: 'Customer server', sub: 'https://shop.example/hooks', kind: 'external', x: 0, y: 2, desc: 'The customer\'s own endpoint. You control nothing about it: it can be slow, down, return HTML errors, or redirect.' },
    { id: 'sched', label: 'Retry scheduler', sub: 'due attempts', kind: 'worker', x: 2, y: 2, icon: 'clock', desc: 'Finds deliveries whose next attempt is due and puts them back on the queue.' }
  ],
  steps: [
    {
      from: 'dash', to: 'api', label: 'POST /webhook-endpoints',
      title: 'The customer registers an endpoint',
      caption: 'The customer gives a URL and the event types they want. The API validates the URL and generates a signing secret shown once.',
      text: [
        'Validation happens here and again at send time: HTTPS only, a public hostname, no credentials in the URL. The API returns a secret (`whsec_...`) that the customer stores in their environment. It is the shared key for {{hmac}} signatures.',
        'Many platforms then send a test event so the customer can confirm their endpoint works before real traffic arrives.'
      ],
      payloadKind: 'HTTP request',
      payload: { method: 'POST', path: '/v1/webhook-endpoints', body: { url: 'https://shop.example/hooks', events: ['invoice.paid', 'invoice.payment_failed'], description: 'Production' } },
      fields: { events: 'Subscriptions. The dispatcher only sends matching types. `*` would mean everything.' },
      code: [{ lang: 'python', title: 'Create endpoint + secret', src: String.raw`
@router.post("/v1/webhook-endpoints", status_code=201)
async def create_endpoint(body: EndpointIn, account=Depends(current_account), db=Depends(get_db)):
    url = validate_public_https_url(body.url)        # scheme, host, no userinfo, resolves publicly
    secret = "whsec_" + secrets.token_urlsafe(32)
    ep = await db.fetchrow("""
        INSERT INTO endpoints (id, account_id, url, events, secret_enc, status)
        VALUES ($1, $2, $3, $4, $5, 'enabled') RETURNING id, url, events, created_at""",
        new_id("we"), account.id, url, body.events, encrypt(secret))
    return {**ep, "secret": secret}          # shown once; stored encrypted at rest` }]
    },
    {
      from: 'api', to: 'db', label: 'INSERT endpoint',
      title: 'Store the endpoint and its subscriptions',
      caption: 'The endpoint, its event types and its encrypted secret are saved. The response returns the secret exactly once.',
      text: ['The secret is encrypted at rest (with a key from a KMS), not hashed, because workers need the raw value to sign. Supporting **two active secrets** during rotation lets customers switch without downtime.'],
      payloadKind: 'HTTP response',
      payload: { status: 201, body: { id: 'we_4Kx', url: 'https://shop.example/hooks', events: ['invoice.paid', 'invoice.payment_failed'], status: 'enabled', secret: 'whsec_MfKQ9r5Tq1n0n7...' } },
      fields: { secret: 'Copy it now. The dashboard can only rotate it later, not reveal it.' }
    },
    {
      from: 'src', to: 'disp', label: 'invoice.paid', async: true,
      title: 'An internal event happens',
      caption: 'The billing service publishes invoice.paid on the internal bus, through its outbox. The dispatcher consumes it.',
      text: ['Internal events and customer-facing webhook payloads are different contracts. The dispatcher maps the internal event to a stable public, versioned shape so internal refactors never leak to customers.'],
      payloadKind: 'Internal event',
      payload: { event_id: 'evt_int_88', type: 'invoice.paid', account_id: 'acct_12', occurred_at: '2026-11-25T09:30:00Z', data: { invoice_id: 'in_552', amount_cents: 12000, currency: 'EUR', customer_ref: 'c_77' } }
    },
    {
      from: 'disp', to: 'db', label: 'match + create deliveries',
      title: 'Fan out to subscribed endpoints',
      caption: 'The dispatcher stores the public event once, finds every enabled endpoint of that account subscribed to invoice.paid, and creates one delivery row each.',
      text: [
        'The public event gets its own id (`msg_...`). That id is the **webhook id** the customer uses to deduplicate, and it stays the same on every retry and replay.',
        'Creating deliveries is idempotent: a unique constraint on `(message_id, endpoint_id)` means a re-consumed internal event creates nothing new.'
      ],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
INSERT INTO messages (id, account_id, event_type, payload, source_event_id)
VALUES ('msg_2Yh7', 'acct_12', 'invoice.paid',
        '{"type":"invoice.paid","data":{"id":"in_552","amount":12000,"currency":"eur"}}',
        'evt_int_88')
ON CONFLICT (source_event_id) DO NOTHING;

INSERT INTO deliveries (id, message_id, endpoint_id, status, next_attempt_at, attempt)
SELECT gen_random_uuid(), 'msg_2Yh7', e.id, 'pending', now(), 0
FROM endpoints e
WHERE e.account_id = 'acct_12' AND e.status = 'enabled'
  AND ('invoice.paid' = ANY(e.events) OR '*' = ANY(e.events))
ON CONFLICT (message_id, endpoint_id) DO NOTHING;`
    },
    {
      from: 'disp', to: 'q', label: 'enqueue per endpoint', async: true,
      title: 'Enqueue into the endpoint\'s lane',
      caption: 'Each delivery is queued in a lane keyed by endpoint id, so a customer whose server takes 30 seconds only slows their own deliveries.',
      text: [
        'Without lanes, a few dead endpoints that always time out would occupy most workers. With per-endpoint keys (a Kafka key or a queue per endpoint), plus a cap on concurrent requests per endpoint, failures stay local.'
      ],
      payloadKind: 'Queue message',
      payload: { key: 'we_4Kx', delivery_id: 'dl_91f', message_id: 'msg_2Yh7', endpoint_id: 'we_4Kx', attempt: 0 }
    },
    {
      from: 'q', to: 'wk', label: 'dequeue', async: true,
      title: 'A worker builds the signed request',
      caption: 'The worker loads the payload and the endpoint secret, then signs "id.timestamp.body" with HMAC-SHA256 and puts it in headers.',
      text: [
        'This follows the Standard Webhooks convention (used by several platforms): three headers, `webhook-id`, `webhook-timestamp` and `webhook-signature`. The signed content is `{id}.{timestamp}.{body}`, so an attacker cannot reuse an old body with a new timestamp, nor move a signature to another message.',
        'The body is serialized **once** and those exact bytes are both signed and sent. Re-serializing JSON can reorder keys or change spacing and break the signature.'
      ],
      payloadKind: 'Signed HTTP request',
      payload: {
        method: 'POST', url: 'https://shop.example/hooks',
        headers: { 'content-type': 'application/json', 'user-agent': 'ExampleWebhooks/1.0', 'webhook-id': 'msg_2Yh7', 'webhook-timestamp': '1764063000', 'webhook-signature': 'v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=' },
        body: { type: 'invoice.paid', timestamp: '2026-11-25T09:30:00Z', data: { id: 'in_552', amount: 12000, currency: 'eur', customer: 'c_77' } }
      },
      fields: { 'webhook-id': 'Stable across retries. The customer stores it to ignore duplicates.', 'webhook-timestamp': 'Unix seconds. Receivers reject requests older than about 5 minutes to block replays.', 'webhook-signature': 'Version prefix + base64 HMAC-SHA256. Several space-separated signatures are allowed during secret rotation.' },
      code: [{ lang: 'python', title: 'Signing (Standard Webhooks style)', src: String.raw`
import base64, hashlib, hmac, json, time

def sign(secret: str, msg_id: str, body: bytes, ts: int | None = None) -> dict:
    ts = ts or int(time.time())
    key = base64.b64decode(secret.removeprefix("whsec_"))
    to_sign = f"{msg_id}.{ts}.".encode() + body
    sig = base64.b64encode(hmac.new(key, to_sign, hashlib.sha256).digest()).decode()
    return {"webhook-id": msg_id, "webhook-timestamp": str(ts),
            "webhook-signature": f"v1,{sig}"}

body = json.dumps(payload, separators=(",", ":")).encode()   # serialize once
headers = sign(endpoint_secret, "msg_2Yh7", body)` }]
    },
    {
      from: 'wk', to: 'proxy', label: 'via egress proxy',
      title: 'Send through the SSRF-safe egress proxy',
      caption: 'The request leaves through a proxy that resolves the hostname itself and refuses private and metadata IP addresses, with strict timeouts.',
      text: [
        'A customer could register `https://169.254.169.254/...` (the cloud metadata service) or a hostname that resolves to `10.0.0.5` and use your workers to probe your internal network. That is {{ssrf}}. Checking the URL at registration is not enough because DNS can change later (DNS rebinding).',
        'So the check happens at connect time on the resolved IP, in one place: the [[proxy]]. Redirects are not followed (or each hop is re-checked). Timeouts: about 3 s to connect, 10–15 s total.'
      ],
      payloadKind: 'Proxy decision',
      payload: { host: 'shop.example', resolved: ['203.0.113.45'], blocked_ranges: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', '::1/128', 'fc00::/7'], decision: 'allow', connect_timeout_s: 3, total_timeout_s: 15, follow_redirects: false },
      code: [{ lang: 'python', title: 'IP check at connect time', src: String.raw`
import ipaddress, socket

def assert_public(host: str, port: int = 443) -> str:
    infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    for *_, sockaddr in infos:
        ip = ipaddress.ip_address(sockaddr[0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_multicast or ip.is_reserved or ip.is_unspecified):
            raise BlockedDestination(f"{host} -> {ip}")
    return infos[0][4][0]     # connect to this exact IP (with SNI = host) to avoid rebinding` }],
      failure: ['**Blocked address:** the attempt fails permanently with reason `blocked_destination`, shown in the dashboard. No retry.']
    },
    {
      from: 'proxy', to: 'cust', label: 'POST /hooks',
      title: 'The customer verifies and acknowledges',
      caption: 'The customer\'s server recomputes the HMAC over the raw body, compares in constant time, checks the timestamp, deduplicates by webhook-id, queues the work and answers 2xx fast.',
      text: [
        'Good receivers do almost nothing synchronously: verify, store the event id, enqueue their own job, return `200`. Doing slow work before answering causes timeouts and therefore retries and duplicates.',
        'They must verify against the **raw** request bytes. In FastAPI that means `await request.body()`, not a parsed model.'
      ],
      payloadKind: 'Receiver side',
      payload: { verify: { recomputed: 'v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=', match: true, age_seconds: 1 }, dedupe: { 'webhook-id': 'msg_2Yh7', first_time: true }, response: { status: 200, body: '' } },
      code: [{ lang: 'python', title: 'Receiving a webhook in FastAPI', src: String.raw`
@app.post("/hooks")
async def receive(request: Request, r: Redis = Depends(get_redis)):
    body = await request.body()                       # raw bytes, before parsing
    msg_id = request.headers["webhook-id"]
    ts = int(request.headers["webhook-timestamp"])
    if abs(time.time() - ts) > 300:
        raise HTTPException(400, "stale timestamp")
    expected = sign(WEBHOOK_SECRET, msg_id, body, ts)["webhook-signature"].split(",", 1)[1]
    sent = [s.split(",", 1)[1] for s in request.headers["webhook-signature"].split()]
    if not any(hmac.compare_digest(expected, s) for s in sent):   # constant time
        raise HTTPException(400, "bad signature")
    if not await r.set(f"wh:{msg_id}", 1, nx=True, ex=7 * 86400):
        return Response(status_code=200)               # duplicate: already handled
    await enqueue_job("handle_invoice_paid", json.loads(body))
    return Response(status_code=200)` }]
    },
    {
      from: 'cust', to: 'wk', label: '503 after 10 s', reply: true,
      title: 'A failed attempt is recorded with full detail',
      caption: 'Suppose the customer was deploying and returned 503. The worker records status, latency and a body excerpt, then schedules the next attempt.',
      text: [
        'Any 2xx is success. Everything else, including timeouts, connection errors and 3xx redirects, is a failure. 4xx responses are usually retried too, because a misconfigured customer endpoint (say a 401 after a secret rotation) is often fixed within hours.',
        'The schedule grows: immediately, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h, which spans roughly a day and a half. Many platforms use a similar multi-day schedule.'
      ],
      payloadKind: 'Attempt record',
      payload: { delivery_id: 'dl_91f', attempt: 1, status_code: 503, duration_ms: 10012, response_excerpt: '<html><h1>503 Service Unavailable</h1>', error: null, next_attempt_at: '2026-11-25T09:30:06Z' },
      fields: { response_excerpt: 'First ~1 KB only. Customers love seeing this in the dashboard; it\'s how they debug.', next_attempt_at: 'From the schedule plus a little jitter.' },
      code: [{ lang: 'python', title: 'Record and reschedule', src: String.raw`
SCHEDULE_S = [0, 5, 300, 1800, 7200, 18000, 36000, 36000]

async def record(db, d, resp=None, err=None, ms=0):
    ok = resp is not None and 200 <= resp.status_code < 300
    await db.execute("INSERT INTO attempts (delivery_id, n, status_code, duration_ms, excerpt, error) "
                     "VALUES ($1,$2,$3,$4,$5,$6)", d.id, d.attempt + 1,
                     resp and resp.status_code, ms, resp and resp.text[:1024], err)
    if ok:
        await db.execute("UPDATE deliveries SET status='succeeded' WHERE id=$1", d.id)
    elif d.attempt + 1 < len(SCHEDULE_S):
        delay = SCHEDULE_S[d.attempt + 1] * random.uniform(0.9, 1.1)
        await db.execute("UPDATE deliveries SET attempt=attempt+1, status='retrying', "
                         "next_attempt_at = now() + make_interval(secs => $2) WHERE id=$1", d.id, delay)
    else:
        await db.execute("UPDATE deliveries SET status='failed' WHERE id=$1", d.id)
        await maybe_disable_endpoint(db, d.endpoint_id)` }]
    },
    {
      from: 'wk', to: 'db', label: 'UPDATE delivery',
      title: 'Persist the outcome',
      caption: 'The delivery row moves to retrying with its next attempt time. Every attempt is kept for the dashboard.',
      text: ['Keeping attempts in their own table makes the dashboard view ("attempt 3 of 8, 503, 10.0 s") one indexed query, and makes support conversations factual.'],
      payloadKind: 'Delivery row',
      payload: { id: 'dl_91f', message_id: 'msg_2Yh7', endpoint_id: 'we_4Kx', status: 'retrying', attempt: 1, next_attempt_at: '2026-11-25T09:30:06Z' }
    },
    {
      from: 'sched', to: 'q', label: 'due → re-enqueue', async: true,
      title: 'The retry scheduler re-queues due attempts',
      caption: 'Every few seconds the scheduler claims deliveries whose next_attempt_at has passed and queues them again.',
      text: ['Multiple scheduler instances can run safely thanks to `FOR UPDATE SKIP LOCKED`. The second attempt five seconds later gets a 200 and the delivery becomes `succeeded`.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
WITH due AS (
  SELECT id FROM deliveries
  WHERE status = 'retrying' AND next_attempt_at <= now()
  ORDER BY next_attempt_at LIMIT 500
  FOR UPDATE SKIP LOCKED)
UPDATE deliveries d SET status = 'queued' FROM due WHERE d.id = due.id
RETURNING d.id, d.endpoint_id, d.message_id, d.attempt;`
    },
    {
      from: 'sched', to: 'db', label: 'disable after days failing',
      title: 'Auto-disable endpoints that keep failing',
      caption: 'If every delivery to an endpoint has failed for days, the endpoint is disabled and the customer is emailed, so you stop spending resources on it.',
      text: ['Disabling is reversible: the customer fixes the server, re-enables the endpoint, and replays the failed messages from the dashboard.'],
      payloadKind: 'Endpoint update',
      payload: { id: 'we_4Kx', status: 'disabled', disabled_reason: 'all deliveries failed since 2026-11-22T09:00Z', notified: 'dev-team@shop.example' }
    },
    {
      from: 'dash', to: 'api', label: 'POST /messages/{id}/replay',
      title: 'The customer replays from the dashboard',
      caption: 'A replay creates a new delivery for the same message. The webhook-id stays the same, so a receiver that already processed it ignores it.',
      text: ['Replay is just "create a delivery row with status pending". Because the message id does not change, receivers stay idempotent even when a customer clicks replay twice.'],
      payloadKind: 'HTTP request',
      payload: { method: 'POST', path: '/v1/messages/msg_2Yh7/replay', body: { endpoint_id: 'we_4Kx' } }
    }
  ],
  api: [
    { verb: 'POST', path: '/v1/webhook-endpoints', desc: 'Register a URL and event types; returns the secret once.' },
    { verb: 'POST', path: '/v1/webhook-endpoints/{id}/rotate-secret', desc: 'New secret; the old one stays valid for 24 h so both signatures are sent.' },
    { verb: 'GET', path: '/v1/webhook-endpoints/{id}/deliveries?status=failed', desc: 'Delivery log with attempts.' },
    { verb: 'POST', path: '/v1/messages/{id}/replay', desc: 'Re-send one message to one or all endpoints.' },
    { verb: 'POST', path: '/v1/webhook-endpoints/{id}/test', desc: 'Send a sample event of a chosen type.' }
  ],
  schema: String.raw`
CREATE TABLE endpoints (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, url TEXT NOT NULL,
  events TEXT[] NOT NULL, secret_enc BYTEA NOT NULL, old_secret_enc BYTEA,
  status TEXT NOT NULL DEFAULT 'enabled', created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON endpoints (account_id) WHERE status = 'enabled';

CREATE TABLE messages (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, event_type TEXT NOT NULL,
  payload JSONB NOT NULL, source_event_id TEXT UNIQUE, created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE deliveries (
  id UUID PRIMARY KEY, message_id TEXT NOT NULL, endpoint_id TEXT NOT NULL,
  status TEXT NOT NULL, attempt INT NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ,
  UNIQUE (message_id, endpoint_id)
);
CREATE INDEX due_deliveries ON deliveries (next_attempt_at) WHERE status = 'retrying';

CREATE TABLE attempts (
  delivery_id UUID NOT NULL, n INT NOT NULL, status_code INT, duration_ms INT,
  excerpt TEXT, error TEXT, at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (delivery_id, n)
);`,
  decisions: [
    { q: 'How should customers authenticate your webhooks?', options: [
      { verdict: 'bad', name: 'A secret token in the URL query string', why: 'Ends up in logs and proxies, and proves nothing about the body.' },
      { verdict: 'good', name: 'HMAC of the body', why: 'Proves origin and integrity, but an attacker who captures one request can replay it later.' },
      { verdict: 'great', name: 'HMAC over id + timestamp + body, with a freshness window and id dedupe', why: 'Integrity, origin, replay protection and idempotency in one scheme. Optionally add asymmetric signatures so customers verify with a public key.' }
    ] },
    { q: 'How do you stop one dead endpoint from slowing everyone?', options: [
      { verdict: 'bad', name: 'Shared FIFO queue, long timeouts', why: 'Workers spend their time waiting on dead servers.' },
      { verdict: 'great', name: 'Per-endpoint lanes, per-endpoint concurrency caps, short timeouts, auto-disable', why: 'Bad endpoints only hurt themselves, and only for a bounded time.' }
    ] }
  ],
  refs: [
    { label: 'Standard Webhooks specification', url: 'https://www.standardwebhooks.com/', note: 'webhook-id, webhook-timestamp, webhook-signature.' },
    { label: 'Stripe: Receive webhook events', url: 'https://docs.stripe.com/webhooks', note: 'Signature checks, retries, best practices.' },
    { label: 'GitHub: Validating webhook deliveries', url: 'https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries' },
    { label: 'OWASP: Server-Side Request Forgery Prevention Cheat Sheet', url: 'https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html' }
  ]
});

flow({
  id: 'job-scheduler',
  title: 'Job scheduler and distributed cron',
  category: 'Messaging & events',
  tags: ['Cron', 'Time zones', 'SKIP LOCKED', 'Leases'],
  summary: '"Email me a report every Monday at 8:00 Brussels time." Follow a recurring job from creation to the time-zone-aware next run, a race-free claim by one of many schedulers, execution under a lease, a crashed worker, and the next occurrence.',
  requirements: {
    functional: [
      'Users and services create one-off jobs (run at a time) and recurring jobs (cron expression + time zone).',
      'Jobs run on a pool of workers; results and logs are visible per run.',
      'Jobs can be paused, resumed, run now, and cancelled.'
    ],
    nonFunctional: [
      'Each scheduled occurrence runs once in effect, even with several scheduler instances.',
      'A crashed worker\'s job is picked up again after its {{lease}} expires.',
      'Correct across daylight-saving changes and server time zones.',
      'Fire within a few seconds of the due time.'
    ]
  },
  estimates: [
    { label: 'Recurring jobs', value: '5 million', note: 'Assumption: one or two per active user.' },
    { label: 'Runs / day', value: '≈ 8 million', note: 'Most jobs run daily or weekly.' },
    { label: 'Peak per second', value: 'tens of thousands at :00', note: 'People pick round times. Spreading by a few seconds (jitter) flattens the spike.' }
  ],
  grid: { cols: 4, rows: 2 },
  nodes: [
    { id: 'app', label: 'Next.js app', sub: 'schedule form', kind: 'client', x: 0, y: 0, desc: 'Lets the user pick "every Monday at 08:00" and shows the next run in their own time zone.' },
    { id: 'api', label: 'Jobs API', sub: 'FastAPI', kind: 'service', x: 1, y: 0, desc: 'Validates the cron expression and time zone, computes the first `next_run_at` in UTC, stores the job.' },
    { id: 'db', label: 'Jobs DB', sub: 'PostgreSQL', kind: 'db', x: 2, y: 0, desc: 'The `jobs` table (definition + next_run_at) and the `job_runs` table (one row per occurrence, with a unique key that makes double-firing impossible).' },
    { id: 'sch', label: 'Schedulers ×3', sub: 'poll due jobs', kind: 'worker', x: 3, y: 0, icon: 'clock', desc: 'Stateless loops that claim due jobs from the database with `SKIP LOCKED`, create run rows, and enqueue them. Running three is for availability; the database prevents duplicates.' },
    { id: 'q', label: 'Run queue', sub: 'Redis Streams', kind: 'queue', x: 3, y: 1, desc: 'Buffer between "it is due" and "a worker is free". Absorbs the top-of-the-hour spike.' },
    { id: 'wk', label: 'Workers', sub: 'Python', kind: 'worker', x: 2, y: 1, desc: 'Execute jobs. Each holds a lease on its run and renews it with heartbeats while working.' },
    { id: 'mail', label: 'Report + email', sub: 'side effect', kind: 'external', x: 1, y: 1, icon: 'mail', desc: 'Whatever the job actually does. Here: build a PDF report and email it. Side effects must be idempotent per run id.' }
  ],
  steps: [
    {
      from: 'app', to: 'api', label: 'POST /jobs',
      title: 'The user schedules a weekly report',
      caption: 'The app sends a cron expression and an IANA time zone, not a UTC time. "08:00 in Brussels" is a different UTC hour in winter and in summer.',
      text: [
        'Storing "every Monday 07:00 UTC" would silently shift the report to 09:00 local in summer. The rule is: store the **intent** (cron + time zone), compute each concrete instant in UTC.',
        '`0 8 * * 1` is cron for minute 0, hour 8, any day of month, any month, Monday.'
      ],
      payloadKind: 'HTTP request',
      payload: { method: 'POST', path: '/v1/jobs', headers: { 'idempotency-key': 'f2c1...' }, body: { name: 'Weekly sales report', type: 'report.weekly_sales', cron: '0 8 * * 1', timezone: 'Europe/Brussels', args: { recipients: ['ops@shop.example'] }, misfire: 'run_once' } },
      fields: { timezone: 'An IANA name. Never an offset like +01:00, which ignores daylight saving.', misfire: 'What to do if runs were missed while the system was down: run once now, run all missed, or skip.' }
    },
    {
      from: 'api', to: 'db', label: 'INSERT job',
      title: 'Compute the next run in UTC and store it',
      caption: 'The API computes the next Monday 08:00 in Brussels, converts it to UTC, and stores it as next_run_at with an index for the scheduler.',
      text: [
        'Today is Wednesday, 25 November 2026. The next Monday is 30 November; Brussels is on winter time (UTC+1), so 08:00 local is **07:00 UTC**. In July the same job would fire at 06:00 UTC.',
        'Daylight-saving edge cases: a 02:30 local job on the spring-forward night has no 02:30; on the fall-back night 02:30 happens twice. A good scheduler documents its rule (commonly: run at the next valid time, and run only once on repeated times).'
      ],
      payloadKind: 'Job row',
      payload: { id: 'job_77', name: 'Weekly sales report', type: 'report.weekly_sales', cron: '0 8 * * 1', timezone: 'Europe/Brussels', next_run_at: '2026-11-30T07:00:00Z', status: 'active', version: 1 },
      fields: { next_run_at: 'Always UTC. Indexed. The scheduler only ever compares this to `now()`.', version: 'For {{optimistic locking}} when the user edits the job while it is being scheduled.' },
      code: [{ lang: 'python', title: 'Next occurrence with croniter + zoneinfo', src: String.raw`
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from croniter import croniter

def next_run_utc(cron: str, tz: str, after_utc: datetime) -> datetime:
    local_now = after_utc.astimezone(ZoneInfo(tz))
    nxt_local = croniter(cron, local_now).get_next(datetime)   # evaluated on the local clock
    return nxt_local.astimezone(timezone.utc)

next_run_utc("0 8 * * 1", "Europe/Brussels",
             datetime(2026, 11, 25, 9, 3, tzinfo=timezone.utc))
# -> 2026-11-30 07:00:00+00:00` }]
    },
    {
      from: 'sch', to: 'db', label: 'claim due (SKIP LOCKED)',
      title: 'Monday 07:00 UTC: one scheduler claims the job',
      caption: 'All three schedulers poll at once. FOR UPDATE SKIP LOCKED gives each row to exactly one of them; the others skip it instead of waiting.',
      text: [
        'In one transaction the scheduler selects due jobs, locks them, inserts a `job_runs` row per occurrence, and advances `next_run_at` to the following Monday. Commit.',
        'The run row has a unique key `(job_id, scheduled_for)`. Even if a bug let two schedulers through, the second insert would conflict. This is the **real** guarantee; the lock is the efficiency.',
        'No leader election needed: the database is the coordinator. That keeps the system simple until you reach a very large scale.'
      ],
      payloadKind: 'SQL transaction',
      payloadLang: 'sql',
      payload: String.raw`
BEGIN;
SELECT id, cron, timezone, next_run_at FROM jobs
WHERE status = 'active' AND next_run_at <= now()
ORDER BY next_run_at
LIMIT 200
FOR UPDATE SKIP LOCKED;                -- rows locked by another scheduler are skipped

INSERT INTO job_runs (id, job_id, scheduled_for, status)
VALUES ('run_5001', 'job_77', '2026-11-30T07:00:00Z', 'queued')
ON CONFLICT (job_id, scheduled_for) DO NOTHING;

UPDATE jobs SET next_run_at = '2026-12-07T07:00:00Z' WHERE id = 'job_77';
COMMIT;`,
      failure: ['**Scheduler crashes mid-transaction:** nothing commits and the locks are released; another scheduler claims the job a second later.', '**All schedulers were down for 3 hours:** on restart they find jobs far in the past. The `misfire` policy decides: `run_once` creates one run now and moves `next_run_at` into the future.']
    },
    {
      from: 'sch', to: 'q', label: 'XADD run', async: true,
      title: 'Enqueue the run',
      caption: 'The run id goes onto the queue. Workers pull at their own pace, so 50,000 jobs due at 07:00 don\'t need 50,000 workers.',
      text: ['If enqueueing fails after the commit, the run sits in `queued` without a message. A sweeper re-enqueues runs that have been `queued` for longer than a minute, which is why workers must check the run status before working.'],
      payloadKind: 'Queue message',
      payload: { stream: 'job-runs', id: '1764486000000-0', fields: { run_id: 'run_5001', job_id: 'job_77', type: 'report.weekly_sales' } }
    },
    {
      from: 'q', to: 'wk', label: 'XREADGROUP', async: true,
      title: 'A worker takes the run under a lease',
      caption: 'The worker marks the run as running with a lease that expires in 60 seconds, and renews it every 20 seconds while it works.',
      text: [
        'A {{lease}} is a lock with an expiry. If the worker dies, nobody renews it, and after 60 seconds the run is considered abandoned and can be retried.',
        'The update is conditional (`WHERE status = \'queued\'`) so two workers that both received the message cannot both start it.'
      ],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
UPDATE job_runs
SET status = 'running', worker_id = 'wk-12', started_at = now(),
    lease_until = now() + interval '60 seconds', attempt = attempt + 1
WHERE id = 'run_5001' AND status = 'queued'
RETURNING attempt;                                -- 0 rows = someone else has it

-- heartbeat every 20 s while working:
UPDATE job_runs SET lease_until = now() + interval '60 seconds'
WHERE id = 'run_5001' AND worker_id = 'wk-12';`,
      code: [{ lang: 'python', title: 'Run a job with a heartbeat task', src: String.raw`
async def execute(run_id: str):
    if not await claim(run_id, WORKER_ID):
        return                                        # another worker owns it
    hb = asyncio.create_task(heartbeat(run_id, every=20))
    try:
        result = await HANDLERS[run.type](run.args, run_id=run_id)
        await finish(run_id, "succeeded", result)
    except Exception as e:
        await finish(run_id, "failed", {"error": repr(e)[:500]})
        await maybe_retry(run_id)
    finally:
        hb.cancel()` }]
    },
    {
      from: 'wk', to: 'mail', label: 'build + send report',
      title: 'Do the work, idempotently',
      caption: 'The worker builds the report and sends the email, using the run id as the idempotency key for the email provider.',
      text: ['If this run is retried after a crash halfway, the email call with the same idempotency key (`run_5001`) is recognised and not sent twice. Every external side effect in a job should carry the run id for this reason.'],
      payloadKind: 'Side effect',
      payload: { to: ['ops@shop.example'], subject: 'Weekly sales: 23 to 29 November 2026', attachment: 'sales-2026-W48.pdf', idempotency_key: 'run_5001' }
    },
    {
      from: 'wk', to: 'db', label: 'run succeeded',
      title: 'Record success',
      caption: 'The run becomes succeeded with timings and output. The job history page reads these rows.',
      payloadKind: 'Run row',
      payload: { id: 'run_5001', job_id: 'job_77', scheduled_for: '2026-11-30T07:00:00Z', status: 'succeeded', attempt: 1, started_at: '2026-11-30T07:00:01Z', finished_at: '2026-11-30T07:00:19Z', output: { rows: 1842, email_id: 'em_8c1' } },
      text: ['Track the delay between `scheduled_for` and `started_at`. If it grows, you need more workers or the queue is stuck; it is the single best health metric for a scheduler.']
    },
    {
      from: 'sch', to: 'db', label: 'reap expired leases',
      title: 'What if a worker had died? The reaper',
      caption: 'A periodic query finds runs that are still running but whose lease expired, and puts them back to queued, up to a maximum number of attempts.',
      text: [
        'Leases turn "the worker might be dead" into a precise rule: no heartbeat for 60 seconds means dead. The tricky case is a worker that was only **paused** (a long garbage-collection pause) and wakes up after its lease expired while another worker already took the run. Guard side effects with the run id and finish with `WHERE worker_id = me` so the late worker\'s write is rejected. A stricter version uses a {{fencing token}}.'
      ],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
UPDATE job_runs
SET status = CASE WHEN attempt >= 3 THEN 'failed' ELSE 'queued' END,
    worker_id = NULL
WHERE status = 'running' AND lease_until < now()
RETURNING id, status;          -- re-enqueue the ones now 'queued'`
    }
  ],
  api: [
    { verb: 'POST', path: '/v1/jobs', desc: 'Create: `{type, cron | run_at, timezone, args, misfire}`. Returns the job with its first `next_run_at`.' },
    { verb: 'PATCH', path: '/v1/jobs/{id}', desc: 'Pause, resume, change schedule. Recomputes `next_run_at`.' },
    { verb: 'POST', path: '/v1/jobs/{id}/run-now', desc: 'Creates a run with `scheduled_for = now()` outside the schedule.' },
    { verb: 'GET', path: '/v1/jobs/{id}/runs', desc: 'History with status, durations, outputs.' }
  ],
  schema: String.raw`
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, type TEXT NOT NULL,
  cron TEXT, timezone TEXT NOT NULL DEFAULT 'UTC', run_at TIMESTAMPTZ,
  args JSONB NOT NULL DEFAULT '{}', misfire TEXT NOT NULL DEFAULT 'run_once',
  next_run_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'active', version INT NOT NULL DEFAULT 1
);
CREATE INDEX jobs_due ON jobs (next_run_at) WHERE status = 'active';

CREATE TABLE job_runs (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
  scheduled_for TIMESTAMPTZ NOT NULL, status TEXT NOT NULL,
  attempt INT NOT NULL DEFAULT 0, worker_id TEXT, lease_until TIMESTAMPTZ,
  started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, output JSONB,
  UNIQUE (job_id, scheduled_for)            -- one run per occurrence, ever
);
CREATE INDEX runs_expired ON job_runs (lease_until) WHERE status = 'running';`,
  decisions: [
    { q: 'How do you avoid two schedulers firing the same job?', options: [
      { verdict: 'bad', name: 'Only run one scheduler', why: 'A single point of failure: when it dies, nothing runs until someone notices.' },
      { verdict: 'good', name: 'Leader election (one active scheduler at a time)', why: 'Works, but adds a coordination system and failover gaps.' },
      { verdict: 'great', name: 'Many schedulers, database row locks with SKIP LOCKED, plus a unique run key', why: 'Active-active with no extra system. The unique key guarantees one run per occurrence even if locking is misused.' }
    ] },
    { q: 'How do you store the schedule time?', options: [
      { verdict: 'bad', name: 'A local time without zone, or a fixed UTC offset', why: 'Wrong by an hour for half of the year.' },
      { verdict: 'great', name: 'Cron + IANA time zone; each next run computed and stored in UTC', why: 'Correct across daylight saving, and the scheduler\'s hot query only compares UTC instants.' }
    ] }
  ],
  refs: [
    { label: 'PostgreSQL: SELECT ... FOR UPDATE SKIP LOCKED', url: 'https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE' },
    { label: 'Python zoneinfo', url: 'https://docs.python.org/3/library/zoneinfo.html', note: 'IANA time zones in the standard library.' },
    { label: 'Martin Kleppmann: How to do distributed locking', url: 'https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html', note: 'Leases, pauses and fencing tokens.' }
  ]
});
