export function detectMemoryCandidate(text) {
    if (typeof text !== 'string') return null;

    const value = text.trim();

    if (!value || value.length > 500) return null;

    const sensitiveInformation = /(?:住所|住んで|居住|在住|電話番号|携帯番号|メールアドレス|パスワード|暗証番号|口座番号|クレジットカード|マイナンバー|個人番号|社会保障番号|運転免許証|パスポート番号|生年月日|誕生日|本名|病名|病気|病|疾患|持病|健康状態|検査結果|診断|治療|服薬|処方薬|薬|手術|障害|妊娠|アレルギー|宗教|信仰|政治的|支持政党|投票先|性別|性的指向|性自認|人種|民族|在留資格|犯罪歴|借金|年収|収入|資産|貯金)/u;
    const privateValue = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:\+?\d[\d\s()-]{7,}\d)\b)/iu;
    const thirdPartyDetails = /(?:友人|友達|同僚|上司|部下|家族|母|父|兄|姉|弟|妹|妻|夫|恋人|彼氏|彼女|同級生|隣人).{0,24}(?:名前|氏名|年齢|勤務先|学校名)/u;
    const thirdPartyPreference = /(?:友人|友達|同僚|上司|部下|家族|母|父|兄|姉|弟|妹|妻|夫|恋人|彼氏|彼女|同級生|隣人)(?:は|が|の)[^。\n]{0,40}(?:好き|嫌い|苦手|得意|趣味|希望)/u;
    const temporaryContext = /(?:今日|昨日|明日|今だけ|今回だけ|一時的に|今週だけ|来週|来月|その場限り)/u;
    const acknowledgement = /^(?:はい|うん|そう|なるほど|ありがとう|ありがとうございます|了解|わかった|分かった|OK|おもしろい|笑)[!！。…\s]*$/iu;
    const emptyMemoryRequest = /^(?:覚えて(?:おいて)?(?:ください|ね)?|記憶して(?:おいて)?(?:ください|ね)?|記録して(?:おいて)?(?:ください|ね)?|忘れないで(?:ね|ください)?)[!！。…\s]*$/u;
    const explicitMemoryRequest = /(?:覚えて(?:おいて)?(?:ください|ね)?|記憶して(?:おいて)?(?:ください|ね)?|記録して(?:おいて)?(?:ください|ね)?|忘れないで(?:ね|ください)?)[、,:：\s]*[\p{L}\p{N}]{3,}/u;

    if (
        sensitiveInformation.test(value) ||
        privateValue.test(value) ||
        thirdPartyDetails.test(value) ||
        thirdPartyPreference.test(value) ||
        temporaryContext.test(value) ||
        acknowledgement.test(value) ||
        emptyMemoryRequest.test(value)
    ) {
        return null;
    }

    const rules = [
        {
            pattern: explicitMemoryRequest,
            reason: '利用者の明示的な記憶依頼'
        },
        {
            pattern: /(?:私|僕|俺|自分)(?:は|が)[^。\n]{0,80}(?:が好き|が嫌い|が苦手|が得意)/u,
            reason: '利用者の好み'
        },
        {
            pattern: /好きな[^。\n]{1,40}(?:は|が)[^。\n]{1,80}/u,
            reason: '利用者の好み'
        },
        {
            pattern: /(?:(?:私|僕|俺|自分)の)?趣味は[^。\n]{1,80}/u,
            reason: '利用者の趣味'
        },
        {
            pattern: /(?:今後は|これからは|普段は|いつも|毎回)[^。\n]{0,80}(?:して|してほしい|してください|話して|呼んで|答えて|返して)/u,
            reason: '継続的な希望'
        }
    ];

    for (const rule of rules) {
        if (rule.pattern.test(value)) {
            return { text: value, reason: rule.reason };
        }
    }

    return null;
}
