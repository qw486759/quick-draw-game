# syntax=docker/dockerfile:1

FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

RUN npm ci --omit=dev

COPY backend ./backend
COPY frontend ./frontend

EXPOSE 3000

CMD ["npm", "start"]