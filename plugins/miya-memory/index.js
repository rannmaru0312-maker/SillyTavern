const path = require('node:path');

const info = {
    id: 'miya-memory',
    name: 'MIYA Memory Test',
    description: 'Test-only memory approval API',
};

async function init(router) {
    // V3: ログイン利用者専用の記憶読み取りAPI
    router.get('/character-memories', (req, res) => {
        const userId = req.user?.profile?.handle;
        const characterId = req.query.characterId;
        const validId = /^[a-zA-Z0-9_-]{1,64}$/;

        if (typeof userId !== 'string' || !validId.test(userId)) {
            return res.status(403).json({
                error: 'ログイン利用者を確認できません'
            });
        }

        if (typeof characterId !== 'string' || !validId.test(characterId)) {
            return res.status(400).json({
                error: 'キャラクターIDが不正です'
            });
        }

        try {
            const servicePath = path.join(__dirname, 'v3-core', 'read-memories.js');

            const { readMemories } = require(servicePath);
            const result = readMemories(userId, characterId);

            return res.json(result);
        } catch (error) {
            console.error('MIYA Memory V3:', error.message);
            return res.status(500).json({
                error: '記憶を読み込めませんでした'
            });
        }
    });

    // 直接保存APIは廃止。承認処理経由のみ保存可能。

    require("./add-decision-v3-api.js")(router);
    require("./add-candidate-v3-api.js")(router);
    // V3: ログイン利用者専用の記憶候補・判定結果読み出しAPI
    router.get('/decisions-v3', (req, res) => {
        const userId = req.user?.profile?.handle;
        const validId = /^[a-zA-Z0-9_-]{1,64}$/;

        if (typeof userId !== 'string' || !validId.test(userId)) {
            return res.status(403).json({
                error: 'ログイン利用者を確認できません'
            });
        }

        try {
            const servicePath = path.join(__dirname, 'v3-core', 'read-decisions.js');

            const { readDecisions } = require(servicePath);
            const result = readDecisions(userId);

            return res.json(result);
        } catch (error) {
            console.error('MIYA Memory V3 Decisions:', error.message);
            return res.status(500).json({
                error: '記憶候補と判定結果を読み込めませんでした'
            });
        }
    });
}

module.exports = { info, init };
