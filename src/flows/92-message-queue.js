flow({
  id: 'message-queue',
  title: 'Distributed message queue (Kafka-style log)',
  category: 'Messaging & events',
  tags: ['Topic partitions', 'Append-only log', 'Leader + in-sync replicas', 'acks=all', 'Consumer groups', 'Committed offsets', 'Idempotent producer'],
  summary: 'A distributed message queue is a replicated, append-only log split into partitions. Producers append to a partition leader, followers copy it, and a write counts as committed once all in-sync replicas have it. Consumers in a group each own some partitions and remember their position as an offset. Follow one order event, a broker crash, and a consumer that restarts.',
  requirements: {
    functional: ['Producers publish to a topic; many independent consumer groups read it.', 'Messages in one partition are read in order.', 'Consumers can replay from an earlier offset.'],
    nonFunctional: ['No loss of committed messages when one broker dies.', 'Hundreds of thousands of messages per second per cluster.', 'Retention by time or size (e.g. 7 days).']
  },
  grid: { cols: 5, rows: 3 },
  nodes: [
    { id: 'prod', label: 'Order service', sub: 'producer', kind: 'service', icon: 'cart', x: 0, y: 1, desc: 'Publishes OrderPlaced events, keyed by order_id so one order\'s events stay in one partition (in order).' },
    { id: 'leader', label: 'Broker 1', sub: 'leader of orders-3', kind: 'queue', icon: 'log', x: 2, y: 1, desc: 'Appends the record to the end of partition 3\'s log file on disk and serves reads.' },
    { id: 'f1', label: 'Broker 2', sub: 'follower', kind: 'queue', icon: 'log', x: 2, y: 0, desc: 'Fetches new records from the leader and appends them to its own copy.' },
    { id: 'f2', label: 'Broker 3', sub: 'follower', kind: 'queue', icon: 'log', x: 2, y: 2, desc: 'Second follower. Together the three form the in-sync replica set (ISR).' },
    { id: 'ctrl', label: 'Controller', sub: 'KRaft quorum', kind: 'service', icon: 'vote', x: 1, y: 0, desc: 'Keeps cluster metadata (who leads which partition, who is in sync) and elects a new leader when a broker dies.' },
    { id: 'cons', label: 'Email consumer', sub: 'group "emails"', kind: 'worker', icon: 'worker', x: 4, y: 1, desc: 'One of 3 consumers in its group; it owns partitions 3 and 4.' },
    { id: 'offs', label: 'Offsets topic', sub: '__consumer_offsets', kind: 'db', icon: 'db', x: 3, y: 2, desc: 'Where each group commits "I have processed up to offset N" per partition.' }
  ],
  pseudo: `
producer(acks="all", enable_idempotence=True)
p = hash("ord_9921") % 12            # -> partition 3
leader(orders-3).append(record)       # gets offset 48211
followers fetch from leader; leader tracks ISR
if all ISR have offset 48211: high_watermark = 48212; ack producer
if ISR shrinks below min.insync.replicas=2: reject writes
consumer: records = poll(orders-3, from=committed+1)
process(records); commit(group="emails", orders-3, 48211)`,
  steps: [
    {
      from: 'prod', to: 'leader', label: 'produce orders key=ord_9921 → partition 3', pc: ['producer(acks', 'p = hash'],
      title: 'The producer picks a partition by key',
      caption: 'The key is hashed to one of 12 partitions. Every event for ord_9921 lands in partition 3, so they are consumed in order. The producer asks for acks=all and is idempotent (sequence numbers stop retries from creating duplicates).',
      text: [],
      payloadKind: 'Produce request',
      payload: { topic: 'orders', partition: 3, key: 'ord_9921', value: { type: 'OrderPlaced', total_eur: 49.9 }, producer_id: 7301, seq: 912, acks: 'all' }
    },
    {
      from: 'leader', to: 'leader', label: 'append at offset 48211', pc: ['leader(orders-3).append'],
      title: 'Append to the end of the log',
      caption: 'The leader writes the record to the end of its segment file. Appends are sequential disk writes, which is why a log is fast.',
      text: [],
      payloadKind: 'Log entry',
      payload: { partition: 'orders-3', offset: 48211, segment: '00000000000048000.log', bytes: 212 }
    },
    {
      from: 'f1', to: 'leader', label: 'Fetch(orders-3, from 48211)', pc: ['followers fetch from leader'],
      title: 'Followers pull the new record',
      caption: 'Followers continuously fetch from the leader, like consumers. Broker 2 and Broker 3 both copy offset 48211.',
      text: [],
      payloadKind: 'Replica fetch',
      payload: { replica: 'broker-2', partition: 'orders-3', fetch_offset: 48211, isr: [1, 2, 3] }
    },
    {
      from: 'f2', to: 'leader', label: 'Fetch(orders-3, from 48211)', pc: ['followers fetch from leader'],
      title: 'The second follower catches up too',
      caption: 'Now every in-sync replica has the record.',
      text: [],
      payloadKind: 'Replica fetch',
      payload: { replica: 'broker-3', partition: 'orders-3', fetch_offset: 48211 }
    },
    {
      from: 'leader', to: 'prod', reply: true, label: 'ack: offset 48211 committed', pc: ['high_watermark = 48212'],
      title: 'Committed: the producer gets its ack',
      caption: 'Because all in-sync replicas have it, the high watermark moves past 48211. Only now can consumers see it, and only now does the producer get success.',
      text: [],
      payloadKind: 'Produce response',
      payload: { partition: 3, base_offset: 48211, error: null },
      branch: { q: 'Does a broker crash now?', options: [ { label: 'no: consumers read it', goto: 'read' }, { label: 'yes: leader dies', goto: 'crash' } ] }
    },
    {
      id: 'crash', path: 'crash', from: 'ctrl', to: 'f1', label: 'broker-1 gone → broker-2 leads orders-3', pc: ['leader tracks ISR'],
      title: 'Other outcome: the leader crashes',
      caption: 'The controller notices broker 1 stopped heartbeating and makes broker 2, which is in the ISR, the new leader. It already has offset 48211, so no committed record is lost. Producers and consumers refresh metadata and continue.',
      text: ['If too few replicas are in sync (fewer than min.insync.replicas), the leader rejects acks=all writes instead of accepting data it could lose.'],
      payloadKind: 'Leader election',
      payload: { partition: 'orders-3', old_leader: 1, new_leader: 2, isr: [2, 3], leader_epoch: 15, committed_lost: 0 }
    },
    {
      id: 'read', from: 'cons', to: 'leader', label: 'poll(orders-3, from 48211)', pc: ['consumer: records = poll'],
      title: 'A consumer in the group reads it',
      caption: 'In group "emails", partitions are split across 3 consumers; this one owns partitions 3 and 4. Other groups (analytics, fraud) read the same record independently.',
      text: [],
      payloadKind: 'Fetch response',
      payload: { group: 'emails', partition: 3, records: [{ offset: 48211, key: 'ord_9921', type: 'OrderPlaced' }] }
    },
    {
      from: 'cons', to: 'offs', label: 'commit emails/orders-3 = 48212', pc: ['process(records); commit'],
      title: 'Commit the position after processing',
      caption: 'After the confirmation email is sent, the consumer commits its offset. Commit after processing gives at-least-once: a crash before the commit means the record is read again, so processing must be idempotent.',
      text: [],
      payloadKind: 'Offset commit',
      payload: { group: 'emails', partition: 'orders-3', committed_offset: 48212 }
    },
    {
      id: 'restart', from: 'offs', to: 'cons', label: 'rebalance → resume orders-3 at 48212', pc: ['from=committed+1'],
      title: 'A restart resumes from the committed offset',
      caption: 'When a consumer joins or leaves, the group rebalances partitions. Whoever owns orders-3 next starts from the committed offset, not from the beginning.',
      text: [],
      payloadKind: 'Resume',
      payload: { group: 'emails', partition: 'orders-3', resume_at: 48212, retention: '7 days' }
    }
  ],
  decisions: [
    { q: 'acks setting?', options: [
      { name: 'acks=all + min.insync.replicas=2', verdict: 'good', why: 'A committed write survives one broker loss.' },
      { name: 'acks=1', verdict: 'ok', why: 'Faster, but a leader crash before followers copy it loses the record.' } ] },
    { q: 'Log or classic queue?', options: [
      { name: 'Log (Kafka, Pulsar)', verdict: 'good', why: 'Replay, many independent consumer groups, ordering per partition.' },
      { name: 'Queue with per-message ack (RabbitMQ, SQS)', verdict: 'ok', why: 'Simpler work distribution and per-message retry; no replay after delete.' } ] }
  ],
  refs: [
    { label: 'Apache Kafka docs: Design (log, replication, ISR, delivery semantics)', url: 'https://kafka.apache.org/41/design/design/' },
    { label: 'Confluent docs: Kafka replication', url: 'https://docs.confluent.io/kafka/design/replication.html' },
    { label: 'Confluent docs: Message delivery guarantees', url: 'https://docs.confluent.io/kafka/design/delivery-semantics.html' },
    { label: 'ByteByteGo: System Design Interview Vol. 2, chapter "Distributed Message Queue" (book)', url: 'https://bytebytego.com/courses/system-design-interview/distributed-message-queue' }
  ],
  verify: {
    checked: ['Partitioned replicated log, leader and in-sync replicas, committed = all ISR have it, min.insync.replicas, idempotent producer: Kafka design docs and Confluent replication docs.', 'Committing after processing gives at-least-once: Confluent delivery semantics.'],
    uncertain: ['Offsets, partition counts and broker numbers are illustrative.']
  }
});
