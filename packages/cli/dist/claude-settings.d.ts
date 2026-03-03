export interface ClaudeCodeOtelEnvVars {
    CLAUDE_CODE_ENABLE_TELEMETRY: string;
    OTEL_EXPORTER_OTLP_ENDPOINT: string;
    OTEL_EXPORTER_OTLP_PROTOCOL: string;
    OTEL_EXPORTER_OTLP_HEADERS: string;
    OTEL_METRICS_EXPORTER: string;
    OTEL_LOGS_EXPORTER: string;
    OTEL_METRIC_EXPORT_INTERVAL: string;
    OTEL_LOG_USER_PROMPTS: string;
}
export declare function defaultClaudeSettingsPath(): string;
export declare function buildClaudeCodeOtelEnv(endpoint: string, apiKey: string): ClaudeCodeOtelEnvVars;
export declare function mergeClaudeCodeEnv(vars: ClaudeCodeOtelEnvVars, settingsPath?: string): Promise<void>;
//# sourceMappingURL=claude-settings.d.ts.map