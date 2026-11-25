# System Design Flows

An interactive explorer of system design flows. Open a flow, press play, and follow each request through the architecture: which component it reaches, the payload and its fields, the code for that step (Next.js / TypeScript on the client, FastAPI / Python on the server, PostgreSQL and Redis where they fit), and what happens when the step fails.

Live site: https://asaphuclouvain.github.io/system-design-flows/

## Flows (33)

**Messaging & events**

- Notification system, end to end
- Event-driven pipeline with Kafka
- Webhook delivery platform
- Job scheduler and distributed cron
- Transactional email delivery

**Identity & security**

- Sign in with Google (OAuth 2.0 + OIDC with PKCE)
- Access tokens, refresh rotation and logout
- Distributed rate limiter

**Real-time**

- Real-time chat (WebSocket)
- Ride matching with geo indexing
- Collaborative editing (CRDT document sync)

**Product systems**

- URL shortener
- News feed with hybrid fan-out
- Large file upload (presigned multipart)
- Video transcoding and adaptive streaming
- Real-time game leaderboard

**Search & discovery**

- Search autocomplete (typeahead)
- Full-text search with Elasticsearch
- Nearby places search (PostGIS, Yelp-style)
- Web crawler and search indexing pipeline

**Commerce & money**

- Card payment checkout
- Distributed transaction: order saga with compensation
- Ticket sale: waiting room, seat holds and checkout

**Infrastructure foundations**

- Distributed cache (Redis cache-aside with invalidation)
- CDN: edge caching, origin shield and purge
- Load balancing, health checks and service discovery
- API gateway and backend for frontend
- Distributed ID generation (Snowflake-style)
- Feature flags and gradual rollout
- Multi-region replication and failover

**Data at scale**

- Metrics, logs and traces pipeline
- Real-time analytics: clickstream to live dashboard
- Distributed key-value store (Dynamo-style)


## Run it

Open `dist/system-design-flows.html` in a browser. It is one self-contained file with no server needed.

## Build

```
python3 build.py
```

This inlines `src/template.html`, `src/app.css`, `src/data.js`, `src/glossary.js`, every file in `src/flows/` and `src/app.js` into `dist/system-design-flows.html`.

## Add or edit a flow

Each flow is one file in `src/flows/` that pushes a plain data object (nodes, steps, payloads, code, failure notes) onto `window.SD_FLOWS`. Copy an existing flow, change it, then rebuild.

## Test

```
pip install playwright && playwright install chromium
python3 test.py            # data checks and browser tests for every flow
python3 test.py <flow_id> --shots   # one flow, with screenshots in shots/
```

See `REQUIREMENTS.md` for the requirements and the design notes.
