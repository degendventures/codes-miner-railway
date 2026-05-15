# Build stage for Rust
FROM rust:1.85-slim-bookworm AS builder

WORKDIR /app
COPY native-miner ./native-miner
WORKDIR /app/native-miner
RUN cargo build --release

# Final stage
FROM node:20-slim

# Install necessary runtime dependencies
RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built binary from builder
COPY --from=builder /app/native-miner/target/release/codes-native-miner /app/native-miner/target/release/codes-native-miner

# Copy node app files
COPY package.json ./
RUN npm install

COPY . .

# Set default env for binary path
ENV NATIVE_BIN=/app/native-miner/target/release/codes-native-miner

CMD ["node", "mine-native.mjs"]
