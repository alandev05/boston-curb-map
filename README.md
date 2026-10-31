# Curb Cartoon 🅿️

An interactive, slightly cartoony map of **every curb in Boston and the parking rule that applies** — right now, or at any day/hour you pick.

Live data comes from the City of Boston's [Curb Lab](https://www.boston.gov/curb-lab), which publishes a public [Curb Data Specification](https://github.com/openmobilityfoundation/curb-data-specification) (CDS) feed at `https://cds-curb-api.boston.gov`. Parking meter points come from [Analyze Boston](https://data.boston.gov).

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Falandev05%2Fboston-curb-map)

## How it works

```
browser ──/api/zones?bbox=…──▶ Vercel function ──▶ cds-curb-api.boston.gov /curbs/zones
        ──/api/policies──────▶ Vercel function ──▶ cds-curb-api.boston.gov /curbs/policies
        ──/api/meters────────▶ Vercel function ──▶ data.boston.gov CKAN datastore
```

* **Zones** are fetched per viewport (zoom ≥ 12.5) and cached client-side; the serverless proxy adds an edge cache so the city API isn't hammered.
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
npm test          # builds, then 69 tests: rule engine, API handlers (mocked fetch), HTTP end-to-end
npm run test:unit # just the fast ones
```

`test/e2e.test.js` boots `scripts/mock-cds.js` (a fake `cds-curb-api.boston.gov` + CKAN with ~5,000 generated curb zones across Boston) and `scripts/dev-server.js` (mounts `api/*.js` without Vercel), then hits them over real HTTP.

### Localhost without Vercel

```bash
# terminal 1 — fake city API (offline / deterministic)
npm run mock
# terminal 2 — site + /api, pointed at the mock
npm run dev:local        # http://localhost:3000

# or against the real city API:
npm run build && npm run serve
```
