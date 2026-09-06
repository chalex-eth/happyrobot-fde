FROM node:22.16.0-bookworm-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
RUN npm ci --no-audit --no-fund
COPY --chown=node:node . .
RUN mkdir -p apps/web/.next tmp docs && chown node:node /app apps/web/.next tmp docs
USER node
EXPOSE 3000 3001
CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]
