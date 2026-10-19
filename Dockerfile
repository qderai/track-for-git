# Track for Git in a container: Node 24 with its built-in SQLite, no other dependency.
#   docker build -t track-for-git .
#   docker run -p 8787:8787 -v track-data:/data --env-file .env track-for-git
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY server ./server
COPY public ./public
COPY migrations ./migrations
ENV NODE_ENV=production PORT=8787 DATABASE_PATH=/data/track.db
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "server/node.js"]
