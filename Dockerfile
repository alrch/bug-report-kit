FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY widget widget
COPY shared shared
COPY scripts/build-widget.mjs scripts/html2canvas-patches.mjs scripts/
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist dist
COPY server server
COPY shared shared
COPY dashboard dashboard
COPY widget/widget.css widget/widget.css
COPY scripts/backup.mjs scripts/backup.mjs
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 7337
CMD ["node", "server/index.mjs"]
