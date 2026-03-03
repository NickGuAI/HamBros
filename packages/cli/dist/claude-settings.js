import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
/** Keys that the old onboarding flow wrote — cleaned up during re-onboard. */
const LEGACY_KEYS = ['HAMMURABI_ENDPOINT', 'HAMMURABI_API_KEY'];
function isObject(value) {
    return typeof value === 'object' && value !== null;
}
function isErrnoException(error) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string');
}
export function defaultClaudeSettingsPath() {
    return path.join(homedir(), '.claude', 'settings.json');
}
export function buildClaudeCodeOtelEnv(endpoint, apiKey) {
    return {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_HEADERS: `x-hambros-api-key=${apiKey}`,
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_METRIC_EXPORT_INTERVAL: '5000',
        OTEL_LOG_USER_PROMPTS: '1',
    };
}
export async function mergeClaudeCodeEnv(vars, settingsPath = defaultClaudeSettingsPath()) {
    let existing = {};
    try {
        const raw = await readFile(settingsPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (isObject(parsed)) {
            existing = parsed;
        }
    }
    catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            // File doesn't exist yet — start fresh
        }
        else {
            throw error;
        }
    }
    const currentEnv = isObject(existing.env) ? { ...existing.env } : {};
    // Remove legacy keys from previous onboarding
    for (const key of LEGACY_KEYS) {
        delete currentEnv[key];
    }
    existing.env = {
        ...currentEnv,
        ...vars,
    };
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
}
