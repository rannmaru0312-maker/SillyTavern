export function detectMemoryCandidate(text) {
    if (typeof text !== 'string') return null;

    const value = text.trim();

    if (!value || value.length > 500) return null;

    const rules = [
        {
            pattern: /(?:私|僕|俺|自分)の好きな.{1,40}(?:は|が).{1,80}(?:です|だ|である|！|!|。|$)/,
            reason: '利用者の好み'
        },
        {
            pattern: /(?:私は|僕は|俺は|自分は).{0,80}(?:が好き|が嫌い|が苦手)/,
            reason: '利用者の好み'
        },
        {
            pattern: /(?:私の|僕の|俺の|自分の)趣味は/,
            reason: '利用者の趣味'
        },
        {
            pattern: /(?:今後は|これからは).{0,80}(?:して|してほしい|してください)/,
            reason: '今後の希望'
        }
    ];

    for (const rule of rules) {
        if (rule.pattern.test(value)) {
            return { text: value, reason: rule.reason };
        }
    }

    return null;
}
