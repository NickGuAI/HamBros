FROM node:22-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

RUN apk add --no-cache python3 make g++ linux-headers
RUN corepack enable

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ai-services/package.json ./packages/ai-services/package.json
COPY apps/herd/package.json ./apps/herd/package.json
COPY packages/auth-providers/package.json ./packages/auth-providers/package.json
COPY packages/herd-cli/package.json ./packages/herd-cli/package.json
COPY packages/sse-streaming/package.json ./packages/sse-streaming/package.json
COPY packages/telemetry/package.json ./packages/telemetry/package.json
COPY packages/transcription/package.json ./packages/transcription/package.json
COPY packages/tsconfig/package.json ./packages/tsconfig/package.json

RUN pnpm install --filter herd... --frozen-lockfile

COPY apps/herd ./apps/herd
COPY packages/ai-services ./packages/ai-services
COPY packages/auth-providers ./packages/auth-providers
COPY packages/herd-cli ./packages/herd-cli
COPY packages/sse-streaming ./packages/sse-streaming
COPY packages/telemetry ./packages/telemetry
COPY packages/transcription ./packages/transcription
COPY packages/tsconfig ./packages/tsconfig

RUN pnpm --filter herd run build

FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=20001
ENV HERD_DATA_DIR=/data/.herd
ENV HERD_PROVIDER_EXECUTION_MODE=daemon-only

RUN apk add --no-cache tini \
  && mkdir -p /data/.herd

COPY --from=build /workspace/package.json ./package.json
COPY --from=build /workspace/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/herd ./apps/herd
COPY --from=build /workspace/packages/ai-services ./packages/ai-services
COPY --from=build /workspace/packages/auth-providers ./packages/auth-providers
COPY --from=build /workspace/packages/herd-cli ./packages/herd-cli
COPY --from=build /workspace/packages/sse-streaming ./packages/sse-streaming
COPY --from=build /workspace/packages/telemetry ./packages/telemetry
COPY --from=build /workspace/packages/transcription ./packages/transcription
COPY --from=build /workspace/packages/tsconfig ./packages/tsconfig

WORKDIR /app/apps/herd

EXPOSE 20001

STOPSIGNAL SIGTERM

ENTRYPOINT ["/sbin/tini", "-g", "--"]
CMD ["node", "dist-server/server/index.js"]
