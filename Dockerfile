# syntax=docker/dockerfile:1
# heel's OCI image (D14). heel runs its TypeScript directly on Node 26, so
# nothing is compiled: the image holds the production dependencies and the
# source. bubblewrap is installed for `heel run` and code mode; the sandbox
# also needs the container to allow user namespaces (see docs).

FROM node:26.13.1-bookworm-slim AS deps
WORKDIR /app
# Native dependencies (better-sqlite3, the sandbox's seccomp helper) build here.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.18.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:26.13.1-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap util-linux ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN useradd --system --create-home --home-dir /var/lib/heel heel
WORKDIR /opt/heel
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY assets/logo ./assets/logo
COPY examples/heel.yaml /etc/heel/heel.yaml
# `docker exec heel heel <command>` for admin commands.
RUN ln -s /opt/heel/bin/heel.js /usr/local/bin/heel
ENV HEEL_HOME=/var/lib/heel \
  HEEL_CONFIG=/etc/heel/heel.yaml \
  NODE_ENV=production
USER heel
VOLUME ["/var/lib/heel"]
EXPOSE 7300 7301
ENTRYPOINT ["node", "/opt/heel/bin/heel.js"]
CMD ["serve"]
