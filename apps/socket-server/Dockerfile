# Multi-stage build. Deploy-ready but not deployed by this repo's tooling —
# Epic 09 Story 5 covers actually standing this up on Fly.io/Railway. Either
# host can point straight at this Dockerfile with apps/socket-server as the
# build context.

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist

EXPOSE 4001
CMD ["node", "dist/index.js"]
