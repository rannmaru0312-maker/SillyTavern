/**
 * MIYA OwnTracks -> annual Excel candidate updater: pure JSON planning.
 * Does not fetch locations, access workbooks, or send network requests.
 * Operates only on pre-reviewed candidate records matching immutable event IDs.
 * The receiving workbook adapter is responsible for read-before-write and
 * re-fetch/verification; this module never modifies manual corrections.
 */

const LIMIT_NAME = 140;
const LIMIT_ADDRESS = 230;
const LIMIT_PROVIDER = 180;
const EVENT_KEY = /^[A-Za-z0-9:_!\.\/-]{8,170}$/;
const NONPRINTING = /[\u0000-\u001f\u007f]/;
const FORMULA_PREFIX = /^[\s]*[=+\-@\t\r\n]/;

function clean(v, max) {
  if (v == null || v === '') return '';
  if (typeof v !== 'string' || v.length > max || NONPRINTING.test(v) || FORMULA_PREFIX.test(v)) {
    throw new Error('invalid_untrusted_text');
  }
  return v.trim();
}
function validISO(v) {
  return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v) &&
    Number.isFinite(Date.parse(v));
}
function validId(v) { return typeof v === 'string' && EVENT_KEY.test(v); }

/**
 * Excel correction sheet header on row 4; A..O immutable schema.
 * D: business suggestion; E: address suggestion; F: manual correction (NEVER touched);
 * I: stable event ID; N: source; O: query timestamp.
 * Records are cell-value objects supplied by the workbook reader, not row indexes.
 * suggestions: [{eventId,status,addressCandidate,facilityCandidate,providerName,checkedAt}]
 */
export function planCandidateUpdates({records, suggestions, year, allowPreviouslyFilled=false}) {
  if (!Number.isInteger(year) || year < 2020 || year > 2100) throw Error('invalid_year');
  if (!Array.isArray(records) || !Array.isArray(suggestions)) throw Error('invalid_input');
  const byId = new Map();
  const conflicts = [], planned = [], skipped = [];
  for (const r of records) {
    if (!validId(r?.eventId) || !Number.isInteger(r.rowNumber) || r.rowNumber < 5 ||
        !/^\d{1,2}月$/.test(r.monthSheet) || r.year !== year) {
      throw Error('invalid_existing_record');
    }
    if (byId.has(r.eventId)) throw Error('duplicate_existing_event_id');
    // Validate all candidate/manual cells from workbook without rewriting them.
    const existing = {
      business: clean(r.existingBusinessCandidate, LIMIT_NAME),
      address: clean(r.existingAddressCandidate, LIMIT_ADDRESS),
      source: clean(r.existingProvider, LIMIT_PROVIDER),
      manual: clean(r.manualCorrection, LIMIT_NAME),
      checkedAt: r.existingCheckedAt || '',
    };
    byId.set(r.eventId,{...r,existing});
  }
  const seen = new Set();
  for (const s of suggestions) {
    if (!validId(s?.eventId) || seen.has(s.eventId)) throw Error('duplicate_or_invalid_suggestion_id');
    seen.add(s.eventId);
    const rec = byId.get(s.eventId);
    if (!rec) { skipped.push({eventId:s.eventId,reason:'event_id_not_in_workbook'}); continue; }
    if (s.status !== 'automatic_candidate_unverified') {
      skipped.push({eventId:s.eventId,reason:'no_verified_enrichment_result'});
      continue;
    }
    if (!validISO(s.checkedAt)) throw Error('invalid_lookup_timestamp');
    const business = clean(s.facilityCandidate, LIMIT_NAME);
    const address = clean(s.addressCandidate, LIMIT_ADDRESS);
    const provider = clean(s.providerName, LIMIT_PROVIDER);
    if (!business && !address) {
      skipped.push({eventId:s.eventId,reason:'empty_candidate'}); continue;
    }
    if (!provider) throw Error('missing_provider_name');
    // The same ID can return changed candidate data: don't overwrite silently.
    const old=rec.existing;
    if (!allowPreviouslyFilled &&
        ((old.business && old.business !== business) ||
         (old.address && old.address !== address) ||
         (old.source && old.source !== provider))) {
      conflicts.push({eventId:s.eventId,reason:'candidate_changed_requires_review'});
      continue;
    }
    const unchanged = old.business === business && old.address === address &&
      old.source === provider && old.checkedAt === s.checkedAt;
    if (unchanged) { skipped.push({eventId:s.eventId,reason:'already_identical'}); continue; }
    // G/H formulas and F manual name are never written by this update.
    // Q map hyperlinks and monthly E original history are also preserved.
    planned.push({
      eventId:s.eventId, rowNumber:rec.rowNumber, monthSheet:rec.monthSheet,
      cells:{D:business,E:address,N:provider,O:s.checkedAt},
      manualCorrectionPreserved:Boolean(old.manual),
      sourceStatus:'automatic_candidate_unverified',
    });
  }
  return {year,planned,conflicts,skipped};
}