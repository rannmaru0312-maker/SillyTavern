const path = require('node:path');

module.exports = function addDecisionV3Api(router) {
    router.post('/decision-v3', (req, res) => {
        const userId = req.user?.profile?.handle;
        const validId = /^[a-zA-Z0-9_-]{1,64}$/;

        if (typeof userId !== 'string' || !validId.test(userId)) {
            return res.status(403).json({
                error: 'ログイン利用者を確認できません'
            });
        }

        const { candidateId, decision } = req.body || {};

        if (
            typeof candidateId !== 'string' ||
            !validId.test(candidateId) ||
            !['approve', 'hold'].includes(decision)
        ) {
            return res.status(400).json({
                error: '入力内容が不正です'
            });
        }

        try {
            const servicePath = path.join(__dirname, 'v3-core', 'save-decision.js');

            const { saveDecision } = require(servicePath);
            const result = saveDecision(userId, candidateId, decision);

            if (result.reason === 'already-decided') {
                return res.status(409).json({
                    error: 'この候補は処理済みです'
                });
            }

            return res.json({
                success: true,
                ...result
            });
        } catch (error) {
            if (error.message === '存在しない記憶候補です') {
                return res.status(404).json({ error: '記憶候補が見つかりません' });
            }
            console.error('MIYA Memory V3 Decision:', error.message);
            return res.status(500).json({
                error: '承認・保留の保存に失敗しました'
            });
        }
    });
};
