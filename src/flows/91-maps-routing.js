flow({
  id: 'maps-routing',
  title: 'Maps: tiles, routing and ETA (Google Maps)',
  category: 'Product systems',
  tags: ['Map tiles z/x/y', 'CDN for tiles', 'Geocoding', 'Road graph', 'Precomputed shortcuts (CH / MLD)', 'Live-traffic ETA'],
  summary: 'Opening a map and asking for directions is three systems: pre-rendered tiles served from a CDN, a geocoder that turns an address into coordinates, and a routing engine that searches a huge road graph with precomputed shortcuts, then adjusts the time with live traffic. Follow a route request, a tile cache miss, and a reroute when traffic changes.',
  requirements: {
    functional: ['Show the map at any zoom level.', 'Turn an address into a point (geocoding).', 'Return the fastest route with an ETA, and reroute when traffic changes.'],
    nonFunctional: ['Tiles load instantly anywhere in the world.', 'Route answers in well under a second for a continental road graph.', 'ETA accuracy matters more than finding the theoretically shortest path.']
  },
  estimates: ['At zoom z the world is 2^z × 2^z tiles: zoom 18 is about 68.7 billion tiles, so deep zooms are rendered on demand and cached.'],
  grid: { cols: 5, rows: 3 },
  nodes: [
    { id: 'app', label: 'Maps app', sub: 'phone', kind: 'client', icon: 'phone', x: 0, y: 1, desc: 'Draws tiles, sends searches and route requests, reports its own GPS speed (anonymised) while navigating.' },
    { id: 'cdn', label: 'Tile CDN', sub: '/tiles/z/x/y', kind: 'edge', icon: 'cdn', x: 1, y: 0, desc: 'Caches static tiles close to users. Tile URLs never change for a given map version.' },
    { id: 'tiles', label: 'Tile service', sub: 'render / vector tiles', kind: 'storage', icon: 'map', x: 2, y: 0, desc: 'Pre-renders popular zoom levels; renders rare tiles on demand from map data.' },
    { id: 'geo', label: 'Geocoding', sub: 'address → lat/lng', kind: 'service', icon: 'pin', x: 1, y: 2, desc: 'Parses the text, matches it against an address index, returns coordinates.' },
    { id: 'route', label: 'Routing engine', sub: 'graph + shortcuts', kind: 'service', icon: 'route', x: 2, y: 1, desc: 'Bidirectional search on a road graph that has precomputed shortcut edges, so it explores thousands of nodes instead of millions.' },
    { id: 'eta', label: 'ETA model', sub: 'traffic + ML', kind: 'ai', icon: 'brain', x: 3, y: 1, desc: 'Predicts travel time per road segment from live speeds and history.' },
    { id: 'traffic', label: 'Live traffic', sub: 'stream of GPS speeds', kind: 'queue', icon: 'car', x: 3, y: 2, desc: 'Aggregates anonymised speed reports into current speed per road segment.' }
  ],
  pseudo: `
tile = cdn.get(f"/tiles/{z}/{x}/{y}.pbf") or tiles.render(z, x, y)
origin = gps(); dest = geocode("Grand-Place, Brussels")
snap origin, dest to nearest road nodes
path = bidirectional_search(graph_with_shortcuts, origin, dest)
eta = sum(eta_model(segment, now, live_speed[segment]) for segment in path)
return {polyline, eta, steps}
while navigating:
    if live_eta(remaining) > best_alternative + 3*min: reroute()`,
  steps: [
    {
      from: 'app', to: 'cdn', label: 'GET /tiles/14/8401/5508.pbf', pc: ['tile = cdn.get'],
      title: 'The map loads as tiles',
      caption: 'The screen is covered by 256-pixel squares. Each tile has an address: zoom, column, row. At zoom 14 Louvain-la-Neuve is in a handful of tiles.',
      text: ['The z/x/y scheme (Web Mercator, 2^z tiles per side) is the common "slippy map" standard documented by OpenStreetMap.'],
      payloadKind: 'Tile request',
      payload: { z: 14, x: 8401, y: 5508, format: 'vector (protobuf)', cache: 'HIT', bytes: 41200 },
      branch: { q: 'Is the tile in the CDN?', options: [ { label: 'yes: served from the edge', goto: 'geo1' }, { label: 'no: render it', goto: 'miss' } ] }
    },
    {
      id: 'miss', path: 'miss', from: 'cdn', to: 'tiles', label: 'MISS /tiles/18/134430/88142', pc: ['tiles.render'],
      title: 'Other outcome: a rare deep-zoom tile',
      caption: 'Nobody has looked at this field at zoom 18 recently. The tile service renders it from map data, and the CDN keeps it for next time.',
      text: [],
      payloadKind: 'Render',
      payload: { z: 18, rendered_ms: 120, cache_control: 'public, max-age=604800' }
    },
    {
      id: 'geo1', from: 'app', to: 'geo', label: '"Grand-Place, Brussels" → 50.8467, 4.3525', pc: ['dest = geocode'],
      title: 'Turn the destination into coordinates',
      caption: 'The geocoder normalises the text and matches it to a place in its index. The phone already knows the origin from GPS.',
      text: [],
      payloadKind: 'Geocode',
      payload: { q: 'Grand-Place, Brussels', result: { lat: 50.8467, lng: 4.3525, place_id: 'pl_grandplace', confidence: 0.98 } }
    },
    {
      from: 'app', to: 'route', label: 'route(50.668,4.612 → 50.847,4.353, car)', pc: ['snap origin', 'path = bidirectional_search'],
      title: 'Search the road graph',
      caption: 'Both points are snapped to the nearest road. Then the engine searches forward from the origin and backward from the destination on a graph that has precomputed shortcut edges.',
      text: ['Plain Dijkstra on a continent-sized graph is far too slow per request. Engines like OSRM preprocess the graph (contraction hierarchies or multi-level partitions) so each query touches only a small part of it.'],
      payloadKind: 'Route query',
      payload: { origin_node: 88123401, dest_node: 10234455, profile: 'car', nodes_settled: 3200, ms: 6 }
    },
    {
      from: 'route', to: 'eta', label: '214 segments → time per segment', pc: ['eta = sum'],
      title: 'Predict the travel time',
      caption: 'The shortest path by distance is not the answer. The ETA model predicts each segment\'s time from live speed, time of day and history.',
      text: ['Google and DeepMind described grouping road segments into "supersegments" and using graph neural networks to improve ETA predictions.'],
      payloadKind: 'ETA',
      payload: { segments: 214, distance_km: 31.4, free_flow_min: 29, predicted_min: 38 }
    },
    {
      from: 'traffic', to: 'eta', label: 'E411 km 12: 34 km/h (usually 110)', pc: ['live_speed[segment]'],
      title: 'Live traffic feeds the model',
      caption: 'Anonymised speeds from phones that are driving are aggregated per segment every minute.',
      text: [],
      payloadKind: 'Segment speed',
      payload: { segment: 'E411_km12_N', speed_kmh: 34, typical_kmh: 110, samples: 57, window: '1 min' }
    },
    {
      from: 'route', to: 'app', reply: true, label: '38 min via E411, polyline + 14 steps', pc: ['return {polyline, eta, steps}'],
      title: 'The route comes back',
      caption: 'The app gets an encoded line to draw, the ETA and turn-by-turn steps.',
      text: [],
      payloadKind: 'Route',
      payload: { eta_min: 38, distance_km: 31.4, polyline: 'u{~vHk~p[…', steps: 14, alternatives: 2 },
      branch: { q: 'Traffic changes while driving?', options: [ { label: 'yes: check for a faster route', goto: 'reroute' }, { label: 'no: keep going', goto: 'end' } ] }
    },
    {
      id: 'reroute', path: 'reroute', from: 'eta', to: 'app', label: 'new route saves 7 min → reroute', pc: ['reroute()'],
      title: 'Other outcome: reroute',
      caption: 'An accident slows the E411. The remaining ETA jumps to 49 min; an alternative via the N4 is 42 min. Above the threshold, so the app offers the new route.',
      text: [],
      payloadKind: 'Reroute',
      payload: { old_remaining_min: 49, new_remaining_min: 42, via: 'N4', accepted: true }
    },
    {
      id: 'end', from: 'app', to: 'traffic', label: 'anonymised speed reports while driving', pc: ['while navigating'],
      title: 'The trip improves everyone else\'s ETA',
      caption: 'While navigating, the phone reports its speed per segment, which becomes live traffic for the next drivers.',
      text: [],
      payloadKind: 'Probe report',
      payload: { segment: 'N4_km3', speed_kmh: 72, anonymised: true }
    }
  ],
  decisions: [
    { q: 'Raster or vector tiles?', options: [
      { name: 'Vector tiles', verdict: 'good', why: 'Smaller, styled on the device, rotate and change language without new downloads.' },
      { name: 'Raster (PNG) tiles', verdict: 'ok', why: 'Simple, but a new image per style and per screen density.' } ] },
    { q: 'Routing algorithm?', options: [
      { name: 'Precomputed shortcuts (CH/MLD)', verdict: 'good', why: 'Millisecond queries; MLD can update traffic weights faster than full CH.' },
      { name: 'Plain Dijkstra / A*', verdict: 'bad', why: 'Explores millions of nodes per request on real road graphs.' } ] }
  ],
  refs: [
    { label: 'OpenStreetMap Wiki: Slippy map tilenames (z/x/y)', url: 'https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames' },
    { label: 'OSRM: Running OSRM (CH and MLD pipelines)', url: 'https://github.com/Project-OSRM/osrm-backend/wiki/Running-OSRM' },
    { label: 'Google DeepMind: Traffic prediction with advanced graph neural networks', url: 'https://deepmind.google/discover/blog/traffic-prediction-with-advanced-graph-neural-networks/' },
    { label: 'ByteByteGo: System Design Interview Vol. 2, chapter "Google Maps" (book)', url: 'https://bytebytego.com/courses/system-design-interview/google-maps' }
  ],
  verify: {
    checked: ['Tile addressing z/x/y with 2^z tiles per side: OpenStreetMap wiki (2^18 squared ≈ 68.7 billion computed from it).', 'CH and MLD preprocessing pipelines: OSRM wiki.', 'Supersegments and graph neural networks for ETA: DeepMind blog.'],
    uncertain: ['Coordinates are real places, but tile numbers, timings, speeds and the reroute threshold are illustrative.', 'Google\'s internal routing system is not public; OSRM is used as the open example.']
  }
});
