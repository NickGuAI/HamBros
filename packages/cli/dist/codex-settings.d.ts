export interface CodexOtelConfig {
    endpoint: string;
    apiKey: string;
}
export declare function defaultCodexConfigPath(): string;
export declare function buildCodexOtelConfig(endpoint: string, apiKey: string): CodexOtelConfig;
/**
 * Merges Hammurabi OTEL configuration into ~/.codex/config.toml.
 *
 * Produces (inline-table form):
 *   [otel]
 *   log_user_prompt = true
 *   exporter = { otlp-http = { endpoint = "<endpoint>/v1/logs", protocol = "json", headers = { "x-hambros-api-key" = "<apiKey>" } } }
 */
export declare function mergeCodexOtelConfig(config: CodexOtelConfig, configPath?: string): Promise<void>;
//# sourceMappingURL=codex-settings.d.ts.map