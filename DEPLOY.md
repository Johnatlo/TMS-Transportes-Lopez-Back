# Despliegue con Docker

Todo corre en tres contenedores, definidos en `docker-compose.yml`:

| Servicio | Qué hace | Visible desde fuera |
|---|---|---|
| `caddy` | Sirve el frontend compilado y pasa `/api` al backend | Sí, puerto 80 (HTTP) |
| `backend` | Servidor Node del TMS | No |
| `mysql` | MySQL 8.4 con los datos en el volumen `mysql-data` | No |

El acceso es **solo por Tailscale**: HTTP simple, sin HTTPS. Tailscale ya cifra
el tráfico entre los equipos. **No abras el puerto 80 a internet** ni lo
redirijas en el router.

> `DESPLIEGUE.md` describe la instalación anterior, sin Docker (XAMPP y tarea
> programada de Windows). Esta guía la reemplaza cuando se usa Docker.

---

## 1. Preparar el servidor

1. Instalar **Docker** (Docker Engine con el plugin `compose`, o Docker Desktop)
   y **Tailscale**, e iniciar sesión en Tailscale con la cuenta de la empresa.
2. Clonar los dos repositorios **lado a lado** en la misma carpeta:

   ```bash
   git clone https://github.com/Johnatlo/TMS-Transportes-Lopez-Back.git backend
   git clone https://github.com/Johnatlo/TMS-Transportes-Lopez-Front-React.git frontend-react
   ```

   Quedan `backend/` y `frontend-react/` como carpetas hermanas: el compose
   busca el frontend en `../frontend-react/dist`.

## 2. Compilar el frontend

Caddy sirve el frontend ya compilado. Con Node instalado en el servidor:

```bash
cd frontend-react
npm ci
npm run build          # genera frontend-react/dist
```

Sin Node en el servidor, con Docker:

```bash
cd frontend-react
docker run --rm -v "$PWD":/app -w /app node:24-bookworm-slim sh -c "npm ci && npm run build"
```

## 3. Configurar las variables

```bash
cd backend
cp .env.production.example .env.production
```

Llenar `.env.production`. Lo mínimo:

- **Base de datos:** `DB_PASSWORD` y `MYSQL_ROOT_PASSWORD`, dos claves largas y
  distintas. Solo se usan dentro de Docker.
- **RNDC:** `RNDC_USUARIO`, `RNDC_PASSWORD`, `RNDC_EMPRESA_NIT` y
  `RNDC_ULTIMO_CONSECUTIVO`.
- **Empresa:** las variables `EMPRESA_*`, que salen en la remesa impresa.
- **Correo:** `SMTP_USUARIO` y `SMTP_CLAVE`, con una contraseña de aplicación
  de Gmail.
- **Acceso:** `HTTP_BIND` con la IP de Tailscale del servidor (`tailscale ip -4`).
  Así el puerto 80 solo responde por Tailscale y no por la red local.

**Ambiente del RNDC.** El ejemplo arranca en `pruebas` con `RNDC_SIMULAR=true`.
Para operar de verdad:

```
RNDC_AMBIENTE=produccion
RNDC_SIMULAR=false
RNDC_CONFIRMO_PRODUCCION="SI, EXPEDIR DOCUMENTOS REALES"
```

La frase la escribe la persona responsable. Sin ella, el backend no arranca en
producción.

Si alguna clave tiene el signo `$`, va entre comillas simples:
`RNDC_PASSWORD='abc$123'`.

## 4. Levantar

Siempre con `--env-file .env.production`: sin él, compose se detiene avisando
qué variable falta.

```bash
cd backend
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production ps        # los tres en "running" / "healthy"
docker compose --env-file .env.production logs -f backend
```

En el log del backend debe salir el ambiente del RNDC activo
(`SIMULACION`, `PRUEBAS` o `!!! PRODUCCION - DOCUMENTOS REALES !!!`). Al
arrancar, el backend crea o actualiza las tablas solo.

Desde otro equipo o celular conectado a Tailscale:
`http://NOMBRE-DEL-SERVIDOR` (nombre en Tailscale) o `http://100.x.y.z`.

Los contenedores tienen `restart: unless-stopped`: vuelven solos si el
servidor se reinicia, mientras Docker arranque con el sistema.

## 5. Pasar los datos actuales (primera vez)

Si ya hay datos en la MariaDB de XAMPP, se pasan con el último respaldo antes
de que nadie use el sistema nuevo.

1. En el equipo actual: `npm run respaldo` en `backend/`. Deja un `.sql.gz` en
   `../respaldos/`.
2. Llevar ese archivo al servidor y cargarlo en el contenedor, con el backend
   detenido:

   ```bash
   docker compose --env-file .env.production stop backend
   gunzip -c rndc_tms-AAAA-MM-DD_HHMM.sql.gz | \
     docker compose --env-file .env.production exec -T mysql \
     sh -c 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"'
   docker compose --env-file .env.production start backend
   ```

3. Entrar y revisar que estén los viajes, los usuarios y el siguiente número de
   despacho.

El respaldo viene de MariaDB y se carga en MySQL 8. Las consultas del sistema
se probaron con el modo estricto de MySQL 8 (`ONLY_FULL_GROUP_BY`), pero la
**primera importación se debe revisar** antes de operar.

## 6. Usuarios

Crear el primero (o cualquiera) desde el contenedor:

```bash
docker compose --env-file .env.production exec backend \
  node dist/scripts/crear-usuario.js correo@empresa.com "Nombre Apellido"
```

Probar el correo:

```bash
docker compose --env-file .env.production exec backend \
  node dist/scripts/probar-correo.js destino@correo.com
```

## 7. Respaldos

`npm run respaldo` es para la instalación sin Docker. Con Docker, el volcado se
saca del contenedor de MySQL:

```bash
mkdir -p ../respaldos
docker compose --env-file .env.production exec -T mysql \
  sh -c 'mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers "$MYSQL_DATABASE"' \
  | gzip > ../respaldos/rndc_tms-$(date +%F_%H%M).sql.gz
```

Programarlo a diario (cron en Linux, por ejemplo a las 23:30), borrar los de más
de 30 días y copiar la carpeta `respaldos/` **fuera del servidor**. Un respaldo
en el mismo disco no sirve si el disco falla.

Los datos viven en el volumen `mysql-data`. `docker compose down` lo conserva;
**`docker compose down -v` lo borra**: no usar `-v`.

## 8. Actualizar a una versión nueva

```bash
cd frontend-react && git pull && npm ci && npm run build
cd ../backend && git pull
docker compose --env-file .env.production up -d --build
```

Caddy toma el frontend nuevo de inmediato (lee la carpeta `dist`). Los
navegadores cargan la versión nueva sin borrar la caché: `index.html` va sin
caché y los archivos de `/assets` llevan un hash en el nombre.

## 9. Lista para el día del lanzamiento

- [ ] Respaldo de la base actual y carga en el contenedor (sección 5).
- [ ] `HTTP_BIND` con la IP de Tailscale; comprobar que desde fuera de Tailscale
      no responde.
- [ ] Usuarios creados y correo probado (sección 6).
- [ ] Siguiente número de despacho correcto.
- [ ] Respaldo diario programado y copiado fuera del servidor.
- [ ] Desde ese día, no expedir desde el portal del RNDC con la misma numeración.
- [ ] Cumplir remesas y manifiestos dentro de los 5 días hábiles (botón
      *Cumplir* en Viajes).
