# Node 24 strips TypeScript natively, so the worker can import the shared
# money helpers from web/src/lib/money.ts with no build step and no risk of the
# two copies of terminalStatus() drifting apart.
FROM node:24-alpine
WORKDIR /app
COPY worker/ ./worker/
COPY web/src/lib/money.ts ./web/src/lib/money.ts
WORKDIR /app/worker
CMD ["node", "index.mjs"]
