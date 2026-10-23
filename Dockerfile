FROM rust:1-alpine AS core
RUN apk add --no-cache musl-dev
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
COPY --from=core /build/target/release/neartrip /usr/local/bin/neartrip
RUN mkdir -p logs
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 2101 2102 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
