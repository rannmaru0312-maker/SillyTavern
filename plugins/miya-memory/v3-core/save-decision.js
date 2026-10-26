const fs = require('node:fs');
const crypto = require('node:crypto');
const { ensureDecisions } = require('./ensure-decisions.js');
const { withFileLock } = require('./file-lock.js');
const { saveUserMemory } = require('./save-user-memory.js');

const validId = /^[a-zA-Z0-9_-]{1,64}$/;

function writeJsonAtomic(file, data) {
    const tempFile = file + '.' + crypto.randomUUID() + '.tmp';

    try {
        fs.writeFileSync(
            tempFile,
            JSON.stringify(data, null, 2) + '\n',
            { flag: 'wx', mode: 0o600 }
        );
        fs.renameSync(tempFile, file);
    } finally {
        if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
        }
    }
}

function saveDecision(userId, candidateId, decision) {
    if (
        typeof userId !== 'string' ||
        !validId.test(userId) ||
        typeof candidateId !== 'string' ||
        !validId.test(candidateId) ||
        !['approve', 'hold'].includes(decision)
    ) {
        throw new Error('入力内容が不正です');
    }

    const { pendingFile, resultsFile } = ensureDecisions(userId);

    // ロック順序を統一：pending -> results -> character memory
    return withFileLock(pendingFile, () => {
        return withFileLock(resultsFile, () => {
            const pendingData = JSON.parse(
                fs.readFileSync(pendingFile, 'utf8')
            );
            const resultsData = JSON.parse(
                fs.readFileSync(resultsFile, 'utf8')
            );

            if (
                pendingData.version !== 3 ||
                !Array.isArray(pendingData.pending) ||
                resultsData.version !== 3 ||
                !Array.isArray(resultsData.decisions)
            ) {
                throw new Error('判定データの形式が不正です');
            }

            const candidate = pendingData.pending.find(
                item => item.id === candidateId
            );

            if (!candidate) {
                throw new Error('存在しない記憶候補です');
            }

            if (
                typeof candidate.characterId !== 'string' ||
                !validId.test(candidate.characterId) ||
                typeof candidate.text !== 'string' ||
                !candidate.text.trim() ||
                candidate.text.length > 2000
            ) {
                throw new Error('記憶候補の形式が不正です');
            }

            const previousDecisions = resultsData.decisions.filter(
                item => item.candidateId === candidateId
            );

            const alreadyApproved = previousDecisions.some(
                item => item.decision === 'approve'
            );

            if (alreadyApproved) {
                // 承認記録が既にある場合も、保存の欠落を補い、
                // 承認待ち一覧から候補を整理する。
                const memoryResult = saveUserMemory(
                    userId,
                    candidate.characterId,
                    candidate.text
                );

                if (
                    memoryResult.saved !== true &&
                    memoryResult.reason !== 'duplicate'
                ) {
                    throw new Error('承認した記憶を保存できませんでした');
                }

                pendingData.pending = pendingData.pending.filter(
                    item => item.id !== candidateId
                );

                writeJsonAtomic(pendingFile, pendingData);

                return {
                    saved: true,
                    decision: 'approve',
                    candidateId,
                    reconciled: true
                };
            }

            if (
                previousDecisions.some(
                    item => item.decision === 'hold'
                ) &&
                decision === 'hold'
            ) {
                return {
                    saved: false,
                    reason: 'already-decided'
                };
            }

            if (decision === 'approve') {
                const memoryResult = saveUserMemory(
                    userId,
                    candidate.characterId,
                    candidate.text
                );

                if (
                    memoryResult.saved !== true &&
                    memoryResult.reason !== 'duplicate'
                ) {
                    throw new Error('承認した記憶を保存できませんでした');
                }
            }

            resultsData.decisions.push({
                id: crypto.randomUUID(),
                candidateId,
                characterId: candidate.characterId,
                decision,
                decidedAt: new Date().toISOString()
            });

            // 先に判定結果を永続化する。
            writeJsonAtomic(resultsFile, resultsData);

            if (decision === 'approve') {
                // 承認結果の保存後に、承認待ち一覧から除外する。
                pendingData.pending = pendingData.pending.filter(
                    item => item.id !== candidateId
                );

                writeJsonAtomic(pendingFile, pendingData);
            }

            return { saved: true, decision, candidateId };
        });
    });
}

module.exports = { saveDecision };
