# syntax=docker/dockerfile:1
# Build a partir da RAIZ do monorepo:  docker build -f apps/web/Dockerfile -t escambo-web .
# (o docker-compose já usa o contexto correto)

# --- build (tsc + Vite) ---
FROM node:22-alpine AS build
WORKDIR /repo
COPY . .
RUN npm ci \
 && npm run build --workspace @escambo/web

# --- runtime: nginx sem root (usuário nginx, porta 8080) servindo o SPA + proxy da API ---
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
