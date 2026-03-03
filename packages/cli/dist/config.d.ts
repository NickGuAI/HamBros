export declare const HAMMURABI_CONFIG_FILENAME = ".hambros.json";
export declare const HAMMURABI_AGENTS: readonly ["claude-code", "codex", "terminal-cri", "cursor", "anti-gravity"];
export type HammurabiAgent = (typeof HAMMURABI_AGENTS)[number];
export interface HammurabiConfig {
    endpoint: string;
    apiKey: string;
    agents: HammurabiAgent[];
    configuredAt: string;
}
interface CreateConfigInput {
    endpoint: string;
    apiKey: string;
    agents: readonly HammurabiAgent[];
    configuredAt?: Date;
}
export declare function normalizeEndpoint(endpoint: string): string;
export declare function isHammurabiAgent(value: string): value is HammurabiAgent;
export declare function defaultConfigPath(): string;
export declare function createHammurabiConfig(input: CreateConfigInput): HammurabiConfig;
export declare function readHammurabiConfig(configPath?: string): Promise<HammurabiConfig | null>;
export declare function writeHammurabiConfig(config: HammurabiConfig, configPath?: string): Promise<void>;
export {};
//# sourceMappingURL=config.d.ts.map