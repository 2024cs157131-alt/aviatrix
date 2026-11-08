# One image, two process types: `web` (HTTPS API + WebSocket + static client) and `worker` (round engine).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY client ./client
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
RUN rm -rf server/test
COPY --from=build /app/client/dist ./client/dist
USER node
EXPOSE 3000
# Default: web. Run migrations as the platform's release/pre-deploy step: `npm run migrate`.
CMD ["node", "server/src/server.js"]
