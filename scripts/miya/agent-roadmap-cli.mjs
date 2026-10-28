#!/usr/bin/env node
/** Offline read-only roadmap CLI; does not accept completed IDs without GitHub evidence. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planNextTasks } from './agent-roadmap.mjs';

if (process.argv.length !== 2) {
    console.error('Usage: node scripts/miya/agent-roadmap-cli.mjs');
    process.exitCode = 2;
} else {
    try {
        const file = fileURLToPath(new URL('./agent-team.config.json', import.meta.url));
        const config = JSON.parse(readFileSync(file, 'utf8'));
        console.log(JSON.stringify(planNextTasks(config), null, 2));
    } catch (error) {
        console.error(`Roadmap failed: ${error.message}`);
        process.exitCode = 1;
    }
}
