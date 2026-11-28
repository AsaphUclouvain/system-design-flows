flow({
  id: 'oauth-login',
  title: 'Sign in with Google (OAuth 2.0 + OIDC with PKCE)',
  category: 'Identity & security',
  tags: ['OAuth 2.0', 'OIDC', 'PKCE', 'JWT', 'Sessions'],
  summary: 'Click "Continue with Google", come back signed in. Every redirect, parameter and token in the authorization code flow with PKCE, how the backend verifies the ID token, and how your own session cookie is created.',
  requirements: {
    functional: [
      'Users sign in with their Google account; first sign-in creates a local account.',
      'The app gets the user\'s verified email, name and a stable user id.',
      'Users stay signed in for weeks without re-entering anything, and can sign out everywhere.'
    ],
    nonFunctional: [
      'The app never sees the Google password.',
      'Stolen authorization codes are useless ({{pkce}}); forged callbacks are rejected (`state`); replayed ID tokens are rejected (`nonce`).',
      'Session tokens cannot be read by JavaScript ({{httponly cookie}}).'
    ]
  },
  grid: { cols: 4, rows: 2 },
  nodes: [
    { id: 'br', label: 'Browser', sub: 'user', kind: 'client', icon: 'user', x: 0, y: 0, desc: 'The user agent. It follows redirects between your site and Google; it is where state and PKCE values must be protected.' },
    { id: 'next', label: 'Next.js server', sub: 'route handlers', kind: 'service', x: 1, y: 0, desc: 'Your web server (Next.js route handlers or Auth.js). It is the OAuth **client**: it starts the flow, receives the callback and exchanges the code. Being a server, it can keep a client secret.' },
    { id: 'google', label: 'Google', sub: 'authorization server', kind: 'external', x: 2, y: 0, icon: 'lock', desc: 'The identity provider. Authenticates the user, asks for consent, issues an authorization code, then tokens. Its OIDC discovery document lists every endpoint.' },
    { id: 'jwks', label: 'Google JWKS', sub: 'public keys', kind: 'external', x: 3, y: 0, icon: 'lock', desc: 'The URL publishing Google\'s current public signing keys. Your backend fetches and caches them to verify ID token signatures locally.' },
    { id: 'api', label: 'Auth API', sub: 'FastAPI', kind: 'service', x: 2, y: 1, desc: 'Your backend. Verifies the ID token, finds or creates the user, and creates your own session. Google\'s tokens are used once, here, and then your session takes over.' },
    { id: 'db', label: 'Users DB', sub: 'PostgreSQL', kind: 'db', x: 3, y: 1, desc: 'Users and their linked identities (`provider`, `provider_subject`), plus refresh-token families for your own sessions.' },
    { id: 'redis', label: 'Redis', sub: 'sessions', kind: 'cache', x: 1, y: 1, desc: 'Fast session lookup and revocation. Deleting a key signs a device out instantly.' }
  ],
  steps: [
    {
      from: 'br', to: 'next', label: 'GET /auth/google',
      title: 'The user clicks "Continue with Google"',
      caption: 'Your server generates three random values: state (anti-CSRF), nonce (anti-replay) and a PKCE code_verifier. It stores them in a short-lived, encrypted cookie.',
      text: [
        '`state` ties the callback to this browser so an attacker cannot make the victim log in to the attacker\'s account ({{csrf}}).',
        '`code_verifier` is a random 43–128 character secret. Its SHA-256 hash, the `code_challenge`, goes to Google now; the verifier itself is revealed only at the token exchange. Someone who intercepts the code cannot use it without the verifier. That is {{pkce}}.',
        '`nonce` is echoed inside the ID token so you can check the token was minted for this login.'
      ],
      payloadKind: 'Server-side values',
      payload: { state: 'h7Qp2xVb9LkC', nonce: 'n-4fZ8wq1Tr0', code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', cookie: 'oauth_tx=<encrypted state+nonce+verifier>; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/auth' },
      fields: { code_challenge: 'BASE64URL(SHA256(code_verifier)). This example pair is the one used in RFC 7636.', cookie: 'SameSite=Lax still sends the cookie on the top-level redirect back from Google, which is what we need.' },
      code: [{ lang: 'ts', title: 'Next.js route handler: start the flow', src: String.raw`
// app/auth/google/route.ts
import { NextResponse } from 'next/server';
import { randomBytes, createHash } from 'node:crypto';

const b64url = (b: Buffer) => b.toString('base64url');

export async function GET() {
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: 'https://app.example.com/auth/google/callback',
    response_type: 'code',
    scope: 'openid email profile',
    state, nonce,
    code_challenge: challenge, code_challenge_method: 'S256',
  }).toString();

  const res = NextResponse.redirect(url);
  res.cookies.set('oauth_tx', await seal({ state, nonce, verifier }), {
    httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600, path: '/auth',
  });
  return res;
}` }]
    },
    {
      from: 'next', to: 'br', label: '302 to Google', reply: true,
      title: 'Redirect the browser to Google\'s authorization endpoint',
      caption: 'A 302 sends the browser to Google with the client id, redirect URI, scopes, state, nonce and code challenge in the query string.',
      text: ['The `redirect_uri` must exactly match one registered in the Google Cloud console. Otherwise Google refuses, which stops attackers from sending codes to their own site.', '`scope=openid email profile` makes this an OpenID Connect ({{oidc}}) request: you will get an ID token describing the user.'],
      payloadKind: 'HTTP response',
      payloadLang: 'http',
      payload: String.raw`
HTTP/1.1 302 Found
Location: https://accounts.google.com/o/oauth2/v2/auth
  ?client_id=1234-abc.apps.googleusercontent.com
  &redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fgoogle%2Fcallback
  &response_type=code
  &scope=openid%20email%20profile
  &state=h7Qp2xVb9LkC
  &nonce=n-4fZ8wq1Tr0
  &code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
  &code_challenge_method=S256
Set-Cookie: oauth_tx=...; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/auth`
    },
    {
      from: 'br', to: 'google', label: 'sign in + consent',
      title: 'The user signs in at Google and consents',
      caption: 'Google shows its own sign-in page and a consent screen. Your app is not involved; it never sees the password or the second factor.',
      text: ['This is the whole point of OAuth: delegated authentication. Google applies its own protections (2-step verification, suspicious-login checks). On first use the consent screen lists what your app asked for.'],
      payloadKind: 'What Google knows now',
      payload: { client_id: '1234-abc.apps.googleusercontent.com', user: 'sam@gmail.com', granted_scopes: ['openid', 'email', 'profile'], code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', nonce: 'n-4fZ8wq1Tr0' }
    },
    {
      from: 'google', to: 'br', label: '302 ?code&state', reply: true,
      title: 'Google redirects back with a one-time code',
      caption: 'Google sends the browser to your redirect URI with a short-lived authorization code and your state value.',
      text: ['The code is single-use and expires within minutes. It travels through the browser (and its history), which is why it is not yet a token: it still needs the client credentials and the PKCE verifier to be exchanged.'],
      payloadKind: 'Redirect',
      payloadLang: 'http',
      payload: String.raw`
HTTP/1.1 302 Found
Location: https://app.example.com/auth/google/callback
  ?state=h7Qp2xVb9LkC
  &code=4/0AeanS0Zt...redacted
  &scope=email%20profile%20openid`
    },
    {
      from: 'br', to: 'next', label: 'GET /callback',
      title: 'Your callback checks state',
      caption: 'The callback reads the encrypted cookie and compares its state with the state in the URL. A mismatch means a forged or stale callback: stop.',
      text: ['After the check, the cookie is deleted so the same transaction cannot be replayed. The server now holds the code and the verifier.'],
      payloadKind: 'Callback request',
      payload: { query: { state: 'h7Qp2xVb9LkC', code: '4/0AeanS0Zt...' }, cookie_oauth_tx: { state: 'h7Qp2xVb9LkC', nonce: 'n-4fZ8wq1Tr0', code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk' }, state_matches: true },
      failure: ['**state missing or different:** respond 400 and restart the login. Never "just continue".']
    },
    {
      from: 'next', to: 'google', label: 'POST /token',
      title: 'Exchange the code for tokens (back channel)',
      caption: 'Server to server, your backend posts the code, the code_verifier, its client id and secret. Google recomputes the challenge and compares.',
      text: ['This request never touches the browser. Google checks: the code is valid and unused, the redirect URI matches, the client secret is right, and SHA256(code_verifier) equals the stored challenge.'],
      payloadKind: 'HTTP request (form-encoded)',
      payloadLang: 'http',
      payload: String.raw`
POST /token HTTP/1.1
Host: oauth2.googleapis.com
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=4/0AeanS0Zt...
&redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fgoogle%2Fcallback
&client_id=1234-abc.apps.googleusercontent.com
&client_secret=GOCSPX-...
&code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk`,
      code: [{ lang: 'ts', title: 'Token exchange in the callback', src: String.raw`
const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code, redirect_uri: REDIRECT_URI,
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    code_verifier: tx.verifier,
  }),
});
if (!tokenRes.ok) throw new Error('token exchange failed ' + tokenRes.status);
const { id_token } = await tokenRes.json();
// hand the ID token to the backend, which verifies it and opens our own session
const session = await fetch(API + '/v1/sessions/google', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id_token, nonce: tx.nonce }),
});` }]
    },
    {
      from: 'google', to: 'next', label: 'tokens', reply: true,
      title: 'Google returns an ID token (and an access token)',
      caption: 'The ID token is a signed JWT describing the user. The access token is for calling Google APIs, which a pure sign-in does not need.',
      text: ['For sign-in, only the ID token matters. Its payload (the middle part of the {{jwt}}) contains `sub`, the stable Google user id. **Use `sub`, not email, as the identity key**: emails can change.'],
      payloadKind: 'Token response + decoded ID token',
      payload: {
        access_token: 'ya29.a0Af...', expires_in: 3599, token_type: 'Bearer', scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
        id_token: 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjFiZDY4...',
        id_token_decoded: {
          header: { alg: 'RS256', kid: '1bd685f5...', typ: 'JWT' },
          payload: { iss: 'https://accounts.google.com', aud: '1234-abc.apps.googleusercontent.com', sub: '110248495921238986420', email: 'sam@gmail.com', email_verified: true, name: 'Sam Lee', picture: 'https://lh3.googleusercontent.com/a/...', nonce: 'n-4fZ8wq1Tr0', iat: 1764064000, exp: 1764067600 }
        }
      },
      fields: { iss: 'Who issued it. Must be Google.', aud: 'Who it is for. Must be your client id, or someone else\'s token could log in to your app.', sub: 'Stable, unique Google account id. Your foreign key.', email_verified: 'Only trust the email if this is true.', nonce: 'Must equal the nonce you generated in step 1.', exp: 'Unix seconds; reject expired tokens.', kid: 'Which of Google\'s public keys signed it.' }
    },
    {
      from: 'api', to: 'jwks', label: 'GET certs (cached)',
      title: 'Verify the signature with Google\'s public keys',
      caption: 'The backend picks the key whose kid matches the token header from Google\'s cached JWKS and verifies the RS256 signature locally.',
      text: ['Keys are cached according to the HTTP cache headers and refreshed when an unknown `kid` appears (Google rotates keys). No network call per login once cached.', 'Then the claims: `iss`, `aud`, `exp` (with a small clock-skew allowance), `nonce`, and `email_verified`.'],
      payloadKind: 'JWKS (abridged)',
      payload: { keys: [{ kid: '1bd685f5...', kty: 'RSA', alg: 'RS256', use: 'sig', n: '0vx7agoebGcQSuu...', e: 'AQAB' }, { kid: 'a3f8...', kty: 'RSA', alg: 'RS256', use: 'sig', n: 'r3L...', e: 'AQAB' }] },
      code: [{ lang: 'python', title: 'Verify a Google ID token (google-auth library)', src: String.raw`
from google.oauth2 import id_token
from google.auth.transport import requests as g_requests

_req = g_requests.Request()   # fetches and caches Google's certs

def verify_google(token: str, expected_nonce: str) -> dict:
    claims = id_token.verify_oauth2_token(token, _req, audience=GOOGLE_CLIENT_ID,
                                          clock_skew_in_seconds=10)
    if claims["iss"] not in ("https://accounts.google.com", "accounts.google.com"):
        raise ValueError("wrong issuer")
    if claims.get("nonce") != expected_nonce:
        raise ValueError("nonce mismatch")
    if not claims.get("email_verified"):
        raise ValueError("email not verified")
    return claims` }]
    },
    {
      from: 'api', to: 'db', label: 'upsert user',
      title: 'Find or create the local user',
      caption: 'Look up the identity by (provider, sub). First time: create the user and link the identity. Next times: update name and picture.',
      text: ['Be careful with automatic account linking by email ("a user with sam@gmail.com already exists, so this Google login is them"). Only link when the provider says the email is verified, and prefer asking the user to confirm by signing in to the existing account first.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
INSERT INTO identities (provider, subject, user_id, email)
VALUES ('google', '110248495921238986420', 'usr_0f3a', 'sam@gmail.com')
ON CONFLICT (provider, subject) DO UPDATE SET email = EXCLUDED.email
RETURNING user_id;

INSERT INTO users (id, email, name, avatar_url)
VALUES ('usr_0f3a', 'sam@gmail.com', 'Sam Lee', 'https://lh3.googleusercontent.com/a/...')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url;`
    },
    {
      from: 'api', to: 'redis', label: 'create session',
      title: 'Create your own session',
      caption: 'Google\'s tokens are done. Your backend creates its own session: a random opaque id stored in Redis, or a short JWT plus a rotating refresh token.',
      text: [
        'Two common designs. **Opaque session id**: a random string in a cookie, the server looks it up in [[redis]] on each request. Simple, instantly revocable. **Short JWT + {{refresh token}}**: the JWT is verified without a lookup and expires in minutes; the refresh token (stored server-side, rotated on every use) gets new JWTs. Scales across services, revocation is delayed by the JWT lifetime.',
        'Either way the browser holds it in a Secure, HttpOnly, SameSite cookie, never in localStorage where any injected script ({{xss}}) could read it.'
      ],
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
HSET sess:Yx3k9Qw2...  user_id usr_0f3a  created 1764064005  ua "Firefox/Linux"  ip 198.51.100.7
EXPIRE sess:Yx3k9Qw2... 1209600          # 14 days, sliding
SADD user_sessions:usr_0f3a sess:Yx3k9Qw2...   # for "sign out everywhere"`
    },
    {
      from: 'next', to: 'br', label: 'Set-Cookie + 302 /', reply: true,
      title: 'The user lands signed in',
      caption: 'The response sets the session cookie and redirects to the page the user started from. Every later request carries the cookie automatically.',
      text: ['Redirect to a **relative** path you stored at the start ("returnTo"), never to an arbitrary URL from the query string, or you have built an open redirect.'],
      payloadKind: 'HTTP response',
      payloadLang: 'http',
      payload: String.raw`
HTTP/1.1 302 Found
Location: /dashboard
Set-Cookie: sid=Yx3k9Qw2...; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1209600
Set-Cookie: oauth_tx=; Max-Age=0; Path=/auth`
    },
    {
      from: 'br', to: 'api', label: 'GET /me (cookie)',
      title: 'Every later request: one fast lookup',
      caption: 'A FastAPI dependency reads the cookie, looks it up in Redis, and loads the user. Sign-out deletes the key; "sign out everywhere" deletes them all.',
      text: ['This lookup is sub-millisecond in Redis. If Redis is lost, users are signed out (annoying, not dangerous). Some teams also persist sessions in PostgreSQL so they survive a cache loss.'],
      payloadKind: 'Request',
      payload: { method: 'GET', path: '/v1/me', cookie: 'sid=Yx3k9Qw2...', resolved_user: { id: 'usr_0f3a', email: 'sam@gmail.com', name: 'Sam Lee' } },
      code: [{ lang: 'python', title: 'Session dependency', src: String.raw`
async def current_user(sid: str | None = Cookie(default=None), r: Redis = Depends(get_redis)):
    if not sid:
        raise HTTPException(401)
    sess = await r.hgetall(f"sess:{sid}")
    if not sess:
        raise HTTPException(401)
    await r.expire(f"sess:{sid}", 1_209_600)      # sliding expiry
    return sess["user_id"]

@router.post("/v1/sessions/logout-all")
async def logout_all(user_id=Depends(current_user), r=Depends(get_redis)):
    keys = await r.smembers(f"user_sessions:{user_id}")
    if keys:
        await r.delete(*keys, f"user_sessions:{user_id}")` }]
    }
  ],
  api: [
    { verb: 'GET', path: '/auth/google', desc: 'Starts the flow (state, nonce, PKCE), redirects to Google.' },
    { verb: 'GET', path: '/auth/google/callback', desc: 'Checks state, exchanges code, opens the session, redirects.' },
    { verb: 'POST', path: '/v1/sessions/google', desc: 'Backend: verifies the ID token and creates a session.' },
    { verb: 'POST', path: '/v1/sessions/logout', desc: 'Deletes the current session.' },
    { verb: 'POST', path: '/v1/sessions/logout-all', desc: 'Deletes every session of the user.' }
  ],
  schema: String.raw`
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE identities (
  provider TEXT NOT NULL,                 -- 'google', 'github', 'password'
  subject  TEXT NOT NULL,                 -- the provider's stable user id (sub)
  user_id  TEXT NOT NULL REFERENCES users(id),
  email    TEXT,
  PRIMARY KEY (provider, subject)
);`,
  decisions: [
    { q: 'Where should the session token live in the browser?', options: [
      { verdict: 'bad', name: 'localStorage', why: 'Readable by any script on the page; one XSS bug leaks every session.' },
      { verdict: 'great', name: 'Secure, HttpOnly, SameSite cookie', why: 'Invisible to JavaScript, sent automatically, protected against most CSRF by SameSite. Add a CSRF token for state-changing requests if you use SameSite=None.' }
    ] },
    { q: 'Which OAuth flow for a web app?', options: [
      { verdict: 'bad', name: 'Implicit flow (tokens in the URL fragment)', why: 'Deprecated by the OAuth 2.0 Security Best Current Practice: tokens leak through history and referrers.' },
      { verdict: 'great', name: 'Authorization code with PKCE', why: 'Recommended for all clients, public and confidential. Tokens never pass through the browser URL.' }
    ] }
  ],
  refs: [
    { label: 'RFC 7636: PKCE', url: 'https://www.rfc-editor.org/rfc/rfc7636' },
    { label: 'RFC 9700: OAuth 2.0 Security Best Current Practice', url: 'https://www.rfc-editor.org/rfc/rfc9700' },
    { label: 'Google: OpenID Connect', url: 'https://developers.google.com/identity/openid-connect/openid-connect', note: 'Endpoints, ID token claims, validation.' },
    { label: 'OpenID Connect Core 1.0', url: 'https://openid.net/specs/openid-connect-core-1_0.html' },
    { label: 'OWASP Session Management Cheat Sheet', url: 'https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html' }
  ]
});

flow({
  id: 'jwt-refresh',
  title: 'Access tokens, refresh rotation and logout',
  category: 'Identity & security',
  tags: ['JWT', 'Refresh tokens', 'Rotation', 'Reuse detection'],
  summary: 'Short-lived JWTs let every service authenticate requests without a database call. Follow an API call with a valid token, its expiry, a silent refresh with rotation, an attacker replaying a stolen refresh token, and how reuse detection signs everyone out of that family.',
  requirements: {
    functional: ['Services verify who is calling without calling the auth service on every request.', 'Users stay signed in for 30 days of activity.', 'Logout and "sign out everywhere" take effect within minutes at most.'],
    nonFunctional: ['A stolen access token is useful for minutes, not days.', 'A stolen refresh token is detected the first time both the thief and the user use it.', 'Signing keys can be rotated without logging everyone out.']
  },
  grid: { cols: 4, rows: 2 },
  nodes: [
    { id: 'app', label: 'Next.js app', sub: 'browser', kind: 'client', x: 0, y: 0, desc: 'Holds the access token in memory and the refresh token in an HttpOnly cookie scoped to the refresh endpoint.' },
    { id: 'api', label: 'Orders API', sub: 'FastAPI', kind: 'service', x: 1, y: 0, desc: 'A resource server. It verifies JWT signatures with the auth service\'s public keys and reads the user id and scopes from the claims.' },
    { id: 'jwks', label: 'JWKS endpoint', sub: '/.well-known/jwks.json', kind: 'edge', x: 2, y: 0, icon: 'lock', desc: 'Publishes the auth service\'s public keys. Resource servers cache it.' },
    { id: 'auth', label: 'Auth service', sub: 'FastAPI', kind: 'service', x: 1, y: 1, icon: 'lock', desc: 'Issues access and refresh tokens, rotates refresh tokens, detects reuse.' },
    { id: 'db', label: 'Token store', sub: 'PostgreSQL', kind: 'db', x: 2, y: 1, desc: 'Refresh tokens stored as hashes, grouped in families (one family per sign-in).' },
    { id: 'bad', label: 'Attacker', sub: 'stolen token', kind: 'external', icon: 'user', x: 0, y: 1, desc: 'Someone who got a copy of a refresh token, for example from malware or a leaked log.' }
  ],
  steps: [
    {
      from: 'app', to: 'api', label: 'GET /orders + Bearer',
      title: 'A normal API call with an access token',
      caption: 'The access token is a JWT valid for 10 minutes. The API verifies it locally: no call to the auth service.',
      text: ['A {{jwt}} has three base64url parts: header, payload, signature. Anyone can decode the first two; only the auth service, with its private key, can produce a valid signature. So the API trusts the claims after verifying the signature with the public key.'],
      payloadKind: 'Request + decoded token',
      payload: { method: 'GET', path: '/v1/orders', authorization: 'Bearer eyJhbGciOiJFUzI1NiIsImtpZCI6IjIwMjYtMTEifQ.eyJzdWIi...', decoded: { header: { alg: 'ES256', kid: '2026-11', typ: 'at+jwt' }, payload: { iss: 'https://auth.example.com', aud: 'api.example.com', sub: 'usr_0f3a', scope: 'orders:read orders:write', iat: 1764064000, exp: 1764064600, jti: 'at_9c1e', sid: 'fam_51' } } },
      fields: { exp: 'iat + 600 s. After that the token is rejected and the app must refresh.', kid: 'Which key signed it, so keys can rotate.', sid: 'The session family. Lets the API reject tokens of a signed-out session if you keep a small deny list.', typ: '`at+jwt` marks an access token (RFC 9068) so an ID token cannot be used in its place.', scope: 'What this token may do. The API checks it per endpoint.' }
    },
    {
      from: 'api', to: 'jwks', label: 'keys (cached)',
      title: 'Verify with the cached public key',
      caption: 'The API keeps the JWKS in memory, refreshes it every few hours, and refetches immediately when it sees an unknown kid.',
      text: ['Key rotation: publish the new key in the JWKS a while before signing with it, keep the old key published until all tokens it signed have expired. No one is logged out.'],
      payloadKind: 'JWKS',
      payload: { keys: [{ kid: '2026-11', kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0', use: 'sig', alg: 'ES256' }, { kid: '2026-10', kty: 'EC', crv: 'P-256', x: '...', y: '...', use: 'sig', alg: 'ES256' }] },
      code: [{ lang: 'python', title: 'Resource-server verification in FastAPI', src: String.raw`
jwks = PyJWKClient("https://auth.example.com/.well-known/jwks.json", cache_keys=True, lifespan=6 * 3600)

def require(scope: str):
    def dep(authorization: str = Header()):
        token = authorization.removeprefix("Bearer ")
        key = jwks.get_signing_key_from_jwt(token).key
        try:
            claims = jwt.decode(token, key, algorithms=["ES256"],   # never accept "none" or HS256 here
                                audience="api.example.com", issuer="https://auth.example.com",
                                leeway=10)
        except jwt.ExpiredSignatureError:
            raise HTTPException(401, headers={"WWW-Authenticate": 'Bearer error="invalid_token"'})
        if scope not in claims["scope"].split():
            raise HTTPException(403)
        return claims
    return dep

@router.get("/v1/orders")
async def orders(claims=Depends(require("orders:read"))): ...` }]
    },
    {
      from: 'api', to: 'app', label: '401 token expired', reply: true,
      title: 'Ten minutes later: the token has expired',
      caption: 'The API answers 401 with WWW-Authenticate: Bearer error="invalid_token". The app knows to refresh, then retry the original request once.',
      text: ['Several parallel requests may all get 401 at once. The app must make **one** refresh call and let the others wait for it, otherwise it triggers reuse detection on itself (see step 6).'],
      payloadKind: 'HTTP response',
      payloadLang: 'http',
      payload: String.raw`
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token", error_description="expired"`,
      code: [{ lang: 'ts', title: 'Single-flight refresh in the client', src: String.raw`
let accessToken: string | null = null;
let refreshing: Promise<string> | null = null;

async function refresh(): Promise<string> {
  refreshing ??= fetch('/auth/refresh', { method: 'POST', credentials: 'include' })
    .then(r => { if (!r.ok) throw new Error('signed out'); return r.json(); })
    .then(j => (accessToken = j.access_token))
    .finally(() => { refreshing = null; });
  return refreshing;           // concurrent callers share one refresh
}

export async function api(path: string, init: RequestInit = {}) {
  const call = (t: string | null) => fetch(path, { ...init, headers: { ...init.headers, Authorization: 'Bearer ' + t } });
  let res = await call(accessToken);
  if (res.status === 401) res = await call(await refresh());
  return res;
}` }]
    },
    {
      from: 'app', to: 'auth', label: 'POST /auth/refresh (cookie)',
      title: 'Refresh: present the refresh token',
      caption: 'The browser sends the refresh cookie, which is HttpOnly and scoped to /auth/refresh only, so it is not attached to every API call.',
      text: ['The {{refresh token}} is an opaque random string, not a JWT, because the server must look it up anyway to rotate and revoke it.'],
      payloadKind: 'HTTP request',
      payloadLang: 'http',
      payload: String.raw`
POST /auth/refresh HTTP/1.1
Host: auth.example.com
Cookie: rt=rt_8Hq2Z...K1   ; HttpOnly; Secure; SameSite=Strict; Path=/auth/refresh`
    },
    {
      from: 'auth', to: 'db', label: 'rotate',
      title: 'Rotate: old token used, new token issued',
      caption: 'The server hashes the token, finds it unused in family fam_51, marks it used, and issues a new refresh token in the same family plus a new access token.',
      text: ['**Rotation** means every refresh token works once. The server stores only a SHA-256 hash, so a database leak does not leak usable tokens.', 'Sliding lifetime: each rotation can extend the family up to an absolute maximum (say 30 days of inactivity, 90 days total).'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
UPDATE refresh_tokens SET used_at = now()
WHERE token_hash = encode(sha256('rt_8Hq2Z...K1'), 'hex')
  AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
RETURNING family_id, user_id;          -- 1 row: good. 0 rows: check for reuse (step 7)

INSERT INTO refresh_tokens (token_hash, family_id, user_id, expires_at)
VALUES (encode(sha256('rt_N3w...Q9'), 'hex'), 'fam_51', 'usr_0f3a', now() + interval '30 days');`,
      code: [{ lang: 'python', title: 'Refresh endpoint with rotation and reuse detection', src: String.raw`
@router.post("/auth/refresh")
async def refresh(rt: str | None = Cookie(default=None), db=Depends(get_db)):
    if not rt:
        raise HTTPException(401)
    h = sha256_hex(rt)
    async with db.transaction():
        row = await db.fetchrow("""UPDATE refresh_tokens SET used_at = now()
            WHERE token_hash=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
            RETURNING family_id, user_id""", h)
        if row is None:
            old = await db.fetchrow("SELECT family_id, used_at FROM refresh_tokens WHERE token_hash=$1", h)
            if old and old["used_at"]:                    # reuse of a rotated token
                await db.execute("UPDATE refresh_tokens SET revoked_at=now() WHERE family_id=$1",
                                 old["family_id"])
                await deny_session(old["family_id"])      # optional: reject its access tokens too
            raise HTTPException(401)
        new_rt = "rt_" + secrets.token_urlsafe(32)
        await db.execute("INSERT INTO refresh_tokens (token_hash, family_id, user_id, expires_at) "
                         "VALUES ($1,$2,$3, now() + interval '30 days')",
                         sha256_hex(new_rt), row["family_id"], row["user_id"])
    resp = JSONResponse({"access_token": mint_access(row["user_id"], row["family_id"]), "expires_in": 600})
    resp.set_cookie("rt", new_rt, httponly=True, secure=True, samesite="strict",
                    path="/auth/refresh", max_age=30 * 86400)
    return resp` }]
    },
    {
      from: 'auth', to: 'app', label: 'new tokens', reply: true,
      title: 'The app gets a fresh pair and retries',
      caption: 'A new access token in the JSON body, a new refresh token in the cookie. The original GET /orders is retried and succeeds.',
      payloadKind: 'HTTP response',
      payload: { status: 200, headers: { 'set-cookie': 'rt=rt_N3w...Q9; HttpOnly; Secure; SameSite=Strict; Path=/auth/refresh; Max-Age=2592000' }, body: { access_token: 'eyJhbGciOiJFUzI1NiIsImtpZCI6IjIwMjYtMTEifQ.eyJzdWIi...', token_type: 'Bearer', expires_in: 600 } },
      text: ['The access token stays in JavaScript memory only. On a full page reload it is gone, and the app simply calls refresh once to get a new one.']
    },
    {
      from: 'bad', to: 'auth', label: 'replays old rt_8Hq2Z',
      title: 'An attacker replays the stolen, already-rotated token',
      caption: 'The attacker copied rt_8Hq2Z before the user rotated it. The server finds it marked used: this is reuse, so it revokes the entire family.',
      text: [
        'The server cannot tell who is the thief and who is the user; it only knows the same token was used twice. The safe reaction is to revoke **every** token in `fam_51`. The attacker gets nothing; the real user is signed out on their next refresh and signs in again.',
        'If the attacker had refreshed **first**, the user\'s later refresh with the same old token triggers exactly the same detection. Either order ends the stolen session.'
      ],
      payloadKind: 'Detection',
      payload: { token: 'rt_8Hq2Z...K1', found: true, used_at: '2026-11-25T10:10:02Z', verdict: 'reuse_detected', action: 'revoke family fam_51 (2 tokens), deny-list sid fam_51 for 10 min, alert security log', response: 401 },
      failure: ['**Legitimate false positive:** two browser tabs refreshing at the same moment with the same token. Prevent it with single-flight refresh in the client (step 3), or allow a few seconds of grace where the previous token returns the same new token.']
    },
    {
      from: 'app', to: 'auth', label: 'POST /auth/logout',
      title: 'Logout: revoke the family, let the access token die',
      caption: 'Logout revokes the refresh family and clears the cookie. The current access token stays valid until it expires, at most 10 minutes, unless the API checks a small deny list.',
      text: ['This is the honest trade-off of JWTs: stateless verification means instant revocation needs state. Options: accept up to 10 minutes, or keep a tiny Redis set of revoked session ids (`sid`) for 10 minutes that APIs check. The set only holds sessions revoked in the last token lifetime, so it stays small.'],
      payloadKind: 'SQL + Redis',
      payloadLang: 'sql',
      payload: String.raw`
UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = 'fam_51';
-- optional instant revocation for access tokens:
-- SET denied_sid:fam_51 1 EX 600`
    }
  ],
  schema: String.raw`
CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,           -- sha256 of the opaque token
  family_id  TEXT NOT NULL,              -- one per sign-in
  user_id    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX ON refresh_tokens (family_id);
CREATE INDEX ON refresh_tokens (user_id);`,
  decisions: [
    { q: 'JWT access tokens or opaque session ids?', options: [
      { verdict: 'good', name: 'Opaque session id + server lookup', why: 'Simplest, instantly revocable. Every service needs access to the session store, which is fine for one backend.' },
      { verdict: 'good', name: 'Short JWT + rotating refresh token', why: 'Many services verify without a shared store. Revocation is delayed by the token lifetime unless you add a deny list.' },
      { verdict: 'bad', name: 'Long-lived JWT (days) with no refresh', why: 'A stolen token works for days and cannot be revoked.' }
    ] },
    { q: 'Symmetric (HS256) or asymmetric (RS256/ES256) signatures?', options: [
      { verdict: 'bad', name: 'HS256 shared secret across services', why: 'Every service that can verify can also forge tokens.' },
      { verdict: 'great', name: 'ES256 or RS256 with a JWKS', why: 'Only the auth service holds the private key; others verify with public keys and pick them up automatically on rotation.' }
    ] }
  ],
  refs: [
    { label: 'RFC 9068: JWT profile for OAuth 2.0 access tokens', url: 'https://www.rfc-editor.org/rfc/rfc9068' },
    { label: 'RFC 9700: OAuth 2.0 Security BCP (refresh token rotation)', url: 'https://www.rfc-editor.org/rfc/rfc9700' },
    { label: 'RFC 8725: JWT Best Current Practices', url: 'https://www.rfc-editor.org/rfc/rfc8725', note: 'Algorithm pinning, audience checks.' },
    { label: 'Auth0: Refresh token rotation', url: 'https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation', note: 'Reuse detection explained.' }
  ]
});

flow({
  id: 'rate-limiter',
  title: 'Distributed rate limiter',
  category: 'Identity & security',
  tags: ['Token bucket', 'Redis Lua', '429', 'Sliding window'],
  summary: 'A shared limit across 40 API servers: "each API key may make 100 requests per minute, bursts of 20 allowed". Follow requests through a token bucket stored in Redis and updated atomically by a Lua script, the headers clients see, the 429 path, and what happens when Redis is unavailable.',
  requirements: {
    functional: ['Limit per API key, per user, and per IP for anonymous traffic.', 'Different limits per plan and per endpoint (logins stricter than reads).', 'Clients learn their remaining quota and when to retry.'],
    nonFunctional: ['Adds well under a millisecond or two per request.', 'Accurate across many servers (a shared counter).', 'If the limiter fails, the API keeps working (fail open) except for sensitive endpoints (fail closed).']
  },
  estimates: [
    { label: 'Requests', value: '50,000 / s', note: 'Assumption, across 40 API servers.' },
    { label: 'Redis ops', value: '50,000 / s', note: 'One script call per request. A single Redis node handles this comfortably; shard by key for more.' },
    { label: 'Memory', value: '≈ 100 MB', note: '1M active keys × about 100 bytes (a hash with 2 fields), expiring when idle.' }
  ],
  grid: { cols: 4, rows: 2 },
  nodes: [
    { id: 'cli', label: 'API client', sub: 'key ak_live_42', kind: 'client', x: 0, y: 0, desc: 'A customer\'s script calling your public API with an API key.' },
    { id: 'lb', label: 'Load balancer', sub: 'L7', kind: 'edge', icon: 'lb', x: 1, y: 0, desc: 'Spreads requests over 40 API instances. Each request can land on any instance, which is why a per-instance counter would be wrong.' },
    { id: 'mw', label: 'Rate-limit middleware', sub: 'in each FastAPI instance', kind: 'service', x: 2, y: 0, desc: 'Runs before the route handler: identifies the caller, picks the rule, asks Redis for a decision, sets headers.' },
    { id: 'redis', label: 'Redis', sub: 'buckets + Lua', kind: 'cache', x: 3, y: 0, desc: 'Holds one small hash per caller (tokens, last refill time). A Lua script reads, refills, decides and writes in one atomic step.' },
    { id: 'cfg', label: 'Plan config', sub: 'PostgreSQL → memory', kind: 'db', x: 3, y: 1, desc: 'Limits per plan and endpoint. Loaded into each instance\'s memory and refreshed every minute; never queried per request.' },
    { id: 'h', label: 'Route handler', sub: 'the real work', kind: 'service', x: 2, y: 1, desc: 'Only reached when the request is allowed.' }
  ],
  steps: [
    {
      from: 'cli', to: 'lb', label: 'GET /v1/search',
      title: 'A request arrives',
      caption: 'The client calls the API with its key. The load balancer forwards it to any of 40 instances.',
      payloadKind: 'HTTP request',
      payload: { method: 'GET', path: '/v1/search?q=lamp', headers: { authorization: 'Bearer ak_live_42...', 'x-forwarded-for': '198.51.100.7' } },
      text: ['If the limit were counted in each instance\'s memory, a client could get 40 × 100 requests per minute by being spread across instances. The count has to be shared: hence Redis.'],
      fields: { 'x-forwarded-for': 'The client IP as seen by the load balancer. Only trust the value your own proxy added, or clients can spoof it.' }
    },
    {
      from: 'lb', to: 'mw', label: 'forward',
      title: 'The middleware picks the rule and the key',
      caption: 'Authenticated by API key, plan "pro", endpoint group "search": 100 requests per minute with a burst of 20. The Redis key is rl:{ak_live_42}:search.',
      text: ['The {{token bucket}}: a bucket of capacity 20 refills at 100/60 ≈ 1.67 tokens per second. Each request takes one token. A burst of 20 is allowed instantly, then the client is held to the average rate.', 'The braces in `{ak_live_42}` are a Redis Cluster hash tag: all keys of one caller land on the same shard, which multi-key scripts require.'],
      payloadKind: 'Rule',
      payload: { identity: 'api_key:ak_live_42', plan: 'pro', endpoint_group: 'search', rule: { capacity: 20, refill_per_sec: 1.6667, cost: 1 }, redis_key: 'rl:{ak_live_42}:search' }
    },
    {
      from: 'mw', to: 'redis', label: 'EVALSHA token_bucket',
      title: 'One atomic script: refill, decide, consume',
      caption: 'The Lua script reads the bucket, adds tokens for the time elapsed, takes one if available, writes back, and returns allowed, remaining and retry-after.',
      text: [
        'Why a script? Doing GET, compute, SET from Python leaves a gap where another instance reads the same old value: both allow, the limit is exceeded. Redis runs a Lua script atomically, so no other command interleaves.',
        'Use the Redis server clock (`TIME`) rather than each instance\'s clock, so 40 machines with slightly different clocks agree.'
      ],
      payloadKind: 'Lua script',
      payloadLang: 'redis',
      payload: String.raw`
-- KEYS[1] = rl:{ak_live_42}:search   ARGV = capacity, refill_per_sec, cost
local cap, rate, cost = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local t = redis.call('TIME')
local now = tonumber(t[1]) + tonumber(t[2]) / 1e6
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1]) or cap
local ts = tonumber(b[2]) or now
tokens = math.min(cap, tokens + (now - ts) * rate)       -- refill for elapsed time
local allowed = 0
if tokens >= cost then tokens = tokens - cost; allowed = 1 end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', KEYS[1], math.ceil(cap / rate) * 2)  -- idle buckets disappear
local retry = allowed == 1 and 0 or (cost - tokens) / rate
return { allowed, math.floor(tokens), tostring(retry) }`,
      code: [{ lang: 'python', title: 'FastAPI middleware calling the script', src: String.raw`
TOKEN_BUCKET = redis.register_script(open("token_bucket.lua").read())

@app.middleware("http")
async def rate_limit(request: Request, call_next):
    ident, rule = identify(request), RULES.lookup(request)        # in-memory config
    key = f"rl:{{{ident}}}:{rule.group}"
    try:
        allowed, remaining, retry = await TOKEN_BUCKET(keys=[key],
            args=[rule.capacity, rule.refill_per_sec, 1])
    except RedisError:
        if rule.fail_closed:                                       # e.g. login, OTP
            return JSONResponse({"error": "try again"}, status_code=503)
        return await call_next(request)                            # fail open
    headers = {"RateLimit-Policy": f'"{rule.group}";q={rule.capacity};w=60',
               "RateLimit": f'"{rule.group}";r={remaining};t={math.ceil(float(retry))}'}
    if not allowed:
        headers["Retry-After"] = str(math.ceil(float(retry)))
        return JSONResponse({"error": "rate_limited"}, status_code=429, headers=headers)
    response = await call_next(request)
    response.headers.update(headers)
    return response` }]
    },
    {
      from: 'redis', to: 'mw', label: '[1, 13, 0]', reply: true,
      title: 'Allowed: 13 tokens left',
      caption: 'The script answers allowed with 13 tokens remaining. Total time: one Redis round trip, typically well under a millisecond inside a data centre.',
      text: ['The script returns three values: allowed (1), whole tokens remaining (13) and seconds to wait (0). The bucket itself keeps the fractional value, so slow steady refills are not lost to rounding.'],
      payloadKind: 'Script result + bucket state',
      payload: { result: [1, 13, '0'], bucket_after: { tokens: 13.42, ts: 1764064811.204 } }
    },
    {
      from: 'mw', to: 'h', label: 'allowed',
      title: 'The request proceeds, with quota headers',
      caption: 'The handler runs. The response carries headers that tell the client its policy and remaining quota.',
      text: ['The IETF httpapi working group is standardizing `RateLimit-Policy` and `RateLimit` headers (an Internet-Draft, still evolving). Many APIs use the older `X-RateLimit-Limit/Remaining/Reset` names. Either way, `Retry-After` on a 429 is standard HTTP.'],
      payloadKind: 'HTTP response headers',
      payloadLang: 'http',
      payload: String.raw`
HTTP/1.1 200 OK
RateLimit-Policy: "search";q=20;w=60
RateLimit: "search";r=13;t=0
Content-Type: application/json`
    },
    {
      from: 'cli', to: 'mw', label: 'burst of 25 requests',
      title: 'The client bursts',
      caption: 'A loop fires 25 requests in one second, one every 40 ms. The 13.42 stored tokens plus the refill so far let the first 14 through; refills add one more token in time for request 24, and the other 10 get 429.',
      payloadKind: 'Bucket over one second',
      payload: { t0_tokens: 13.42, requests: 25, refilled_in_1s: 1.67, allowed: 15, rejected: 10, tokens_after: 0.09 },
      text: ['13.42 tokens at the start plus 1.67 refilled during the second allow 15 requests (1–14 and 24); 10 are rejected. The test suite replays this bucket to check the numbers.']
    },
    {
      from: 'mw', to: 'cli', label: '429 Retry-After: 1', reply: true,
      title: 'Rejected requests get 429 and a precise wait',
      caption: 'The script computed how long until one token is available (about 0.55 s). The client is told Retry-After: 1 and should wait that long.',
      text: ['Good clients back off using `Retry-After` plus {{jitter}}. Bad clients ignore it; they keep getting cheap 429s from the middleware without touching your database.', 'For abusive traffic at very high rates, push coarse limits further out (to the CDN or the load balancer) so floods never reach your instances.'],
      payloadKind: 'HTTP response',
      payloadLang: 'http',
      payload: String.raw`
HTTP/1.1 429 Too Many Requests
Retry-After: 1
RateLimit-Policy: "search";q=20;w=60
RateLimit: "search";r=0;t=1
Content-Type: application/json

{"error":"rate_limited","message":"Too many requests. Retry after 1 second."}`
    },
    {
      from: 'mw', to: 'cfg', label: 'reload limits (every 60 s)',
      title: 'Limits come from config, not code',
      caption: 'Plans and per-endpoint limits live in PostgreSQL and are cached in each instance. Changing a customer\'s limit takes effect within a minute without a deploy.',
      text: ['Rules are matched most specific first: plan + endpoint group, then plan default, then a global default. Login is keyed by IP **and** username so an attacker cannot spread guesses across many IPs for one account, or many accounts from one IP.'],
      payloadKind: 'Config rows',
      payload: { rules: [{ plan: 'free', group: 'search', capacity: 5, per_minute: 30 }, { plan: 'pro', group: 'search', capacity: 20, per_minute: 100 }, { plan: '*', group: 'login', capacity: 5, per_minute: 5, key: 'ip+username', fail_closed: true }] },
      fields: { fail_closed: 'For login and one-time-code endpoints, a broken limiter must not open the door to brute force.' }
    }
  ],
  decisions: [
    { q: 'Which algorithm?', options: [
      { verdict: 'good', name: 'Fixed window counter (INCR + EXPIRE)', why: 'Simplest. Allows up to 2× the limit around a window boundary (end of one minute + start of the next).' },
      { verdict: 'good', name: 'Sliding window log (sorted set of timestamps)', why: 'Exact, but stores every request timestamp: memory grows with the limit.' },
      { verdict: 'great', name: 'Token bucket or sliding window counter', why: 'Constant memory per key, smooth, allows controlled bursts. Token bucket is the usual choice for APIs.' }
    ] },
    { q: 'What happens when Redis is down?', options: [
      { verdict: 'bad', name: 'Fail every request', why: 'The limiter becomes a single point of failure for the whole API.' },
      { verdict: 'great', name: 'Fail open for normal endpoints, closed for sensitive ones, with a local in-memory fallback limit', why: 'Availability for normal traffic, protection where abuse is dangerous.' }
    ] }
  ],
  refs: [
    { label: 'Redis: Rate limiting tutorial', url: 'https://redis.io/learn/howtos/ratelimiting' },
    { label: 'IETF draft: RateLimit header fields for HTTP', url: 'https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/', note: 'Still a draft; check the latest version.' },
    { label: 'Stripe: Scaling your API with rate limiters', url: 'https://stripe.com/blog/rate-limiters' },
    { label: 'RFC 6585: HTTP 429 Too Many Requests', url: 'https://www.rfc-editor.org/rfc/rfc6585' }
  ],
  verify: {
    checked: ['Step 6 (the burst): test_content.js replays the token bucket with the flow\'s own numbers (13.42 tokens, capacity 20, 100/60 tokens per second, 25 requests 40 ms apart) and checks 15 allowed, 10 rejected and 0.09 tokens left.'],
    uncertain: ['The other steps have not been checked line by line against the sources yet. Keys, timestamps and plan limits are illustrative.']
  }
});
