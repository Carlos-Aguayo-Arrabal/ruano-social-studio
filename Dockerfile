FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

COPY package.json server.mjs index.html ./

# Carpeta de datos (inmuebles, contenidos y fotos). En Easypanel se monta un
# volumen en /app/data para que no se pierda en cada despliegue.
RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null || exit 1

CMD ["node", "server.mjs"]
