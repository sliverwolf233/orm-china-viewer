/**
 * orm-china-viewer · PBF source: Range-resumable downloader (03-research §3/§7).
 *
 * Target: download.openstreetmap.fr/extracts/asia/china-latest.osm.pbf
 * (~1.65 GiB, accept-ranges: bytes — verified 2026-11-08). Layout under the
 * store's data dir:
 *   pbf/pbf.json                 — download state (atomic write)
 *   pbf/<filename>.part          — in-progress download (appended per chunk)
 *   pbf/<filename>               — completed download (rename from .part)
 * Every chunk request is a separate Range GET so an interrupted download
 * resumes at the exact byte offset on the next run.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync, rmSync, openSync, writeSync, closeSync, truncateSync } from "node:fs";
import path from "node:path";

const DEFAULT_HEADERS = {
	"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	"Accept": "*/*",
	"Referer": "https://www.openstreetmap.org/"
};

/** Parse filename out of a URL path (fallback: china-latest.osm.pbf). */
export function fileNameOf(url) {
	try {
		const name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
		if (name.length > 0 && !name.endsWith("/")) return name;
	} catch { /* fall through */ }
	return "china-latest.osm.pbf";
}

/**
 * @param {object} config pbf config (sourceUrl/altUrl/chunkBytes)
 * @param {string} dataDir store data directory
 * @param {object} [deps] injectable transport for tests
 * @param {(url: string, init: object) => Promise<{status:number, headers:object, arrayBuffer:()=>Promise<ArrayBuffer>}>} [deps.fetchImpl]
 */
