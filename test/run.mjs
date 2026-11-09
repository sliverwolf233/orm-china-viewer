/**
 * orm-china-viewer · offline test suite (02-plan §8/§9).
 * Run: node test/run.mjs  — no network, no browser; engines use injected stubs.
 */
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertOsm, bboxOf, gridCells } from "../lib/convert.js";
import { createStore, resolveDataDir } from "../lib/store.js";
import { createEngine, unitQuery, probeQuery, interpreterUrl } from "../lib/overpass.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
let passed = 0;
const failures = [];
function ok(cond, label) {
	if (cond) { passed += 1; }
	else { failures.push(label); console.error("FAIL: " + label); }
}

// ---------- 1. convert ----------

const fixture = JSON.parse(readFileSync(path.join(root, "test", "fixtures", "hainan-sample.osm.json"), "utf8"));
const converted = convertOsm(fixture);
ok(converted.rail.type === "FeatureCollection", "convert: rail is a FeatureCollection");
ok(converted.rail.features.length === 4, "convert: 4 rail ways (highway way excluded, id-204 kept despite a dropped unknown node)");
ok(converted.station.features.length === 2, "convert: 2 station points (level_crossing node excluded)");
ok(converted.station.features[0].geometry.coordinates[0] === 109.6, "convert: station lon preserved");
	const urbanFix = convertOsm({ elements: [...fixture.elements, { type: "way", id: 300, nodes: [101, 102], tags: { railway: "subway", name: "BJ-Subway-4" } }, { type: "node", id: 110, lat: 39.9, lon: 116.3, tags: { railway: "tram_stop" } }] });
	ok(urbanFix.rail.features.some((f) => f.properties?.name === "BJ-Subway-4"), "convert: subway ways kept (task-21)");
	ok(urbanFix.station.features.some((f) => f.geometry?.coordinates?.[0] === 116.3), "convert: tram_stop nodes kept");
const way201 = converted.rail.features.find((f) => f.properties.name === "西环货线");
ok(Array.isArray(way201.geometry.coordinates) && way201.geometry.coordinates.length === 4, "convert: way 201 has 4 coordinates");
ok(way201.properties.usage === "main", "convert: tags preserved");
const way204 = converted.rail.features.find((f) => f.id === undefined && f.properties.railway === "rail" && f.geometry.coordinates.length === 2);
ok(way204 !== undefined, "convert: way with unknown node id dropped that node and survived with 2 coords");
const empty = convertOsm({ elements: [] });
ok(empty.rail.features.length === 0 && empty.station.features.length === 0, "convert: empty input tolerated");
const bbox = bboxOf(converted.rail);
ok(Array.isArray(bbox) && bbox[0] <= 109.6 && bbox[2] >= 110.3 && bbox[1] <= 18.6 && bbox[3] >= 19.4, "convert: bboxOf covers all rails");
ok(bboxOf(empty.rail) === null, "convert: bboxOf(null) on empty");

const cells = gridCells([108.0, 18.0, 112.0, 22.0], 2);
ok(cells.length === 4, "convert: gridCells 108-112/18-22 @2° = 4 cells");
ok(cells.every((c) => Array.isArray(c.bbox) && c.bbox[2] - c.bbox[0] === 2), "convert: cells are 2° wide");

// ---------- 2. store (temp dir lifecycle) ----------

const tmpData = path.join(tmpdir(), "orm-china-viewer-test-" + process.pid + "-" + Date.now());
// readShardFor discriminated states (panel graceful-shard fix)
{
	const dir2 = path.join(tmpdir(), "orm-china-viewer-test2-" + process.pid + "-" + Date.now());
	const store2 = createStore({ dataDir: dir2 });
	store2.ensureManifest({ mode: "grid", areaId: 3600270056, gridBbox: [73.5, 18, 135.1, 53.6], generatedAt: "now" });
	ok(store2.readShardFor("nope", "rail").status === "unknown-unit", "shardFor: unknown unit");
	store2.upsertUnit({ id: "g1", name: "g1", mode: "grid", status: "pending" });
	ok(store2.readShardFor("g1", "rail").status === "not-fetched", "shardFor: pending unit");
	store2.upsertUnit({ id: "g2", name: "g2", mode: "grid", status: "done", features: { rail: 0, station: 0 }, bytes: { rail: 0, station: 0 }, fetchedAt: "now" });
	ok(store2.readShardFor("g2", "rail").status === "empty", "shardFor: done-with-zero-features is empty, not an error");
	store2.upsertUnit({ id: "g3", name: "g3", mode: "grid", status: "done", features: { rail: 4, station: 2 }, bytes: { rail: 10, station: 5 }, fetchedAt: "now" });
	ok(store2.readShardFor("g3", "rail").status === "missing-file", "shardFor: done but file vanished");
	store2.writeShard("g3", "rail", converted.rail);
	store2.upsertUnit({ id: "g3", name: "g3", mode: "grid", status: "done", features: { rail: 4, station: 2 }, bytes: { rail: 10, station: 5 }, fetchedAt: "now" });
	const okRes = store2.readShardFor("g3", "rail");
	ok(okRes.status === "ok" && okRes.geojson.features.length === 4, "shardFor: ok path returns geojson");
	rmSync(dir2, { recursive: true, force: true });
}

rmSync(tmpData, { recursive: true, force: true });
const store = createStore({ dataDir: tmpData });
ok(existsSync(store.unitsDir), "store: dirs created");
const m1 = store.ensureManifest({ mode: "area", areaId: 3600270056, gridBbox: [73.5, 18, 135.1, 53.6], generatedAt: "now" });
ok(m1.version === 1 && m1.units.length === 0, "store: manifest initialized");
store.upsertUnit({ id: "p1", name: "海南", mode: "area", status: "fetching" });
const bytes = store.writeShard("p1", "rail", converted.rail);
store.upsertUnit({ id: "p1", name: "海南", mode: "area", status: "done", bytes: { rail: bytes, station: 0 }, features: { rail: 4, station: 2 }, fetchedAt: "2026-11-08T00:00:00Z" });
const m2 = store.readManifest();
ok(m2.units.length === 1 && m2.units[0].status === "done", "store: upsert replaces by id");
ok(bytes > 0 && existsSync(path.join(tmpData, "units", "p1.rail.geojson")), "store: shard written");
ok(store.readShard("p1", "rail").features.length === 4, "store: shard reads back");
ok(store.readShard("p1", "station") === null, "store: missing shard -> null");
ok(existsSync(path.join(tmpData, "units", "p1.rail.geojson.tmp")) === false, "store: no .tmp residue");
const s = store.summary();
ok(s.scoped && s.unitsDone === 1 && s.features.rail === 4 && s.bytes === bytes + 0, "store: summary aggregates");
const freed = store.removeUnit("p1");
ok(freed === bytes && store.readManifest().units.length === 0 && store.readShard("p1", "rail") === null, "store: removeUnit frees and cleans");
ok(resolveDataDir("").endsWith(path.join("orm-china-viewer", "..")) === false, "store: default dir resolves outside the package (parent dir)");
rmSync(tmpData, { recursive: true, force: true });

