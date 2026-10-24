FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

# Dependencias (SDK de Anthropic para los textos con IA)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.mjs index.html ./
COPY lib ./lib
COPY scripts/photo-storage.mjs ./scripts/photo-storage.mjs

# Carpeta de datos (inmuebles, contenidos y fotos). En Easypanel se monta un
# volumen en /app/data para que no se pierda en cada despliegue.
RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null || exit 1

CMD ["node", "server.mjs"]
