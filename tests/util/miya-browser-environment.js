import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../../', import.meta.url));

/** Run the real app in a disposable copy, never the user's configured app/data. */
export async function startMiyaBrowserEnvironment() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miya-ui-e2e-'));
    const prompts = [];
    let child;
    let output = '';
    const mock = http.createServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/v1/models') {
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ data: [{ id: 'fictional-local-model' }] }));
        }
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
            res.writeHead(404).end();
            return;
        }
        try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString());
            prompts.push(body);
            const last = body.messages.findLast(message => message.role === 'user');
            const content = 'LOCAL MOCK: ' + String(last?.content);
            if (body.stream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] }) + '\n\ndata: [DONE]\n\n');
                return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ id: 'fictional-completion', object: 'chat.completion', model: 'fictional-local-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] }));
        } catch {
            res.writeHead(400).end();
        }
    });
    async function stop() {
        if (child && child.exitCode === null && child.signalCode === null) {
            await new Promise(resolve => {
                const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
                child.once('exit', () => { clearTimeout(timer); resolve(); });
                child.kill('SIGTERM');
            });
        }
        mock.closeAllConnections();
        if (mock.listening) await new Promise(resolve => mock.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
    try {
        // Copy tracked source only: ignored assets, installed extensions and
        // runtime data can belong to real users and must never enter a fixture.
        const files = execFileSync('git', ['ls-files', '-z', '--', 'src', 'public', 'default', 'plugins/package.json', 'plugins/miya-memory', 'server.js', 'package.json', 'webpack.config.js'], { cwd: project }).toString().split('\0').filter(Boolean);
        for (const file of files) {
            const source = path.join(project, file);
            if (!fs.lstatSync(source).isFile()) throw new Error('Fixture source must be a regular tracked file: ' + file);
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.copyFileSync(source, path.join(root, file));
        }
        fs.symlinkSync(path.join(project, 'node_modules'), path.join(root, 'node_modules'), 'dir');
        fs.writeFileSync(path.join(root, 'config.yaml'), 'enableUserAccounts: true\nenableDiscreetLogin: true\nsessionTimeout: 600\nenableServerPlugins: true\nenableServerPluginsAutoUpdate: false\nskipContentCheck: true\n');
        // Fixture provisioning only: synthetic accounts/cards, no runtime UI bypass.
        execFileSync(process.execPath, ['--input-type=module', '-e', `
            import fs from 'node:fs';
            import path from 'node:path';
            globalThis.DATA_ROOT = path.resolve('data');
            const { setConfigFilePath } = await import('./src/util.js');
            setConfigFilePath(path.resolve('config.yaml'));
            const users = await import('./src/users.js');
            const { default: storage } = await import('node-persist');
            const { write } = await import('./src/character-card-parser.js');
            await users.initUserStorage(globalThis.DATA_ROOT);
            for (const handle of ['fictional_ui_a', 'fictional_ui_b']) {
                const salt = users.getPasswordSalt();
                await storage.setItem(users.toKey(handle), { handle, name: handle, created: Date.now(), password: users.getPasswordHash('fictional-ui-password', salt), salt, enabled: true, admin: false });
                const dirs = users.getUserDirectories(handle);
                fs.mkdirSync(dirs.characters, { recursive: true });
                const settings = JSON.parse(fs.readFileSync('default/content/settings.json', 'utf8'));
                settings.firstRun = false;
                settings.main_api = 'openai';
                settings.oai_settings.chat_completion_source = 'custom';
                settings.oai_settings.custom_url = '';
                fs.writeFileSync(path.join(dirs.root, 'settings.json'), JSON.stringify(settings));
                for (const [id, name, marker] of [['miya', 'みや', 'MIYA_CONTEXT_ONLY'], ['koharu', '小春', 'KOHARU_CONTEXT_ONLY']]) {
                    const data = { name, description: marker, personality: marker, scenario: 'Fictional local test', first_mes: name + 'の架空テスト会話です。', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: 'fixture', character_version: '1', extensions: { miya_memory_id: id } };
                    fs.writeFileSync(path.join(dirs.characters, id + '.png'), write(fs.readFileSync('public/img/ai4.png'), JSON.stringify({ ...data, chat: id + ' - fixture', spec: 'chara_card_v2', spec_version: '2.0', data })));
                }
            }
            process.exit(0);
        `], { cwd: root, timeout: 30000, stdio: 'pipe' });
        await new Promise((resolve, reject) => {
            mock.once('error', reject);
            mock.listen(0, '127.0.0.1', resolve);
        });
        const probe = http.createServer();
        await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
        const port = probe.address().port;
        await new Promise(resolve => probe.close(resolve));
        const baseURL = 'http://127.0.0.1:' + port;
        child = spawn(process.execPath, ['server.js', '--configPath=' + path.join(root, 'config.yaml'), '--dataRoot=' + path.join(root, 'data'), '--listen=false', '--browserLaunchEnabled=false', '--port=' + port], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('App startup timed out: ' + output.slice(-3000))), 60000);
            const receive = chunk => {
                output += chunk.toString();
                if (output.includes('SillyTavern is listening')) { clearTimeout(timer); resolve(); }
            };
            child.stdout.on('data', receive);
            child.stderr.on('data', receive);
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', code => { clearTimeout(timer); reject(new Error('App exited: ' + code + '\n' + output.slice(-3000))); });
        });
        return { root, baseURL, mockURL: 'http://127.0.0.1:' + mock.address().port + '/v1', prompts, stop, logs: () => output };
    } catch (error) {
        await stop();
        throw error;
    }
}
