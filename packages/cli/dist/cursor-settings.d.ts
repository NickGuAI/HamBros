export interface CursorOtelEnvVars {
    OTEL_EXPORTER_OTLP_ENDPOINT: string;
    OTEL_EXPORTER_OTLP_PROTOCOL: string;
    OTEL_EXPORTER_OTLP_HEADERS: string;
}
export declare function defaultCursorSettingsPath(): string;
export declare function buildCursorOtelEnv(endpoint: string, apiKey: string): CursorOtelEnvVars;
export declare function mergeCursorEnv(vars: CursorOtelEnvVars, settingsPath?: string): Promise<void>;
//# sourceMappingURL=cursor-settings.d.ts.map