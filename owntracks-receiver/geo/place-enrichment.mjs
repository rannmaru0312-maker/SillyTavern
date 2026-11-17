/**
 * OwnTracks location enrichment (isolated, opt-in prototype).
 *
 * Pure integration layer: NO network client, default provider, credentials, logs,
 * persistence or scheduled job. A caller must supply a separately reviewed
 * location provider. Unreviewed / private points are not sent from a cloud host.
 * Original OwnTracks events remain immutable, and provider suggestions are NEVER
 * treated as confirmed visits.
 */

export const ENRICHMENT_STATUS = Object.freeze({
  NOT_CONFIGURED: 'lookup_not_configured',
  PRIVACY_HOLD: 'privacy_hold',
  LOW_ACCURACY: 'low_accuracy',
  BAD_LOCATION: 'invalid_location',
  LOOKUP_FAILED: 'lookup_failed',
  NO_MATCH: 'no_match',
  CANDIDATE: 'automatic_candidate_unverified',
});

const inRange = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const clean = (s, limit = 250) => typeof s === 'string' ? s.trim().slice(0, limit) : '';

export function distanceMeters(a, b) {
  const radians = deg => deg * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) *
    Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * privacy.mode:
 *   cloud_public_only: cloud provider may receive only a positively reviewed
 *     public-site coordinate not near a protected zone.
 *   approved_device_provider: a specifically approved on-device integration may
 *     send coordinates to its provider (possibly an external Apple server),
 *     including private sites. The device integration owns disclosure UX.
 * Other or missing values fail closed.
 */
export async function suggestPlace(point, {
  provider = null,
  privacy = {},
  protectedZones = [],
  maxAccuracyMeters = 100,
} = {}) {
  const baseline = {eventId: clean(point?.eventId, 100), status: ENRICHMENT_STATUS.NOT_CONFIGURED,
    addressCandidate: '', facilityCandidate: '', providerName: '', checkedAt: ''};
  if (!point || !inRange(point.lat, -90, 90) || !inRange(point.lon, -180, 180)) {
    return {...baseline, status: ENRICHMENT_STATUS.BAD_LOCATION};
  }
  if (!inRange(point.accuracyMeters, 0, Number.MAX_VALUE) || point.accuracyMeters > maxAccuracyMeters) {
    return {...baseline, status: ENRICHMENT_STATUS.LOW_ACCURACY};
  }
  const allowedDevice = privacy.mode === 'approved_device_provider' && privacy.approved === true;
  const allowedCloud = privacy.mode === 'cloud_public_only' && privacy.approved === true &&
    point.classification === 'public_place' && point.publicClassificationVerified === true;
  // Sensitive places must never be sent to arbitrary cloud providers based on
  // a nearby GPS point. Protect by distance including GPS accuracy margin.
  const nearProtectedZone = protectedZones.some(z => {
    if (!inRange(z.lat, -90, 90) || !inRange(z.lon, -180, 180) || !inRange(z.radiusMeters, 0, 20000)) return true;
    return distanceMeters(point, z) <= z.radiusMeters + point.accuracyMeters;
  });
  if ((!allowedDevice && !allowedCloud) || (allowedCloud && nearProtectedZone)) {
    return {...baseline, status: ENRICHMENT_STATUS.PRIVACY_HOLD};
  }
  if (!provider || typeof provider.reverseAddress !== 'function' ||
      typeof provider.nearbyFacility !== 'function' || !clean(provider.name)) {
    return baseline;
  }
  // Preserve partial results when the address or POI provider is unavailable.
  // Nearby facilities never prove an actual visit.
  let address, place, failed = 0;
  try { address = await provider.reverseAddress({lat: point.lat, lon: point.lon}); }
  catch { failed++; }
  try { place = await provider.nearbyFacility({lat: point.lat, lon: point.lon,
    accuracyMeters: point.accuracyMeters}); }
  catch { failed++; }
  const addressCandidate = clean(address?.address);
  const facilityCandidate = clean(place?.name);
  if (!addressCandidate && !facilityCandidate && failed > 0) {
    return {...baseline, status: ENRICHMENT_STATUS.LOOKUP_FAILED};
  }
  return {...baseline, status: addressCandidate || facilityCandidate ? ENRICHMENT_STATUS.CANDIDATE : ENRICHMENT_STATUS.NO_MATCH,
    addressCandidate, facilityCandidate, providerName: clean(provider.name, 100),
    checkedAt: new Date().toISOString()};
}

/** Manual correction always wins; do not alter immutable source record. */
export function displayNameForEvent({existingName = '', manualCorrection = '', suggestion = null} = {}) {
  const manual = clean(manualCorrection);
  if (manual) return {name: manual, status: 'manual_name_confirmed'};
  const suggested = clean(suggestion?.facilityCandidate);
  if (suggested) return {name: suggested, status: ENRICHMENT_STATUS.CANDIDATE};
  return {name: clean(existingName), status: 'existing_name_or_unknown'};
}