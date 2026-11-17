# MIYA & KOHARU — Offline public OSM POI catalog (2026-11-17)

**Status:** Code and synthetic 7-case tests passed; private actual annual workbook schema tested with an unrelated public synthetic POI (0 changes). **Not yet production-deployed.** Real Kansai OSM catalog creation must be confirmed from CI artifact before testing actual names, and the scheduled job must be separately wired and verified.

## Public dataset acquisition: no private GPS in GitHub

`.github/workflows/owntracks-public-poi-catalog.yml` downloads fixed **entire Kansai** Geofabrik OSM extract to GitHub Actions and extracts named POI **nodes only**. Source [Geofabrik Kansai](https://download.geofabrik.de/asia/japan/kansai.html), OSM data © OpenStreetMap contributors, license ODbL-1.0, see https://www.openstreetmap.org/copyright. No personal GPS or annual Excel leaves the private environment. The CI generated artifact is public reference-only; do **not** publish joined results or candidate matches.

Only named shop/amenity/tourism nodes are included initially. OSM ways (buildings mapped as polygons) and restaurants absent from OSM are **not covered**. No claim of comprehensive store lookup. Catalog is not generated if public download/parse fails. Artifact retention 2 days (fetch into *private*, non-shared Drive after validating source and SHA256). Do not auto-download to a public repository or use live per-point Overpass requests.

## Private processing

1. Obtain the `kansai-public-poi.ndjson` public artifact. Validate the output first line `schema:1`, `kind:public_osm_named_poi_nodes`, source URL, `count`, ODbL attribution and SHA256. Store as **nonshared**, with update date/hash (never store user GPS in artifact or GitHub).
2. In a trusted private environment with `artifact_tool`, download the **latest** `生活記録_YYYY.xlsx` and the catalog bytes. Run `offline-poi-candidates.py --source 生活記録_YYYY.xlsx --catalog kansai-public-poi.ndjson --catalog-sha256 SHA256 --output 生活記録_YYYY_候補.xlsx`.
3. The script processes only GPS observations whose original month record E column is `未登録`, GPS accuracy ≤12m, one uniquely named POI within 15m and **no other named POI within 35m plus accuracy**. This is a *nearby candidate, not a verified visit*. Manual correction F and existing candidate D and existing P/Q provenance are never overwritten. Exact coordinates are never logged, emitted, or sent outside private process. All existing month data and formulas are compared before output is considered valid.
4. If updated, pre-save verify original Drive file version, parent, sharing, full byte SHA256, create a nonshared backup. Replace same Drive file ID only; read back and compare the byte hash and key cells. If `unchanged` or `no_public_poi_data`, do not write. This script deliberately does **not** call Google Drive or change the production app.
5. The weekly/monthly visible tabs `11月_見やすい` etc. derive location from existing monthly R and S; candidate D is reflected via existing correction formulas. Do not overwrite manual edits or change source linkage.

### Limitations

- If no OSM file can be downloaded, **no new store names can be produced**. Do not create invented names.
- OSM POI nodes only: mapping coverage is partial. Nearby is not an arrival/departure confirmation. Missing, inaccurate, or ambiguous locations must remain blank.
- Sensitive site names/locations are never sent to public APIs; offline candidate generation still requires careful review before using names for any private household, workplace or care-client location.
- Scheduled updates not proven, and no payments or production Render changes authorized.

## Local verification

```sh
python3 test-offline-poi-candidates.py
```