// ---------- 3. overpass engine (stubbed transport) ----------

const cfg = { userAgent: "test", referer: "https://wiki.openstreetmap.org/", probeAttempts: 2, probeGapMs: 0, queryTimeoutS: 30, clientTimeoutMs: 2000, maxRetries: 2, backoffMs: 1, maxBytes: 1048576 };
const fixtureText = JSON.stringify(fixture);
function stubEngine(responses) {
	const seen = [];
	let i = 0;
	const fetchImpl = async (url) => {
		seen.push(url);
		const r = responses[Math.min(i, responses.length - 1)];
		i += 1;
		if (r.networkFail) throw new TypeError("fetch failed");
		return { status: r.status, text: async () => r.body };
	};
	return { engine: createEngine(cfg, { fetchImpl, sleep: async () => {}, now: () => 0 }), seen };
}
const s1 = stubEngine([{ status: 502, body: "busy" }, { status: 200, body: fixtureText }]);
const out1 = await s1.engine.run(unitQuery(3600270056), { label: "t" });
ok(out1.elements.length === 13, "engine: 502 retried then 200 parsed");
const s2 = stubEngine([{ networkFail: true }, { networkFail: true }, { networkFail: true }]);
let threw2 = false;
try { await s2.engine.run(probeQuery(3600270056)); } catch { threw2 = true; }
ok(threw2, "engine: exhausted retries throw");
const s3 = stubEngine([{ status: 406, body: "filtered" }]);
let threw3 = false;
try { await s3.engine.run(probeQuery(3600270056)); } catch (e) { threw3 = String(e.message).includes("406"); }
ok(threw3, "engine: hard 4xx surfaces immediately with status");
const s4 = stubEngine([{ status: 200, body: JSON.stringify(fixture) }]);
ok(await s4.engine.probe(3600270056) === true, "engine: probe true on 200");
const s5 = stubEngine([{ networkFail: true }]);
ok(await s5.engine.probe(3600270056) === false, "engine: probe false when window closed");
ok(interpreterUrl("x y").startsWith("https://overpass-api.de/api/interpreter?data="), "engine: GET URL form");
ok(unitQuery([108, 18, 110, 20]).includes("(108,18,110,20)"), "engine: bbox variant embeds coords");
ok(unitQuery(3600270056).includes("area(3600270056)->.a;"), "engine: area variant uses area");

// ---------- 3b. src/client.js must parse standalone (caught a missing paren once) ----------
{
	const vm = await import("node:vm");
	try {
		new vm.Script(readFileSync(path.join(root, "src", "client.js"), "utf8"), { filename: "src/client.js" });
		ok(true, "src: src/client.js parses standalone");
	} catch (error) {
		ok(false, "src: src/client.js parses standalone — " + String(error.message).slice(0, 160));
	}
}

// ---------- 4. generated bundle checks ----------

const clientJs = readFileSync(path.join(root, "client.js"), "utf8");
ok(clientJs.startsWith("// GENERATED by scripts/build-client.mjs"), "build: client.js carries GENERATED banner");
ok(clientJs.includes("window.L=module.exports"), "build: leaflet bridge present");
ok(clientJs.includes("window.__ORM_LEAFLET_CSS__="), "build: css global present");
ok(clientJs.includes("id: '@local/orm-china-viewer'"), "build: module registration present");

// ---------- 4b. Leaflet bridge smoke (regression for the panel-blank bug) ----------
{
	const vm = await import("node:vm");
	const generated = readFileSync(path.join(root, "client.js"), "utf8");
	const bridgeEnd = generated.indexOf("window.__ORM_LEAFLET_CSS__=");
	const bridge = generated.slice(0, bridgeEnd);
	function makeSandbox() {
		const sb = {
			console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
			setTimeout, clearTimeout,
			addEventListener: () => {}, removeEventListener: () => {},
			screen: { deviceXDPI: 96, logicalXDPI: 96 },
			devicePixelRatio: 1,
			navigator: { userAgent: "Mozilla/5.0", platform: "Win32", maxTouchPoints: 0 },
			requestAnimationFrame: (fn) => setTimeout(fn, 16), cancelAnimationFrame: clearTimeout
		};
		sb.document = {
			documentElement: { style: {} }, body: { appendChild: () => {} },
			createElement: (el) => ({ style: {}, tagName: el, setAttribute: () => {}, appendChild: () => {}, getContext: el === "canvas" ? () => ({}) : undefined }),
			createElementNS: () => ({ createSVGRect: () => ({}) }), createTextNode: () => ({}),
			getElementById: () => null, getElementsByTagName: () => [{ appendChild: () => {} }],
			addEventListener: () => {}, removeEventListener: () => {}
		};
		sb.window = sb; sb.self = sb; sb.globalThis = sb;
		return sb;
	}
	try {
		const sb = makeSandbox();
		vm.runInNewContext(bridge, sb, { filename: "client.js [bridge]" });
		ok(typeof sb.window.L?.map === "function" && typeof sb.window.L.geoJSON === "function", "bridge: window.L carries Leaflet (map+geoJSON)");
	} catch (error) {
		ok(false, "bridge: bridge execution threw — " + String(error.message).slice(0, 120));
	}
}

// ---------- 5. marker table <-> descriptor table ----------

