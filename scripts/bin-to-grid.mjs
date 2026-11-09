/**
 * task-18 minimal fix: re-bin the whole-country cn-pbf shards into the existing
 * 2-degree grid units (same ids/naming as lib/convert.gridCells) so the panel's
 * viewport-progressive loading works with small shards, and the untrusted
 * Overpass grid rows are replaced by relay-derived truth. Removes the cn-pbf
 * mega-unit afterwards (its 188MB shard is what froze/failed the Load path).
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gridCells, slimFeature } from "../lib/convert.js";
import { createStore } from "../lib/store.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const store = createStore({ dataDir: path.resolve(root, "..", "orm-china-data") });
const manifest = store.readManifest();
const gridBbox = manifest.scope.gridBbox ?? [73.5, 18.0, 135.1, 53.6];
const cells = gridCells(gridBbox, 2);
const cellById = new Map(cells.map((c) => [c.id, c]));
console.error("grid cells: " + cells.length);

function cellOf(lon, lat) {
	const lon0 = Math.floor(lon / 2) * 2;
	const lat0 = Math.floor(lat / 2) * 2;
	const id = "g" + String(+(lon0.toFixed(2))).replace(".", "").replace("-", "m") + "-" + String(+(lat0.toFixed(2))).replace(".", "").replace("-", "m");
	return cellById.get(id) ?? null;
}

const fetchedAt = new Date().toISOString();
let totalFeatures = { rail: 0, station: 0 };
for (const klass of ["rail", "station"]) {
	const shard = store.readShard("cn-pbf", klass);
	if (shard === null) continue;
	const bins = new Map(); // cellId -> features[]
	for (const f of shard.features ?? []) {
		const g = f.geometry;
		let point = null;
		if (g?.type === "Point") point = g.coordinates;
		else if (g?.type === "LineString" && g.coordinates?.length > 0) point = g.coordinates[0];
		if (point === null) continue;
		const cell = cellOf(point[0], point[1]);
		if (cell === null) continue;
		if (!bins.has(cell.id)) bins.set(cell.id, []);
		bins.get(cell.id).push(f);
	}
	for (const cell of cells) {
		const features = bins.get(cell.id) ?? [];
		const KEEP_GRID = ["railway", "name", "name:en", "usage", "maxspeed", "gauge", "electrified", "operator", "railway:ref", "ref", "wikidata", "alt_name", "tunnel", "bridge", "disused", "proposed", "construction", "station", "subway", "network"];
		const fc = { type: "FeatureCollection", features: features.map((f) => slimFeature(f, KEEP_GRID, 5)) };
		let bytes = 0;
		if (features.length > 0) bytes = store.writeShard(cell.id, klass, fc);
		totalFeatures[klass] += features.length;
		const prior = store.readManifest()?.units.find((u) => u.id === cell.id);
		const merged = {
			id: cell.id, name: cell.id, mode: "pbf-grid", status: "done", bbox: cell.bbox,
			bytes: { ...(prior?.bytes ?? { rail: 0, station: 0 }), [klass]: bytes },
			features: { ...(prior?.features ?? { rail: 0, station: 0 }), [klass]: features.length },
			fetchedAt, error: null, attempts: 1
		};
		store.upsertUnit(merged);
	}
	console.error(klass + " binned: " + totalFeatures[klass] + " features across " + (bins.size) + " non-empty cells");
}
const freed = store.removeUnit("cn-pbf");
console.error("removed cn-pbf mega-unit (freed " + Math.round(freed / 1048576) + " MiB of shards)");
const summary = store.summary();
console.log(JSON.stringify({ summary }, null, 1));
