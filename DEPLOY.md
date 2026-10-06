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

## 7. Borrar viajes de prueba

Los viajes simulados (radicados `SIMULADO-...`) y los hechos contra el servidor
de pruebas del Ministerio (radicados desde 900.000.000) no existen en
producción: fallan al imprimir y su número queda como usado. Se borran con:

```bash
# Cuáles se pueden borrar
docker compose --env-file .env.production exec backend node dist/scripts/borrar-viaje.js --listar
# Ver qué borraría (no borra nada)
docker compose --env-file .env.production exec backend node dist/scripts/borrar-viaje.js 00006735
# Borrarlo
docker compose --env-file .env.production exec backend node dist/scripts/borrar-viaje.js 00006735 --confirmar
```

El viaje se indica por número de manifiesto o por id (`#36`). El script **se
niega a borrar un viaje con cualquier radicado de producción**: su número ya
existe en el RNDC, y borrarlo haría que el próximo despacho lo repitiera. Un
viaje real que sobra se anula desde Viajes. Si el viaje no tiene ningún
radicado, pide además `--sin-radicado`.

Antes de borrar, sacar un respaldo (sección 8).

## 8. Respaldos

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

## 9. Rutina de actualización (guardar cambios y subirlos al servidor)

Como está montado hoy el servidor (`ubuntu-4gb-hel1-2`, IP de Tailscale
`100.99.218.10`):

| Qué | Dónde |
|---|---|
| Backend: repo, `docker-compose.yml`, `Caddyfile`, `.env.production` | `/opt/tms` (repo del backend, rama `main`) |
| Frontend compilado que sirve Caddy | `/opt/frontend-react/dist` (carpeta simple, **no** es un repo) |

En el computador se trabaja en la rama `feature/ruta-explicita` de los dos
repos (`backend` y `frontend-react`); el servidor usa `main`.

### 9.1 Guardar los cambios en GitHub (en el computador, cada repo por separado)

```powershell
cd "C:\Users\Jhon1\Desktop\TMS Transportes Lopez\frontend-react"
```
Entra a la carpeta del repo. Para el backend: `...\TMS Transportes Lopez\backend`.

```powershell
git status
```
Lista lo que cambió:
- `modified:`: un archivo que ya existía y se modificó.
- `Untracked files`: archivos nuevos.

**Leerla antes de seguir**: no deben ir `.env`, `.csv` con datos personales ni
respaldos (`.sql`).

```powershell
git add src index.html GUIA-UI.md
```
Marca qué archivos entran al commit. Es más seguro nombrarlos que usar
`git add -A`, que agrega **todo**. En el backend casi siempre basta `git add src`.

```powershell
git status
```
Lo que va al commit aparece en verde, bajo `Changes to be committed`. Revisar que
sea solo lo que se quería.

```powershell
git commit -m "Descripcion corta del cambio"
```
Guarda una foto del cambio **en el computador**. Todavía no sube nada.

```powershell
git push origin feature/ruta-explicita
```
Sube el commit a GitHub, en la rama de trabajo.

```powershell
git push origin feature/ruta-explicita:main
```
Lo sube también a `main`, que es la que descarga el servidor.

Si GitHub responde `rejected` o `non-fast-forward`, **no forzar** (`--force`):
`main` tiene algo que el computador no tiene. Hay que revisarlo antes.

### 9.2 Actualizar el backend (consola del servidor)

Solo si cambió el repo `backend`.

```powershell
ssh root@100.99.218.10
```
Desde PowerShell del computador: abre la consola del servidor por Tailscale y
pide la contraseña. Si se demora y falla, correr
`tailscale ping 100.99.218.10` y volver a intentar.

```bash
cd /opt/tms
```
Carpeta del repo del backend y del `docker-compose.yml`.

```bash
git pull
```
Descarga de GitHub lo que se subió a `main`.

