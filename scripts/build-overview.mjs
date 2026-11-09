/** task-18 round 2: build a small national overview shard (cn-overview) from the
 * grid rail shards — deterministic decimation (every Nth feature, main lines
 * preferentially kept by ordering) so the whole network is visible at any zoom
 * without loading 200 MB of grid cells. */
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createStore } from "../lib/store.js";
import { slimFeature } from "../lib/convert.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const store = createStore({ dataDir: path.resolve(root, "..", "orm-china-data") });
const manifest = store.readManifest();
const railUnits = (manifest.units ?? []).filter((u) => u.status === "done" && (u.features?.rail ?? 0) > 0 && u.id !== "cn-overview"); // never resample our own output

// deterministic order: main lines first (stable by id), then others by id
const main = [];
const other = [];
for (const u of railUnits) {
	const shard = store.readShard(u.id, "rail");
	if (shard === null) continue;
	for (const f of shard.features ?? []) {
		(f?.properties?.usage === "main" ? main : other).push(f);
	}
}
const STRIDE = 12;
const picked = [];
for (let i = 0; i < main.length; i += STRIDE) picked.push(main[i]);
for (let i = 0; i < other.length; i += STRIDE * 4) picked.push(other[i]);
const KEEP = ["name", "usage", "railway:ref"];
const fc = { type: "FeatureCollection", features: picked.map((f) => slimFeature(f, KEEP, 5)) };
const bytes = store.writeShard("cn-overview", "rail", fc);
const prior = store.readManifest()?.units.find((u) => u.id === "cn-overview");
store.upsertUnit({
	id: "cn-overview", name: "全国概览 (每6条主线取1)", mode: "pbf-grid", status: "done",
	bbox: [73.5, 18.0, 135.1, 53.6],
	bytes: { rail: bytes, station: 0 },
	features: { rail: picked.length, station: 0 },
	fetchedAt: new Date().toISOString(), error: null, attempts: 1
});
console.log(JSON.stringify({ mainTotal: main.length, otherTotal: other.length, picked: picked.length, bytesMB: +(bytes / 1048576).toFixed(2) }, null, 1));