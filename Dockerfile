# Imagen ligera de Node
FROM node:20-slim

# Directorio de trabajo dentro del contenedor
WORKDIR /usr/src/app

# Copia package primero para usar cache
COPY package*.json ./

# Instala dependencias
RUN npm ci --omit=dev

# Copia el resto del código
COPY . .

# Cloud Run escucha en $PORT
ENV PORT=8080
EXPOSE 8080

# Arranque
CMD ["npm", "start"]
