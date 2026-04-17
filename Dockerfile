FROM node:22-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN mkdir -p /app/bookings /app/../bookings /tmp/souleora-bookings
EXPOSE 3003
ENV PORT=3003
ENV NODE_ENV=production
CMD ["node", "index.js"]
