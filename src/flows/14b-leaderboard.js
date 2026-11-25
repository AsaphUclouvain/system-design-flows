flow({
  id: 'leaderboard',
  title: 'Real-time game leaderboard',
  category: 'Product systems',
  tags: ['Redis sorted sets', 'Rank queries', 'Score validation', 'Seasonal boards', 'Sharded top-K'],
  summary: 'Ten million players finish matches and want to see their rank right away, the global top 10, and the players just above and below them. Follow a score from the game client through validation, a Redis sorted set update, rank queries in O(log n), and the weekly reset that archives a season.',
  requirements: {
    functional: [
      'After a match, the player sees their new global rank within a second.',
      'Show the top 100, the player\'s own rank, and the 5 players above and below.',
      'Weekly and all-time boards; friends-only board.'
    ],
    nonFunctional: [
      'Rank queries under 10 ms at 50,000 reads per second.',
      'Cheated scores must not appear on the board.',
      'A Redis failure loses no scores: the database stays the source of truth.'
    ]
  },
  estimates: [
    { label: 'Players', value: '10 million', note: 'Ranked on the weekly board.' },
    { label: 'Score writes', value: '5,000 / s', note: 'Match completions at peak.' },
    { label: 'Board memory', value: '≈ 1 GB', note: 'A sorted set costs roughly 80–100 bytes per member: 10M × ~100 B.' },
    { label: 'Rank lookup', value: 'O(log n)', note: 'ZREVRANK on a skip list: ~23 levels for 10M members.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'game', label: 'Game client', sub: 'match ends', kind: 'client', icon: 'phone', x: 0, y: 0, desc: 'Shows the result screen and the new rank.' },
    { id: 'match', label: 'Match server', sub: 'authoritative', kind: 'service', icon: 'server', x: 0, y: 2, desc: 'Ran the match and knows the real result; signs it.' },
    { id: 'api', label: 'Leaderboard API', sub: 'FastAPI', kind: 'service', icon: 'trophy', x: 1, y: 1, desc: 'Validates results, updates boards, answers rank queries.' },
    { id: 'db', label: 'Scores DB', sub: 'PostgreSQL', kind: 'db', x: 2, y: 2, desc: 'Every accepted match result; the source of truth.' },
    { id: 'redis', label: 'Boards', sub: 'Redis sorted sets', kind: 'cache', x: 2, y: 0, desc: 'One sorted set per board: member = player id, score = points.' },
    { id: 'web', label: 'Leaderboard page', sub: 'Next.js', kind: 'client', icon: 'chart', x: 3, y: 0, desc: 'Public top-100 page, revalidated every few seconds.' },
    { id: 'cron', label: 'Season job', sub: 'weekly', kind: 'worker', icon: 'clock', x: 3, y: 2, desc: 'Closes the weekly board, archives it and hands out rewards.' },
    { id: 'archive', label: 'Season archive', sub: 'S3 + DB', kind: 'storage', x: 3, y: 1, desc: 'Final standings of past seasons.' }
  ],
  steps: [
    {
      from: 'match', to: 'api', label: 'POST /results (signed)',
      title: 'The match server reports the result',
      caption: 'The score comes from the authoritative match server, not from the player\'s device. It signs the result with an HMAC so the API knows it was not changed or invented.',
      text: ['If the client reported its own score, a modified client could send any number. Server-authoritative results remove the easiest kind of cheating.'],
      payloadKind: 'HTTP request',
      payload: { method: 'POST', path: '/internal/v1/results', headers: { 'X-Signature': 'sha256=8f0c…', 'X-Match-Server': 'eu-gs-14' }, body: { match_id: 'm_01JDQH2', mode: 'ranked', ended_at: '2026-11-25T11:41:40Z', results: [{ player: 'p_ana', points: 1340, kills: 9, duration_s: 1210 }, { player: 'p_ben', points: 880, kills: 4, duration_s: 1210 }] } },
      fields: { match_id: 'Unique per match. Used as an idempotency key: replaying the same result does not add points twice.' }
    },
    {
      from: 'api', to: 'db', label: 'validate + INSERT',
      title: 'Validate and record the result',
      caption: 'The API checks the signature, the match id has not been seen, and the numbers are plausible (1,340 points in 20 minutes is within limits). Then it stores the result in the database.',
      text: ['The database row is written first. If Redis is lost, the boards can be rebuilt from these rows; the reverse is not true.', 'Plausibility rules (points per minute, kills per match) flag outliers for review instead of silently accepting them.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
INSERT INTO match_results (match_id, player_id, points, season, ended_at)
VALUES ('m_01JDQH2', 'p_ana', 1340, '2026-W48', '2026-11-25T11:41:40Z'),
       ('m_01JDQH2', 'p_ben',  880, '2026-W48', '2026-11-25T11:41:40Z')
ON CONFLICT (match_id, player_id) DO NOTHING      -- replay-safe
RETURNING player_id, points;`,
      code: [{ lang: 'python', title: 'Result endpoint', src: String.raw`
@router.post("/internal/v1/results")
async def results(req: Request, body: MatchResult):
    raw = await req.body()
    if not hmac.compare_digest(sign(raw), req.headers["X-Signature"]):
        raise HTTPException(401)
    for r in body.results:
        if r.points / max(r.duration_s / 60, 1) > MAX_POINTS_PER_MIN:
            await flag_for_review(body.match_id, r)
            continue
    inserted = await insert_results(body)            # ON CONFLICT DO NOTHING
    for r in inserted:                               # only new rows touch the boards
        await bump_boards(r.player_id, r.points)
    return {"accepted": len(inserted)}` }],
      failure: ['**Duplicate delivery:** `ON CONFLICT DO NOTHING` returns no rows, so the boards are not incremented again.', '**Implausible score:** stored with `status = review`, not added to boards, and an anti-cheat analyst gets a queue item.']
    },
    {
      from: 'api', to: 'redis', label: 'ZINCRBY × 3 boards',
      title: 'Add the points to each board',
      caption: 'In one pipeline, the API adds 1,340 points to Ana\'s entry in the weekly board, the all-time board and the regional board. Each ZINCRBY is O(log n).',
      text: ['A Redis {{sorted set}} keeps members ordered by score in a skip list plus a hash map. Updating a score moves the member to its new position; no full re-sort ever happens.'],
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
> MULTI
> ZINCRBY lb:weekly:2026-W48 1340 p_ana
> ZINCRBY lb:alltime          1340 p_ana
> ZINCRBY lb:weekly:2026-W48:eu 1340 p_ana
> EXEC
1) "48210"        -- Ana's weekly total
2) "1902455"
3) "48210"`,
      failure: ['**Redis unavailable:** the result is already in the database; a retry queue re-applies the increments when Redis recovers. Increments are tied to `match_id` in a small applied-set so a retry does not double count.']
    },
    {
      from: 'game', to: 'api', label: 'GET /me/rank',
      title: 'The result screen asks for the new rank',
      caption: 'The game client asks for Ana\'s weekly rank and the players around her. One request returns everything the result screen shows.',
      text: ['The client polls once after the match ends. A push channel would also work, but one request a second after the match is simpler and enough here.'],
      payloadKind: 'HTTP request',
      payload: { method: 'GET', path: '/v1/boards/weekly/me?around=5', headers: { Authorization: 'Bearer eyJ… (sub: p_ana)' } }
    },
    {
      from: 'api', to: 'redis', label: 'ZREVRANK + ZREVRANGE',
      title: 'Rank and neighbours in O(log n)',
      caption: 'ZREVRANK gives Ana\'s position from the top (0-based). ZREVRANGE with that position ± 5 returns her neighbours with their scores. Both are logarithmic.',
      text: ['With a SQL table, "what is my rank" means counting all players with more points: O(n) per query, too slow at 10 million rows and 50,000 queries a second.', 'Ties: equal scores are ordered by member id, which is arbitrary. To rank earlier achievers first, encode time in the score (points × 10^10 + (MAX_TS − ts)).'],
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
> ZREVRANK lb:weekly:2026-W48 p_ana
(integer) 18342                       -- rank 18,343
> ZREVRANGE lb:weekly:2026-W48 18337 18347 WITHSCORES
 1) "p_kito"   2) "48290"
 3) "p_mara"   4) "48260"
 …
11) "p_ana"   12) "48210"
 …
