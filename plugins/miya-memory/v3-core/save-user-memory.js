const fs = require('node:fs');
const crypto = require('node:crypto');
const { ensureCharacter } = require('./ensure-character.js');
const { withFileLock } = require('./file-lock.js');

const { normalizeForComparison } = require('./normalize-memory-text.js');

const validId = /^[a-zA-Z0-9_-]{1,64}$/;

function saveUserMemory(userId, characterId, text) {
    if (
        typeof userId !== 'string' ||
        typeof characterId !== 'string' ||
        !validId.test(userId) ||
        !validId.test(characterId)
    ) {
        throw new Error('利用者IDまたはキャラクターIDが不正です');
    }

    if (
        typeof text !== 'string' ||
        !text.trim() ||
        text.length > 2000
    ) {
        throw new Error('記憶内容が不正です');
    }

    const file = ensureCharacter(userId, characterId);
    const content = text.trim();
    const comparableContent = normalizeForComparison(content);

    return withFileLock(file, () => {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));

        if (
            data.version !== 3 ||
            !Array.isArray(data.memories)
        ) {
            throw new Error('記憶データの形式が不正です');
        }

        if (data.memories.some(item =>
            typeof item.text === 'string' &&
            normalizeForComparison(item.text) === comparableContent,
        )) {
            return { saved: false, reason: 'duplicate' };
        }

        data.memories.push({
            id: crypto.randomUUID(),
            text: content,
            createdAt: new Date().toISOString(),
        });

        const tempFile = file + '.' + crypto.randomUUID() + '.tmp';

        try {
            fs.writeFileSync(
                tempFile,
                JSON.stringify(data, null, 2) + '\n',
                { flag: 'wx', mode: 0o600 },
            );
            fs.renameSync(tempFile, file);
        } finally {
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }
        }

        return { saved: true };
    });
}

module.exports = { saveUserMemory };
