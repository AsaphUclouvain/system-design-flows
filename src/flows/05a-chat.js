flow({
  id: 'chat-messaging',
  title: 'Real-time chat (WebSocket)',
  category: 'Real-time',
  tags: ['WebSocket', 'Redis Pub/Sub', 'Cassandra', 'Presence', 'Push'],
  summary: 'Ana sends "On my way!" to a group; it shows a single tick, then two, then blue, on every member\'s phone in under 200 ms. Persistent WebSocket connections, a connection registry, per-conversation ordering, offline delivery with push, and read receipts.',
  requirements: {
    functional: [
      'One-to-one and group conversations (up to 500 members) with text and attachments.',
      'Messages arrive in real time to online members; offline members get a push notification and see the message when they reconnect.',
      'Sent, delivered and read states; typing indicators; online presence.'
    ],
    nonFunctional: [
      'Delivery latency under 200 ms p95 when both users are online.',
      'No message is lost once the sender sees the single tick; order inside a conversation is preserved.',
      'Millions of concurrent connections.'
    ]
  },
  estimates: [
    { label: 'Concurrent connections', value: '10M', note: 'Assumption: 20% of 50M daily users online at peak.' },
    { label: 'Gateway servers', value: '≈ 100', note: 'About 100k idle WebSockets per well-tuned server (memory and file descriptors are the limit).' },
    { label: 'Messages', value: '≈ 230,000 / s', note: '50M users × 400 messages a day ÷ 86,400 s (peaks ×2).' },
    { label: 'Storage', value: '≈ 2 TB / day', note: '20B messages × about 100 bytes, before replication (×3).' }
  ],
  grid: { cols: 5, rows: 2 },
  nodes: [
    { id: 'ana', label: 'Ana\'s app', sub: 'Next.js PWA', kind: 'client', icon: 'phone', x: 0, y: 0, desc: 'The sender, online, with an open WebSocket to gateway A.' },
    { id: 'gwa', label: 'Gateway A', sub: 'FastAPI WS', kind: 'edge', icon: 'lb', x: 1, y: 0, desc: 'Holds Ana\'s socket. Gateways only move bytes and authenticate; no business logic.' },
    { id: 'chat', label: 'Chat service', sub: 'FastAPI', kind: 'service', x: 2, y: 0, desc: 'Validates membership, assigns the sequence number, stores the message, routes it.' },
    { id: 'store', label: 'Message store', sub: 'Cassandra', kind: 'db', x: 3, y: 0, desc: 'Messages partitioned by conversation, clustered by sequence: one partition read returns a page in order.' },
    { id: 'push', label: 'Push service', sub: 'APNs / FCM', kind: 'external', icon: 'bell', x: 4, y: 0, desc: 'Wakes offline members\' phones. Details in the notification flow.' },
    { id: 'reg', label: 'Session registry', sub: 'Redis', kind: 'cache', x: 2, y: 1, desc: 'user_id → gateway ids where that user has an open socket (one per device), with a TTL refreshed by heartbeats.' },
    { id: 'bus', label: 'Gateway bus', sub: 'Redis Pub/Sub', kind: 'queue', x: 3, y: 1, desc: 'One channel per gateway. The chat service publishes a message to the channel of each gateway that holds a recipient.' },
    { id: 'gwb', label: 'Gateway B', sub: 'FastAPI WS', kind: 'edge', icon: 'lb', x: 1, y: 1, desc: 'Holds Leo\'s socket. Subscribed to its own channel on the bus.' },
    { id: 'leo', label: 'Leo\'s app', sub: 'online', kind: 'client', icon: 'phone', x: 0, y: 1, desc: 'A group member who is online on another gateway.' },
    { id: 'sam', label: 'Sam\'s phone', sub: 'offline', kind: 'client', icon: 'phone', x: 4, y: 1, desc: 'A group member with no open socket: gets a push and syncs later.' }
  ],
  steps: [
    {
      from: 'ana', to: 'gwa', label: 'WS upgrade + auth',
      title: 'Ana\'s app opens a WebSocket',
      caption: 'When the app starts, it upgrades an HTTPS request to a WebSocket. The gateway checks the access token, then registers the socket in Redis.',
      text: ['A {{websocket}} is one long-lived TCP connection that both sides can write to at any time, so the server can push messages without the client polling. Browsers cannot set custom headers on WebSocket requests, so the token goes in a cookie or a short-lived ticket in the query string, never a long-lived token in the URL (URLs end up in logs).', 'The load balancer in front of the gateways must support long connections and spread new ones evenly; it does not need sticky sessions because each socket stays on the gateway that accepted it.'],
      payloadKind: 'HTTP upgrade',
      payloadLang: 'http',
      payload: String.raw`
GET /ws?ticket=wst_7Kq2… HTTP/1.1
Host: chat.example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13

HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`,
      fields: { ticket: 'One-time ticket from POST /v1/ws-ticket (valid 30 s), so the real token never appears in a URL.' },
      code: [{ lang: 'python', title: 'Gateway: accept, register, heartbeat', src: String.raw`
GATEWAY_ID = os.environ["GATEWAY_ID"]                      # e.g. "gw-a-07"
local: dict[str, set[WebSocket]] = defaultdict(set)        # user_id -> sockets on THIS gateway

@app.websocket("/ws")
async def ws(sock: WebSocket, ticket: str):
    user_id = await redeem_ticket(ticket)                  # GETDEL wst:{ticket}
    if not user_id:
        await sock.close(code=4401); return
    await sock.accept()
    local[user_id].add(sock)
    await redis.sadd(f"sess:{user_id}", GATEWAY_ID); await redis.expire(f"sess:{user_id}", 90)
    try:
        async for raw in sock.iter_text():
            frame = json.loads(raw)
            if frame["t"] == "ping":
                await redis.expire(f"sess:{user_id}", 90)  # heartbeat keeps presence alive
                await sock.send_text('{"t":"pong"}')
            else:
                await chat.handle(user_id, frame, reply=sock.send_text)
    finally:
        local[user_id].discard(sock)
        if not local[user_id]:
            await redis.srem(f"sess:{user_id}", GATEWAY_ID)` }],
      failure: ['**Gateway crashes:** its sockets drop; clients reconnect with backoff to another gateway and resync. Stale registry entries expire within 90 s thanks to the {{ttl}}.']
    },
    {
      from: 'ana', to: 'gwa', label: 'send frame',
      title: 'Ana sends a message',
      caption: 'The app writes a frame with a client-generated id and shows the message at once as "sending" (a clock icon).',
      text: ['The `client_msg_id` is the {{idempotency key}}. If the socket drops before the acknowledgement, the app resends the same frame after reconnecting and the server recognises it.'],
      payloadKind: 'WebSocket frame (client → server)',
      payload: { t: 'msg.send', client_msg_id: '01JDQ6X3K1V9Z8T2YQ7N4M5B6C', conversation_id: 'cnv_trip_ardennes', body: { type: 'text', text: 'On my way! 🚗 ETA 15 min' }, sent_at_client: '2026-11-25T10:52:03.120Z' },
      fields: { client_msg_id: 'A ULID made on the phone. Lets the app match the server\'s ack to the bubble it already drew.', sent_at_client: 'For display only. Ordering uses the server sequence, because phone clocks are wrong.' }
    },
    {
      from: 'gwa', to: 'chat', label: 'handle(msg.send)',
      title: 'The chat service checks and orders the message',
      caption: 'The service checks that Ana is a member, deduplicates on client_msg_id, and takes the next sequence number for this conversation.',
      text: ['Ordering is per conversation, not global. An atomic `INCR` on a per-conversation counter in Redis gives a gap-free, increasing `seq`. Members sort and page by seq, and a client that sees seq 41 then 43 knows it missed 42 and fetches it.'],
      payloadKind: 'Enriched message',
      payload: { conversation_id: 'cnv_trip_ardennes', seq: 4812, message_id: 'msg_01JDQ6X3M8', client_msg_id: '01JDQ6X3K1V9Z8T2YQ7N4M5B6C', sender_id: 'usr_ana', body: { type: 'text', text: 'On my way! 🚗 ETA 15 min' }, server_ts: '2026-11-25T10:52:03.161Z' },
      fields: { seq: 'Added here. INCR conv_seq:cnv_trip_ardennes → 4812.', message_id: 'Added here. Server id used everywhere after this step.', server_ts: 'Added here. The authoritative time shown in the chat.' },
      code: [{ lang: 'python', title: 'Chat service: accept a message', src: String.raw`
async def handle_send(user_id: str, f: dict, reply):
    conv = f["conversation_id"]
    if not await is_member(conv, user_id):                     # cached member set
        return await reply(json.dumps({"t": "error", "code": "not_member"}))
    dedupe_key = f"cmid:{user_id}:{f['client_msg_id']}"
    if (prev := await redis.get(dedupe_key)):                  # resend after reconnect
        return await reply(prev)
    seq = await redis.incr(f"conv_seq:{conv}")
    msg = Message(conversation_id=conv, seq=seq, message_id=new_id("msg"),
                  client_msg_id=f["client_msg_id"], sender_id=user_id,
                  body=f["body"], server_ts=utcnow())
    await store.insert(msg)                                    # durable before ack
    ack = json.dumps({"t": "msg.ack", "client_msg_id": msg.client_msg_id, "seq": seq,
                      "message_id": msg.message_id, "server_ts": msg.server_ts.isoformat()})
    await redis.set(dedupe_key, ack, ex=86400)
    await reply(ack)                                           # single tick
    asyncio.create_task(route(msg))                            # fan-out to members` }],
      failure: ['**Redis counter lost (failover):** the counter is rebuilt from `max(seq)` in the store before accepting writes for that conversation; never hand out a seq that may already exist.']
    },
    {
      from: 'chat', to: 'store', label: 'INSERT message',
      title: 'Store it durably before acknowledging',
      caption: 'The message is written to Cassandra with quorum consistency. Only after the write succeeds does Ana get her single tick.',
      text: ['Partition key `conversation_id`, clustering key `seq` descending: opening a chat reads the newest 50 rows from one partition, already sorted. Very busy group chats can split the partition by time bucket (for example by month) so no partition grows without bound.', 'Writing with `QUORUM` on a replication factor of 3 means 2 replicas confirmed it; a single node failure loses nothing ({{quorum}}).'],
      payloadKind: 'CQL',
      payloadLang: 'sql',
      payload: String.raw`
INSERT INTO messages (conversation_id, seq, message_id, sender_id, body, server_ts)
VALUES ('cnv_trip_ardennes', 4812, 'msg_01JDQ6X3M8', 'usr_ana',
        '{"type":"text","text":"On my way! ETA 15 min"}', '2026-11-25 10:52:03.161+0000')
USING TTL 0;                       -- CONSISTENCY QUORUM`,
      failure: ['**Write times out:** no ack is sent; the app keeps the clock icon and resends the same client_msg_id. The dedupe key (or a lookup by client_msg_id) prevents a double message.']
    },
    {
      from: 'chat', to: 'ana', label: 'msg.ack (single tick)', reply: true,
      title: 'Ana sees one tick',
      caption: 'The ack travels back through gateway A. The app replaces the clock with one tick and stores seq 4812 locally.',
      payloadKind: 'WebSocket frame (server → client)',
      payload: { t: 'msg.ack', client_msg_id: '01JDQ6X3K1V9Z8T2YQ7N4M5B6C', message_id: 'msg_01JDQ6X3M8', seq: 4812, server_ts: '2026-11-25T10:52:03.161Z' },
      text: ['The ack is drawn going straight to the app; physically it goes through [[gwa]] on the same socket.']
    },
    {
      from: 'chat', to: 'reg', label: 'where are members?',
      title: 'Find which gateways hold each member',
      caption: 'One pipelined lookup returns the gateways for every member. Leo is on gateway B; Sam has no entry, so he is offline.',
      payloadKind: 'Redis pipeline',
      payloadLang: 'redis',
      payload: String.raw`
SMEMBERS sess:usr_leo   → {"gw-b-12"}
SMEMBERS sess:usr_sam   → (empty)          -- offline
SMEMBERS sess:usr_ana   → {"gw-a-07", "gw-c-03"}   -- also her laptop`,
      text: ['The sender is included: her laptop on gateway C should show the message too. Group by gateway, so a gateway holding 40 members of one group gets one publish, not 40.'],
      code: [{ lang: 'python', title: 'Routing', src: String.raw`
async def route(msg: Message):
    members = await member_ids(msg.conversation_id)            # up to 500
    pipe = redis.pipeline(transaction=False)
    for uid in members:
        pipe.smembers(f"sess:{uid}")
    by_gateway, offline = defaultdict(list), []
    for uid, gws in zip(members, await pipe.execute()):
        if not gws and uid != msg.sender_id:
            offline.append(uid)
        for gw in gws:
            by_gateway[gw.decode()].append(uid)
    frame = msg.to_frame()                                     # {"t": "msg.new", ...}
    for gw, uids in by_gateway.items():
        await redis.publish(f"gw:{gw}", json.dumps({"to": uids, "frame": frame}))
    if offline:
        await push_queue.enqueue("chat.offline", {"user_ids": offline, "message_id": msg.message_id})` }]
    },
    {
      from: 'chat', to: 'bus', label: 'PUBLISH gw:gw-b-12',
      title: 'Publish to the gateways that hold recipients',
      caption: 'One publish per gateway, carrying the list of local recipients and the message frame.',
      text: ['{{pub/sub}} is fire-and-forget: if gateway B is restarting at that moment, the publish is lost. That is acceptable because the message is already stored; clients detect the gap in `seq` and fetch it. Real-time delivery is an optimisation on top of a durable store, not the source of truth.'],
      payloadKind: 'Pub/Sub message',
      payload: { channel: 'gw:gw-b-12', data: { to: ['usr_leo'], frame: { t: 'msg.new', conversation_id: 'cnv_trip_ardennes', seq: 4812, message_id: 'msg_01JDQ6X3M8', sender: { id: 'usr_ana', name: 'Ana' }, body: { type: 'text', text: 'On my way! 🚗 ETA 15 min' }, server_ts: '2026-11-25T10:52:03.161Z' } } }
    },
    {
      from: 'bus', to: 'gwb', label: 'subscriber callback',
      title: 'Gateway B receives it',
      caption: 'Gateway B is subscribed to its own channel. It looks up Leo\'s sockets in its local map and writes the frame to each.',
      code: [{ lang: 'python', title: 'Gateway: deliver from the bus', src: String.raw`
async def bus_listener():
    ps = redis.pubsub()
    await ps.subscribe(f"gw:{GATEWAY_ID}")
    async for m in ps.listen():
        if m["type"] != "message":
            continue
        data = json.loads(m["data"])
        text = json.dumps(data["frame"])
        for uid in data["to"]:
            for sock in list(local.get(uid, ())):
                try:
                    await asyncio.wait_for(sock.send_text(text), timeout=2)
                except Exception:
                    await sock.close()                     # slow or dead client: drop it, it will resync` }],
      text: ['A client on a bad network can stop reading. Without the timeout, its socket buffer grows and one slow phone slows the whole gateway ({{backpressure}}). Dropping the connection is the safe choice: the client resyncs from the store.'],
      payloadKind: 'Local delivery',
      payload: { gateway: 'gw-b-12', recipients: ['usr_leo'], sockets_found: 1, write_ms: 0.4 }
    },
    {
      from: 'gwb', to: 'leo', label: 'msg.new',
      title: 'Leo\'s app shows the message',
      caption: 'Leo\'s app checks the seq (4811 was the last one it had, so no gap), shows the bubble, and sends back a delivered receipt.',
      payloadKind: 'Frames',
      payload: { received: { t: 'msg.new', conversation_id: 'cnv_trip_ardennes', seq: 4812, message_id: 'msg_01JDQ6X3M8' }, sent_back: { t: 'receipt', conversation_id: 'cnv_trip_ardennes', up_to_seq: 4812, state: 'delivered' } },
      text: ['The app renders from its local database (IndexedDB in a PWA), so the conversation also works offline and opening it later costs no request.'],
      fields: { 'sent_back.up_to_seq': 'Receipts are cumulative: "I have everything up to 4812". One small write per member instead of one per message.' },
      code: [{ lang: 'ts', title: 'Client: apply incoming messages with gap detection', src: String.raw`
function onFrame(f: ServerFrame) {
  if (f.t !== 'msg.new') return;
  const conv = store.conversations[f.conversation_id];
  if (f.seq <= conv.lastSeq) return;                         // duplicate: ignore
  if (f.seq > conv.lastSeq + 1) {
    void syncRange(f.conversation_id, conv.lastSeq + 1);      // fetch the missing ones
  }
  conv.insert(f);                                            // kept sorted by seq
  conv.lastSeq = Math.max(conv.lastSeq, f.seq);
  ws.send(JSON.stringify({ t: 'receipt', conversation_id: f.conversation_id,
                           up_to_seq: conv.lastSeq, state: 'delivered' }));
}` }]
    },
    {
      from: 'chat', to: 'push', label: 'push for Sam', async: true,
      title: 'Offline members get a push notification',
      caption: 'Sam has no socket, so a push job is queued. The push contains a preview and the conversation id; the full message is fetched when he opens the app.',
      text: ['With end-to-end encryption the server cannot read the text, so the push carries only an encrypted payload or "New message", and the app decrypts on the device. The notification flow covers batching, quiet hours and token cleanup.', 'Muted conversations skip the push but still store the message.'],
      payloadKind: 'Push request (APNs)',
      payload: { device_token: '80f3…e1c9', headers: { 'apns-push-type': 'alert', 'apns-collapse-id': 'cnv_trip_ardennes' }, aps: { alert: { title: 'Trip to the Ardennes', body: 'Ana: On my way! 🚗 ETA 15 min' }, 'thread-id': 'cnv_trip_ardennes', 'mutable-content': 1 }, conversation_id: 'cnv_trip_ardennes', seq: 4812 },
      fields: { 'headers.apns-collapse-id': 'Ten messages while Sam is offline replace each other on the lock screen instead of stacking.' }
    },
    {
      from: 'sam', to: 'store', label: 'sync since seq 4790',
      title: 'Sam reconnects and catches up',
      caption: 'When Sam opens the app it reconnects and asks for everything after the last seq it has for each conversation. One partition range read returns them in order.',
      text: ['This sync path is what makes the system reliable: Pub/Sub can drop messages, sockets can die, pushes can be throttled, and still nothing is lost because every client converges on the store by seq.', 'In production this goes through a gateway and the chat service; it is drawn straight to the store to show which data answers it.'],
      payloadKind: 'Sync request → CQL',
      payloadLang: 'sql',
      payload: String.raw`
-- frame from Sam: {"t":"sync","conversation_id":"cnv_trip_ardennes","after_seq":4790}
SELECT seq, message_id, sender_id, body, server_ts
FROM messages
WHERE conversation_id = 'cnv_trip_ardennes' AND seq > 4790
ORDER BY seq ASC LIMIT 200;          -- 22 rows, including 4812`
    },
    {
      from: 'leo', to: 'gwb', label: 'receipt: read',
      title: 'Leo reads it and Ana sees blue ticks',
      caption: 'When the chat is on screen, Leo\'s app sends a read receipt up to seq 4812. The service stores it and routes a receipt update to the sender\'s gateways, the same way as a message.',
      text: ['Read state is one row per (conversation, member): `last_read_seq`. Ana\'s app shows two blue ticks on a message when every member\'s last_read_seq has passed its seq (in large groups, apps usually show "read by 12" instead).', 'Typing indicators use the same route but are never stored: they are ephemeral and dropped if anything is slow.'],
      payloadKind: 'Receipt frames',
      payload: { from_leo: { t: 'receipt', conversation_id: 'cnv_trip_ardennes', up_to_seq: 4812, state: 'read' }, stored: 'UPDATE read_state SET last_read_seq = 4812 WHERE conversation_id = \'cnv_trip_ardennes\' AND user_id = \'usr_leo\'', to_ana: { t: 'receipt.update', conversation_id: 'cnv_trip_ardennes', user_id: 'usr_leo', read_up_to: 4812 } }
    }
  ],
  api: [
    { verb: 'POST', path: '/v1/ws-ticket', desc: 'Exchange the session for a 30-second WebSocket ticket.' },
    { verb: 'WS', path: '/ws', desc: 'Frames: msg.send, msg.ack, msg.new, receipt, typing, sync, ping/pong.' },
    { verb: 'GET', path: '/v1/conversations/{id}/messages?before_seq=&limit=50', desc: 'History pages for scrolling up.' },
    { verb: 'POST', path: '/v1/conversations', desc: 'Create a group with member ids.' }
  ],
  schema: String.raw`
-- Cassandra
CREATE TABLE messages (
  conversation_id text,
  seq            bigint,
  message_id     text,
  sender_id      text,
  body           text,          -- JSON, or ciphertext with E2EE
  server_ts      timestamp,
  PRIMARY KEY ((conversation_id), seq)
) WITH CLUSTERING ORDER BY (seq DESC);

CREATE TABLE read_state (
  conversation_id text, user_id text, last_read_seq bigint, last_delivered_seq bigint,
  PRIMARY KEY ((conversation_id), user_id)
);

-- Redis
-- sess:{user_id}          SET of gateway ids, TTL 90 s (heartbeat)
-- conv_seq:{conv_id}      counter
-- cmid:{user}:{client_id} cached ack for resends, TTL 1 day`,
  decisions: [
    { q: 'How does the server push messages to clients?', options: [
      { verdict: 'bad', name: 'Short polling every 2 s', why: 'Wasteful and still up to 2 s late.' },
      { verdict: 'good', name: 'Server-Sent Events + POST for sending', why: 'Simple and proxy-friendly, but one direction only; fine for notifications.' },
      { verdict: 'great', name: 'WebSocket', why: 'Bidirectional, low overhead per message; suited to chat, typing and receipts.' }
    ] },
    { q: 'How do you route a message to the right server?', options: [
      { verdict: 'bad', name: 'Broadcast every message to every gateway', why: 'Traffic grows with gateways × messages.' },
      { verdict: 'great', name: 'Session registry + per-gateway channel', why: 'Each message goes only to gateways that hold a recipient.' }
    ] },
    { q: 'How do you order messages?', options: [
      { verdict: 'bad', name: 'Client timestamps', why: 'Phone clocks drift; two members would see different orders.' },
      { verdict: 'great', name: 'Server sequence per conversation', why: 'One total order per chat, and gaps reveal missed messages.' }
    ] }
  ],
  refs: [
    { label: 'RFC 6455: The WebSocket Protocol', url: 'https://www.rfc-editor.org/rfc/rfc6455' },
    { label: 'FastAPI: WebSockets', url: 'https://fastapi.tiangolo.com/advanced/websockets/' },
    { label: 'Discord: How Discord stores trillions of messages', url: 'https://discord.com/blog/how-discord-stores-trillions-of-messages', note: 'Partitioning messages by channel and time bucket.' },
    { label: 'Redis: Pub/Sub', url: 'https://redis.io/docs/latest/develop/interact/pubsub/' }
  ]
});
