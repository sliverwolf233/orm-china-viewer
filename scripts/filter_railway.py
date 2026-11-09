#!/usr/bin/env python3
"""orm-china-viewer · filter railway features out of an OSM PBF.

Input:  china-latest.osm.pbf (full national extract)
Output: Overpass-shaped OSM JSON {elements: [...]} that feeds the existing
        lib/convert.js unchanged:
          - every node referenced by a kept way (id/lat/lon, no tags)
          - kept ways: railway=rail (id, node ids, tags)
          - kept nodes: railway=station|halt (id/lat/lon, tags)
Usage:  python filter_railway.py --in <pbf> --out <osm.json> [--mode all|rail]
Requires: pyosmium (pip install osmium) — see README; the Host installs it
on demand when autoInstallPyosmium is on.
Stats are printed as one JSON line on stdout for the Host to surface.
"""
import argparse
import json
import sys

try:
    import osmium
except ImportError:
    print("MISSING_PYOSMIUM", end="")
    sys.exit(3)

# Single source for BOTH filters (relay workflow must match — test/run.mjs asserts sync):
# ways: rail + urban rail; nodes: station/halt/tram_stop
MODES = {
    "all": {"ways": {"rail", "subway", "tram", "light_rail"}, "nodes": {"station", "halt", "tram_stop"}, "subway_ok": True},
    "rail": {"ways": {"rail"}, "nodes": {"station", "halt"}, "subway_ok": False},  # B: stations follow ways (no subway stations)
}



def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="inp", required=True)
    parser.add_argument("--out", dest="out", required=True)
    parser.add_argument("--mode", choices=list(MODES.keys()), default="all")
    args = parser.parse_args()

    mode = MODES[args.mode]
    elements = []
    member_nodes = {}
    ways = 0
    stations = 0

    fp = osmium.FileProcessor(args.inp).with_locations()
    for obj in fp:
        if obj.is_way():
            tags = {t.k: t.v for t in obj.tags}
            if tags.get("railway") not in mode["ways"]:
                continue
            node_ids = []
            valid = True
            for n in obj.nodes:
                loc = n.location
                if not loc.valid():
                    valid = False
                    break
                node_ids.append(n.ref)
                member_nodes[n.ref] = (round(loc.lat, 7), round(loc.lon, 7))
            if not valid or len(node_ids) < 2:
                continue
            elements.append({"type": "way", "id": obj.id, "nodes": node_ids, "tags": tags})
            ways += 1
        elif obj.is_node():
            tags = {t.k: t.v for t in obj.tags}
            if tags.get("railway") in mode["nodes"] and (mode["subway_ok"] or tags.get("station") != "subway"):
                loc = obj.location
                if not loc.valid():
                    continue
                elements.append({
                    "type": "node", "id": obj.id,
                    "lon": round(loc.lon, 7), "lat": round(loc.lat, 7),
                    "tags": tags
                })
                stations += 1

    head = [{"type": "node", "id": ref, "lon": lonlat[1], "lat": lonlat[0]}
            for ref, lonlat in member_nodes.items()]
    out = {"version": 0.6, "generator": "orm-china-viewer filter_railway.py (pyosmium)",
           "elements": head + elements}
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    print(json.dumps({"ways": ways, "stations": stations, "memberNodes": len(member_nodes)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())