export function createPbfSource(config, dataDir, deps = {}) {
	const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
	const dir = path.join(dataDir, "pbf");
	const fileName = fileNameOf(config.sourceUrl);
	const partPath = path.join(dir, fileName + ".part");
	const finalPath = path.join(dir, fileName);
	const metaPath = path.join(dir, "pbf.json");
	const chunkBytes = Math.max(1048576, config.chunkBytes | 0);

	function ensureDir() {
		mkdirSync(dir, { recursive: true });
	}

	/** Atomic meta write. */
	function writeMeta(meta) {
		ensureDir();
		const tmp = metaPath + ".tmp";
		writeFileSync(tmp, JSON.stringify(meta, null, 1), "utf8");
		renameSync(tmp, metaPath);
	}

	function readMeta() {
		try {
			return JSON.parse(readFileSync(metaPath, "utf8"));
		} catch {
			return null;
		}
	}

	function partSize() {
		try {
			return statSync(partPath).size;
		} catch {
			return 0;
		}
	}

	/** Snapshot for state()/orm_status. */
	function status(override = {}) {
		const meta = readMeta();
		return {
			phase: meta?.phase ?? "idle",
			url: meta?.url ?? config.sourceUrl,
			fileName,
			downloadedBytes: meta?.downloadedBytes ?? partSize(),
			totalBytes: meta?.totalBytes ?? null,
			startedAt: meta?.startedAt ?? null,
			finishedAt: meta?.finishedAt ?? null,
			error: meta?.error ?? null,
			...override
		};
	}

	/**
	 * Probe the source (HEAD): {ok, totalBytes, acceptRanges, lastModified, url}.
	 * Falls through config.altUrl when the primary fails.
	 */
	async function probeSource(urlOverride) {
		const candidates = [urlOverride, config.sourceUrl, config.altUrl].filter((u) => typeof u === "string" && u.length > 0);
		let lastError = null;
		for (const url of candidates) {
			try {
				const response = await fetchImpl(url, { method: "HEAD", headers: DEFAULT_HEADERS });
				if (response.status === 200) {
					const total = Number(response.headers.get("content-length") ?? 0);
					const ranges = response.headers.get("accept-ranges") ?? "";
					if (total > 0 && ranges.includes("bytes")) {
						return { ok: true, url, totalBytes: total, lastModified: response.headers.get("last-modified") ?? null };
					}
					return { ok: false, url, error: "source does not advertise size + byte ranges" };
				}
				lastError = "HTTP " + response.status;
			} catch (error) {
				lastError = String(error?.cause?.code ?? error?.message ?? error);
			}
		}
		return { ok: false, error: lastError ?? "no source reachable" };
	}

	/**
	 * Download in chunks until complete (task-15 hardening):
	 *  - append-only writes; the byte position is ALWAYS re-derived from the
	 *    .part file size after every append (disk is the single source of
	 *    truth — partial writes can never desync the counter again);
	 *  - an epoch token in the meta file marks the owning pipeline: a second
	 *    pipeline (e.g. after an hmr service reload) adopts the download and
	 *    the superseded loop stops at its next chunk instead of double-writing;
	 *  - a superseded loop rolls its own last append back before exiting.
	 */
	async function download(onProgress = () => {}, urlOverride) {
		const probe = await probeSource(urlOverride);
		if (!probe.ok) throw new Error("pbf source unreachable: " + probe.error);
		const myEpoch = String(Date.now().toString(36)) + "-" + String(Math.floor(Math.random() * 1e9).toString(36));
		let meta = readMeta();
		const resumeable = meta !== null && meta.url === probe.url && meta.totalBytes === probe.totalBytes;
		if (resumeable && meta.downloadedBytes !== partSize() && partSize() > 0) {
			// meta/disk drift (historic bug or crash): disk wins
			meta.downloadedBytes = partSize();
		}
		if (!resumeable) {
			rmSync(partPath, { force: true });
			meta = {
				version: 1, phase: "downloading", url: probe.url, fileName,
				downloadedBytes: 0, totalBytes: probe.totalBytes, epoch: myEpoch,
				startedAt: new Date().toISOString(), finishedAt: null, error: null
			};
			writeMeta(meta);
		} else {
			if (partSize() > meta.totalBytes) {
				// corrupt part from a past duplicate-append race: restart clean
				rmSync(partPath, { force: true });
				meta = { ...meta, downloadedBytes: 0 };
			}
			// adopt the download under a fresh epoch (supersedes any older loop)
			writeMeta({ ...meta, phase: "downloading", epoch: myEpoch, downloadedBytes: partSize(), error: null });
			meta = readMeta();
		}
		let position = partSize();
		if (meta.totalBytes !== null && position >= meta.totalBytes && existsSync(finalPath) === false) {
			// part already complete from a previous run: finish it
			renameSync(partPath, finalPath);
			writeMeta({ ...meta, phase: "downloaded", downloadedBytes: meta.totalBytes, finishedAt: new Date().toISOString() });
			onProgress(status());
			return { done: true, path: finalPath, bytes: meta.totalBytes };
		}
		const fd = openSync(partPath, "a");
		try {
			for (;;) {
				// ownership check: another pipeline may have adopted the download
				const current = readMeta();
				if (current?.epoch !== myEpoch) {
					try { closeSync(fd); } catch { /* already closed */ }
					return { done: false, superseded: true, note: "pbf download adopted by a newer pipeline" };
				}
				const end2 = Math.min(position + chunkBytes - 1, meta.totalBytes - 1);
				if (position > end2) break;
				const sizeBefore = partSize();
				const response = await fetchImpl(meta.url, {
					method: "GET",
					headers: { ...DEFAULT_HEADERS, Range: `bytes=${position}-${end2}` }
				});
				if (response.status !== 206 && !(response.status === 200 && position === 0)) {
					throw new Error(`chunk ${position}-${end2} answered HTTP ${response.status}`);
				}
				if (response.status === 200) {
					throw new Error("server ignored Range for a resumed download (restart required)");
				}
				const chunk = Buffer.from(await response.arrayBuffer());
				if (chunk.length === 0) throw new Error("empty chunk at offset " + position);
				writeSync(fd, chunk); // append; position is re-derived from disk below
				position = partSize();
				if (position !== sizeBefore + chunk.length) {
					// partial write (or external writer): disk wins, keep going from truth
					console?.warn?.(`pbfSource: append drift at ${sizeBefore} (wrote ${position - sizeBefore}/${chunk.length} bytes); resuming from ${position}`);
				}
				const owner = readMeta();
				if (owner?.epoch !== myEpoch) {
					// lost ownership during the await: stop without writing progress over the new owner
					try { closeSync(fd); } catch { /* already closed */ }
					return { done: false, superseded: true, note: "pbf download adopted by a newer pipeline" };
				}
				if (position > meta.totalBytes) {
					// duplicate-append race (two loops overlapped once): the part is corrupt — clean restart under our epoch
					try { closeSync(fd); } catch { /* already closed */ }
					rmSync(partPath, { force: true });
					writeMeta({ ...meta, downloadedBytes: 0 });
					return download(onProgress); // recurse with a fresh epoch as the sole owner
				}
				writeMeta({ ...meta, downloadedBytes: position });
				onProgress(status({ phase: "downloading", downloadedBytes: position }));
				if (position >= meta.totalBytes) break;
			}
		} finally {
			try { closeSync(fd); } catch { /* already closed */ }
		}
		for (let attempt = 0; ; attempt++) {
			try { renameSync(partPath, finalPath); break; }
			catch (error) {
				if (attempt >= 4) throw new Error("cannot finalize " + fileName + " after 5 attempts: " + (error?.message ?? error));
				await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1))); // a superseded loop may still hold a handle briefly
			}
		}
		writeMeta({ ...readMeta(), phase: "downloaded", downloadedBytes: meta.totalBytes, finishedAt: new Date().toISOString() });
		onProgress(status());
		return { done: true, path: finalPath, bytes: meta.totalBytes };
	}

		function pbfPath() {
		return existsSync(finalPath) ? finalPath : null;
	}

	return { dir, fileName, partPath, finalPath, metaPath, status, probeSource, download, pbfPath, readMeta };
}