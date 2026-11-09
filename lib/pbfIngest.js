/**
 * orm-china-viewer · PBF ingestion pipeline (03-research §7).
 * download (pbfSource) -> filter (pyosmium subprocess) -> convertOsm ->
 * shards + manifest via the existing store. Single unit "<unitId>"
 * (default cn-pbf) with mode "pbf"; fully compatible with the panel.
 */
import { spawn } from "node:child_process";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertOsm, bboxOf } from "./convert.js";

const FILTER_SCRIPT = fileURLToPath(new URL("../scripts/filter_railway.py", import.meta.url));

/**
 * @param {object} opts
 * @param {object} opts.config resolved plugin config (pbf section)
 * @param {object} opts.store store instance
 * @param {object} opts.pbfSource pbfSource instance
 * @param {(level: string, msg: string) => void} [opts.log]
 * @param {object} [opts.deps] injectables: {spawnImpl, makeTempDir}
 */
export function createPbfIngest(opts) {
	const { config, store, pbfSource } = opts;
	const log = opts.log ?? (() => {});
	const spawnImpl = opts.deps?.spawnImpl ?? ((cmd, args) => spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }));
	const makeTempDir = opts.deps?.makeTempDir ?? (() => mkdtempSync(path.join(tmpdir(), "orm-pbf-")));
	let running = false;
	let lastStatus = null;

	/** Report progress: stores snapshot and notifies the panel via cb. */
	function report(phase, extra = {}) {
		lastStatus = { ...pbfSource.status(), phase, ...extra };
		opts.onProgress?.(lastStatus);
		return lastStatus;
	}

	function status() {
		return lastStatus ?? { ...pbfSource.status(), phase: pbfSource.pbfPath() ? "ready" : "idle" };
	}

	/** Run one subprocess; resolves {code, stdout, stderr}. */
	function run(cmd, args) {
		return new Promise((resolve) => {
			const child = spawnImpl(cmd, args);
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (d) => { stdout += String(d); });
			child.stderr?.on("data", (d) => { stderr += String(d); });
			child.on("error", (error) => resolve({ code: -1, stdout, stderr: String(error.message) }));
			child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
		});
	}

	/** Ensure pyosmium importable; optionally pip-install it. */
	async function ensureOsmium() {
		const probe = await run(config.pbf.pythonPath, ["-c", "import osmium"]);
		if (probe.code === 0) return { ok: true };
		if (!config.pbf.autoInstallPyosmium) {
			return { ok: false, error: "pyosmium missing (autoInstall off): " + probe.stderr.slice(0, 160) };
		}
		const install = await run(config.pbf.pythonPath, ["-m", "pip", "install", "--no-input", "osmium"]);
		if (install.code !== 0) {
			return { ok: false, error: "pip install osmium failed: " + (install.stderr || install.stdout).slice(0, 200) };
		}
		const recheck = await run(config.pbf.pythonPath, ["-c", "import osmium"]);
		return recheck.code === 0 ? { ok: true } : { ok: false, error: "pyosmium still missing after install" };
	}

	/** Full pipeline. Serialized (single running flag). */
	async function runPipeline(opts = {}) {
		const urlOverride = typeof opts.urlOverride === "string" && opts.urlOverride.length > 0 ? opts.urlOverride : null;
		if (running) return { started: false, note: "pbf pipeline already running" };
		running = true;
		const unitId = config.pbf.unitId;
		try {
			// phase 1: download
			report("downloading");
			const result = await pbfSource.download((snap) => { report("downloading", snap); }, urlOverride ?? undefined);
			// phase 2: filter
			report("filtering");
			const osmiumCheck = await ensureOsmium();
			if (!osmiumCheck.ok) throw new Error(osmiumCheck.error);
			const workDir = makeTempDir();
			const osmJsonPath = path.join(workDir, "filtered.osm.json");
			const filterRun = await run(config.pbf.pythonPath, [FILTER_SCRIPT, "--in", result.path, "--out", osmJsonPath]);
			if (filterRun.code !== 0) throw new Error("filter_railway.py failed: " + (filterRun.stderr || filterRun.stdout).slice(0, 240));
			// phase 3+4: convert + store
			report("converting");
			const osm = JSON.parse(readFileSync(osmJsonPath, "utf8"));
			const converted = convertOsm(osm);
			const bytes = { rail: 0, station: 0 };
			const features = { rail: converted.rail.features.length, station: converted.station.features.length };
			if (features.rail > 0) bytes.rail = store.writeShard(unitId, "rail", converted.rail);
			if (features.station > 0) bytes.station = store.writeShard(unitId, "station", converted.station);
			const prior = store.readManifest()?.units.find((u) => u.id === unitId);
			store.upsertUnit({
				id: unitId,
				name: "中国全量 (PBF)",
				mode: "pbf",
				status: "done",
				bbox: bboxOf(converted.rail) ?? prior?.bbox ?? null,
				bytes,
				features,
				fetchedAt: new Date().toISOString(),
				error: null,
				attempts: (prior?.attempts ?? 0) + 1
			});
			rmSync(workDir, { recursive: true, force: true });
			report("done", { filterStats: filterRun.stdout.trim() });
			log("info", `orm-china-viewer: pbf pipeline done (${features.rail} rail / ${features.station} station)`);
			return { started: true, done: true, features };
		} catch (error) {
			report("failed", { error: String(error?.message ?? error) });
			log("warn", "orm-china-viewer: pbf pipeline failed: " + String(error?.message ?? error));
			return { started: true, done: false, error: String(error?.message ?? error) };
		} finally {
			running = false;
		}
	}

	return { status, runPipeline, isRunning: () => running, ensureOsmium };
}