# orm-china-relay

GitHub-side relay for the `@local/orm-china-viewer` DSH plugin (B-path of docs/pipeline/orm-china-viewer/03-alt-source-research.md). The workflow in `.github/workflows/relay.yml` runs on GitHub-hosted runners, where `download.geofabrik.de` is reachable, and publishes a railway-filtered China PBF as the rolling Release tag **`data-latest`**:

- `china-rail-latest.osm.pbf` — ways railway=rail + nodes railway=station|halt (osmium tags-filter)
- `china-rail-latest.osm.pbf.sha256` — checksum
- `china-rail-latest.fileinfo.txt` — osmium fileinfo (element counts, bounding box)
- `generated-at.txt` — UTC timestamp

The local machine never talks to geofabrik: it resolves the asset via `api.github.com/repos/<this-repo>/releases/tags/data-latest` and downloads with Range resume, verifying the checksum. See `orm-china-viewer/scripts/gh-relay-fetch.mjs` and the plugin's `pbf.relay` config.

Data: © OpenStreetMap contributors, ODbL 1.0. Keeping this repo public keeps Actions minutes free and the asset downloadable without auth; the ODbL attribution is embedded in the release notes.
