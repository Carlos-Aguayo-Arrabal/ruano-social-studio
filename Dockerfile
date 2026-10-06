FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY app.mjs db.mjs security.mjs state.mjs login.mjs schema.sql index.html saas-client.js ./
COPY scripts ./scripts
ENV NODE_ENV=production PORT=3000
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1
CMD ["node", "app.mjs"]
