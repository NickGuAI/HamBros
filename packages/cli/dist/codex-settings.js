import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
function isErrnoException(error) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string');
}
export function defaultCodexConfigPath() {
    return path.join(homedir(), '.codex', 'config.toml');
}
export function buildCodexOtelConfig(endpoint, apiKey) {
    return { endpoint, apiKey };
}
/**
 * Merges Hammurabi OTEL configuration into ~/.codex/config.toml.
 *
 * Produces (inline-table form):
 *   [otel]
 *   log_user_prompt = true
 *   exporter = { otlp-http = { endpoint = "<endpoint>/v1/logs", protocol = "json", headers = { "x-hambros-api-key" = "<apiKey>" } } }
 */
export async function mergeCodexOtelConfig(config, configPath = defaultCodexConfigPath()) {
    let existing = {};
    try {
        const raw = await readFile(configPath, 'utf8');
        existing = parse(raw);
    }
    catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            // File doesn't exist yet — start fresh
        }
        else {
            throw error;
        }
    }
    // Build the [otel] section, preserving any unrelated otel keys (e.g. trace_exporter, environment)
    const currentOtel = typeof existing.otel === 'object' && existing.otel !== null
        ? { ...existing.otel }
        : {};
    currentOtel.log_user_prompt = true;
    currentOtel.exporter = {
        'otlp-http': {
            endpoint: `${config.endpoint}/v1/logs`,
            protocol: 'json',
            headers: {
                'x-hambros-api-key': config.apiKey,
            },
        },
    };
    existing.otel = currentOtel;
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, stringify(existing) + '\n', 'utf8');
}
