FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
COPY packages/core ./packages/core
COPY apps/engine-server ./apps/engine-server
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci && npm run build -w @chessin/engine-server

FROM node:24-bookworm-slim AS native
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN set -eu; case "$TARGETARCH" in \
 amd64) arch=x86-64; digest=9defc0d4e55d49c65a6d042f3e571a39fcea499ade6dbe741b53b8c65e03611f ;; \
 arm64) arch=arm64; digest=fe26cfd1d9db4c8af3d21e24d9ff34cacb31c1f940085a7583da11796f2bac01 ;; \
 *) echo "Unsupported container architecture: $TARGETARCH" >&2; exit 1 ;; esac; \
 curl --fail --location --retry 3 -o /tmp/stockfish.tar.gz "https://github.com/official-stockfish/Stockfish/releases/download/sf_19/stockfish-linux-$arch-universal.tar.gz"; \
 echo "$digest  /tmp/stockfish.tar.gz" | sha256sum -c -; \
 tar -xzf /tmp/stockfish.tar.gz -C /opt; \
 ln -s "/opt/stockfish/stockfish-linux-$arch-universal" /opt/stockfish/chessin-engine

FROM node:24-bookworm-slim
ENV NODE_ENV=production CHESSIN_HOST=0.0.0.0 CHESSIN_PORT=8787 STOCKFISH_PATH=/opt/stockfish/chessin-engine
WORKDIR /app
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/packages/core ./packages/core
COPY --from=build /build/apps/engine-server ./apps/engine-server
COPY --from=native /opt/stockfish /opt/stockfish
USER node
EXPOSE 8787
CMD ["node", "--import", "tsx", "apps/engine-server/src/server.ts"]