> ZCARD lb:weekly:2026-W48
(integer) 9871204`,
      code: [{ lang: 'python', title: 'Rank endpoint', src: String.raw`
@router.get("/v1/boards/{board}/me")
async def my_rank(board: str, around: int = 5, user=Depends(current_player)):
    key = board_key(board)                           # lb:weekly:2026-W48
    rank = await redis.zrevrank(key, user.id)
    if rank is None:
        return {"ranked": False}
    lo, hi = max(rank - around, 0), rank + around
    async with redis.pipeline(transaction=False) as p:
        p.zrevrange(key, lo, hi, withscores=True)
        p.zcard(key)
        rows, total = await p.execute()
    names = await profiles.names([m for m, _ in rows])   # cached lookups
    return {"rank": rank + 1, "total": total,
            "percentile": round(100 * (1 - rank / total), 1),
            "around": [{"rank": lo + i + 1, "player": names[m], "points": int(s)}
                       for i, (m, s) in enumerate(rows)]}` }]
    },
    {
      from: 'api', to: 'game', label: 'rank 18,343 (top 0.2%)', reply: true,
      title: 'The player sees their rank',
      caption: 'The result screen animates Ana climbing from 21,907th to 18,343rd, top 0.2% this week, with the five players just above her as the next targets.',
      text: ['Showing neighbours instead of only the top 10 keeps the board motivating for the 99.99% of players who will never be in the top 10.'],
      payloadKind: 'HTTP response',
      payload: { status: 200, body: { board: 'weekly 2026-W48', rank: 18343, previous_rank: 21907, total: 9871204, percentile: 99.8, points: 48210, around: [{ rank: 18338, player: 'Kito', points: 48290 }, { rank: 18339, player: 'Mara', points: 48260 }, { rank: 18343, player: 'Ana (you)', points: 48210 }, { rank: 18344, player: 'Jules', points: 48200 }] } }
    },
    {
      from: 'web', to: 'api', label: 'GET top 100 (cached)',
      title: 'The public top 100 is cached',
      caption: 'The public leaderboard page shows the top 100. It is the same for everyone, so the Next.js page revalidates every 5 seconds instead of hitting Redis for every visitor.',
      text: ['Personal views (my rank) are computed per request; shared views (top 100) are cached. That split keeps Redis load proportional to active players, not page views.'],
      payloadKind: 'Next.js + Redis',
      payloadLang: 'text',
      payload: String.raw`
