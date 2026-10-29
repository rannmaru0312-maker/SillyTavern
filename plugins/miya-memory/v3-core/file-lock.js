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
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;

            if (Date.now() >= deadline) {
                // A PID or timestamp is not reliable proof that the owner is
                // gone (PID reuse, host changes, or paused processes). Never
                // automatically delete a possibly active lock.
                throw new Error('ロック取得がタイムアウトしました。書き込み処理を停止し、ロック所有者を確認してから復旧してください');
            }
            sleep(50);
        }
    }

    // If creating lock metadata fails, never leave our own incomplete lock.
    try {
        fs.writeSync(fd, JSON.stringify({
            pid: process.pid,
            createdAt: new Date().toISOString()
        }) + '\n');
        fs.fsyncSync(fd);
    } catch (error) {
        try {
            fs.closeSync(fd);
        } finally {
            fs.unlinkSync(lockFile);
        }
        throw error;
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
