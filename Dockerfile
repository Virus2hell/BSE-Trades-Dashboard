FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY shared ./shared
COPY bse-mock ./bse-mock
COPY dashboard ./dashboard
COPY scripts ./scripts
ENV NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
USER node
