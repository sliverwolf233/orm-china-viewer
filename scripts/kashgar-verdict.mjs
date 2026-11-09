/** task-16: Kashgar 6-cell verdict — relay rail features vs grid cells that reported 0. */
import { readFileSync } from "node:fs";
const shard = JSON.parse(readFileSync("D:/Codes/Deepseek Harness Custom/orm-china-data/units/cn-pbf.rail.geojson", "utf8"));
const cells = {
	"g74-36": [74, 36, 76, 38], "g74-38": [74, 38, 76, 40], "g74-40": [74, 40, 76, 42],
	"g76-36": [76, 36, 78, 38], "g76-38": [76, 38, 78, 40], "g76-40": [76, 40, 78, 42],
	"beijing-g116-40": [116, 40, 118, 42]
};
const hits = {};
for (const k of Object.keys(cells)) hits[k] = { count: 0, names: [] };
for (const f of shard.features) {
	const coords = f.geometry?.coordinates ?? [];
	for (const k of Object.keys(cells)) {
		const [w, s, e, n] = cells[k];
		let inter = false;
		for (const [lon, lat] of coords) {
			if (lon >= w && lon <= e && lat >= s && lat <= n) { inter = true; break; }
		}
		if (inter) {
			hits[k].count += 1;
			if (hits[k].names.length < 3 && f.properties?.name) hits[k].names.push(String(f.properties.name));
		}
	}
}
const manifest = JSON.parse(readFileSync("D:/Codes/Deepseek Harness Custom/orm-china-data/manifest.json", "utf8"));
const gridRows = {};
for (const id of Object.keys(cells)) {
	const gid = id.startsWith("beijing") ? "g116-40" : id;
	gridRows[gid] = manifest.units.find((u) => u.id === gid)?.status ?? "absent";
}
console.log(JSON.stringify({ relayHits: hits, gridStatus: gridRows, totalRelayRails: shard.features.length }, null, 1));
