const fs = require('node:fs');
const path = require('node:path');
const { ensureCharacter } = require('./ensure-character.js');
const { ensureUser } = require('./ensure-user.js');

function readMemories(userId, characterId) {
    const validId = /^[a-zA-Z0-9_-]{1,64}$/;

    if (
        typeof userId !== 'string' ||
        typeof characterId !== 'string' ||
        !validId.test(userId) ||
        !validId.test(characterId)
    ) {
        throw new Error('IDの形式が不正です');
    }

    // 利用者とキャラクター専用の記憶領域を準備
    const characterFile = ensureCharacter(userId, characterId);

    // 共通記憶も開発専用の保存先から取得
    const { commonFile } = ensureUser(userId);

    const common = JSON.parse(fs.readFileSync(commonFile, 'utf8'));
    const character = JSON.parse(fs.readFileSync(characterFile, 'utf8'));

    if (
        common.version !== 3 ||
        character.version !== 3 ||
        !Array.isArray(common.memories) ||
        !Array.isArray(character.memories)
    ) {
        throw new Error('記憶データの形式が不正です');
    }

    return {
        characterId,
        memories: [
            ...common.memories.map(item => ({
                ...item,
                scope: 'common'
            })),
            ...character.memories.map(item => ({
                ...item,
                scope: 'character'
            }))
        ]
    };
}

module.exports = { readMemories };
