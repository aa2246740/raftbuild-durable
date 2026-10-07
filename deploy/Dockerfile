FROM node:24-slim
RUN apt-get update && apt-get install -y python3 python3-venv python3-pip && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
WORKDIR /app
COPY repo.tar.gz /repo.tar.gz
RUN mkdir -p /raftbuild-durable && tar -xzf /repo.tar.gz -C /raftbuild-durable && rm /repo.tar.gz
RUN cd /raftbuild-durable && pnpm install --frozen-lockfile
COPY . /app
RUN python3 -m venv /venv && /venv/bin/pip install fastapi uvicorn httpx
ENV PATH=/venv/bin:$PATH
ENV RAFTD_STATE=/data/raftd
RUN mkdir -p /data/raftd
EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
