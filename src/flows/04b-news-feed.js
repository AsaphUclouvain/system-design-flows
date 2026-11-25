flow({
  id: 'news-feed',
  title: 'News feed with hybrid fan-out',
  category: 'Product systems',
  tags: ['Fan-out', 'Redis', 'Kafka', 'Cursor pagination', 'Ranking'],
  summary: 'Maya posts a photo; her 300 followers see it at the top of their feed within seconds, while a celebrity with 40M followers costs no more to post than anyone else. Fan-out on write, fan-out on read for celebrities, the Redis timeline, ranking and cursor pagination.',
  requirements: {
    functional: [
      'Users publish posts (text, images) and follow other users.',
      'The home feed shows posts from followed accounts, ranked, with infinite scroll.',
      'New posts appear in followers\' feeds within a few seconds.'
    ],
    nonFunctional: [
      'Feed reads are very frequent: p99 under 200 ms.',
      'Posting by an account with millions of followers must not create a write storm.',
      'Eventual consistency is fine (a few seconds of delay); losing a post is not.'
    ]
  },
  estimates: [
    { label: 'Daily active users', value: '50M', note: 'Assumption.' },
    { label: 'Feed reads', value: '≈ 58,000 / s', note: '50M users × 100 feed loads a day ÷ 86,400 s (peaks ×2).' },
    { label: 'Posts', value: '≈ 1,160 / s', note: '50M × 2 posts a day ÷ 86,400.' },
    { label: 'Timeline writes', value: '≈ 230,000 / s', note: '1,160 posts × 200 followers on average. That is why celebrities are left out of fan-out.' },
    { label: 'Timeline memory', value: '≈ 320 GB raw', note: '50M timelines × 800 entries × 8-byte id; sorted-set overhead roughly doubles it, so shard Redis.' }
  ],
  grid: { cols: 5, rows: 2 },
  nodes: [
    { id: 'app', label: 'Maya\'s app', sub: 'Next.js', kind: 'client', icon: 'phone', x: 0, y: 0, desc: 'The author. Posts a photo with a caption.' },
    { id: 'reader', label: 'Leo\'s app', sub: 'Next.js', kind: 'client', icon: 'phone', x: 0, y: 1, desc: 'A follower of Maya and of one celebrity. Opens the home feed.' },
    { id: 'posts', label: 'Post service', sub: 'FastAPI', kind: 'service', x: 1, y: 0, desc: 'Creates posts and publishes a PostCreated event through the outbox.' },
    { id: 'pdb', label: 'Posts DB', sub: 'PostgreSQL', kind: 'db', x: 2, y: 0, desc: 'Posts, sharded by author id. Source of truth for content.' },
    { id: 'kafka', label: 'Post events', sub: 'Kafka', kind: 'queue', x: 3, y: 0, desc: 'PostCreated events, partitioned by author id.' },
    { id: 'fan', label: 'Fan-out workers', sub: 'Python', kind: 'worker', x: 4, y: 0, desc: 'For each new post, push its id into each active follower\'s timeline, unless the author is a celebrity.' },
    { id: 'graph', label: 'Social graph', sub: 'PostgreSQL', kind: 'db', icon: 'spider', x: 4, y: 1, desc: 'Who follows whom, indexed both ways, plus cached follower counts.' },
    { id: 'tl', label: 'Timelines', sub: 'Redis', kind: 'cache', x: 3, y: 1, desc: 'One sorted set per user: post ids scored by time, capped at 800 entries.' },
    { id: 'pcache', label: 'Post cache', sub: 'Redis', kind: 'cache', x: 2, y: 1, desc: 'Post bodies and counters by id, so hydrating a page is one MGET.' },
    { id: 'feed', label: 'Feed service', sub: 'FastAPI', kind: 'service', x: 1, y: 1, desc: 'Builds a page of the feed: reads the timeline, merges celebrity posts, ranks, hydrates.' }
  ],
  steps: [
    {
      from: 'app', to: 'posts', label: 'POST /v1/posts',
      title: 'Maya publishes a post',
      caption: 'The app has already uploaded the photo to object storage with a presigned URL; the post request only references the media key.',
      text: ['Media never goes through the post API: big uploads would tie up API workers. The file-upload flow shows that part.', 'The {{idempotency key}} makes a retry after a flaky mobile connection return the same post instead of a duplicate.'],
      payloadKind: 'HTTP request',
      payload: { method: 'POST', path: '/v1/posts', headers: { Authorization: 'Bearer eyJ…(sub=usr_maya)', 'Idempotency-Key': 'c2a1d7e0-…' }, body: { text: 'First snow in Louvain-la-Neuve ❄️', media: [{ key: 'u/usr_maya/2026/11/25/9f2c.jpg', width: 3024, height: 4032 }], visibility: 'followers' } },
      fields: { 'body.media[0].key': 'Object key returned by the upload step; the API checks it belongs to this user.' }
    },
    {
      from: 'posts', to: 'pdb', label: 'INSERT post + outbox',
      title: 'Store the post and its event in one transaction',
      caption: 'The post row and an outbox row commit together. A relay publishes the outbox row to Kafka, so a post never exists without its event, or the reverse.',
      text: ['This is the {{outbox pattern}}. It avoids the {{dual write}} problem, where the database commit succeeds but the Kafka publish fails (or the other way round).'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
BEGIN;
INSERT INTO posts (id, author_id, text, media)
VALUES (7399412000000000001, 'usr_maya', 'First snow in Louvain-la-Neuve',
        '[{"key":"u/usr_maya/2026/11/25/9f2c.jpg"}]');
INSERT INTO outbox (topic, key, payload)
VALUES ('post-created', 'usr_maya',
        '{"post_id":"7399412000000000001","author_id":"usr_maya","ts":1764067267}');
COMMIT;`,
      code: [{ lang: 'python', title: 'Create post (FastAPI + asyncpg)', src: String.raw`
@router.post("/v1/posts", status_code=201)
async def create_post(body: PostIn, user=Depends(current_user), db=Depends(get_db)):
    post_id = snowflake.next_id()          # time-ordered: sorting by id = sorting by time
    event = {"post_id": str(post_id), "author_id": user.id, "ts": int(time.time())}
    async with db.transaction():
        await db.execute(
            "INSERT INTO posts (id, author_id, text, media) VALUES ($1,$2,$3,$4)",
            post_id, user.id, body.text, json.dumps([m.model_dump() for m in body.media]))
        await db.execute(
            "INSERT INTO outbox (topic, key, payload) VALUES ('post-created', $1, $2)",
            user.id, json.dumps(event))
    return {"id": str(post_id)}            # string: JS numbers lose precision above 2^53` }],
      fields: { id: 'A Snowflake id: time-ordered, and sent to clients as a string because JavaScript numbers are exact only up to 2⁵³.' }
    },
    {
      from: 'pdb', to: 'kafka', label: 'outbox relay', async: true,
      title: 'The event reaches Kafka',
      caption: 'A relay (polling the outbox table, or {{CDC}} with Debezium) publishes PostCreated keyed by author id, then marks the row sent.',
      text: ['The relay can publish twice if it crashes after publishing and before marking the row. That is fine as long as consumers are idempotent: adding the same post id to a sorted set twice changes nothing.'],
      payloadKind: 'Kafka record',
      payload: { topic: 'post-created', partition: 11, offset: 88412097, key: 'usr_maya', value: { post_id: '7399412000000000001', author_id: 'usr_maya', ts: 1764067267 } },
      fields: { partition: 'hash(author_id) mod partitions: all posts of one author stay in order.' }
    },
    {
      from: 'fan', to: 'graph', label: 'followers of usr_maya',
      title: 'The fan-out worker loads the followers',
      caption: 'Maya has 312 followers, far below the celebrity threshold (100,000 here), so her post is fanned out on write. The worker pages through followers 1,000 at a time.',
      text: ['It skips followers who have not opened the app for 30 days. Their timelines are rebuilt when they come back, which saves a large share of writes.', 'For an author above the threshold, the worker does nothing: those posts are pulled at read time (step 8).'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
SELECT f.follower_id FROM follows f
JOIN user_activity a ON a.user_id = f.follower_id
WHERE f.followee_id = 'usr_maya'
  AND a.last_seen_at > now() - interval '30 days'
  AND f.follower_id > ''                -- keyset cursor: last id of previous page
ORDER BY f.follower_id LIMIT 1000;
-- 271 of 312 followers are active`,
      details: ['Celebrity check: `follower_count >= 100000`, read from a counter cached on the author record.', 'Index `follows (followee_id, follower_id)` makes this a range scan.']
    },
    {
      from: 'fan', to: 'tl', label: 'ZADD × 271 (pipelined)',
      title: 'Push the post id into each follower\'s timeline',
      caption: 'One pipelined batch: ZADD the post id with its timestamp score into each active follower\'s sorted set, then trim each set to the newest 800.',
      text: ['A {{sorted set}} keeps ids ordered by score, so reading the newest 20 costs O(log N + 20). Storing only ids, not post bodies, is what makes 50M timelines fit in memory.', 'This is {{fan-out}} on write: the work happens once at post time, so each read is cheap.'],
      payloadKind: 'Redis pipeline',
      payloadLang: 'redis',
      payload: String.raw`
ZADD tl:usr_leo 1764067267 7399412000000000001
ZREMRANGEBYRANK tl:usr_leo 0 -801         -- keep the newest 800
ZADD tl:usr_ana 1764067267 7399412000000000001
ZREMRANGEBYRANK tl:usr_ana 0 -801
… 271 followers, sent as one round trip`,
      code: [{ lang: 'python', title: 'Fan-out consumer', src: String.raw`
CELEBRITY = 100_000

async def handle_post_created(ev: dict):
    author = await authors.get(ev["author_id"])          # cached follower_count
    if author.follower_count >= CELEBRITY:
        return                                           # pulled at read time
    async for page in active_followers(ev["author_id"], size=1000, days=30):
        pipe = redis.pipeline(transaction=False)
        for uid in page:
            key = f"tl:{uid}"
            pipe.zadd(key, {ev["post_id"]: ev["ts"]})
            pipe.zremrangebyrank(key, 0, -801)
        await pipe.execute()                             # re-adding the same id is a no-op

async for msg in consumer:                               # aiokafka, enable_auto_commit=False
    await handle_post_created(json.loads(msg.value))
    await consumer.commit()                              # only after the whole fan-out` }],
      failure: ['**Worker crashes halfway:** the offset was not committed, so another worker redoes the whole post. ZADD of an existing member only rewrites its score, so the retry is harmless ({{idempotent consumer}}).', '**A Redis shard is down:** the batch fails and is retried with {{exponential backoff}}. Timelines are a cache that can be rebuilt from the graph and the posts DB.']
    },
    {
      from: 'reader', to: 'feed', label: 'GET /v1/feed',
      title: 'Leo opens his home feed',
      caption: 'The first page has no cursor. Leo follows Maya and 180 other accounts, including one celebrity (@worldcup, 40M followers).',
      payloadKind: 'HTTP request',
      payload: { method: 'GET', path: '/v1/feed?limit=20', headers: { Authorization: 'Bearer eyJ…(sub=usr_leo)' } },
      text: ['The Next.js page renders the first page on the server (a Server Component calls the feed service) for a fast first paint; scrolling then fetches further pages from the browser with the cursor.']
    },
    {
      from: 'feed', to: 'tl', label: 'ZREVRANGEBYSCORE',
      title: 'Read Leo\'s precomputed timeline',
      caption: 'One command returns the newest post ids from Leo\'s timeline, already including Maya\'s post from a few seconds ago.',
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
> ZREVRANGEBYSCORE tl:usr_leo +inf -inf WITHSCORES LIMIT 0 60
1) "7399412000000000001"   2) "1764067267"     -- Maya, 4 s ago
3) "7399409713200000007"   4) "1764066722"
…`,
      text: ['The service over-fetches (60 ids for a page of 20) to leave room for ranking and for posts that were deleted or come from muted accounts.'],
      failure: ['**Timeline missing (inactive user or lost cache):** rebuild it now by pulling the latest posts of each followee from the posts DB, merge, write back to Redis. The first load is slower, the next ones fast.']
    },
    {
      from: 'feed', to: 'pdb', label: 'celebrity posts (pull)',
      title: 'Merge in celebrity posts at read time',
      caption: 'For the few celebrities Leo follows, the service reads their recent posts directly (cached per celebrity) and merges them with the timeline ids.',
      text: ['This hybrid model is how Twitter described its timelines: fan-out on write for most accounts, on read for the very large ones. One @worldcup post would otherwise mean 40M Redis writes.', 'Each celebrity\'s recent-post list is cached once and shared by millions of readers, so this pull rarely touches the database.'],
      payloadKind: 'Merged candidates',
      payload: { from_timeline: 60, celebrities_followed: ['usr_worldcup'], from_celebrities: 5, candidates: 65, removed_muted: 2, removed_deleted: 1, remaining: 62 }
    },
    {
      from: 'feed', to: 'pcache', label: 'MGET post:… (rank, hydrate)',
      title: 'Rank and hydrate the page',
      caption: 'One MGET fetches bodies and counters for the candidates. The service scores them (recency, affinity with the author, engagement) and keeps the top 20.',
      text: ['A simple score is enough to start, for example `affinity × (1 + likes) / (age_hours + 2)^1.5`. Large feeds replace it with a model, but the pipeline shape stays: candidates, features, score, top K.', 'Author names and avatars come from a user cache the same way. Never one query per post ({{N+1 query}}).'],
      code: [{ lang: 'python', title: 'Feed page assembly', src: String.raw`
async def build_page(uid: str, cursor: Cursor | None, limit: int = 20):
    top = cursor.score if cursor else "+inf"
    ids = await redis.zrevrangebyscore(f"tl:{uid}", top, "-inf", start=0, num=limit * 3, withscores=True)
    ids += await celebrity_posts(uid, before=top)              # cached per celebrity
    ids = [i for i in dedupe(ids) if not cursor or (i.score, i.id) < (cursor.score, cursor.id)]
    posts = await post_cache.mget_or_load([i.id for i in ids])  # one MGET + DB fill for misses
    muted = await muted_authors(uid)
    posts = [p for p in posts if p and not p.deleted and p.author_id not in muted]
    page = sorted(posts, key=lambda p: rank(uid, p), reverse=True)[:limit]
    oldest = min(page, key=lambda p: (p.ts, p.id), default=None)
    return {"items": page, "next_cursor": oldest and encode_cursor(oldest.ts, oldest.id)}` }],
      payloadKind: 'One hydrated item',
      payload: { id: '7399412000000000001', author: { id: 'usr_maya', name: 'Maya', avatar: 'https://cdn.example.com/a/usr_maya.jpg' }, text: 'First snow in Louvain-la-Neuve ❄️', media: [{ url: 'https://cdn.example.com/u/usr_maya/2026/11/25/9f2c_1080.jpg', w: 1080, h: 1440 }], likes: 3, comments: 0, created_at: '2026-11-25T10:41:07Z', rank_score: 2.41 },
      fields: { rank_score: 'Only for debugging; real feeds keep scores server-side.' }
    },
    {
      from: 'feed', to: 'reader', label: '200 items + next_cursor', reply: true,
      title: 'Leo sees Maya\'s post first',
      caption: 'The page returns 20 items and an opaque cursor. The next scroll sends the cursor back and continues where this page ended, even while new posts arrive.',
      text: ['{{cursor pagination}}, not `OFFSET`: with offsets, a new post at the top shifts everything down and the user sees duplicates on the next page. The cursor encodes a stable position (time score and id) in the ordering.'],
      payloadKind: 'HTTP response',
      payload: { items: ['…20 hydrated posts…'], next_cursor: 'eyJzIjoxNzY0MDY0MTIyLCJpIjoiNzM5OTQwNTEyMzQwMDAwMDAwMyJ9', has_more: true },
      fields: { next_cursor: 'Base64 of {"s":1764064122,"i":"7399405123400000003"}. Sign it with an {{HMAC}} if clients must not craft their own.' },
      code: [{ lang: 'ts', title: 'Infinite scroll in Next.js (client component)', src: String.raw`
'use client';
import useSWRInfinite from 'swr/infinite';

type FeedPage = { items: Post[]; next_cursor: string | null };

const getKey = (i: number, prev: FeedPage | null) =>
  prev && !prev.next_cursor ? null                       // reached the end
    : '/api/feed?limit=20' + (prev ? '&cursor=' + prev.next_cursor : '');

export function Feed({ first }: { first: FeedPage }) {
  const { data, setSize, isValidating } =
    useSWRInfinite<FeedPage>(getKey, fetcher, { fallbackData: [first] });
  const items = data?.flatMap(p => p.items) ?? [];
  return (
    <>
      {items.map(p => <PostCard key={p.id} post={p} />)}
      <Sentinel onVisible={() => { if (!isValidating) setSize(s => s + 1); }} />
    </>
  );
}` }]
    }
  ],
  api: [
    { verb: 'POST', path: '/v1/posts', desc: 'Create a post (text + media keys). Requires Idempotency-Key.' },
    { verb: 'GET', path: '/v1/feed?cursor=&limit=20', desc: 'Home feed page with an opaque cursor.' },
    { verb: 'PUT', path: '/v1/follows/{user_id}', desc: 'Follow (DELETE to unfollow). Starts a job that backfills or removes that author\'s posts in the timeline.' }
  ],
  schema: String.raw`
CREATE TABLE posts (
  id BIGINT PRIMARY KEY,               -- Snowflake id, time-ordered
  author_id TEXT NOT NULL, text TEXT, media JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ
);
CREATE INDEX posts_author_recent ON posts (author_id, id DESC);   -- pull model + rebuilds

CREATE TABLE follows (
  follower_id TEXT NOT NULL, followee_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX follows_by_followee ON follows (followee_id, follower_id);  -- fan-out

-- Redis  tl:{user_id}  ZSET   member = post_id, score = unix ts (capped at 800)
--        post:{id}     STRING JSON body + counters (TTL 1 day)`,
  decisions: [
    { q: 'Fan-out on write or on read?', options: [
      { verdict: 'bad', name: 'Pure fan-out on read', why: 'Every feed load queries hundreds of authors and merges: slow and expensive at 58k reads/s.' },
      { verdict: 'bad', name: 'Pure fan-out on write', why: 'A celebrity post becomes tens of millions of writes and minutes of delay.' },
      { verdict: 'great', name: 'Hybrid: push for normal accounts, pull for celebrities', why: 'Reads stay cheap and writes stay bounded.' }
    ] },
    { q: 'What goes in the timeline cache?', options: [
      { verdict: 'bad', name: 'Full post bodies', why: 'Copied into every follower\'s timeline; edits and deletes must touch millions of copies.' },
      { verdict: 'great', name: 'Post ids only, hydrated from a post cache', why: 'Small, and each post is stored once.' }
    ] },
    { q: 'How do you paginate?', options: [
      { verdict: 'bad', name: 'LIMIT/OFFSET', why: 'Duplicates and gaps when new posts arrive; deep offsets get slower.' },
      { verdict: 'great', name: 'Cursor on (score, id)', why: 'Stable under inserts, constant cost per page.' }
    ] }
  ],
  refs: [
    { label: 'Redis: Sorted sets', url: 'https://redis.io/docs/latest/develop/data-types/sorted-sets/' },
    { label: 'InfoQ: Timelines at Scale (Raffi Krikorian, Twitter)', url: 'https://www.infoq.com/presentations/Twitter-Timeline-Scalability/', note: 'The fan-out design described by the team that built it.' },
    { label: 'SWR: Pagination and infinite loading', url: 'https://swr.vercel.app/docs/pagination' }
  ]
});
