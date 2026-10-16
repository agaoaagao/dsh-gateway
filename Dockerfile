# syntax=docker/dockerfile:1
#
# dsh-gateway in a container.
#
# The image is deliberately thin. `@deepseek-ai/dsh` declares every bundle it can
# boot (`dsh-base`, `dsh-web-app`, and the rest) as its own runtime dependency, so
# one global install is a complete Harness: a profile resolves its bundles from
# the installation and needs no `pnpm install`, no lockfile and no build step.
# That was verified on a fresh DSH_HOME before this file was written.

FROM node:24-bookworm-slim

ARG DSH_VERSION=0.2.0-rc.2

ENV NODE_ENV=production \
    DSH_HOME=/srv/dsh \
    DSH_GATEWAY_HOME_ROOT=/srv/users \
    DSH_GATEWAY_STATE=/srv/gateway/state.json \
    DSH_GATEWAY_PROFILE=web \
    DSH_GATEWAY_PORT=8080 \
    DSH_GATEWAY_BIND=0.0.0.0

# pnpm is what `dsh plugin add` uses. It is not needed to boot, but a Harness
# image where installing a plugin fails is a trap, so enable it via corepack.
RUN corepack enable \
 && corepack prepare pnpm@10.18.0 --activate \
 || echo "dsh-gateway: corepack unavailable; 'dsh plugin add' will need pnpm installed first"

RUN npm install --global --no-fund --no-audit "@deepseek-ai/dsh@${DSH_VERSION}" \
 && npm cache clean --force \
 && dsh --version

# Seed the profile at build time so the image is bootable on its own. A volume
# mounted at /srv shadows it, and the entrypoint re-seeds in that case.
RUN dsh --profile web --dump-default-config > /dev/null \
 && test -f /srv/dsh/profiles/web/package.json

WORKDIR /app
COPY . /app
RUN chmod +x /app/docker/entrypoint.sh \
 && mkdir -p /srv/users /srv/gateway \
 && chown -R node:node /srv

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DSH_GATEWAY_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/docker/entrypoint.sh"]
