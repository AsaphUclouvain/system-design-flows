flow({
  id: 'multi-leader',
  title: 'Multi-leader (active–active) replication and write conflicts',
  category: 'Databases & replication',
  tags: ['Leader per region', 'Async cross-region', 'Write conflicts', 'Last writer wins', 'CRDT merge'],
  summary: 'Each region has its own writable leader, so users write locally with low latency. The cost: two people can change the same row in two regions at the same moment. Follow a profile edit in Frankfurt and a conflicting edit in Virginia, then choose how the conflict is resolved: last writer wins, or a merge.',
  requirements: {
    functional: ['Users in Europe and America can both write with local latency.', 'Every region eventually holds the same data.'],
    nonFunctional: ['A whole region can fail without stopping writes elsewhere.', 'Conflicts are resolved deterministically, the same way in every region.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'eu', label: 'User in Brussels', sub: 'web app', kind: 'client', icon: 'laptop', x: 0, y: 0, desc: 'Routed to the Frankfurt region by GeoDNS.' },
    { id: 'us', label: 'Teammate in Boston', sub: 'mobile app', kind: 'client', icon: 'phone', x: 0, y: 2, desc: 'Routed to the Virginia region.' },
    { id: 'fra', label: 'Leader eu-central', sub: 'Frankfurt, writable', kind: 'db', icon: 'db', x: 1, y: 0, desc: 'Accepts writes for European users and replicates them asynchronously to the other leader.' },
    { id: 'iad', label: 'Leader us-east', sub: 'Virginia, writable', kind: 'db', icon: 'db', x: 1, y: 2, desc: 'Accepts writes for American users and replicates them to Frankfurt.' },
    { id: 'link', label: 'Replication link', sub: '~90 ms across the Atlantic', kind: 'queue', icon: 'route', x: 2, y: 1, desc: 'Ships each leader\'s changes to the other, with the version metadata needed to detect conflicts.' },
    { id: 'resolve', label: 'Conflict resolver', sub: 'runs in both regions', kind: 'worker', icon: 'split', x: 3, y: 1, desc: 'Same rule in every region, so both converge to the same value: e.g. highest timestamp wins, or a field-level merge.' }
  ],
  pseudo: `
def local_write(region, key, change):
    row = region.db.apply(key, change)
    row.version = (now(), region.id)            # timestamp + tie-breaker
    replicate_async(other_regions, key, row)    # no cross-region wait
    return "OK"

def on_replicated(region, key, incoming):
    local = region.db.get(key)
    if not concurrent(local, incoming):
        region.db.put(key, newer(local, incoming))
    elif policy == "last_writer_wins":
        region.db.put(key, max(local, incoming, key=version))
    else:                                        # merge (CRDT / field-level)
        region.db.put(key, merge(local, incoming))`,
  steps: [
    {
      from: 'eu', to: 'fra', label: 'PATCH /team/42 {name:"Team Ember"}', pc: ['def local_write', 'db.apply'],
      title: 'A write in Frankfurt',
      caption: 'At 10:00:00.100 UTC the Brussels user renames the team to "Team Ember". Frankfurt commits locally in 4 ms.',
      text: ['With a single leader in Virginia this write would cross the Atlantic twice (about 180 ms). Local leaders are the whole point of multi-leader replication.'],
      payloadKind: 'Write',
      payload: { table: 'teams', id: 42, set: { name: 'Team Ember' }, version: { ts: '10:00:00.100', region: 'eu-central' } }
    },
    {
      from: 'us', to: 'iad', label: 'PATCH /team/42 {name:"Team Blaze", color:"red"}', pc: ['def local_write', 'db.apply'],
      title: 'Meanwhile, a write to the same row in Virginia',
      caption: 'At 10:00:00.130, before Frankfurt\'s change has arrived, the Boston teammate renames the same team to "Team Blaze" and sets its colour to red.',
      text: ['Neither leader knew about the other\'s write when it accepted its own. That is a conflict: two concurrent writes to one key.'],
      payloadKind: 'Write',
      payload: { table: 'teams', id: 42, set: { name: 'Team Blaze', color: 'red' }, version: { ts: '10:00:00.130', region: 'us-east' } }
    },
    {
      from: 'fra', to: 'link', async: true, label: 'change v(…100, eu)', pc: ['replicate_async'],
      title: 'Both leaders ship their changes',
      caption: 'Each leader sends its change to the other asynchronously. The two changes cross in the middle of the Atlantic about 90 ms later.',
      text: ['Replication must carry enough metadata to detect conflicts: a version, a timestamp, or a vector clock per row or per field.'],
      payloadKind: 'Replicated changes',
      payload: { 'eu→us': { id: 42, name: 'Team Ember', v: ['10:00:00.100', 'eu-central'] }, 'us→eu': { id: 42, name: 'Team Blaze', color: 'red', v: ['10:00:00.130', 'us-east'] } }
    },
    {
      from: 'link', to: 'resolve', label: 'concurrent writes to teams/42', pc: ['def on_replicated', 'if not concurrent'],
      title: 'Each region detects the conflict',
      caption: 'Frankfurt receives Virginia\'s change and sees that it does not build on its own; Virginia sees the mirror image. Both must now apply the same rule.',
      text: ['Common strategies: avoid conflicts (route all writes for one record to one leader), last write wins, custom merge logic, or CRDTs. ByteByteGo stresses that conflict management is the hard part of multi-leader setups.'],
      payloadKind: 'Conflict',
      payload: { key: 'teams/42', local_in_fra: { name: 'Team Ember' }, incoming_from_us: { name: 'Team Blaze', color: 'red' }, concurrent: true },
      branch: { q: 'Which resolution policy is configured?', options: [ { label: 'last writer wins', goto: 'lww' }, { label: 'field-level merge', goto: 'merge' } ] }
    },
    {
      id: 'lww', path: 'last writer wins', from: 'resolve', to: 'fra', label: 'keep v(…130, us): "Team Blaze"', pc: ['last_writer_wins', 'max(local, incoming'],
      title: 'Last writer wins: the later timestamp survives',
      caption: 'Virginia\'s write has the later timestamp, so both regions keep "Team Blaze", red. The Brussels user\'s rename is silently lost.',
      text: ['DynamoDB global tables use this rule: the modification with the latest internal timestamp wins, per item. It is simple and converges, but it depends on clocks and discards one of the writes.'],
      payloadKind: 'Resolved row (both regions)',
      payload: { id: 42, name: 'Team Blaze', color: 'red', lost_write: { name: 'Team Ember', from: 'eu-central' } },
      end: true
    },
    {
      id: 'merge', path: 'merge', from: 'resolve', to: 'iad', label: 'merge fields', pc: ['merge(local, incoming)'],
      title: 'Merge: keep non-conflicting fields from both',
      caption: 'With per-field versions, the colour change has no rival, so it is kept. Only the name truly conflicts; a rule (later timestamp) or the app (show both, ask the user) decides it.',
      text: ['CRDTs push this further: sets, counters and text types defined so that merging in any order gives the same result. Collaborative editors and some databases (Redis Enterprise active-active, Riak) use them.'],
      payloadKind: 'Resolved row (both regions)',
      payload: { id: 42, name: 'Team Blaze', name_conflict: ['Team Ember', 'Team Blaze'], color: 'red', rule: 'per-field versions; name by later timestamp, both kept in history' }
    },
    {
      path: 'merge', from: 'iad', to: 'us', reply: true, label: 'team/42 updated (conflict noted)', pc: ['merge(local, incoming)'],
      title: 'Both regions converge',
      caption: 'Frankfurt applies the same merge, so both regions hold identical data. The app can show "renamed by two people at once" in the activity log.',
      text: ['The cleanest solution is often to avoid conflicts: give each record a home region (for example the team\'s creator\'s region) and send all its writes there.'],
      payloadKind: 'Final state',
      payload: { 'eu-central': { name: 'Team Blaze', color: 'red' }, 'us-east': { name: 'Team Blaze', color: 'red' }, converged: true }
    }
  ],
  decisions: [
    { q: 'Single leader with cross-region replicas, or a leader per region?', options: [
      { name: 'Single leader', verdict: 'good', why: 'No write conflicts ever. Remote users pay a cross-region round trip on every write; failover is needed if the leader\'s region fails.' },
      { name: 'Leader per region', verdict: 'good', why: 'Local writes and region-level fault tolerance. You must design for conflicts, and constraints like uniqueness become hard to enforce.' } ] }
  ],
  refs: [
    { label: 'ByteByteGo newsletter: How to choose a replication strategy (multi-leader, conflict handling)', url: 'https://blog.bytebytego.com/p/how-to-choose-a-replication-strategy', note: 'subscriber post; the free part covers multi-leader conflicts and CRDTs.' },
    { label: 'AWS docs: How DynamoDB global tables work (last writer wins)', url: 'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/V2globaltables_HowItWorks.html' },
    { label: 'CRDT overview (crdt.tech)', url: 'https://crdt.tech/' }
  ],
  verify: {
    checked: ['Multi-leader definition, conflict management and CRDT merging: ByteByteGo replication-strategy post (free part).', 'Per-item last-writer-wins with internal timestamps, replication typically within a second: DynamoDB global tables docs.'],
    uncertain: ['Field-level merge is a design pattern; which databases do it natively varies. Product names in the CRDT note are examples, not checked against their current docs.']
  }
});
