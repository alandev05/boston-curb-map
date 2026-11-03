# Boston curb parking rules

![Block scale](docs/preview-desktop.png)
![Citywide overview](docs/preview-city.png)
![Light mode](docs/preview-light.png)
*Preview shot against the mock city API with stand-in buildings; live, the towers are real OpenFreeMap footprints with heights and the curb lines follow actual street edges.*

An interactive map of **every curb in Boston and the parking rule that applies** — right now, or at any day/hour you pick.

Live data comes from the City of Boston's [Curb Lab](https://www.boston.gov/curb-lab), which publishes a public [Curb Data Specification](https://github.com/openmobilityfoundation/curb-data-specification) (CDS) feed at `https://cds-curb-api.boston.gov`. Parking meters come from the City's [ArcGIS Hub Parking Meters item](https://bostonopendata-boston.opendata.arcgis.com/datasets/parking-meters/api).

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Falandev05%2Fboston-curb-map)

## How it works

**Build time** (`npm run build` → `scripts/data.js`):

```
cds-curb-api.boston.gov ──▶ scripts/fetch-cds.js ──▶ data/raw/zones.geojson + policies.json
ArcGIS Hub (Parking Meters) ──▶ scripts/fetch-meters.js ──▶ data/raw/meters.geojson
OpenFreeMap roads (z14)     ──▶ scripts/osm-roads.js   ──▶ data/raw/osm/*.pbf (cache)
                              scripts/build-tiles.js ──▶ public/tiles/{z}/{x}/{y}.pbf  (gzipped MVT, z9–15)
                                                         public/data/policies.json, manifest.json
```

Every curb carries `rs`, the index of its **set of rule ids** (`public/data/rulesets.json`; ~12.6k distinct sets for ~52k curbs). When the time changes, the browser grades each rule set once and hands the results to the style as an array indexed by `rs`. Panning and zooming therefore run no JavaScript and keep no per-curb feature-state (feature-state is re-applied to every tile as it loads, which made zooming stutter). Tiles also carry `dom`, the most common category over the week, as a fallback. Grades are integer arrays read with `["at", rs, …]`: an O(1) lookup (a string `slice` copies the whole string per curb, which cost seconds per tile).

**Level of detail.** Zoomed out, single curbs are too small to read or click, and drawing tens of thousands at once is what made zooming slow, so curbs fade in over z12–12.3 and curb tiles start at z12 (the largest is ~240 KB, ~15k curbs). Meters are a point layer in the same tiles from z13. The view is bounded to Boston (plus a margin), which also caps zooming out.

