flow({
  id: 'raft-consensus',
  title: 'Consensus with Raft (leader election and log replication)',
  category: 'Databases & replication',
  tags: ['Leader election', 'Terms', 'Randomized timeouts', 'Log replication', 'Majority commit', 'Network partition (CP)'],
  summary: 'Raft lets five servers agree on one ordered log even when some crash. One server is leader for a term; it appends client commands and an entry is committed once a majority has stored it. When the leader disappears, a follower whose timer runs out first asks for votes and becomes the new leader. Follow a write, a leader crash and election, and a partitioned minority that cannot accept writes.',
  requirements: {
    functional: ['Replicate a sequence of commands (e.g. key-value writes) to all servers in the same order.', 'Elect a new leader automatically after a failure.'],
    nonFunctional: ['Safety: a committed entry is never lost or reordered.', 'Available while a majority (3 of 5) is up and connected.', 'Used by etcd, Consul, CockroachDB, Kafka KRaft, among others.']
  },
  grid: { cols: 5, rows: 3 },
  nodes: [
    { id: 'client', label: 'Client', sub: 'SET config=v2', kind: 'client', icon: 'laptop', x: 0, y: 1, desc: 'Sends commands to the leader; followers redirect it there.' },
    { id: 's1', label: 'S1', sub: 'leader, term 4', kind: 'service', icon: 'flag', x: 2, y: 1, desc: 'Accepts commands, appends them to its log, sends AppendEntries to followers, also as heartbeats.' },
    { id: 's2', label: 'S2', sub: 'follower', kind: 'service', icon: 'server', x: 1, y: 0, desc: 'Appends entries from the leader if its log matches at the previous index.' },
    { id: 's3', label: 'S3', sub: 'follower', kind: 'service', icon: 'server', x: 3, y: 0, desc: 'Follower. Its election timer resets on every heartbeat.' },
    { id: 's4', label: 'S4', sub: 'follower', kind: 'service', icon: 'server', x: 1, y: 2, desc: 'Follower.' },
    { id: 's5', label: 'S5', sub: 'follower', kind: 'service', icon: 'server', x: 3, y: 2, desc: 'Follower.' },
    { id: 'sm', label: 'State machine', sub: 'key-value store', kind: 'db', icon: 'db', x: 4, y: 1, desc: 'Each server applies committed entries in log order, so all five reach the same state.' }
  ],
  pseudo: `
leader.on_command(cmd): log.append((term=4, cmd)); send AppendEntries(prevIndex, prevTerm, [entry])
follower: if log[prevIndex].term == prevTerm: append; reply success
leader: if success from majority (3 of 5): commitIndex = idx; apply; reply client
follower: if no heartbeat for timeout (random 150-300 ms): term += 1; become candidate
candidate: vote for self; RequestVote(term, lastLogIndex, lastLogTerm)
voter: grant if not voted this term and candidate log is at least as up to date
if votes >= 3: become leader
minority side of a partition: cannot reach 3 -> cannot commit`,
  steps: [
    {
      from: 'client', to: 's1', label: 'SET config=v2', pc: ['leader.on_command'],
      title: 'A command reaches the leader',
      caption: 'S1 is leader for term 4. It appends the command to its own log at index 17 (not committed yet).',
      text: [],
      payloadKind: 'Log entry',
      payload: { index: 17, term: 4, cmd: 'SET config=v2', committed: false }
    },
    {
      from: 's1', to: 's2', label: 'AppendEntries(prev 16/t4, [17])', pc: ['send AppendEntries', 'follower: if log[prevIndex]'],
      title: 'Replicate to followers',
      caption: 'The leader sends the entry with the index and term of the entry before it. A follower only appends if its log matches there; that check keeps all logs identical.',
      text: [],
      payloadKind: 'AppendEntries',
      payload: { term: 4, leaderId: 'S1', prevLogIndex: 16, prevLogTerm: 4, entries: [{ index: 17, term: 4, cmd: 'SET config=v2' }], leaderCommit: 16 }
    },
    {
      from: 's3', to: 's1', reply: true, label: 'success (S2, S3 ack)', pc: ['reply success', 'if success from majority'],
      title: 'A majority stores it: committed',
      caption: 'S2 and S3 reply. With S1 itself that is 3 of 5, a majority, so entry 17 is committed. S4 and S5 will catch up; the leader keeps retrying them.',
      text: ['Any two majorities of 5 overlap in at least one server. That is why a committed entry is always known to whoever wins a later election.'],
      payloadKind: 'Commit',
      payload: { index: 17, acks: ['S1', 'S2', 'S3'], majority: 3, commitIndex: 17 }
    },
    {
      from: 's1', to: 'sm', label: 'apply 17 → config=v2; reply OK', pc: ['apply; reply client'],
      title: 'Apply and answer the client',
      caption: 'The leader applies the entry to its state machine and replies. Followers apply it when the next heartbeat tells them commitIndex = 17.',
      text: [],
      payloadKind: 'Apply',
      payload: { applied_index: 17, key: 'config', value: 'v2', reply: 'OK' },
      branch: { q: 'What happens next?', options: [ { label: 'the leader crashes', goto: 'elect' }, { label: 'a network partition', goto: 'part' } ] }
    },
    {
      id: 'elect', path: 'elect', from: 's3', to: 's2', label: 'timeout 183 ms → RequestVote(term 5, last 17/t4)', pc: ['follower: if no heartbeat', 'candidate: vote for self'],
      title: 'Leader crash: a follower starts an election',
      caption: 'S1 dies. Followers stop getting heartbeats. Each has a random timeout between 150 and 300 ms, so usually one, here S3 at 183 ms, fires first, becomes candidate for term 5 and asks for votes.',
      text: ['The randomized timeout is what keeps candidates from splitting the vote over and over.'],
      payloadKind: 'RequestVote',
      payload: { term: 5, candidateId: 'S3', lastLogIndex: 17, lastLogTerm: 4 }
    },
    {
      from: 's4', to: 's3', reply: true, label: 'voteGranted (S2, S4) → S3 leads term 5', pc: ['voter: grant if', 'if votes >= 3'],
      title: 'Votes arrive: new leader',
      caption: 'S2 and S4 have not voted in term 5 and S3\'s log is at least as up to date as theirs, so they vote yes. S3 has 3 votes and starts sending heartbeats as leader. S4 lacked entry 17; S3 now sends it.',
      text: [],
      payloadKind: 'Votes',
      payload: { term: 5, votes: ['S3', 'S2', 'S4'], leader: 'S3', election_ms: 210 },
      next: 'end'
    },
    {
      id: 'part', path: 'part', from: 's3', to: 's5', label: 'partition: {S1, S2} | {S3, S4, S5} \u2192 S3+S4+S5 elect', pc: ['minority side of a partition'],
      title: 'Other outcome: a network partition',
      caption: 'The network splits. S1 still thinks it is leader but can only reach S2: 2 of 5. It cannot commit anything, so clients on that side get timeouts. On the other side, S3, S4 and S5 elect a leader for term 5 and keep working.',
      text: ['This is the CAP trade-off in practice: Raft picks consistency, so the minority side becomes unavailable rather than accepting writes that could conflict.'],
      payloadKind: 'Partition',
      payload: { minority: ['S1', 'S2'], majority: ['S3', 'S4', 'S5'], minority_can_commit: false, majority_new_term: 5 }
    },
    {
      id: 'end', from: 's3', to: 'sm', label: 'healed: S1 sees term 5 → steps down', pc: ['if votes >= 3: become leader'],
      title: 'The old leader rejoins as follower',
      caption: 'When S1 comes back, any message from term 5 tells it a newer leader exists. It becomes a follower and any uncommitted entries it had are overwritten by the leader\'s log.',
      text: [],
      payloadKind: 'Rejoin',
      payload: { server: 'S1', old_term: 4, new_term: 5, role: 'follower', uncommitted_discarded: 1 }
    }
  ],
  decisions: [
    { q: 'Cluster size?', options: [
      { name: '3 servers', verdict: 'ok', why: 'Tolerates 1 failure; cheapest.' },
      { name: '5 servers', verdict: 'good', why: 'Tolerates 2 failures, e.g. one in maintenance and one crash.' },
      { name: '4 or 6 servers', verdict: 'bad', why: 'Same fault tolerance as 3 or 5 but a bigger majority to reach.' } ] }
  ],
  refs: [
    { label: 'Ongaro & Ousterhout, In Search of an Understandable Consensus Algorithm (Raft paper, PDF)', url: 'https://raft.github.io/raft.pdf' },
    { label: 'The Raft Consensus Algorithm (site with interactive visualization)', url: 'https://raft.github.io/' },
    { label: 'etcd docs: FAQ (cluster size and failure tolerance)', url: 'https://etcd.io/docs/v3.5/faq/' },
    { label: 'ByteByteGo: System Design Interview Vol. 1, chapter "Design a Key-Value Store" (book)', url: 'https://bytebytego.com/courses/system-design-interview/design-a-key-value-store' }
  ],
  verify: {
    checked: ['Terms, AppendEntries consistency check, majority commit, RequestVote rules, randomized election timeouts of e.g. 150–300 ms: Raft paper.', 'Odd cluster sizes and failure tolerance: etcd FAQ.'],
    uncertain: ['Indices, the 183 ms timeout and election time are illustrative.']
  }
});
