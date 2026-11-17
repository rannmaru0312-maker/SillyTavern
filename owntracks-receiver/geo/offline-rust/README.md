# MIYA Offline Japan town geocoder — Draft evaluation

A privacy-first **address-only** fallback for the MIYA & KOHARU OwnTracks workflow.

- Dependency: `japan-reverse-geocoder = 0.1.0`, source https://github.com/uiuifree/rust-japan-reverse-geocoder (MIT/Apache-2.0 code; embedded MLIT location reference data subject to its own attribution/terms).
- At **runtime**, the Rust crate works without HTTP, cloud geocoding or API keys. `cargo build` may use networking to download dependencies; this is a separate supply-chain and deployment decision.
- JSON request on **stdin**: `{"lat":35.6812,"lon":139.7671}`. JSON response on stdout contains town-level approximate address, distance to the nearest **town representative point**, dataset version, and a statement that this is unverified. Invalid inputs receive generic stderr errors (no raw coordinates).
- Returns no shop/building/street number, never claims a visit, and returns no candidate when the nearest representative point is more than 1.5km away.
- Do **not** send user location to GitHub CI. CI uses two publicly known railway stations, Tokyo and Osaka, for smoke tests only. For the actual personal diary, build and run this with the compiled data on a trusted private runtime, subject to dependency review and resource checks.
- This evaluator is not integrated with the existing Render web receiver, Apps Script, annual Excel writer or the 9 AM scheduled task. They remain untouched.
- Trust boundary: an offline address may be stored in private Excel. Public Overpass/other external POI lookup for private homes/work visits remains prohibited unless separately evaluated.
- Data attribution for future output: 国土交通省「位置参照情報（大字・町丁目レベル）」 (https://nlftp.mlit.go.jp/isj/). Source metadata, input accuracy and confidence should be retained in the candidate sheet.

Run in an isolated Rust environment: `cargo test --manifest-path owntracks-receiver/geo/offline-rust/Cargo.toml`.