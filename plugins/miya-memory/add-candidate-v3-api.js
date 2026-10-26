const path = require('node:path');

module.exports = function addCandidateV3Api(router) {
    router.post('/candidate-v3', (req, res) => {
        const userId = req.user?.profile?.handle;
        const validId = /^[a-zA-Z0-9_-]{1,64}$/;

        if (typeof userId !== 'string' || !validId.test(userId)) {
            return res.status(403).json({
                error: 'ログイン利用者を確認できません'
            });
        }

        const { characterId, text, reason = '' } = req.body || {};

        if (
            typeof characterId !== 'string' ||
            !validId.test(characterId) ||
            typeof text !== 'string' ||
            !text.trim() ||
            text.length > 2000 ||
            typeof reason !== 'string' ||
            reason.length > 1000
        ) {
            return res.status(400).json({
                error: '入力内容が不正です'
            });
        }

        try {
            const servicePath = path.join(__dirname, 'v3-core', 'add-candidate.js');

            const { addCandidate } = require(servicePath);
            const result = addCandidate(
                userId,
                characterId,
                text,
                reason
            );

            if (
                result.saved === false &&
                result.reason === 'duplicate-candidate'
            ) {
                return res.status(409).json({
                    success: false,
                    reason: result.reason,
                    candidateId: result.candidate.id,
                    error: '同じ記憶候補がすでに登録されています'
                });
            }

            if (
                result.saved === false &&
                result.reason === 'duplicate-memory'
            ) {
                return res.status(409).json({
                    success: false,
                    reason: result.reason,
                    error: '同じ内容が長期記憶に保存されています'
                });
            }

            if (
                result.saved === false &&
                result.reason === 'pending-limit'
            ) {
                return res.status(409).json({
                    success: false,
                    reason: 'pending-limit',
                    limit: 100,
                    pendingCount: result.pendingCount,
                    error: '承認待ち候補が100件に達しています'
                });
            }

            return res.status(201).json({
                success: true,
                candidate: result.candidate || result
            });
        } catch (error) {
            console.error('MIYA Memory V3 Candidate:', error.message);
            return res.status(500).json({
                error: '記憶候補の登録に失敗しました'
            });
        }
    });
};
