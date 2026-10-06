FROM node:22-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json secretary-policy.json ./
COPY src ./src
COPY tests ./tests
RUN npm run check
RUN npm prune --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package*.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/secretary-policy.json ./secretary-policy.json

EXPOSE 8787
CMD ["npm", "start"]
