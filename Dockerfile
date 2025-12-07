FROM node:20-alpine

# Set working directory
WORKDIR /usr/src/app

# Install dependencies first (leveraging Docker layer cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the application code
COPY . .

# Environment variables (override via docker-compose or runtime env vars)
ENV BOT_TOKEN="" \
    API_URL="https://matchinghub.work" \
    BACKEND_API_BASE_URL="" \
    MERCURE_HUB_URL="https://matchinghub.work/.well-known/mercure" \
    MERCURE_SUBSCRIBER_JWT="" \
    MERCURE_JWT=""

CMD ["npm", "start"]
