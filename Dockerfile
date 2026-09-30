# Backend del TMS para produccion.
#
# Dos etapas: la primera instala todo (TypeScript incluido) y compila; la
# segunda solo lleva las dependencias de produccion y el JavaScript compilado,
# asi la imagen final no carga el compilador ni los tipos.
#
# Node 24, la misma version con la que se desarrolla. La imagen oficial trae
# ICU completo, necesario para formatear las fechas en hora de Colombia
# (Intl con America/Bogota) al armar los documentos del RNDC.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Logo que se estampa en el manifiesto y la remesa (rndc/estampado.ts).
COPY assets ./assets

# Sin privilegios de root dentro del contenedor.
USER node
EXPOSE 3000

# Arranca el servidor; al iniciar aplica solo los cambios de esquema (db.ts).
CMD ["node", "dist/index.js"]
