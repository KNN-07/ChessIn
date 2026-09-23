FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY . .
RUN npm ci && npm run prepare:engines && node scripts/prepare-app-source.mjs && npm run build -w @chessin/web
FROM nginx:1.28-bookworm
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /build/apps/web/dist /usr/share/nginx/html
EXPOSE 80
