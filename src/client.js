/**
 * @local/orm-china-viewer — client source (edit this, then rebuild client.js).
 *
 * Browser half: mounts the Host "orm" Remote namespace and registers the
 * offline China railway panel (sidebar icon + main panel). Leaflet comes
 * from the bundle prefix (window.L, set by build-client.mjs part 1); its CSS
 * arrives as window.__ORM_LEAFLET_CSS__ (part 2). All data flows through
 * ctx.remote.orm — the browser performs zero network requests of its own.
 * Structure follows @local/rss-reader client.js (mount/apply/dispose).
 */
window.__ModuleLoader__.load({
	id: '@local/orm-china-viewer',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const { useState, useEffect, useRef, useCallback } = React;
		const h = React.createElement;

		const PACKAGE = '@local/orm-china-viewer';
		const NS = 'orm.panel';
		const PANEL_ID = 'orm';

		// [theme-pure-start] (test/run.mjs extracts this block: palettes + contrast math)
		const PALETTES = {
			dark: {
				bg: '#111418', surface: '#171d23', border: '#232a31',
				text: '#d7dde3', textDim: '#9fb0bd', textFaint: '#7d8f9c',
				btnBg: '#1d2730', btnBorder: '#2c3944', btnText: '#d7dde3', accent: '#4d6bfe', accentText: '#9db4ff',
				mapBg: '#111418', attribBg: '#111418', attribText: '#9fb0bd', err: '#e2a2a8',
				unitCard: '#171d23', unitDone: '#2f5d3a'
			},
			light: {
				bg: '#f2f4f7', surface: '#ffffff', border: '#d5dde3',
				text: '#1f2733', textDim: '#4a5b6a', textFaint: '#66788a',
				btnBg: '#ffffff', btnBorder: '#b9c6d0', btnText: '#1f2733', accent: '#3b5bdb', accentText: '#2b4ecc',
				mapBg: '#e9edf1', attribBg: '#f7f9fb', attribText: '#5a6b7a', err: '#b3261e',
				unitCard: '#ffffff', unitDone: '#3e7a4e'
			}
		};
		const THEME_KEYS = Object.keys(PALETTES.dark);
		function relLuma(hex) {
			const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
			if (m === null) return null;
			const n = parseInt(m[1], 16);
			const chan = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
			return 0.2126 * chan((n >> 16) & 255) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255);
		}
		function contrastRatio(a, b) {
			const la = relLuma(a); const lb = relLuma(b);
			if (la === null || lb === null) return null;
			const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
			return (hi + 0.05) / (lo + 0.05);
		}
		function isDarkColor(color) {
			const l = relLuma(color);
			return l === null ? true : l < 0.35;
		}
		function normColor(raw) {
			const s = String(raw ?? '').trim();
			if (s === '') return '';
			const rgb = /^rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/i.exec(s);
			if (rgb !== null) {
				const hex = (n) => Number(n).toString(16).padStart(2, '0');
				return '#' + hex(rgb[1]) + hex(rgb[2]) + hex(rgb[3]);
			}
			return s;
		}
		function themeVars(theme) {
			const p = PALETTES[theme] ?? PALETTES.dark;
			return THEME_KEYS.map((k) => `--orm-${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}:${p[k]}`).join(';') + ';';
		}
		// [theme-pure-end]

		// ---------- Remote descriptors (must mirror index.js marker table 1:1) ----------

		const anyCodec = { mode: 'strict', typeSymbol: 'orm/any', create: () => undefined };
		function methodDescriptor(method, params) {
			return {
				id: PACKAGE + '#orm/' + method,
				service: 'ormChinaViewer',
				namespace: 'orm',
				method,
				invocation: { kind: 'direct' },
				parameters: params.map((name) => ({ name, wire: name, source: 'json', codec: anyCodec })),
				result: anyCodec
			};
		}
		const ORM_REMOTE = {
			package: PACKAGE,
			descriptors: [
				methodDescriptor('state', []),
				methodDescriptor('layer', ['request']),
				methodDescriptor('fetchNow', ['request']),
				{
					id: PACKAGE + '#orm/follow',
					service: 'ormChinaViewer',
					namespace: 'orm',
					method: 'follow',
					mode: 'stream',
					invocation: { kind: 'direct' },
					parameters: [],
					cancellation: { parameter: 'signal' },
					result: anyCodec
				}
			]
		};

		// ---------- styles (colors are our own; tag semantics reference ORM legends) ----------

		const RAIL_STYLES = [
			{ key: 'subway', label: '地铁 subway', color: '#9d7bea', weight: 1.8, dash: null },
			{ key: 'light_rail', label: '轻轨 light_rail', color: '#4dd0e1', weight: 1.5, dash: null },
			{ key: 'tram', label: '有轨电车 tram', color: '#ffb74d', weight: 1, dash: '4 3' },
			{ key: 'main', label: '干线 usage=main', color: '#ff8a65', weight: 2, dash: null },
			{ key: 'branch', label: '支线/未标注 usage', color: '#ffd54f', weight: 1.5, dash: null },
			{ key: 'industrial', label: '工业/测试/场线', color: '#90a4ae', weight: 1, dash: null },
			{ key: 'disused', label: '废弃/拆除', color: '#616161', weight: 1, dash: '2 5' },
			{ key: 'proposed', label: '规划', color: '#7986cb', weight: 1, dash: '1 6' },
			{ key: 'construction', label: '在建', color: '#4db6ac', weight: 1.5, dash: '6 4' }
		];
		function railStyle(tags) {
			const kind = tags?.railway;
			if (kind === 'subway') return RAIL_STYLES.find((s) => s.key === 'subway');
			if (kind === 'light_rail') return RAIL_STYLES.find((s) => s.key === 'light_rail');
			if (kind === 'tram') return RAIL_STYLES.find((s) => s.key === 'tram');
			const usage = tags?.usage;
			if (tags?.railway !== 'rail') return RAIL_STYLES[1];
			if (tags?.disused === 'yes' || tags?.abandoned === 'yes' || tags?.razed === 'yes') return RAIL_STYLES[3];
			if (tags?.proposed === 'yes') return RAIL_STYLES[4];
			if (tags?.construction === 'yes') return RAIL_STYLES[5];
			if (usage === 'main') return RAIL_STYLES[0];
			if (usage === 'industrial' || usage === 'test' || usage === 'service' || usage === 'yard') return RAIL_STYLES[2];
			return RAIL_STYLES[1];
		}
		function tunnelAlpha(style, tags) {
			if (tags?.tunnel !== undefined && tags?.tunnel !== 'no') return { ...style, opacity: 0.55 };
			return style;
		}

		// ---------- locale ----------

		const DICT_ZH = {
			'panel': '中国铁路地图',
			'title': '中国铁路 · 离线预览',
			'status.idle': '数据未就绪',
			'status.units': '{done}/{total} 单元完成 · {failed} 失败 · {rail} 段线路 / {station} 站',
			'status.empty': '尚无数据：点击「拉取数据」经 Overpass 下载中国铁路分片（需网络窗口；下载后面板完全离线）',
			'action.fetch': '拉取数据',
			'action.fetching': '下载中…',
			'action.retryUnit': '重试',
			'action.loadUnit': '加载',
			'action.removeUnit': '移除',
			'legend.title': '图例',
			'layer.rail': '线路',
			'layer.station': '车站',
			'units.title': '数据单元（省 / 网格）',
			'units.loaded': '已载入',
			'units.none': '（无单元）',
			'attribution': '© OpenStreetMap contributors (ODbL)',
			'err.layer': '分片读取失败',
			'err.state': '状态读取失败',
			'unit.empty': '该单元无铁路要素',
			'map.empty': '地图画布 · 暂无已加载数据图层',
					'pop.kind': '类型',
			'pop.kind.subway': '地铁',
			'pop.kind.light_rail': '轻轨',
			'pop.kind.tram': '有轨电车',
			'pop.usage': '用途',
			'pop.usage.main': '干线',
			'pop.usage.branch': '支线',
			'pop.usage.industrial': '工业/测试线',
			'pop.usage.service': '场内/服务线',
			'pop.maxspeed': '限速',
			'pop.gauge': '轨距',
			'pop.electrified': '电气化',
			'pop.operator': '运营者',
			'pop.ref': '编号',
			'pop.enName': '英文名',
			'pop.rail': '铁路线',
			'pop.unnamed': '（未命名）',
			'pop.allTags': '全部标签',
			'pop.noTags': '（无标签）',
			'unit.missing': '数据未下载（先拉取数据）',
			'action.pbf': 'PBF 直下',
			'pbf.downloading': 'PBF 下载中 {pct}%（{got}/{total} MB）',
			'pbf.filtering': 'PBF 过滤中…',
			'pbf.converting': 'PBF 转换入库中…',
			'pbf.failed': 'PBF 管线失败：{err}',
			'mode.area': '范围模式：按省分片',
			'mode.grid': '范围模式：2° 网格分片'
		};
		const DICT_EN = {
			'panel': 'China Railway Map',
			'title': 'China Railway · offline viewer',
			'status.idle': 'data not ready',
			'status.units': '{done}/{total} units done · {failed} failed · {rail} ways / {station} stations',
			'status.empty': 'No data yet: press Fetch to download China railway shards via Overpass (needs a network window; the panel is fully offline afterwards)',
			'action.fetch': 'Fetch data',
			'action.fetching': 'Fetching…',
			'action.retryUnit': 'Retry',
			'action.loadUnit': 'Load',
			'action.removeUnit': 'Remove',
			'legend.title': 'Legend',
			'layer.rail': 'Tracks',
			'layer.station': 'Stations',
			'units.title': 'Data units (provinces / grid)',
			'units.loaded': 'loaded',
			'units.none': '(no units)',
			'attribution': '© OpenStreetMap contributors (ODbL)',
			'err.layer': 'failed to read shard',
			'err.state': 'failed to read state',
			'unit.empty': 'no railway features in this unit',
			'map.empty': 'map canvas · no data layers loaded yet',
					'pop.kind': 'Type',
			'pop.kind.subway': 'Subway',
			'pop.kind.light_rail': 'Light rail',
			'pop.kind.tram': 'Tram',
			'pop.usage': 'Usage',
			'pop.usage.main': 'Trunk line',
		'pop.usage.branch': 'Branch',
			'pop.usage.industrial': 'Industrial/test',
			'pop.usage.service': 'Service/yard',
			'pop.maxspeed': 'Max speed',
			'pop.gauge': 'Gauge',
			'pop.electrified': 'Electrified',
			'pop.operator': 'Operator',
			'pop.ref': 'Ref',
			'pop.enName': 'English name',
			'pop.rail': 'Railway line',
			'pop.unnamed': '(unnamed)',
			'pop.allTags': 'All tags',
			'pop.noTags': '(no tags)',
			'unit.missing': 'data not downloaded yet (fetch first)',
			'action.pbf': 'PBF direct',
			'pbf.downloading': 'PBF downloading {pct}% ({got}/{total} MB)',
			'pbf.filtering': 'PBF filtering…',
			'pbf.converting': 'PBF converting…',
			'pbf.failed': 'PBF pipeline failed: {err}',
			'mode.area': 'scope: per-province shards',
			'mode.grid': 'scope: 2° grid shards'
		};

		// ---------- CSS ----------

		const PANEL_CSS = `
.dsh-orm-root { display: flex; flex-direction: column; height: 100%; background: var(--orm-bg); color: var(--orm-text); font-size: 13px; }
.dsh-orm-topbar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--orm-border); flex-wrap: wrap; }
.dsh-orm-title { font-weight: 600; }
.dsh-orm-status { flex: 1; min-width: 200px; color: var(--orm-text-dim); font-size: 12px; }
.dsh-orm-btn { background: var(--orm-btn-bg); color: var(--orm-btn-text); border: 1px solid var(--orm-btn-border); border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 12px; }
.dsh-orm-btn:hover { filter: brightness(0.95); }
.dsh-orm-btn[disabled] { opacity: 0.5; cursor: default; }
.dsh-orm-btn.on { border-color: var(--orm-accent); color: var(--orm-accent-text); }
.dsh-orm-body { flex: 1; display: flex; min-height: 0; }
.dsh-orm-map { flex: 1; min-width: 0; position: relative; background: var(--orm-map-bg); }
.dsh-orm-map .leaflet-container { position: absolute; inset: 0; width: 100%; height: 100%; background: var(--orm-map-bg); }
.dsh-orm-mapempty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; color: var(--orm-text-faint); font-size: 13px; z-index: 500; }
.dsh-orm-side { width: 250px; border-left: 1px solid var(--orm-border); overflow-y: auto; padding: 10px 12px; }
.dsh-orm-side h4 { margin: 12px 0 6px; font-size: 12px; color: var(--orm-text-faint); text-transform: uppercase; letter-spacing: 0.04em; }
.dsh-orm-legenditem { display: flex; align-items: center; gap: 8px; margin: 3px 0; font-size: 12px; color: var(--orm-text-dim); }
.dsh-orm-swatch { width: 22px; height: 4px; border-radius: 2px; flex: none; }
.dsh-orm-unit { margin: 4px 0; padding: 4px 6px; border-radius: 6px; background: var(--orm-unit-card); font-size: 12px; }
.dsh-orm-unit .dsh-orm-unitname { display: flex; align-items: center; gap: 6px; }
.dsh-orm-unit.failed { border: 1px solid #b3555e; }
.dsh-orm-unit.done.loaded { outline: 1px solid var(--orm-unit-done); }
.dsh-orm-unit small { color: var(--orm-text-faint); }
.dsh-orm-unit .dsh-orm-ubtns { display: flex; gap: 6px; margin-top: 3px; }
.dsh-orm-unit .dsh-orm-ubtns button { font-size: 11px; padding: 1px 8px; }
.dsh-orm-err { color: var(--orm-err); font-size: 11px; margin-top: 2px; }
.dsh-orm-attrib { position: absolute; right: 6px; bottom: 3px; z-index: 800; font-size: 10px; color: var(--orm-attrib-text); background: var(--orm-attrib-bg); padding: 1px 6px; border-radius: 4px; }
.dsh-orm-map .leaflet-container { background: var(--orm-map-bg); }
.dsh-orm-empty { padding: 4px 12px; color: var(--orm-text-dim); font-size: 12px; border-bottom: 1px solid var(--orm-border); }
.dsh-orm-pop { max-width: 300px; font-size: 12px; color: var(--orm-text); }
.dsh-orm-pop-title { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
.dsh-orm-pop-row { display: flex; gap: 4px; margin: 1px 0; }
.dsh-orm-pop-label { color: var(--orm-text-faint); flex: none; }
.dsh-orm-pop-value { color: var(--orm-text); word-break: break-all; }
.dsh-orm-pop-alias { color: var(--orm-text-faint); font-size: 11px; margin-top: 3px; word-break: break-all; }
.dsh-orm-pop-all { white-space: pre; font-size: 11px; color: var(--orm-text-dim); max-height: 160px; overflow: auto; }
.dsh-orm-pop details { margin-top: 5px; }
.dsh-orm-pop summary { color: var(--orm-text-faint); cursor: pointer; font-size: 11px; }
.dsh-orm-pop a { color: var(--orm-accent-text); }
.dsh-orm-map .leaflet-popup-content-wrapper, .dsh-orm-map .leaflet-popup-tip { background: var(--orm-surface); color: var(--orm-text); border: 1px solid var(--orm-border); box-shadow: 0 2px 10px rgba(0,0,0,0.25); }
.dsh-orm-map .leaflet-popup-content { margin: 10px 12px; line-height: 1.45; }

.dsh-orm-root[data-orm-theme='dark'] {
	--orm-bg: #111418; --orm-surface: #171d23; --orm-border: #232a31; --orm-text: #d7dde3; --orm-text-dim: #9fb0bd; --orm-text-faint: #7d8f9c;
	--orm-btn-bg: #1d2730; --orm-btn-border: #2c3944; --orm-btn-text: #d7dde3; --orm-accent: #4d6bfe; --orm-accent-text: #9db4ff;
	--orm-map-bg: #111418; --orm-attrib-bg: #111418; --orm-attrib-text: #9fb0bd; --orm-err: #e2a2a8; --orm-unit-card: #171d23; --orm-unit-done: #2f5d3a;
}
.dsh-orm-root[data-orm-theme='light'] {
	--orm-bg: #f2f4f7; --orm-surface: #ffffff; --orm-border: #d5dde3; --orm-text: #1f2733; --orm-text-dim: #4a5b6a; --orm-text-faint: #66788a;
	--orm-btn-bg: #ffffff; --orm-btn-border: #b9c6d0; --orm-btn-text: #1f2733; --orm-accent: #3b5bdb; --orm-accent-text: #2b4ecc;
	--orm-map-bg: #e9edf1; --orm-attrib-bg: #f7f9fb; --orm-attrib-text: #5a6b7a; --orm-err: #b3261e; --orm-unit-card: #ffffff; --orm-unit-done: #3e7a4e;
}
`;
		const CSS = (typeof window !== 'undefined' && typeof window.__ORM_LEAFLET_CSS__ === 'string' ? window.__ORM_LEAFLET_CSS__ : '') + PANEL_CSS;

		// ---------- theme runtime (follows the DSH GUI theme; task-12) ----------

		function createThemeHub(ctx) {
			const listeners = new Set();
			const hub = {
				current: 'dark',
				set(theme) { if (theme !== 'dark' && theme !== 'light') return; if (hub.current === theme) return; hub.current = theme; for (const fn of [...listeners]) { try { fn(theme); } catch { /* listener guard */ } } },
				subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; }
			};
			// initial + fallback: derive from the DSH CSS variables (the theme presenter keeps them scheme-correct)
			function fromCss() {
				try {
					const v = normColor(getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-base'));
					if (v !== '') return isDarkColor(v) ? 'dark' : 'light';
					const cs = getComputedStyle(document.documentElement).colorScheme || '';
					if (cs.includes('dark')) return 'dark';
					if (cs.includes('light')) return 'light';
				} catch { /* no DOM */ }
				return 'dark';
			}
			hub.set(fromCss());
			// primary channel: the DSH theme service event (client-ui-theme ThemeRuntime ctx.emit('theme/change', snapshot))
			try {
				const off = ctx.on('theme/change', (snap) => {
					const scheme = snap?.active?.colorScheme ?? (snap?.active?.id === 'light' ? 'light' : 'dark');
					hub.set(scheme === 'light' ? 'light' : 'dark');
				});
				typeof ctx.effect === 'function' ? ctx.effect(() => off) : undefined;
			} catch { /* theme event channel unavailable — CSS fallback still runs */ }
			// keepalive fallback while the event channel is silent (cheap, self-disarms on any event-driven change match)
			let timer = 0;
			try {
				timer = setInterval(() => { const t = fromCss(); if (t !== hub.current) hub.set(t); }, 3000);
			} catch { /* timer unavailable */ }
			typeof ctx?.effect === 'function' ? ctx.effect(() => clearInterval(timer)) : undefined;
			return hub;
		}

		// [popup-pure-start] (test/run.mjs extracts: popupModel)
		/** Curated popup model from raw OSM tags (task-19). Pure data, no DOM. */
		function popupModel(tags, t) {
			const g = (k) => (tags && typeof tags[k] === 'string' && tags[k].length > 0 ? tags[k] : null);
			const isStation = g('railway') === 'station' || g('railway') === 'halt';
			const usageMap = { main: 'pop.usage.main', branch: 'pop.usage.branch', industrial: 'pop.usage.industrial', test: 'pop.usage.industrial', service: 'pop.usage.service', yard: 'pop.usage.service' };
			const title = isStation ? (g('name') ?? g('name:en') ?? g('alt_name') ?? g('railway:ref') ?? t('pop.unnamed')) : (g('name') ?? g('name:en') ?? g('railway:ref') ?? (g('usage') !== null && usageMap[g('usage')] ? t(usageMap[g('usage')]) : t('pop.rail')));
			const subs = [];
			const push = (label, value) => { if (value !== null && value !== undefined && String(value).length > 0) subs.push([label, String(value)]); };
			if (isStation) {
				if (g('name:en') !== null && g('name:en') !== g('name')) push(t('pop.enName'), g('name:en'));
			} else {
				if (g('usage') !== null && usageMap[g('usage')] !== undefined) push(t('pop.usage'), t(usageMap[g('usage')]));
			const kindMap = { subway: 'pop.kind.subway', light_rail: 'pop.kind.light_rail', tram: 'pop.kind.tram' };
			if (g('railway') !== null && kindMap[g('railway')] !== undefined) push(t('pop.kind'), t(kindMap[g('railway')]));
				push(t('pop.maxspeed'), g('maxspeed'));
				push(t('pop.gauge'), g('gauge'));
				push(t('pop.electrified'), g('electrified'));
			}
			push(t('pop.operator'), g('operator'));
			push(t('pop.ref'), g('railway:ref'));
			const wikidata = g('wikidata');
			const link = wikidata !== null && /^Q[1-9][0-9]*$/.test(wikidata) ? { qid: wikidata, url: 'https://www.wikidata.org/wiki/' + wikidata } : null;
			const aliases = g('alt_name');
			const allTags = Object.keys(tags ?? {}).sort().map((k) => k + '=' + String(tags[k]));
			return { title, subs, link, aliases, allTags };
		}
		// [popup-pure-end]

		/** DOM popup builder — createElement/textContent only (never innerHTML). */
		function buildPopupEl(tags, t) {
			const model = popupModel(tags, t);
			const el = document.createElement('div');
			el.className = 'dsh-orm-pop';
			const title = document.createElement('div');
			title.className = 'dsh-orm-pop-title';
			title.textContent = model.title;
			el.appendChild(title);
			for (const [label, value] of model.subs) {
				const row = document.createElement('div');
				row.className = 'dsh-orm-pop-row';
				const l = document.createElement('span'); l.className = 'dsh-orm-pop-label'; l.textContent = label + ': ';
				const v = document.createElement('span'); v.className = 'dsh-orm-pop-value'; v.textContent = value;
				row.appendChild(l); row.appendChild(v); el.appendChild(row);
			}
			if (model.link !== null) {
				const row = document.createElement('div'); row.className = 'dsh-orm-pop-row';
				const a = document.createElement('a');
				a.href = model.link.url; a.textContent = 'wikidata:' + model.link.qid;
				a.target = '_blank'; a.rel = 'noopener noreferrer';
				row.appendChild(a); el.appendChild(row);
			}
			if (model.aliases !== null) {
				const row = document.createElement('div'); row.className = 'dsh-orm-pop-alias';
				row.textContent = model.aliases;
				el.appendChild(row);
			}
			const details = document.createElement('details');
			const summary = document.createElement('summary');
			summary.textContent = t('pop.allTags');
			details.appendChild(summary);
			const all = document.createElement('div');
			all.className = 'dsh-orm-pop-all';
			all.textContent = model.allTags.length > 0 ? model.allTags.join('\n') : t('pop.noTags');
			details.appendChild(all);
			el.appendChild(details);
			return el;
		}

		// ---------- components ----------

		function fmtMB(bytes) {
			if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
			return (bytes / 1048576).toFixed(1) + ' MB';
		}

function OrmMap({ mapRef, showEmpty, t, diagOn }) {
			const containerRef = useRef(null);
		useEffect(() => {
			const L = window.L;
			if (!L || !containerRef.current) return undefined;
			let map = null;
			let observer = null;
			try {
				map = L.map(containerRef.current, { preferCanvas: true, minZoom: 3, maxZoom: 14, zoomControl: true, attributionControl: false, zoomAnimation: false, markerZoomAnimation: false, fadeAnimation: false, inertia: false });
				mapRef.current = map;
				// the host may lay out after mount (slots/tabs/theme switches): keep the map sized to its container
				const resize = () => { try { map.invalidateSize(); } catch { /* detached */ } };
				setTimeout(resize, 0);
				setTimeout(resize, 200);
				if (typeof ResizeObserver === 'function') {
					observer = new ResizeObserver(resize);
					observer.observe(containerRef.current);
				}
			} catch {
				// never let map init take the panel down; the empty overlay still renders
				mapRef.current = null;
			}
				// perf diagnostics (task-22 r4): frame timing + layer stats, toggle via localStorage.ormDiag=1
			if (diagOn === true) {
				const diag = document.createElement('div');
				diag.className = 'dsh-orm-diag';
				diag.style.cssText = 'position:absolute;top:4px;left:4px;z-index:900;font:10px monospace;color:#4dd0e1;background:rgba(0,0,0,0.7);padding:2px 6px;border-radius:3px;pointer-events:none;';
				containerRef.current.parentElement?.appendChild(diag);
				let frames = 0, last = performance.now();
				let rafHandle = 0;
				let stopped = false;
				const tick = () => {
					if (stopped) return;
					try {
						frames++;
						const now = performance.now();
						if (now - last >= 500) {
							const fps = Math.round(frames * 1000 / (now - last));
							const layers = window.__ormLoadedGroups ? Object.keys(window.__ormLoadedGroups).length : 0;
							diag.textContent = fps + 'fps | ' + layers + ' units | z' + map.getZoom().toFixed(1);
							frames = 0; last = now;
						}
					} catch { stopped = true; return; }
					rafHandle = requestAnimationFrame(tick);
				};
				rafHandle = requestAnimationFrame(tick);
				ctx2DiagCleanup = () => { stopped = true; cancelAnimationFrame(rafHandle); diag.remove(); };
			}

		// one-shot click → nearest rail feature popup (no per-layer interactive overhead)
			map.on('click', (e) => {
				try {
					const threshold = Math.max(5, 10 / Math.pow(2, 14 - map.getZoom()));
					let best = null, bestDist = Infinity;
					const groups = window.__ormLoadedGroups ?? {};
					for (const gid of Object.keys(groups)) {
						const g = groups[gid];
						if (g.rail === undefined) continue;
						for (const layer of g.rail.getLayers()) {
							const ll = layer.getLatLng ? layer.getLatLng() : null;
							if (ll === null) continue;
							const d = map.distance(e.latlng, ll);
							if (d < bestDist) { bestDist = d; best = layer; }
						}
					}
					if (best !== null && bestDist < threshold * 10) {
						best.openPopup();
					}
				} catch { /* click query best-effort */ }
			});
			return () => {
				try { observer?.disconnect(); } catch { /* gone */ }
				try { map?.remove(); } catch { /* gone */ }
				mapRef.current = null;
			};
		}, [mapRef]);
		return h('div', { className: 'dsh-orm-map', ref: containerRef },
			showEmpty ? h('div', { className: 'dsh-orm-mapempty' }, t('map.empty')) : null,
			h('span', { className: 'dsh-orm-attrib' }, '© OpenStreetMap contributors (ODbL)'));
		}

function OrmPage({ t, api, theme }) {
			const [state, setState] = useState(null);
			const [stateError, setStateError] = useState('');
			const [busy, setBusy] = useState(false);
			const [showRail, setShowRail] = useState(true);
			const [showStations, setShowStations] = useState(true);
			const [loaded, setLoaded] = useState({}); // unitId -> {rail: L.layerGroup, station: L.layerGroup}
			const [loadingUnit, setLoadingUnit] = useState('');
			const [emptyUnits, setEmptyUnits] = useState({});
			const [diagOn, setDiagOn] = useState(() => { try { return localStorage.getItem('ormDiag') === '1'; } catch { return false; } }); // unitId -> 'empty' | 'missing'
			const [unitError, setUnitError] = useState('');
			const mapRef = useRef(null);
			const [view, setView] = useState({ center: [35.5, 104.5], zoom: 4 });

			// initial state + follow stream
			useEffect(() => {
				let disposed = false;
				const applyState = (s) => { if (!disposed) setState(s); };
				api.state().then(applyState).catch((e) => { if (!disposed) setStateError(String(e?.message ?? e)); });
				const handle = api.follow();
				(async () => {
					try {
						for await (const frame of handle) {
							if (disposed) break;
							if (frame?.kind === 'state') applyState(frame.state);
						}
					} catch { /* stream ended */ }
				})();
				return () => { disposed = true; try { handle.return?.(); } catch { /* ignore */ } };
			}, [api]);

			// (re)fit view when config arrives once
			const fittedRef = useRef(false);
			useEffect(() => {
				if (fittedRef.current || mapRef.current === null || !state?.panel) return;
				fittedRef.current = true;
				setView({ center: state.panel.center, zoom: state.panel.zoom });
				mapRef.current.setView(state.panel.center, state.panel.zoom);
			}, [state]);

			const evictLRU = useCallback(() => {
				const entries = Object.entries(loaded);
				if (entries.length === 0) return;
				let total = 0;
				for (const [, g] of entries) total += g.bytes ?? 0;
				if (total <= LOADED_BUDGET) return;
				// evict the first (oldest by insertion order) until under budget
				for (const [id, g] of entries) {
					if (total <= LOADED_BUDGET) break;
					if (id === 'cn-overview') continue; // overview never evicted (it is the far-zoom backbone)
					try { g.rail.remove(); g.station.remove(); } catch { /* gone */ }
					delete loaded[id];
					total -= g.bytes ?? 0;
					setEmptyUnits((prev) => { const n = { ...prev }; delete n[id]; return n; });
				}
			}, [loaded]);

			// task-26: viewport-aware unload with hysteresis
			const unloadTimer = useRef(null);
			const unloadOutsideViewport = useCallback(() => {
				const map = mapRef.current;
				if (map === null) return;
				const b = map.getBounds();
				const latSpan = b.getNorth() - b.getSouth();
				const lonSpan = b.getEast() - b.getWest();
				const mLat = latSpan * 1.0;
				const mLon = lonSpan * 1.0;
				const s = b.getSouth() - mLat, n = b.getNorth() + mLat;
				const w = b.getWest() - mLon, e = b.getEast() + mLon;
				for (const uid of Object.keys(loaded)) {
					if (uid === 'cn-overview') continue;
					const g = loaded[uid];
					if (!g.bbox) continue;
					const [cw, cs, ce, cn] = g.bbox;
					if (ce < w || cw > e || cn < s || cs > n) {
						try { g.rail.remove(); g.station.remove(); } catch { }
						setLoaded((prev) => { const next = { ...prev }; delete next[uid]; return next; });
						setEmptyUnits((prev) => { const next = { ...prev }; delete next[uid]; return next; });
					}
				}
			}, [loaded]);
			const scheduleViewportUnload = useCallback(() => {
				if (unloadTimer.current !== null) clearTimeout(unloadTimer.current);
				unloadTimer.current = setTimeout(() => {
					unloadTimer.current = null;
					unloadOutsideViewport();
				}, 3000);
			}, [unloadOutsideViewport]);

			const loadUnit = useCallback(async (unit) => {
				const L = window.L;
				const map = mapRef.current;
				if (!L || !map) return;
				setLoadingUnit(unit.id);
				setUnitError('');
				try {
					const groups = { rail: L.layerGroup(), station: L.layerGroup() };
					for (const klass of ['rail', 'station']) {
						const res = await api.layer({ unitId: unit.id, klass });
						if (res.geojson?.features?.length > 0) {
							L.geoJSON(res.geojson, {
								...(klass === 'rail'
									? { style: (f) => tunnelAlpha(railStyle(f?.properties), f?.properties) }
									: {
										pointToLayer: (f, latlng) => L.circleMarker(latlng, {
											radius: f?.properties?.railway === 'halt' ? 2.5 : 4,
											color: '#212121',
											weight: 1,
											fillColor: f?.properties?.railway === 'halt' ? '#9e9e9e' : '#e0e0e0',
											fillOpacity: 1
										}).on('mouseover', function () { this.bindTooltip(String(f?.properties?.name ?? f?.properties?.railway ?? ''), { direction: 'top' }).openTooltip(); }),
										style: {}
									})
							}).bindPopup((layer) => buildPopupEl(layer?.feature?.properties ?? {}, t)).addTo(groups[klass]);
						}
					}
					if (showRail) groups.rail.addTo(map);
					if (showStations) groups.station.addTo(map);
				window.__ormLoadedGroups = loaded;
				groups.bytes = (unit.bytes?.rail ?? 0) + (unit.bytes?.station ?? 0);
					groups.bbox = unit.bbox;
				setLoaded((prev) => ({ ...prev, [unit.id]: groups }));
				evictLRU();
					if (groups.rail.getLayers().length + groups.station.getLayers().length === 0) {
						setEmptyUnits((prev) => ({ ...prev, [unit.id]: 'empty' }));
					}
				} catch (e) {
				const code = String(e?.code ?? '');
				const msg = String(e?.message ?? e);
				if (code === 'orm/not-fetched' || code === 'orm/not-found' || msg.includes('not fetched') || msg.includes('shard for unit')) {
					setUnitError('');
					setEmptyUnits((prev) => ({ ...prev, [unit.id]: 'missing' }));
				} else {
					setUnitError(t('err.layer') + ': ' + msg);
				}
				} finally {
					setLoadingUnit('');
				}
			}, [api, showRail, showStations, t]);

			const unloadUnit = useCallback((unitId) => {

			// task-22 O2: LRU eviction — keep loaded units under a byte budget (~60 MiB)
			const LOADED_BUDGET = 62914560;

				setLoaded((prev) => {
					const groups = prev[unitId];
					if (groups !== undefined) {
						try { groups.rail.remove(); groups.station.remove(); } catch { /* gone */ }
					}
					const next = { ...prev };
					delete next[unitId];
					return next;
				});
			setEmptyUnits((prev) => { const next = { ...prev }; delete next[unitId]; return next; });
			}, []);

			const toggleClass = useCallback((klass) => {
				const map = mapRef.current;
				if (klass === 'rail') setShowRail((v) => { const next = !v; if (map) Object.values(loaded).forEach((g) => (next ? g.rail.addTo(map) : g.rail.remove())); return next; });
				if (klass === 'station') setShowStations((v) => { const next = !v; if (map) Object.values(loaded).forEach((g) => (next ? g.station.addTo(map) : g.station.remove())); return next; });
			}, [loaded]);

			// auto-load (02-plan §2.4): under the byte threshold load every done
			// unit once; above it, load done units intersecting the viewport as
			// it moves. Manual Load/Remove buttons always stay in control.
			const autoLoadedRef = useRef(false);
			useEffect(() => {
				const map = mapRef.current;
				const summary = state?.summary;
				if (map === null || !summary?.scoped || summary.unitsDone === 0) return undefined;
				// national overview unit: small, always auto-loads so the network is
				// visible at ANY zoom (city-level grid cells join from zoom 6)
				const overview = (state.units ?? []).find((u) => u.id === 'cn-overview' && u.status === 'done' && (u.features?.rail ?? 0) > 0);
				if (overview !== undefined && loaded[overview.id] === undefined) void loadUnit(overview);
				const doneUnits = (state.units ?? []).filter((u) => u.status === 'done' && ((u.features?.rail ?? 0) + (u.features?.station ?? 0)) > 0);
				const limit = state.panel?.autoLoadBytesLimit ?? 26214400;
				if (summary.bytes <= limit) {
					if (autoLoadedRef.current) return undefined;
					autoLoadedRef.current = true;
					void (async () => { for (const u of doneUnits) { await loadUnit(u); } })();
					return undefined;
				}

				const loadIntersecting = () => {
					if (autoLoadedRef.current) return;
					// whole-country view intersects ~230 non-empty cells (~200 MB): never
					// auto-load there. Past zoom 6 load intersecting cells with a per-pass
					// byte budget; the rest arrive on further moves.
					if (map.getZoom() < 6) return;
					const b = map.getBounds();
					let budget = 41943040;
					for (const u of doneUnits) {
						if (budget <= 0) break;
						if (loaded[u.id] !== undefined || !Array.isArray(u.bbox)) continue;
						const [w, s, ee, n] = u.bbox;
						if (w <= b.getEast() && ee >= b.getWest() && s <= b.getNorth() && n >= b.getSouth()) {
							const size = (u.bytes?.rail ?? 0) + (u.bytes?.station ?? 0);
							if (size > budget && size > 8388608) continue;
							budget -= size;
							void loadUnit(u);
						}
					}
				};
				let timer = null;
				const onMove = () => {
					if (timer !== null) clearTimeout(timer);
					timer = setTimeout(loadIntersecting, 400);
					scheduleViewportUnload();
				};
				map.on('moveend', onMove);
				loadIntersecting();
				return () => {
					if (unloadTimer.current !== null) clearTimeout(unloadTimer.current);
					map.off('moveend', onMove);
					if (timer !== null) clearTimeout(timer);
				};
			}, [state, loadUnit, loaded]);

			const pbf = state?.pbf ?? null;
			const pbfBusy = pbf !== null && ['downloading', 'filtering', 'converting'].includes(pbf.phase);
			const doPbf = useCallback(async () => {
				try { await api.fetchNow({ source: 'pbf' }); } catch { /* stream reports */ }
			}, [api]);

			const doFetch = useCallback(async () => {
				setBusy(true);
				try { await api.fetchNow({}); } catch { /* status stream reports */ }
				finally { setBusy(false); }
			}, [api]);

			const doFetchUnit = useCallback(async (unitId) => {
				setBusy(true);
				try { await api.fetchNow({ unitId }); } catch { /* stream reports */ } finally { setBusy(false); }
			}, [api]);

			const units = state?.units ?? [];
			const summary = state?.summary ?? null;

			const statusText = summary === null
				? (stateError !== '' ? t('err.state') + ': ' + stateError : '…')
				: summary.scoped
					? t('status.units', { done: summary.unitsDone, total: summary.unitsTotal, failed: summary.unitsFailed, rail: summary.features.rail, station: summary.features.station }) + ' · ' + fmtMB(summary.bytes)
					: t('status.idle');
			let pbfText = '';
			if (pbf !== null && pbf.phase !== 'idle' && pbf.phase !== 'ready') {
				if (pbf.phase === 'downloading') {
					const totalMB = pbf.totalBytes ? Math.round(pbf.totalBytes / 1048576) : 0;
					const gotMB = Math.round((pbf.downloadedBytes ?? 0) / 1048576);
					const pct = pbf.totalBytes ? Math.min(100, Math.round((pbf.downloadedBytes ?? 0) / pbf.totalBytes * 100)) : 0;
					pbfText = ' · ' + t('pbf.downloading', { pct: String(pct), got: String(gotMB), total: String(totalMB) });
				} else if (pbf.phase === 'filtering') {
					pbfText = ' · ' + t('pbf.filtering');
				} else if (pbf.phase === 'converting') {
					pbfText = ' · ' + t('pbf.converting');
				} else if (pbf.phase === 'failed') {
					pbfText = ' · ' + t('pbf.failed', { err: String(pbf.error ?? '').slice(0, 80) });
				}
			}

			const legend = h('div', { className: 'dsh-orm-legend' },
				h('h4', null, t('legend.title')),
				RAIL_STYLES.map((s) => h('div', { key: s.key, className: 'dsh-orm-legenditem' },
					h('span', { className: 'dsh-orm-swatch', style: { background: s.color } }), s.label)));

			const unitList = h('div', null,
				h('h4', null, t('units.title')),
				units.length === 0 ? h('div', { className: 'dsh-orm-unit' }, t('units.none')) : null,
				units.map((u) => h('div', {
					key: u.id,
					className: 'dsh-orm-unit ' + u.status + (loaded[u.id] !== undefined ? ' loaded' : '')
				},
					h('div', { className: 'dsh-orm-unitname' },
						h('span', null, u.name),
						h('small', null, u.status),
						loaded[u.id] !== undefined ? h('small', null, '· ' + t('units.loaded')) : null),
					u.status === 'done' ? h('small', null, ((u.features?.rail ?? 0) + (u.features?.station ?? 0)) === 0 ? t('unit.empty') : ((u.features?.rail ?? 0) + ' / ' + (u.features?.station ?? 0) + ' · ' + fmtMB((u.bytes?.rail ?? 0) + (u.bytes?.station ?? 0)))) : null,
					emptyUnits[u.id] === 'missing' ? h('div', { className: 'dsh-orm-err' }, t('unit.missing')) : null,
					u.status === 'failed' ? h('div', { className: 'dsh-orm-err' }, String(u.error ?? '').slice(0, 100)) : null,
					h('div', { className: 'dsh-orm-ubtns' },
						u.status === 'done' && loaded[u.id] === undefined && ((u.features?.rail ?? 0) + (u.features?.station ?? 0)) > 0
							? h('button', { className: 'dsh-orm-btn', disabled: loadingUnit === u.id, onClick: () => { void loadUnit(u); } }, loadingUnit === u.id ? '…' : t('action.loadUnit'))
							: null,
						loaded[u.id] !== undefined
							? h('button', { className: 'dsh-orm-btn', onClick: () => unloadUnit(u.id) }, t('action.removeUnit'))
							: null,
						u.status === 'failed'
							? h('button', { className: 'dsh-orm-btn', onClick: () => { void doFetchUnit(u.id); } }, t('action.retryUnit'))
							: null))));

			return h('div', { className: 'dsh-orm-root', 'data-orm-theme': theme },
				h('style', null, CSS),
				h('div', { className: 'dsh-orm-topbar' },
					h('span', { className: 'dsh-orm-title' }, t('title')),
					h('span', { className: 'dsh-orm-status' }, statusText, pbfText),
					h('button', { className: 'dsh-orm-btn' + (showRail ? ' on' : ''), onClick: () => toggleClass('rail') }, t('layer.rail')),
					h('button', { className: 'dsh-orm-btn' + (showStations ? ' on' : ''), onClick: () => toggleClass('station') }, t('layer.station')),
					h('button', { className: 'dsh-orm-btn', disabled: busy, onClick: () => { void doFetch(); } }, busy ? t('action.fetching') : t('action.fetch')),
					h('button', { className: 'dsh-orm-btn', disabled: pbfBusy, onClick: () => { void doPbf(); }, title: 'download.openstreetmap.fr china-latest.osm.pbf (A path)' }, pbfBusy ? '…' : t('action.pbf')),
					h('button', { className: 'dsh-orm-btn' + (diagOn ? ' on' : ''), onClick: () => { const v = !diagOn; setDiagOn(v); try { localStorage.setItem('ormDiag', v ? '1' : '0'); } catch { } }, title: 'performance overlay' }, 'perf')),
				(summary !== null && summary.scoped && summary.unitsTotal > 0 && summary.unitsDone === 0)
					? h('div', { className: 'dsh-orm-empty' }, t('status.empty'))
					: null,
				h('div', { className: 'dsh-orm-body' },
					h(OrmMap, { mapRef, t, showEmpty: Object.keys(loaded).length === 0, diagOn }),
					h('div', { className: 'dsh-orm-side' },
						summary !== null && summary.scoped ? h('div', { style: { fontSize: 11, color: 'var(--orm-text-faint)' } }, t(summary.mode === 'grid' ? 'mode.grid' : 'mode.area')) : null,
						unitError !== '' ? h('div', { className: 'dsh-orm-err' }, unitError) : null,
						legend,
						unitList)));
		}

		function OrmPanelIcon({ t }) {
			return h('span', { title: t('panel') }, '🚆');
		}

		// ---------- mount (structure follows rss-reader client.js:1943-2006) ----------

		const inject = ['remote', 'slots', 'locale'];

		function registerUi(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }));
			const t = (key, params) => {
				let dict = DICT_EN;
				const id = String((ctx.locale && (ctx.locale.id || ctx.locale.current || ctx.locale.lang)) || '');
				if (id.startsWith('zh')) dict = DICT_ZH;
				let text = dict[key] ?? DICT_EN[key] ?? key;
				if (params) for (const [k, v] of Object.entries(params)) text = text.replace('{' + k + '}', String(v));
				return text;
			};
			async function unwrap(promise) {
				const result = await promise;
				if (result && typeof result === 'object' && 'ok' in result) {
					if (result.ok) return result.value;
					throw (result.error ?? new Error('remote call failed'));
				}
				return result;
			}
			const api = {
				state: () => unwrap(ctx.remote.orm.state()),
				layer: (request) => unwrap(ctx.remote.orm.layer(request)),
				fetchNow: (request) => unwrap(ctx.remote.orm.fetchNow(request || {})),
				follow: (signal) => ctx.remote.orm.follow(signal)
			};
				// task-27 r2: black-box error boundary — panel never goes silently blank
		class OrmErrorBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(error) {
				return { error };
			}
			componentDidCatch(error, info) {
				// fire-and-forget report to Host for disk logging
				try {
					const line = new Date().toISOString() + ' | ' + String(error?.stack ?? error?.message ?? error).slice(0, 2000) + '\n';
					console.error('[orm-china-viewer]', line);
				} catch { }
			}
			render() {
				if (this.state.error !== null) {
					const h2 = React.createElement;
					return h2('div', { style: { padding: '16px', color: '#e2a2a8', fontSize: 12, fontFamily: 'monospace', overflow: 'auto', height: '100%' } },
						h2('h3', { style: { color: '#e2a2a8', marginBottom: '8px' } }, 'Panel error (auto-recovered)'),
						h2('pre', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, String(this.state.error?.stack ?? this.state.error?.message ?? this.state.error)),
						h2('button', { className: 'dsh-orm-btn', onClick: () => this.setState({ error: null }), style: { marginTop: '8px' } }, 'Retry'));
				}
				return this.props.children;
			}
		}

const themeHub = createThemeHub(ctx);
		function OrmMainInner() {
			const [theme, setTheme] = useState(themeHub.current);
			useEffect(() => themeHub.subscribe(setTheme), [setTheme]);
			return h(OrmPage, { t, api, theme });
		}
			const OrmMain = () => React.createElement(OrmErrorBoundary, null, React.createElement(OrmMainInner));
			ctx.slots.inject('main', () => ctx.slots.register({
				name: 'main',
				key: PANEL_ID,
				locale: NS,
				inject: () => ({})
			}, OrmMain));
			function OrmPanelIconWithT() { return h(OrmPanelIcon, { t }); }
			ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
				name: 'sidebar.panellist',
				id: PANEL_ID,
				order: 12,
				locale: NS,
				label: () => t('panel')
			}, OrmPanelIconWithT));
		}

		async function apply(ctx) {
			const disposeRemote = await ctx.remote.$mount(ORM_REMOTE);
			const ui = ctx.inject(['remote.orm', 'slots', 'locale'], registerUi);
			try {
				await ui;
			} catch (error) {
				await ui.dispose();
				await disposeRemote();
				throw error;
			}
			return async () => {
				await ui.dispose();
				await disposeRemote();
			};
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});