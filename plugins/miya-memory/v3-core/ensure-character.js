const fs = require('node:fs');
const path = require('node:path');
const { ensureUser } = require('./ensure-user.js');

function ensureCharacter(userId, characterId) {
    const validId = /^[a-zA-Z0-9_-]{1,64}$/;

    if (
        typeof userId !== 'string' ||
        typeof characterId !== 'string' ||
        !validId.test(userId) ||
        !validId.test(characterId)
    ) {
        throw new Error('IDの形式が不正です');
    }

    const { charactersDir } = ensureUser(userId);
    const characterFile = path.join(
        charactersDir,
        characterId + '.json'
    );

    const initialData = {
        version: 3,
        memories: []
    };

    try {
        fs.writeFileSync(
            characterFile,
            JSON.stringify(initialData, null, 2) + '\n',
            { flag: 'wx', mode: 0o600 }
        );
    } catch (error) {
        if (error.code !== 'EEXIST') {
            throw error;
        }
    }

    return characterFile;
}

module.exports = { ensureCharacter };
