FROM node:20-slim
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
