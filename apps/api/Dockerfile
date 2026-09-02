# syntax=docker/dockerfile:1
# Build a partir da RAIZ do monorepo:  docker build -f apps/api/Dockerfile -t escambo-api .
# (o docker-compose já usa o contexto correto)

# --- build ---
FROM node:22-alpine AS build
WORKDIR /repo
COPY . .
RUN npm ci \
 && npm run build --workspace @escambo/api \
 && npm prune --omit=dev

# --- runtime ---
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
# tini como init: encaminha sinais (SIGTERM) para o Node e faz reap de zumbis.
RUN apk add --no-cache tini
WORKDIR /repo
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/package.json ./package.json
COPY --from=build --chown=node:node /repo/packages/types ./packages/types
COPY --from=build --chown=node:node /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /repo/apps/api/dist ./apps/api/dist
WORKDIR /repo/apps/api
# Roda como usuário sem privilégios (o node:alpine já traz o usuário `node`).
USER node
EXPOSE 3333
# Readiness/liveness do container: usa o endpoint de liveness (não depende do banco).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3333/api/health/live',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
