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
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/packages/types ./packages/types
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build /repo/apps/api/dist ./apps/api/dist
WORKDIR /repo/apps/api
EXPOSE 3333
CMD ["node", "dist/server.js"]