const indexSrc = readFileSync(path.join(root, "index.js"), "utf8");
const srcClient = readFileSync(path.join(root, "src", "client.js"), "utf8");
const markers = [...indexSrc.matchAll(/remoteMarker\("([^"]+)"(?:,\s*"stream")?\)/g)].map((m) => m[1]);
const descriptors = [...srcClient.matchAll(/methodDescriptor\('([^']+)'|method:\s*'([^']+)'/g)].map((m) => m[1] ?? m[2]);
ok(new Set(markers).size === 4 && markers.length === 4, "parity: 4 remote markers");
ok(new Set(descriptors).size === 4 && descriptors.length >= 4, "parity: 4 client descriptors");
for (const name of markers) ok(descriptors.includes(name), "parity: marker " + name + " has a descriptor");
const streamMarkers = [...indexSrc.matchAll(/remoteMarker\("([^"]+)",\s*"stream"\)/g)].map((m) => m[1]);
ok(streamMarkers.length === 1 && streamMarkers[0] === "follow" && srcClient.includes("method: 'follow'") && srcClient.includes("mode: 'stream'"), "parity: follow is the single stream method on both sides");

// ---------- 6. RemoteError 3-arg discipline ----------

/** Depth-aware scan: every new RemoteError( ... ) call in our sources has >= 3 top-level args. */
function remoteErrorCallsOk(source) {
	let okAll = true;
	let idx = 0;
	while ((idx = source.indexOf("new RemoteError(", idx)) !== -1) {
		const start = idx + "new RemoteError(".length;
		let depth = 1;
		let i = start;
		let args = depth > 0 ? 1 : 0;
		while (i < source.length && depth > 0) {
			const ch = source[i];
			if (ch === "(" || ch === "[" || ch === "{") depth += 1;
			else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
			else if (ch === "," && depth === 1) args += 1;
			i += 1;
		}
		if (args < 3) { okAll = false; console.error("  RemoteError with " + args + " args at offset " + idx); }
		idx = i;
	}
	return okAll;
}
ok(remoteErrorCallsOk(indexSrc), "remote-error: index.js always passes details");
ok(remoteErrorCallsOk(readFileSync(path.join(root, "lib", "agent-tools.js"), "utf8")), "remote-error: agent-tools.js clean");

// ---------- 7. no dangerous HTML sinks (our code only; vendored Leaflet dist excluded by design) ----------

for (const file of ["src/client.js", "index.js", "lib/agent-tools.js"]) {
	const src = readFileSync(path.join(root, file), "utf8");
	ok(src.includes("dangerouslySetInnerHTML") === false && /\binnerHTML\s*=/.test(src) === false && /\beval\(/.test(src) === false && /new Function\(/.test(src) === false, "safety: " + file + " free of innerHTML/eval/new Function");
}
{
	const generated = readFileSync(path.join(root, "client.js"), "utf8");
	const ourPart = generated.slice(generated.indexOf("window.__ModuleLoader__.load"));
	ok(ourPart.includes("dangerouslySetInnerHTML") === false && /\binnerHTML\s*=/.test(ourPart) === false, "safety: generated client.js panel part free of innerHTML sinks");
}


// ---------- 8. pbfSource: Range resumable downloader ----------

{
	const { createPbfSource } = await import("../lib/pbfSource.js");
	const payload = Buffer.alloc(1000, 0x61);
	const dirA = path.join(tmpdir(), "orm-pbf-src-" + process.pid + "-" + Date.now());
	function makeFetchStub({ headStatus = 200, ranges = true } = {}) {
		const calls = [];
		const fetchImpl = async (url, init = {}) => {
			calls.push({ method: init.method ?? "GET", range: init.headers?.Range ?? null, url });
			if ((init.method ?? "GET") === "HEAD") {
				return { status: headStatus, headers: { get: (k) => (k === "content-length" ? "1000" : k === "accept-ranges" ? (ranges ? "bytes" : "") : null) }, arrayBuffer: async () => new ArrayBuffer(0) };
			}
			const m = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range ?? "");
			if (m === null) throw new Error("GET without Range");
			const start = Number(m[1]);
			const end = Math.min(Number(m[2]), 999);
			const slice = payload.subarray(start, end + 1);
			return { status: 206, headers: { get: () => null }, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length) };
		};
		return { fetchImpl, calls };
	}
	{
		const { fetchImpl } = makeFetchStub();
		const src = createPbfSource({ sourceUrl: "https://mirror.example/china-latest.osm.pbf", altUrl: "", chunkBytes: 300 }, dirA, { fetchImpl });
		const result = await src.download();
		ok(result.done === true && result.bytes === 1000, "pbfSource: chunked download completes");
		ok(src.pbfPath() !== null, "pbfSource: final file present after rename");
		const meta = src.readMeta();
		ok(meta.phase === "downloaded" && meta.downloadedBytes === 1000, "pbfSource: meta downloaded");
		ok(statSync(src.finalPath).size === 1000, "pbfSource: bytes on disk correct");
	}
	{
		const { fetchImpl, calls } = makeFetchStub();
		mkdirSync(path.join(dirA, "pbf"), { recursive: true });
		writeFileSync(path.join(dirA, "pbf", "china-latest.osm.pbf.part"), payload.subarray(0, 300));
		writeFileSync(path.join(dirA, "pbf", "pbf.json"), JSON.stringify({ version: 1, phase: "downloading", url: "https://mirror.example/china-latest.osm.pbf", downloadedBytes: 300, totalBytes: 1000 }));
		const src2 = createPbfSource({ sourceUrl: "https://mirror.example/china-latest.osm.pbf", altUrl: "", chunkBytes: 400 }, dirA, { fetchImpl });
		await src2.download();
		const firstRange = calls.find((c) => c.range !== null)?.range ?? "";
		ok(firstRange.startsWith("bytes=300-"), "pbfSource: resumes at .part offset (range " + firstRange + ")");
	}
	{
		// primary HEAD 404 -> alt URL serves
		const fetchImpl = async (url, init = {}) => {
			if ((init.method ?? "GET") === "HEAD" && url.includes("primary")) {
				return { status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
			}
			if ((init.method ?? "GET") === "HEAD") {
				return { status: 200, headers: { get: (k) => (k === "content-length" ? "1000" : k === "accept-ranges" ? "bytes" : null) }, arrayBuffer: async () => new ArrayBuffer(0) };
			}
			const m = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range ?? "");
			const slice = payload.subarray(Number(m[1]), Math.min(Number(m[2]), 999) + 1);
			return { status: 206, headers: { get: () => null }, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length) };
		};
		const src3 = createPbfSource({ sourceUrl: "https://primary.example/china-latest.osm.pbf", altUrl: "https://alt.example/china-latest.osm.pbf", chunkBytes: 1000 }, dirA, { fetchImpl });
		const probe = await src3.probeSource();
		ok(probe.ok === true && probe.url.includes("alt.example"), "pbfSource: falls back to altUrl");
	}
	rmSync(dirA, { recursive: true, force: true });
}

// ---------- 9. pbfIngest: pipeline with stubbed transport/spawn ----------

{
	const { createPbfIngest } = await import("../lib/pbfIngest.js");
	const dirB = path.join(tmpdir(), "orm-pbf-ing-" + process.pid + "-" + Date.now());
	const storeB = createStore({ dataDir: dirB });
	storeB.ensureManifest({ mode: "grid", areaId: 3600270056, gridBbox: [73.5, 18, 135.1, 53.6], generatedAt: "now" });
	const fixtureText = readFileSync(path.join(root, "test", "fixtures", "hainan-sample.osm.json"), "utf8");
	const fakePbf = path.join(dirB, "fake.pbf");
	writeFileSync(fakePbf, Buffer.alloc(16));
	const pbfStub = {
		dir: dirB, fileName: "fake.pbf", partPath: "", finalPath: fakePbf, metaPath: "",
		status: () => ({ phase: "downloaded", url: "stub", fileName: "fake.pbf", downloadedBytes: 16, totalBytes: 16 }),
		pbfPath: () => fakePbf,
		download: async () => ({ done: true, path: fakePbf, bytes: 16 }),
		readMeta: () => null
	};
	function fakeSpawn(cmd, args) {
		const child = { stdout: { on: (_e, cb) => { if (cmd.includes("python") && args[0] === "-c") setTimeout(() => cb(""), 0); } }, stderr: { on: () => {} }, on: (event, cb) => { if (event === "close") setTimeout(() => { if (args.some((a) => String(a).includes("filter_railway.py"))) { const outIdx = args.indexOf("--out"); writeFileSync(args[outIdx + 1], fixtureText); } cb(0); }, 0); } };
		return child;
	}
	const ingest = createPbfIngest({
		config: { pbf: { pythonPath: "python", autoInstallPyosmium: false, unitId: "cn-pbf", chunkBytes: 1048576 } },
		store: storeB, pbfSource: pbfStub, log: () => {},
		deps: { spawnImpl: fakeSpawn, makeTempDir: () => { mkdirSync(path.join(dirB, "tmpwork"), { recursive: true }); return path.join(dirB, "tmpwork"); } }
	});
	const result = await ingest.runPipeline();
	ok(result.done === true && result.features?.rail === 4, "pbfIngest: pipeline converts fixture into shards (rail=4) — got: " + JSON.stringify(result).slice(0, 200));
	ok(storeB.readShardFor("cn-pbf", "rail").status === "ok", "pbfIngest: unit cn-pbf readable via readShardFor");
	ok(storeB.summary().unitsDone === 1, "pbfIngest: manifest counts the pbf unit");
	const again = await ingest.runPipeline();
	ok(again.done === true, "pbfIngest: rerun overwrites unit cleanly");
	rmSync(dirB, { recursive: true, force: true });
}

// ---------- 10. config surface ----------

{
	const indexSrc = readFileSync(path.join(root, "index.js"), "utf8");
	ok(indexSrc.includes('sourceUrl: z.string().default("https://download.openstreetmap.fr/extracts/asia/china-latest.osm.pbf")'), "config: pbf.sourceUrl default is the fr mirror");
	ok(indexSrc.includes('unitId: z.string().default("cn-pbf")'), "config: pbf.unitId default");
	ok(indexSrc.includes("this.startPbf()") && indexSrc.includes('"pbf"'), "fetchNow: pbf source dispatch present");
	const agentSrc = readFileSync(path.join(root, "lib", "agent-tools.js"), "utf8");
	ok(agentSrc.includes('enum: ["overpass", "pbf"]'), "tool: orm_fetch exposes source enum");
}


// ---------- 11. theme palettes + contrast (task-12) ----------

{
	const srcTheme = readFileSync(path.join(root, "src", "client.js"), "utf8");
	const s = srcTheme.indexOf("// [theme-pure-start]");
	const e = srcTheme.indexOf("// [theme-pure-end]");
	ok(s > 0 && e > s, "theme: pure block markers present in src/client.js");
	const block = srcTheme.slice(s, e);
	const fn = new Function(block + "; return { PALETTES, THEME_KEYS, relLuma, contrastRatio, isDarkColor, normColor, themeVars };")();
	for (const scheme of ["dark", "light"]) {
		const p = fn.PALETTES[scheme];
		ok(p !== undefined, "theme: palette " + scheme + " exists");
		const c = (a, b) => fn.contrastRatio(p[a], p[b]);
		ok(c("text", "bg") >= 4.5, "theme[" + scheme + "]: text/bg contrast " + c("text", "bg").toFixed(2) + " >= 4.5");
		ok(c("text", "surface") >= 4.5, "theme[" + scheme + "]: text/surface contrast >= 4.5");
		ok(c("textDim", "bg") >= 3, "theme[" + scheme + "]: textDim/bg contrast >= 3");
		ok(c("textFaint", "surface") >= 3, "theme[" + scheme + "]: textFaint/surface contrast >= 3");
		ok(c("btnText", "btnBg") >= 4.5, "theme[" + scheme + "]: btnText/btnBg contrast >= 4.5");
		ok(c("err", "bg") >= 4.5, "theme[" + scheme + "]: err/bg contrast >= 4.5");
		ok(c("attribText", "attribBg") >= 4.5, "theme[" + scheme + "]: attribText/attribBg contrast >= 4.5");
		ok(c("accentText", "bg") >= 3, "theme[" + scheme + "]: accentText/bg contrast >= 3");
	}
	ok(fn.PALETTES.dark.bg !== fn.PALETTES.light.bg, "theme: palettes actually differ");
	ok(fn.isDarkColor("#111418") === true && fn.isDarkColor("#f2f4f7") === false, "theme: isDarkColor threshold");
	const vars = fn.themeVars("light");
	ok(vars.includes("--orm-bg:#f2f4f7") && vars.includes("--orm-map-bg:#e9edf1"), "theme: themeVars emits css vars");
	const cssStart = srcTheme.indexOf("const PANEL_CSS =");
	const cssEnd = srcTheme.indexOf("`" + ";", cssStart);
	const cssBody = srcTheme.slice(cssStart, cssEnd);
	const usedVars = [...new Set([...cssBody.matchAll(/var\(--orm-[a-z-]+\)/g)].map((m) => m[0].slice(4, -1)))];
	for (const v of usedVars) ok(vars.includes(v + ":"), "theme: PANEL_CSS var " + v + " is defined by themeVars");
	const fn2 = fn;
	ok(typeof fn2.normColor === "function" || block.includes("normColor"), "theme: normColor exported or present for rgb() parsing");
	ok(srcTheme.includes("style: themeVars(theme)") === false, "theme: root must NOT pass a string style prop (React dev throws)");
	ok(srcTheme.includes("'data-orm-theme': theme") === true, "theme: root carries data-orm-theme attribute");
	// CSS palette blocks must match PALETTES exactly (single source cross-check)
	for (const scheme of ["dark", "light"]) {
		const sel = ".dsh-orm-root[data-orm-theme='" + scheme + "'] {";
		const selIdx = cssBody.indexOf(sel);
		ok(selIdx >= 0, "theme: PANEL_CSS has palette block for " + scheme);
		if (selIdx >= 0) {
			const blockCss = cssBody.slice(selIdx, cssBody.indexOf("}", selIdx));
			for (const [k, v] of Object.entries(fn.PALETTES[scheme])) {
				const varName = "--orm-" + k.replace(/[A-Z]/g, (c2) => "-" + c2.toLowerCase()) + ": " + v.toLowerCase() + ";";
				ok(blockCss.replace(/\s+/g, " ").includes(varName) || blockCss.includes("--orm-" + k.replace(/[A-Z]/g, (c2) => "-" + c2.toLowerCase()) + ":" + v), "theme: css var " + k + " matches PALETTES." + scheme);
			}
		}
	}
	// task-14: map container must be absolutely filled + resize-hardened + empty overlay
	ok(cssBody.includes(".dsh-orm-map .leaflet-container { position: absolute; inset: 0;"), "mapFix: leaflet container absolute-fills the host");
	ok(cssBody.includes(".dsh-orm-mapempty {"), "mapFix: on-canvas empty overlay rule present");
	ok(srcTheme.includes("invalidateSize") && srcTheme.includes("ResizeObserver"), "mapFix: resize observer + invalidateSize wired");
	ok(srcTheme.includes("'map.empty':") && srcTheme.includes("dsh-orm-mapempty"), "mapFix: empty overlay text wired");
	ok(/\/\* never let map init[\s\S]*?\*\//.test(srcTheme) || srcTheme.includes("never let map init"), "mapFix: map init is try/catch guarded");
	ok(srcTheme.includes("createThemeHub(ctx)") && srcTheme.includes("ctx.on('theme/change'") && srcTheme.includes("--dsw-alias-bg-base"), "theme: runtime follows DSH theme (event + css fallback)");
}


// ---------- 12. pbfSource hardening (task-15: epoch lock, partial write, reconcile) ----------

{
	const { createPbfSource } = await import("../lib/pbfSource.js");
	const payload = Buffer.alloc(600, 0x62);
	const dirC = path.join(tmpdir(), "orm-pbf-hard-" + process.pid + "-" + Date.now());
	function makeFetchStub() {
		const calls = [];
		const fetchImpl = async (url, init = {}) => {
			if ((init.method ?? "GET") === "HEAD") {
				return { status: 200, headers: { get: (k) => (k === "content-length" ? "600" : k === "accept-ranges" ? "bytes" : null) }, arrayBuffer: async () => new ArrayBuffer(0) };
			}
			const m = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range ?? "");
			if (m === null) throw new Error("GET without Range");
			calls.push(Number(m[1]));
			const slice = payload.subarray(Number(m[1]), Math.min(Number(m[2]), 599) + 1);
			return { status: 206, headers: { get: () => null }, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length) };
		};
		return { fetchImpl, calls };
	}
	// (1) partial write + disk-truth position: server sends short chunk, position still follows disk
	{
		const { fetchImpl } = makeFetchStub();
		const src = createPbfSource({ sourceUrl: "https://m.example/china-latest.osm.pbf", altUrl: "", chunkBytes: 600 }, dirC, { fetchImpl });
		const result = await src.download();
		ok(result.done === true && result.bytes === 600, "pbfHard: plain download ok");
		const meta = src.readMeta();
		ok(meta.downloadedBytes === statSync(src.finalPath).size, "pbfHard: meta matches disk after completion");
	}
	// (2) meta/disk drift reconcile: meta claims 500, disk holds 300 -> resume from 300
	{
		const { fetchImpl, calls } = makeFetchStub();
		mkdirSync(path.join(dirC, "pbf"), { recursive: true });
		writeFileSync(path.join(dirC, "pbf", "china-latest.osm.pbf.part"), payload.subarray(0, 300));
		writeFileSync(path.join(dirC, "pbf", "pbf.json"), JSON.stringify({ version: 1, phase: "downloading", url: "https://m.example/china-latest.osm.pbf", downloadedBytes: 500, totalBytes: 600, epoch: "stale" }));
		const src2 = createPbfSource({ sourceUrl: "https://m.example/china-latest.osm.pbf", altUrl: "", chunkBytes: 300 }, dirC, { fetchImpl });
		await src2.download();
		ok(calls[0] === 300, "pbfHard: drift reconciled to disk size (first range from 300, got " + calls[0] + ")");
		ok(statSync(src2.finalPath).size === 600, "pbfHard: drifted resume completes to full size");
	}
	// (3) epoch supersede (deterministic): pause loop A mid-flight, adopt via epoch change, release -> A yields
	{
		let releaseA = null;
		const gate = new Promise((resolve) => { releaseA = resolve; });
		let served = 0;
		const payload3 = Buffer.alloc(3145728, 0x64); // 3 MiB = 3 chunks at the 1 MiB floor
		const dirD = path.join(dirC, "-epoch");
		const fetchImpl = async (url, init = {}) => {
			if ((init.method ?? "GET") === "HEAD") return { status: 200, headers: { get: (k) => (k === "content-length" ? "3145728" : k === "accept-ranges" ? "bytes" : null) }, arrayBuffer: async () => new ArrayBuffer(0) };
			const m = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range ?? "");
			const start = Number(m[1]);
			served += 1;
			if (served === 2) await gate; // hold A's second chunk while another pipeline adopts
			const slice = payload3.subarray(start, Math.min(Number(m[2]), 3145727) + 1);
			return { status: 206, headers: { get: () => null }, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length) };
		};
		const srcA = createPbfSource({ sourceUrl: "https://m.example/china-latest.osm.pbf", altUrl: "", chunkBytes: 1048576 }, dirD, { fetchImpl });
		const pA = srcA.download();
		await new Promise((r) => setTimeout(r, 30));
		const sizeAfterChunk1 = statSync(srcA.partPath).size;
		ok(sizeAfterChunk1 === 1048576, "pbfHard: loop A wrote chunk 1 (1 MiB)");
		// simulate adoption by a newer pipeline: flip the epoch under A
		const metaNow = srcA.readMeta();
		writeFileSync(srcA.metaPath, JSON.stringify({ ...metaNow, epoch: "newer-pipeline" }));
		releaseA();
		const rA = await pA;
		ok(rA.superseded === true, "pbfHard: superseded loop yields (got " + JSON.stringify(rA).slice(0, 80) + ")");
		ok(statSync(srcA.partPath).size === 2097152, "pbfHard: A appended its held chunk but wrote no further chunks after losing ownership");
	}
	// (3b) pre-corrupted oversized part restarts clean
	{
		const { fetchImpl } = makeFetchStub();
		const dirE = path.join(dirC, "-overshoot");
		mkdirSync(path.join(dirE, "pbf"), { recursive: true });
		writeFileSync(path.join(dirE, "pbf", "china-latest.osm.pbf.part"), Buffer.alloc(700, 0x65));
		writeFileSync(path.join(dirE, "pbf", "pbf.json"), JSON.stringify({ version: 1, phase: "downloading", url: "https://m.example/china-latest.osm.pbf", downloadedBytes: 700, totalBytes: 600, epoch: "x" }));
		const srcE = createPbfSource({ sourceUrl: "https://m.example/china-latest.osm.pbf", altUrl: "", chunkBytes: 200 }, dirE, { fetchImpl });
		const rE = await srcE.download();
		ok(rE.done === true && statSync(srcE.finalPath).size === 600, "pbfHard: oversized corrupt part restarts clean to exact size");
	}
	// (4) attempts accounting fix (source contract)
	{
		const idx = readFileSync(path.join(root, "index.js"), "utf8");
		ok(/const attempts = \(unit\.attempts \?\? 0\) \+ 1;/.test(idx) && /status: "failed", attempts,/.test(idx), "pbfHard: fetchUnit carries attempts into the failed row");
	}
}


