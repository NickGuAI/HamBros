export type UsagePeriod = "day" | "month" | "all";
export interface TrackAICallOptions {
    userId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd?: number;
    provider: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
    createdAt?: Date;
}
export interface AICallRecord extends TrackAICallOptions {
    id: string;
    costUsd: number;
    createdAt: Date;
}
export interface UsageSummary {
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    sessionCount: number;
    requestCount: number;
    breakdown: {
        model: string;
        costUsd: number;
        requests: number;
    }[];
}
export interface QuotaStatus {
    tierLimitUsd: number;
    balanceUsd: number;
    usedUsd: number;
    periodEnd: Date | null;
}
export interface TelemetryTracker {
    trackAICall(opts: TrackAICallOptions): Promise<void>;
    getUsage(userId: string, period: UsagePeriod): Promise<UsageSummary>;
    getUserQuota(userId: string): Promise<QuotaStatus>;
    enforceQuota(userId: string): Promise<boolean>;
}
export interface TelemetryStore {
    saveCall(record: AICallRecord): Promise<void>;
    listCalls(userId: string): Promise<AICallRecord[]>;
    getQuota(userId: string): Promise<QuotaStatus | null>;
    setQuota(userId: string, quota: QuotaStatus): Promise<void>;
}
export declare function extractOpenRouterCost(headers: Headers | Record<string, string | string[] | null | undefined>): number | null;
export declare function extractOpenRouterRateLimits(headers: Headers | Record<string, string | string[] | null | undefined>): {
    requestLimit: number | null;
    tokenLimit: number | null;
};
export declare function calculateAICallCost(inputTokens: number, outputTokens: number, pricing: {
    inputPer1kUsd: number;
    outputPer1kUsd: number;
}): number;
export declare class InMemoryTelemetryStore implements TelemetryStore {
    private readonly callsByUser;
    private readonly quotaByUser;
    saveCall(record: AICallRecord): Promise<void>;
    listCalls(userId: string): Promise<AICallRecord[]>;
    getQuota(userId: string): Promise<QuotaStatus | null>;
    setQuota(userId: string, quota: QuotaStatus): Promise<void>;
}
export declare class PrismaTelemetryStore implements TelemetryStore {
    private readonly prismaClient;
    private readonly tables;
    constructor(prismaClient: Record<string, any>, tables?: {
        usage: string;
        quota: string;
    });
    saveCall(record: AICallRecord): Promise<void>;
    listCalls(userId: string): Promise<AICallRecord[]>;
    getQuota(userId: string): Promise<QuotaStatus | null>;
    setQuota(userId: string, quota: QuotaStatus): Promise<void>;
}
export declare class SupabaseTelemetryStore implements TelemetryStore {
    private readonly supabaseClient;
    private readonly tables;
    constructor(supabaseClient: Record<string, any>, tables?: {
        usage: string;
        quota: string;
    });
    saveCall(record: AICallRecord): Promise<void>;
    listCalls(userId: string): Promise<AICallRecord[]>;
    getQuota(userId: string): Promise<QuotaStatus | null>;
    setQuota(userId: string, quota: QuotaStatus): Promise<void>;
}
export interface TelemetryTrackerConfig {
    store?: TelemetryStore;
    defaultTierLimitUsd?: number;
    now?: () => Date;
}
export declare class DefaultTelemetryTracker implements TelemetryTracker {
    private readonly store;
    private readonly defaultTierLimitUsd;
    private readonly now;
    constructor(config?: TelemetryTrackerConfig);
    trackAICall(opts: TrackAICallOptions): Promise<void>;
    getUsage(userId: string, period: UsagePeriod): Promise<UsageSummary>;
    getUserQuota(userId: string): Promise<QuotaStatus>;
    setUserQuota(userId: string, quota: {
        tierLimitUsd: number;
        periodEnd?: Date | null;
    }): Promise<void>;
    enforceQuota(userId: string): Promise<boolean>;
}
export declare function createTelemetryTracker(config?: TelemetryTrackerConfig): DefaultTelemetryTracker;
//# sourceMappingURL=index.d.ts.map