/**
 * orm-china-viewer · agent tool registration (02-plan §4).
 * Structure copied from @local/rss-reader lib/hub.js:703-899:
 * ctx.tools.register({name, description, parameters, output:{schema,render},
 * timeoutMs, isConcurrencySafe, execute}).
 */

/** Human-friendly byte count. */
function fmtBytes(n) {
	if (!Number.isFinite(n) || n <= 0) return "0 B";
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KiB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function renderStatusMarkdown(value) {
	const s = value?.summary ?? {};
	const lines = [];
	lines.push("# orm-china-viewer data inventory");
	lines.push(`scope: ${s.scoped ? `${s.mode} mode` : "not scoped yet (run orm_fetch)"}`);
	if (s.scoped) {
		lines.push(`units: ${s.unitsDone}/${s.unitsTotal} done, ${s.unitsFailed} failed, ${s.unitsPending} pending`);
		lines.push(`features: ${s.features.rail} rail ways, ${s.features.station} stations`);
		lines.push(`size: ${fmtBytes(s.bytes)}; last fetch: ${s.lastFetchedAt ?? "never"}`);
	}
	if (s.counts !== null && s.counts !== undefined) {
		const c = s.counts;
		lines.push(`national counts (OSM China area): rail ${c.railWays ?? "?"} / subway ${c.subwayWays ?? "?"} / light_rail ${c.lightRailWays ?? "?"} / tram ${c.tramWays ?? "?"} / station nodes ${c.stationNodes ?? "?"}`);
	}
	const failed = (value?.units ?? []).filter((u) => u.status === "failed");
	if (failed.length > 0) {
		lines.push("", "failed units (retry with orm_fetch unit=<id>):");
		for (const u of failed.slice(0, 15)) lines.push(`- ${u.id} (${u.name}): ${String(u.error ?? "").slice(0, 120)}`);
	}
	return lines.join("\n");
}

/**
 * Register orm_status / orm_fetch / orm_reset on ctx.tools.
 * @param {object} ctx plugin context (tools service)
 * @param {object} h helpers: status(), fetch(unitId), reset(unitId)
 * @param {object} config plugin config (tool toggles + names)
 */
export function registerAgentTools(ctx, h, config, logger) {
	if (typeof ctx.tools?.register !== "function") {
		logger?.warn?.("orm-china-viewer: the tools service is unavailable; chat tools stay unregistered");
		return;
	}
	const disposers = [];

	if (config.statusTool !== false) {
		disposers.push(ctx.tools.register({
			name: config.statusToolName,
			description: "Report the offline China railway data inventory of orm-china-viewer: scope mode, per-unit download status, feature and byte totals, national OSM counts when available, and failed units. The Web panel shows the same data.",
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false
			},
			output: {
				schema: {
					type: "object",
					properties: { summary: { type: "object" }, units: { type: "array", items: {} }, pbf: { type: "object" } },
					required: ["summary", "units"],
					additionalProperties: false
				},
				render(_args, value) {
					return [{ type: "text", text: renderStatusMarkdown(value) }];
				}
			},
			timeoutMs: 30000,
			isConcurrencySafe() {
				return true;
			},
			execute() {
				return h.status();
			}
		}));
	}

	if (config.fetchTool !== false) {
		disposers.push(ctx.tools.register({
			name: config.fetchToolName,
			description: "Download China railway data into the local offline store. source=overpass (default): window-probed Overpass shard queue, unit=<id or province name> optional. source=pbf: direct PBF path — Range-resumable download of the national china-latest.osm.pbf mirror (~1.65 GiB), pyosmium railway filter, single whole-country unit; needs Python with pip on the Host. Follow progress with orm_status.",
			parameters: {
				type: "object",
				properties: {
					unit: { type: "string", description: "Optional unit id or province name; omit for every pending/failed unit (overpass source only)" },
					source: { type: "string", enum: ["overpass", "pbf"], description: "overpass (default) = shard queue; pbf = direct national PBF download + filter" }
				},
				additionalProperties: false
			},
			output: {
				schema: {
					type: "object",
					properties: { started: { type: "boolean" }, queued: { type: "array", items: { type: "string" } }, note: { type: "string" } },
					required: ["started", "queued", "note"],
					additionalProperties: false
				},
				render(_args, value) {
					const head = value.started ? `queued: ${value.queued.join(", ")}` : "nothing queued";
					return [{ type: "text", text: `${head}\n${value.note ?? ""}` }];
				}
			},
			timeoutMs: 60000,
			isConcurrencySafe() {
				return false;
			},
			async execute(args) {
				const unit = typeof args?.unit === "string" && args.unit.length > 0 ? args.unit : undefined;
				const source = args?.source === "pbf" ? "pbf" : "overpass";
				return h.fetch(source === "pbf" ? undefined : unit, source);
			}
		}));
	}

	if (config.resetTool !== false) {
		disposers.push(ctx.tools.register({
			name: config.resetToolName,
			description: "Drop downloaded data shards (local files) so they can be refetched. Omit unit to drop everything; pass unit=<id or province name> for one unit. Does not touch the plugin configuration.",
			parameters: {
				type: "object",
				properties: {
					unit: { type: "string", description: "Optional unit id or province name; omit for all units" }
				},
				additionalProperties: false
			},
			output: {
				schema: {
					type: "object",
					properties: { removed: { type: "array", items: { type: "string" } }, bytesFreed: { type: "number" } },
					required: ["removed", "bytesFreed"],
					additionalProperties: false
				},
				render(_args, value) {
					return [{ type: "text", text: `removed: ${value.removed.length > 0 ? value.removed.join(", ") : "(none)"} (freed ${fmtBytes(value.bytesFreed)})` }];
				}
			},
			timeoutMs: 30000,
			isConcurrencySafe() {
				return false;
			},
			execute(args) {
				const unit = typeof args?.unit === "string" && args.unit.length > 0 ? args.unit : undefined;
				return h.reset(unit);
			}
		}));
	}

	return () => {
		for (const dispose of disposers.splice(0)) {
			try {
				dispose();
			} catch {
				// dispose best-effort
			}
		}
	};
}