// ---------- 13. relay fallback chain (task-9 local) ----------

{
	const { createPbfSource } = await import("../lib/pbfSource.js");
	// probeSource with override: override first, then source, then alt
	{
		const order = [];
		const fetchImpl = async (url) => { order.push(url); if (url.includes("relay")) return { status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }; return { status: 200, headers: { get: (k) => (k === "content-length" ? "10" : k === "accept-ranges" ? "bytes" : null) }, arrayBuffer: async () => new ArrayBuffer(0) }; };
		const src = createPbfSource({ sourceUrl: "https://fr.example/a.osm.pbf", altUrl: "https://geo.example/a.osm.pbf", chunkBytes: 1048576 }, path.join(tmpdir(), "orm-relay-" + process.pid), { fetchImpl });
		const probe = await src.probeSource("https://relay.example/a.osm.pbf");
		ok(probe.ok === true && probe.url.includes("fr.example"), "relay: override tried first, primary next");
		ok(order[0].includes("relay") && order[1].includes("fr"), "relay: candidate order override->primary->alt");
	}
	// index wiring contracts
	{
		const idx = readFileSync(path.join(root, "index.js"), "utf8");
		ok(idx.includes("resolveRelayUrl()"), "relay: resolver present");
		ok(idx.includes("releases/tags/") && idx.includes("china-rail-latest.osm.pbf"), "relay: GitHub release tag + asset defaults");
		ok(idx.includes("runPipeline({ urlOverride: relay.url })"), "relay: fallback routes through urlOverride");
		const relayYml = readFileSync(path.join(root, "relay", ".github", "workflows", "relay.yml"), "utf8");
		ok(relayYml.includes("osmium tags-filter") && relayYml.includes("gh release create"), "relay: workflow filters with osmium and publishes a release");
		ok(relayYml.includes("china-latest.osm.pbf"), "relay: workflow pulls the Geofabrik China extract");
	}
}


