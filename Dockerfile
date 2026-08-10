FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 \
       python3-venv \
       libgl1 \
       libglib2.0-0 \
       libgomp1 \
    && python3 -m venv /opt/venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

COPY --chown=node:node package.json server.mjs index.html app.js styles.css ./
COPY --chown=node:node scripts ./scripts

RUN mkdir -p /app/data && chown node:node /app/data

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    SIVAN_PORT=8766 \
    SIVAN_PYTHON=/opt/venv/bin/python \
    PYTHONDONTWRITEBYTECODE=1

USER node

CMD ["node", "server.mjs"]
