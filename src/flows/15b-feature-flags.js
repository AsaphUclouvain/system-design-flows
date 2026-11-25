flow({
  id: 'feature-flags',
  title: 'Feature flags and gradual rollout',
  category: 'Infrastructure foundations',
  tags: ['Percentage rollout', 'Consistent bucketing', 'Local evaluation', 'Streaming updates', 'Kill switch', 'Exposure events'],
  summary: 'A new checkout design ships turned off, then goes to 5% of Belgian users, then everyone, without a deploy. Follow a flag change from the dashboard to every FastAPI pod and Next.js server in under a second, how each request is evaluated locally in microseconds, and how a kill switch turns it off when errors rise.',
  requirements: {
    functional: [
      'Turn features on or off for segments (country, plan, internal staff) and percentages of users.',
      'A user keeps the same variant on every request, device and service.',
      'Changes take effect everywhere within seconds, with an audit trail.'
    ],
    nonFunctional: [
      'Flag evaluation adds no network call to the request path.',
      'If the flag service is down, apps keep working with the last known rules.',
      'No flicker: server-rendered pages and client code agree on the variant.'
    ]
  },
  estimates: [
    { label: 'Evaluations', value: '≈ 2M / s', note: '20k req/s × ~100 flag checks per request across services.' },
    { label: 'Per evaluation', value: '< 5 µs', note: 'In-memory rules plus one hash; no I/O.' },
    { label: 'Rule set size', value: '≈ 300 KB', note: '~400 flags with targeting rules, sent compressed to every SDK.' },
    { label: 'Propagation', value: '< 1 s', note: 'Server-sent events from the flag service to each SDK.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'pm', label: 'Product manager', sub: 'flag dashboard', kind: 'client', icon: 'user', x: 0, y: 0, desc: 'Edits targeting rules and rollout percentages.' },
    { id: 'flags', label: 'Flag service', sub: 'FastAPI', kind: 'service', icon: 'flag', x: 1, y: 0, desc: 'Stores rules, versions them, streams changes to SDKs.' },
    { id: 'fdb', label: 'Flag store', sub: 'PostgreSQL', kind: 'db', x: 1, y: 1, desc: 'Flags, rules, environments and the audit log.' },
    { id: 'sdk', label: 'Server SDK', sub: 'in each pod', kind: 'worker', icon: 'cpu', x: 2, y: 0, desc: 'Keeps rules in memory, evaluates locally, reports exposures.' },
    { id: 'next', label: 'Next.js server', sub: 'middleware', kind: 'service', x: 2, y: 1, desc: 'Evaluates flags on the server and passes the result to the page.' },
    { id: 'user', label: 'Shopper', sub: 'browser', kind: 'client', icon: 'phone', x: 3, y: 1, desc: 'Sees the old or new checkout.' },
    { id: 'api', label: 'Checkout API', sub: 'FastAPI', kind: 'service', icon: 'cart', x: 3, y: 0, desc: 'Uses the same flag to switch backend behaviour.' },
    { id: 'analytics', label: 'Exposure events', sub: 'Kafka → warehouse', kind: 'queue', icon: 'chart', x: 2, y: 2, desc: 'Who saw which variant, joined later with conversions and errors.' },
    { id: 'mon', label: 'Guardrail monitor', sub: 'metrics', kind: 'worker', icon: 'pulse', x: 3, y: 2, desc: 'Watches error rate per variant and can trip the kill switch.' }
  ],
  steps: [
    {
      from: 'pm', to: 'flags', label: 'PATCH rollout 5% BE',
      title: 'Roll out to 5% of Belgian users',
      caption: 'The flag new-checkout has been on for staff for a week. The product manager adds a rule: users in Belgium, 5% get variant on. The change needs a reason and is versioned.',
      text: ['Shipping code turned off and turning it on separately decouples deploying from releasing: the deploy can happen on Tuesday, the release when the team is watching.'],
      payloadKind: 'HTTP request',
      payload: { method: 'PATCH', path: '/v1/environments/prod/flags/new-checkout', headers: { 'If-Match': '"v41"' }, body: { rules: [{ id: 'r_staff', when: { attr: 'email', op: 'ends_with', value: '@shop.example' }, serve: 'on' }, { id: 'r_be', when: { attr: 'country', op: 'in', value: ['BE'] }, rollout: { on: 5, off: 95 }, bucket_by: 'user_id' }], default: 'off', reason: 'Start BE rollout (CHK-412)' } },
      fields: { 'If-Match': 'Optimistic locking: two people editing the same flag cannot overwrite each other.', bucket_by: 'Which attribute keeps a user in the same bucket. user_id for logged-in users, a stable anonymous id otherwise.' }
    },
    {
      from: 'flags', to: 'fdb', label: 'save v42 + audit',
      title: 'Save the new version and the audit entry',
      caption: 'The rules are saved as version 42 of the flag, and an audit row records who changed what and why. Every change can be diffed and reverted.',
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
BEGIN;
UPDATE flags SET rules = $1, version = 42, updated_at = now()
  WHERE env = 'prod' AND key = 'new-checkout' AND version = 41;
INSERT INTO flag_audit (env, key, version, actor, reason, diff)
VALUES ('prod', 'new-checkout', 42, 'usr_pm_lea', 'Start BE rollout (CHK-412)',
        '{"added_rule":"r_be","rollout":{"on":5}}');
UPDATE environments SET ruleset_version = ruleset_version + 1 WHERE env = 'prod';   -- 9182
COMMIT;`,
      text: ['The environment has one global ruleset version. SDKs compare it to know they are up to date, without comparing 400 flags one by one.']
    },
    {
      from: 'flags', to: 'sdk', label: 'SSE: ruleset 9182',
      title: 'Stream the change to every SDK',
      caption: 'Every server SDK keeps one Server-Sent Events connection to the flag service. The new version of new-checkout is pushed to all of them, about 0.3 s after the save.',
      text: ['Streaming beats polling here: changes arrive in under a second, and the connection is idle the rest of the time. SDKs also poll every 5 minutes as a backup in case a stream silently died.'],
      payloadKind: 'SSE message',
      payloadLang: 'text',
      payload: String.raw`
event: patch
id: 9182
data: {"key":"new-checkout","version":42,"rules":[{"id":"r_staff",…},
       {"id":"r_be","when":{"attr":"country","op":"in","value":["BE"]},
        "rollout":{"on":5,"off":95},"bucket_by":"user_id","salt":"nc-7f1"}],"default":"off"}`,
      failure: ['**Flag service down:** SDKs keep the last ruleset in memory (and on disk, for restarts). Nothing changes until it recovers, but nothing breaks.', '**A brand-new pod starts while the service is down:** it loads the ruleset from a file baked in at deploy time or from a CDN copy, never failing open to random behaviour.']
    },
    {
      from: 'user', to: 'next', label: 'GET /checkout',
      title: 'A Belgian shopper opens checkout',
      caption: 'User usr_ana, logged in, country BE, opens the checkout. The Next.js middleware evaluates new-checkout on the server before rendering, so the page never flickers between designs.',
      text: ['Evaluating in the browser after load would show the old design for a split second, then swap. Server evaluation picks the variant before the first byte.'],
      payloadKind: 'Evaluation context',
      payload: { user_id: 'usr_ana', country: 'BE', plan: 'free', email: 'ana.lopez@gmail.com', app_version: 'web' },
      code: [{ lang: 'ts', title: 'middleware.ts', src: String.raw`
import { flags } from "@/lib/flags";      // server SDK, rules in memory

export async function middleware(req: NextRequest) {
  const user = await sessionUser(req);
  const ctx = { user_id: user?.id ?? anonId(req), country: req.geo?.country ?? "XX",
                email: user?.email, plan: user?.plan };
  const variant = flags.variant("new-checkout", ctx);       // ~microseconds, no I/O
  const res = NextResponse.next();
  res.headers.set("x-flag-new-checkout", variant);          // read by the page
  res.cookies.set("ff_nc", variant, { httpOnly: false, sameSite: "lax" }); // client hydration
  return res;
}
export const config = { matcher: ["/checkout/:path*"] };` }]
    },
    {
      from: 'next', to: 'sdk', label: 'evaluate locally',
      title: 'Evaluate: rules first, then the bucket',
      caption: 'The SDK walks the rules in order. Ana is not staff; she is in Belgium, so the rollout rule applies. Hashing "nc-7f1:usr_ana" gives bucket 3 out of 100, which is below 5: variant on.',
      text: ['{{consistent bucketing}} is the key property. The same user always gets the same bucket, and raising 5% to 20% keeps all current users on and only adds buckets 5–19. Nobody flips back and forth.', 'The per-flag salt makes buckets independent between flags, so the same 5% of users are not the guinea pigs for every experiment.'],
      payloadKind: 'Evaluation',
      payload: { flag: 'new-checkout', version: 42, matched_rule: 'r_be', hash_input: 'nc-7f1:usr_ana', hash: 'murmur3_32 = 2147483903', bucket: 3, threshold: 5, variant: 'on', took_us: 2.1 },
      fields: { bucket: 'hash mod 100. Buckets 0–4 get on (5%).', hash_input: 'salt + user id. Changing the salt reshuffles everyone, which is done only to restart an experiment.' },
      code: [{ lang: 'python', title: 'Local evaluation (Python SDK)', src: String.raw`
import mmh3

def variant(flag: Flag, ctx: dict) -> str:
    for rule in flag.rules:
        if not matches(rule.when, ctx):
            continue
        if rule.serve:
            return rule.serve
        unit = str(ctx.get(rule.bucket_by, ""))
        bucket = mmh3.hash(f"{flag.salt}:{unit}", signed=False) % 100
        acc = 0
        for name, pct in rule.rollout.items():      # {"on": 5, "off": 95}
            acc += pct
            if bucket < acc:
                return name
    return flag.default` }]
    },
    {
      from: 'next', to: 'user', label: 'new checkout page', reply: true,
      title: 'The new design is rendered',
      caption: 'The server renders the new checkout and sends the variant to the client in a cookie, so client components agree with the server and later calls to the API carry the same decision.',
      payloadKind: 'Rendered page',
      payload: { variant: 'on', component: 'CheckoutV2', set_cookie: 'ff_nc=on', html_bytes: 41200 },
      text: ['Client code reads the cookie instead of evaluating again, so a client SDK with slightly older rules can never disagree with the server render.']
    },
    {
      from: 'api', to: 'sdk', label: 'same flag, backend',
      title: 'The backend uses the same flag',
      caption: 'The new checkout calls a new endpoint behaviour (address autocomplete, one-page payment). The Checkout API evaluates new-checkout with the same user id and gets the same answer: on.',
      text: ['Because evaluation is deterministic (same rules, same user id, same hash), the frontend and every backend service agree without talking to each other.'],
      payloadKind: 'FastAPI',
      payloadLang: 'text',
      payload: String.raw`
GET /v1/checkout/summary   (user usr_ana)
flags.variant("new-checkout", {user_id: "usr_ana", country: "BE"}) -> "on"
-> uses PricingV2 and returns address suggestions`,
      code: [{ lang: 'python', title: 'FastAPI dependency', src: String.raw`
def flag(key: str):
    def dep(user: User = Depends(current_user), req: Request = None) -> str:
        return flags.variant(key, {"user_id": user.id, "country": user.country,
                                   "plan": user.plan, "email": user.email})
    return dep

@router.get("/v1/checkout/summary")
async def summary(nc: str = Depends(flag("new-checkout")), user=Depends(current_user)):
    return await (summary_v2(user) if nc == "on" else summary_v1(user))` }]
    },
    {
      from: 'sdk', to: 'analytics', label: 'exposure events', async: true,
      title: 'Record who saw which variant',
      caption: 'The SDK batches exposure events (user, flag, variant, rule) and sends them every few seconds. Analysts join them with orders to compare conversion between on and off.',
      text: ['Exposures are deduplicated per user per flag per hour in the SDK; logging every evaluation would mean millions of identical events per second.'],
      payloadKind: 'Exposure event',
      payload: { type: 'flag_exposure', flag: 'new-checkout', version: 42, variant: 'on', rule: 'r_be', user_id: 'usr_ana', ts: '2026-11-25T11:41:44Z', service: 'web-next' }
    },
    {
      from: 'mon', to: 'flags', label: 'kill switch: off',
      title: 'Guardrail trips the kill switch',
      caption: 'At 20%, the error rate of checkout for variant on reaches 3.1% against 0.4% for off. The guardrail monitor flips new-checkout\'s kill switch: everyone gets off within a second, no deploy.',
      text: ['A {{kill switch}} is the main safety benefit of flags: rolling back becomes a click (or an automatic rule), not a revert and a 15-minute deploy.', 'Comparing error rates per variant, not overall, is what makes a 20% rollout problem visible: overall checkout errors only rose from 0.4% to 0.9%.'],
      payloadKind: 'Guardrail decision',
      payload: { flag: 'new-checkout', metric: 'checkout_5xx_ratio', window: '5m', by_variant: { on: 0.031, off: 0.004 }, rule: 'on > 3 × off and on > 1% for 2 windows', action: { kill: true, version: 46 }, notified: ['#checkout-team', 'usr_pm_lea'] },
      failure: ['**False alarm:** the team investigates and re-enables with a click. The audit log shows the automatic kill and who re-enabled it.']
    },
    {
      from: 'flags', to: 'next', label: 'SSE: killed → off',
      title: 'Everyone is back on the old checkout',
      caption: 'The kill is streamed like any change. Next request, Ana gets the old checkout. Later, once the bug is fixed, the rollout resumes at 5% and the same users are back in the on group.',
      payloadKind: 'SSE message',
      payloadLang: 'text',
      payload: String.raw`
event: patch
id: 9187
data: {"key":"new-checkout","version":46,"killed":true,"default":"off"}`,
      text: ['When a flag reaches 100% and stays stable, the old code path and the flag are removed. Stale flags are tracked by age, so the code does not fill up with dead branches.']
    }
  ],
  api: [
    { verb: 'PATCH', path: '/v1/environments/{env}/flags/{key}', desc: 'Change rules; needs `If-Match` and a reason.' },
    { verb: 'GET', path: '/v1/sdk/ruleset?env=prod', desc: 'Full ruleset with version, for SDK start-up.' },
    { verb: 'GET', path: '/v1/sdk/stream?env=prod', desc: 'Server-Sent Events of ruleset patches.' },
    { verb: 'POST', path: '/v1/environments/{env}/flags/{key}/kill', desc: 'Kill switch: serve default to everyone.' }
  ],
  schema: String.raw`
CREATE TABLE flags (
  env TEXT, key TEXT, rules JSONB NOT NULL, default_variant TEXT NOT NULL,
  salt TEXT NOT NULL, killed BOOLEAN DEFAULT false, version INT NOT NULL,
  owner TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
  PRIMARY KEY (env, key)
);
CREATE TABLE flag_audit (
  id BIGSERIAL PRIMARY KEY, env TEXT, key TEXT, version INT,
  actor TEXT, reason TEXT, diff JSONB, at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE environments (env TEXT PRIMARY KEY, ruleset_version BIGINT NOT NULL);`,
  decisions: [
    { q: 'Where are flags evaluated?', options: [
      { verdict: 'bad', name: 'Call the flag service on every check', why: 'A network hop per flag per request, and an outage breaks everything.' },
      { verdict: 'great', name: 'SDK with rules in memory, streamed updates', why: 'Microsecond evaluations and keeps working when the service is down.' }
    ] },
    { q: 'How are percentages assigned?', options: [
      { verdict: 'bad', name: 'random() < 0.05 on each request', why: 'Users flip between designs on every page.' },
      { verdict: 'great', name: 'hash(salt + user id) mod 100', why: 'Stable per user, consistent across services, and rollouts only add users.' }
    ] }
  ],
  refs: [
    { label: 'Martin Fowler: Feature Toggles', url: 'https://martinfowler.com/articles/feature-toggles.html' },
    { label: 'OpenFeature specification', url: 'https://openfeature.dev/specification/' }
  ]
});
