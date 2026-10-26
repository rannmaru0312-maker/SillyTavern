const fs = require('node:fs');
const { ensureDecisions } = require('./ensure-decisions.js');

function readDecisions(userId) {
    // 利用者専用のファイルを準備
    const { pendingFile, resultsFile } = ensureDecisions(userId);

    // JSONファイルを読み込む
    function readJson(file) {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }

    const pendingData = readJson(pendingFile);
    const resultsData = readJson(resultsFile);

    // 保存データの基本的な形式を確認
    if (
        pendingData.version !== 3 ||
        !Array.isArray(pendingData.pending)
    ) {
        throw new Error('記憶候補データの形式が不正です');
    }

    if (
        resultsData.version !== 3 ||
        !Array.isArray(resultsData.decisions)
    ) {
        throw new Error('承認結果データの形式が不正です');
    }

    return {
        pending: pendingData.pending,
        decisions: resultsData.decisions
    };
}

module.exports = { readDecisions };
