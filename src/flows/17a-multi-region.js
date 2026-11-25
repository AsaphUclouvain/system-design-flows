flow({
  id: 'multi-region',
  title: 'Multi-region replication and failover',
  category: 'Infrastructure foundations',
  tags: ['Active-passive database', 'Async replication', 'Read-your-writes', 'GeoDNS routing', 'Regional failover', 'RPO / RTO'],
  summary: 'The shop runs in Frankfurt and Virginia. Follow a write from a European user to the primary, its asynchronous trip across the Atlantic, an American user reading from the local replica while still seeing their own fresh writes, and then the whole Frankfurt region failing and traffic and the primary role moving to Virginia.',
  requirements: {
    functional: [
      'Users are served from the nearest region for low latency.',
      'A user always sees their own writes immediately, wherever they read.',
      'If a whole region fails, the service continues from the other region.'
    ],
    nonFunctional: [
      'Reads under 50 ms for users on both continents.',
      'RPO: lose at most a few seconds of writes in a regional disaster. RTO: back within 5 minutes.',
      'No split brain: never two regions accepting writes for the same data at once.'
    ]
  },
  estimates: [
    { label: 'Regions', value: '2', note: 'eu-central-1 (primary) and us-east-1 (standby + read replicas).' },
    { label: 'Transatlantic RTT', value: '≈ 90 ms', note: 'Frankfurt ↔ Virginia. Synchronous replication would add this to every commit.' },
    { label: 'Replication lag', value: '≈ 100–300 ms', note: 'Normal async lag across the Atlantic; alert above 5 s.' },
    { label: 'Write share', value: '≈ 5%', note: 'Of all requests. Reads dominate, which is why local read replicas pay off.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'eu_user', label: 'User in Brussels', sub: 'browser', kind: 'client', icon: 'phone', x: 0, y: 0, desc: 'Routed to Frankfurt.' },
    { id: 'us_user', label: 'User in Boston', sub: 'browser', kind: 'client', icon: 'phone', x: 0, y: 2, desc: 'Routed to Virginia.' },
    { id: 'dns', label: 'Global DNS', sub: 'latency routing', kind: 'edge', icon: 'globe', x: 0, y: 1, desc: 'Answers with the nearest healthy region; health checks remove a failed region.' },
    { id: 'eu_app', label: 'EU app', sub: 'Next.js + FastAPI', kind: 'service', x: 1, y: 0, desc: 'Full application stack in Frankfurt.' },
    { id: 'us_app', label: 'US app', sub: 'Next.js + FastAPI', kind: 'service', x: 1, y: 2, desc: 'Full application stack in Virginia; sends writes to the primary.' },
    { id: 'eu_db', label: 'EU primary', sub: 'PostgreSQL', kind: 'db', x: 2, y: 0, desc: 'Accepts all writes. Has a synchronous standby in another Frankfurt zone.' },
    { id: 'us_db', label: 'US replica', sub: 'PostgreSQL', kind: 'db', x: 2, y: 2, desc: 'Streams WAL asynchronously from Frankfurt; serves US reads; can be promoted.' },
    { id: 'ctl', label: 'Failover controller', sub: 'runbook automation', kind: 'worker', icon: 'shield', x: 3, y: 1, desc: 'Detects a regional outage, fences the old primary, promotes the replica and flips routing.' },
    { id: 's3', label: 'Object storage', sub: 'S3, replicated', kind: 'storage', x: 3, y: 0, desc: 'Images and files, replicated to the other region in the background.' }
  ],
  steps: [
    {
      from: 'eu_user', to: 'dns', label: 'A? api.shop.example',
      title: 'Route each user to the nearest region',
      caption: 'DNS with latency-based routing answers Brussels users with the Frankfurt load balancer and Boston users with Virginia. Health checks run from several locations every 10 seconds.',
      text: ['DNS answers have a short TTL (60 s) so that, in a failover, clients move to the other region quickly. Some resolvers ignore TTLs, which is one reason an anycast front door is often added in front.'],
      payloadKind: 'DNS answers',
      payloadLang: 'text',
      payload: String.raw`
; from a Brussels resolver
api.shop.example.  60  IN A  3.120.41.7     ; eu-central-1 ALB
; from a Boston resolver
api.shop.example.  60  IN A  44.198.12.90   ; us-east-1 ALB

health: eu-central-1 HEALTHY (3/3 checkers)  us-east-1 HEALTHY (3/3)`
    },
    {
      from: 'eu_app', to: 'eu_db', label: 'UPDATE address (COMMIT)',
      title: 'A European user writes',
      caption: 'The Brussels user changes their delivery address. The EU app writes to the primary in Frankfurt; the commit waits for the synchronous standby in another Frankfurt zone (2 ms), not for Virginia.',
      text: ['Synchronous inside the region, asynchronous across regions: losing one zone loses nothing, and commits do not pay the 90 ms transatlantic round trip.', 'The response returns the commit\'s {{lsn}} to the client in a cookie; that is what makes read-your-writes possible later.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
UPDATE addresses SET line1 = 'Rue de la Loi 16', city = 'Bruxelles', updated_at = now()
WHERE user_id = 'usr_ana' AND id = 'addr_33';
COMMIT;                                     -- waits for eu-central-1b standby (synchronous_commit = on)
SELECT pg_current_wal_lsn();                -- 3A/7F21C9B8  -> returned as cookie "rv"`,
      code: [{ lang: 'python', title: 'Write and remember the LSN', src: String.raw`
@router.patch("/v1/addresses/{aid}")
async def update_address(aid: str, body: AddressIn, resp: Response, user=Depends(current_user)):
    async with primary.acquire() as c, c.transaction():
        await c.execute(UPDATE_ADDRESS, body.line1, body.city, user.id, aid)
    lsn = await primary.fetchval("SELECT pg_current_wal_lsn()::text")
    resp.set_cookie("rv", lsn, max_age=60, httponly=True, secure=True, samesite="lax")
    return {"ok": True}` }]
    },
    {
      from: 'eu_db', to: 'us_db', label: 'WAL stream (async)', async: true,
      title: 'The change crosses the Atlantic',
      caption: 'The primary streams its write-ahead log to the Virginia replica, which replays it. Lag is usually 100–300 ms. The European user already got their answer.',
      text: ['{{replication lag}} is the cost of async replication: for a short window, Virginia has an older copy. It is also the {{rpo}}: if Frankfurt vanished now, the last ~200 ms of commits would be lost.'],
      payloadKind: 'Replication status',
      payload: { application_name: 'us-east-1-replica', state: 'streaming', sync_state: 'async', sent_lsn: '3A/7F21C9B8', replay_lsn: '3A/7F1E0040', replay_lag_ms: 212 },
      fields: { replay_lag_ms: 'How far behind the replica is in time. Alerting at 5 s keeps the RPO honest.' },
      failure: ['**Transatlantic link degraded:** lag grows; the primary keeps WAL around (replication slot) until the replica catches up. A max-slot-size guard prevents filling the primary\'s disk.']
    },
    {
      from: 'us_user', to: 'us_app', label: 'GET /v1/products',
      title: 'An American user arrives in Virginia',
      caption: 'The Boston resolver got the Virginia address, so the request lands in us-east-1, about 8 ms away instead of 90 ms to Frankfurt. The full app stack runs there too.',
      text: ['Every region runs the same Next.js and FastAPI deployment from the same images. Only the database role differs: Virginia has replicas, Frankfurt the primary.'],
      payloadKind: 'HTTP request',
      payload: { method: 'GET', path: '/v1/products?category=trail', served_by: 'us-east-1', client_rtt_ms: 8, headers: { 'CloudFront-Viewer-Country': 'US' } }
    },
    {
      from: 'us_app', to: 'us_db', label: 'read (local replica)',
      title: 'An American user reads locally',
      caption: 'A Boston user opens the product catalogue. The US app reads from the local replica in 2 ms instead of crossing the Atlantic (about 90 ms). A product edited 200 ms ago might still show its old version, which is acceptable here.',
      payloadKind: 'Query',
      payload: { region: 'us-east-1', target: 'local replica', query: 'SELECT … FROM products WHERE category = $1 LIMIT 40', took_ms: 2.3, staleness_bound: '≤ replication lag (≈ 0.2 s)' },
      text: ['Most reads tolerate a fraction of a second of staleness. The ones that do not are handled by routing rules, as the next step shows.']
    },
    {
      from: 'us_app', to: 'eu_db', label: 'write → EU primary',
      title: 'An American user writes: the write goes to Frankfurt',
      caption: 'The Boston user places an order. Writes must go to the single primary, so the US app sends this transaction to Frankfurt. It costs about 90 ms extra, paid only on writes.',
      text: ['One primary for all writes avoids conflicts entirely. The alternative, writing in both regions (multi-primary), needs conflict resolution for every table and is usually reserved for data that can be partitioned by home region.'],
      payloadKind: 'Write routing',
      payload: { region: 'us-east-1', target: 'eu-central-1 primary', statement: 'INSERT INTO orders …', network_rtt_ms: 88, commit_ms: 94, returned_lsn: '3A/7F2A0010' }
    },
    {
      from: 'us_app', to: 'us_db', label: 'read own write (wait LSN)',
      title: 'Read-your-writes after crossing regions',
      caption: 'The order confirmation page loads right after. The request carries the LSN of the order commit. The US app checks the local replica has replayed past it; it has not yet, so it waits up to 300 ms, then reads locally.',
      text: ['{{read-your-writes}} without sending every read to the primary: only this user\'s reads, only for a minute after their write, and only if the replica is behind their LSN. Everyone else reads freely.', 'If the wait would exceed 300 ms, the read goes to the primary instead, slower but correct.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
-- on the US replica
SELECT pg_last_wal_replay_lsn() >= '3A/7F2A0010'::pg_lsn;   -- false
-- ...poll every 20 ms...
SELECT pg_last_wal_replay_lsn() >= '3A/7F2A0010'::pg_lsn;   -- true after 140 ms
SELECT * FROM orders WHERE id = 'ord_8812';                 -- sees the new order`,
      code: [{ lang: 'python', title: 'Pick a connection for a read', src: String.raw`
async def read_conn(req: Request):
    rv = req.cookies.get("rv")                       # LSN of this user's last write
    if not rv:
        return local_replica
    deadline = time.monotonic() + 0.3
    while time.monotonic() < deadline:
        if await local_replica.fetchval("SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn", rv):
            return local_replica
        await asyncio.sleep(0.02)
    return primary                                   # still behind: read the source` }]
    },
    {
      from: 'eu_app', to: 's3', label: 'upload + CRR', async: true,
      title: 'Files replicate too',
      caption: 'An uploaded invoice PDF is stored in the Frankfurt bucket and copied to Virginia by cross-region replication, usually within seconds to minutes. Database rows referencing it can arrive before the file.',
      text: ['The app handles the gap: if a file is missing in the local bucket, it fetches it from the other region. Without this, a failover could show broken images for objects uploaded in the last minutes.'],
      payloadKind: 'Replication rule',
      payload: { source: 's3://shop-files-euc1', destination: 's3://shop-files-use1', status: 'Enabled', replication_time_control: '15 minutes SLA (99.99%)', object: 'invoices/ord_8812.pdf', replication_status: 'COMPLETED' }
    },
    {
      from: 'ctl', to: 'eu_db', label: 'region down: fence',
      title: 'Frankfurt fails',
      caption: 'A regional outage makes Frankfurt unreachable from health checkers on three continents for 2 minutes. The controller declares the region failed and first fences the old primary so it can never accept writes again, even if it comes back.',
      text: ['Fencing comes before promotion. Without it, a network partition could leave Frankfurt still accepting writes from some clients while Virginia accepts others: {{split brain}}, with two diverging histories.', 'Fencing here means revoking the EU database\'s credentials and security group access, and bumping an epoch number apps check before writing.'],
      payloadKind: 'Failover decision',
      payload: { detected_at: '2026-11-25T11:52:10Z', signals: { health_checks_failed: '9/9 checkers, 120 s', eu_api_5xx: 'no responses', replica_lag_s: 'stalled at 0.4 s' }, decision: 'regional failover to us-east-1', fencing: ['revoke app role on eu primary', 'security group: deny 5432', 'epoch 7 → 8 in global config'], approved_by: 'on-call (Sam), 11:53:02Z' },
      fields: { approved_by: 'Regional failover is automated but gated by one human confirmation, because a false positive is itself an outage.' }
    },
    {
      from: 'ctl', to: 'us_db', label: 'promote replica',
      title: 'Promote Virginia to primary',
      caption: 'The Virginia replica stops replaying, promotes itself, and starts accepting writes as the new primary on a new timeline. The last 0.4 s of Frankfurt commits that never arrived are lost: that is the RPO in action.',
      text: ['Lost commits are not silently forgotten: when Frankfurt returns, its WAL after the divergence point is compared, and those few transactions are listed for reconciliation (for example orders paid but not in the new primary).'],
      payloadKind: 'Promotion',
      payloadLang: 'text',
      payload: String.raw`
$ pg_ctl promote -D /var/lib/postgresql/data
waiting for server to promote.... done
server promoted

LOG:  selected new timeline ID: 9
LOG:  last replayed LSN 3A/7F3B2280  (approx. 0.4 s behind the old primary)
LOG:  database system is ready to accept connections`,
      failure: ['**Promotion fails:** a second replica in another US zone is promoted instead. Each region keeps at least two database nodes for this reason.']
    },
    {
      from: 'ctl', to: 'dns', label: 'EU → unhealthy',
      title: 'Route everyone to Virginia',
      caption: 'Frankfurt is marked unhealthy in DNS, so European users now get the Virginia address. The US apps switch their write connection to the local new primary through a config change keyed by the epoch.',
      text: ['Total time from detection to writes working again: about 4 minutes, within the 5-minute {{rto}}. European users see higher latency (about 90 ms more) until Frankfurt is restored.'],
      payloadKind: 'Routing change',
      payload: { dns: { 'eu-central-1': 'UNHEALTHY (forced)', 'us-east-1': 'HEALTHY' }, app_config: { epoch: 8, primary: 'us-east-1', read_replicas: ['us-east-1b'] }, ttl_s: 60, traffic_moved_after_s: 90 }
    },
    {
      from: 'eu_user', to: 'us_app', label: 'served from US',
      title: 'Europe is served from America, slower but up',
      caption: 'The Brussels user\'s next request lands in Virginia. Pages work, writes work. Later, Frankfurt is rebuilt as a replica of Virginia and, in a planned, quiet hour, the primary is switched back.',
      text: ['Failback is a planned switchover, not another emergency: replicate back, wait until lag is near zero, stop writes for a few seconds, promote, re-route.', 'Failover is practised regularly (game days). A failover path that has never run is a plan, not a capability.'],
      payloadKind: 'Request',
      payload: { from: 'Brussels', served_by: 'us-east-1', latency_ms: { before: 28, now: 118 }, status: 200, writes: 'accepted (new primary, epoch 8)' }
    }
  ],
  api: [
    { verb: 'ANY', path: 'api.shop.example', desc: 'Latency-routed DNS name; each region serves the full API.' },
    { verb: 'GET', path: '/internal/health/region', desc: 'Deep regional health used by DNS checks (app + database reachability).' },
    { verb: 'POST', path: '/internal/failover', desc: 'Starts the fenced failover runbook; needs on-call approval.' }
  ],
  schemaLang: 'text',
  schemaNote: 'Topology and replication settings.',
  schema: String.raw`
eu-central-1a  primary        synchronous_standby_names = 'FIRST 1 (euc1b)'
eu-central-1b  sync standby   (zone failure: promoted, RPO 0)
us-east-1a     async replica  primary_conninfo -> euc1a, replication slot 'use1'
us-east-1b     async replica  cascades from use1a

App config (global, versioned)
  epoch: 7           # bumped on every failover; writes carry it and are refused on mismatch
  primary: eu-central-1
  read_from: local replica, or primary if user's rv cookie LSN not yet replayed`,
  decisions: [
    { q: 'How do the regions replicate?', options: [
      { verdict: 'bad', name: 'Synchronous across the Atlantic', why: 'Every commit waits ~90 ms, and an ocean link problem stops all writes.' },
      { verdict: 'good', name: 'Multi-primary with conflict resolution', why: 'Local writes everywhere, but every table needs merge rules.' },
      { verdict: 'great', name: 'One primary, sync in-region, async cross-region, fenced failover', why: 'Simple consistency, zone failures lose nothing, region failures lose seconds.' }
    ] },
    { q: 'How do users see their own writes?', options: [
      { verdict: 'ok', name: 'Send all reads to the primary', why: 'Correct but loses the latency benefit of replicas.' },
      { verdict: 'great', name: 'LSN token per user; wait briefly or fall back to primary', why: 'Fresh for the writer, fast for everyone.' }
    ] }
  ],
  refs: [
    { label: 'PostgreSQL: High availability, load balancing and replication', url: 'https://www.postgresql.org/docs/current/high-availability.html' },
    { label: 'AWS: Disaster recovery options in the cloud', url: 'https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html' },
    { label: 'Amazon S3: Replicating objects', url: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication.html' }
  ]
});
