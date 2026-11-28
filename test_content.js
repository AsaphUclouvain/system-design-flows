// Content tests with known answers: replay numbers the flows claim and fail when the text and the maths disagree.
// Run: node test_content.js   (no browser needed)
const fs = require('fs'), path = require('path'), assert = require('assert'); global.window = {};
const dir = __dirname; eval(fs.readFileSync(path.join(dir, 'src/data.js'), 'utf8'));
fs.readdirSync(path.join(dir, 'src/flows')).sort().forEach(f => eval(fs.readFileSync(path.join(dir, 'src/flows', f), 'utf8')));
const flows = window.SD_FLOWS, byId = Object.fromEntries(flows.map(f => [f.id, f]));
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ', name); } catch (e) { failed++; console.log('FAIL ', name, '\n      ', e.message); }
}

// Token bucket as the rate limiter's Lua script runs it: refill by elapsed time, cap at capacity, take one token if there is one.
function tokenBucket({ tokens, capacity, refillPerSec, times }) {
  let last = 0; const allowed = [];
  times.forEach((t, i) => {
    tokens = Math.min(capacity, tokens + (t - last) * refillPerSec); last = t;
    if (tokens >= 1) { tokens -= 1; allowed.push(i + 1); }
  });
  return { allowed, tokens };
}

test('token bucket: a full bucket of 20 lets exactly 20 instant requests through', () => {
  const r = tokenBucket({ tokens: 20, capacity: 20, refillPerSec: 100 / 60, times: Array(25).fill(0) });
  assert.strictEqual(r.allowed.length, 20);
});

test('rate-limiter step 6: payload and caption match a replay of the bucket', () => {
  const f = byId['rate-limiter'];
  const rule = f.steps.map(s => s.payload && s.payload.rule).find(Boolean);
  const s = f.steps.find(st => st.payload && st.payload.t0_tokens !== undefined);
  assert(rule && s, 'rule or burst step not found');
  const p = s.payload;
  // 25 evenly spaced requests over one second: one every 40 ms, the last at t = 1 s
  const times = Array.from({ length: p.requests }, (_, i) => (i + 1) / p.requests);
  const r = tokenBucket({ tokens: p.t0_tokens, capacity: rule.capacity, refillPerSec: rule.refill_per_sec, times });
  assert.strictEqual(r.allowed.length, p.allowed, 'allowed');
  assert.strictEqual(p.requests - r.allowed.length, p.rejected, 'rejected');
  assert.strictEqual(Math.round(r.tokens * 100) / 100, p.tokens_after, 'tokens_after');
  assert.strictEqual(Math.round(rule.refill_per_sec * 100) / 100, p.refilled_in_1s, 'refill per second');
  const words = s.caption + ' ' + s.text.join(' ');
  assert(words.includes('first ' + (r.allowed.findIndex((n, i) => n !== i + 1) === -1 ? r.allowed.length : r.allowed.findIndex((n, i) => n !== i + 1))), 'caption names the wrong number of requests passing in a row');
  assert(words.includes(p.rejected + ' get 429'), 'caption does not say ' + p.rejected + ' get 429');
  assert(words.includes(p.allowed + ' requests'), 'text does not say ' + p.allowed + ' requests');
});

test('leaderboard: Redis skip list (p = 1/4) needs about 12 levels for 10M members', () => {
  const levels = Math.ceil(Math.log(10e6) / Math.log(4));
  assert.strictEqual(levels, 12);
  assert(JSON.stringify(byId['leaderboard']).includes('about 12 levels'), 'scale card does not say about 12 levels');
});

test('every step points at nodes that exist, and every branch and next target exists', () => {
  const problems = [];
  for (const f of flows) {
    const nodes = new Set(f.nodes.map(n => n.id)), sids = new Set(f.steps.map(s => s.id).filter(Boolean));
    f.steps.forEach((s, i) => {
      if (!nodes.has(s.from)) problems.push(f.id + ' step ' + (i + 1) + ' from ' + s.from);
      if (!nodes.has(s.to)) problems.push(f.id + ' step ' + (i + 1) + ' to ' + s.to);
      if (s.next && !sids.has(s.next)) problems.push(f.id + ' step ' + (i + 1) + ' next ' + s.next);
      ((s.branch && s.branch.options) || []).forEach(o => { if (!sids.has(o.goto)) problems.push(f.id + ' step ' + (i + 1) + ' goto ' + o.goto); });
    });
  }
  assert.deepStrictEqual(problems, []);
});

test('kv-store: the coordinator, not the last writer, increments the vector clock', () => {
  const f = byId['kv-store'], w = f.steps.find(s => s.payload && s.payload.coordinator);
  assert(w, 'write step with a coordinator not found');
  const { before, after } = w.payload.vclock, c = w.payload.coordinator;
  assert.strictEqual(after[c], (before[c] || 0) + 1, 'coordinator entry not incremented by one');
  Object.keys(before).filter(k => k !== c).forEach(k => assert.strictEqual(after[k], before[k], 'other entries must not change'));
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
