# debian
FROM node:24-trixie-slim

# install packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    tzdata \
    ca-certificates \
    curl \
    unzip \
    git \
    openssl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# timezone
ENV TZ=Asia/Tokyo
RUN ln -sf /usr/share/zoneinfo/$TZ /etc/localtime
