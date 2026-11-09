# 中国铁路离线地图（`@local/orm-china-viewer`）

面向 DeepSeek Harness (DSH) Web GUI 的离线优先铁路查看器：经 Overpass API 把中国范围的 OpenStreetMap 铁路要素（railway=rail 线 + station/halt 站点）下载为本地 GeoJSON 分片，再以深色画布 Leaflet 面板渲染（标签语义参照 OpenRailwayMap）。数据落盘后面板完全离线——浏览器侧零网络请求。

同时注册三个 agent 工具：`orm_status`（数据清单）、`orm_fetch`（窗口探测式后台下载）、`orm_reset`（删除分片）。

## 面板

- 侧栏图标「中国铁路地图」→ 主面板。
- 深色画布（刻意不用任何底图瓦片），默认中国视角（35.5N 104.5E，zoom 4）。
- 线路按 OSM 标签着色：usage（干线/支线/工业线）、桥涵 casing、隧道半透明、废弃/拆除/规划/在建各有线型；车站/乘降所圆点 + 名称悬停提示；点击任意要素查看原始标签。
- 数据单元列表（省级；探测失败时回退 2° 网格），支持逐单元 加载/移除/重试；线路与车站两类全局开关；进度经 `orm` Remote follow 流实时刷新。

## 数据管线

- 范围：OSM 中国 = relation 270056（ISO3166-1=CN）→ Overpass area `3600270056`；单元优先省级 relation（admin_level=4），扫描不可用时回退 bbox (73.5, 18.0, 135.1, 53.6) 的 2° 网格。
- 下载只走 GET（浏览器 UA + Referer），先发廉价探针查询确认网络窗口（本机网络对 Overpass 间歇黑洞），429/502/504 指数退避；队列串行、可断点续传——重跑只处理 pending/failed 单元。
- 存储（包目录旁）：`orm-china-data/manifest.json` 与 `units/<unitId>.{rail,station}.geojson`；全部原子写（.tmp → rename）。删除该目录即重置。
- 数据许可：© OpenStreetMap contributors，ODbL 1.0；面板右下角常显归属。

## 数据来源 B：PBF 直下（A 路）

### 数据来源 B2：GitHub Actions 中继（兜底）

双镜像都不可达时，`orm_fetch source=pbf`（及面板 PBF 按钮）自动回落到 relay 发布资产：GitHub 托管 runner 代拉 Geofabrik 切包、osmium 过滤（railway=rail 线 + station/halt 站），以滚动标签 `data-latest` 发布 `china-rail-latest.osm.pbf`（仓库 sliverwolf233/orm-china-relay，内容在 `relay/`，push 待用户批准）。独立取回脚本: `scripts/gh-relay-fetch.mjs`（api.github.com、断点续传、sha256 校验）。

除窗口探测的 Overpass 队列外，面板工具栏另提供 **PBF 直下**：断点续传下载全国 `china-latest.osm.pbf` 镜像（默认 `download.openstreetmap.fr/extracts/asia/china-latest.osm.pbf`，约 1.65 GiB，geofabrik.de 为备源）→ pyosmium 过滤铁路要素 → 以单一全国单元（`cn-pbf`）写入同一分片/manifest 存储。工具形态：`orm_fetch source=pbf`。进度显示在工具栏与 orm_status。

前提：Host 可达一个带 pip 的 Python 3.10+（必要时把 `pbf.pythonPath` 配成解释器绝对路径——DSH 自带 Python 可用）；首次使用时 Host 会在 `pbf.autoInstallPyosmium` 开启时自动安装 pyosmium。

## 安装（Lead/管理员动作，不属于本包内容）

1. 以 `link:` 形式从本目录安装 bundle（与 `@local/rss-reader` 相同）。
2. 把包目录加入 profile 的 `hmr` root 列表以获得 Host 侧热替换（参照 desktop profile cordis.patch.yml 的 rss-reader 行）。

## 配置

配置随 patch 行（见 `cordis.patch.yml`）。要点：`scope.mode`（auto|area|grid）、`fetch.*`（探针/退避/超时/maxBytes）、`panel.*`（中心/缩放/自动加载阈值）、各工具开关与命名。默认值适配本机。

## 开发

| 文件 | 职责 |
|---|---|
| `index.js` | Host 服务：范围解析、串行下载队列、Remote 命名空间 `orm`、标记表。 |
| `lib/store.js` | manifest 与分片持久化（原子写）。 |
| `lib/overpass.js` | GET 引擎：探针、重试、单元/计数/省份查询。 |
| `lib/convert.js` | OSM JSON → GeoJSON（纯函数）。 |
| `lib/agent-tools.js` | orm_status / orm_fetch / orm_reset 注册。 |
| `src/client.js` | 面板源码——**改这里**，然后重建。 |
| `scripts/build-client.mjs` | 确定性拼接构建器（见下）。 |
| `client.js` | 生成物（入库）。勿手改。 |
| `vendor/` | Leaflet 1.9.4 dist 原文。 |
| `test/run.mjs` | 离线测试套件。 |

- `npm test` → `node test/run.mjs`（无网络）。
- 开发环路：改 `src/client.js` → `node scripts/build-client.mjs` → DSH client-hmr stat-poll 约 500ms 内热换 `client.js`；无需刷新页面，也不需要 dev:web。Host 侧改动经 profile hmr root 行热替换。
- `client.js` = GENERATED 注释 + CJS 桥包裹的 Leaflet（设置 `window.L`）+ `window.__ORM_LEAFLET_CSS__` + `src/client.js` 原文。重建确定性：输入不变则逐字节一致。

### Vendored Leaflet 记录（销 01-research U6）

来源：`https://registry.npmjs.org/leaflet/-/leaflet-1.9.4.tgz`（Leaflet 1.9.4，BSD-2-Clause）。

| 文件 | 字节 | SHA-256 |
|---|---|---|
| `vendor/leaflet.js` | 147552 | `db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a` |
| `vendor/leaflet.css` | 14806 | `a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6` |

未使用任何 marker 图片资源（仅 CircleMarker + tooltip），CSS 中 images/ 引用无效化。

## 许可

双协议择一：非商业相同共享使用走 **CC BY-NC-SA 4.0**；不满足 CC 条件（含商业）走 **AGPL-3.0** 兜底。详见 [LICENSE](LICENSE)。

- OpenStreetMap 数据：ODbL 1.0（不可再许可）。
- 内嵌 Leaflet：BSD-2-Clause。

## 月度数据更新

relay workflow（本仓 `relay/`，部署于 [sliverwolf233/orm-china-relay](https://github.com/sliverwolf233/orm-china-relay)）**每月 1 日 03:00 UTC（北京 11:00）** 经 GitHub Actions cron 自动更新，产出双模式滚动 Release 资产。刷新本地数据: 面板 **PBF 直下** 按钮或 CLI 链（见 README.md Monthly data updates 节）。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)