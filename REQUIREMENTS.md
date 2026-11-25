# System design flows app: the user's requirements, recorded

Recorded Nov 25, 2026, from the user's own words in the call.

- At least 30 flows, "or you can do more". Only system design, no DSA. "The most important system design, and it has to be good."
- "I open the app and I see the flows. I see different flow and I click on one. I see how the things go and it's interactive."
- Notification system end to end: "from the user input ... to the authority ... everything, how everything works out, the payload, the fields, in details".
- "No, not detailed centerpiece. All have to be detailed, detailed. Otherwise it doesn't serve to anything. There has to be details, every single one." Every flow gets the same depth as the notification flow.
- Code for each flow: focused, realistic snippets for the key pieces of each step (a full project per flow is too much).
- Stack: "Next.js, FastAPI. That's my stack." Code is TypeScript / Next.js on the client side and Python / FastAPI on the server side, with PostgreSQL and Redis where relevant.
- Easy to update: flows live in a data structure that can be edited or added to as technologies change.
- "Take your time. It could take two hours, three hours, five hours." "Test, see in the browser. Test and over and over."
- "I don't know whether you do that very cleanly, very beautifully." Look online at the websites that already show flows like this, check everything they do, and reproduce or improve it.
- "I want very beautiful graphics and interactive when needed or relevant."
- Professional, something to put online. Works on a phone.
- "Can you take browser snapshot and check them?" Reference sites were screenshotted and checked.

## What the reference sites do (checked in screenshots, Nov 25, 2026)

- samwho.dev (load balancing, hashing): warm off-white canvas, rounded-square nodes, requests as moving coloured dots, play/pause + speed slider + reset under every diagram, and the words in the text are coloured like the shapes they name (a green dot before "requests").
- thesecretlivesofdata.com/raft: one caption sentence per step under the diagram, Continue and restart buttons, coloured words match diagram colours.
- Hello Interview (Bitly breakdown): hand-drawn style diagrams with numbered labels on arrows ("1) generate short url 2) save to DB") and the data fields written beside the database; requirements first, then API, then high-level design, then deep dives as Bad / Good / Great solution accordions; sticky "On this page" table of contents and reading progress.
- ByteByteGo guides: colourful category cards with diagram thumbnails.

Design decisions taken from this: positioned architecture diagram with labelled, numbered arrows; colour per component kind and matching coloured names in the text; moving packet; play / pause / speed / restart; caption per step; tabs for explanation, payload, code and failure; requirements, API, data model and deep-dive decision accordions per flow; category colours on the home grid.
