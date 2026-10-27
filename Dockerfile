FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY widget widget
COPY shared shared
COPY scripts/build-widget.mjs scripts/html2canvas-patches.mjs scripts/
RUN npm run build

FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist dist
COPY server server
COPY shared shared
COPY dashboard dashboard
COPY widget/widget.css widget/widget.css
COPY widget/loading-ui.js widget/loading-ui.js
COPY scripts/backup.mjs scripts/backup.mjs
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 7337
CMD ["node", "server/index.mjs"]

# Keep Python/model layers independent of application source for repeatable updates.
FROM node:24-bookworm-slim AS speech-deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv libgomp1 && rm -rf /var/lib/apt/lists/*
COPY scripts/speech-requirements.txt scripts/prepare-speech-model.py /tmp/speech/
RUN python3 -m venv /opt/bug-kit/speech && /opt/bug-kit/speech/bin/pip install --no-cache-dir -r /tmp/speech/speech-requirements.txt
RUN /opt/bug-kit/speech/bin/python /tmp/speech/prepare-speech-model.py /opt/bug-kit/models/small

FROM speech-deps AS speech
WORKDIR /app
COPY --from=base /app /app
COPY scripts/transcribe.py scripts/transcribe.py
RUN chown node:node /app/data
ENV NODE_ENV=production BUG_KIT_SPEECH_ENABLED=1 BUG_KIT_SPEECH_PYTHON=/opt/bug-kit/speech/bin/python BUG_KIT_SPEECH_MODEL=/opt/bug-kit/models/small BUG_KIT_SPEECH_LANGUAGE=ru HF_HUB_OFFLINE=1
USER node
EXPOSE 7337
CMD ["node", "server/index.mjs"]

# Preserve the lightweight default build for existing non-speech installations.
FROM base AS runtime
