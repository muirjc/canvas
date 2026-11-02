# canvas-1bty.4: the diagram-core bridge, a sidecar next to the Python service (canvas-api-py).
# Build from the repository root:
#   docker build -f packages/diagram-bridge/Dockerfile -t canvas-diagram-bridge .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/diagram-core/package.json packages/diagram-core/
COPY packages/diagram-bridge/package.json packages/diagram-bridge/
RUN npm ci --workspace=@canvas/diagram-bridge --include-workspace-root=false
COPY packages/diagram-core packages/diagram-core
COPY packages/diagram-bridge packages/diagram-bridge
# canvas-1bty.12: the AI chat's diagram tools and prompt sections, bundled from apps/api (src/ai.ts).
COPY apps/api/src/ai/diagram-tools.ts apps/api/src/ai/diagram-type-primers.ts apps/api/src/ai/standard-prompt.ts apps/api/src/ai/describe-model.ts apps/api/src/ai/
RUN npm run build --workspace=@canvas/diagram-bridge

FROM node:22-slim AS runtime
WORKDIR /app
COPY --from=build /app/packages/diagram-bridge/dist/bridge.mjs ./bridge.mjs
ENV BRIDGE_HOST=127.0.0.1 BRIDGE_PORT=7070 NODE_ENV=production
USER node
EXPOSE 7070
CMD ["node", "bridge.mjs"]