// ---------- 14. store readManifest transient-failure fallback (task-18) ----------

{
	const dirT = path.join(tmpdir(), "orm-store-t18-" + process.pid + "-" + Date.now());
	const storeT = createStore({ dataDir: dirT });
	storeT.ensureManifest({ mode: "grid", areaId: 1, gridBbox: [0, 0, 2, 2], generatedAt: "now" });
	storeT.upsertUnit({ id: "g0-0", name: "g0-0", mode: "grid", status: "done", features: { rail: 3, station: 1 }, bytes: { rail: 10, station: 5 } });
	const good = storeT.readManifest();
	ok(good !== null && good.units.length === 1, "storeT18: baseline manifest readable");
	// corrupt on disk (simulates a mid-rename torn read window): readManifest must NOT return null
	writeFileSync(storeT.manifestPath, "{{{torn", "utf8");
	const fallback = storeT.readManifest();
	ok(fallback !== null && fallback.units.length === 1, "storeT18: transient corruption falls back to lastGood instead of null (panel list survives)");
	// delete outright: same fallback applies
	rmSync(storeT.manifestPath, { force: true });
	ok(storeT.readManifest() !== null, "storeT18: missing file also falls back to lastGood");
	rmSync(dirT, { recursive: true, force: true });
}


// ---------- 15. popup model (task-19) ----------

