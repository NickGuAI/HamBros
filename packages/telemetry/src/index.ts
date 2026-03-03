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
  breakdown: { model: string; costUsd: number; requests: number }[];
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

function createRecordId(userId: string): string {
  return `${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeHeaderValue(value: string | string[] | null | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

export function extractOpenRouterCost(
  headers: Headers | Record<string, string | string[] | null | undefined>
): number | null {
  const value =
    headers instanceof Headers
      ? headers.get("x-openrouter-cost")
      : normalizeHeaderValue(
          headers["x-openrouter-cost"] ?? headers["X-OpenRouter-Cost"]
        );

  if (!value) {
    return null;
  }

  const numeric = Number.parseFloat(value.replace(/[^0-9.\-]+/g, ""));
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return numeric;
}

export function extractOpenRouterRateLimits(
  headers: Headers | Record<string, string | string[] | null | undefined>
): { requestLimit: number | null; tokenLimit: number | null } {
  const requestLimitRaw =
    headers instanceof Headers
      ? headers.get("x-ratelimit-requests-limit")
      : normalizeHeaderValue(
          headers["x-ratelimit-requests-limit"] ??
            headers["X-RateLimit-Requests-Limit"]
        );

  const tokenLimitRaw =
    headers instanceof Headers
      ? headers.get("x-ratelimit-tokens-limit")
      : normalizeHeaderValue(
          headers["x-ratelimit-tokens-limit"] ?? headers["X-RateLimit-Tokens-Limit"]
        );

  const requestLimit = requestLimitRaw ? Number.parseInt(requestLimitRaw, 10) : null;
  const tokenLimit = tokenLimitRaw ? Number.parseInt(tokenLimitRaw, 10) : null;

  return {
    requestLimit: Number.isFinite(requestLimit) ? requestLimit : null,
    tokenLimit: Number.isFinite(tokenLimit) ? tokenLimit : null
  };
}

export function calculateAICallCost(
  inputTokens: number,
  outputTokens: number,
  pricing: {
    inputPer1kUsd: number;
    outputPer1kUsd: number;
  }
): number {
  const inputCost = (inputTokens / 1000) * pricing.inputPer1kUsd;
  const outputCost = (outputTokens / 1000) * pricing.outputPer1kUsd;
  return Number((inputCost + outputCost).toFixed(6));
}

function periodStart(now: Date, period: UsagePeriod): Date | null {
  if (period === "all") {
    return null;
  }

  if (period === "day") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function filterByPeriod(records: AICallRecord[], now: Date, period: UsagePeriod): AICallRecord[] {
  const start = periodStart(now, period);
  if (!start) {
    return records;
  }

  return records.filter((record) => record.createdAt >= start);
}

export class InMemoryTelemetryStore implements TelemetryStore {
  private readonly callsByUser = new Map<string, AICallRecord[]>();
  private readonly quotaByUser = new Map<string, QuotaStatus>();

  async saveCall(record: AICallRecord): Promise<void> {
    const existing = this.callsByUser.get(record.userId) ?? [];
    existing.push({ ...record });
    this.callsByUser.set(record.userId, existing);
  }

  async listCalls(userId: string): Promise<AICallRecord[]> {
    const records = this.callsByUser.get(userId) ?? [];
    return records.map((record) => ({ ...record }));
  }

  async getQuota(userId: string): Promise<QuotaStatus | null> {
    const quota = this.quotaByUser.get(userId);
    return quota ? { ...quota } : null;
  }

  async setQuota(userId: string, quota: QuotaStatus): Promise<void> {
    this.quotaByUser.set(userId, { ...quota });
  }
}

function serializeQuota(quota: QuotaStatus): Record<string, unknown> {
  return {
    tierLimitUsd: quota.tierLimitUsd,
    balanceUsd: quota.balanceUsd,
    usedUsd: quota.usedUsd,
    periodEnd: quota.periodEnd?.toISOString() ?? null
  };
}

function deserializeQuota(raw: Record<string, unknown>): QuotaStatus {
  const periodEndRaw = raw.periodEnd;

  return {
    tierLimitUsd: Number(raw.tierLimitUsd ?? 0),
    balanceUsd: Number(raw.balanceUsd ?? 0),
    usedUsd: Number(raw.usedUsd ?? 0),
    periodEnd:
      typeof periodEndRaw === "string" && periodEndRaw.length > 0
        ? new Date(periodEndRaw)
        : null
  };
}

function serializeCall(record: AICallRecord): Record<string, unknown> {
  return {
    ...record,
    createdAt: record.createdAt.toISOString()
  };
}

function deserializeCall(raw: Record<string, unknown>): AICallRecord {
  return {
    id: String(raw.id),
    userId: String(raw.userId),
    model: String(raw.model),
    inputTokens: Number(raw.inputTokens ?? 0),
    outputTokens: Number(raw.outputTokens ?? 0),
    costUsd: Number(raw.costUsd ?? 0),
    provider: String(raw.provider),
    sessionId: raw.sessionId ? String(raw.sessionId) : undefined,
    metadata:
      raw.metadata && typeof raw.metadata === "object"
        ? (raw.metadata as Record<string, unknown>)
        : undefined,
    createdAt: new Date(String(raw.createdAt))
  };
}

export class PrismaTelemetryStore implements TelemetryStore {
  constructor(
    private readonly prismaClient: Record<string, any>,
    private readonly tables: { usage: string; quota: string } = {
      usage: "aiUsage",
      quota: "aiQuota"
    }
  ) {}

  async saveCall(record: AICallRecord): Promise<void> {
    await this.prismaClient[this.tables.usage].create({
      data: serializeCall(record)
    });
  }

  async listCalls(userId: string): Promise<AICallRecord[]> {
    const rows = await this.prismaClient[this.tables.usage].findMany({
      where: { userId }
    });

    return (rows as Record<string, unknown>[]).map(deserializeCall);
  }

  async getQuota(userId: string): Promise<QuotaStatus | null> {
    const row = await this.prismaClient[this.tables.quota].findUnique({
      where: { userId }
    });

    return row ? deserializeQuota(row as Record<string, unknown>) : null;
  }

  async setQuota(userId: string, quota: QuotaStatus): Promise<void> {
    await this.prismaClient[this.tables.quota].upsert({
      where: { userId },
      create: {
        userId,
        ...serializeQuota(quota)
      },
      update: serializeQuota(quota)
    });
  }
}

export class SupabaseTelemetryStore implements TelemetryStore {
  constructor(
    private readonly supabaseClient: Record<string, any>,
    private readonly tables: { usage: string; quota: string } = {
      usage: "ai_usage",
      quota: "ai_quota"
    }
  ) {}

  async saveCall(record: AICallRecord): Promise<void> {
    const payload = serializeCall(record);
    await this.supabaseClient.from(this.tables.usage).insert(payload);
  }

  async listCalls(userId: string): Promise<AICallRecord[]> {
    const response = await this.supabaseClient
      .from(this.tables.usage)
      .select("*")
      .eq("userId", userId);

    const rows = (response.data ?? []) as Record<string, unknown>[];
    return rows.map(deserializeCall);
  }

  async getQuota(userId: string): Promise<QuotaStatus | null> {
    const response = await this.supabaseClient
      .from(this.tables.quota)
      .select("*")
      .eq("userId", userId)
      .single();

    const row = response.data as Record<string, unknown> | null;
    return row ? deserializeQuota(row) : null;
  }

  async setQuota(userId: string, quota: QuotaStatus): Promise<void> {
    await this.supabaseClient.from(this.tables.quota).upsert({
      userId,
      ...serializeQuota(quota)
    });
  }
}

export interface TelemetryTrackerConfig {
  store?: TelemetryStore;
  defaultTierLimitUsd?: number;
  now?: () => Date;
}

export class DefaultTelemetryTracker implements TelemetryTracker {
  private readonly store: TelemetryStore;
  private readonly defaultTierLimitUsd: number;
  private readonly now: () => Date;

  constructor(config: TelemetryTrackerConfig = {}) {
    this.store = config.store ?? new InMemoryTelemetryStore();
    this.defaultTierLimitUsd = config.defaultTierLimitUsd ?? 0;
    this.now = config.now ?? (() => new Date());
  }

  async trackAICall(opts: TrackAICallOptions): Promise<void> {
    const record: AICallRecord = {
      ...opts,
      id: createRecordId(opts.userId),
      createdAt: opts.createdAt ?? this.now(),
      costUsd: opts.costUsd ?? 0
    };

    await this.store.saveCall(record);
  }

  async getUsage(userId: string, period: UsagePeriod): Promise<UsageSummary> {
    const records = filterByPeriod(await this.store.listCalls(userId), this.now(), period);

    const breakdownByModel = new Map<string, { model: string; costUsd: number; requests: number }>();
    const sessions = new Set<string>();

    let totalCostUsd = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const record of records) {
      totalCostUsd += record.costUsd;
      totalInputTokens += record.inputTokens;
      totalOutputTokens += record.outputTokens;
      if (record.sessionId) {
        sessions.add(record.sessionId);
      }

      const current =
        breakdownByModel.get(record.model) ??
        ({ model: record.model, costUsd: 0, requests: 0 } as const);
      breakdownByModel.set(record.model, {
        model: current.model,
        costUsd: current.costUsd + record.costUsd,
        requests: current.requests + 1
      });
    }

    const breakdown = [...breakdownByModel.values()].sort((a, b) => b.costUsd - a.costUsd);

    return {
      totalCostUsd: Number(totalCostUsd.toFixed(6)),
      totalInputTokens,
      totalOutputTokens,
      sessionCount: sessions.size,
      requestCount: records.length,
      breakdown
    };
  }

  async getUserQuota(userId: string): Promise<QuotaStatus> {
    const usage = await this.getUsage(userId, "month");
    const storedQuota = await this.store.getQuota(userId);

    const tierLimitUsd = storedQuota?.tierLimitUsd ?? this.defaultTierLimitUsd;
    const usedUsd = Number(usage.totalCostUsd.toFixed(6));
    const balanceUsd = Number(Math.max(tierLimitUsd - usedUsd, 0).toFixed(6));

    return {
      tierLimitUsd,
      usedUsd,
      balanceUsd,
      periodEnd: storedQuota?.periodEnd ?? null
    };
  }

  async setUserQuota(
    userId: string,
    quota: { tierLimitUsd: number; periodEnd?: Date | null }
  ): Promise<void> {
    const usage = await this.getUsage(userId, "month");

    await this.store.setQuota(userId, {
      tierLimitUsd: quota.tierLimitUsd,
      usedUsd: usage.totalCostUsd,
      balanceUsd: Number(Math.max(quota.tierLimitUsd - usage.totalCostUsd, 0).toFixed(6)),
      periodEnd: quota.periodEnd ?? null
    });
  }

  async enforceQuota(userId: string): Promise<boolean> {
    const quota = await this.getUserQuota(userId);
    return quota.usedUsd <= quota.tierLimitUsd;
  }
}

export function createTelemetryTracker(config: TelemetryTrackerConfig = {}): DefaultTelemetryTracker {
  return new DefaultTelemetryTracker(config);
}
