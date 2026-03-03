import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
export const HAMMURABI_CONFIG_FILENAME = '.hambros.json';
export const HAMMURABI_AGENTS = [
    'claude-code',
    'codex',
    'terminal-cri',
    'cursor',
    'anti-gravity',
];
function isObject(value) {
    return typeof value === 'object' && value !== null;
}
function isErrnoException(error) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string');
}
export function normalizeEndpoint(endpoint) {
    return endpoint.trim().replace(/\/+$/u, '');
}
export function isHammurabiAgent(value) {
    return HAMMURABI_AGENTS.includes(value);
}
export function defaultConfigPath() {
    return path.join(homedir(), HAMMURABI_CONFIG_FILENAME);
}
export function createHammurabiConfig(input) {
    const endpoint = normalizeEndpoint(input.endpoint);
    const apiKey = input.apiKey.trim();
    const agents = [...new Set(input.agents)];
    if (!endpoint) {
        throw new Error('endpoint is required');
    }
    if (!apiKey) {
        throw new Error('apiKey is required');
    }
    if (agents.length === 0) {
        throw new Error('at least one agent must be selected');
    }
    return {
        endpoint,
        apiKey,
        agents,
        configuredAt: (input.configuredAt ?? new Date()).toISOString(),
    };
}
function parseConfig(value) {
    if (!isObject(value)) {
        return null;
    }
    const endpoint = typeof value.endpoint === 'string' ? normalizeEndpoint(value.endpoint) : '';
    const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
    const configuredAt = typeof value.configuredAt === 'string' ? value.configuredAt : '';
    const agents = value.agents;
    if (!endpoint || !apiKey || !configuredAt || !Array.isArray(agents)) {
        return null;
    }
    if (!agents.every((agent) => typeof agent === 'string' && isHammurabiAgent(agent))) {
        return null;
    }
    return {
        endpoint,
        apiKey,
        agents,
        configuredAt,
    };
}
export async function readHammurabiConfig(configPath = defaultConfigPath()) {
    let raw;
    try {
        raw = await readFile(configPath, 'utf8');
    }
    catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    return parseConfig(parsed);
}
export async function writeHammurabiConfig(config, configPath = defaultConfigPath()) {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