```bash
docker compose --env-file .env.production up -d --build backend
```
Reconstruye la imagen del backend con el código nuevo y reinicia solo ese
contenedor:
- `--env-file .env.production`: usa las claves de producción.
- `--build`: recompila.
- `-d`: queda corriendo en segundo plano.
- `backend`: no toca MySQL ni Caddy.

La base de datos no se afecta.

```bash
docker compose --env-file .env.production ps
```
`backend` debe decir **Up** y, a los segundos, **(healthy)**.

```bash
docker compose --env-file .env.production logs backend --tail 20
```
Últimas 20 líneas del log: debe terminar con
`PRODUCCION - DOCUMENTOS REALES`. Si hay un error, sale aquí.

```bash
exit
```
Cierra la consola del servidor. La aplicación sigue corriendo.

### 9.3 Actualizar el frontend (computador + servidor)

Solo si cambió el repo `frontend-react`. Se compila en el computador y se sube
la carpeta `dist`.

En el computador (PowerShell):

```powershell
cd "C:\Users\Jhon1\Desktop\TMS Transportes Lopez\frontend-react"
npm run build
```
Compila el frontend en `dist`. Debe terminar con `✓ built in ...`; si dice
`error`, no subir nada.

```powershell
scp -r dist root@100.99.218.10:/opt/frontend-react/dist-nuevo
```
Copia `dist` al servidor en una carpeta **aparte** (`dist-nuevo`): lo que está
en uso no se toca todavía. Pide la contraseña.

En el servidor (`ssh root@100.99.218.10`):

```bash
cd /opt/frontend-react
ls dist-nuevo
```
Debe mostrar `assets  favicon.png  index.html`: la subida llegó completa.

```bash
rm -rf dist-anterior && cp -r dist dist-anterior
```
Borra el respaldo anterior y guarda la versión **actual** como `dist-anterior`,
por si hay que volver atrás.

```bash
rm -rf dist/* && cp -r dist-nuevo/. dist/
```
Vacía `dist` y copia **adentro** la versión nueva. Se hace así, y no
renombrando carpetas, porque Caddy está pegado a esa carpeta exacta: una carpeta
renombrada lo dejaría mostrando la versión vieja.

```bash
rm -rf dist-nuevo
```
Borra la copia temporal.

Comprobar: abrir **https://ubuntu-4gb-hel1-2.tail841fce.ts.net** con **Ctrl+F5**,
que recarga sin caché. Caddy toma el frontend nuevo de inmediato, y
`index.html` va sin caché.

Si algo se ve mal, volver a la versión anterior:

```bash
cd /opt/frontend-react && rm -rf dist/* && cp -r dist-anterior/. dist/
```

### 9.4 Resumen

| Qué | Dónde | Comandos |
|---|---|---|
| Guardar cambios | Computador, en cada repo | `git status` → `git add ...` → `git commit -m "..."` → `git push origin feature/ruta-explicita` → `git push origin feature/ruta-explicita:main` |
| Actualizar backend | Servidor | `cd /opt/tms` → `git pull` → `docker compose --env-file .env.production up -d --build backend` |
| Actualizar frontend | Computador y servidor | `npm run build` → `scp -r dist ...:/opt/frontend-react/dist-nuevo` → en el servidor: respaldo y copia dentro de `dist` |

Reglas:
- Leer siempre `git status` antes de `git add`.
- Nunca `--force` en un push.
- Nunca `docker compose down -v`: borra la base de datos.
- Respaldo antes de cambios grandes (sección 8).

## 10. Lista para el día del lanzamiento

- [ ] Respaldo de la base actual y carga en el contenedor (sección 5).
- [ ] `HTTP_BIND` con la IP de Tailscale; comprobar que desde fuera de Tailscale
      no responde.
- [ ] Usuarios creados y correo probado (sección 6).
- [ ] Siguiente número de despacho correcto.
- [ ] Respaldo diario programado y copiado fuera del servidor.
- [ ] Desde ese día, no expedir desde el portal del RNDC con la misma numeración.
- [ ] Cumplir remesas y manifiestos dentro de los 5 días hábiles (botón
      *Cumplir* en Viajes).
