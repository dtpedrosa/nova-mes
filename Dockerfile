FROM node:20-slim
WORKDIR /app

# Copy workspace manifests first for layer caching.
COPY package.json ./
COPY services/mes-web/package.json services/mes-web/package.json
COPY services/batch-service/package.json services/batch-service/package.json
COPY services/dispensing-service/package.json services/dispensing-service/package.json
COPY loadgen/package.json loadgen/package.json

# Workspace install hoists deps to /app/node_modules, which is on the module
# resolution path for services/shared/*.js and every service. Omit dev deps.
RUN npm install --omit=dev --workspaces --include-workspace-root

# Copy source.
COPY services services
COPY loadgen loadgen

ENV NODE_ENV=production
USER node
EXPOSE 4000 4001 4002
CMD ["node", "services/mes-web/server.js"]