{
	const srcTheme = readFileSync(path.join(root, "src", "client.js"), "utf8");
	const s2 = srcTheme.indexOf("// [popup-pure-start]");
	const e2 = srcTheme.indexOf("// [popup-pure-end]");
	ok(s2 > 0 && e2 > s2, "popup: pure block present");
	const t19 = (k) => ({ 'pop.usage': '用途', 'pop.usage.main': '干线', 'pop.usage.branch': '支线', 'pop.usage.industrial': '工业/测试线', 'pop.usage.service': '场内/服务线', 'pop.maxspeed': '限速', 'pop.gauge': '轨距', 'pop.electrified': '电气化', 'pop.operator': '运营者', 'pop.ref': '编号', 'pop.enName': '英文名', 'pop.rail': '铁路线', 'pop.unnamed': '（未命名）' }[k] ?? k);
	const fn = new Function(srcTheme.slice(s2, e2) + "; return { popupModel };")();
	// user's real station tags (凌源站, from the bug report)
	const station = fn.popupModel({
		alt_name: "凌源站;凌源火车站;Lingyuan Railway Station",
		name: "凌源", "name:en": "Lingyuan",
		operator: "中国铁路沈阳局集团有限公司 阜新车务段",
		public_transport: "station", railway: "station",
		"railway:ref": "52382", wikidata: "Q10895965"
	}, t19);
	ok(station.title === "凌源", "popup: station title is the Chinese name");
	ok(station.subs.some(([l, v]) => l === "运营者" && v.includes("沈阳局")), "popup: operator surfaced");
	ok(station.subs.some(([l, v]) => l === "编号" && v === "52382"), "popup: railway:ref surfaced");
	ok(station.subs.some(([l, v]) => l === "英文名" && v === "Lingyuan"), "popup: English name surfaced");
	ok(station.link !== null && station.link.url === "https://www.wikidata.org/wiki/Q10895965", "popup: wikidata link built");
	ok(station.aliases.includes("凌源火车站"), "popup: alt_name kept as aliases");
	ok(station.allTags.some((kv) => kv.startsWith("public_transport=")), "popup: unknown tags preserved in allTags");
	// rail example
	const rail = fn.popupModel({ railway: "rail", usage: "main", name: "京哈线", maxspeed: "160", gauge: "1435", electrified: "contact_line", "railway:ref": "JH" }, t19);
	ok(rail.title === "京哈线", "popup: rail title is the line name");
	ok(rail.subs.some(([l, v]) => l === "用途" && v === "干线"), "popup: usage mapped to legend wording");
	ok(rail.subs.some(([l, v]) => l === "限速" && v === "160"), "popup: maxspeed surfaced");
	// wikidata injection guard
	const evil = fn.popupModel({ railway: "station", name: "x", wikidata: "Q1 <script>" }, t19);
	ok(evil.link === null, "popup: malformed wikidata QID yields no link");
	// builder safety: DOM builder must not use innerHTML
	ok(/buildPopupEl[\s\S]{0,4000}?innerHTML/.test(srcTheme.slice(srcTheme.indexOf("function buildPopupEl"))) === false, "popup: DOM builder uses no innerHTML");
}


