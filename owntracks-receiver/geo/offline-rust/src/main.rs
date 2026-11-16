//! Private, offline town-level reverse geocoding.
//!
//! Run only on a trusted private host. Exact coordinates are accepted on stdin
//! and never appear in command-line arguments, logs, web requests or errors.
//! Uses MLIT town representative points, NOT building addresses or POI data.
use japan_reverse_geocoder::Geocoder;
use serde::{Deserialize, Serialize};
use std::io::{self, Read};

const MAX_BYTES: u64 = 2048;
const MAX_REPRESENTATIVE_DISTANCE_M: f64 = 1500.0;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    lat: f64,
    lon: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    status: &'static str,
    address_candidate: String,
    facility_candidate: &'static str,
    provider_name: &'static str,
    address_level: &'static str,
    representative_distance_meters: Option<u32>,
    data_version: String,
}

fn query(g: &Geocoder, input: &str) -> Result<Response, &'static str> {
    let req: Request = serde_json::from_str(input).map_err(|_| "invalid_input")?;
    if !req.lat.is_finite() || !req.lon.is_finite() ||
        !(20.0..=46.0).contains(&req.lat) || !(122.0..=154.0).contains(&req.lon) {
        return Err("outside_japan_range");
    }
    let r = g.reverse_geocode(req.lat, req.lon).map_err(|_| "lookup_failed")?;
    let close = r.distance_meters.is_finite() &&
        r.distance_meters <= MAX_REPRESENTATIVE_DISTANCE_M;
    Ok(Response {
        status: if close { "town_candidate_unverified" } else { "no_reliable_town_candidate" },
        address_candidate: if close { format!("{}{}{}", r.address.prefecture, r.address.city, r.address.town) } else { String::new() },
        facility_candidate: "",
        provider_name: "MLIT location reference / japan-reverse-geocoder 0.1.0",
        address_level: "approximate_town_nearest_representative_point",
        representative_distance_meters: if r.distance_meters >= 0.0 && r.distance_meters <= u32::MAX as f64 {
            Some(r.distance_meters.round() as u32)
        } else { None },
        data_version: g.data_version().to_string(),
    })
}

fn main() {
    let mut input = String::new();
    if io::stdin().take(MAX_BYTES + 1).read_to_string(&mut input).is_err() ||
        input.len() as u64 > MAX_BYTES {
        eprintln!("invalid_input");
        std::process::exit(2);
    }
    let geocoder = Geocoder::new();
    match query(&geocoder, &input) {
        Ok(result) => println!("{}", serde_json::to_string(&result).expect("serializable")),
        Err(reason) => { eprintln!("{}", reason); std::process::exit(2); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tokyo_station_public_landmark() {
        let g = Geocoder::new();
        let r = query(&g, r#"{"lat":35.6812,"lon":139.7671}"#).unwrap();
        assert_eq!(r.status, "town_candidate_unverified");
        assert!(r.address_candidate.starts_with("東京都千代田区"), "unexpected municipality");
        assert!(r.address_candidate.contains("丸の内"), "unexpected town");
        assert_eq!(r.facility_candidate, "");
    }
    #[test]
    fn osaka_station_public_landmark() {
        let g = Geocoder::new();
        let r = query(&g, r#"{"lat":34.7024,"lon":135.4959}"#).unwrap();
        assert_eq!(r.status, "town_candidate_unverified");
        assert!(r.address_candidate.starts_with("大阪府大阪市北区"), "unexpected municipality");
        assert_eq!(r.facility_candidate, "");
    }
    #[test]
    fn invalid_or_private_input_is_not_echoed() {
        let g = Geocoder::new();
        assert_eq!(query(&g, r#"{"lat":0,"lon":0}"#).err(), Some("outside_japan_range"));
        assert_eq!(query(&g, r#"{"lat":"secret","lon":139.0}"#).err(), Some("invalid_input"));
        assert_eq!(query(&g, r#"{"lat":35.0,"lon":139.0,"name":"private"}"#).err(), Some("invalid_input"));
    }
}