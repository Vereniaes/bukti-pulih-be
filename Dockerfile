# Dockerfile
# -> multi-stage docker build untuk backend service bukti-pulih-be
#      -> stage 1 (builder): instalasi dependensi dan kompilasi typescript ke javascript
#      -> stage 2 (runner): container produksi minimal berbasis alpine untuk efisiensi cloud run

FROM node:24-alpine AS builder
WORKDIR /app

# salin berkas manifes dependensi paket ----------------------------------------
COPY package*.json tsconfig.json ./
RUN npm ci

# salin seluruh source code backend --------------------------------------------
COPY src ./src

# kompilasi berkas typescript ke javascript produksi ---------------------------
RUN npm run build

# tahap runner produksi minimal -----------------------------------------------
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# instalasi hanya dependensi produksi (tanpa devDependencies) -----------------
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# salin hasil kompilasi dari builder stage -------------------------------------
COPY --from=builder /app/dist ./dist

# buat pengguna non-root demi keamanan kontainer -------------------------------
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001 -G nodejs
USER nodejs

# port yang diexpose (cloud run mendengarkan pada port 8080) -------------------
EXPOSE 8080

CMD ["node", "dist/server.js"]
