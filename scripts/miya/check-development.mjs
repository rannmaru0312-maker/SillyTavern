import { execFileSync } from 'node:child_process';

const [base, head] = process.argv.slice(2);
if (![base, head].every(value => /^[a-f0-9]{40}$/i.test(value || ''))) {
    throw new Error('Provide full base and head commit SHAs');
}
if (process.env.GITHUB_BASE_REF && process.env.GITHUB_BASE_REF !== 'miya-ai-dev') {
    throw new Error('PR base must be miya-ai-dev');
}
const files = execFileSync('git', ['diff', '--name-only', '-z', base, head], { encoding: 'utf8' }).split('\0').filter(Boolean);
const forbidden = /(^|\/)(?:runtime-data|data|backups|secrets|\.ssh)(\/|$)|(^|\/)\.env(?:\.|$)|\.(?:pem|key|p12)$/i;
for (const file of files) {
    if (forbidden.test(file)) throw new Error(`Protected data or credential path: ${file}`);
}
const patch = execFileSync('git', ['diff', '--no-ext-diff', '--unified=0', base, head], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
const added = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n');
if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/.test(added)) {
    throw new Error('Possible credential detected; value omitted');
}
execFileSync('git', ['diff', '--check', base, head], { stdio: 'inherit' });
console.log(`Development checks passed (${files.length} files). Heuristic scan; manual privacy review still required.`);
if (process.argv.includes('--lint')) {
    const js = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', '-z', base, head], { encoding: 'utf8' }).split('\0').filter(file => /\.(?:js|mjs|cjs)$/.test(file));
    if (js.length) execFileSync('node', ['node_modules/eslint/bin/eslint.js', '--no-ignore', '--', ...js], { stdio: 'inherit' });
}
