/** task-16: convert+store step of the pbf pipeline (spawn-free variant of lib/pbfIngest tail). */
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { convertOsm, bboxOf } from "../lib/convert.js";
import { createStore } from "../lib/store.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const osmJsonPath = process.argv[2];
const osm = JSON.parse(readFileSync(osmJsonPath, "utf8"));
const converted = convertOsm(osm);
const store = createStore({ dataDir: path.resolve(root, "..", "orm-china-data") });
const unitId = "cn-pbf";
const bytes = { rail: 0, station: 0 };
const features = { rail: converted.rail.features.length, station: converted.station.features.length };
if (features.rail > 0) bytes.rail = store.writeShard(unitId, "rail", converted.rail);
if (features.station > 0) bytes.station = store.writeShard(unitId, "station", converted.station);
const prior = store.readManifest()?.units.find((u) => u.id === unitId);
store.upsertUnit({
	id: unitId, name: "中国全量 (PBF)", mode: "pbf", status: "done",
	bbox: bboxOf(converted.rail) ?? prior?.bbox ?? null,
	bytes, features,
	fetchedAt: new Date().toISOString(), error: null,
	attempts: (prior?.attempts ?? 0) + 1
});
console.log(JSON.stringify({ features, bytesMB: { rail: +(bytes.rail / 1048576).toFixed(1), station: +(bytes.station / 1048576).toFixed(1) }, summary: store.summary() }, null, 1));
