# Despliegue del módulo de despacho

Guía para dejar el sistema funcionando para la administración en un equipo
Windows de la oficina, con la base de datos MariaDB de XAMPP. Todo corre en un
solo proceso: el backend sirve también la página, en `http://EQUIPO:3000`.

## 1. Preparar el equipo

1. Instalar **Node.js LTS** y **XAMPP** (MariaDB), y clonar los dos repos en la
   misma carpeta: `backend/` y `frontend-react/` deben quedar lado a lado.
2. Arrancar MySQL desde el panel de XAMPP y marcarlo como servicio (casilla
   *Svc*), para que arranque solo con Windows.
3. Copiar la base actual si se cambia de equipo: restaurar el último respaldo
   (ver la sección 4).

## 2. Configurar y compilar

```bash
cd backend
npm install
copy .env.example .env      # y llenarlo (ver abajo)
npm run build

cd ../frontend-react
npm install
npm run build               # genera frontend-react/dist, que sirve el backend
```

En el `.env` de producción revisar sobre todo:

| Variable | Valor |
|---|---|
| `RNDC_AMBIENTE` / `RNDC_CONFIRMO_PRODUCCION` | producción y la frase de confirmación, **escrita por la persona responsable** |
| `RNDC_ULTIMO_CONSECUTIVO` | el último número expedido fuera del sistema |
| `DB_*` | los datos de la MariaDB de ese equipo |
| `SMTP_*` | la cuenta de Gmail con contraseña de aplicación (probar con `npm run probar-correo -- correo@destino`) |
| `EMPRESA_*` | nombre, dirección y teléfono para la remesa impresa |

## 3. Dejarlo corriendo siempre

Arranque manual para probar: `npm start` en `backend/` y abrir
`http://localhost:3000`.

Para que arranque solo con Windows (sin nadie con sesión iniciada), crear una
tarea programada **como administrador**:

```bat
schtasks /Create /TN "TMS Transportes Lopez" /SC ONSTART /RU SYSTEM /RL HIGHEST ^
  /TR "cmd /c cd /d C:\ruta\backend && node dist\index.js >> C:\ruta\logs\tms.log 2>&1"
```

Desde los otros equipos de la oficina se entra con `http://NOMBRE-DEL-EQUIPO:3000`.
Si no abre, permitir el puerto en el firewall (como administrador):

```bat
netsh advfirewall firewall add rule name="TMS 3000" dir=in action=allow protocol=TCP localport=3000
```

**Fuera de la oficina:** no abrir el puerto 3000 a internet. Poner delante un
proxy con HTTPS (o un túnel) y activar `TRUST_PROXY=1` en el `.env`, para que la
cookie de sesión viaje cifrada.

## 4. Respaldos

`npm run respaldo` deja un volcado comprimido en `../respaldos/` y borra los de
más de 30 días. Programarlo a diario:

```bat
schtasks /Create /TN "TMS respaldo diario" /SC DAILY /ST 23:30 /RU SYSTEM ^
  /TR "cmd /c cd /d C:\ruta\backend && npm run respaldo >> C:\ruta\logs\respaldo.log 2>&1"
```

Copiar de vez en cuando la carpeta `respaldos/` **a otro lugar** (Drive, un
disco externo): un respaldo en el mismo disco no sirve si el disco falla.

Para restaurar: descomprimir el `.sql.gz` y cargarlo con
`C:\xampp\mysql\bin\mysql -u root -p rndc_tms < archivo.sql`.

## 5. Actualizar a una versión nueva

```bash
cd backend        && git pull && npm install && npm run build
cd ../frontend-react && git pull && npm install && npm run build
```

y reiniciar la tarea "TMS Transportes Lopez" (o el equipo). Los cambios de la
base se aplican solos al arrancar.

## 6. Lista para el día del lanzamiento

- [ ] Respaldo hecho justo antes (`npm run respaldo`).
- [ ] Crear los usuarios de la administración (`npm run crear-usuario -- correo "Nombre"`
      o desde la pantalla Usuarios) y confirmar que les llega el correo.
- [ ] Verificar que el siguiente número que propone el despacho es el correcto.
- [ ] **Acordar que desde ese día no se expiden manifiestos ni remesas desde el
      portal del RNDC** con la misma numeración: el sistema no los ve y el
      número choca (así falló la remesa 00006728 el 29/09).
- [ ] Cumplir remesas y manifiestos **dentro de los 5 días hábiles** desde la
      entrega (botón *Cumplir* en Viajes; el tablero avisa los pendientes): si
      los vencidos pasan del 20 % de los manifiestos del último mes, el RNDC
      bloquea la expedición [Guía de Manifiesto V7, pág. 6]. El sistema hace el
      cumplido normal; suspensiones, adicionales o descuentos van por el portal.
- [ ] Los viajes que ya se cumplieron en el portal: al darles *Cumplir*, si el
      RNDC responde "DUPLICADO:<radicado>" (como hace con remesas repetidas) el
      sistema los marca cumplidos con ese radicado. **Sin verificar para
      cumplidos**: revisar qué responde el RNDC la primera vez que pase.
