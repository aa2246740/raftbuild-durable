# raftd cloud image — build context is the REPO ROOT:
#   docker build -f deploy/Dockerfile -t raftd .
# (fly.toml at the repo root points here; never pack a checked-in tarball —
# the image must always carry the source it was built from.)
FROM node:24-slim
RUN apt-get update && apt-get install -y python3 python3-venv python3-pip && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate

WORKDIR /raftbuild-durable
# Install deps first for layer caching, then the full agent source.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/agent/package.json packages/agent/package.json
RUN pnpm install --frozen-lockfile
COPY packages/agent packages/agent

WORKDIR /app
COPY deploy/app /app/app
COPY deploy/pyproject.toml /app/pyproject.toml
RUN python3 -m venv /venv && /venv/bin/pip install .
ENV PATH=/venv/bin:$PATH
ENV RAFTD_REPO=/raftbuild-durable
ENV RAFTD_STATE=/data/raftd
ENV RAFTD_DATA=/data
RUN mkdir -p /data/raftd
EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
