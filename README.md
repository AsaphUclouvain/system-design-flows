# System Design Flows

An interactive explorer of system design flows. Open a flow, press play, and follow each request through the architecture: which component it reaches, the payload and its fields, the code for that step (Next.js / TypeScript on the client, FastAPI / Python on the server, PostgreSQL and Redis where they fit), and what happens when the step fails.

Work in progress: the goal is at least 30 flows, each as detailed as the notification system flow.

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
