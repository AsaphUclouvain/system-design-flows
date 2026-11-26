flow({
  id: 'recommendation-system',
  title: 'Recommendation system: candidate generation, ranking, re-ranking',
  category: 'AI & machine learning',
  tags: ['Two-tower retrieval', 'ANN candidate generation', 'Feature store lookup', 'Ranking model', 'Diversity re-rank', 'Impression logging', 'Training feedback loop'],
  summary: 'A video app has 10 million videos and 200 ms to fill a home screen. Follow one request through the funnel used by YouTube, TikTok-style feeds and stores: several retrievers pull about 1,000 candidates, a heavier model scores each with rich features, business rules re-rank for diversity and freshness, and impressions are logged so tomorrow\'s model learns from today\'s clicks.',
  requirements: {
    functional: ['Show a personalised list of 20 items on the home screen.', 'Learn from what users watch, skip and like.'],
    nonFunctional: ['p99 < 200 ms.', 'Catalog of 10M items, 50M users.', 'No more than 2 items from the same creator in the top 20.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'app', label: 'Mobile app', sub: 'home screen', kind: 'client', icon: 'phone', x: 0, y: 1, desc: 'Requests a feed and reports what the user saw and did.' },
    { id: 'rec', label: 'Recommendation service', sub: 'orchestrates funnel', kind: 'service', icon: 'server', x: 1, y: 1, desc: 'Calls retrievers, fetches features, calls the ranker, applies rules.' },
    { id: 'ann', label: 'Candidate retrievers', sub: 'two-tower ANN + others', kind: 'db', icon: 'vector', x: 1, y: 0, desc: 'Nearest-neighbour search between the user embedding and 10M item embeddings, plus simpler sources (subscriptions, trending).' },
    { id: 'fs', label: 'Feature store', sub: 'online, Redis', kind: 'cache', icon: 'layers', x: 2, y: 0, desc: 'Fresh per-user and per-item features: watch history, item click-through rate in the last hour, creator stats.' },
    { id: 'rank', label: 'Ranking model', sub: 'deep net on GPU', kind: 'ai', icon: 'brain', x: 3, y: 1, desc: 'Predicts for each candidate the probability of click, watch time, like; combines them into one score.' },
    { id: 'log', label: 'Event log', sub: 'Kafka → lake', kind: 'queue', icon: 'queue', x: 2, y: 2, desc: 'Impressions and interactions, joined with the features used at serving time to make training data.' }
  ],
  pseudo: `
u = user_tower(user_features)                     # embedding, cached
cands = ann.search(u, k=800) + subscriptions(user, 150) + trending(50)
feats = feature_store.get(user, cands)            # batched lookup
scores = ranker.predict(feats)                    # p_click, watch_time, p_like
score = w1*p_click + w2*watch_time + w3*p_like
feed = rerank(cands, score, max_per_creator=2, fresh_boost=0.1)[:20]
log_impressions(user, feed, feats, request_id)
return feed`,
  steps: [
    {
      from: 'app', to: 'rec', label: 'GET /feed/home user=u_42', pc: ['u = user_tower'],
      title: 'A request for 20 items',
      caption: 'Scoring all 10M items with a heavy model in 200 ms is impossible, so the work is split into stages that get narrower and more expensive.',
      text: ['Covington et al. (2016) describe YouTube\'s split into a candidate generation network and a separate ranking network.'],
      payloadKind: 'Request',
      payload: { user: 'u_42', surface: 'home', device: 'android', request_id: 'r_9f2' }
    },
    {
      from: 'rec', to: 'ann', label: 'ANN top 800 + 150 subs + 50 trending', pc: ['cands = ann.search'],
      title: 'Candidate generation: 10M → 1,000',
      caption: 'A two-tower model maps users and items into the same vector space; an ANN index returns the 800 closest items in a few milliseconds. Other retrievers add subscriptions and trending items.',
      text: [],
      payloadKind: 'Candidates',
      payload: { two_tower: 800, subscriptions: 150, trending: 50, total: 1000, latency_ms: 14 }
    },
    {
      from: 'rec', to: 'fs', label: 'get features for u_42 × 1,000 items', pc: ['feats = feature_store.get'],
      title: 'Fetch features',
      caption: 'The ranker needs much richer inputs than the retriever: recent watches, the item\'s click rate this hour, how often this user finishes this creator\'s videos.',
      text: [],
      payloadKind: 'Features (one item)',
      payload: { user: { watched_last_24h: 31, fav_topics: ['anime', 'cs'] }, item: { id: 'v_771', ctr_1h: 0.083, duration_s: 610, age_h: 5 }, cross: { user_creator_completion: 0.74 } }
    },
    {
      from: 'rec', to: 'rank', label: 'score 1,000 candidates', pc: ['scores = ranker.predict', 'score = w1*p_click'],
      title: 'Ranking: predict several outcomes',
      caption: 'The model predicts click, expected watch time and like for each candidate. A weighted sum turns them into one score. The weights encode what the product values.',
      text: ['Optimising only for clicks rewards clickbait; YouTube\'s paper ranks by expected watch time for that reason.'],
      payloadKind: 'Scores (top 3)',
      payload: [{ item: 'v_771', p_click: 0.12, watch_s: 340, p_like: 0.05, score: 0.91 }, { item: 'v_102', score: 0.88 }, { item: 'v_559', score: 0.87 }]
    },
    {
      from: 'rank', to: 'rec', reply: true, label: 're-rank: diversity, freshness, rules', pc: ['feed = rerank'],
      title: 'Re-rank with business rules',
      caption: 'Top scores are often near-duplicates. Re-ranking caps each creator at 2, boosts fresh uploads, removes already-watched and policy-flagged items.',
      text: [],
      payloadKind: 'Re-rank',
      payload: { removed: { watched: 41, same_creator_cap: 12, policy: 1 }, final: 20 },
      branch: { q: 'New user with no history?', options: [ { label: 'no: personalised feed', goto: 'serve' }, { label: 'yes: cold start', goto: 'cold' } ] }
    },
    {
      id: 'cold', path: 'cold start', from: 'rec', to: 'ann', label: 'popular in BE + onboarding topics', pc: ['trending(50)'],
      title: 'Other outcome: cold start',
      caption: 'A brand-new user has no embedding worth searching. The service falls back to popular items in their country and the topics they picked at sign-up, and explores to learn quickly.',
      text: [],
      payloadKind: 'Cold start',
      payload: { sources: ['popular_BE', 'topics:[anime, cs]'], exploration: 0.2 },
      next: 'serve'
    },
    {
      id: 'serve', from: 'rec', to: 'app', reply: true, label: '20 items, 128 ms', pc: ['return feed'],
      title: 'Serve the feed',
      caption: 'The app shows the list. Total: retrieval 14 ms, features 22 ms, ranking 71 ms, rules 6 ms.',
      text: [],
      payloadKind: 'Response',
      payload: { items: ['v_771', 'v_102', 'v_559', '…'], request_id: 'r_9f2', latency_ms: 128 }
    },
    {
      from: 'app', to: 'log', async: true, label: 'impressions + watch 340 s on v_771', pc: ['log_impressions'],
      title: 'Log impressions and outcomes',
      caption: 'What was shown, in which position, and what the user did are logged with the request id. Joining them with the exact features used at serving time gives tomorrow\'s training data without training/serving skew.',
      text: [],
      payloadKind: 'Events',
      payload: [{ type: 'impression', item: 'v_771', pos: 1, request_id: 'r_9f2' }, { type: 'watch', item: 'v_771', seconds: 340 }, { type: 'skip', item: 'v_102', after_s: 2 }]
    }
  ],
  decisions: [
    { q: 'One model or a funnel?', options: [
      { name: 'One heavy model over all items', verdict: 'bad', why: 'Cannot score millions of items within the latency budget.' },
      { name: 'Retrieve → rank → re-rank', verdict: 'great', why: 'Cheap wide stage, expensive narrow stage; the standard design.' } ] }
  ],
  refs: [
    { label: 'Covington et al. (2016): Deep neural networks for YouTube recommendations', url: 'https://research.google/pubs/deep-neural-networks-for-youtube-recommendations/' },
    { label: 'Yi et al. (2019): Sampling-bias-corrected neural modeling (two-tower retrieval)', url: 'https://research.google/pubs/sampling-bias-corrected-neural-modeling-for-large-corpus-item-recommendations/' },
    { label: 'Eugene Yan: System design for recommendations and search', url: 'https://eugeneyan.com/writing/system-design-for-discovery/' },
    { label: 'ByteByteGo ML System Design Interview (book page)', url: 'https://bytebytego.com/courses/machine-learning-system-design-interview' }
  ],
  verify: {
    checked: ['Two-stage design: a deep candidate generation model and a separate deep ranking model: YouTube paper abstract.', 'Ranking objective a function of expected watch time per impression, because ranking by click-through rate promotes deceptive videos: YouTube paper PDF (read).'],
    uncertain: ['Candidate counts, weights, timings and features are illustrative.']
  }
});
