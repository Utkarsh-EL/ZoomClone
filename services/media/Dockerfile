FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203
WORKDIR /app
COPY services/media/package*.json ./
RUN npm ci --omit=dev
COPY services/media/kernel.mjs ./
COPY coordination/wire.ts coordination/logical-clock.ts ./coordination/
COPY media/kernel-fence.ts ./media/
USER node
CMD ["node", "kernel.mjs"]
