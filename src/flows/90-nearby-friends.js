flow({
  id: 'nearby-friends',
  title: 'Nearby friends (live location sharing)',
  category: 'Real-time',
  tags: ['WebSocket servers', 'Redis pub/sub channel per user', 'Location cache with TTL', 'Distance filter', 'Fan-out to friends', 'Location history'],
  summary: 'Friends who opted in see each other on a map when they are within 5 km, updated every 30 seconds. Each phone keeps a WebSocket open; every location update is published on the sender\'s own channel, and each friend\'s WebSocket server, subscribed to that channel, checks the distance before pushing it. Follow one update, a friend who is too far, and a friend who just went offline.',
  requirements: {
    functional: ['See friends within 5 km on a map with their distance and last-updated time.', 'Location updates every 30 s.', 'Friends who are inactive for 10 min disappear.'],
    nonFunctional: ['Updates reach friends in a few seconds.', 'Location is only shared with opted-in friends.', 'Losing an occasional update is fine.']
  },
  estimates: ['Illustrative: 10 M concurrent users × 1 update / 30 s ≈ 334 k updates/s.', 'Average 400 friends, ~10% online and nearby → ~40 pushes per update.'],
  grid: { cols: 5, rows: 3 },
  nodes: [
    { id: 'alice', label: 'Alice\'s phone', sub: 'sends location', kind: 'client', icon: 'phone', x: 0, y: 1, desc: 'Sends {lat, lng} every 30 s over its WebSocket.' },
    { id: 'ws1', label: 'WebSocket server A', sub: 'stateful', kind: 'service', icon: 'plug', x: 1, y: 1, desc: 'Holds Alice\'s connection. Writes her location, then publishes it on her channel.' },
    { id: 'cache', label: 'Location cache', sub: 'Redis, TTL 10 min', kind: 'cache', icon: 'pin', x: 1, y: 0, desc: 'Latest location per user. The TTL makes inactive users expire on their own.' },
    { id: 'hist', label: 'Location history', sub: 'Cassandra', kind: 'db', icon: 'db', x: 1, y: 2, desc: 'Append-only history for other features (and ML). Not on the hot path.' },
    { id: 'pubsub', label: 'Redis pub/sub', sub: 'channel per user', kind: 'queue', icon: 'route', x: 2, y: 1, desc: 'One lightweight channel per user. Fire-and-forget: if nobody is subscribed, the message is dropped.' },
    { id: 'ws2', label: 'WebSocket server B', sub: 'holds Bob', kind: 'service', icon: 'plug', x: 3, y: 1, desc: 'Subscribed to the channels of all of Bob\'s online friends. Filters by distance before pushing.' },
    { id: 'bob', label: 'Bob\'s phone', sub: 'friend, 1.8 km away', kind: 'client', icon: 'phone', x: 4, y: 1, desc: 'Moves Alice\'s pin on the map.' }
  ],
  pseudo: `
on_ws_message(user, loc):
    redis.set(f"loc:{user}", loc, ex=600)
    history.append(user, loc)
    redis.publish(f"ch:{user}", loc)
on_connect(user):          # on Bob's server
    for f in online_friends(user): redis.subscribe(f"ch:{f}")
on_channel_message(friend, loc, subscriber):
    d = haversine(loc, last_loc(subscriber))
    if d <= 5_000: ws.send(subscriber, {friend, loc, d})
    else: skip`,
  steps: [
    {
      from: 'alice', to: 'ws1', label: 'WS {lat 50.668, lng 4.612, ts}', pc: ['on_ws_message'],
      title: 'Alice\'s phone sends its location',
      caption: 'Every 30 seconds the app sends a tiny message over the WebSocket it keeps open. No HTTP request per update.',
      text: [],
      payloadKind: 'Location update',
      payload: { type: 'loc', user_id: 'u_alice', lat: 50.6681, lng: 4.6118, ts: 1764169330 }
    },
    {
      from: 'ws1', to: 'cache', label: 'SET loc:u_alice … EX 600', pc: ['redis.set'],
      title: 'Save the latest location with a TTL',
      caption: 'Only the latest point matters for the map. The 10-minute TTL means a user who stops sending simply disappears; no clean-up job needed.',
      text: [],
      payloadKind: 'Cache write',
      payload: { key: 'loc:u_alice', value: { lat: 50.6681, lng: 4.6118, ts: 1764169330 }, ttl_s: 600 }
    },
    {
      from: 'ws1', to: 'hist', label: 'append (u_alice, ts, lat, lng)', pc: ['history.append'],
      title: 'Append to history (off the hot path)',
      caption: 'A write-heavy, append-only table partitioned by user. Friends never read from it.',
      text: [],
      payloadKind: 'History row',
      payload: { user_id: 'u_alice', ts: 1764169330, lat: 50.6681, lng: 4.6118 }
    },
    {
      from: 'ws1', to: 'pubsub', label: 'PUBLISH ch:u_alice {…}', pc: ['redis.publish'],
      title: 'Publish on Alice\'s own channel',
      caption: 'One publish, regardless of how many friends she has. Redis delivers it to every server subscribed to ch:u_alice.',
      text: ['Redis pub/sub is at-most-once: a message published while nobody is subscribed is gone. That is fine here, because the next update arrives in 30 seconds.'],
      payloadKind: 'Publish',
      payload: { channel: 'ch:u_alice', subscribers_reached: 37 }
    },
    {
      from: 'pubsub', to: 'ws2', label: 'message on ch:u_alice → subscriber u_bob', pc: ['on_channel_message', 'd = haversine'],
      title: 'Bob\'s server receives it and checks the distance',
      caption: 'When Bob connected, his server subscribed to the channels of his online friends. It now computes the distance between Alice\'s new point and Bob\'s last point.',
      text: [],
      payloadKind: 'Distance check',
      payload: { friend: 'u_alice', subscriber: 'u_bob', distance_m: 1820, radius_m: 5000 },
      branch: { q: 'Within 5 km?', options: [ { label: 'yes: push to Bob', goto: 'push' }, { label: 'no: drop it', goto: 'far' } ] }
    },
    {
      id: 'far', path: 'far', from: 'ws2', to: 'ws2', label: 'u_carol is 48 km away → skip', pc: ['else: skip'],
      title: 'Other outcome: friend too far',
      caption: 'Carol is also Alice\'s friend, but she is in Brussels. Her server gets the same message and drops it: no push, no battery wasted on her phone.',
      text: [],
      payloadKind: 'Filtered',
      payload: { friend: 'u_alice', subscriber: 'u_carol', distance_m: 48200, pushed: false },
      next: 'offline'
    },
    {
      id: 'push', from: 'ws2', to: 'bob', label: 'WS {friend alice, 1.8 km, just now}', pc: ['ws.send'],
      title: 'Bob\'s map moves Alice\'s pin',
      caption: 'Total time from Alice\'s phone to Bob\'s screen: well under a second inside one region.',
      text: [],
      payloadKind: 'Push',
      payload: { type: 'friend_loc', friend: 'u_alice', lat: 50.6681, lng: 4.6118, distance_m: 1820, updated: 'just now' }
    },
    {
      id: 'offline', path: 'offline', from: 'cache', to: 'ws2', label: 'loc:u_dan expired (TTL)', pc: ['ex=600', 'online_friends(user)'],
      title: 'Other outcome: a friend goes quiet',
      caption: 'Dan closed the app 10 minutes ago. His cache key has expired, so he is not in the online-friends list any more and disappears from Bob\'s map.',
      text: [],
      payloadKind: 'Expiry',
      payload: { key: 'loc:u_dan', last_ts: 1764168700, status: 'expired', shown_on_map: false }
    }
  ],
  decisions: [
    { q: 'How to route updates to friends?', options: [
      { name: 'Pub/sub channel per user', verdict: 'good', why: 'One publish per update; subscriptions follow the friend graph; channels are cheap in Redis.' },
      { name: 'Geohash grid channels', verdict: 'ok', why: 'Good for "anyone nearby" (strangers), but friends-only needs the friend graph anyway.' } ] },
    { q: 'Stateful WebSocket servers?', options: [
      { name: 'Yes, with draining on deploy', verdict: 'good', why: 'Needed for push; remove a node by marking it draining and letting clients reconnect elsewhere.' } ] }
  ],
  refs: [
    { label: 'Redis docs: Pub/Sub (delivery semantics)', url: 'https://redis.io/docs/latest/develop/pubsub/' },
    { label: 'Redis docs: Key expiration (EXPIRE)', url: 'https://redis.io/docs/latest/commands/expire/' },
    { label: 'MDN: The WebSocket API', url: 'https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API' },
    { label: 'ByteByteGo: System Design Interview Vol. 2, chapter "Nearby Friends" (book)', url: 'https://bytebytego.com/courses/system-design-interview/nearby-friends' }
  ],
  verify: {
    checked: ['Pub/sub is at-most-once and messages with no subscriber are lost: Redis Pub/Sub docs.', 'Keys with an expiry are removed automatically: Redis EXPIRE docs.'],
    uncertain: ['User counts, friend counts, the 5 km radius and the 30 s interval are illustrative design choices.']
  }
});
