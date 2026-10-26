const fs = require('node:fs');

function sleep(ms) {
    const buffer = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function withFileLock(file, operation) {
    if (typeof operation !== 'function') {
        throw new Error('処理が指定されていません');
    }

    const lockFile = file + '.lock';
    const deadline = Date.now() + 5000;
    let fd;

    while (fd === undefined) {
        try {
            fd = fs.openSync(lockFile, 'wx', 0o600);
            fs.writeSync(fd, JSON.stringify({
                pid: process.pid,
                createdAt: new Date().toISOString()
            }) + '\n');
            fs.fsyncSync(fd);
        } catch (error) {
            if (error.code !== 'EEXIST') {
                throw error;
            }

            if (Date.now() >= deadline) {
                throw new Error('ロック取得がタイムアウトしました');
            }

            sleep(50);
        }
    }

    try {
        return operation();
    } finally {
        try {
            fs.closeSync(fd);
        } finally {
            fs.unlinkSync(lockFile);
        }
    }
}

module.exports = { withFileLock };
