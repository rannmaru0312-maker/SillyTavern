// Use the same comparison for candidate registration and final memory writes.
function normalizeForComparison(text) {
    return text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

module.exports = { normalizeForComparison };
