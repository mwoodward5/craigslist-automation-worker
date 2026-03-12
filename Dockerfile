FROM ghcr.io/puppeteer/puppeteer:21.6.1

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js poster.js zipLookup.js zip-to-cl.json ./

EXPOSE 3000

CMD ["node", "server.js"]
