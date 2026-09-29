# Offline routing: design

Date: 2026-09-29
Status: design approved in brainstorming (engine B chosen after the A/B comparison); for review.
Branch: `routing`

## Goal

Plan a route by road from where you are to a place you pick, offline, and show it on the map with
its distance and estimated time. No turn-by-turn guidance. A switch decides whether F-roads and 4×4
tracks may be used.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Kind of navigation | Route by road, no guidance | Chosen by the user |
| Road types | A per-route switch "Allow F-roads and tracks", default on, remembered | Chosen by the user |
| Extras | None (no stops, no saving, start is always your position or the map centre) | "Keep it simple for now" |
| Engine | B: Garmin's own routing network (NOD) | Chosen after the comparison below |
| Where it runs | In a tile worker, like the place index | Keeps the map smooth |

### The comparison (commit d504384, `web/test/routing.bench.test.ts`)

On the Mac, F-Road Detailed map, 12 benchmark routes:

| | A: from road lines | B: from NOD |
|---|---|---|
| Network build | 3.4 s (decoding the whole detailed level) | 0.05 s, plus 3.2 s for the F-road lookup |
| Memory | ~98 MB | ~44 MB |
| Connectivity | 98.5% in one network | 99.3% |
| Route search | 0–9 ms | 0–13 ms |
| One-way streets | ignored | respected |
| Speeds | a table by road type | Garmin's speed class per segment |

Both found all 12 routes, with distances within 1–3% of each other. B's weaknesses, both addressed
below: F-roads cannot be told apart in NOD itself, and its F-road speeds are optimistic.

## Engine B

### The network (already implemented in the spike: `web/src/routing/nod.ts`, `engineB.ts`)

- Per map tile, read the NOD header, the road records (NOD2) for each road's first node, and follow
  arcs from there to reach every node (NOD1).
- A node's position is the tables area's base plus its 12- or 16-bit offsets (map units).
- Only **direct** arcs are used (the first arc of each road-and-direction group); the other
  ("indirect") arcs skip further along the same road and their length field isn't the road length.
- Arc length = raw length × 2.4 m. One-way (Table A bit 3) arcs running against the road are dropped.
- Tiles join where their boundary nodes share coordinates.

### Speeds

Garmin speed class 0–7 → 5, 20, 40, 60, 80, 90, 110, 128 km/h, **capped** for F-roads and tracks so
highland estimates are realistic (Selfoss → Landmannalaugar should come out near 2.5–3 h, not 1.7 h):

| Road | Cap (km/h) |
|---|---|
| F-road (type 0x12, or a name like "F208") | 25 |
| Track (0x11) | 20 |
| Rough 4×4 track (0x13) | 15 |

### F-road lookup

NOD can't tell F-roads from gravel roads, so each road's line type and name come from the road lines
via the NET pointer that both carry. The lookup (per tile: NET offset → F-road / track / rough track)
is produced **in the same whole-map decode that already builds the place index**, and saved with the
place index cache (same key: map file name, size, date). So after the first launch with a map, the
network builds in about a tenth of a second.

### Route search

- Start: the GPS position if a fix is under 10 minutes old, else the map centre. End: the chosen
  place. Both snap to the nearest node of the main network (the largest connected part) within
  2 km; otherwise the panel explains which end has no road nearby.
- A* over travel time; with the switch off, F-road and track edges are skipped.
- Result: node path, metres, seconds.

### Drawing the route along the roads

A route is a list of arcs; each arc knows its road (NET offset) and its two end nodes. To draw it
along the real road, the worker decodes the finest-level subdivisions that contain the route's nodes
(using the tile cache), finds the road line with that NET offset containing both end points, and
takes the part between them (reversed if needed). If no matching line is found (rare), that arc is
drawn straight.

## Screens

- **Destination card.** Tapping a search result (flies there and drops the pin, as now) or a long
  press on the map (right-click on the Mac; drops a pin) shows a card at the bottom: the name (or
  "Dropped pin" and coordinates) and **Route here**. Tapping the map elsewhere or × closes it.
- **Route panel.** "To ‹name›", "186 km · 3 h 05 min · from your position" (or "from the map
  centre"), and the switch "Allow F-roads and tracks". The first route of a session shows "Preparing
  roads…". Messages instead of silent failure: "No road within 2 km of the destination", "No road
  near your position", "No route without F-roads and tracks: turn the switch on to allow them". ×
  clears the route and pin.
- **On the map.** A thick dark-blue line with a white casing, above the map and GPX tracks, below
  the position dot; a white start dot and the red destination pin. The map fits the route above the
  panel. The route doesn't change as you move (no guidance); follow and heading-up work as usual.
- **Instructions page.** A short "Plan a route" section.

## Code layout

- `web/src/routing/nod.ts`: NOD reader (from the spike).
- `web/src/routing/graph.ts`: graph, A*, snapping (from the spike).
- `web/src/routing/network.ts`: engine B's network with speed caps and the F-road lookup; route
  shape along road lines.
- The place-index pass (`web/src/search/places.ts` + worker) also returns the F-road lookup; the
  cache stores both.
- Worker message `route` and `TilePool.route(from, to, allowFRoads)`.
- `web/src/app/route.ts`: destination card, route panel, route layer.
- Engine A's graph builder and the benchmark are removed once B is in (they stay in branch history);
  the road-line collection moves to where the lookup is built.

## Testing

- Unit: NOD decoding on synthetic bytes (a hand-built node area: coordinates, arcs, both length
  forms, one-way, inter-area links); speed caps; F-road lookup; route shape extraction.
- Real data (skipped without the map): every decoded node lies on a road point; direct arcs are
  paired; benchmark routes (Reykjavík → Akureyri 380–395 km; Selfoss → Landmannalaugar found only
  with F-roads, 2.2–3.3 h; Húsavík → Dettifoss found); route shape follows roads (every shape point
  within a few metres of a road line).
- Browser run: long press → Route here → the panel's numbers; the switch changes the route; × clears.

## Out of scope

Turn-by-turn guidance and re-routing; stops; saving routes; turn restrictions (NOD Table C) and
vehicle access flags; walking or cycling routes.