// app/leaderboard/page.tsx
export const revalidate = 5;    // ISR: at most one API call per 5 s per region

> ZREVRANGE lb:weekly:2026-W48 0 99 WITHSCORES
1) "p_zed"  2) "912400"
3) "p_yuna" 4) "905120"   …`
    },
    {
      from: 'api', to: 'redis', label: 'friends board (ZUNION)',
      title: 'A friends-only board',
      caption: 'For the friends tab, the API takes Ana\'s 140 friends and reads their weekly scores with one ZMSCORE call, then sorts those 140 numbers in memory.',
      text: ['For small groups, reading scores and sorting in the API is simplest. Building a separate sorted set per player would cost memory for every player\'s friend list.'],
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
> ZMSCORE lb:weekly:2026-W48 p_ben p_chloe p_dan … (140 ids)
1) "36120"
2) (nil)            -- has not played this week
3) "51900"
…
-- API sorts 140 values: Ana is 4th among friends`
    },
    {
      from: 'cron', to: 'redis', label: 'close season W48',
      title: 'The weekly season closes',
      caption: 'Monday 00:00 UTC, the season job freezes the weekly board: new results already go to lb:weekly:2026-W49. It reads the final top 10,000 to award prizes.',
      text: ['New results switch boards by the season id computed from `ended_at`, so a match that ended at 23:59:58 on Sunday still counts for W48 even if it is reported a few seconds later.'],
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
> ZREVRANGE lb:weekly:2026-W48 0 9999 WITHSCORES      -- prize winners
> EXPIRE lb:weekly:2026-W48 1209600                    -- keep 2 weeks for disputes
(integer) 1`
    },
    {
      from: 'cron', to: 'archive', label: 'archive standings',
      title: 'Archive the final standings',
      caption: 'The final standings are written to the database (top 10,000 with ranks) and the full board is dumped to S3. Rewards are granted from the database copy, idempotently per season and player.',
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
INSERT INTO season_standings (season, rank, player_id, points)
SELECT '2026-W48', rank, player_id, points FROM staging_w48   -- loaded from ZREVRANGE
ON CONFLICT DO NOTHING;

INSERT INTO rewards (season, player_id, reward)
SELECT season, player_id, CASE WHEN rank <= 100 THEN 'gold_frame' ELSE 'silver_badge' END
FROM season_standings WHERE season = '2026-W48' AND rank <= 10000
ON CONFLICT (season, player_id) DO NOTHING;`,
      text: ['If Redis had lost data, the job could still rebuild the weekly board from `match_results` with one SUM … GROUP BY over the season, which is why every result goes to the database first.']
    }
  ],
  api: [
    { verb: 'POST', path: '/internal/v1/results', desc: 'Signed match results from match servers.' },
    { verb: 'GET', path: '/v1/boards/{board}/top?limit=100', desc: 'Top N, cached for 5 s.' },
    { verb: 'GET', path: '/v1/boards/{board}/me?around=5', desc: 'My rank, percentile and neighbours.' },
    { verb: 'GET', path: '/v1/boards/{board}/friends', desc: 'Ranking among my friends.' }
  ],
  schema: String.raw`
CREATE TABLE match_results (
  match_id TEXT, player_id TEXT, points INT NOT NULL, season TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted', ended_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (match_id, player_id)
);
CREATE INDEX ON match_results (season, player_id);
CREATE TABLE season_standings (season TEXT, rank INT, player_id TEXT, points INT,
                               PRIMARY KEY (season, rank));

-- Redis
-- lb:weekly:{season}        ZSET player -> points
-- lb:weekly:{season}:{region}
-- lb:alltime`,
  decisions: [
    { q: 'Where do ranks come from?', options: [
      { verdict: 'bad', name: 'SELECT COUNT(*) WHERE points > mine', why: 'O(n) per query; 10M rows × 50k queries/s is impossible.' },
      { verdict: 'great', name: 'Redis sorted sets, rebuilt from the database if needed', why: 'O(log n) updates and rank queries, and the database stays the truth.' }
    ] },
    { q: 'Who reports scores?', options: [
      { verdict: 'bad', name: 'The game client', why: 'Any modified client can post any score.' },
      { verdict: 'great', name: 'The authoritative match server, signed, with plausibility checks', why: 'Removes the easy cheats and flags the subtle ones.' }
    ] }
  ],
  refs: [
    { label: 'Redis: Sorted sets', url: 'https://redis.io/docs/latest/develop/data-types/sorted-sets/' },
    { label: 'Redis: ZREVRANK', url: 'https://redis.io/docs/latest/commands/zrevrank/' }
  ]
});
