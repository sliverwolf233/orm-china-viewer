/**
 * orm-china-viewer · local shard store.
 *
 * Data lives in <package-parent>/orm-china-data/ (mirrors @local/rss-reader's
 * "../../.rss-reader-data.json" placement, rss-reader/lib/hub.js:205):
 *   manifest.json                     — scope + per-unit status (atomic write)
 *   units/<unitId>.rail.geojson       — railway=rail LineStrings
 *   units/<unitId>.station.geojson    — station/halt Points
 * Every write goes .tmp -> rename so a killed fetch never leaves a torn file.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DEFAULT_DIR = fileURLToPath(new URL("../../orm-china-data/", import.meta.url));

/** Resolve the data directory (config override wins). */
export function resolveDataDir(override) {
	if (typeof override === "string" && override.trim().length > 0) return path.resolve(override.trim());
	return DEFAULT_DIR;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dataDir] override for the data directory
 * @param {(level: string, msg: string) => void} [opts.log]
 */
export function createStore(opts = {}) {
	const dir = resolveDataDir(opts.dataDir);
	const unitsDir = path.join(dir, "units");
	const manifestPath = path.join(dir, "manifest.json");
	const log = opts.log ?? (() => {});
	mkdirSync(unitsDir, { recursive: true }); // eager: the store is created once at plugin start

	function ensureDirs() {
		mkdirSync(unitsDir, { recursive: true });
	}

	/** Atomic text write: temp file + rename. */
	function atomicWrite(file, text) {
		const tmp = file + ".tmp";
		writeFileSync(tmp, text, "utf8");
		renameSync(tmp, file);
	}

	/** Read the manifest (or null when absent/corrupt). */
	let lastGoodManifest = null; // survives transient mid-rename read failures (task-18)

	function readManifest() {
		// Windows rename-over-open races can make one read fail transiently while
		// another process writes; retry briefly, then fall back to the last good
		// snapshot instead of reporting "no manifest" (which wiped the panel list).
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
				if (parsed !== null && typeof parsed === "object") lastGoodManifest = parsed;
				return parsed;
			} catch (error) {
				if (attempt === 2) break;
				const backoff = 15 * (attempt + 1);
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoff); // sync sleep
			}
		}
		return lastGoodManifest;
	}

	/** Whole-manifest replace (atomic). */
	function writeManifest(manifest) {
		ensureDirs();
		atomicWrite(manifestPath, JSON.stringify(manifest, null, 1));
		lastGoodManifest = manifest;
	}

	/** Init or reuse the manifest for one scope mode. */
	function ensureManifest(scope) {
		let manifest = readManifest();
		if (manifest === null || manifest.version !== 1 || manifest.scope?.mode !== scope.mode) {
			manifest = { version: 1, scope, counts: null, units: [] };
			writeManifest(manifest);
		}
		return manifest;
	}

	/** Upsert one unit row (by id) and persist. Returns the fresh manifest. */
	function upsertUnit(unit) {
		const manifest = readManifest() ?? { version: 1, scope: { mode: "unknown" }, counts: null, units: [] };
		const row = {
			id: String(unit.id),
			name: String(unit.name ?? unit.id),
			mode: String(unit.mode ?? "area"),
			status: String(unit.status ?? "pending"),
			bbox: Array.isArray(unit.bbox) ? unit.bbox : null,
			bytes: unit.bytes ?? { rail: 0, station: 0 },
			features: unit.features ?? { rail: 0, station: 0 },
			fetchedAt: unit.fetchedAt ?? null,
			error: unit.error ?? null,
			attempts: Number.isFinite(unit.attempts) ? unit.attempts : 0
		};
		const idx = manifest.units.findIndex((u) => u.id === row.id);
		if (idx >= 0) manifest.units[idx] = row;
		else manifest.units.push(row);
		writeManifest(manifest);
		return manifest;
	}

	function shardPath(unitId, klass) {
		return path.join(unitsDir, `${unitId}.${klass}.geojson`);
	}

	/** Read one shard (parsed FeatureCollection) or null. */
	function readShard(unitId, klass) {
		const file = shardPath(unitId, klass);
		if (!existsSync(file)) return null;
		try {
			return JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			log("warn", `shard unreadable: ${file} (${error.message})`);
			return null;
		}
	}

	/** Write one shard (atomic) and record its byte size. Returns bytes written. */
	function writeShard(unitId, klass, featureCollection) {
		ensureDirs();
		const file = shardPath(unitId, klass);
		atomicWrite(file, JSON.stringify(featureCollection));
		return statSync(file).size;
	}

	/**
	 * Discriminated shard lookup for the Remote layer() (panel graceful states):
	 *  - {status:"ok", geojson}               file present
	 *  - {status:"empty"}                     unit done, 0 features of that class (no file by design)
	 *  - {status:"not-fetched"}               unit exists but not fetched yet
	 *  - {status:"unknown-unit"}              no such unit id in the manifest
	 */
	function readShardFor(unitId, klass) {
		const unit = (readManifest()?.units ?? []).find((u) => u.id === unitId);
		if (unit === undefined) return { status: "unknown-unit" };
		if (unit.status !== "done") return { status: "not-fetched", unit };
		if ((unit.features?.[klass] ?? 0) === 0) return { status: "empty", unit };
		const shard = readShard(unitId, klass);
		if (shard === null) return { status: "missing-file", unit };
		return { status: "ok", geojson: shard };
	}

	/** Drop one unit's shards + manifest row. Returns bytes freed. */
	function removeUnit(unitId) {
		let freed = 0;
		for (const klass of ["rail", "station"]) {
			const file = shardPath(unitId, klass);
			if (existsSync(file)) {
				freed += statSync(file).size;
				rmSync(file, { force: true });
			}
		}
		const manifest = readManifest();
		if (manifest !== null) {
			manifest.units = manifest.units.filter((u) => u.id !== unitId);
			writeManifest(manifest);
		}
		return freed;
	}

	/** Aggregate summary for state()/tools. */
	function summary() {
		const manifest = readManifest();
		if (manifest === null) {
			return { scoped: false, mode: null, unitsTotal: 0, unitsDone: 0, unitsFailed: 0, unitsPending: 0, features: { rail: 0, station: 0 }, bytes: 0, lastFetchedAt: null, counts: null };
		}
		let bytes = 0;
		let features = { rail: 0, station: 0 };
		let lastFetchedAt = null;
		let unitsDone = 0;
		let unitsFailed = 0;
		for (const u of manifest.units) {
			if (u.status === "done") {
				unitsDone += 1;
				bytes += (u.bytes?.rail ?? 0) + (u.bytes?.station ?? 0);
				features.rail += u.features?.rail ?? 0;
				features.station += u.features?.station ?? 0;
				if (u.fetchedAt !== null && (lastFetchedAt === null || u.fetchedAt > lastFetchedAt)) lastFetchedAt = u.fetchedAt;
			} else if (u.status === "failed") unitsFailed += 1;
		}
		return {
			scoped: true,
			mode: manifest.scope?.mode ?? null,
			unitsTotal: manifest.units.length,
			unitsDone,
			unitsFailed,
			unitsPending: manifest.units.length - unitsDone - unitsFailed,
			features,
			bytes,
			lastFetchedAt,
			counts: manifest.counts ?? null
		};
	}

	return { dir, unitsDir, manifestPath, ensureManifest, readManifest, writeManifest, upsertUnit, readShard, readShardFor, writeShard, removeUnit, summary };
}