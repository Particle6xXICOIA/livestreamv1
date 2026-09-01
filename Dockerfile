FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# The platform server: viewer page + HLS + chat + episode control.
ENV NODE_ENV=production
EXPOSE 8080
CMD ["npx", "tsx", "src/server.ts"]