**Versioning.** Every data URL carries the build version (`?v=` in the manifest's `tile_url`, and on `policies`/`rulesets`), so a browser never pairs cached tiles from one deploy with rules from another.

**Curbs line up with the drawn roads** the way Google's traffic layer does. The city's geometry sits on the physical curb, 4–6 m off the centerline, while a basemap draws roads at a symbolic width, so raw curbs float beside the road. `scripts/snap.js` projects each curb onto the OSM centerline it runs along (the same OpenFreeMap tiles the basemap renders) and records its side (`side` ±1) and road class (`rc`). The map then pushes it to that edge of the drawn road with a data-driven `line-offset`. Roads are drawn at true metric width from z15, so the curb sits just inside the road edge at every zoom. Every drawn curb follows two rules: it sits on its own road, and it never runs onto another road.
- **On its own road:** curbs snap where they can. A curb on a corner becomes one piece per street. A divided street whose two carriageways are drawn as one wide road (edges ≤ 5 m apart, same road class, e.g. Mass Ave in Back Bay) has no visible median, so a curb between them goes on the outer edge of the nearer carriageway, in line with its neighbors. No curb is ever drawn on a carriageway's hidden inner edge. A curb in a real median (a visible gap) or at a fork keeps its true position, which lies inside the drawn road anyway. A curb that won't snap and would float off the road gets a looser second snap, or is pulled to the nearest edge of a road running its way.
- **Never onto another road:** every curb end is trimmed back from cross streets, and slivers that sit wholly inside an intersection aren't drawn.

`npm run data` prints what happened to each group. Run it on the current data and about 91% snap.

**Progressive disclosure** follows Google Maps (Google zoom N ≈ MapLibre N−1). Arterials and city names come first. Local streets, neighborhoods and street names by road class appear as you zoom in, then one-way arrows, buildings and POIs, and house numbers from z18. Curbs do the same: arterials only below z12, short stubs such as hydrant zones from z14, and curbs with no data only from z15.

**Run time**: static files only. The `api/` functions remain as a fallback (`/api/zones`, `/api/policies`, `/api/meters`) and the client uses them automatically when no `manifest.json` exists.

**Freshness**: data is re-fetched on every deploy. For a nightly refresh, point a Vercel Cron or any scheduler at a Vercel Deploy Hook.

* **Fallback (API) mode**: below z13 one citywide `lite=1` fetch draws the whole city; above it, per-viewport full-detail fetches.
* **Time.** The map follows the clock by default. Open the time chip to pick a day (the next 7) and drag the time-of-day slider (30-minute steps); "Now" goes back to following the clock. Curbs are graded for a driver with no resident permit or disability placard.
* **Street cleaning.** The city's sweeping schedules from Analyze Boston are a table with no geometry, fetched by `scripts/fetch-sweeping.js`. `scripts/sweeping.js` joins each row onto the curbs as drawn, using the basemap's OSM data:
  * the street, by name;
  * the stretch between the row's two cross streets, where those streets meet it; when a name appears in several places, the pair whose distance matches the row's `miles` is chosen;
  * the odd or even side, from OSM house numbers, carried over to the facing curb and along neighbors on the same side.

  About 69% of rows match. Curbs whose curb-feed rules already include sweeping keep them (the feed wins). Sweeping is its own "Street cleaning" rule and counts as not allowed while it runs. On a chosen date only the listed weeks apply: "1st & 3rd Tue" means only those Tuesdays, from April to November unless the row is year-round. That's why curbs in view are graded in the browser for the actual date.
* **Artifact audit.** `npm run audit` checks how every curb will be drawn: through buildings, off the road, into a cross street, jogs between neighbors, sharp turns, and stray from the city's geometry. It prints counts and example locations.
* **Overnight spans** ("Mon–Fri 6 PM–8 AM") belong to the day they start. Friday 6 PM through Saturday 8 AM is in force; Sunday night into Monday is not.
* **Overridden rules.** A rule a higher-precedence rule covers at every time it applies (a hydrant's all-day "no stopping" over the block's "2 hr parking", which the city often lists on the hydrant's own few meters) is left out of the popup: it can never apply there. Meters never override (they go free), and a running meter beats a free time-limit sign on the same curb. Where the city's description gives a reason for no stopping/no parking (fire hydrant, bus stop, emergency use), the popup shows it.
* **Parking meters as curb rules** (`scripts/meters.js`). Each of the city's ~7,000 meters carries its own schedule: `PAY_POLICY` (paid hours and time limit), `PARK_NO_PAY` (the free hours: the rest of the week), `TOW_AWAY` (rush-hour tow). At build time each active meter is matched to the curb it stands beside (within 6 m, on the city's own curb geometry; ~6,500 match, on ~1,600 curbs). The meter's schedule replaces the feed's metered rule there (keeping the feed's hourly rate; the meter's "$0.25" is a minimum payment) or gives a no-data curb one, and its tow-away hours become a no-stopping rule.
* **Signs that cover part of a curb.** The feed often lists every sign on a block in one zone, so a hydrant's all-day "no stopping" (priority 1) painted whole metered blocks red. A spot sign (hydrant, bus stop, valet, loading, accessible, pick-up/drop-off, rideshare, emergency) on a curb that also has general parking or meters and is long enough (30 m, 20 m for a hydrant, 12 m with meters on it), and any restriction in force through all of a metered curb's paid hours, is stored as `~id`: it doesn't grade the curb, and the popup lists it as "on part of this curb". Restrictions covering only some of those hours (street cleaning, tow-away) still apply to the whole curb. Checked against the meters themselves: during their paid hours the curb they stand on reads "Paid meter" 95% of the time (48% before).
* **Accessible spaces.** Where the city mapped an accessible space as its own zone (857 curbs, median 17 m), it's "Accessible" (placard). Where an accessible-only rule and a resident-only rule are posted on the same stretch (689 curbs, also median 17 m), the feed doesn't say whether you need one or both: the popup shows one line ("Accessible space · resident permit also posted") and the map grades it strictly, as needing both. Accessible rules are never folded away on priority.
* **Policies** are resolved client-side in `src/rules.js`: for the chosen day + hour, every policy attached to a zone is checked against its CDS `time_spans`; the lowest `priority` number wins (CDS precedence), and its first rule is bucketed into a colour category (no stopping, no parking, travel lane, loading, paid, resident, accessible, free).
* If the city API is unreachable the map falls back to a few hand-made demo curbs in Back Bay and says so in the status chip.

## Run locally

```bash
npm install
npx vercel dev      # serves the site AND the /api functions on :3000
# or: npm run dev   # vite only; proxies /api to :3000 (run vercel dev alongside)
```

## Deploy

Click the Vercel button above, or:

```bash
npx vercel --prod
```

No environment variables required. Set `CDS_BASE` if the city moves the API.

## Project layout

```
api/        Vercel serverless functions (CDS + CKAN proxies)
src/        Vite front-end: MapLibre map, rule resolver, cartoon CSS
index.html  Panel + legend + time picker
```

## Caveats

* Curb Lab coverage started in Chinatown and is expanding citywide — some neighbourhoods may still be empty.
* Category bucketing is a heuristic over CDS `activity` / `user_classes` / `rate`; read the sign before you park.
* Not affiliated with the City of Boston.

## Testing

```bash
npm test          # builds the site, then 113 tests: rule engine, API handlers (mocked fetch), HTTP end-to-end
npm run test:unit # just the fast ones
```

`test/e2e.test.js` boots `scripts/mock-cds.js` (a fake `cds-curb-api.boston.gov` + CKAN with ~5,000 generated curb zones across Boston) and `scripts/dev-server.js` (mounts `api/*.js` without Vercel), then hits them over real HTTP.

### Localhost without Vercel

```bash
# terminal 1 — fake city API + Hub (offline / deterministic)
npm run mock
# terminal 2 — build tiles from the mock, then serve
npm run data:mock && npm run dev:local        # http://localhost:3000

# or against the real city API:
npm run build && npm run serve
```

## Themes

Follows the device's light/dark setting (`prefers-color-scheme`, live); the theme button switches it for the visit. The map is strictly 2D (pitch and rotation locked, like Google Maps). Both themes share one layer list so `map.setStyle(…, { diff: true })` swaps paint in place. UI uses the system font stack (Helvetica Neue / Segoe / Roboto) — no web fonts, no logos.
