flow({
  id: 'db-sharding',
  title: 'Database sharding: routing by shard key',
  category: 'Databases & replication',
  tags: ['Shard key', 'Hash vs range', 'Query router', 'Targeted vs scatter-gather', 'Hotspots', 'Resharding'],
  summary: 'When one database can no longer hold the data or the writes, split rows across shards that share a schema. Follow a query that includes the shard key straight to one shard, then a query without it that must ask every shard and merge the results, and see the celebrity hotspot and resharding problems.',
  requirements: {
    functional: ['Store 2 billion chapter-view rows and 40 million users.', 'Fetch one user\'s data quickly; occasionally run queries across all users.'],
    nonFunctional: ['Write throughput grows by adding shards.', 'A query that includes the shard key touches one shard only.']
  },
  estimates: [
    { label: 'Shards', value: '4 → 8', note: 'Each shard is itself a primary with replicas.' },
    { label: 'Targeted query', value: '1 shard', note: 'Latency of a single database.' },
    { label: 'Scatter-gather query', value: 'all shards', note: 'As slow as the slowest shard, and load on every shard.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'api', label: 'Reading-history API', sub: 'FastAPI', kind: 'client', icon: 'api', x: 0, y: 1, desc: 'Sends queries as if there were one database; the router hides the shards.' },
    { id: 'router', label: 'Shard router', sub: 'mongos / Vitess / app lib', kind: 'edge', icon: 'split', x: 1, y: 1, desc: 'Computes which shard owns a key and forwards the query. With no key in the query, it fans out to all shards and merges.' },
    { id: 'meta', label: 'Shard map', sub: 'config servers', kind: 'cache', icon: 'log', x: 1, y: 0, desc: 'Metadata: which key ranges (or hash ranges) live on which shard. Cached by routers.' },
    { id: 's0', label: 'Shard 0', sub: 'hash range 0–3fff', kind: 'db', icon: 'db', x: 3, y: 0, desc: 'Holds about a quarter of users and all their rows.' },
    { id: 's1', label: 'Shard 1', sub: 'hash range 4000–7fff', kind: 'db', icon: 'db', x: 3, y: 1, desc: 'Another quarter.' },
    { id: 's2', label: 'Shards 2–3', sub: '8000–ffff', kind: 'db', icon: 'db', x: 3, y: 2, desc: 'The remaining half, drawn as one box.' }
  ],
  pseudo: `
SHARD_KEY = "user_id"
def route(query):
    key = query.get(SHARD_KEY)
    if key is not None:
        shard = shard_map.lookup(hash(key) & 0xffff)  # targeted
        return shard.execute(query)
    parts = parallel(s.execute(query) for s in shards) # scatter
    return merge_sort_limit(parts, query.order_by, query.limit)  # gather`,
  steps: [
    {
      from: 'api', to: 'router', label: 'SELECT … WHERE user_id=8812 ORDER BY at DESC LIMIT 20', pc: ['def route', 'key = query.get'],
      title: 'A query that includes the shard key',
      caption: 'Ana opens her reading history. The query filters on user_id, which is the shard key, so the router can tell exactly where her rows are.',
      text: ['ByteByteGo\'s rule for choosing a shard key: it should spread data evenly and let most queries go to one shard. user_id fits: nearly every query is about one user.'],
      payloadKind: 'SQL',
      payload: { sql: 'SELECT chapter_id, at FROM views WHERE user_id = 8812 ORDER BY at DESC LIMIT 20', shard_key_present: true }
    },
    {
      from: 'router', to: 'meta', label: 'hash(8812)=0x5a1c → ?', pc: ['shard_map.lookup'],
      title: 'Look up the owner in the shard map',
      caption: 'The router hashes 8812 to 0x5a1c and checks its cached shard map: that hash range belongs to Shard 1.',
      text: ['Hash sharding spreads keys evenly but makes range scans on the key impossible. Range sharding (user_id 1–10M on shard 0…) keeps ranges together but new users all land on the last shard. MongoDB, for example, supports both, grouping keys into chunks that a balancer moves between shards.'],
      payloadKind: 'Shard map entry',
      payload: { hash: '0x5a1c', ranges: [{ from: '0x0000', to: '0x3fff', shard: 0 }, { from: '0x4000', to: '0x7fff', shard: 1 }], owner: 'shard 1' }
    },
    {
      from: 'router', to: 's1', label: 'targeted → shard 1', pc: ['return shard.execute'],
      title: 'Targeted: one shard answers',
      caption: 'The query goes only to Shard 1, which has all of Ana\'s rows. 20 rows come back in 3 ms; the other shards did no work.',
      text: ['Keeping everything a request needs on one shard (here, all of a user\'s views) also keeps transactions local, avoiding cross-shard commits.'],
      payloadKind: 'Result',
      payload: { shard: 1, rows: 20, ms: 3, other_shards_touched: 0 }
    },
    {
      from: 'api', to: 'router', label: 'SELECT chapter_id, count(*) … GROUP BY … LIMIT 10', pc: ['key = query.get'],
      title: 'A query without the shard key',
      caption: 'An admin dashboard asks for the 10 most-read chapters this week. There is no user_id, so no single shard has the answer.',
      text: [],
      payloadKind: 'SQL',
      payload: { sql: "SELECT chapter_id, count(*) AS n FROM views WHERE at > now() - interval '7 days' GROUP BY chapter_id ORDER BY n DESC LIMIT 10", shard_key_present: false },
      branch: { q: 'How is this query served?', options: [ { label: 'scatter-gather over shards', goto: 'scatter' }, { label: 'precomputed elsewhere', goto: 'olap' } ] }
    },
    {
      id: 'scatter', path: 'scatter-gather', from: 'router', to: 's0', label: 'broadcast to all 4 shards', pc: ['parts = parallel'],
      title: 'Scatter: every shard runs the query',
      caption: 'The router sends the query to all shards in parallel. Each computes its own local top counts.',
      text: ['The response time is that of the slowest shard, and every shard pays the cost. Fine for a rare admin query; dangerous on a hot path.'],
      payloadKind: 'Fan-out',
      payload: { sent_to: ['shard 0', 'shard 1', 'shard 2', 'shard 3'], each_returns: 'local counts per chapter (not just top 10, or the merge would be wrong)' },
      fields: { each_returns: 'A global top 10 needs each shard\'s full counts for candidate chapters, or a two-phase approximate method. Taking each shard\'s top 10 can miss a chapter that is 11th everywhere.' }
    },
    {
      path: 'scatter-gather', from: 's1', to: 'router', reply: true, label: 'partial counts × 4 → merge', pc: ['merge_sort_limit'],
      title: 'Gather: merge and cut to 10',
      caption: 'The router sums the counts per chapter from the four shards, sorts, and returns the top 10. 410 ms, versus 3 ms for the targeted query.',
      text: ['ByteByteGo lists the other costs of sharding: joins across shards are hard (denormalise instead), a celebrity key can overload one shard, and resharding is needed when shards fill unevenly. Consistent hashing reduces how much data moves when shards are added.'],
      payloadKind: 'Merged result',
      payload: { top: [{ chapter_id: 'static-bloom/63', n: 48211 }, { chapter_id: 'static-bloom/62', n: 30170 }], shards_merged: 4, ms: 410 },
      failure: ['**Celebrity hotspot:** if one series gets 40% of all traffic and the shard key were series_id, its shard would melt. Fixes: a better key, splitting the hot key (key + random suffix), or caching.'],
      end: true
    },
    {
      id: 'olap', path: 'precomputed', from: 'router', to: 's2', async: true, label: 'served from analytics store', pc: ['parts = parallel'],
      title: 'Better for dashboards: precompute',
      caption: 'Analytics queries are often moved off the shards entirely: change events stream into a warehouse or a counter table that is keyed by chapter, where the top 10 is one cheap read.',
      text: ['This is the usual shape at scale: shards serve per-user requests; aggregated views come from a separate pipeline (see the ad click aggregation and CDC flows).'],
      payloadKind: 'Precomputed table',
      payload: { table: 'chapter_views_weekly (keyed by chapter_id)', updated: 'every minute by a stream job', query_ms: 2 }
    }
  ],
  decisions: [
    { q: 'Hash or range sharding?', options: [
      { name: 'Hash of the key', verdict: 'good', why: 'Even spread, no hot "latest" shard. Range queries on the key become scatter-gather.' },
      { name: 'Ranges of the key', verdict: 'good', why: 'Range scans stay on one shard. Monotonic keys (time, auto-increment ids) send all new writes to one shard.' },
      { name: 'Directory (lookup table)', verdict: 'good', why: 'Any placement you like, easy to move tenants. The directory is an extra hop and must be highly available.' } ] }
  ],
  refs: [
    { label: 'ByteByteGo, System Design Interview Vol. 1: Scale from zero to millions of users (sharding, resharding, celebrity problem, joins)', url: 'https://bytebytego.com/courses/system-design-interview/scale-from-zero-to-millions-of-users' },
    { label: 'MongoDB manual: Sharding (shard keys, mongos, config servers, chunks, targeted vs broadcast)', url: 'https://www.mongodb.com/docs/manual/sharding/' },
    { label: 'Vitess docs: Sharding (keyspaces, vindexes, resharding)', url: 'https://vitess.io/docs/22.0/reference/features/sharding/' },
    { label: 'Citus: Understanding partitioning and sharding in Postgres', url: 'https://www.citusdata.com/blog/2023/08/04/understanding-partitioning-and-sharding-in-postgres-and-citus/' }
  ],
  verify: {
    checked: ['Shard key choice, resharding, celebrity problem, cross-shard joins: ByteByteGo Vol. 1 ch. 1.', 'mongos routing, config servers, chunks, targeted vs broadcast operations: MongoDB manual.'],
    uncertain: ['Hash ranges, row counts and timings are illustrative.']
  }
});
