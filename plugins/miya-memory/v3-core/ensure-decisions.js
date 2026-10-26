const fs = require('node:fs');
const path = require('node:path');
const { ensureUser } = require('./ensure-user.js');

function ensureDecisions(userId) {
    // 利用者IDの形式を確認
    if (
        typeof userId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(userId)
    ) {
        throw new Error('利用者IDの形式が不正です');
    }

    // 利用者専用の保存場所を取得
    const { userDir } = ensureUser(userId);
    const decisionsDir = path.join(userDir, 'decisions');

    fs.mkdirSync(decisionsDir, {
        recursive: true,
        mode: 0o700
    });

    const pendingFile = path.join(decisionsDir, 'pending.json');
    const resultsFile = path.join(decisionsDir, 'results.json');

    // ファイルがなければ新規作成。既存ファイルは上書きしない
    function createIfMissing(file, data) {
        try {
            fs.writeFileSync(
                file,
                JSON.stringify(data, null, 2) + '\n',
                { flag: 'wx', mode: 0o600 }
            );
        } catch (error) {
            if (error.code !== 'EEXIST') {
                throw error;
            }
        }
    }

    createIfMissing(pendingFile, {
        version: 3,
        pending: []
    });

    createIfMissing(resultsFile, {
        version: 3,
        decisions: []
    });

    return {
        decisionsDir,
        pendingFile,
        resultsFile
    };
}

module.exports = { ensureDecisions };