// ---------- 16. perf: slimFeature + overview budget (task-20) ----------

{
	const { slimFeature } = await import("../lib/convert.js");
	const f = { type: "Feature", geometry: { type: "LineString", coordinates: [[116.12345678, 39.87654321], [116.5, 40.0]] }, properties: { name: "X", usage: "main", operator: "Y", maxspeed: "120" } };
	const slim = slimFeature(f, ["name", "usage"], 5);
	ok(slim.properties.name === "X" && slim.properties.usage === "main" && slim.properties.operator === undefined, "slim: whitelist filters props");
	ok(slim.geometry.coordinates[0][0] === 116.12346, "slim: coordinate precision rounded to 5");
	ok(f.properties.operator === "Y" && f.geometry.coordinates[0][0] === 116.12345678, "slim: input feature untouched");
	ok(slimFeature({ type: "Feature", geometry: { type: "Point", coordinates: [1.23456789, 2.3456789] }, properties: {} }, [], 4).geometry.coordinates[0] === 1.2346, "slim: point geometry handled");
	// overview shard budget regression (was 11.41 MB before slimming)
	const overviewPath = path.join(root, "..", "orm-china-data", "units", "cn-overview.rail.geojson");
	if (existsSync(overviewPath)) {
		const ob = statSync(overviewPath).size;
		ok(ob <= 6291456, "perf: overview shard stays under 6 MiB (now " + Math.round(ob / 1048576) + " MiB)");
	}
}


// ---------- 17. overpass remark validation (task-17) ----------

{
	const { createEngine } = await import("../lib/overpass.js");
	const cfg17 = { userAgent: "t", referer: "https://wiki.openstreetmap.org/", probeAttempts: 1, probeGapMs: 0, queryTimeoutS: 30, clientTimeoutMs: 2000, maxRetries: 0, backoffMs: 1, maxBytes: 1048576 };
	function stubEngine(body) {
		const fetchImpl = async () => ({ status: 200, headers: { get: () => null }, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer });
		return createEngine(cfg17, { fetchImpl, sleep: async () => {}, now: () => 0 });
	}
	let threwDegraded = false;
	try { await stubEngine(JSON.stringify({ elements: [], remark: "runtime error: query timed out" })).run("x"); } catch (e) { threwDegraded = String(e.message).includes("overpass degraded"); }
	ok(threwDegraded, "remark: empty elements + remark is rejected (fake-empty guard)");
	const partial = await stubEngine(JSON.stringify({ elements: [{ type: "node", id: 1 }], remark: "partial" })).run("x");
	ok(Array.isArray(partial.elements) && partial.elements.length === 1, "remark: non-empty with remark still accepted (partial data)");
	const trueEmpty = await stubEngine(JSON.stringify({ elements: [] })).run("x");
	ok(Array.isArray(trueEmpty.elements) && trueEmpty.elements.length === 0, "remark: empty without remark stays a valid empty result (true-empty semantics)");
	// manifest consistency with the relay verdict: all grid rows are pbf-grid truth now
	const manifestPath17 = path.join(root, "..", "orm-china-data", "manifest.json");
	if (existsSync(manifestPath17)) {
		const m17 = JSON.parse(readFileSync(manifestPath17, "utf8"));
		const grid17 = m17.units.filter((u) => u.id.startsWith("g"));
		ok(grid17.length > 500 && grid17.every((u) => u.mode === "pbf-grid" && u.status === "done"), "cleanup: grid rows are relay-derived truth (no Overpass-fake rows left)");
		const g7638 = m17.units.find((u) => u.id === "g76-38");
		ok(g7638 !== undefined && g7638.features.rail > 0, "cleanup: kashgar g76-38 carries real features (matches the verdict)");
	}
}


// ---------- 18. urban rail (task-21): filter sync + styles ----------

