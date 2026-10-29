# MuseSwarm hosted public-demo image.
#
# Static assets: .dockerignore excludes museswarm-studio/dist (and node_modules,
# .env*, non-golden workspaces). server.js (~line 429) serves dist/ before public/,
# so omitting dist means this image serves public/ — the Studio bundle PR rebuilds
# that tree. We chose this over a Docker multi-stage `npm run build` of the Studio
# because museswarm-studio/** and public/** are owned by that bundle PR; copying a
# stale local dist would show judges an outdated UI.
FROM node:22-alpine

WORKDIR /app

RUN addgroup -S museswarm && adduser -S museswarm -G museswarm

COPY --chown=museswarm:museswarm . .

ENV NODE_ENV=production
ENV MUSE_SWARM_PUBLIC_DEMO=1
ENV PORT=4321

EXPOSE 4321

USER museswarm

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4321)+'/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
