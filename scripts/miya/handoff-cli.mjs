#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { planNextHandoff } from './handoff-core.mjs';

const input = process.argv.slice(2);
if (input.length === 0 || input.some(path => !/^\.github\/miya\/handoffs\/MIYA-AUTO-[0-9]{3,6}\.json$/.test(path))) {
    console.error('Usage: node scripts/miya/handoff-cli.mjs .github/miya/handoffs/MIYA-AUTO-001.json');
    process.exitCode = 2;
} else {
    try {
        const tickets = input.map(path => JSON.parse(readFileSync(path, 'utf8')));
        console.log(JSON.stringify(planNextHandoff(tickets), null, 2));
    } catch (error) {
        console.error('Handoff validation failed: ' + error.message);
        process.exitCode = 1;
    }
}