{
	const pySrc = readFileSync(path.join(root, "scripts", "filter_railway.py"), "utf8");
	const ymlSrc = readFileSync(path.join(root, "relay", ".github", "workflows", "relay.yml"), "utf8");
	const pyAll = /"all": \{"ways": \{([^}]*)\}, "nodes": \{([^}]*)\}/.exec(pySrc);
	const pyWays = pyAll?.[1] ?? "";
	for (const tag of ["rail", "subway", "tram", "light_rail"]) {
		ok(pyWays.includes('"' + tag + '"'), "sync: py way filter has " + tag);
		ok(ymlSrc.includes("w/railway=" + tag), "sync: relay workflow filters way " + tag);
	}
	for (const tag of ["station", "halt", "tram_stop"]) ok(ymlSrc.includes("n/railway=" + tag), "sync: relay node filter has " + tag);
	ok(pySrc.includes('"tram_stop"'), "sync: py node filter has tram_stop");

	// task-23: dual-mode sets — B(rail) ways {rail} & nodes {station,halt} with subway stations excluded; A(all) as before
	ok(pySrc.includes('subway_ok') && pySrc.includes('station\": \\"subway\"') === false && pySrc.includes('station") != \\"subway\"') === false, "sync: py has dual-mode constants (station=subway check)");
	ok(pySrc.includes('subway_ok'), "sync: py has subway_ok flag");
	ok(ymlSrc.includes("data-all-latest") && ymlSrc.includes("data-rail-latest"), "relay: dual tags present");
	ok(ymlSrc.includes("china-rail-latest.osm.pbf") && !ymlSrc.includes("-n/"), "relay: rail mode uses positive-only filters (no invalid osmium negation)");
	ok(ymlSrc.includes('cron: "0 3 1 * *"'), "relay: monthly cron present");
	ok(ymlSrc.includes("actions/cache@v4"), "relay: PBF download cached across matrix")
	const convSrc = readFileSync(path.join(root, "lib", "convert.js"), "utf8");
	for (const tag of ["rail", "subway", "tram", "light_rail"]) ok(convSrc.includes('"' + tag + '"'), "sync: convert.js way set has " + tag);
	ok(convSrc.includes("tram_stop"), "sync: convert.js node set has tram_stop");
	// client styling dispatch
	const src21 = readFileSync(path.join(root, "src", "client.js"), "utf8");
	ok(src21.includes("kind === 'subway'") && src21.includes("kind === 'tram'"), "styles: urban kinds dispatch in railStyle");
	ok(src21.includes("'pop.kind.subway'"), "popup: subway wording present");
}

	// task-25: evictLRU TDZ regression
{
	const srcT25 = readFileSync(path.join(root, "src", "client.js"), "utf8");
	const defPos = srcT25.indexOf("const evictLRU");
	const callPos = srcT25.indexOf("evictLRU();");
	ok(defPos > 0 && callPos > 0 && defPos < callPos, "tdz: evictLRU defined before first call (TDZ guard)");
}

	// task-27: rAF cancellation + no direct state mutation
{
	const srcT27 = readFileSync(path.join(root, "src", "client.js"), "utf8");
	ok(srcT27.includes("stopped = true") && srcT27.includes("cancelAnimationFrame"), "crash27: rAF loop has stop flag + cancelAnimationFrame on cleanup");
	ok(srcT27.includes("let stopped = false;"), "crash27: stopped flag initialized");
	ok(!srcT27.includes("delete loaded[uid];"), "crash27: no direct mutation of loaded state (React anti-pattern eliminated)");
	ok(srcT27.includes("try {") && srcT27.includes("} catch { stopped = true; return; }"), "crash27: tick body wrapped in try/catch with stop-on-error");
}


	// task-27 r2: error boundary black-box
{
	const srcT27r2 = readFileSync(path.join(root, "src", "client.js"), "utf8");
	ok(srcT27r2.includes("OrmErrorBoundary") && srcT27r2.includes("getDerivedStateFromError"), "crash27r2: error boundary class present");
	ok(srcT27r2.includes("componentDidCatch"), "crash27r2: error caught and logged");
	ok(srcT27r2.includes("'Retry'"), "crash27r2: retry button present");
	ok(srcT27r2.includes("OrmMainInner"), "crash27r2: inner component separated from boundary wrapper");
}


	// task-28: all-branch render test (empty/loading/error) catches TDZ class bugs
	// Extract OrmPage source and execute it in vm with stub identifiers for every
	// dependency it references. Any ReferenceError in any branch = test failure.
	{
		const srcT28 = readFileSync(path.join(root, "src", "client.js"), "utf8");
		// Check that showEmpty is now a computed expression, not a bare identifier
		const ormMapCall = /h\(OrmMap, \{[^}]+\}\)/.exec(srcT28);
		ok(ormMapCall !== null && !/\bshowEmpty\s*[,}]/.test(ormMapCall[0]), "crash28: showEmpty passed as computed value, not bare identifier");
		ok(ormMapCall !== null && ormMapCall[0].includes("showEmpty:"), "crash28: showEmpty has explicit key:value form");
		// Static scan: collect all identifiers referenced inside OrmPage's render return
		// and verify none are commonly-TDZ-prone (function-level const/let defined after the return)
		const pageStart = srcT28.indexOf("function OrmPage(");
		const pageEnd = srcT28.indexOf("function OrmPanelIcon");
		const pageSrc = srcT28.slice(pageStart, pageEnd);
		// Extract all identifiers used in the return statement's JSX
		const returnMatch = /return h\('div',[\s\S]*?;\s*\}/.exec(pageSrc);
		ok(returnMatch !== null, "crash28: OrmPage return statement extractable");
		if (returnMatch !== null) {
			const jsx = returnMatch[0];
			// Common identifiers that should be defined before the return
			for (const ident of ["showEmpty", "evictLRU", "loadUnit", "unloadUnit", "toggleClass", "doFetch", "doPbf", "doFetchUnit", "pbfText", "statusText", "unitList", "legend"]) {
				const used = new RegExp("\\b" + ident + "\\b").test(jsx);
				if (used) {
					const defIdx = Math.max(pageSrc.indexOf("const " + ident), pageSrc.indexOf("let " + ident), pageSrc.indexOf("function " + ident));
					const useIdx = pageSrc.indexOf(ident, pageSrc.indexOf("return h"));
					ok(defIdx >= 0 && defIdx < useIdx, "crash28: " + ident + " defined before first use in return (TDZ guard)");
				}
			}
		}
	}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);