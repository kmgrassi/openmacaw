# ── Build stage ──────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/.npmrc ./apps/api/
COPY packages/plan-schema/package.json ./packages/plan-schema/
COPY packages/supabase-schema/package.json ./packages/supabase-schema/
RUN corepack enable && pnpm install --frozen-lockfile --filter symphony-express-server...

COPY apps/api/tsconfig.json ./apps/api/tsconfig.json
COPY apps/api/tsconfig.build.json ./apps/api/tsconfig.build.json
COPY apps/api/src/ ./apps/api/src/
COPY packages/plan-schema/ ./packages/plan-schema/
COPY packages/supabase-schema/ ./packages/supabase-schema/
COPY contracts/ ./contracts/
RUN pnpm --filter @harper/plan-schema run build
RUN pnpm --filter @kmgrassi/supabase-schema run build
# Use build-specific tsconfig that excludes test files. Production
# image must not be held hostage by test-only type errors, and tests
# don't belong in the runtime image anyway. `pnpm run typecheck` and
# IDEs still use tsconfig.json which includes everything.
RUN pnpm --filter symphony-express-server exec tsc -p tsconfig.build.json

# ── Production stage ────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY .npmrc package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/.npmrc ./apps/api/
COPY packages/plan-schema/package.json ./packages/plan-schema/
COPY packages/supabase-schema/package.json ./packages/supabase-schema/
RUN corepack enable && pnpm install --frozen-lockfile --prod --filter symphony-express-server...
COPY --from=builder /app/packages/plan-schema ./packages/plan-schema
COPY --from=builder /app/packages/supabase-schema ./packages/supabase-schema

COPY --from=builder /app/apps/api/dist ./apps/api/dist

EXPOSE 3100

USER node

CMD ["node", "apps/api/dist/apps/api/src/index.js"]
