#!/usr/bin/env node
/** Read-only CLI: proposes an AI team assignment without contacting any provider. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { proposeAssignment } from './agent-team-core.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--capability') {
    console.error('Usage: node scripts/miya/agent-team.mjs --capability <planning|implementation|testing|review|security|documentation|audio>');
    process.exitCode = 2;
} else {
    try {
        const configPath = fileURLToPath(new URL('./agent-team.config.json', import.meta.url));
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        const plan = proposeAssignment(config, {
            capability: args[1],
            baseBranch: 'miya-ai-dev',
        });
        process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } catch (error) {
        console.error(`Planning failed: ${error.message}`);
        process.exitCode = 1;
    }
}
