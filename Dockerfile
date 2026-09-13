FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

RUN mkdir -p /app/data

ENV WEB_PORT=18080 \
    TRAP_PORTS=2222,2375,3389,5900,6379,9200,1337 \
    DATA_DIR=/app/data

EXPOSE 18080 2222 2375 3389 5900 6379 9200 1337

CMD ["node", "server.js"]
