FROM node:22-alpine
WORKDIR /app
COPY index.html server.js ./
COPY assets ./assets
ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server.js"]
