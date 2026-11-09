/**
 * orm-china-viewer · live small-bbox pipeline test (verify-stage artifact, task-4).
 *
 * Drives the REAL production pipeline modules end to end:
 *   lib/overpass.js createEngine (probe + unitQuery + retries, default fetch config)
 *   -> lib/convert.js convertOsm -> lib/store.js writeShard (atomic)
 * Data dir is overridden to test/.live-data so nothing outside the package is touched.
 *
 * Modes:
 *   node test/live-sample.mjs          live attempt: engine probe (8 x 15s default); on open
 *                                      window download Beijing bbox 116.2,39.8,116.6,40.05.
 *                                      Exit 0 = live download OK; exit 3 = window never opened
 *                                      (blocked-by-network; then runs the mock pipeline check).
 *   node test/live-sample.mjs --mock   offline: stubbed transport serving the Hainan fixture
 *                                      through the identical engine->convert->store path. Exit 0.
 * Exit 1 = genuine failure (either mode).
 */
import { readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine, unitQuery } from "../lib/overpass.js";
import { convertOsm } from "../lib/convert.js";
import { createStore } from "../lib/store.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const MOCK = process.argv.includes("--mock");
const AREA_ID = 3600270056;
const BBOX = [116.2, 39.8, 116.6, 40.05]; // Beijing urban sample (task-4 hint 4)
const FETCH_CONFIG = {
	userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	referer: "https://wiki.openstreetmap.org/",
	probeAttempts: 8,
	probeGapMs: 15000,
	queryTimeoutS: 300,
	clientTimeoutMs: 240000,
	maxRetries: 3,
	backoffMs: 10000,
	maxBytes: 268435456
};
const UNIT_ID = MOCK ? "mock-hainan" : "beijing-sample";

const log = (msg) => console.log("[live-sample " + new Date().toISOString() + "] " + msg);

function makeDataDir() {
	const dir = path.join(root, "test", ".live-data", UNIT_ID);
	rmSync(dir, { recursive: true, force: true });
	return dir;
}

function validateGeo(rail, station) {
	const problems = [];
	if (rail.type !== "FeatureCollection") problems.push("rail.type != FeatureCollection");
	if (station.type !== "FeatureCollection") problems.push("station.type != FeatureCollection");
	let badGeom = 0, badCoord = 0, shortLine = 0, outside = 0;
	const inChina = (lon, lat) => lon > 73 && lon < 136 && lat > 17 && lat < 54;
	const inSample = (lon, lat) => lon >= 115.8 && lon <= 117.0 && lat >= 39.5 && lat <= 40.4;
	for (const f of rail.features) {
		if (f.geometry?.type !== "LineString") { badGeom++; continue; }
		if (f.geometry.coordinates.length < 2) shortLine++;
		for (const c of f.geometry.coordinates) {
			if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) { badCoord++; continue; }
			if (!inChina(c[0], c[1])) outside++;
		}
	}
	for (const f of station.features) {
		if (f.geometry?.type !== "Point") { badGeom++; continue; }
		const c = f.geometry.coordinates;
		if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) badCoord++;
		else if (!inSample(c[0], c[1]) && !MOCK) outside++;
	}
	if (badGeom) problems.push(badGeom + " features with wrong geometry type");
	if (badCoord) problems.push(badCoord + " non-finite coordinates");
	if (shortLine) problems.push(shortLine + " LineStrings with <2 points");
	if (rail.features.length === 0) problems.push("0 rail features (expected >0)");
	if (outside > 0) problems.push(outside + " coordinates outside plausible bounds");
	return problems;
}

async function main() {
	const dataDir = makeDataDir();
	const store = createStore({ dataDir });
	log("mode=" + (MOCK ? "MOCK (stubbed transport, zero network)" : "LIVE") + " dataDir=" + dataDir);

	let fetchImpl;
	const probeLog = [];
	if (MOCK) {
		const fixture = readFileSync(path.join(root, "test", "fixtures", "hainan-sample.osm.json"), "utf8");
		fetchImpl = async (url) => {
			probeLog.push(url.includes("out%20ids") || url.includes("out+ids") ? "probe" : "unit-query");
			return { status: 200, text: async () => fixture };
		};
	} else {
		let n = 0;
		fetchImpl = async (url, init) => {
			n += 1;
			const isProbe = decodeURIComponent(url).includes(";out ids;");
			const t0 = Date.now();
			try {
				const r = await fetch(url, init);
				probeLog.push("attempt " + n + (isProbe ? " (probe)" : " (query)") + " -> HTTP " + r.status + " (" + (Date.now() - t0) + "ms)");
				return r;
			} catch (e) {
				probeLog.push("attempt " + n + (isProbe ? " (probe)" : " (query)") + " -> network error " + (e?.cause?.code ?? e.name) + " (" + (Date.now() - t0) + "ms)");
				throw e;
			}
		};
	}

	const engine = createEngine(FETCH_CONFIG, { fetchImpl });
	log("engine probe start (probeAttempts=" + FETCH_CONFIG.probeAttempts + ", gap=" + FETCH_CONFIG.probeGapMs + "ms)");
	const probeStart = Date.now();
	const open = await engine.probe(AREA_ID);
	log("probe result: " + open + " after " + (Date.now() - probeStart) + "ms; transport log:");
	for (const line of probeLog) console.log("    " + line);

	if (!open) {
		console.log("RESULT: WINDOW-CLOSED (blocked-by-network)");
		process.exit(3);
	}

	const target = MOCK ? [108.5, 18.0, 111.0, 20.0] : BBOX;
	const qStart = Date.now();
	const osm = await engine.run(unitQuery(target, FETCH_CONFIG.queryTimeoutS), { label: "live-sample" });
	const queryMs = Date.now() - qStart;
	const el = osm.elements ?? [];
	const counts = { node: 0, way: 0, rel: 0 };
	for (const e of el) counts[e.type] = (counts[e.type] ?? 0) + 1;
	log("unit query done in " + queryMs + "ms; elements=" + el.length + " " + JSON.stringify(counts) + "; generator=" + (osm.osm3s?.generator ?? "?"));

	const converted = convertOsm(osm);
	const bytes = {};
	if (converted.rail.features.length > 0) bytes.rail = store.writeShard(UNIT_ID, "rail", converted.rail);
	if (converted.station.features.length > 0) bytes.station = store.writeShard(UNIT_ID, "station", converted.station);
	const problems = validateGeo(converted.rail, converted.station);
	console.log("RESULT: " + (problems.length === 0 ? "OK" : "GEOJSON-INVALID"));
	console.log("  rail features:    " + converted.rail.features.length + " (" + (bytes.rail ?? 0) + " B shard)");
	console.log("  station features: " + converted.station.features.length + " (" + (bytes.station ?? 0) + " B shard)");
	console.log("  shard dir: " + store.unitsDir);
	console.log("  problems: " + (problems.length === 0 ? "none" : problems.join("; ")));
	if (problems.length > 0) process.exit(1);
	process.exit(0);
}

main().catch((e) => { console.error("FATAL: " + (e?.stack ?? e)); process.exit(1); });
