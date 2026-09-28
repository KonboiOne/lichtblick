# Build stage
ARG BASE_IMAGE_REGISTRY=docker.io
FROM ${BASE_IMAGE_REGISTRY}/library/node:22 AS build
WORKDIR /src
COPY . ./

RUN corepack enable
RUN yarn install --immutable

RUN yarn run web:build:prod

# Release stage
FROM ${BASE_IMAGE_REGISTRY}/library/caddy:2.10.2-alpine
RUN cp /usr/bin/caddy /usr/local/bin/caddy
WORKDIR /src
COPY --from=build /src/web/.webpack ./
COPY Caddyfile /etc/caddy/Caddyfile

EXPOSE 8080
USER 10001:10001
CMD ["/usr/local/bin/caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
