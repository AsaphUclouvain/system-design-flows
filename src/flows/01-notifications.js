flow({
  id: 'notification-system',
  title: 'Notification system, end to end',
  category: 'Messaging & events',
  tags: ['Outbox', 'Kafka', 'APNs / FCM', 'Email', 'Retries'],
  summary: 'Alice comments on Bob\'s post. Follow that one click all the way to a push on Bob\'s phone and an email in his inbox: authentication, the transactional outbox, events, preferences, deduplication, channel queues, provider calls, retries and status tracking.',
  requirements: {
    functional: [
      'Any product event (comment, like, payment) can trigger a notification to one or many users.',
      'Channels: push (iOS and Android), email, in-app inbox. SMS is the same shape with another provider.',
      'Users choose per channel and per category, and can set {{quiet hours}}.',
      'Notifications can be sent now or scheduled for later.',
      'Every delivery has a status you can look up: queued, sent, delivered, failed.'
    ],
    nonFunctional: [
      'Never lose a notification the product meant to send: the event survives crashes ({{at-least-once}} delivery).',
      'Never spam: the same event must not produce two pushes ({{idempotency}} at every hop).',
      'The user action that triggers it stays fast: sending happens asynchronously, off the request path.',
      'One slow provider (email) must not delay another channel (push): separate queues and workers per channel.',
      'Respect provider limits and back off politely ({{exponential backoff}} with {{jitter}}).'
    ]
  },
  estimates: [
    { label: 'Daily active users', value: '10 million', note: 'Assumption for the exercise.' },
    { label: 'Notifications / day', value: '100 million', note: '10 per user per day on average, across all channels.' },
    { label: 'Average rate', value: '≈ 1,160 / s', note: '100M ÷ 86,400 s. Plan for peaks of 5–10× that, about 10,000 / s.' },
    { label: 'Delivery rows / day', value: '≈ 100 GB', note: '100M rows × about 1 KB each. Partition by day and drop old partitions.' }
  ],
  grid: { cols: 5, rows: 3 },
  nodes: [
    { id: 'app', label: 'Alice\'s app', sub: 'Next.js', kind: 'client', x: 0, y: 0, icon: 'phone', desc: 'The Next.js front end. It only knows the public API: it sends the comment and shows the result. It never talks to the notification system directly.' },
    { id: 'gw', label: 'API gateway', sub: 'auth · rate limit', kind: 'edge', x: 1, y: 0, desc: 'The single public entry point. It terminates TLS, checks the access token, applies {{rate limiting}}, attaches a request id and {{trace context}}, then forwards to the right internal service.' },
    { id: 'cmt', label: 'Comments API', sub: 'FastAPI', kind: 'service', x: 2, y: 0, desc: 'Owns comments. It does not send notifications itself: it records that something happened (an event) and lets the notification system react. This keeps the services decoupled.' },
    { id: 'cdb', label: 'Comments DB', sub: 'PostgreSQL + outbox', kind: 'db', x: 3, y: 0, desc: 'Stores comments and an `outbox` table. Writing the comment and the outbox row in one transaction is the {{outbox pattern}}: either both exist or neither does.' },
    { id: 'bus', label: 'Event log', sub: 'Kafka · comment.created', kind: 'queue', x: 4, y: 0, desc: 'A durable, ordered, replayable log of business events. Many consumers (notifications, search indexing, analytics) read the same event independently, each with its own {{consumer group}}.' },
    { id: 'ns', label: 'Notification service', sub: 'FastAPI consumer', kind: 'service', x: 4, y: 1, icon: 'bell', desc: 'The brain. It turns a business event into notifications: who should get it, on which channels, with which text, now or later. It does not talk to Apple or Google itself; channel workers do.' },
    { id: 'redis', label: 'Redis', sub: 'prefs · dedupe · limits', kind: 'cache', x: 4, y: 2, desc: 'Fast shared memory for three jobs: a {{cache-aside}} copy of user preferences, short-lived deduplication keys, and per-user rate-limit counters. Losing Redis degrades the system but never loses a notification, because PostgreSQL is the source of truth.' },
    { id: 'ndb', label: 'Notification DB', sub: 'PostgreSQL', kind: 'db', x: 3, y: 2, desc: 'Source of truth for notifications, deliveries (one row per channel), device tokens and preferences. Delivery status lives here so support can answer "did Bob get it?".' },
    { id: 'q', label: 'Channel queues', sub: 'push · email · sms', kind: 'queue', x: 3, y: 1, desc: 'One queue (topic) per channel. If the email provider slows down, only the email queue grows; push keeps flowing. Each queue has its own {{dead-letter queue}}.' },
    { id: 'pw', label: 'Push worker', sub: 'HTTP/2 client', kind: 'worker', x: 2, y: 1, desc: 'Stateless workers that take a push job, look up Bob\'s device tokens, call APNs (iOS) or FCM (Android), and record the result. Scale them by adding instances.' },
    { id: 'apns', label: 'APNs / FCM', sub: 'Apple · Google', kind: 'external', x: 1, y: 1, desc: 'Apple Push Notification service and Firebase Cloud Messaging. Only they can wake a phone. They accept the message, store it briefly if the phone is offline, and deliver it when it reconnects.' },
    { id: 'bob', label: 'Bob\'s phone', sub: 'iOS / Android', kind: 'client', x: 0, y: 1, icon: 'phone', desc: 'The recipient. The operating system shows the banner even when the app is closed; tapping it opens the deep link carried in the payload.' },
    { id: 'ew', label: 'Email worker', sub: 'templating · SMTP API', kind: 'worker', x: 2, y: 2, icon: 'mail', desc: 'Renders the HTML and plain-text email, adds unsubscribe headers, and calls the email provider. Email is slower and can be batched into digests.' },
    { id: 'ses', label: 'Email provider', sub: 'Amazon SES', kind: 'external', x: 1, y: 2, icon: 'mail', desc: 'Sends the email from authenticated domains (SPF, DKIM, DMARC) and reports bounces and complaints back through webhooks.' }
  ],
  steps: [
    {
      from: 'app', to: 'gw', label: 'POST /comments',
      title: 'Alice taps "Post"',
      caption: 'The Next.js app sends the comment to the public API with Alice\'s access token and an idempotency key.',
      text: [
        'This is the user input. The browser sends an HTTPS request to the [[gw]]. Two headers matter for everything that follows: `Authorization` proves who Alice is, and `Idempotency-Key` lets the server recognise a retry of the same click.',
        'The key is generated once per click on the client. If Alice\'s network drops after the server saved the comment but before the response arrived, the app retries with the **same** key and the server returns the saved result instead of creating a second comment, and therefore a second notification.'
      ],
      details: [
        'The {{jwt|access token}} is short-lived (minutes). The refresh token stays in an HttpOnly cookie that JavaScript cannot read.',
        'The idempotency key is a random UUID v4. It is not a security feature; it only identifies the attempt.',
        'The body carries only what the user typed plus ids. The server decides everything else (timestamps, author id) so the client cannot forge them.'
      ],
      payloadKind: 'HTTP request',
      payload: {
        method: 'POST',
        path: '/v1/posts/p_8812/comments',
        headers: {
          'authorization': 'Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0...',
          'idempotency-key': '5f0c2a8e-6c1b-4f7e-9a51-2f3d1c7b9e10',
          'content-type': 'application/json'
        },
        body: { text: 'Great photo! Where was this taken?', client_ts: '2026-11-25T14:05:09.120Z' }
      },
      fields: {
        'authorization': 'Signed access token. The gateway verifies the signature and expiry, then trusts the user id inside it.',
        'idempotency-key': 'Same value on every retry of this one click. The server stores it with the response for about 24 hours.',
        'client_ts': 'The client clock is only informative. The server sets the real `created_at`, because client clocks are wrong.'
      },
      code: [
        { lang: 'tsx', title: 'Next.js: post a comment with retry-safe key', src: String.raw`
'use client';
import { useRef, useState } from 'react';

export function CommentBox({ postId }: { postId: string }) {
  const [text, setText] = useState('');
  // One key per submit attempt, reused if we retry the same submit.
  const keyRef = useRef<string | null>(null);

  async function submit() {
    keyRef.current ??= crypto.randomUUID();
    const res = await fetchWithRetry('/api/v1/posts/' + postId + '/comments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': keyRef.current,
      },
      body: JSON.stringify({ text, client_ts: new Date().toISOString() }),
    });
    if (res.ok) { keyRef.current = null; setText(''); }
  }
  return <form action={submit}><textarea value={text} onChange={e => setText(e.target.value)} /></form>;
}

async function fetchWithRetry(url: string, init: RequestInit, tries = 3): Promise<Response> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, init);
      if (r.status < 500 || i === tries - 1) return r;   // only retry server errors
    } catch (e) { if (i === tries - 1) throw e; }        // network error: retry
    await new Promise(ok => setTimeout(ok, 2 ** i * 300 + Math.random() * 200));
  }
}` }
      ],
      failure: [
        '**Network drops after the server committed.** Without the idempotency key the retry would create a duplicate comment and a duplicate notification. With it, the server replays the first response.',
        '**Token expired.** The gateway answers `401`; the app silently refreshes the access token using the refresh cookie and retries once.'
      ]
    },
    {
      from: 'gw', to: 'cmt', label: 'verified + forwarded',
      title: 'The gateway authenticates, rate-limits, and forwards',
      caption: 'The gateway checks the token signature, applies a per-user rate limit, then forwards the request with the trusted user id and a trace id.',
      text: [
        'The [[gw]] does the work every service would otherwise repeat. It verifies the JWT signature with the identity provider\'s public key (fetched from its {{jwks}} endpoint and cached), checks `exp`, `iss` and `aud`, and rejects the request with `401` if anything is off.',
        'Then it applies a {{token bucket}} limit per user (for example 30 comments per minute) and forwards the request to the [[cmt]] over the private network, adding headers the internal service can trust.'
      ],
      details: [
        'The internal service trusts `x-user-id` only because it can be reached exclusively through the gateway (network policy or mutual TLS). Never trust that header on a public endpoint.',
        '`traceparent` follows the W3C {{trace context}} format, so every log line and span from here to Bob\'s phone shares one trace id.',
        'The raw token is usually still forwarded so services can check scopes themselves; that is defence in depth.'
      ],
      payloadKind: 'HTTP request (internal)',
      payload: {
        method: 'POST',
        path: '/v1/posts/p_8812/comments',
        headers: {
          'authorization': 'Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0...',
          'idempotency-key': '5f0c2a8e-6c1b-4f7e-9a51-2f3d1c7b9e10',
          'content-type': 'application/json',
          'x-user-id': 'u_alice',
          'x-request-id': 'req_01JDQ4M8V6',
          'traceparent': '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
        },
        body: { text: 'Great photo! Where was this taken?', client_ts: '2026-11-25T14:05:09.120Z' }
      },
      fields: {
        'x-user-id': 'Taken from the token\'s `sub` claim after the signature check. Services use this, not anything from the body.',
        'x-request-id': 'Unique per request; returned to the client so a support ticket can quote it.',
        'traceparent': 'version-traceid-spanid-flags. The trace id stays the same across every hop of this flow.'
      },
      code: [
        { lang: 'python', title: 'Verifying the JWT (what the gateway or a FastAPI dependency does)', src: String.raw`
import jwt                      # PyJWT
from jwt import PyJWKClient
from fastapi import Depends, HTTPException, Request

jwks = PyJWKClient("https://auth.example.com/.well-known/jwks.json")  # caches keys

def current_user(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "missing token")
    token = auth.removeprefix("Bearer ")
    try:
        key = jwks.get_signing_key_from_jwt(token).key   # picked by the 'kid' header
        claims = jwt.decode(token, key, algorithms=["RS256"],
                            audience="api.example.com",
                            issuer="https://auth.example.com/")
    except jwt.PyJWTError:
        raise HTTPException(401, "invalid token")
    return claims["sub"]` },
        { lang: 'redis', title: 'Per-user limit: fixed window, simplest version', src: String.raw`
# key = rl:{user}:{minute}; allow when the count is <= 30
INCR rl:u_alice:2026-11-25T14:05
EXPIRE rl:u_alice:2026-11-25T14:05 60 NX
# The token-bucket version (smoother) is in the "Rate limiter" flow.` }
      ],
      failure: [
        '**Invalid or expired token:** `401` with `WWW-Authenticate: Bearer error="invalid_token"`. The service is never called.',
        '**Over the limit:** `429 Too Many Requests` with a `Retry-After` header. Well-behaved clients wait that long.',
        '**Comments API down:** the gateway times out after a budget (say 3 s), may retry idempotent requests once on another instance, and otherwise returns `503`.'
      ]
    },
    {
      from: 'cmt', to: 'cdb', label: 'one transaction',
      title: 'Save the comment and the event in one transaction',
      caption: 'The Comments API inserts the comment and an outbox row in the same database transaction, so the event can never be lost or invented.',
      text: [
        'This is the most important reliability decision in the flow. The naive version saves the comment, then publishes to Kafka. If the process crashes between the two, the comment exists but nobody is ever notified. If you publish first and the insert fails, Bob is notified about a comment that does not exist. This is the {{dual write}} problem.',
        'The {{outbox pattern}} fixes it: the event is written as a row in the same PostgreSQL transaction as the comment. A separate relay publishes outbox rows later. The database guarantees both rows commit together or not at all.',
        'The idempotency key is stored too, with a unique constraint, so a retried request hits the constraint and returns the stored comment.'
      ],
      details: [
        'The event is self-contained: it carries the post owner id, so consumers don\'t have to call back into the Comments API to act on it.',
        'The outbox row gets its own `event_id` (a UUID). Every downstream deduplication uses this id.',
        'The aggregate id (`post_id`) is used as the Kafka key later, so all events of one post stay in order on one {{partition}}.'
      ],
      payloadKind: 'SQL transaction',
      payloadLang: 'sql',
      payload: String.raw`
BEGIN;

INSERT INTO comments (id, post_id, author_id, text, idempotency_key)
VALUES ('c_93a1', 'p_8812', 'u_alice', 'Great photo! Where was this taken?',
        '5f0c2a8e-6c1b-4f7e-9a51-2f3d1c7b9e10')
ON CONFLICT (author_id, idempotency_key) DO NOTHING
RETURNING id, created_at;          -- returns nothing on a retry

INSERT INTO outbox (event_id, aggregate_type, aggregate_id, event_type, payload)
VALUES ('evt_7d2e', 'post', 'p_8812', 'comment.created',
        '{"comment_id":"c_93a1","post_id":"p_8812","post_owner_id":"u_bob",
          "actor_id":"u_alice","actor_name":"Alice",
          "preview":"Great photo! Where was this taken?"}');

COMMIT;`,
      code: [
        { lang: 'python', title: 'FastAPI endpoint with the outbox write (SQLAlchemy 2, async)', src: String.raw`
@router.post("/v1/posts/{post_id}/comments", status_code=201)
async def create_comment(post_id: str, body: CommentIn,
                         user_id: str = Depends(current_user),
                         idem_key: str = Header(alias="Idempotency-Key"),
                         db: AsyncSession = Depends(get_db)):
    async with db.begin():                         # one transaction
        existing = await db.scalar(select(Comment).where(
            Comment.author_id == user_id, Comment.idempotency_key == idem_key))
        if existing:
            return CommentOut.model_validate(existing)   # replay, no new event

        post = await db.get(Post, post_id) or raise_404()
        comment = Comment(id=new_id("c"), post_id=post_id, author_id=user_id,
                          text=body.text, idempotency_key=idem_key)
        db.add(comment)
        db.add(Outbox(
            event_id=new_id("evt"), aggregate_type="post", aggregate_id=post_id,
            event_type="comment.created",
            payload={"comment_id": comment.id, "post_id": post_id,
                     "post_owner_id": post.owner_id, "actor_id": user_id,
                     "preview": body.text[:120]},
        ))
    return CommentOut.model_validate(comment)` }
      ],
      failure: [
        '**Crash before COMMIT:** nothing was written; the client retries with the same idempotency key and it works the second time.',
        '**Two concurrent retries:** both try to insert; the unique constraint on `(author_id, idempotency_key)` lets exactly one win. The loser reads the winner\'s row.'
      ]
    },
    {
      from: 'cmt', to: 'gw', label: '201 Created', reply: true,
      title: 'Alice gets her answer immediately',
      caption: 'The API answers 201 as soon as the transaction commits. Nothing about notifications is on Alice\'s critical path.',
      text: [
        'The response goes back through the [[gw]] to [[app]]. Total time is one database transaction, typically a few tens of milliseconds.',
        'Notice what did **not** happen: no call to Apple, no email rendering, no preference lookups. Those can take seconds and fail. Moving them behind the event log is what keeps posting fast and reliable.'
      ],
      payloadKind: 'HTTP response',
      payload: {
        status: 201,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req_01JDQ4M8V6', 'location': '/v1/comments/c_93a1' },
        body: { id: 'c_93a1', post_id: 'p_8812', author_id: 'u_alice', text: 'Great photo! Where was this taken?', created_at: '2026-11-25T14:05:09.412Z' }
      },
      fields: {
        'status': '201 Created, also on an idempotent replay (the stored response is returned as it was).',
        'location': 'Where the new resource lives, a REST convention for 201.',
        'created_at': 'Server time, authoritative. The client should display this one.'
      }
    },
    {
      from: 'cdb', to: 'bus', label: 'outbox relay', async: true,
      title: 'The relay publishes the event to Kafka',
      caption: 'A small relay process reads unpublished outbox rows and publishes them to the comment.created topic, then marks them published.',
      text: [
        'Two common ways to move outbox rows into Kafka: a polling relay (shown in the code) or {{cdc|change data capture}} with a tool such as Debezium that tails PostgreSQL\'s write-ahead log. CDC has lower latency and no polling load; polling is simpler to run.',
        'The relay may publish a row and crash before marking it published, so after a restart it publishes the same event again. That is fine and expected: the system is {{at-least-once}}, and every consumer deduplicates by `event_id`.'
      ],
      details: [
        '`FOR UPDATE SKIP LOCKED` lets several relay instances run without picking the same rows.',
        'Kafka message key = `post_id`, so all events for one post land on the same partition and stay in order.',
        'The producer uses `acks=all` and idempotence, so a broker hiccup doesn\'t create duplicates inside Kafka itself.'
      ],
      payloadKind: 'Kafka record',
      payload: {
        topic: 'comment.created',
        key: 'p_8812',
        headers: { 'event-id': 'evt_7d2e', 'traceparent': '00-4bf92f3577b34da6a3ce929d0e0e4736-7a3c11d9e2f40b18-01', 'schema-version': '1' },
        value: {
          event_id: 'evt_7d2e', type: 'comment.created', occurred_at: '2026-11-25T14:05:09.412Z',
          data: { comment_id: 'c_93a1', post_id: 'p_8812', post_owner_id: 'u_bob', actor_id: 'u_alice', actor_name: 'Alice', preview: 'Great photo! Where was this taken?' }
        }
      },
      fields: {
        'key': 'Decides the partition. Same key, same partition, guaranteed order for that post.',
        'event-id': 'The deduplication id for every consumer downstream.',
        'schema-version': 'Lets consumers handle old and new event shapes during a migration.'
      },
      code: [
        { lang: 'python', title: 'Polling outbox relay (aiokafka)', src: String.raw`
async def relay_forever(db_pool, producer: AIOKafkaProducer):
    while True:
        async with db_pool.acquire() as conn, conn.transaction():
            rows = await conn.fetch("""
                SELECT id, event_id, aggregate_id, event_type, payload, created_at
                FROM outbox
                WHERE published_at IS NULL
                ORDER BY id
                LIMIT 500
                FOR UPDATE SKIP LOCKED""")
            for r in rows:
                await producer.send_and_wait(
                    r["event_type"],                         # topic
                    key=r["aggregate_id"].encode(),
                    value=json.dumps({"event_id": r["event_id"], "type": r["event_type"],
                                      "occurred_at": r["created_at"].isoformat(),
                                      "data": json.loads(r["payload"])}).encode(),
                    headers=[("event-id", r["event_id"].encode())])
            if rows:
                await conn.execute("UPDATE outbox SET published_at = now() WHERE id = ANY($1)",
                                   [r["id"] for r in rows])
        if not rows:
            await asyncio.sleep(0.2)   # idle: poll a few times per second

# producer = AIOKafkaProducer(bootstrap_servers=..., acks="all", enable_idempotence=True)` }
      ],
      failure: [
        '**Kafka unavailable:** rows simply stay unpublished in the outbox and pile up. Nothing is lost; the relay retries and catches up when Kafka returns.',
        '**Relay crashes after publishing, before marking:** the same event is published twice. Consumers drop the duplicate by `event_id` (step 7).'
      ]
    },
    {
      from: 'bus', to: 'ns', label: 'consume', async: true,
      title: 'The notification service consumes the event',
      caption: 'The notification service reads comment.created as part of its consumer group and commits its offset only after the work is safely stored.',
      text: [
        'Kafka does not push; the [[ns]] polls. Each partition is read by exactly one instance in the consumer group, so adding instances (up to the number of partitions) spreads the load.',
        'The service commits its {{offset}} **after** it has stored the notification. If it crashes halfway, the event is read again after the restart. Committing before the work would risk losing it; committing after means possible duplicates, which step 7 removes.'
      ],
      details: [
        'Search indexing and analytics read the same topic with their own consumer groups, at their own pace. That is why a log beats calling each service directly.',
        'Poison events (that always crash the handler) are moved to a `comment.created.dlq` topic after a few attempts so they don\'t block the partition.'
      ],
      payloadKind: 'Event as the consumer sees it',
      payload: {
        topic: 'comment.created', partition: 7, offset: 1882734,
        key: 'p_8812',
        value: {
          event_id: 'evt_7d2e', type: 'comment.created', occurred_at: '2026-11-25T14:05:09.412Z',
          data: { comment_id: 'c_93a1', post_id: 'p_8812', post_owner_id: 'u_bob', actor_id: 'u_alice', actor_name: 'Alice', preview: 'Great photo! Where was this taken?' }
        }
      },
      fields: {
        'partition': 'Chosen by hashing the key. One consumer instance owns it at a time.',
        'offset': 'Position in the partition. The group commits it to say "done up to here".'
      },
      code: [
        { lang: 'python', title: 'Consumer loop with commit-after-processing', src: String.raw`
consumer = AIOKafkaConsumer(
    "comment.created", "like.created", "payment.succeeded",
    group_id="notification-service",
    enable_auto_commit=False,          # we decide when an event is done
    auto_offset_reset="earliest",
)
await consumer.start()
async for msg in consumer:
    event = json.loads(msg.value)
    try:
        await handle_event(event)              # steps 7-10, idempotent
    except RetryableError:
        await asyncio.sleep(1)
        consumer.seek(TopicPartition(msg.topic, msg.partition), msg.offset)
        continue                               # re-read the same event
    except Exception:
        await send_to_dlq(msg)                 # don't block the partition forever
    await consumer.commit()` }
      ],
      failure: [
        '**Consumer crashes:** the group rebalances and another instance takes the partition, starting from the last committed offset. Some events are processed twice; deduplication handles it.',
        '**Consumer too slow:** {{consumer lag}} grows. Alert on lag, add instances (up to the partition count), or speed up the handler.'
      ]
    },
    {
      from: 'ns', to: 'redis', label: 'dedupe + prefs',
      title: 'Deduplicate, load preferences, check limits',
      caption: 'One atomic SET NX drops duplicates. Bob\'s preferences come from a Redis cache in front of PostgreSQL. A counter caps how many pushes Bob gets per hour.',
      text: [
        'Three quick checks against [[redis]] before doing any real work:',
        '**1. Deduplication.** `SET dedupe:{event_id}:{user} 1 NX EX 86400` succeeds only the first time. If it returns nil, this event was already handled for Bob, so stop. It is a fast first line; the unique constraint in step 9 is the guarantee.',
        '**2. Preferences.** {{cache-aside}}: read `prefs:u_bob`; on a miss, load from [[ndb]] and cache it for 10 minutes. Changing a preference deletes the key, so the next read refreshes it.',
        '**3. Rate limit.** Nobody wants 40 pushes in an hour because a post went viral. Past a threshold, new comments are folded into a summary ("Alice and 12 others commented")'
      ],
      payloadKind: 'Redis commands',
      payloadLang: 'redis',
      payload: String.raw`
SET dedupe:evt_7d2e:u_bob 1 NX EX 86400      # -> OK   (first time: continue)
                                              # -> nil  (duplicate: stop here)
HGETALL prefs:u_bob
# 1) "push.comments"  2) "on"
# 3) "email.comments" 4) "digest_daily"
# 5) "quiet_hours"    6) "22:00-07:00"
# 7) "tz"             8) "Europe/Brussels"
# 9) "locale"        10) "en"

INCR nlimit:u_bob:push:2026-11-25T14           # -> 3 (pushes this hour)
EXPIRE nlimit:u_bob:push:2026-11-25T14 3600 NX`,
      code: [
        { lang: 'python', title: 'Dedupe and cache-aside preferences (redis-py asyncio)', src: String.raw`
async def first_time(r: Redis, event_id: str, user_id: str) -> bool:
    # True only for the first worker that sees this (event, user) pair
    return await r.set(f"dedupe:{event_id}:{user_id}", 1, nx=True, ex=86_400) is not None

async def get_prefs(r: Redis, db, user_id: str) -> dict:
    key = f"prefs:{user_id}"
    cached = await r.hgetall(key)
    if cached:
        return cached
    row = await db.fetchrow("SELECT * FROM notification_prefs WHERE user_id=$1", user_id)
    prefs = defaults() | (dict(row) if row else {})
    await r.hset(key, mapping=prefs)
    await r.expire(key, 600)            # 10 min; invalidated on change
    return prefs` }
      ],
      failure: [
        '**Redis down:** skip the fast dedupe (the database constraint still prevents duplicates), read preferences straight from PostgreSQL, and fail open on the rate limit. Slower, still correct.',
        '**Stale preferences:** Bob turned push off seconds ago. Deleting the cache key on every change keeps the window tiny; for strict cases, read from PostgreSQL.'
      ]
    },
    {
      from: 'ns', to: 'ns', label: 'build notification',
      title: 'Decide channels, timing and text',
      caption: 'The service resolves who gets it, which channels are allowed, whether quiet hours delay it, and renders localized text from a template.',
      text: [
        'Now the [[ns]] turns an event into a notification. The rules live in a template per event type: which channels it may use, its category (so preferences apply), its priority, and its text in each language.',
        'For Bob: push for comments is on; email for comments is set to a daily digest, so the email delivery is scheduled for his digest time instead of now. It\'s 15:05 in Brussels, outside his {{quiet hours}}, so push goes now.',
        'Never notify the actor about their own action: if Alice comments on her own post, the recipient list is empty and processing stops here.'
      ],
      details: [
        'Priority matters: a security alert ("new sign-in") ignores quiet hours and digests; a "someone liked your post" never does.',
        'Text is rendered per recipient locale. Untrusted user text (the comment preview) is truncated and escaped, never interpreted as template code.',
        'The `collapse_key` (`post:p_8812:comments`) lets the phone replace an older banner for the same post instead of stacking ten banners.',
        'For a post with a million followers this step is a {{fanout}}: the service would split recipients into batches and emit one job per batch instead of a loop that runs for minutes.'
      ],
      payloadKind: 'Notification (in memory)',
      payload: {
        notification_id: 'n_51f0',
        event_id: 'evt_7d2e',
        recipient_id: 'u_bob',
        category: 'comments',
        priority: 'normal',
        template: 'comment_created.v3',
        locale: 'en',
        title: 'Alice commented on your post',
        body: 'Great photo! Where was this taken?',
        deep_link: 'app://posts/p_8812?comment=c_93a1',
        collapse_key: 'post:p_8812:comments',
        channels: [
          { channel: 'push', send_at: '2026-11-25T14:05:09Z' },
          { channel: 'email', send_at: '2026-11-25T18:00:00Z', mode: 'digest_daily' },
          { channel: 'in_app', send_at: '2026-11-25T14:05:09Z' }
        ]
      },
      fields: {
        'priority': 'normal or high. High (security, payments) bypasses quiet hours and rate limits.',
        'deep_link': 'What the app opens when Bob taps the banner.',
        'collapse_key': 'Same key, newer message replaces the older one on the device.',
        'send_at': 'Push: now. Email: Bob\'s 19:00 digest (18:00 UTC). Quiet hours would move push to 07:00 local.'
      },
      code: [
        { lang: 'python', title: 'Planning channels with preferences and quiet hours', src: String.raw`
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

def plan_channels(tpl, prefs, now_utc: datetime) -> list[dict]:
    plans = []
    tz = ZoneInfo(prefs["tz"])
    for ch in tpl.channels:                          # e.g. ["push", "email", "in_app"]
        setting = prefs.get(f"{ch}.{tpl.category}", "on")
        if setting == "off":
            continue
        send_at = now_utc
        if setting == "digest_daily":
            send_at = next_local_time(now_utc, tz, time(19, 0))
        elif ch == "push" and tpl.priority != "high" and in_quiet_hours(now_utc, tz, prefs):
            send_at = quiet_hours_end(now_utc, tz, prefs)
        plans.append({"channel": ch, "send_at": send_at, "mode": setting})
    return plans

def next_local_time(now_utc, tz, t):
    local = now_utc.astimezone(tz)
    target = local.replace(hour=t.hour, minute=t.minute, second=0, microsecond=0)
    if target <= local:
        target += timedelta(days=1)
    return target.astimezone(ZoneInfo("UTC"))` }
      ],
      failure: [
        '**Template missing for this locale:** fall back to the default language rather than drop the notification, and log it.',
        '**Recipient deleted their account:** no recipient, nothing to send; the event is still committed as handled.'
      ]
    },
    {
      from: 'ns', to: 'ndb', label: 'INSERT deliveries',
      title: 'Store the notification and one delivery per channel',
      caption: 'One transaction writes the notification, a delivery row per channel and the in-app inbox entry. A unique constraint makes the whole step idempotent.',
      text: [
        'The [[ndb]] is the source of truth. A delivery row per channel tracks that channel\'s life: `scheduled` → `queued` → `sent` → `delivered`, or `failed`.',
        'The unique constraint on `(event_id, recipient_id)` is the real guarantee against duplicates: if a duplicate event slipped past Redis, the insert does nothing and processing stops.',
        'The in-app channel is "delivered" by this insert alone: Bob\'s bell icon reads from this table (and a live connection can push it instantly, see the Chat and Live updates flows).'
      ],
      details: [
        'Scheduled deliveries (the email digest at 18:00 UTC) stay in `scheduled` state. A scheduler polls `WHERE status=\'scheduled\' AND send_at <= now()` with `SKIP LOCKED` and enqueues them when due.',
        'The deliveries table is partitioned by day, so old rows are dropped by detaching a partition instead of a slow `DELETE`.'
      ],
      payloadKind: 'SQL transaction',
      payloadLang: 'sql',
      payload: String.raw`
BEGIN;
INSERT INTO notifications (id, event_id, recipient_id, category, template, title, body, deep_link)
VALUES ('n_51f0', 'evt_7d2e', 'u_bob', 'comments', 'comment_created.v3',
        'Alice commented on your post', 'Great photo! Where was this taken?',
        'app://posts/p_8812?comment=c_93a1')
ON CONFLICT (event_id, recipient_id) DO NOTHING
RETURNING id;                         -- nothing returned = duplicate, stop

INSERT INTO deliveries (id, notification_id, channel, status, send_at) VALUES
  ('d_push_01', 'n_51f0', 'push',   'queued',    '2026-11-25T14:05:09Z'),
  ('d_mail_01', 'n_51f0', 'email',  'scheduled', '2026-11-25T18:00:00Z'),
  ('d_inap_01', 'n_51f0', 'in_app', 'delivered', '2026-11-25T14:05:09Z');
COMMIT;`,
      code: [
        { lang: 'sql', title: 'Scheduler: claim due deliveries safely', src: String.raw`
-- Runs every few seconds on any number of scheduler instances.
WITH due AS (
  SELECT id FROM deliveries
  WHERE status = 'scheduled' AND send_at <= now()
  ORDER BY send_at
  LIMIT 1000
  FOR UPDATE SKIP LOCKED          -- two schedulers never claim the same row
)
UPDATE deliveries d SET status = 'queued', queued_at = now()
FROM due WHERE d.id = due.id
RETURNING d.id, d.notification_id, d.channel;
-- then publish one job per returned row (same outbox idea if you need it airtight)` }
      ],
      failure: [
        '**Database unavailable:** the handler raises a retryable error and does not commit the Kafka offset; the event is re-read once the database is back. No notification is lost.'
      ]
    },
    {
      from: 'ns', to: 'q', label: 'enqueue push job', async: true,
      title: 'Enqueue a job on the push queue',
      caption: 'A small job carrying only ids goes onto the push queue. Workers will look up everything else, so the job is cheap and never stale.',
      text: [
        'The job is deliberately thin: the delivery id plus what the worker needs to route it. The worker reads current data (device tokens, the rendered text) when it runs, so a job that waited in the queue never sends outdated tokens.',
        'Separate queues per channel isolate failures: an SES slowdown fills only the email queue. Priorities can be separate queues too (`push.high`, `push.normal`) so a security alert never waits behind a marketing blast.'
      ],
      payloadKind: 'Queue message',
      payload: {
        queue: 'notifications.push.normal',
        message_id: 'msg_a91c',
        body: { delivery_id: 'd_push_01', notification_id: 'n_51f0', recipient_id: 'u_bob', attempt: 0, not_after: '2026-11-26T14:05:09Z' },
        headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01' }
      },
      fields: {
        'delivery_id': 'The idempotency handle for the worker: it checks this row\'s status before sending.',
        'attempt': 'Incremented on every retry; past the maximum the job goes to the dead-letter queue.',
        'not_after': 'Past this time the notification is pointless ("Alice commented" a week later), so it\'s dropped instead of sent.'
      },
      code: [
        { lang: 'python', title: 'Enqueue with Redis Streams (a Kafka topic works the same way)', src: String.raw`
await r.xadd("notifications.push.normal", {
    "delivery_id": "d_push_01",
    "notification_id": "n_51f0",
    "recipient_id": "u_bob",
    "attempt": 0,
    "not_after": "2026-11-26T14:05:09Z",
}, maxlen=5_000_000, approximate=True)    # cap memory

# Workers read with a consumer group:
# XREADGROUP GROUP push-workers w-17 COUNT 50 BLOCK 5000 STREAMS notifications.push.normal >` }
      ]
    },
    {
      from: 'q', to: 'pw', label: 'XREADGROUP', async: true,
      title: 'A push worker picks up the job',
      caption: 'The worker claims the job, checks the delivery is still queued, and loads Bob\'s active device tokens.',
      text: [
        'The [[pw]] first re-checks the delivery row. If its status is already `sent` (a duplicate job, or a retry after a crash that happened right after sending) it acknowledges and stops. This check is what makes the worker idempotent.',
        'Bob has two devices: an iPhone (APNs token) and an Android tablet (FCM registration token). The worker sends to each and records a per-device result.'
      ],
      details: [
        'Device tokens are registered by the app at startup (`POST /v1/devices`) and can change at any time; always store the latest one.',
        'If the job isn\'t acknowledged within a timeout (the worker died), another worker reclaims it (`XAUTOCLAIM` in Redis Streams, visibility timeout in SQS).'
      ],
      payloadKind: 'Job + loaded data',
      payload: {
        delivery_id: 'd_push_01', notification_id: 'n_51f0', recipient_id: 'u_bob', attempt: 0,
        status_in_db: 'queued',
        devices: [
          { platform: 'ios', token: '80f3c2e1d7a4...9b2', app_version: '4.12.0' },
          { platform: 'android', token: 'fcm:dQw4w9WgXcQ:APA91bH...', app_version: '4.11.3' }
        ],
        title: 'Alice commented on your post', body: 'Great photo! Where was this taken?', deep_link: 'app://posts/p_8812?comment=c_93a1', collapse_key: 'post:p_8812:comments'
      },
      fields: {
        'status_in_db': 'Only `queued` proceeds. Anything else means another attempt already handled it.',
        'devices': 'One user, many devices. Each device gets its own provider call and its own result.'
      }
    },
    {
      from: 'pw', to: 'apns', label: 'HTTP/2 POST',
      title: 'Call APNs (and FCM for Android)',
      caption: 'The worker sends one HTTP/2 request per device. For Apple: the device token in the path, push metadata in apns-* headers, the visible content in the aps dictionary.',
      text: [
        'APNs uses HTTP/2 with a long-lived connection; the worker authenticates with a provider token (a JWT signed with the team\'s key, reused for up to an hour) in the `authorization` header.',
        'The headers carry routing and delivery policy: `apns-push-type: alert` for a visible notification, `apns-priority: 10` to deliver immediately, `apns-expiration` for how long Apple may keep trying if the phone is offline, `apns-collapse-id` so a newer banner replaces an older one, and `apns-topic` (the app\'s bundle id).',
        'For Android, the same content goes to FCM\'s HTTP v1 endpoint `POST /v1/projects/{project}/messages:send` as a `message` object with the registration `token`, a `notification` block and `data`.'
      ],
      details: [
        'Keep the payload small: APNs limits a regular notification payload to 4 KB. Send ids and a short preview, never the whole comment thread.',
        '`apns-id` is a UUID you can set yourself; Apple echoes it back, so it can serve as a correlation id in logs.',
        'Put custom keys (like `deep_link`) outside the `aps` dictionary; `aps` is reserved for Apple-defined keys.'
      ],
      payloadKind: 'HTTP/2 request to APNs',
      payload: {
        method: 'POST',
        path: '/3/device/80f3c2e1d7a4...9b2',
        headers: {
          'authorization': 'bearer eyJhbGciOiJFUzI1NiIsImtpZCI6IkFCQzEyMyJ9...',
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': '1764165909',
          'apns-collapse-id': 'post:p_8812:comments',
          'apns-topic': 'com.example.social',
          'apns-id': '9e2a4b1c-0d3f-4e6a-8b7c-5d4e3f2a1b0c'
        },
        body: {
          aps: { alert: { title: 'Alice commented on your post', body: 'Great photo! Where was this taken?' }, sound: 'default', 'thread-id': 'post:p_8812' },
          deep_link: 'app://posts/p_8812?comment=c_93a1',
          notification_id: 'n_51f0'
        }
      },
      fields: {
        'path': 'The device token goes in the URL path: one request per device.',
        'apns-push-type': '`alert` = visible banner. `background` = silent content update (must use priority 5).',
        'apns-priority': '10 = send immediately. 5 = may be delayed to save the phone\'s battery.',
        'apns-expiration': 'Unix seconds. Apple retries until then if the phone is offline; 0 means try once.',
        'apns-collapse-id': 'A newer notification with the same id replaces the old one on the device.',
        'apns-topic': 'Usually the app\'s bundle id.',
        'thread-id': 'Groups banners from the same post together in Notification Center.'
      },
      code: [
        { lang: 'python', title: 'Sending to APNs with httpx over HTTP/2', src: String.raw`
import httpx, time, jwt

APNS = "https://api.push.apple.com"          # sandbox: api.sandbox.push.apple.com
client = httpx.AsyncClient(http2=True, timeout=10)

def provider_token() -> str:
    # ES256 JWT, cache it and refresh every ~50 minutes (Apple rejects older than 1 hour)
    return jwt.encode({"iss": TEAM_ID, "iat": int(time.time())}, APNS_P8_KEY,
                      algorithm="ES256", headers={"kid": KEY_ID})

async def send_apns(token: str, n: dict) -> httpx.Response:
    return await client.post(f"{APNS}/3/device/{token}",
        headers={
            "authorization": f"bearer {cached(provider_token)}",
            "apns-push-type": "alert",
            "apns-priority": "10",
            "apns-expiration": str(int(time.time()) + 86_400),
            "apns-collapse-id": n["collapse_key"],
            "apns-topic": BUNDLE_ID,
        },
        json={"aps": {"alert": {"title": n["title"], "body": n["body"]},
                      "sound": "default", "thread-id": n["thread"]},
              "deep_link": n["deep_link"], "notification_id": n["id"]})` },
        { lang: 'json', title: 'The same notification for Android (FCM HTTP v1 body)', src: String.raw`
{
  "message": {
    "token": "dQw4w9WgXcQ:APA91bH...",
    "notification": { "title": "Alice commented on your post",
                      "body": "Great photo! Where was this taken?" },
    "data": { "deep_link": "app://posts/p_8812?comment=c_93a1", "notification_id": "n_51f0" },
    "android": { "collapse_key": "post:p_8812:comments", "priority": "high", "ttl": "86400s" }
  }
}` }
      ],
      failure: [
        '**Timeout or connection reset:** you don\'t know whether Apple received it. Retrying may show the banner twice, but `apns-collapse-id` makes the second one replace the first, so the user sees one. Accept that small risk; don\'t silently drop.'
      ]
    },
    {
      from: 'apns', to: 'bob', label: 'deliver to device', async: true,
      title: 'Apple wakes Bob\'s phone',
      caption: 'APNs delivers over its own persistent connection to the device. iOS shows the banner, even if the app is closed.',
      text: [
        'Every iPhone keeps one connection open to Apple; every Android phone keeps one to Google. That is why your server can\'t reach a phone directly and must go through [[apns]].',
        'If [[bob]] is offline, Apple stores the notification (only the latest one per app when several pile up) until `apns-expiration`. When the phone reconnects it gets the notification then.',
        'When Bob taps the banner, iOS launches the app and hands it the payload; the app reads `deep_link` and navigates to the comment. The app can also report "opened" back to your API for analytics.'
      ],
      payloadKind: 'What the app receives',
      payload: {
        aps: { alert: { title: 'Alice commented on your post', body: 'Great photo! Where was this taken?' }, sound: 'default', 'thread-id': 'post:p_8812' },
        deep_link: 'app://posts/p_8812?comment=c_93a1',
        notification_id: 'n_51f0'
      },
      fields: { 'notification_id': 'Sent back with the "opened" event so analytics can join opens to sends.' }
    },
    {
      from: 'apns', to: 'pw', label: '200 / 410', reply: true,
      title: 'Apple answers: accepted, or this token is dead',
      caption: 'APNs replies per request. 200 means accepted (not yet displayed). 410 means the token is no longer valid and must be deleted.',
      text: [
        'A `200` means Apple accepted the notification for delivery. It does not prove Bob saw it; true "delivered" and "opened" come from the app itself.',
        'The worker sorts every non-200 into one of three buckets, because each needs a different action: **retry later**, **fix and stop**, or **delete the token**.'
      ],
      details: [
        '`410 Unregistered`: the app was uninstalled or the token is no longer valid for the topic. Delete the token, or you keep paying to send into the void.',
        '`400 BadDeviceToken`: a malformed token or a sandbox token sent to production. Delete it.',
        '`429` (too many requests) and `5xx`: retry with exponential backoff and jitter.',
        '`403`: your provider token or certificate is wrong. Retrying won\'t help; alert the team.',
        'FCM reports the same situations as `UNREGISTERED` (delete the token), `QUOTA_EXCEEDED`, `UNAVAILABLE` and `INTERNAL` (retry with backoff), and `INVALID_ARGUMENT` (fix the request).'
      ],
      payloadKind: 'HTTP/2 responses',
      payload: {
        ios_response: { status: 200, headers: { 'apns-id': '9e2a4b1c-0d3f-4e6a-8b7c-5d4e3f2a1b0c' } },
        android_response: { status: 404, body: { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } } }
      },
      fields: {
        'ios_response': 'Accepted: mark this device as sent.',
        'errorCode': 'The tablet\'s app was uninstalled. Delete that FCM token; no retry.'
      },
      code: [
        { lang: 'python', title: 'Classify the result and retry with backoff and jitter', src: String.raw`
import random

RETRY = {429, 500, 502, 503, 504}
DEAD_TOKEN_REASONS = {"Unregistered", "BadDeviceToken", "DeviceTokenNotForTopic"}
MAX_ATTEMPTS = 6

async def handle_result(job, device, resp):
    if resp.status_code == 200:
        return "sent"
    reason = resp.json().get("reason", "") if resp.content else ""
    if resp.status_code == 410 or reason in DEAD_TOKEN_REASONS:
        await db.execute("DELETE FROM device_tokens WHERE token=$1", device.token)
        return "dead_token"
    if resp.status_code in RETRY and job.attempt + 1 < MAX_ATTEMPTS:
        # "full jitter": random delay up to an exponentially growing cap
        delay = random.uniform(0, min(300, 2 ** job.attempt))
        await requeue(job | {"attempt": job.attempt + 1}, delay_s=delay)
        return "retrying"
    await dead_letter(job, reason=f"{resp.status_code} {reason}")
    return "failed"` }
      ],
      failure: [
        '**Retries exhausted:** the job goes to `notifications.push.dlq` with the last error. An alert fires when the DLQ grows; an operator can replay it after fixing the cause.',
        '**Provider outage:** every worker sees 5xx. Backoff with jitter keeps you from hammering Apple when it recovers; a {{circuit breaker}} can pause the queue entirely for a minute.'
      ]
    },
    {
      from: 'pw', to: 'ndb', label: 'UPDATE status',
      title: 'Record the outcome',
      caption: 'The worker updates the delivery row and the per-device attempts, then acknowledges the queue message. Only now is the job done.',
      text: [
        'Order matters: write the result to [[ndb]], **then** acknowledge the queue message. If the worker dies between the two, the job is redelivered, the worker sees status `sent` and just acknowledges. Acknowledging first could lose the record of what happened.',
        'Support can now answer "did Bob get it?" from one query, and dashboards can show send success rate per provider.'
      ],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
UPDATE deliveries
SET status = 'sent', sent_at = now(), attempts = attempts + 1,
    provider_ids = '{"ios":"9e2a4b1c-0d3f-4e6a-8b7c-5d4e3f2a1b0c"}'
WHERE id = 'd_push_01' AND status = 'queued';     -- guard against a racing duplicate

INSERT INTO delivery_attempts (delivery_id, device_token, attempt, outcome, http_status, at)
VALUES ('d_push_01', '80f3c2e1d7a4...9b2', 1, 'sent', 200, now()),
       ('d_push_01', 'dQw4w9WgXcQ:APA91bH...', 1, 'dead_token', 404, now());

-- then: XACK notifications.push.normal push-workers msg_a91c`,
      failure: [
        '**Both devices dead:** status becomes `failed` with reason `no_valid_devices`. The in-app inbox still has the notification, so Bob sees it next time he opens the app.'
      ]
    },
    {
      from: 'q', to: 'ew', label: '18:00 UTC digest', async: true,
      title: 'Later: the email digest job runs',
      caption: 'At Bob\'s digest time the scheduler queues his email delivery. The email worker gathers all of today\'s pending email items for Bob into one message.',
      text: [
        'Bob chose a daily digest for comment emails, so the scheduler (step 9) moved `d_mail_01` to `queued` at 18:00 UTC. The [[ew]] collects every scheduled email item for Bob today and renders one email instead of five.',
        'Before sending it checks suppression: has this address bounced permanently or complained (marked as spam)? If so, it never sends; sending to such addresses damages the domain\'s reputation with mailbox providers.'
      ],
      payloadKind: 'Email job',
      payload: {
        queue: 'notifications.email',
        body: { delivery_ids: ['d_mail_01', 'd_mail_02', 'd_mail_03'], recipient_id: 'u_bob', mode: 'digest_daily', attempt: 0 },
        loaded: { to: 'bob@example.org', suppressed: false, locale: 'en', items: 3, unsubscribe_token: 'ust_6Qh2...' }
      },
      fields: {
        'suppressed': 'True if the address hard-bounced or complained before. Then nothing is sent.',
        'unsubscribe_token': 'Signed token in the unsubscribe link, so one click works without logging in.'
      }
    },
    {
      from: 'ew', to: 'ses', label: 'SendEmail',
      title: 'Hand the email to the provider',
      caption: 'The worker calls the email provider\'s API with HTML and text versions, a one-click unsubscribe header, and tags for tracking.',
      text: [
        'Large senders must support one-click unsubscribe: a `List-Unsubscribe` header with an HTTPS URL plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). Mailbox providers show an "Unsubscribe" button that calls it.',
        'The sending domain must be authenticated with SPF and DKIM and have a DMARC policy, or major inboxes will mark the mail as spam or reject it.',
        'The provider answers with a message id quickly; actual delivery, bounces and complaints come later as webhooks.'
      ],
      payloadKind: 'Provider API request (illustrative)',
      payload: {
        from: 'Example <notify@mail.example.com>',
        to: ['bob@example.org'],
        subject: 'Alice and 2 others commented on your posts today',
        html: '<h1>Today on Example</h1> ...',
        text: 'Today on Example ...',
        headers: {
          'List-Unsubscribe': '<https://example.com/u/ust_6Qh2...>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        },
        tags: { category: 'comments_digest', delivery_ids: 'd_mail_01,d_mail_02,d_mail_03' }
      },
      fields: {
        'text': 'Always send a plain-text part too: some clients and screen readers prefer it.',
        'List-Unsubscribe-Post': 'Tells the mailbox provider the URL accepts a one-click POST without a confirmation page.',
        'tags': 'Come back in bounce and complaint webhooks so you can update the right delivery rows.'
      },
      code: [
        { lang: 'python', title: 'Unsubscribe endpoint that the one-click header calls (FastAPI)', src: String.raw`
@router.post("/u/{token}")
async def one_click_unsubscribe(token: str, db=Depends(get_db), r=Depends(get_redis)):
    user_id, category = verify_signed(token)         # HMAC-signed, no login needed
    await db.execute("""
        INSERT INTO notification_prefs (user_id, key, value) VALUES ($1, $2, 'off')
        ON CONFLICT (user_id, key) DO UPDATE SET value = 'off'""",
        user_id, f"email.{category}")
    await r.delete(f"prefs:{user_id}")               # invalidate the cache from step 7
    return Response(status_code=200)` }
      ]
    },
    {
      from: 'ses', to: 'bob', label: 'inbox', async: true,
      title: 'The email lands, and the feedback loop closes',
      caption: 'The provider delivers the email. Bounces and spam complaints come back as webhook events that update the deliveries table and the suppression list.',
      text: [
        'Delivery to Bob\'s inbox is asynchronous and can take seconds to minutes. The provider then emits events (delivery, bounce, complaint) that your API receives on a webhook endpoint.',
        'A **hard bounce** (address does not exist) or a **complaint** adds the address to the suppression list immediately. A **soft bounce** (mailbox full) is retried by the provider for a while.',
        'That closes the loop: every delivery now has a final, queryable status, and the system gets smarter about where not to send.'
      ],
      payloadKind: 'Webhook event (illustrative shape)',
      payload: {
        eventType: 'Bounce',
        mail: { messageId: '0100018c2f...', destination: ['bob@example.org'], tags: { delivery_ids: ['d_mail_01,d_mail_02,d_mail_03'] } },
        bounce: { bounceType: 'Permanent', bounceSubType: 'General', timestamp: '2026-11-25T18:00:04Z' }
      },
      fields: {
        'bounceType': 'Permanent = never send to this address again. Transient = temporary, may retry.',
        'tags': 'The tags you attached when sending, so the webhook handler knows which rows to update.'
      },
      failure: [
        '**Webhook endpoint down:** providers retry webhook delivery for a while, and your handler must be idempotent (the same event can arrive twice). Key it on the provider\'s event or message id.'
      ]
    }
  ],
  api: [
    { verb: 'POST', path: '/v1/posts/{post_id}/comments', desc: 'The triggering action. Requires `Idempotency-Key`. Returns 201 with the comment.' },
    { verb: 'POST', path: '/v1/devices', desc: 'The app registers or refreshes a push token: `{platform, token, app_version}`. Called on every app start.' },
    { verb: 'GET', path: '/v1/notifications?cursor=...', desc: 'In-app inbox, newest first, {{cursor pagination}}.' },
    { verb: 'POST', path: '/v1/notifications/{id}/read', desc: 'Mark one as read; also `POST /v1/notifications/read-all`.' },
    { verb: 'PUT', path: '/v1/notification-preferences', desc: 'Per channel and category: `{"push.comments":"on","email.comments":"digest_daily","quiet_hours":"22:00-07:00"}`. Deletes the Redis cache key.' },
    { verb: 'POST', path: '/internal/v1/notifications', desc: 'For services that want to notify directly (password reset) instead of via an event. Same idempotency rules.' },
    { verb: 'POST', path: '/webhooks/email-events', desc: 'Receives bounce, complaint and delivery events from the email provider. Verifies the signature first.' }
  ],
  schema: String.raw`
CREATE TABLE outbox (                                  -- in the Comments DB
  id            BIGSERIAL PRIMARY KEY,
  event_id      TEXT UNIQUE NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id  TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ
);
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;

CREATE TABLE notifications (                           -- Notification DB
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL,
  recipient_id  TEXT NOT NULL,
  category      TEXT NOT NULL,
  template      TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  deep_link     TEXT,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, recipient_id)                      -- the real dedupe guarantee
);
CREATE INDEX inbox ON notifications (recipient_id, created_at DESC);

CREATE TABLE deliveries (
  id              TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  channel         TEXT NOT NULL CHECK (channel IN ('push','email','sms','in_app')),
  status          TEXT NOT NULL,                        -- scheduled|queued|sent|delivered|failed
  send_at         TIMESTAMPTZ NOT NULL,
  attempts        INT NOT NULL DEFAULT 0,
  provider_ids    JSONB,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);                      -- one partition per day
CREATE INDEX due ON deliveries (send_at) WHERE status = 'scheduled';

CREATE TABLE device_tokens (
  token        TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  platform     TEXT NOT NULL,                           -- ios | android | web
  app_version  TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON device_tokens (user_id);

CREATE TABLE notification_prefs (
  user_id TEXT NOT NULL,
  key     TEXT NOT NULL,                                -- 'push.comments', 'quiet_hours', 'tz'
  value   TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);`,
  decisions: [
    {
      q: 'How does the comment service tell the notification system that something happened?',
      options: [
        { verdict: 'bad', name: 'Call the notification API synchronously inside the request', why: 'Alice waits on Apple and SES, and if the notification service is down, posting a comment fails. Two systems coupled by a network call.' },
        { verdict: 'good', name: 'Save, then publish to Kafka after commit', why: 'Fast for Alice, but a crash between commit and publish silently loses the notification (the dual-write problem).' },
        { verdict: 'great', name: 'Transactional outbox + relay or CDC', why: 'The event commits atomically with the comment and is published at least once. Consumers deduplicate by event id. Lossless and decoupled.' }
      ]
    },
    {
      q: 'How do you avoid sending the same push twice?',
      options: [
        { verdict: 'bad', name: 'Rely on exactly-once delivery from the queue', why: 'Across a queue, a database and an external HTTP call, there is no end-to-end exactly-once. Some hop will redeliver after a crash.' },
        { verdict: 'good', name: 'Redis SET NX on the event id', why: 'Cheap and catches nearly all duplicates, but keys expire and Redis can lose writes on failover.' },
        { verdict: 'great', name: 'Layered: Redis fast path, database unique constraint as the guarantee, status check in the worker, collapse id at the device', why: 'Each layer catches what the previous one misses. The one remaining gap (a timeout after Apple accepted) shows at most a replaced banner, never two.' }
      ]
    },
    {
      q: 'One queue for everything, or one per channel?',
      options: [
        { verdict: 'bad', name: 'One shared queue', why: 'An email provider slowdown makes every push wait behind it ({{head-of-line blocking}}).' },
        { verdict: 'great', name: 'One queue per channel, optionally per priority', why: 'Failures and backlogs stay contained; each channel scales its workers independently; security alerts never wait behind marketing.' }
      ]
    },
    {
      q: 'A celebrity with 10 million followers posts. Now what?',
      options: [
        { verdict: 'bad', name: 'Loop over 10 million followers inside one event handler', why: 'Runs for a long time, blocks the partition, and a crash restarts it from the beginning.' },
        { verdict: 'great', name: 'Fan out in batches', why: 'The handler emits jobs of, say, 1,000 recipients each with a cursor. Workers process batches in parallel, each idempotent, and low-priority broadcast queues never starve personal notifications.' }
      ]
    }
  ],
  refs: [
    { label: 'Apple: Sending notification requests to APNs', url: 'https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns', note: 'Headers, priorities, expiration, collapse id.' },
    { label: 'Apple: Handling notification responses from APNs', url: 'https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns', note: 'Status codes and reasons such as 410 Unregistered.' },
    { label: 'Firebase: FCM HTTP v1 error codes', url: 'https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode', note: 'UNREGISTERED, QUOTA_EXCEEDED, UNAVAILABLE and what to do.' },
    { label: 'microservices.io: Transactional outbox', url: 'https://microservices.io/patterns/data/transactional-outbox.html', note: 'The pattern behind step 3.' },
    { label: 'AWS Architecture Blog: Exponential backoff and jitter', url: 'https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/', note: 'Why "full jitter" beats plain backoff.' },
    { label: 'RFC 8058: One-click unsubscribe', url: 'https://www.rfc-editor.org/rfc/rfc8058', note: 'List-Unsubscribe-Post.' },
    { label: 'W3C Trace Context', url: 'https://www.w3.org/TR/trace-context/', note: 'The traceparent header.' }
  ]
});
