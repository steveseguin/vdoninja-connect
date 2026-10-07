FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8788 UV_THREADPOOL_SIZE=1 RAYON_NUM_THREADS=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
RUN mkdir /data && chown node:node /data
USER node
ENV VDONINJA_HOSTED_DATA=/data
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/hosted.mjs"]
