FROM node:18

WORKDIR /usr/src/app

# Copia package.json
COPY package*.json ./
RUN npm install

# Copia TODO (incluye index.html / public)
COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
