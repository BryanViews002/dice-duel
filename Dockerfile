# Payout worker image.
#
# This lives at the REPO ROOT on purpose. Railway (and most PaaS builders) only
# auto-detect a Dockerfile at the root of the service directory; a custom path
# in railway.json is not reliably honoured, and the build silently falls through
# to language auto-detection, which cannot make sense of this repo.
#
# The build context must be the repo root either way, because the worker imports
# the shared money helpers from web/src/lib/money.ts. That single shared file is
# what stops terminalStatus() existing in two copies that can drift apart — and
# a drifted terminalStatus is how a PENDING payout gets refunded as FAILED.
#
# Node 24 strips TypeScript natively, so there is no build step.
FROM node:24-alpine

WORKDIR /app

COPY worker/ ./worker/
COPY web/src/lib/money.ts ./web/src/lib/money.ts

WORKDIR /app/worker

# Fail fast and loudly rather than restarting into a broken config.
ENV NODE_ENV=production

CMD ["node", "index.mjs"]
