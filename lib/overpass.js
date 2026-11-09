/**
 * orm-china-viewer · Overpass fetch engine (02-plan §3.2).
 *
 * Network facts this engine encodes (01-research §1/§3.5):
 *  - GET only: the local middlebox 406s POST bodies to /api/interpreter.
 *  - Browser UA + Referer headers pass the filters; bare clients do not.
 *  - overpass-api.de flaps between blackhole and open windows: a cheap probe
 *    query gates every real query; 502/429/504 use exponential backoff.
 * All transport primitives are injectable so tests run without a network.
 */

const ENDPOINT = "https://overpass-api.de/api/interpreter";

/** Build the URL-encoded GET interpreter URL for one query. */
export function interpreterUrl(query, endpoint = ENDPOINT) {
	return `${endpoint}?data=${encodeURIComponent(query)}`;
}

/** The standard unit download query (02-plan §3.2 template). */
export function unitQuery(areaIdOrBbox, timeoutS = 300) {
	const areaFilter = Array.isArray(areaIdOrBbox)
		? `(${areaIdOrBbox.join(",")})`
		: `(area.a)`;
	const areaPrelude = Array.isArray(areaIdOrBbox)
		? ""
		: `area(${areaIdOrBbox})->.a;`;
	return `[out:json][timeout:${timeoutS}];
${areaPrelude}
(
  way["railway"="rail"]${areaFilter};
  node["railway"~"^(station|halt)$"]${areaFilter};
);
(._;>;);
out meta;`;
}

/** The cheap probe query used to detect an open window. */
export function probeQuery(areaId) {
	return `[out:json][timeout:10];area(${areaId});out ids;`;
}

/** Q1: national per-class counts (run once, cached in the manifest). */
export function countsQuery(areaId) {
	return `[out:json][timeout:300];
area(${areaId})->.a;
way["railway"="rail"](area.a)->.rail; .rail out count;
way["railway"="subway"](area.a)->.sub; .sub out count;
way["railway"="light_rail"](area.a)->.lr; .lr out count;
way["railway"="tram"](area.a)->.tram; .tram out count;
node["railway"="station"](area.a)->.st; .st out count;`;
}

/** Q2: province-level administrative relations inside the China area. */
export function provincesQuery(areaId) {
	return `[out:json][timeout:120];
area(${areaId})->.a;
relation["boundary"="administrative"]["admin_level"="4"](area.a);
out tags;`;
}

/**
 * @param {object} config resolved fetch config (02-plan §6 keys)
 * @param {object} [deps] injectable transport for tests
 * @param {(url: string, init: object) => Promise<Response>} [deps.fetchImpl]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => number} [deps.now]
 */
export function createEngine(config, deps = {}) {
	const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
	const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const now = deps.now ?? (() => Date.now());
	const headers = {
		"User-Agent": config.userAgent,
		"Referer": config.referer,
		"Accept": "*/*"
	};

	/** One GET; returns {status, text}; never throws (network errors -> {status:0}). */
	async function rawGet(query, clientTimeoutMs) {
		try {
			const response = await fetchImpl(interpreterUrl(query), {
				headers,
				signal: AbortSignal.timeout(clientTimeoutMs)
			});
			const text = await response.text();
			return { status: response.status, text };
		} catch (error) {
			return { status: 0, text: String(error?.cause?.code ?? error?.message ?? error) };
		}
	}

	/**
	 * Run one query with retries on 429/502/504/network. Returns parsed JSON.
	 * Throws Error('orm/overpass-unreachable') after exhausting attempts, or
	 * Error('orm/overpass-error') for hard HTTP failures.
	 */
	async function run(query, { clientTimeoutMs, label } = {}) {
		const timeout = clientTimeoutMs ?? config.clientTimeoutMs;
		let last = null;
		for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
			if (attempt > 0) await sleep(config.backoffMs * 2 ** (attempt - 1));
			const res = await rawGet(query, timeout);
			if (res.status === 200) {
				if (res.text.length > config.maxBytes) throw new Error(`response exceeds maxBytes (${res.text.length} > ${config.maxBytes}) for ${label ?? "query"}`);
				let parsed;
				try {
					parsed = JSON.parse(res.text);
				} catch {
					throw new Error(`invalid JSON from Overpass for ${label ?? "query"}`);
				}
				// task-17: Overpass signals degraded results (server timeout/cancellation
				// after partial output) with HTTP 200 + a "remark" field. An empty
				// elements array WITH a remark is a fake-empty — never treat it as
				// success, or units get marked done with zero features (11-relay-run).
				const remark = typeof parsed?.remark === "string" ? parsed.remark : null;
				if (remark !== null && (!Array.isArray(parsed.elements) || parsed.elements.length === 0)) {
					throw new Error(`overpass degraded (remark): ${remark.slice(0, 120)}`);
				}
				return parsed;
			}
			last = res;
			const retryable = res.status === 0 || res.status === 429 || res.status === 502 || res.status === 504;
			if (!retryable) throw new Error(`Overpass HTTP ${res.status} for ${label ?? "query"}: ${res.text.slice(0, 160)}`);
		}
		throw new Error(`Overpass unreachable after ${config.maxRetries + 1} attempts (last: ${last?.status ?? 0}) — network window closed?`);
	}

	/**
	 * Probe for an open window (cheap Q, short timeout, spaced retries).
	 * Returns true/false instead of throwing.
	 */
	async function probe(areaId) {
		for (let attempt = 0; attempt < config.probeAttempts; attempt++) {
			if (attempt > 0) await sleep(config.probeGapMs);
			const res = await rawGet(probeQuery(areaId), 9000);
			if (res.status === 200) return true;
		}
		return false;
	}

	return { run, probe, rawGet, headers, ENDPOINT };
}