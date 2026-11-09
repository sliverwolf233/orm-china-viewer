#!/usr/bin/env node
/**
 * orm-china-viewer · fetch the railway extract from the GitHub relay (B-path).
 * Standalone CLI (also the reference for the Host-side relay resolver):
 *   node scripts/gh-relay-fetch.mjs --repo sliverwolf233/orm-china-relay \
 *        --out ../../orm-china-data/pbf/china-rail-latest.osm.pbf
 * - Resolves the rolling release tag via api.github.com (reachable on this
 *   machine; raw github.com is not — 01-research §1).
 * - Range-resumable download (server: GitHub's S3 assets).
 * - Verifies against the release's <asset>.sha256 companion when present.
 * - --token / GH_TOKEN env adds Authorization (private repos); public works
 *   anonymously within API rate limits.
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdirSync, renameSync, writeFile } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const UA = "orm-china-viewer-relay-fetch";
const args = process.argv.slice(2);
function arg(name, fallback = undefined) {
	const i = args.indexOf("--" + name);
	if (i >= 0 && i + 1 < args.length) return args[i + 1];
	return fallback;
}
const mode = arg("mode", "all");
const repo = arg("repo", "sliverwolf233/orm-china-relay");
const tag = arg("tag", mode === "rail" ? "data-rail-latest" : "data-all-latest");
const assetName = arg("asset", mode === "rail" ? "china-rail-latest.osm.pbf" : "china-all-latest.osm.pbf");
const outPath = path.resolve(arg("out", "china-rail-latest.osm.pbf"));
const token = arg("token") ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
const apiHeaders = { "User-Agent": UA, Accept: "application/vnd.github+json", ...(token ? { Authorization: "Bearer " + token } : {}) };

async function getJson(url) {
	const r = await fetch(url, { headers: apiHeaders });
	if (r.status !== 200) throw new Error("GET " + url + " -> HTTP " + r.status);
	return JSON.parse(await r.text());
}

async function main() {
	const release = await getJson(`https://api.github.com/repos/${repo}/releases/tags/${tag}`);
	const asset = (release.assets ?? []).find((a) => a.name === assetName);
	if (asset === undefined) throw new Error(`asset ${assetName} not found on ${repo}@${tag} (assets: ${(release.assets ?? []).map((a) => a.name).join(", ") || "none"})`);
	let shaExpected = null;
	const shaAsset = (release.assets ?? []).find((a) => a.name === assetName + ".sha256");
	if (shaAsset !== undefined) {
		const r = await fetch(shaAsset.url, { headers: { ...apiHeaders, Accept: "application/octet-stream" } });
		if (r.status === 200) shaExpected = (await r.text()).trim().split(/\s+/)[0];
	}
	mkdirSync(path.dirname(outPath), { recursive: true });
	const part = outPath + ".part";
	let pos = existsSync(part) ? statSync(part).size : 0;
	let total = asset.size ?? null;
	// resume loop via the asset API endpoint (works anonymous for public repos)
	for (;;) {
		const headers = { "User-Agent": UA, Accept: "application/octet-stream", ...(token ? { Authorization: "Bearer " + token } : {}) };
		if (pos > 0) headers.Range = `bytes=${pos}-`;
		const r = await fetch(asset.url, { headers });
		if (pos > 0 && r.status !== 206) throw new Error("resume failed: HTTP " + r.status + " for bytes=" + pos + "-");
		if (total === null) total = Number(r.headers.get("content-length") ?? 0) + pos;
		const nodeStream = Readable.fromWeb(r.body);
		await pipeline(nodeStream, createWriteStream(part, { flags: pos > 0 ? "a" : "w" }));
		pos = statSync(part).size;
		process.stderr.write(`fetched ${Math.round(pos / 1048576)} MB${total ? " / " + Math.round(total / 1048576) + " MB" : ""}\n`);
		if (total && pos >= total) break;
		if (!r.headers.get("content-range") && pos === Number(r.headers.get("content-length") ?? 0)) break;
		if (!total) break;
	}
	if (shaExpected !== null) {
		const buf = readFileSync(part);
		const sha = createHash("sha256").update(buf).digest("hex");
		if (sha !== shaExpected) throw new Error(`sha256 mismatch: expected ${shaExpected}, got ${sha}`);
		process.stderr.write("sha256 OK\n");
	}
	renameSync(part, outPath);
	process.stderr.write(`written ${outPath} (${statSync(outPath).size} bytes)\n`);
}

main().catch((error) => {
	console.error("gh-relay-fetch: " + (error?.message ?? error));
	process.exit(1);
});