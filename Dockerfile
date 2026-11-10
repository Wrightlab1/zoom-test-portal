# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    ZTP_DATA_DIR=/data \
    ZTP_KEY_FILE=/secrets/master.key \
    # Inside the container the admin listener must bind 0.0.0.0 to be reachable through the
    # published port. compose publishes it on the HOST's 127.0.0.1 only.
    ZTP_ADMIN_HOST=0.0.0.0 \
    ZTP_ADMIN_ALLOW_NON_LOOPBACK=1 \
    ZTP_ADMIN_PORT=4800 \
    # The public listener stays on the container's loopback: only the in-process ngrok
    # tunnel connects to it, so it is never published.
    ZTP_PUBLIC_HOST=127.0.0.1 \
    ZTP_PUBLIC_PORT=4801
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data /secrets && chown node:node /data /secrets && chmod 700 /data /secrets
USER node
VOLUME ["/data", "/secrets"]
EXPOSE 4800
CMD ["node", "dist/server/index.js"]
