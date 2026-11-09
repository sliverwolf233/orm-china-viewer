/**
 * orm-china-viewer · Overpass OSM JSON -> GeoJSON converter (pure functions).
 *
 * Scope (02-plan §3.4): ways tagged railway=rail become LineStrings; nodes
 * tagged railway=station|halt become Points. Missing node coordinates are
 * skipped; ways left with fewer than 2 coordinates are dropped. Everything
 * else in the response is ignored. No IO here — test with fixtures only.
 */

/**
 * Convert one Overpass JSON payload into per-class FeatureCollections.
 * @param {object} osmJson parsed Overpass response ({elements: []})
 * @returns {{rail: object, station: object}} two FeatureCollections
 */
/** Way railway values kept (sync: filter_railway.py + relay workflow + here). */
export const KEEP_WAY_RAILWAYS = new Set(["rail", "subway", "tram", "light_rail"]);
/** Node railway values kept. */
export const KEEP_NODE_RAILWAYS = new Set(["station", "halt", "tram_stop"]);

export function convertOsm(osmJson) {
	const elements = Array.isArray(osmJson?.elements) ? osmJson.elements : [];
	const nodes = new Map();
	const stationFeatures = [];
	for (const el of elements) {
		if (el?.type !== "node") continue;
		if (typeof el.lon !== "number" || typeof el.lat !== "number") continue;
		nodes.set(el.id, el);
		const railway = el.tags?.railway;
		if (KEEP_NODE_RAILWAYS.has(railway)) {
			stationFeatures.push({
				type: "Feature",
				geometry: { type: "Point", coordinates: [el.lon, el.lat] },
				properties: { ...(el.tags ?? {}) }
			});
		}
	}
	const railFeatures = [];
	for (const el of elements) {
		if (el?.type !== "way" || !KEEP_WAY_RAILWAYS.has(el.tags?.railway)) continue;
		const coordinates = [];
		for (const id of Array.isArray(el.nodes) ? el.nodes : []) {
			const node = nodes.get(id);
			if (node !== undefined) coordinates.push([node.lon, node.lat]);
		}
		if (coordinates.length < 2) continue;
		railFeatures.push({
			type: "Feature",
			geometry: { type: "LineString", coordinates },
			properties: { ...(el.tags ?? {}) }
		});
	}
	return {
		rail: { type: "FeatureCollection", features: railFeatures },
		station: { type: "FeatureCollection", features: stationFeatures }
	};
}

/**
 * Bounding box [w, s, e, n] of a FeatureCollection (null when empty).
 * @param {object} fc FeatureCollection
 * @returns {number[]|null}
 */
export function bboxOf(fc) {
	let w = Infinity;
	let s = Infinity;
	let e = -Infinity;
	let n = -Infinity;
	for (const f of fc?.features ?? []) {
		const g = f.geometry;
		if (!g) continue;
		const rings = g.type === "Point" ? [g.coordinates] : g.type === "LineString" ? [g.coordinates] : Array.isArray(g.coordinates) ? g.coordinates : [];
		for (const ring of rings) {
			if (!Array.isArray(ring)) continue;
			if (typeof ring[0] === "number" && typeof ring[1] === "number") {
				w = Math.min(w, ring[0]);
				s = Math.min(s, ring[1]);
				e = Math.max(e, ring[0]);
				n = Math.max(n, ring[1]);
			} else {
				for (const point of ring) {
					if (Array.isArray(point) && typeof point[0] === "number" && typeof point[1] === "number") {
						w = Math.min(w, point[0]);
						s = Math.min(s, point[1]);
						e = Math.max(e, point[0]);
						n = Math.max(n, point[1]);
					}
				}
			}
		}
	}
	return w === Infinity ? null : [w, s, e, n];
}

/**
 * Grid cells covering a bbox (grid fallback scope, 02-plan §3.1).
 * @param {number[]} bbox [w, s, e, n]
 * @param {number} sizeDeg cell edge in degrees
 * @returns {{id: string, bbox: number[]}[]}
 */
export function gridCells(bbox, sizeDeg) {
	const [w, s, e, n] = bbox;
	const size = Math.max(0.5, Number(sizeDeg) || 2);
	const cells = [];
	for (let lon = Math.floor(w / size) * size; lon < e; lon += size) {
		for (let lat = Math.floor(s / size) * size; lat < n; lat += size) {
			const lon0 = Math.round(lon * 100) / 100;
			const lat0 = Math.round(lat * 100) / 100;
			cells.push({
				id: `g${String(lon0).replace(".", "").replace("-", "m")}-${String(lat0).replace(".", "").replace("-", "m")}`,
				bbox: [lon0, lat0, Math.round((lon + size) * 100) / 100, Math.round((lat + size) * 100) / 100]
			});
		}
	}
	return cells;
}
/**
 * Slim one GeoJSON feature for lightweight layers (task-20): keep only the
 * whitelisted properties and round coordinates to `precision` decimals
 * (5 decimals ≈ 1.1 m — far below map precision at these zooms).
 * @param {object} feature GeoJSON feature
 * @param {string[]} keepProps property whitelist
 * @param {number} precision coordinate decimals
 * @returns {object} slimmed shallow-copied feature (input untouched)
 */
export function slimFeature(feature, keepProps, precision = 5) {
	const props = {};
	for (const k of keepProps) {
		if (feature?.properties && feature.properties[k] !== undefined && feature.properties[k] !== null) props[k] = feature.properties[k];
	}
	const r = (v) => (typeof v === "number" ? Number(v.toFixed(precision)) : v);
	let geometry = feature.geometry;
	if (geometry?.type === "LineString") {
		geometry = { type: "LineString", coordinates: geometry.coordinates.map((p) => p.map(r)) };
	} else if (geometry?.type === "Point") {
		geometry = { type: "Point", coordinates: geometry.coordinates.map(r) };
	}
	return { type: "Feature", geometry, properties: props };
}