FROM node:20-bullseye-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    for i in 1 2 3; do \
        apt-get update && apt-get install -y --no-install-recommends \
            python3 \
            ffmpeg \
            ca-certificates \
            curl && break || sleep 5; \
    done; \
    curl -fL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp; \
    chmod a+rx /usr/local/bin/yt-dlp; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
