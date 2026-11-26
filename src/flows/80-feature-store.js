flow({
  id: 'feature-store',
  title: 'Feature store: same features for training and serving',
  category: 'AI & machine learning',
  tags: ['Offline store', 'Online store', 'Materialization', 'Point-in-time join', 'Training–serving skew', 'Feature registry'],
  summary: 'A fraud model is trained on features computed in a warehouse but served with features computed by an API, and the two drift apart. A feature store defines each feature once and serves it both ways. Follow a feature from definition to a point-in-time-correct training set, its materialization into Redis, and a 5 ms lookup at payment time.',
  requirements: {
    functional: ['Define features once; use them for training and for real-time inference.', 'Training sets must only use data that existed at each label\'s time.'],
    nonFunctional: ['Online lookup p99 < 10 ms.', 'Online values at most 15 minutes old.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'ds', label: 'Data scientist', sub: 'feature repo (Git)', kind: 'client', icon: 'laptop', x: 0, y: 0, desc: 'Writes feature definitions as code and reviews them like any other code.' },
    { id: 'reg', label: 'Registry', sub: 'definitions', kind: 'db', icon: 'doc', x: 1, y: 0, desc: 'The catalog: entities, feature views, sources, TTLs, owners.' },
    { id: 'off', label: 'Offline store', sub: 'BigQuery / Parquet', kind: 'storage', icon: 'db', x: 2, y: 0, desc: 'All historical feature values with timestamps. Used to build training sets.' },
    { id: 'mat', label: 'Materialization job', sub: 'every 15 min', kind: 'worker', icon: 'clock', x: 2, y: 1, desc: 'Copies the latest value per entity from the offline store to the online store.' },
    { id: 'on', label: 'Online store', sub: 'Redis', kind: 'cache', icon: 'cache', x: 3, y: 1, desc: 'Only the latest value per entity, keyed for fast lookup.' },
    { id: 'api', label: 'Fraud service', sub: 'model at payment time', kind: 'service', icon: 'shield', x: 1, y: 2, desc: 'Fetches features for the card and merchant, runs the model, approves or blocks.' }
  ],
  pseudo: `
card = Entity(name="card", join_keys=["card_id"])
card_stats = FeatureView(entities=[card], ttl=timedelta(days=1),
    schema=[Field("txn_count_1h", Int64), Field("avg_amount_7d", Float32)],
    source=BigQuerySource(table="features.card_stats", timestamp_field="ts"))
# training: point-in-time join
train = store.get_historical_features(entity_df=labels, features=["card_stats:txn_count_1h", ...])
# serving
store.materialize_incremental(end_date=now())
feats = store.get_online_features(features=[...], entity_rows=[{"card_id": "c_19"}])`,
  steps: [
    {
      from: 'ds', to: 'reg', label: 'feast apply: card_stats view', pc: ['card = Entity', 'card_stats = FeatureView'],
      title: 'Define the feature once',
      caption: 'The feature view says where the data lives, which entity it is keyed by, its timestamp column and how long a value stays valid (TTL).',
      text: [],
      payloadKind: 'Definition',
      payload: { entity: 'card', features: ['txn_count_1h', 'avg_amount_7d'], source: 'features.card_stats', timestamp_field: 'ts', ttl: '1 day' }
    },
    {
      from: 'ds', to: 'off', label: 'get_historical_features(labels)', pc: ['store.get_historical_features'],
      title: 'Build a training set, point-in-time correct',
      caption: 'For each labelled transaction, the store picks the feature value that was current at that transaction\'s timestamp, never a later one. Joining on "latest value" would leak the future into training.',
      text: ['Feast\'s docs name this directly: point-in-time correct feature sets so no future data leaks into model training.'],
      payloadKind: 'Point-in-time join',
      payload: { label_row: { card_id: 'c_19', ts: '2026-10-02 14:03', is_fraud: 1 }, values_available: [{ ts: '13:45', txn_count_1h: 2 }, { ts: '14:00', txn_count_1h: 7 }, { ts: '14:15', txn_count_1h: 11 }], picked: { ts: '14:00', txn_count_1h: 7 } }
    },
    {
      from: 'mat', to: 'off', label: 'read latest per card since last run', pc: ['store.materialize_incremental'],
      title: 'Materialize to the online store',
      caption: 'Every 15 minutes a job reads values newer than its last run and writes the latest per card to Redis.',
      text: [],
      payloadKind: 'Job run',
      payload: { window: '14:00–14:15', rows_read: 182000, keys_written: 61000, took_s: 41 }
    },
    {
      from: 'mat', to: 'on', label: 'HSET card:c_19 txn_count_1h 11 …', pc: ['store.materialize_incremental'],
      title: 'Online store holds only the latest value',
      caption: 'The online store does not keep history; it answers "what is this card\'s value now?" in milliseconds.',
      text: [],
      payloadKind: 'Online row',
      payload: { key: 'card:c_19', txn_count_1h: 11, avg_amount_7d: 23.4, event_ts: '14:15' }
    },
    {
      from: 'api', to: 'on', label: 'get_online_features(card_id=c_19)', pc: ['feats = store.get_online_features'],
      title: 'Serve the same feature at payment time',
      caption: 'A payment arrives. The fraud service fetches the same named features the model was trained with, by the same definitions.',
      text: [],
      payloadKind: 'Lookup',
      payload: { request: { card_id: 'c_19' }, response: { txn_count_1h: 11, avg_amount_7d: 23.4 }, latency_ms: 4 },
      branch: { q: 'Value older than its TTL?', options: [ { label: 'no: use it', goto: 'score' }, { label: 'yes: treat as missing', goto: 'stale' } ] }
    },
    {
      id: 'stale', path: 'stale value', from: 'on', to: 'api', reply: true, label: 'expired → null + default', pc: ['ttl=timedelta(days=1)'],
      title: 'Other outcome: a stale feature',
      caption: 'If materialization has been failing and the value is older than its TTL, the store returns null. The model uses its default for missing values and an alert fires.',
      text: [],
      payloadKind: 'Stale',
      payload: { txn_count_1h: null, reason: 'ttl expired', alert: 'materialization lag > 1 day' },
      next: 'score'
    },
    {
      id: 'score', from: 'api', to: 'api', label: 'model(features) → p_fraud 0.83 → step-up auth', pc: ['feats = store.get_online_features'],
      title: 'Score and act',
      caption: '11 transactions in an hour against a usual 2: the model returns a high fraud probability and the payment asks for 3-D Secure.',
      text: [],
      payloadKind: 'Decision',
      payload: { p_fraud: 0.83, action: 'step_up_3ds', features_logged_for_training: true }
    }
  ],
  decisions: [
    { q: 'Why not query the warehouse at serving time?', options: [
      { name: 'Warehouse query', verdict: 'bad', why: 'Seconds of latency; not built for per-request lookups.' },
      { name: 'Online store fed by materialization', verdict: 'great', why: 'Milliseconds; same definitions as training.' } ] }
  ],
  refs: [
    { label: 'Feast documentation (overview)', url: 'https://docs.feast.dev/' },
    { label: 'Feast docs: Point-in-time joins', url: 'https://docs.feast.dev/getting-started/concepts/point-in-time-joins' },
    { label: 'Uber: Meet Michelangelo, Uber\'s ML platform', url: 'https://www.uber.com/us/en/blog/michelangelo-machine-learning-platform/' }
  ],
  verify: {
    checked: ['Offline store for training, online store for serving, materialization from offline to online, point-in-time correct sets to avoid leakage: Feast docs (read).'],
    uncertain: ['Code is close to Feast\'s Python API but simplified; the fraud features, counts and timings are illustrative.']
  }
});
