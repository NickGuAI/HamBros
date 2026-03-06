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

function notImplemented(api: string): never {
  throw new Error(
    `@gehirn/sse-streaming scaffold: "${api}" is not implemented yet.`
  );
}

export async function* streamSSE<T>(
  url: string,
  body: unknown,
  options: SSEOptions<T> = {}
): AsyncGenerator<T> {
  void url;
  void body;
  void options;
  notImplemented("streamSSE");
}

export function useSSE<T>(
  url: string,
  body: unknown,
  options: SSEOptions<T> = {}
): UseSSEResult<T> {
  void url;
  void body;
  void options;
  return notImplemented("useSSE");
}

export function sseResponse(response: ServerSentEventResponse): {
  send: (data: unknown) => void;
  close: () => void;
} {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders?.();

  return {
    send: (data: unknown) => {
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    },
    close: () => {
      response.end();
    }
  };
}
