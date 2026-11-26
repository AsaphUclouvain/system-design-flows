flow({
  id: 'id-generation',
  title: 'Distributed ID generation (Snowflake-style)',
  category: 'Infrastructure foundations',
  tags: ['Snowflake IDs', 'Worker leases', 'Clock skew', 'Sortable IDs', 'UUIDv7 comparison'],
  summary: 'Every post, order and message needs a unique id, created by hundreds of servers without asking each other. Follow how a FastAPI instance gets a worker number, packs time, worker and a counter into 64 bits, survives 4,096 ids in one millisecond and a clock that jumps backwards, and why the ids sort by time.',
  requirements: {
    functional: [
      'Generate unique 64-bit ids on any server without a network call per id.',
      'Ids sort roughly by creation time, so "newest first" is an index scan.',
      'Given an id, recover when it was created (for debugging and partitioning).'
    ],
    nonFunctional: [
      'No duplicates, ever, even across restarts, clock adjustments and scaling events.',
      'Generating an id takes under a microsecond on average.',
      'Ids fit in a signed 64-bit integer (PostgreSQL BIGINT, Java long).'
    ]
  },
  estimates: [
    { label: 'Ids per worker', value: '4,096 / ms', note: '12-bit sequence: up to ~4 million ids per second per worker.' },
    { label: 'Workers', value: '1,024', note: '10-bit worker id. Enough for every pod across regions.' },
    { label: 'Lifetime', value: '≈ 69 years', note: '41 bits of milliseconds = 2.2 × 10^12 ms from the custom epoch (2024-01-01).' },
    { label: 'Size', value: '8 bytes', note: 'Half of a UUID; smaller indexes and foreign keys.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'pod', label: 'Orders API pod', sub: 'FastAPI', kind: 'service', icon: 'server', x: 0, y: 1, desc: 'Needs ids for new orders. Starts with no worker number.' },
    { id: 'coord', label: 'Coordinator', sub: 'etcd / Redis', kind: 'db', icon: 'lock', x: 1, y: 0, desc: 'Hands out worker numbers 0–1023 as leases.' },
    { id: 'gen', label: 'ID generator', sub: 'in-process', kind: 'worker', icon: 'hash', x: 1, y: 1, desc: 'A tiny library in the pod: time, worker id and sequence packed into 64 bits.' },
    { id: 'clock', label: 'System clock', sub: 'NTP-synced', kind: 'external', icon: 'clock', x: 1, y: 2, desc: 'Milliseconds since the epoch. Usually right, occasionally adjusted.' },
    { id: 'db', label: 'Orders table', sub: 'PostgreSQL', kind: 'db', x: 2, y: 1, desc: 'BIGINT primary key; ids arrive in nearly increasing order.' },
    { id: 'client', label: 'Next.js app', sub: 'browser', kind: 'client', x: 3, y: 1, desc: 'Displays the order and its id.' },
    { id: 'ops', label: 'Support tool', sub: 'id decoder', kind: 'client', icon: 'user', x: 3, y: 0, desc: 'Decodes an id into time and worker for debugging.' }
  ],
  steps: [
    {
      from: 'pod', to: 'coord', label: 'lease a worker id',
      title: 'The pod claims a worker number',
      caption: 'On start-up the pod needs a worker id no other running pod uses. It claims the first free one, 217, as a lease with a 30-second expiry that it renews every 10 seconds.',
      text: ['Two pods with the same worker id would generate identical ids in the same millisecond, so this lease is the one thing that must be right. A {{lease}} with expiry also frees numbers from crashed pods automatically.', 'The pod refuses to generate ids until it holds a lease, and stops immediately if renewal fails.'],
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
> SET idgen:worker:216 pod-orders-6b9f NX EX 30
(nil)                               -- taken
> SET idgen:worker:217 pod-orders-6b9f NX EX 30
OK                                  -- ours; renew every 10 s with a check-and-set`,
      code: [{ lang: 'python', title: 'Lease a worker id at start-up', src: String.raw`
async def acquire_worker_id(redis, pod: str) -> int:
    start = random.randrange(1024)                     # spread contention
    for i in range(1024):
        wid = (start + i) % 1024
        if await redis.set(f"idgen:worker:{wid}", pod, nx=True, ex=30):
            return wid
    raise RuntimeError("no free worker id")

RENEW = "if redis.call('GET', KEYS[1]) == ARGV[1] then " \
        "return redis.call('EXPIRE', KEYS[1], 30) else return 0 end"

async def keep_lease(redis, wid: int, pod: str, gen: "Snowflake"):
    while True:
        await asyncio.sleep(10)
        if not await redis.eval(RENEW, 1, f"idgen:worker:{wid}", pod):
            gen.disable()                              # lost it: stop issuing ids
            raise SystemExit("worker id lease lost")` }],
      failure: ['**Coordinator unreachable at start-up:** the pod fails its readiness check and gets no traffic; it retries. Already-running pods keep generating with their leases.', '**Renewal fails (network partition):** the pod disables generation before the 30 s expiry, so another pod can safely take 217 afterwards.']
    },
    {
      from: 'pod', to: 'gen', label: 'next_id()',
      title: 'A request needs an id',
      caption: 'A customer places an order. The handler calls next_id() in memory: no database sequence, no network call.',
      text: ['Generating ids in the application means the id is known before the INSERT, so it can go into the outbox event, logs and the response in the same transaction.'],
      payloadKind: 'Call',
      payload: { caller: 'POST /v1/orders', worker_id: 217, last_ms: 91536144177, sequence_in_ms: 3 },
      fields: { last_ms: 'Milliseconds since the custom epoch (2024-01-01T00:00:00Z) at the last id this worker issued.' }
    },
    {
      from: 'gen', to: 'clock', label: 'now() in ms',
      title: 'Read the clock',
      caption: 'The generator reads the current time in milliseconds and subtracts the custom epoch. It is the same millisecond as the previous id, so the sequence goes up instead.',
      text: ['A custom epoch (here 2024-01-01) instead of 1970 gives the 41-bit timestamp about 69 years of range starting from when the system was built.', 'The generator uses the wall clock (needed to decode real times), but compares against the last value it issued to detect jumps.'],
      payloadKind: 'Clock read',
      payload: { unix_ms: 1795603344177, epoch_ms: 1704067200000, since_epoch_ms: 91536144177, same_ms_as_last: true },
      failure: ['**Clock jumps backwards (NTP step, VM migration):** see the clock-skew step below.']
    },
    {
      from: 'gen', to: 'gen', label: 'pack 41 | 10 | 12 bits',
      title: 'Pack time, worker and sequence into 64 bits',
      caption: 'The id is three numbers side by side: 41 bits of milliseconds, 10 bits of worker id, 12 bits of sequence, plus a leading 0 sign bit. Put together they form one integer.',
      text: ['Uniqueness follows from the layout: two ids from different workers differ in the worker bits; two from the same worker differ in time or sequence.', 'Because time is in the high bits, ids sort by creation time across all workers, to within clock skew.'],
      payloadKind: 'Bit layout',
      payloadLang: 'text',
      payload: String.raw`
 sign  timestamp (41 bits, ms since 2024-01-01)   worker (10)   sequence (12)
  0    00001010101001111111110101011011100110001    0011011001    000000000100
       = 91536144177                                = 217         = 4

id = (91536144177 << 22) | (217 << 12) | 4
   = 383930415666167808 + 888832 + 4
   = 383930415667056644`,
      code: [{ lang: 'python', title: 'Snowflake generator', src: String.raw`
EPOCH_MS = 1704067200000          # 2024-01-01T00:00:00Z

class Snowflake:
    def __init__(self, worker_id: int):
        assert 0 <= worker_id < 1024
        self.worker, self.last, self.seq = worker_id, -1, 0
        self.lock = threading.Lock()
        self.enabled = True

    def next_id(self) -> int:
        with self.lock:
            if not self.enabled:
                raise RuntimeError("generator disabled")
            now = time.time_ns() // 1_000_000 - EPOCH_MS
            if now < self.last:                       # clock went backwards
                now = self._wait_or_fail(now)
            if now == self.last:
                self.seq = (self.seq + 1) & 0xFFF
                if self.seq == 0:                     # 4,096 used this ms
                    while now <= self.last:
                        now = time.time_ns() // 1_000_000 - EPOCH_MS
            else:
                self.seq = 0
            self.last = now
            return (now << 22) | (self.worker << 12) | self.seq` }]
    },
    {
      from: 'gen', to: 'gen', label: 'sequence overflow → wait',
      title: 'A burst: 4,096 ids in one millisecond',
      caption: 'A bulk import asks for 10,000 ids at once. After 4,096 ids in the same millisecond the 12-bit sequence would wrap to 0 and repeat, so the generator spins until the next millisecond.',
      text: ['The wait is under a millisecond, so even a large burst only slows down by a tiny amount. Wrapping instead of waiting would produce duplicates, the one thing an id generator must never do.'],
      payloadKind: 'Trace',
      payload: [
        { ms: 91536144178, seq: '0 → 4095', ids: 4096 },
        { ms: 91536144178, event: 'sequence exhausted: spin 0.31 ms' },
        { ms: 91536144179, seq: '0 → 4095', ids: 4096 },
        { ms: 91536144180, seq: '0 → 1807', ids: 1808, total: 10000 }
      ]
    },
    {
      from: 'clock', to: 'gen', label: 'clock stepped back 8 ms',
      title: 'The clock jumps backwards',
      caption: 'NTP corrects this machine\'s clock by stepping it back 8 ms. If the generator trusted the clock, it could reissue timestamps it already used and create duplicate ids.',
      text: ['{{clock skew}} and adjustments are normal. {{ntp}} usually slews the clock gradually, but large errors (or a VM paused and resumed) cause steps. The generator remembers the last millisecond it issued and never goes below it.', 'Small jumps (under ~10 ms): wait until the clock passes the last issued time. Large jumps: refuse and fail the readiness probe, so traffic moves to other pods while a human looks.'],
      payloadKind: 'Clock event',
      payload: { last_issued_ms: 91536144180, clock_now_ms: 91536144172, delta_ms: -8, action: 'wait 8 ms (below 10 ms threshold)', metric: 'idgen_clock_backwards_total{worker="217"} += 1' },
      code: [{ lang: 'python', title: 'Handling a backwards clock', src: String.raw`
def _wait_or_fail(self, now: int) -> int:
    behind = self.last - now
    if behind > 10:
        self.enabled = False                      # readiness probe now fails
        CLOCK_BACKWARDS_FATAL.inc()
        raise RuntimeError(f"clock moved back {behind} ms")
    CLOCK_BACKWARDS.inc()
    while now < self.last:                        # small jump: wait it out
        time.sleep((self.last - now) / 1000)
        now = time.time_ns() // 1_000_000 - EPOCH_MS
    return now` }]
    },
    {
      from: 'gen', to: 'db', label: 'INSERT id=383930415667056644',
      title: 'Insert with a nearly increasing key',
      caption: 'The order is inserted with its id as the primary key. Because ids grow with time, new rows land at the right edge of the B-tree index, like an auto-increment.',
      text: ['Random UUIDv4 keys insert all over the index, splitting pages and touching cold parts of it; time-ordered ids keep inserts in hot, cached pages. UUIDv7 gives the same time ordering in 128 bits if you prefer a standard format.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
INSERT INTO orders (id, user_id, total_minor, created_at)
VALUES (383930415667056644, 'usr_ana', 11700, now());

-- newest orders: no separate created_at index needed
SELECT id, total_minor FROM orders WHERE user_id = 'usr_ana'
ORDER BY id DESC LIMIT 20;`
    },
    {
      from: 'db', to: 'client', label: 'id as a string', reply: true,
      title: 'Send the id to the browser as a string',
      caption: 'The API returns the id as a JSON string, not a number. JavaScript numbers are doubles and lose precision above 2^53, which would silently change the last digits.',
      text: ['`JSON.parse` turns 383930415667056644 into 383930415667056640: the last digit changes because a double cannot hold it exactly. That bug shows up as "order not found" on the frontend. Pydantic can serialise BIGINT ids as strings for you.'],
      payloadKind: 'HTTP response',
      payload: { status: 201, body: { id: '383930415667056644', status: 'PENDING', total: 117.0 } },
      fields: { id: 'Always a string in JSON. Number.MAX_SAFE_INTEGER is 9007199254740991 (about 9 × 10^15); these ids are about 4 × 10^17.' },
      code: [{ lang: 'python', title: 'Pydantic: big ids as strings', src: String.raw`
from typing import Annotated
from pydantic import BaseModel, PlainSerializer

Id = Annotated[int, PlainSerializer(lambda v: str(v), return_type=str, when_used="json")]

class OrderOut(BaseModel):
    id: Id
    status: str
    total: float` }, { lang: 'ts', title: 'Frontend type', src: String.raw`
type Order = { id: string; status: "PENDING" | "CONFIRMED" | "FAILED"; total: number };
// never Number(order.id): compare and route with the string` }]
    },
    {
      from: 'ops', to: 'gen', label: 'decode id',
      title: 'Decode an id when debugging',
      caption: 'A support engineer pastes the id into the decoder. Shifting the bits back out gives the creation time to the millisecond and which worker created it.',
      text: ['This is surprisingly useful: logs, traces and data can be found from an id alone, and tables can be partitioned by the time inside the id.'],
      payloadKind: 'Decoded id',
      payload: { id: '383930415667056644', timestamp_ms: 91536144177, created_at: '2026-11-25T10:42:24.177Z', worker_id: 217, sequence: 4 },
      code: [{ lang: 'python', title: 'Decode', src: String.raw`
def decode(i: int) -> dict:
    ms = (i >> 22) + EPOCH_MS
    return {"created_at": datetime.fromtimestamp(ms / 1000, UTC).isoformat(),
            "worker_id": (i >> 12) & 0x3FF, "sequence": i & 0xFFF}` }]
    }
  ],
  api: [
    { verb: 'LIB', path: 'next_id() -> int', desc: 'In-process; no network call per id.' },
    { verb: 'GET', path: '/internal/ids/{id}/decode', desc: 'Time, worker and sequence of an id.' }
  ],
  schema: String.raw`
-- coordinator (Redis or etcd)
-- idgen:worker:{0..1023}  pod name, EX 30, renewed every 10 s

CREATE TABLE orders (
  id BIGINT PRIMARY KEY,            -- Snowflake id, time-ordered
  user_id TEXT NOT NULL, total_minor INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX ON orders (user_id, id DESC);`,
  decisions: [
    { q: 'Which id scheme?', options: [
      { verdict: 'ok', name: 'Database auto-increment', why: 'Simple and ordered, but every id needs the one database, and ids leak your order volume.' },
      { verdict: 'good', name: 'UUIDv4', why: 'Generated anywhere, but 16 bytes and random order hurts index locality.' },
      { verdict: 'good', name: 'UUIDv7', why: 'Time-ordered standard UUID, no coordination at all; 16 bytes.' },
      { verdict: 'great', name: 'Snowflake 64-bit with leased worker ids', why: 'Ordered, 8 bytes, decodable, millions per second per pod.' }
    ] },
    { q: 'How are worker ids assigned?', options: [
      { verdict: 'bad', name: 'Hash of hostname or IP', why: 'Two hosts can collide; nobody notices until duplicate keys appear.' },
      { verdict: 'great', name: 'Leases from a coordinator, generation stops if the lease is lost', why: 'Guaranteed unique among running pods.' }
    ] }
  ],
  refs: [
    { label: 'Twitter: Snowflake source code and README (2010 release)', url: 'https://github.com/twitter-archive/snowflake/tree/snowflake-2010' },
    { label: 'RFC 9562: UUID version 7', url: 'https://www.rfc-editor.org/rfc/rfc9562' },
    { label: 'MDN: Number.MAX_SAFE_INTEGER', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/MAX_SAFE_INTEGER' }
  ]
});
