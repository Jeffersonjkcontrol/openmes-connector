FROM node:22-alpine

WORKDIR /app

# Sem dependências externas: só o código.
COPY package.json ./
COPY src ./src

RUN mkdir -p /app/data && chown node:node /app/data
USER node

ENV NODE_ENV=production \
    CONFIG_FILE=/app/config.json \
    STATE_FILE=/app/data/state.json

# Estado (cursor e ids já entregues) — monte um volume para não reler tudo a cada deploy.
VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
