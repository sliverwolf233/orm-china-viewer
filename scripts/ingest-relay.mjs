/**
 * orm-china-viewer · relay ingestion driver (task-16).
 * Runs the REAL lib/pbfIngest pipeline against a pre-downloaded PBF:
 *   node scripts/ingest-relay.mjs <path-to-pbf>
 * - pbfSource is stubbed to "download = already at <path>" (the file came from
 *   the relay via gh-relay-fetch.mjs; A-path mirrors stay untouched);
 * - filter/convert/store are the production lib code paths;
 * - PYTHONPATH must point at the extracted pyosmium wheel (see .pylibs).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createStore } from "../lib/store.js";
import { createPbfIngest } from "../lib/pbfIngest.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pbfPath = path.resolve(process.argv[2]);
const stat = statSync(pbfPath);
const sha256 = createHash("sha256").update(readFileSync(pbfPath)).digest("hex");

const dataDir = path.resolve(root, "..", "orm-china-data");
const store = createStore({ dataDir });
const pbfStub = {
	dir: path.dirname(pbfPath), fileName: path.basename(pbfPath),
	partPath: "", finalPath: pbfPath, metaPath: "",
	status: () => ({ phase: "downloaded", url: "relay", fileName: path.basename(pbfPath), downloadedBytes: stat.size, totalBytes: stat.size }),
	pbfPath: () => pbfPath,
	download: async () => ({ done: true, path: pbfPath, bytes: stat.size }),
	readMeta: () => null
};
const ingest = createPbfIngest({
	config: {
		pbf: {
			pythonPath: process.env.ORM_PYTHON ?? "python",
			autoInstallPyosmium: false,
			unitId: "cn-pbf",
			chunkBytes: 8388608
		}
	},
	store, pbfSource: pbfStub,
	log: (level, msg) => console.error("[" + level + "] " + msg)
});
const result = await ingest.runPipeline();
console.log(JSON.stringify({ input: { path: pbfPath, bytes: stat.size, sha256 }, result }, null, 1));
process.exit(result.done ? 0 : 1);
