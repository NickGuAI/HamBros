export interface SSEOptions<T> {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    parse?: (raw: string) => T;
    onError?: (error: Error) => void;
}
export interface UseSSEResult<T> {
    data: T[];
    isStreaming: boolean;
    error: Error | null;
    abort: () => void;
}
export interface ServerSentEventResponse {
    setHeader: (name: string, value: string) => void;
    write: (chunk: string) => void;
    end: () => void;
    flushHeaders?: () => void;
}
export declare function streamSSE<T>(url: string, body: unknown, options?: SSEOptions<T>): AsyncGenerator<T>;
export declare function useSSE<T>(url: string, body: unknown, options?: SSEOptions<T>): UseSSEResult<T>;
export declare function sseResponse(response: ServerSentEventResponse): {
    send: (data: unknown) => void;
    close: () => void;
};
//# sourceMappingURL=index.d.ts.map