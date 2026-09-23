FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY models.json ./models.json
# `proxyctl login|logout|status`, usable via `docker compose exec`.
COPY bin/proxyctl /usr/local/bin/proxyctl
RUN chmod +x /usr/local/bin/proxyctl
EXPOSE 8080
ENTRYPOINT ["node", "dist/index.js"]
CMD ["serve"]
