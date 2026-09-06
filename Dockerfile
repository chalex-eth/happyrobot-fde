FROM node:22.16.0-bookworm-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --chown=node:node . .
RUN mkdir -p .next tmp docs && chown node:node /app .next tmp docs
USER node
EXPOSE 3000
# Development mode is intentional: the local console and screen OTP require it.
CMD ["node", "node_modules/next/dist/bin/next", "dev", "--hostname", "0.0.0.0"]
