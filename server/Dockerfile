FROM node:20-slim AS build
ARG VITE_API_BASE
ENV VITE_API_BASE=$VITE_API_BASE
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY prod-server.mjs accounts.mjs backup.mjs package.json ./
ENV NODE_ENV=production PORT=80 METRICS_PORT=9091
EXPOSE 80 9091
CMD ["node","prod-server.mjs"]
