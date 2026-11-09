# ORM China Viewer (`@local/orm-china-viewer`)

An offline-first railway viewer for the DeepSeek Harness (DSH) Web GUI: it downloads China-scope OpenStreetMap railway features (railway=rail ways + station/halt nodes) via the Overpass API into local GeoJSON shards, then renders them in a dark-canvas Leaflet panel with OpenRailwayMap-style tag semantics. Once the data is on disk the panel is fully offline — the browser side performs zero network requests.

Also registers three agent tools: `orm_status` (data inventory), `orm_fetch` (window-probed background download), `orm_reset` (drop shards).

## Panel

- Sidebar icon "中国铁路地图 / China Railway Map" → main panel.
- Dark canvas (no basemap tiles — that is the point), default view over China (35.5N 104.5E, zoom 4).
- Track styling by OSM tags: usage (main/branch/industrial), bridge casing, tunnel transparency, disused/abandoned/razed/proposed/construction variants; station/halt circle markers with name tooltips. Click any feature to see its raw tags.
- Data units list (provinces, or 2° grid cells as fallback) with per-unit Load/Remove/Retry; class toggles for tracks and stations; live progress through the `orm` Remote follow stream.

## Data pipeline

- Scope: OSM China = relation 270056 (ISO3166-1=CN) → Overpass area `3600270056`; units are province relations (admin_level=4) when the province scan works, else a 2° grid over bbox (73.5, 18.0, 135.1, 53.6).
- Fetches are GET-only with browser UA + Referer headers, gated by a cheap probe query (the local network blackholes Overpass intermittently), with exponential backoff on 429/502/504 and a serial, resumable queue — re-running only touches pending/failed units.
- Storage (next to the package's parent directory): `orm-china-data/manifest.json` plus `units/<unitId>.{rail,station}.geojson`. All writes are atomic (.tmp → rename). Delete the directory to reset.
- Data license: © OpenStreetMap contributors, ODbL 1.0. The panel shows the attribution permanently.

## Data source B: direct PBF (A-path)

### Data source B2: GitHub Actions relay (fallback)

When both direct mirrors are unreachable, `orm_fetch source=pbf` (and the panel's PBF button) automatically falls back to the relay release asset: a GitHub-hosted runner pulls the Geofabrik extract, filters it with osmium (`railway=rail` ways + `station|halt` nodes), and publishes `china-rail-latest.osm.pbf` under the rolling tag `data-latest` of the configured `pbf.relay.repo`. The relay repository content lives in `relay/` (push pending user approval); the standalone fetcher is `scripts/gh-relay-fetch.mjs` (api.github.com, Range resume, sha256 verify).

Besides the window-probed Overpass queue, the panel toolbar offers **PBF direct**: a Range-resumable download of the national `china-latest.osm.pbf` mirror (default `download.openstreetmap.fr/extracts/asia/china-latest.osm.pbf`, ~1.65 GiB, geofabrik.de as fallback), a pyosmium railway filter, and ingestion as one whole-country unit (`cn-pbf`) into the same shards/manifest store. Agent form: `orm_fetch source=pbf`. Progress appears in the toolbar and `orm_status`.

Requirements: a Python 3.10+ with pip reachable by the Host (set `pbf.pythonPath` to an absolute interpreter path if needed — the DSH bundled Python works). The Host installs pyosmium on first use when `pbf.autoInstallPyosmium` is on.

## Install (Lead/admin action — not part of this package)

1. Install the bundle from this directory (plugin manager, `link:` form, same as `@local/rss-reader`).
2. Add the package directory to the profile's `hmr` root list for Host-side hot reload (see the rss-reader row in the desktop profile's cordis.patch.yml).

## Configuration

The patch row carries the config (see `cordis.patch.yml`). Highlights: `scope.mode` (auto|area|grid), `fetch.*` (probe/backoff/timeouts/maxBytes), `panel.*` (center/zoom/autoLoadBytesLimit), per-tool toggles and names. Defaults are sane for this machine.

## Development

| File | Role |
|---|---|
| `index.js` | Host service: scope resolution, serial fetch queue, Remote namespace `orm`, marker table. |
| `lib/store.js` | Manifest + shard persistence (atomic writes). |
| `lib/overpass.js` | GET engine: probe, retries, unit/counts/province queries. |
| `lib/convert.js` | OSM JSON → GeoJSON (pure functions). |
| `lib/agent-tools.js` | orm_status / orm_fetch / orm_reset registration. |
| `src/client.js` | Panel source — **edit this**, then rebuild. |
| `scripts/build-client.mjs` | Deterministic bundle builder (see below). |
| `client.js` | Generated bundle (committed). Do not edit. |
| `vendor/` | Vendored Leaflet 1.9.4 dist. |
| `test/run.mjs` | Offline test suite. |

- `npm test` → `node test/run.mjs` (no network).
- Dev loop: edit `src/client.js` → `node scripts/build-client.mjs` → the DSH client-hmr stat-poll hot-swaps `client.js` within ~500 ms; no page refresh, no dev:web needed. Host-side edits hot-reload through the profile hmr root entry.
- `client.js` = GENERATED banner + Leaflet in a forced-CommonJS bridge (sets `window.L`) + `window.__ORM_LEAFLET_CSS__` + `src/client.js` verbatim. Rebuilds are deterministic (byte-identical for unchanged inputs).

### Vendored Leaflet record (01-research U6 closure)

Source: `https://registry.npmjs.org/leaflet/-/leaflet-1.9.4.tgz` (Leaflet 1.9.4, BSD-2-Clause).

| File | Bytes | SHA-256 |
|---|---|---|
| `vendor/leaflet.js` | 147552 | `db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a` |
| `vendor/leaflet.css` | 14806 | `a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6` |

No marker image assets are used (CircleMarker + tooltips only), so the CSS `images/` references are inert.

## License

Dual-licensed: **CC BY-NC-SA 4.0** for non-commercial share-alike use, or **AGPL-3.0** as the fallback for any use that does not meet the CC conditions (including commercial). See [LICENSE](LICENSE) for the full text.

- OpenStreetMap data: ODbL 1.0 (cannot be relicensed).
- Vendored Leaflet: BSD-2-Clause.

## Monthly data updates

The relay workflow (`relay/` in this repository, deployed at [sliverwolf233/orm-china-relay](https://github.com/sliverwolf233/orm-china-relay)) runs **monthly on the 1st at 03:00 UTC (11:00 Beijing)** via GitHub Actions cron, producing two rolling release assets:

- `china-all-latest.osm.pbf` (national + urban rail) under tag `data-all-latest`
- `china-rail-latest.osm.pbf` (national rail only) under tag `data-rail-latest`

To refresh local data: open the panel and press **PBF direct**, or run:

```bash
node scripts/gh-relay-fetch.mjs --mode all   # or --mode rail
node scripts/ingest-relay.mjs <path-to-pbf>
node scripts/bin-to-grid.mjs
node scripts/build-overview.mjs
```


[![powered by dsh](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
