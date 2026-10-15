# Migración del servidor a EE.UU. (Hetzner Ashburn)

Estado: **pendiente**. Plan acordado el 2026-10-15.

**Motivo:** el RNDC no acepta solicitudes desde el servidor actual en Finlandia
(`ubuntu-4gb-hel1-2`, Tailscale `100.99.218.10`). Solo desde EE.UU. o Colombia.

Cada paso que cambie algo se confirma antes de hacerlo. El servidor finlandés
**no se apaga ni se borra** hasta confirmarlo explícitamente.

## Decisiones

- **Servidor nuevo limpio, no clon del snapshot.** Todo el estado cabe en: el
  volumen `mysql-data`, `.env.production`, `/opt/frontend-react/dist` y el repo
  en `main`. Un clon arrastraría la identidad de Tailscale (choca con el viejo;
  `tailscale logout` en el clon saca también al viejo de la red) y lo que se
  haya cambiado a mano en el servidor. El snapshot del viejo se saca igual,
  como seguro.
- **Tipo:** en Ashburn no hay CX; el equivalente es **CPX21** (4 GB), Ubuntu 24.04.
- **El token de Hetzner no se pega en el chat.** Si se usa la CLI, se configura
  con `! hcloud context create tms`. La consola web basta.

## Cosas que hay que cambiar o revisar en el servidor nuevo

- `HTTP_BIND` en `.env.production`: es la IP de Tailscale del viejo; Caddy no
  arranca con ella en el nuevo. Poner la nueva (`tailscale ip -4`).
- `SMTP_PUERTO=587`: Hetzner suele bloquear la salida por 25 y 465 en
  servidores nuevos (el código ya usa STARTTLS con 587).
- `TMS_CLAVE_CIFRADO`: copiarla **idéntica**; si cambia, las claves de GPS
  guardadas no se pueden leer.
- `tailscale serve`: la oficina entra por
  `https://ubuntu-4gb-hel1-2.tail841fce.ts.net`. Revisar en el viejo si está
  configurado y replicarlo. Si se renombra el viejo y el nuevo toma su nombre,
  los equipos de la oficina no cambian nada.
- Respaldo diario (cron) y su copia fuera del servidor: recrearlos.
- Mientras se prueba, nadie de la oficina despacha en el nuevo (los dos tienen
  las credenciales reales del RNDC; la sincronización automática solo lee).

## Pasos

0. **Diagnóstico (solo lectura):** cómo falla hoy el RNDC desde Finlandia
   (logs del backend y `node dist/scripts/verificar-rndc.js` dentro del
   contenedor). Si es credencial o lista de IP permitidas, mudarse no lo arregla.
1. **Inventario (solo lectura):** `docker compose ps`, volúmenes,
   `HTTP_BIND`, `tailscale status` / `tailscale serve status`, `crontab -l`,
   puerto SMTP, espacio en disco, `git status` de `/opt/tms`. Sin mostrar
   valores de `.env.production`.
2. **Respaldo:** `mysqldump` (DEPLOY.md, sección 8) sin parar nada; copia de
   `.env.production` y de `dist` al computador; snapshot del viejo.
3. **Servidor nuevo** en Ashburn con la llave SSH, y **de inmediato la prueba
   del RNDC** contra los tres servidores que usa la app: `rndcws:8080`
   (expedir), `rndcws2:8080` (SICETAC) y `plc:8081` (PDF). Si falla: se borra
   el servidor y se para aquí.
4. **Instalación** según DEPLOY.md: Docker, Tailscale (equipo nuevo), repos,
   `.env.production` ajustado (ver arriba), `dist`.
5. **Ensayo:** cargar el respaldo; probar la app, el RNDC
   (`verificar-rndc.js`) y el correo (`probar-correo.js`); comparar conteos de
   tablas con el viejo.
6. **Corte** (fuera del horario de despacho):
   1. detener el backend viejo (`docker compose ... stop backend`);
   2. último respaldo;
   3. cargarlo en el nuevo;
   4. revisar conteos y el siguiente número de despacho;
   5. pasar el nombre de Tailscale al nuevo;
   6. activar el respaldo diario.
7. **El viejo queda detenido, no borrado**, hasta confirmarlo.
