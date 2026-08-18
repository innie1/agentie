FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

# package-lock.json is not committed in this worker, so use npm install.
# Keep production dependencies only for the Railway runtime.
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 4100

CMD ["node", "src/index.js"]
