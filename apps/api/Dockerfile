FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY apps/api ./apps/api
EXPOSE 4000
CMD ["node", "apps/api/src/server.js"]
