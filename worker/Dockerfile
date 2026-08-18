FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache python3 git
RUN git clone --depth 1 https://github.com/mvanhorn/last30days-skill.git /opt/last30days

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV LAST30DAYS_PYTHON=python3
ENV LAST30DAYS_SCRIPT=/opt/last30days/skills/last30days/scripts/last30days.py

EXPOSE 4100

CMD ["node", "src/index.js"]
