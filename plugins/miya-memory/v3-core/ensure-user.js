const fs = require('node:fs');
const path = require('node:path');

// 開発専用データ。HOME配下の本番記憶にはアクセスしない
const usersDir = path.join(
    __dirname,
    '..',
    'runtime-data',
    'users'
);

function ensureUser(userId) {
    if (typeof userId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(userId)) {
        throw new Error('利用者IDの形式が不正です');
    }

    const userDir = path.join(usersDir, userId);
    const charactersDir = path.join(userDir, 'characters');
    const commonFile = path.join(userDir, 'common.json');

    fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(charactersDir, { recursive: true, mode: 0o700 });

    if (!fs.existsSync(commonFile)) {
        const initialData = { version: 3, memories: [] };
        fs.writeFileSync(
            commonFile,
            JSON.stringify(initialData, null, 2) + '\n',
            { flag: 'wx', mode: 0o600 }
        );
    }

    return { userDir, charactersDir, commonFile };
}

module.exports = { ensureUser };
