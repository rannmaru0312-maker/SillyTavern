const fs = require('node:fs');
const crypto = require('node:crypto');
const { ensureDecisions } = require('./ensure-decisions.js');
const { ensureCharacter } = require('./ensure-character.js');
const { withFileLock } = require('./file-lock.js');

const { normalizeForComparison } = require('./normalize-memory-text.js');

const validId = /^[a-zA-Z0-9_-]{1,64}$/;

function addCandidate(userId, characterId, text, reason = '') {
    if (
        typeof userId !== 'string' || !validId.test(userId) ||
        typeof characterId !== 'string' || !validId.test(characterId) ||
        typeof text !== 'string' || !text.trim() || text.length > 2000 ||
        typeof reason !== 'string' || reason.length > 1000
    ) {
        throw new Error('記憶候補の入力内容が不正です');
    }

    const content = text.trim();
    const comparableContent = normalizeForComparison(content);
    const { pendingFile } = ensureDecisions(userId);
    const memoryFile = ensureCharacter(userId, characterId);

    // ロック順序を固定する：pending -> character memory
    return withFileLock(pendingFile, () => {
        const pendingData = JSON.parse(
            fs.readFileSync(pendingFile, 'utf8'),
        );

        if (
            pendingData.version !== 3 ||
            !Array.isArray(pendingData.pending)
        ) {
            throw new Error('記憶候補データの形式が不正です');
        }

        const duplicateCandidate = pendingData.pending.find(item =>
            item.characterId === characterId &&
            typeof item.text === 'string' &&
            normalizeForComparison(item.text) === comparableContent &&
            item.status === 'pending',
        );

        if (duplicateCandidate) {
            return {
                saved: false,
                reason: 'duplicate-candidate',
                candidate: duplicateCandidate,
            };
        }

        return withFileLock(memoryFile, () => {
            const memoryData = JSON.parse(
                fs.readFileSync(memoryFile, 'utf8'),
            );

            if (
                memoryData.version !== 3 ||
                !Array.isArray(memoryData.memories)
            ) {
                throw new Error('記憶データの形式が不正です');
            }

            if (memoryData.memories.some(item =>
                typeof item.text === 'string' &&
                normalizeForComparison(item.text) === comparableContent,
            )) {
                return {
                    saved: false,
                    reason: 'duplicate-memory',
                };
            }

            // 承認待ち候補は利用者ごとに最大100件
            const pendingCount = pendingData.pending.filter(
                item => item.status === 'pending',
            ).length;

            if (pendingCount >= 100) {
                return {
                    saved: false,
                    reason: 'pending-limit',
                    limit: 100,
                    pendingCount,
                };
            }

            const candidate = {
                id: crypto.randomUUID(),
                characterId,
                text: content,
                reason: reason.trim(),
                status: 'pending',
            };

            pendingData.pending.push(candidate);

            const tempFile =
                pendingFile + '.' + crypto.randomUUID() + '.tmp';

            try {
                fs.writeFileSync(
                    tempFile,
                    JSON.stringify(pendingData, null, 2) + '\n',
                    { flag: 'wx', mode: 0o600 },
                );
                fs.renameSync(tempFile, pendingFile);
            } finally {
                if (fs.existsSync(tempFile)) {
                    fs.unlinkSync(tempFile);
                }
            }

            return candidate;
        });
    });
}

module.exports = { addCandidate };
