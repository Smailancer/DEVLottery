FROM node:20-alpine
WORKDIR /app
COPY index.html server.js ./
COPY assets ./assets
ENV PORT=3000 DATA_FILE=/data/db.json
EXPOSE 3000
CMD ["node", "server.js"]
