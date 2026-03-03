export interface ValidateApiKeyInput {
    endpoint: string;
    apiKey: string;
    fetchImpl?: typeof fetch;
}
export type ApiKeyValidationResult = {
    ok: true;
    validationUrl: string;
} | {
    ok: false;
    code: 'invalid_endpoint' | 'invalid_key' | 'unauthorized' | 'forbidden' | 'network' | 'unexpected';
    message: string;
    status?: number;
    validationUrl?: string;
};
/**
 * Validate a telemetry write API key by sending a minimal OTLP log payload
 * to `POST /v1/logs`. This verifies both connectivity and auth in one shot.
 */
export declare function validateTelemetryWriteKey(input: ValidateApiKeyInput): Promise<ApiKeyValidationResult>;
//# sourceMappingURL=validate.d.ts.map