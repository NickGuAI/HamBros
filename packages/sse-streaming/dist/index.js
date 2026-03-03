function notImplemented(api) {
    throw new Error(`@hambros/sse-streaming scaffold: "${api}" is not implemented yet.`);
}
export async function* streamSSE(url, body, options = {}) {
    void url;
    void body;
    void options;
    notImplemented("streamSSE");
}
export function useSSE(url, body, options = {}) {
    void url;
    void body;
    void options;
    return notImplemented("useSSE");
}
export function sseResponse(response) {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders?.();
    return {
        send: (data) => {
            response.write(`data: ${JSON.stringify(data)}\n\n`);
        },
        close: () => {
            response.end();
        }
    };
}
//# sourceMappingURL=index.js.map