# TMS Transportes López — Backend

Sistema de gestión de transporte (TMS) de **Transportes López C S.A.S.** El
backend expide y administra ante el **RNDC** (Registro Nacional de Despachos
de Carga del Ministerio de Transporte) los documentos de cada viaje: remesas,
manifiestos, cumplidos y anulaciones. También lleva el control operativo y
financiero de los viajes (**Cuadro pagos**), los catálogos de la empresa, los
usuarios y las alertas de vencimiento de documentos.

> **Documentación relacionada**
> - [`PRUEBAS.md`](PRUEBAS.md): pruebas unitarias (qué cubren y cómo correrlas).
> - [`DEPLOY.md`](DEPLOY.md): despliegue en el servidor (Docker) y rutina de actualización.
> - [`../frontend-react/README.md`](../frontend-react/README.md): la aplicación web.
> - Cada función del código tiene un comentario que explica qué hace y cómo; la
>   [sección 12](#12-referencia-de-funciones) los reúne todos.

## Contenido

1. [Qué hace el sistema](#1-qué-hace-el-sistema)
2. [Arquitectura](#2-arquitectura)
3. [Tecnologías](#3-tecnologías)
4. [Estructura del código](#4-estructura-del-código)
5. [Cómo correrlo](#5-cómo-correrlo)
6. [Variables de entorno](#6-variables-de-entorno)
7. [Scripts](#7-scripts)
8. [Flujos principales](#8-flujos-principales)
9. [Integración con el RNDC](#9-integración-con-el-rndc)
10. [Modelo de datos](#10-modelo-de-datos)
11. [API REST](#11-api-rest)
12. [Referencia de funciones](#12-referencia-de-funciones)

---

## 1. Qué hace el sistema

| Módulo | Qué resuelve |
|---|---|
| **Despacho** | Expide en el RNDC las remesas (una por cliente o parada) y el manifiesto de un viaje con un solo envío desde la pantalla Despachar. |
| **Corrección y reintento** | Si el RNDC rechaza algo, el viaje queda con el error explicado; se corrige y se reenvía solo lo que falta, sin duplicar documentos. |
| **Adopción de documentos** | Si un documento ya existía en el RNDC (respuesta `DUPLICADO` o expedido en el portal), se toma su radicado en vez de fallar. |
| **Anulación** | Anula en orden el cumplido inicial, el manifiesto y las remesas, controlando el tope mensual de anulaciones. |
| **Cumplidos** | Cumple cada remesa con sus tiempos logísticos (tomando los del GPS) y luego el manifiesto, calculando retenciones, FOPAT y el **piso SICETAC del cumplido**. |
| **SICETAC** | Consulta el valor mínimo de referencia de cada vía para no expedir por debajo del piso (con caché ante el límite de consultas del RNDC). |
| **Cuadro pagos** | Seguimiento de cada viaje, con o sin manifiesto: papeles, radicación, facturación, anticipos de bombas aliadas, pago al dueño del vehículo y revisiones. Reemplaza la hoja de Excel "CUADRO CENTRAL". |
| **Catálogos** | Vehículos (flota propia López/MYC o tercero), remolques, conductores, terceros, empresas de monitoreo (GPS), plantillas de viaje, vías y parámetros. |
| **Alertas** | SOAT, tecnomecánica, licencias y póliza vencidos o por vencer, contados contra la fecha de descargue (como los valida el RNDC). |
| **Usuarios** | Inicio de sesión con cookie segura, claves temporales, recuperación por correo y bloqueo por intentos fallidos. |
| **Documentos** | PDF oficial del manifiesto (con el logo de la empresa) y remesa imprimible. |

---

## 2. Arquitectura

```
 Navegador (React)
        │  HTTPS (Tailscale)
        ▼
 Caddy ──── sirve el frontend compilado (dist)
   │
   │ /api/*
   ▼
 Express (Node.js + TypeScript) ── src/routes/*  ← cada pantalla llama aquí
   │            │
   │            ├── src/repo.ts, src/cuadro.ts ──► MySQL 8 (tablas de la sección 10)
   │            │
   │            └── src/rndc/* ──SOAP──► Web Service del RNDC
   │                                     · registrar (tipo 1)
   │                                     · consultar propios (tipo 3)
   │                                     · maestros y SICETAC (tipo 6)
   │                           ──REST──► PDF del manifiesto
   └── src/correo.ts ──SMTP──► Gmail (claves temporales y recuperación)
```

- **Las rutas no escriben SQL**: usan los repositorios (`repo.ts`, `cuadro.ts`).
- **Todo lo del RNDC está en `src/rndc/`**: armado del XML (`builders.ts`),
  envío (`client.ts`), consultas de solo lectura (`consultas.ts`), SICETAC
  (`sicetac.ts`), PDF (`pdf.ts`, `estampado.ts`) e impresión (`remesa-impresion.ts`).
- **El esquema se crea solo** al arrancar (`initSchema` en `db.ts`): no hay migraciones manuales.
- **Fechas:** la base y el servidor trabajan en UTC; todo lo que escribe o lee
  la gente es hora de Colombia (UTC‑5), y se convierte en un solo lugar (`fechas.ts`).

---

## 3. Tecnologías

| Capa | Tecnología |
|---|---|
| Runtime y lenguaje | Node.js 20+ y TypeScript (strict) |
| Servidor HTTP | Express 4 (`express-async-errors` para errores en rutas async) |
| Base de datos | MySQL 8 con `mysql2` (SQL explícito, sin ORM) |
| RNDC | `soap` (Web Service SOAP) y `pdf-lib` (logo sobre el PDF oficial) |
| Correo | `nodemailer` (SMTP de Gmail) |
| Pruebas | Vitest |
| Despliegue | Docker Compose (backend, MySQL, Caddy) — ver `DEPLOY.md` |

---

## 4. Estructura del código

```
backend/
├── src/
│   ├── index.ts             Arranque: esquema, Express, rutas y frontend compilado
│   ├── config.ts            Configuración del .env y frenos de seguridad de producción
│   ├── db.ts                Conexión MySQL, candado de consecutivos y esquema
│   ├── fechas.ts            Horas escritas en Colombia → instantes UTC
│   ├── auth.ts              Usuarios, contraseñas (scrypt), sesiones y bloqueo de intentos
│   ├── correo.ts            Envío de correos y sus plantillas
│   ├── alertas.ts           Vencimiento de documentos
│   ├── consecutivos.ts      Numeración de manifiestos y remesas (00006692, 00006692A...)
│   ├── repo.ts              Repositorios de todas las tablas del despacho y catálogos
│   ├── cuadro.ts            Repositorio y reglas del Cuadro pagos
│   ├── seed.ts              Datos de ejemplo para desarrollo
│   ├── rndc/
│   │   ├── builders.ts      XML y datos de cada proceso del RNDC, cálculos y validaciones
│   │   ├── client.ts        Cliente SOAP: envío, reintentos e interpretación de respuestas
│   │   ├── consultas.ts     Consultas de solo lectura (placa, documentos propios, cumplidos, GPS)
│   │   ├── sicetac.ts       Piso SICETAC: consulta, filtros, caché y fórmula
│   │   ├── pdf.ts           Descarga del PDF del manifiesto
│   │   ├── estampado.ts     Logo de la empresa sobre el PDF
│   │   └── remesa-impresion.ts  HTML imprimible de la remesa
│   ├── routes/
│   │   ├── auth.ts          /api/auth
│   │   ├── catalogo.ts      /api/catalogo
│   │   ├── despacho.ts      /api/despacho
│   │   ├── usuarios.ts      /api/usuarios
│   │   └── cuadro.ts        /api/cuadro
│   ├── scripts/             Herramientas de terminal (sección 7)
│   └── **/*.test.ts         Pruebas unitarias (ver PRUEBAS.md)
├── herramientas/
│   └── generar-referencia.cjs   Regenera las secciones 11 y 12 de este README
├── Dockerfile, docker-compose.yml, Caddyfile
└── .env.example
```

---

## 5. Cómo correrlo

**Requisitos:** Node.js 20+, MySQL 8 (o MariaDB), y credenciales del RNDC.

```bash
cd backend
npm install
cp .env.example .env          # y completar (sección 6)
npm run dev                   # http://localhost:3000, se recarga al guardar
npm run crear-usuario -- correo@empresa.com "Nombre Apellido"   # primer usuario
```

- **`RNDC_SIMULAR=true`** (por defecto) no contacta al RNDC: responde radicados
  simulados y deja ver el XML que se habría enviado. Útil para armar plantillas.
- **Para expedir documentos reales** hacen falta `RNDC_AMBIENTE=produccion`,
  `RNDC_SIMULAR=false` y la frase `RNDC_CONFIRMO_PRODUCCION="SI, EXPEDIR DOCUMENTOS REALES"`.
  Sin la frase el servidor no arranca en producción.
- **El servidor de pruebas** del RNDC (`rndcpruebas`) solo responde desde IPs de Colombia.

---

## 6. Variables de entorno

Se definen en `.env` (plantilla comentada en `.env.example`).

| Variable | Para qué sirve |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Conexión a MySQL |
| `PORT` | Puerto del backend (3000) |
| `CORS_ORIGIN` | URL del frontend en desarrollo (Vite) |
| `EMPRESA_NOMBRE`, `EMPRESA_DIRECCION`, `EMPRESA_TELEFONO`, `EMPRESA_MUNICIPIO` | Encabezado de la remesa impresa |
| `LOGO_EMPRESA` | Ruta del logo que se estampa en el PDF (por defecto `assets/logo-empresa.png`) |
| `SMTP_HOST`, `SMTP_PUERTO`, `SMTP_USUARIO`, `SMTP_CLAVE`, `SMTP_REMITENTE` | Correo (contraseña de aplicación de Gmail). Vacío: las claves temporales se muestran en pantalla |
| `FRONTEND_DIST` | Carpeta del frontend compilado que sirve el backend (sin Docker) |
| `TRUST_PROXY` | `1` si hay un proxy con HTTPS delante (cookie `Secure`) |
| `RESPALDO_DIR`, `RESPALDO_DIAS`, `MYSQLDUMP` | Respaldos con `npm run respaldo` |
| `RNDC_AMBIENTE` | `pruebas` o `produccion` |
| `RNDC_SIMULAR` | `true` no contacta al RNDC |
| `RNDC_CONFIRMO_PRODUCCION` | Frase obligatoria para expedir documentos reales |
| `RNDC_USUARIO`, `RNDC_PASSWORD`, `RNDC_EMPRESA_NIT` | Credenciales del RNDC y NIT de la empresa |
| `RNDC_WSDL_URL`, `RNDC_CONSULTAS_WSDL_URL`, `RNDC_REST_URL` | URLs para sobrescribir las del ambiente (WSDL, consultas, PDF) |
| `RNDC_REINTENTOS` | Reintentos ante fallas de red (nunca ante rechazos) |
| `RNDC_NIT_MONITOREO_FLOTA` | Empresa de monitoreo de último recurso si el vehículo no tiene una |
| `RNDC_LONGITUD_CONSECUTIVO`, `RNDC_PREFIJO_CONSECUTIVO`, `RNDC_ULTIMO_CONSECUTIVO` | Numeración de manifiestos y remesas |
| `SICETAC_UNIDAD_TRANSPORTE`, `SICETAC_TIPO_CARGA`, `SICETAC_MESES_ATRAS` | Qué fila de SICETAC corresponde a la operación de la empresa |

---

## 7. Scripts

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo con recarga al guardar |
| `npm run build` / `npm start` | Compila a `dist/` y lo ejecuta (producción) |
| `npm test` / `npm run test:watch` | Pruebas unitarias (ver `PRUEBAS.md`) |
| `npm run test:tipos` | Revisa los tipos de TypeScript, incluidas las pruebas |
| `npm run docs` | Regenera la API y la referencia de funciones de este README |
| `npm run crear-usuario -- <correo> "<nombre>"` | Crea un usuario (o le restablece la clave) |
| `npm run verificar` | Verifica configuración, conexión con el RNDC y estado de las placas (solo lectura) |
| `npm run importar -- <tipo> <archivo.csv> [--aplicar]` | Carga masiva desde CSV (revisa todo antes de escribir) |
| `npm run cargar-datos` | Carga los datos reales de `datos-empresa.json` |
| `npm run habituales [-- --aplicar]` | Remolque, conductor y GPS habituales de cada vehículo según el historial del RNDC |
| `npm run probar-correo [-- destino@correo]` | Prueba la configuración de correo |
| `npm run respaldo` | Respaldo comprimido de la base |
| `npm run borrar-viaje -- <número> [--confirmar]` | Borra viajes de **prueba** (nunca uno con radicado de producción) |
| `npm run seed` | Datos de ejemplo para desarrollo |

---

## 8. Flujos principales

### 8.1 Despachar un viaje

1. La pantalla envía `POST /api/despacho` con vehículo, conductor, remolque,
   las cargas (una por plantilla), valores y número de manifiesto.
2. **Validación local** (`validarReglasRndc`): solo detienen el envío los
   problemas estructurales (sin remesas, consecutivo inválido o repetido). Lo
   demás (documentos por vencer, coordenadas, piso SICETAC) se guarda como
   **aviso**: el RNDC decide con su propio error.
3. Se toma el número con un **candado en MySQL** (`conCandado`) para que dos
   despachos no usen el mismo.
4. Se envía cada **remesa** (proceso 3) y después el **manifiesto** (proceso 4)
   con la lista de sus remesas.
5. Resultado: `CONFIRMADO` con los radicados, o un estado de error
   (`VALIDACION_ERROR`, `REMESA_ERROR`, `MANIFIESTO_ERROR`) con el mensaje del
   RNDC explicado en español.

### 8.2 Corregir y reintentar

- Desde Viajes, "Corregir y reintentar" abre el viaje completo en Despachar.
- Antes de reenviar se pregunta al RNDC si el manifiesto **ya existe**
  (`tomarSiYaExpedido`): si es de la misma placa, se adopta con sus valores.
- Las remesas ya creadas no se reenvían; solo se envía lo que falta.
- Si el RNDC responde `DUPLICADO:<radicado>`, se puede **usar el documento
  existente** con ese radicado.

### 8.3 Anular

`GET /api/despacho/:id/anulacion` muestra qué se anulará, los motivos válidos
y el **tope mensual** de anulaciones (30 %, 20 % o 10 % según los manifiestos
del mes). `POST /:id/anular` anula en orden: cumplido inicial (54),
manifiesto (32) y remesas (9).

### 8.4 Cumplir remesas

1. Se leen del RNDC los tiempos que ya reportó el **GPS** (cumplido inicial,
   proceso 45) y vienen puestos en el formulario.
2. Un tiempo del GPS que no se cambie **no se reenvía** (enviarlo distinto da
   `CRE111`); si el usuario lo corrige, se envía su valor y el RNDC decide.
3. Se envía el cumplido (proceso 5) con kilos entregados y los seis tiempos.
4. Un cumplido de remesa se puede **anular para corregirlo** (proceso 28),
   mientras el manifiesto no esté cumplido.

### 8.5 Cumplir el manifiesto y el piso SICETAC

1. Al abrir la ventana se **adoptan** del RNDC los cumplidos hechos en el portal.
2. El valor final = flete + adicionales − descuento; sobre él se calculan la
   retención en la fuente (1 %) y el FOPAT (0,1 % exacto, si no `CMA273`).
3. **Piso del cumplido** (verificado en producción con el manifiesto 00006775):

   > valor a pagar ≥ movilización + valor hora × (horas de cargue + horas de descargue),
   > **contando desde la LLEGADA** (la espera cuenta), redondeado hacia arriba.

   Si no se cumple, el RNDC responde `CMA045`. La pantalla muestra el piso y
   suma lo que falta al adicional por horas de cargue con un clic.
4. Se envía el cumplido (proceso 6) con la fecha de entrega de documentos
   (sin ella, `CMA140`) y la vía del manifiesto.

### 8.6 Cuadro pagos

- Cada **manifiesto expedido entra solo** (una fila por remesa); los viajes
  **sin manifiesto** (urbanos o planillados por el cliente) se crean a mano.
- **Recorrido de los papeles:** en ruta → con el conductor → parqueadero →
  oficina de Don Alexander → radicados. Parqueadero y oficina solo para
  CORAME / Cartones América.
- **El estado se calcula de los datos** con los colores del Excel: en proceso
  (blanco), sin radicar (morado), radicado (verde), facturado sin datos (azul),
  revisado por contabilidad (naranja) y **todo pagado** (amarillo: factura
  cobrada, saldo del tercero pagado y anticipos pagados a la bomba).
- Flete **por kilo** (peso real × tarifa) o **fijo**. Una factura puede cubrir varios viajes.
- A los **terceros** se les paga 15 días después de descargar; la flota propia
  (Transportes López y Transportes MYC) no tiene saldo de tercero.

### 8.7 Sesiones y usuarios

- Contraseñas con **scrypt** y sal; comparación en tiempo constante.
- La sesión es un token aleatorio en cookie **HttpOnly**; en la base solo se
  guarda su hash. Vence tras 12 horas sin actividad.
- 5 intentos fallidos bloquean el login 10 minutos.
- Los usuarios nuevos reciben una clave temporal (por correo) que deben cambiar al entrar.

---

## 9. Integración con el RNDC

Todos los mensajes van al método `AtenderMensajeRNDC` del Web Service SOAP.

| Tipo de solicitud | Uso |
|---|---|
| **1** | Registrar (expedir, cumplir, anular) |
| **3** | Consultar documentos propios (solo lectura): radicados, cumplidos, GPS |
| **6** | Maestros especiales (solo lectura): placa en el RNA, SICETAC |

| Proceso | Qué hace | Dónde |
|---|---|---|
| 3 | Expedir remesa | `construirDatosRemesa` |
| 4 | Expedir manifiesto | `construirDatosManifiesto` |
| 5 | Cumplir remesa | `construirDatosCumplidoRemesa` |
| 6 | Cumplir manifiesto | `construirDatosCumplidoManifiesto` |
| 9 | Anular remesa | `construirDatosAnularRemesa` |
| 28 | Anular cumplido de remesa | `construirDatosAnularCumplidoRemesa` |
| 32 | Anular manifiesto | `construirDatosAnularManifiesto` |
| 45 | Cumplido inicial del GPS (consulta) | `leerCumplidoInicial` |
| 48 | Estado de una placa en el RNA (consulta) | `consultarPlaca` |
| 54 | Anular cumplido inicial | `construirDatosAnularCumplidoInicial` |
| 26 | SICETAC (consulta) | `consultarSicetac` |

**Protecciones:**
- El cliente de consultas (`soloConsultas`) rechaza antes de salir cualquier
  mensaje que no sea de tipo 3 o 6.
- Solo se reintenta ante fallas de red, nunca ante un rechazo del RNDC.
- Una respuesta sin radicado ni error se trata como fallo, para no dar por
  expedido algo que quizá no lo está.

**Errores frecuentes:**

| Código | Significado | Qué hace el sistema |
|---|---|---|
| `MAN045` | Flete por debajo del piso SICETAC al expedir | Muestra el piso de la vía al despachar |
| `CMA045` | Valor a pagar del cumplido por debajo del piso | Calcula el piso con horas desde la llegada y lo completa |
| `CMA140` | Falta la fecha de entrega de documentos | La pide siempre |
| `CMA273` | El FOPAT no es exactamente el 0,1 % del valor final | Lo calcula sobre el valor final |
| `CRE111` | Tiempos distintos a los del GPS | No reenvía los del GPS si no se cambiaron |
| `CRE080`, `CRE090`, `CRE130`, `CRE150`, `CRE160` | Faltan tiempos de llegada o salida | Pide los seis tiempos |
| `ACR070` | No se puede anular el cumplido de la remesa | La remesa no está cumplida o el manifiesto ya lo está |
| `RNDC11` | Documento no encontrado (en consultas) | Se interpreta como "no existe" |
| `RNDC13` | SICETAC: límite de consultas | Usa la última respuesta guardada |
| `DUPLICADO:<n>` | El documento ya existía | Permite adoptarlo con ese radicado |

---

## 10. Modelo de datos

Las tablas se crean al arrancar (`initSchema`).

| Tabla | Contenido |
|---|---|
| `vehiculos` | Placa, configuración, titular, flota (López / MYC / tercero), GPS, vencimientos, FOPAT |
| `remolques` | Placa, ejes, capacidad y vencimientos |
| `conductores` | Cédula, nombre, licencia y su vencimiento |
| `terceros` | Clientes, remitentes y destinatarios con sede, municipio y coordenadas |
| `municipios` | Maestro DIVIPOLA |
| `rutas` | Rutas origen-destino (en desuso: la ruta sale de la plantilla) |
| `vias` | Vías (CODVIA) de cada par origen-destino con su piso SICETAC |
| `sicetac_respuestas` | Última respuesta buena de SICETAC por filtros (caché ante el límite) |
| `empresas_monitoreo` | Proveedores de GPS registrados en el RNDC |
| `parametros_empresa` | Póliza de carga, aseguradora, retención y FOPAT por defecto |
| `plantillas_viaje` | Cliente, remitente, destinatario, mercancía, tiempos pactados y flete |
| `viajes` | Cada manifiesto: estado, radicados, valores, cumplido, anulación y usuarios |
| `viaje_remesas` | Las remesas de cada viaje con su consecutivo, radicado, estado y cumplido |
| `cuadro_viajes` | Filas del Cuadro pagos (con o sin manifiesto) |
| `cuadro_anticipos` | Anticipos entregados por las bombas aliadas |
| `cuadro_notas` | Notas de cada viaje con autor y fecha |
| `bombas` | Bombas aliadas |
| `usuarios`, `sesiones`, `recuperaciones` | Cuentas, sesiones abiertas (hash del token) y códigos de recuperación |

**Estados del viaje:** `PENDIENTE` → `CONFIRMADO` (expedido) → `CUMPLIDO`, o
`ANULADO`. Errores: `VALIDACION_ERROR`, `REMESA_ERROR`, `MANIFIESTO_ERROR`,
`ANULACION_ERROR`. Transitorios mientras se envía: `REINTENTANDO`,
`ANULANDO`, `CUMPLIENDO`.

**Estados de la remesa:** `PENDIENTE`, `CREADA`, `CUMPLIENDO`, `CUMPLIDA`,
`ANULADA` o `ERROR`.

---

## 11. API REST

Todas las rutas, salvo login y recuperación de contraseña, exigen sesión.

<!-- RUTAS:INICIO -->
| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/api/auth/login` | Inicio de sesion con email y contrasena. El mensaje de error es el mismo para email inexistente y clave errada: no revela que correos tienen cuenta. |
| `POST` | `/api/auth/logout` | Cierra la sesion del token de la cookie (si hay) y borra la cookie. Responde 204 sin cuerpo. |
| `GET` | `/api/auth/sesion` | Quien soy: lo usa el frontend al abrir para saber si hay sesion. |
| `POST` | `/api/auth/cambiar-clave` | Cambiar la propia contrasena (obligatorio tras una clave temporal). |
| `POST` | `/api/auth/recuperar` | Paso 1: pedir un codigo. La respuesta es la MISMA exista o no el correo: no revela que cuentas existen. Tras 5 pedidos seguidos para el mismo correo, se bloquea un rato. |
| `POST` | `/api/auth/recuperar/confirmar` | Paso 2: con el codigo recibido, crear la contrasena nueva. |
| `GET` | `/api/catalogo/remolques` | Todos los remolques. |
| `POST` | `/api/catalogo/remolques` | Crea un remolque (placa en mayuscula). 201 con el creado. |
| `PUT` | `/api/catalogo/remolques/:id` | Edita solo los campos enviados. |
| `GET` | `/api/catalogo/vehiculos/:id/gps` | Link, usuario y clave (descifrada) de la plataforma GPS del vehiculo, para revisar a que hora salio del cargue mientras se despacha. Es la unica ruta que entrega la clave. |
| `GET` | `/api/catalogo/vehiculos` | Vehiculos del catalogo (sin los eliminados). |
| `POST` | `/api/catalogo/vehiculos` | Crea un vehiculo. |
| `DELETE` | `/api/catalogo/vehiculos/:id` | "Elimina" un vehiculo: borrado logico. Sale del catalogo, del despacho y de las alertas, pero se conserva para los viajes que ya lo usaron. |
| `PUT` | `/api/catalogo/vehiculos/:id` | Edicion completa de un vehiculo desde el catalogo. |
| `GET` | `/api/catalogo/conductores` | Todos los conductores. |
| `POST` | `/api/catalogo/conductores` | Crea un conductor (cedula por defecto). 201 con el creado. |
| `PUT` | `/api/catalogo/conductores/:id` | Edita los campos enviados. La cedula queda solo con digitos, la categoria en mayuscula; cedula y nombre no pueden quedar vacios. |
| `GET` | `/api/catalogo/terceros` | Clientes, remitentes y destinatarios. |
| `POST` | `/api/catalogo/terceros` | Crea un cliente, remitente o destinatario. |
| `PUT` | `/api/catalogo/terceros/:id` | Edita los campos enviados. NIT y nombre obligatorios; el municipio debe ser un codigo DIVIPOLA de 8 digitos. |
| `POST` | `/api/catalogo/:maestro/:id/rndc` | Crea o actualiza en el RNDC el tercero, conductor, vehiculo o remolque con los datos que tiene hoy el catalogo (procesos 11 y 12, ver src/rndc/maestros.ts). Responde { ok, radicado, yaEstabaIgual, error } y deja el resultado guardado en la fila. |
| `GET` | `/api/catalogo/rutas` | Rutas guardadas (tabla en desuso). |
| `POST` | `/api/catalogo/rutas` | Crea una ruta origen-destino (tabla en desuso). |
| `GET` | `/api/catalogo/municipios` | Para elegir la ruta de una plantilla por nombre y no por codigo. Puede venir vacio si aun no se importo el CSV de municipios. |
| `GET` | `/api/catalogo/monitoreo` | Empresas de monitoreo de flota activas. |
| `POST` | `/api/catalogo/monitoreo` | Registra (o reactiva) una empresa de monitoreo de flota con NIT (maximo 15 digitos) y nombre. |
| `PUT` | `/api/catalogo/monitoreo/:id` | Cambia NIT y/o nombre de una empresa de monitoreo. |
| `DELETE` | `/api/catalogo/monitoreo/:id` | Desactiva la empresa de monitoreo (204). |
| `PUT` | `/api/catalogo/vehiculos/:id/monitoreo` | Fija el proveedor de GPS por defecto de un vehiculo. |
| `GET` | `/api/catalogo/vias/sicetac` | Vias consultadas en linea a SICETAC para un par de municipios. |
| `GET` | `/api/catalogo/vias` | Vias guardadas de un par de municipios (codigos DIVIPOLA de 8 digitos), la estandar primero. |
| `POST` | `/api/catalogo/vias` | Guarda o actualiza una via (CODVIA) de un par origen-destino con su descripcion y, si se conoce, su valor SICETAC. |
| `GET` | `/api/catalogo/tarifas/rutas` | Rutas existentes con su rango de tarifas, para ver donde hay dispersion. |
| `GET` | `/api/catalogo/tarifas/previsualizar` | Plantillas afectadas por una ruta, para revisar ANTES de actualizar. |
| `PUT` | `/api/catalogo/tarifas` | Aplica la nueva tarifa a todas las plantillas de la ruta. |
| `GET` | `/api/catalogo/alertas` | El RNDC valida SOAT, tecnomecanica y licencia contra la fecha de descargue, no contra hoy: conviene ver lo que vence pronto y no solo lo vencido. |
| `GET` | `/api/catalogo/parametros` | Parametros de la empresa, sus datos fijos (nombre, NIT) y el aviso de vigencia de la poliza de carga. |
| `PUT` | `/api/catalogo/parametros` | Guarda los parametros de la empresa. Solo cambian los campos que llegan: un guardado parcial no borra la poliza. |
| `GET` | `/api/catalogo/plantillas` | Plantillas activas con sus terceros. |
| `DELETE` | `/api/catalogo/plantillas/:id` | "Elimina" una plantilla (en realidad la desactiva: ver plantillas.desactivar en el repo). No se borra de verdad porque el historial de viajes y remesas la referencia por id. |
| `POST` | `/api/catalogo/plantillas` | Valida el cuerpo (plantillaDesdeCuerpo) y crea la plantilla. 422 con el problema si algo no es valido. |
| `PUT` | `/api/catalogo/plantillas/:id` | Edita una plantilla. |
| `GET` | `/api/cuadro` | Todos los viajes del cuadro (sincroniza antes los manifiestos). |
| `GET` | `/api/cuadro/bombas` | Catalogo de bombas aliadas. |
| `POST` | `/api/cuadro/bombas` | Crea una bomba ({ nombre, ciudad }). Devuelve su id. |
| `PUT` | `/api/cuadro/bombas/:bombaId` | Cambia nombre, ciudad o activa; devuelve la lista. |
| `GET` | `/api/cuadro/anticipos` | Todos los tramos de anticipo (ida y vuelta), lo mas reciente primero. |
| `POST` | `/api/cuadro/anticipos/importar/previa` | Propone el viaje de cada fila del Excel de anticipos ({ filas }). No guarda nada. |
| `POST` | `/api/cuadro/anticipos/importar` | Carga las filas confirmadas ({ filas: [{ ...fila, viajeId }] }). |
| `GET` | `/api/cuadro/anticipos/resumen` | Deuda, pagado, abonado por el socio, pendiente y cupo con la bomba. |
| `PUT` | `/api/cuadro/anticipos/parametros` | Cupo de credito con la bomba y precio y descuento por galon sugeridos ({ cupoBomba, precioGalonBomba, descuentoGalonBomba }). Va antes de /anticipos/:anticipoId para que "parametros" no se tome como id. |
| `POST` | `/api/cuadro/anticipos/juntar` | Junta dos tanqueos de la misma placa como ida y vuelta ({ ida, vuelta }: ids de tanqueo). Devuelve el cuadro. |
| `POST` | `/api/cuadro/anticipos/separar/:tanqueoId` | Separa la vuelta de un tanqueo de ida y vuelta. |
| `GET` | `/api/cuadro/relaciones-bomba` | Facturas (relaciones de vales) de la bomba ya cruzadas. |
| `POST` | `/api/cuadro/relaciones-bomba/previa` | Propone el tanqueo de cada vale ({ numero, vales }). No guarda. |
| `POST` | `/api/cuadro/relaciones-bomba` | Guarda la relacion y cruza los tanqueos ({ numero, fecha, nota, vales }). |
| `PUT` | `/api/cuadro/relaciones-bomba/:relacionId/pago` | Fecha de pago de la factura ({ fechaPago }; vacia la quita). |
| `PUT` | `/api/cuadro/relaciones-bomba/:relacionId/vencimiento` | Fecha de vencimiento de la factura ({ fechaVencimiento }). |
| `GET` | `/api/cuadro/reportes/bomba` | Estado de cuenta con la bomba (deuda al inicio, prestamos, abonos de los socios, pagos de la empresa, deuda al final) y lo prestado por mes, bomba y empresa. |
| `GET` | `/api/cuadro/pagos-bomba` | Pagos a la bomba (facturas de la quincena menos abonos de los socios). |
| `POST` | `/api/cuadro/pagos-bomba` | Registra el pago ({ relaciones, abonos, fecha, referencia }). Devuelve los pagos. |
| `DELETE` | `/api/cuadro/pagos-bomba/:pagoId` | Deshace un pago a la bomba. |
| `DELETE` | `/api/cuadro/relaciones-bomba/:relacionId` | Borra la relacion y deshace el cruce. |
| `GET` | `/api/cuadro/abonos-socio` | Abonos del socio a la bomba, con sus viajes. |
| `POST` | `/api/cuadro/abonos-socio` | Registra un abono ({ socio, fecha, nota, viajes: [{ cuadroViajeId, valor }] }). |
| `DELETE` | `/api/cuadro/abonos-socio/:abonoId` | Borra un abono. |
| `PUT` | `/api/cuadro/anticipos/:anticipoId` | Fecha de pago, nota, viaje o datos del cruce (galones, precio y descuento: recalcula el combustible) de un tramo. |
| `PUT` | `/api/cuadro/tanqueos/:tanqueoId` | Factura de la bomba (numero, fecha) o la bomba del tanqueo. |
| `GET` | `/api/cuadro/tarifas` | La matriz de fletes. |
| `PUT` | `/api/cuadro/tarifas` | Reemplaza la matriz completa con la importada del Excel ({ tarifas: [{ nombre, razonSocial, valor, tipo, pesoMinimoKg, observaciones }] }). |
| `POST` | `/api/cuadro/tarifas` | Agrega una tarifa a la matriz ({ nombre, razonSocial, valor, tipo, ... }). |
| `PUT` | `/api/cuadro/tarifas/:tarifaId` | Cambia una tarifa y la devuelve (404 si no existe). |
| `GET` | `/api/cuadro/por-facturar` | Viajes listos para facturar (y los ya enviados sin fecha de factura). |
| `POST` | `/api/cuadro/enviar-facturacion` | Guarda en cada viaje lo que va en el cuadro de la contadora ({ filas: [{ id, tarifaFleteId, tipo, valorTon, pesoFacturadoKg, total, remision, notaFactura, facturaNumero }] }). |
| `POST` | `/api/cuadro/facturar` | Asigna una misma factura a varios viajes. |
| `GET` | `/api/cuadro/:id` | Un viaje con sus anticipos y notas (404 si no existe). |
| `POST` | `/api/cuadro` | Crea un viaje sin manifiesto (urbano o planillado por el cliente). Placa, empresa y fecha obligatorias. Devuelve el viaje creado. |
| `PUT` | `/api/cuadro/:id` | Guarda los campos enviados (papeles, flete, factura, pagos...) y devuelve el viaje actualizado. |
| `POST` | `/api/cuadro/:id/tarifa` | Pone el flete de una tarifa de la matriz elegida a mano ({ tarifaFleteId }) y devuelve el viaje actualizado. |
| `DELETE` | `/api/cuadro/:id` | Borra un viaje creado a mano. Los que tienen manifiesto no se borran aqui (409): se anulan desde Viajes. |
| `POST` | `/api/cuadro/:id/revision` | Marca o quita la revision de CONTABILIDAD o GERENCIA ({ quien, revisado }), con el usuario y la hora. |
| `POST` | `/api/cuadro/:id/notas` | Agrega una nota ({ texto }) con su autor. |
| `DELETE` | `/api/cuadro/:id/notas/:notaId` | Borra una nota. |
| `POST` | `/api/cuadro/:id/anticipos` | Registra un anticipo de bomba ({ bombaId, valor, fecha, fechaPago?, nota? }). |
| `PUT` | `/api/cuadro/:id/anticipos/:anticipoId` | Cambia la fecha de pago a la bomba y/o la nota del anticipo. |
| `DELETE` | `/api/cuadro/:id/anticipos/:anticipoId` | Quita un anticipo. |
| `POST` | `/api/despacho` | El "boton unico" del despacho. |
| `POST` | `/api/despacho/remesas/:remesaId/usar-existente` | "Ya existe" en el RNDC: la remesa o el manifiesto quedaron creados en un intento anterior aunque aqui figure el error (por ejemplo, se perdio la respuesta). El RNDC lo dice con "DUPLICADO:<radicado>". |
| `POST` | `/api/despacho/:id/usar-manifiesto-existente` | Adopta un manifiesto que el RNDC reporto como existente ("DUPLICADO:<radicado>"). |
| `GET` | `/api/despacho/:id/datos-rndc` | Todos los datos que el viaje envia (o enviaria) al RNDC, sin enviar nada. Para revisarlos antes de reintentar. |
| `POST` | `/api/despacho/:id/reintentar` | Reintenta un viaje que quedo a medias, despues de corregir lo necesario. |
| `GET` | `/api/despacho/:id/anulacion` | Vista previa: que pasos se van a ejecutar, que motivos acepta el RNDC y como va el tope mensual de anulaciones de manifiestos. |
| `POST` | `/api/despacho/:id/anular` | Anula un viaje en el RNDC, en el orden que exige: 0. si el viaje ya estaba cumplido: el cumplido del manifiesto (29) y luego el de cada remesa cumplida (28). Con el manifiesto cumplido el RNDC no deja anular el cumplido de una remesa (ACR070), y una remesa cumplida no se puede anular (Manual 6.1); 1. cumplido inicial de cada remesa (54): lo genera el satelital y pide el numero del manifiesto, asi que va mientras este exista; 2. el manifiesto (32); 3. cada remesa (9): el RNDC no deja anular una remesa ligada a un manifiesto vigente (ANR030). |
| `POST` | `/api/despacho/remesas/:remesaId/cumplir` | Cumplido de una remesa (proceso 5): reporta los kilos entregados y la hora real de entrada al cargue y al descargue. El RNDC completa la llegada y la salida con el cumplido inicial que genera el GPS [Guia Cumplido 2.3]. |
| `GET` | `/api/despacho/remesas/:remesaId/gps` | Tiempos que ya reporto el GPS, para mostrarlos bloqueados al cumplir. |
| `GET` | `/api/despacho/remesas/:remesaId/cumplido` | Lo que quedo registrado en el cumplido de una remesa: kilos entregados y los seis tiempos, leidos del RNDC (la verdad, incluso si se cumplio en el portal). Si el RNDC no responde, lo que se envio desde este sistema. |
| `POST` | `/api/despacho/remesas/:remesaId/anular-cumplido` | Anula el cumplido de una remesa (proceso 28) para corregirlo y volver a cumplirla. La remesa vuelve a "creada" con los datos que tenia, para corregir solo lo que estaba mal. Si el manifiesto ya esta cumplido, el RNDC lo rechaza (ACR070): primero hay que anular el cumplido del manifiesto. |
| `POST` | `/api/despacho/:id/cumplir/sincronizar` | Adopta lo cumplido en el portal (sincronizarCumplidos) y devuelve lo adoptado, el viaje y sus remesas. Si el RNDC no responde, devuelve el error sin fallar: la ventana sigue con lo local. |
| `GET` | `/api/despacho/:id/cumplir/previa` | Datos para el formulario del cumplido del manifiesto: flete, anticipo, vacios, retencion y FOPAT calculados, tiempos logisticos con el piso SICETAC del cumplido, y los motivos permitidos de adicional y descuento. |
| `POST` | `/api/despacho/:id/cumplir` | Cumple el manifiesto en el RNDC (proceso 6). |
| `GET` | `/api/despacho/:id/manifiesto.pdf` | PDF del manifiesto, tal como lo genera el Ministerio. |
| `GET` | `/api/despacho/:id/manifiesto-contingencia` | Manifiesto de contingencia (HTML para imprimir): cuando el RNDC no deja expedir el manifiesto o no entrega su PDF. Lleva los mismos datos que se envian al RNDC, sin QR y con el aviso de contingencia. El viaje queda marcado y con alerta hasta que se imprime el oficial. ?motivo= el error que se vio. |
| `GET` | `/api/despacho/remesas/:remesaId/imprimir` | Impresion de una remesa. |
| `GET` | `/api/despacho/:id/remesas` | Remesas de un viaje, con su consecutivo y radicado. |
| `GET` | `/api/despacho/sugerencias/:vehiculoId` | Remolque y conductor sugeridos para un vehiculo: el que mas ha usado en sus ultimos viajes; si no tiene historial, el habitual del catalogo (placaRemolque y cedulaConductorHabitual). Solo sugiere: el despachador puede cambiarlos. |
| `GET` | `/api/despacho/siguiente-consecutivo` | Siguiente numero disponible, para precargar el campo del despacho. Se puede cambiar: lo devuelto es una sugerencia, no una reserva. |
| `GET` | `/api/despacho/consecutivos` | Libro de consecutivos: una fila por remesa (la hoja de control de la empresa). |
| `GET` | `/api/despacho/:id/detalle` | Todo lo que se registro al despachar un viaje, para leerlo en una sola ventana: documentos y radicados, vehiculo y conductores, cada remesa con sus partes y su mercancia, valores, tiempos pactados, y quien hizo que. |
| `GET` | `/api/despacho/sincronizacion` | Estado de la sincronizacion automatica con el RNDC. |
| `POST` | `/api/despacho/sincronizacion` | Sincroniza ya con el RNDC (los ultimos dias, o todo desde septiembre con { completa: true }) y devuelve lo que cambio. |
| `GET` | `/api/despacho/historial` | Todos los viajes (la tabla pagina de a 50 en el navegador). A los manifiestos vigentes sin cumplir cuya cita de descargue ya paso les agrega el plazo del cumplido (5 dias habiles). |
| `GET` | `/api/despacho/fopat` | FOPAT causado por mes, con lo que falta pagar a la DIAN. |
| `POST` | `/api/despacho/fopat/pagar` | Marca un lote de manifiestos como incluidos en un pago de FOPAT. |
| `GET` | `/api/despacho/:id` | Detalle de un viaje con sus remesas. |
| `GET` | `/api/seguimiento/alertas` | Alertas de papeles, facturacion y cartera. |
| `GET` | `/api/seguimiento/papeles` | Viajes sin factura con su alerta de papeles y de facturacion. |
| `POST` | `/api/seguimiento/papeles/:id` | Registra lo que se supo de los papeles ({ estadoPapeles?, papelesTiene?, papelesCompletos?, papelesFaltan?, nota? }). Devuelve el viaje del cuadro actualizado (404 si no existe). |
| `GET` | `/api/seguimiento/cartera` | Facturas por cobrar, totales por cliente y facturados sin datos. Con dueno (MAURICIO, CELSO, MILLER, LUISA o TERCEROS), solo la parte de los vehiculos de ese dueno. |
| `GET` | `/api/seguimiento/anticipos-empresas` | Viajes con anticipo que da la empresa (Zorro, Aburra Limpio, sin manifiesto) y lo que debe cada cliente. |
| `POST` | `/api/seguimiento/anticipos-empresas/pago` | La empresa pago el anticipo de esos viajes ({ ids, fecha }). |
| `GET` | `/api/seguimiento/terceros` | Viajes de vehiculos terceros con lo que se les paga (valor pactado - anticipos - retenciones si aplican) y el resumen por tercero. |
| `POST` | `/api/seguimiento/terceros/nombres/previa` | A que vehiculos se le pone cada nombre de la Matriz Terceros ({ terceros: [{ nombre, cedula, placas }] }). No guarda. |
| `POST` | `/api/seguimiento/terceros/nombres` | Pone esos nombres como titular de los vehiculos. |
| `GET` | `/api/seguimiento/rentabilidad` | Todos los viajes no anulados con su grupo (TERCEROS, CELSO, MAURICIO...) y lo que deja cada uno (ver src/rentabilidad.ts). |
| `GET` | `/api/seguimiento/rentabilidad/matrices` | Comisiones y retenciones por cliente. |
| `PUT` | `/api/seguimiento/rentabilidad/matrices` | Reemplaza las matrices ({ comisiones?, retenciones? }). |
| `POST` | `/api/seguimiento/terceros/pago` | Se le pago al tercero esos viajes ({ ids, fecha, cuentaCobro? }). |
| `PUT` | `/api/seguimiento/cartera/anticipo` | Anticipo del cliente de una factura ({ facturaNumero, empresa, valor }). |
| `POST` | `/api/seguimiento/cartera/importar/previa` | Propone como cargar cada factura del Excel "Cartera Total" ({ facturas }): saldo sin viaje o ligada a sus viajes. No guarda nada. |
| `POST` | `/api/seguimiento/cartera/importar` | Carga las facturas confirmadas ({ facturas }). |
| `PUT` | `/api/seguimiento/cartera/plazos` | Plazo y contacto de cobro de un cliente. |
| `GET` | `/api/seguimiento/cartera/gestiones` | Gestiones de cobro de una factura. |
| `POST` | `/api/seguimiento/cartera/gestiones` | Anota una gestion de cobro ({ facturaNumero, empresa, texto, compromisoPago? }). Devuelve las de esa factura. |
| `POST` | `/api/seguimiento/cartera/pago` | Pago de una factura ({ facturaNumero, empresa, fecha }). |
| `GET` | `/api/usuarios` | Lista de usuarios del sistema. |
| `POST` | `/api/usuarios` | Crea un usuario con una clave temporal. |
| `PUT` | `/api/usuarios/:id` | Cambia nombre y/o estado activo. |
| `POST` | `/api/usuarios/:id/restablecer-clave` | Genera una clave temporal nueva y cierra las sesiones de ese usuario. |
<!-- RUTAS:FIN -->

---

## 12. Referencia de funciones

Generada a partir de los comentarios del código con `npm run docs`. Cada
entrada indica la firma, el tipo (función, método, componente, ruta) y qué
hace y cómo.

<!-- REFERENCIA:INICIO -->
_724 funciones, componentes, métodos y rutas en 50 archivos._

- [`src/alertas.ts`](#srcalertasts) (5)
- [`src/anticipos.ts`](#srcanticiposts) (31)
- [`src/auth.ts`](#srcauthts) (35)
- [`src/cifrado.ts`](#srccifradots) (4)
- [`src/clientesCobro.ts`](#srcclientescobrots) (3)
- [`src/config.ts`](#srcconfigts) (3)
- [`src/consecutivos.ts`](#srcconsecutivosts) (5)
- [`src/contingencia.ts`](#srccontingenciats) (9)
- [`src/correo.ts`](#srccorreots) (9)
- [`src/cuadro.ts`](#srccuadrots) (43)
- [`src/db.ts`](#srcdbts) (3)
- [`src/duenos.ts`](#srcduenosts) (1)
- [`src/facturacion.ts`](#srcfacturacionts) (11)
- [`src/fechas.ts`](#srcfechasts) (1)
- [`src/flota.ts`](#srcflotats) (1)
- [`src/importaciones.ts`](#srcimportacionests) (14)
- [`src/index.ts`](#srcindexts) (1)
- [`src/relacionesBomba.ts`](#srcrelacionesbombats) (18)
- [`src/rentabilidad.ts`](#srcrentabilidadts) (9)
- [`src/repo.ts`](#srcrepots) (94)
- [`src/reportes.ts`](#srcreportests) (10)
- [`src/rndc/builders.ts`](#srcrndcbuildersts) (44)
- [`src/rndc/client.ts`](#srcrndcclientts) (12)
- [`src/rndc/conexion.ts`](#srcrndcconexionts) (4)
- [`src/rndc/consultas.ts`](#srcrndcconsultasts) (16)
- [`src/rndc/estampado.ts`](#srcrndcestampadots) (4)
- [`src/rndc/maestros.ts`](#srcrndcmaestrosts) (9)
- [`src/rndc/manifiesto-contingencia.ts`](#srcrndcmanifiestocontingenciats) (5)
- [`src/rndc/pdf.ts`](#srcrndcpdfts) (4)
- [`src/rndc/remesa-impresion.ts`](#srcrndcremesaimpresionts) (7)
- [`src/rndc/sicetac.ts`](#srcrndcsicetacts) (14)
- [`src/rndc/sincronizacion.ts`](#srcrndcsincronizacionts) (26)
- [`src/routes/auth.ts`](#srcroutesauthts) (6)
- [`src/routes/catalogo.ts`](#srcroutescatalogots) (46)
- [`src/routes/cuadro.ts`](#srcroutescuadrots) (45)
- [`src/routes/despacho.ts`](#srcroutesdespachots) (48)
- [`src/routes/seguimiento.ts`](#srcroutesseguimientots) (20)
- [`src/routes/usuarios.ts`](#srcroutesusuariosts) (5)
- [`src/scripts/borrar-viaje.ts`](#srcscriptsborrarviajets) (6)
- [`src/scripts/cargar-datos.ts`](#srcscriptscargardatosts) (3)
- [`src/scripts/crear-usuario.ts`](#srcscriptscrearusuariots) (1)
- [`src/scripts/habituales.ts`](#srcscriptshabitualests) (5)
- [`src/scripts/importar.ts`](#srcscriptsimportarts) (10)
- [`src/scripts/probar-correo.ts`](#srcscriptsprobarcorreots) (1)
- [`src/scripts/respaldo.ts`](#srcscriptsrespaldots) (3)
- [`src/scripts/verificar-rndc.ts`](#srcscriptsverificarrndcts) (5)
- [`src/seed.ts`](#srcseedts) (1)
- [`src/seguimiento.ts`](#srcseguimientots) (37)
- [`src/tarifasFlete.ts`](#srctarifasfletets) (14)
- [`src/terceros.ts`](#srctercerosts) (13)

### `src/alertas.ts`

> Alertas de vencimiento de documentos.
>
> Por que importa: el RNDC valida SOAT, tecnomecanica y licencia contra la
> fecha mas alta de cita de DESCARGUE del manifiesto, no contra hoy. Un
> documento que vence pasado manana ya bloquea un viaje que descarga el
> viernes. Por eso las alertas miran hacia adelante y no solo a lo vencido.

- **`diasHasta(fecha)`** · _función_
  Dias calendario que faltan para una fecha (negativo si ya paso; null sin fecha).

  Compara solo el dia (en UTC, como se guardan las columnas DATE), no la hora:
  un documento que vence hoy sigue siendo valido hoy.

- **`severidadDe(dias, diasAviso)`** · _función_
  Clasifica una alerta segun los dias que faltan.

  VENCIDO si ya paso la fecha, POR_VENCER si cae dentro del umbral de aviso,
  VIGENTE en otro caso. Sin fecha cuenta como VIGENTE aqui; las alertas sin
  fecha se reportan aparte en revisarDocumentos.

- **`describir(tipo, sujeto, dias)`** · _función_
  Frase para mostrar en pantalla: "SOAT de SKN250 vence en 3 dia(s)", "vence hoy",
  "vencio hace 2 dia(s)" o "sin fecha registrada".

- **`alerta(tipo, sujeto, identificacion, fecha, diasAviso, origen, activo)`** · _función_
  Arma una alerta completa de un documento: calcula los dias restantes, la
  severidad y el mensaje, y guarda de que registro y campo sale la fecha para
  poder corregirla desde la alerta.

- **`revisarVencimientos(diasAviso, incluirInactivos)`** · _función_
  Revisa los vehiculos y conductores activos (los remolques no tienen SOAT ni
  tecnomecanica) y la poliza de carga de la empresa.

  Los registros sin fecha se reportan aparte: no estan vencidos, pero tampoco
  se puede afirmar que esten vigentes, y esa diferencia importa porque el
  despacho si los deja pasar.

### `src/anticipos.ts`

> Anticipos de los viajes: efectivo y combustible (bomba / EDS).
>
> Se llevan de dos formas a la vez (como el Excel "cuadro de anticipos"):
> - Por tanqueo (anticipos_tanqueo): lo que se entrego de una vez en una
>   bomba, que puede cubrir la ida y la vuelta. Es lo que se corrobora con la
>   factura de la bomba.
> - Por viaje (cuadro_anticipos): cada tramo (IDA o VUELTA) con su efectivo y
>   su combustible, sumado al viaje (recorrido / empresa) del cuadro pagos.
>
> Si el anticipo es de ida y vuelta, la vuelta se guarda sin viaje y se
> asigna sola al proximo viaje de esa placa (asignarVueltasPendientes), con
> su valor, su bomba y su fecha.
>
> Ida y vuelta en el Excel (y en lo que se cargo de el): no hay columna que lo
> diga; son dos anticipos de la misma placa, el mismo dia y en la misma
> bomba. juntarIdaYVuelta los deja en un solo tanqueo: la ida es la del viaje
> despachado mas cerca del dia del tanqueo (el que sale de Bogota / Soacha);
> la otra es la vuelta (ver elegirIdaYVuelta). Si son 3 o mas el mismo dia,
> no se juntan solos: la pantalla los muestra como posible vuelta.
>
> Cuentas con la bomba (resumirBomba): lo que se le debe (todo lo entregado en
> la bomba), lo pagado, lo que abono un socio (el Zorro) por algunos viajes y
> el cupo de credito que queda.
>
> Cruce con la relacion quincenal de la bomba: el combustible de cada tramo es
> la formula de la columna COMBUST. del Excel, que da el valor exacto
> (redondeado): round(galones x precio por galon - descuento). El precio se
> sugiere desde los parametros (11.390); el descuento (por la sociedad) se
> sugiere como galones x descuento por galon (250), en pesos. Los dos se
> pueden cambiar en cada tramo.

- **`placaNormal(p)`** · _función_
  Placa comparable: mayusculas sin guion ni espacios ("SZP-339" -> "SZP339").

- **`pesos(v, campo)`** · _función_
  Valor en pesos >= 0; vacio -> 0. Lanza ErrorCuadro si no es numero.

- **`fecha(v, campo)`** · _función_
  Fecha "AAAA-MM-DD" valida o ErrorCuadro.

- **`validarAnticipo(d)`** · _función_
  Valida el anticipo del formulario. Reglas:
  - Fecha obligatoria; al menos un valor (efectivo o combustible) en la ida.
  - Si hay combustible (ida o vuelta), la bomba es obligatoria.
  - Ida y vuelta: la vuelta debe tener algun valor.
  - Compatibilidad: "valor" sin desglose se toma como combustible.

- **`mapear(r)`** · _función_
  Fila de SELECT_ANTICIPOS -> FilaAnticipo.

- **`distancia(a, b)`** · _función_
  Dias entre dos fechas "AAAA-MM-DD" (sin signo); sin fecha, muy lejos.

- **`elegirIdaYVuelta(a, b)`** · _función_
  Cual de dos tanqueos del mismo dia es la ida y cual la vuelta: la ida es la
  del viaje despachado mas cerca del dia del tanqueo; si empatan, la que sale
  de Bogota / Soacha; si no, el viaje mas antiguo.

- **`parejasIdaYVuelta(sueltos)`** · _función_
  Parejas de ida y vuelta entre los tanqueos sueltos: exactamente dos de la
  misma placa, el mismo dia y la misma bomba (con 3 o mas no se sabe cuales
  van juntos). No junta dos con facturas de la bomba distintas.

- **`descuentoSugerido(galones, descuentoPorGalon)`** · _función_
  Descuento sugerido en pesos: galones x descuento por galon, redondeado.

- **`combustibleSegunFormula(galones, precioGalon, descuento)`** · _función_
  Combustible de un tramo segun la relacion de la bomba (la formula de la
  columna COMBUST. del Excel): round(galones x precio - descuento).
  Ej.: 100,182 galones x 11.230 - 25.044 = 1.100.000.

- **`resumirBomba(tramos, abonadoSocio, p, abonosSinUsar)`** · _función_
  Cuentas con la bomba a partir de los tramos: solo cuentan los entregados en
  una bomba (los de solo efectivo sin bomba no son deuda con ella).

  Los abonos de los socios que ya se descontaron en un pago a la bomba estan
  dentro de lo pagado (sus tramos quedaron pagados): a la deuda solo se le
  restan los que aun no se han usado (`abonosSinUsar`; por defecto, todos).

- **`anticipos`** · _módulo_
  Anticipos por tanqueo y por tramo: registrar, asignar vueltas, listar y corregir.

  - **`anticipos.registrar(cuadroViajeId, d, usuarioId)`** · _método_
    Registra un anticipo en un viaje del cuadro: crea el tanqueo, el tramo de
    IDA en este viaje y, si es de ida y vuelta, el tramo de VUELTA pendiente
    (se asigna solo al proximo viaje de la placa). Todo en una transaccion.

  - **`anticipos.asignarVueltasPendientes()`** · _método_
    Asigna cada vuelta pendiente al proximo viaje de su placa: el primero del
    cuadro (no anulado) despues del viaje de ida, por fecha y luego por orden
    de creacion. Si aun no hay, sigue pendiente. Devuelve cuantas asigno.

  - **`anticipos.sueltos()`** · _método_
    Tanqueos de un solo tramo de IDA (sin juntar), con su viaje.

  - **`anticipos.juntar(ida, vuelta)`** · _método_
    Junta un tanqueo de ida con otro como su vuelta: el tramo de la vuelta
    pasa al tanqueo de la ida como VUELTA y el tanqueo de la vuelta se borra.
    Si los dos estaban en el mismo viaje, la vuelta queda para el proximo
    viaje de la placa.

  - **`anticipos.juntarIdaYVuelta()`** · _método_
    Junta solos los pares de ida y vuelta (ver parejasIdaYVuelta). Devuelve cuantos junto.

  - **`anticipos.juntarManual(idaTanqueoId, vueltaTanqueoId)`** · _método_
    Junta a mano dos tanqueos de la misma placa (la posible vuelta que muestra
    la pantalla): el primero es la ida. Los dos deben ser de un solo tramo.

  - **`anticipos.separarVuelta(tanqueoId)`** · _método_
    Separa la vuelta de un tanqueo de ida y vuelta: queda como un tanqueo de
    ida propio en el mismo viaje (para corregir una pareja mal hecha).

  - **`anticipos.delViaje(cuadroViajeId)`** · _método_
    Los tramos de un viaje (para su detalle), por fecha.

  - **`anticipos.cuadro()`** · _método_
    El cuadro de anticipos completo (una fila por tramo), lo mas reciente primero.

  - **`anticipos.actualizarTanqueo(id, d)`** · _método_
    Datos de la factura de la bomba de un tanqueo (para corroborarlo): numero,
    fecha y, si hace falta, la bomba (cambia tambien en sus tramos).

  - **`anticipos.actualizarTramo(id, d)`** · _método_
    Cambia un tramo desde el cuadro de anticipos: fecha de pago, nota, a que
    viaje se suma (para corregir una vuelta asignada al viaje equivocado), el
    efectivo o el combustible a mano (para corregir lo que no coincide con la
    bomba; el valor total se recalcula), aceptar lo que cobro la bomba
    (aceptarBomba: la diferencia queda resuelta) o
    los datos del cruce: galones, precio por galon y descuento. Con galones,
    el combustible del tramo se recalcula con la formula de la bomba (precio
    y descuento vacios = los sugeridos) y se guarda lo que se habia
    registrado antes, para ver la diferencia.

  - **`anticipos.cruzarTramo(id, d)`** · _método_
    Cruce de un tramo con la relacion de la bomba: guarda galones, precio y
    descuento y recalcula el combustible con la formula. Precio vacio = el
    sugerido; descuento vacio = galones x descuento por galon sugerido. Sin
    galones, el tramo vuelve al combustible que se habia registrado.

  - **`anticipos.borrarTramo(id)`** · _método_
    Quita un tramo. Si era la ida de un anticipo de ida y vuelta, tambien
    quita la vuelta que aun no se asigno a ningun viaje. Si el tanqueo queda
    sin tramos, se borra.

  - **`anticipos.parametrosBomba()`** · _método_
    Cupo con la bomba, precio por galon y descuento por galon sugeridos.

  - **`anticipos.guardarParametrosBomba(d)`** · _método_
    Cambia el cupo con la bomba y/o los valores sugeridos del cruce.

  - **`anticipos.resumen()`** · _método_
    Cuentas con la bomba: deuda, pagado, abonado por el socio, pendiente y cupo disponible.

  - **`anticipos.abonos()`** · _método_
    Abonos del socio, el mas reciente primero, con sus viajes.

  - **`anticipos.registrarAbono(d, usuarioId)`** · _método_
    Registra un abono del socio: socio, fecha, nota y los viajes con el valor
    de cada uno (al menos uno). El valor del abono es la suma de los viajes.

  - **`anticipos.borrarAbono(id)`** · _método_
    Borra un abono del socio (y su reparto en los viajes).

### `src/auth.ts`

> Autenticacion: usuarios con email + contrasena y sesiones en cookie.
>
> - Contrasenas con scrypt (incluido en Node, sin dependencias) y sal propia
>   por usuario. Nunca se guarda ni se registra la contrasena en claro.
> - La sesion es un token aleatorio en una cookie HttpOnly: el JavaScript del
>   navegador no puede leerlo (protege contra XSS) y viaja solo, lo que
>   permite abrir los PDF del manifiesto en otra pestana. En la base se guarda
>   el HASH del token: si alguien lee la tabla, no puede usar las sesiones.
> - La sesion vence tras 12 horas sin actividad; cada peticion la renueva.
> - Tras varios intentos fallidos se bloquea el login un rato (en memoria).
>
> Por ahora no hay roles: todo usuario activo puede todo.

- **`scryptAsync(clave, sal, largo)`** · _función_
  Version con promesa de crypto.scrypt: deriva una llave de 'largo' bytes a
  partir de la contrasena y la sal, con los parametros de PARAMETROS_SCRYPT.

- **`hashClave(clave)`** · _función_
  "scrypt$<sal base64>$<hash base64>"

- **`verificarClave(clave, guardado)`** · _función_
  Comprueba una contrasena contra el hash guardado ("scrypt$sal$hash").

  Vuelve a derivar la llave con la misma sal y la compara en tiempo constante
  (timingSafeEqual), para no revelar por el tiempo de respuesta cuantos bytes
  coincidieron. Un formato desconocido devuelve false.

- **`problemaConClave(clave)`** · _función_
  Reglas de una contrasena nueva: minimo LARGO_MINIMO_CLAVE caracteres, con
  letras y numeros. Devuelve el mensaje del problema o null si sirve.

- **`claveTemporal()`** · _función_
  Contrasena temporal legible (sin 0/O ni 1/l para dictarla sin confusiones).

- **`mapUsuario(r)`** · _función_
  Fila de la tabla usuarios -> objeto Usuario (sin el hash de la clave, que
  solo sale de este modulo en conClavePorEmail).

- **`normalizarEmail(e)`** · _función_
  Correo sin espacios y en minuscula: asi se guarda y asi se busca.

- **`emailValido(e)`** · _función_
  Validacion basica de formato de correo (algo@dominio.ext).

- **`usuarios`** · _módulo_
  Repositorio de usuarios del sistema (tabla usuarios).

  - **`usuarios.listar()`** · _método_
    Todos los usuarios, ordenados por nombre.

  - **`usuarios.porId(id)`** · _método_
    Un usuario por id, o null.

  - **`usuarios.conClavePorEmail(email)`** · _método_
    Usuario con su hash de clave, para verificar el login. Solo lo usa la ruta de login.

  - **`usuarios.crear(email, nombre, clave, debeCambiar)`** · _método_
    Crea un usuario guardando el hash de la clave (nunca la clave).
    debeCambiar=true obliga a cambiarla al primer ingreso (clave temporal).

  - **`usuarios.cambiarClave(id, clave, debeCambiar)`** · _método_
    Reemplaza la clave de un usuario (guarda el hash nuevo) y fija si debe
    cambiarla en el proximo ingreso.

  - **`usuarios.actualizar(id, datos)`** · _método_
    Cambia nombre y/o estado activo. Los campos ausentes no se tocan.

  - **`usuarios.contarActivos()`** · _método_
    Cuantos usuarios activos hay (para no desactivar al ultimo).

- **`hashToken(t)`** · _función_
  SHA-256 en hexadecimal del token de sesion: es lo que se guarda en la base.

- **`sesiones`** · _módulo_
  Sesiones abiertas (tabla sesiones). Se guarda el HASH SHA-256 del token,
  nunca el token: quien lea la tabla no puede suplantar a nadie.

  - **`sesiones.crear(usuarioId)`** · _método_
    Abre una sesion: genera un token aleatorio de 32 bytes, guarda su hash con
    vencimiento por inactividad, anota el ultimo acceso del usuario y devuelve
    el token (que viaja en la cookie).

  - **`sesiones.validar(token)`** · _método_
    Usuario de la sesion si es valida; ademas la renueva (inactividad).

  - **`sesiones.cerrar(token)`** · _método_
    Cierra la sesion de ese token (logout).

  - **`sesiones.cerrarTodasDe(usuarioId, exceptoToken)`** · _método_
    Al desactivar un usuario o restablecer su clave, sus sesiones mueren.

  - **`sesiones.limpiarVencidas()`** · _método_
    Borra las sesiones vencidas (mantenimiento).

- **`leerToken(req)`** · _función_
  Saca el token de sesion de la cabecera Cookie de la peticion, o null si no viene.

- **`ponerCookie(res, token, req)`** · _función_
  Pone la cookie de sesion: HttpOnly (el JavaScript de la pagina no la lee),
  SameSite=Lax, y Secure cuando la peticion llego por HTTPS.

- **`borrarCookie(res)`** · _función_
  Borra la cookie de sesion del navegador (logout).

- **`exigirSesion(req, res, next)`** · _función_
  Filtro: toda ruta de la API (menos el login) exige una sesion valida.

- **`minutosBloqueado(clave)`** · _función_
  Minutos que faltan si esta bloqueado; 0 si puede intentar.

- **`registrarFallo(clave)`** · _función_
  Suma un intento fallido de login para esa clave (correo o IP). Al llegar a
  MAX_INTENTOS bloquea durante BLOQUEO_MS (10 minutos).

- **`limpiarFallos(clave)`** · _función_
  Olvida los fallos de esa clave (tras un login correcto).

- **`hashCodigo(usuarioId, codigo)`** · _función_
  El hash lleva el id del usuario: el mismo codigo no sirve para otra cuenta.

- **`recuperaciones`** · _módulo_
  Codigos de recuperacion de contrasena por correo (tabla recuperaciones).
  Se guarda el hash del codigo, su vencimiento y los intentos fallidos.

  - **`recuperaciones.crear(usuarioId)`** · _método_
    Genera un codigo nuevo de 6 digitos; anula los anteriores del usuario.

  - **`recuperaciones.verificar(usuarioId, codigo)`** · _método_
    true si el codigo es valido y vigente. Cada fallo suma un intento; al
    llegar al maximo el codigo se anula y hay que pedir otro.

  - **`recuperaciones.borrarDe(usuarioId)`** · _método_
    Anula los codigos pendientes de un usuario (tras usarlos).

### `src/cifrado.ts`

> Cifrado de datos sensibles guardados en la base (hoy: la clave de la
> plataforma GPS de cada vehiculo).
>
> AES-256-GCM con una llave derivada (scrypt) de TMS_CLAVE_CIFRADO del .env.
> Quien lea la base sin el .env no ve las claves. GCM ademas detecta si el
> texto guardado fue alterado.
>
> Formato guardado: "v1:" + base64(iv de 12 bytes | etiqueta de 16 | cifrado).
>
> Si se cambia TMS_CLAVE_CIFRADO, las claves guardadas ya no se pueden leer y
> hay que volver a escribirlas.

- **`ErrorCifrado`** · _clase_
  Falta la llave o el dato guardado no se puede descifrar.

- **`llave()`** · _función_
  Llave de 32 bytes derivada de TMS_CLAVE_CIFRADO (minimo 16 caracteres).

- **`cifrar(texto)`** · _función_
  Cifra un texto para guardarlo en la base.

- **`descifrar(guardado)`** · _función_
  Descifra lo que guardo cifrar(). Lanza ErrorCifrado si no se puede.

### `src/clientesCobro.ts`

> Cliente al que se le cobra: varios nombres de empresa del cuadro son cobros
> a la misma empresa con distinto concepto ("RECONOCIDO CARTONES AMERICA",
> "CARTONES AMERICA URBANO", "CORAME RECONOCIDO CARTULINA BOGOTA" son todos
> de CARTONES AMERICA; "RECICLAJES URBANO TOCANCIPA" es de RECICLAJES BOGOTA).
> En cartera y en los reportes se agrupan por el cliente y se muestra su
> concepto. El nombre original de la empresa no se cambia: sigue siendo la
> llave de la factura (pagos, gestiones, anticipos).
>
> Es una lista cerrada, a proposito: solo se juntan los clientes de la lista
> (una regla general podria juntar dos empresas que solo se parecen).

- **`normal(t)`** · _función_
  Nombre comparable: mayusculas, sin tildes, sin puntos ni comas, espacios simples.

- **`limpiar(t)`** · _función_
  Lo que sobra del nombre, sin tipo de sociedad ni signos sueltos.

- **`clienteDeCobro(empresa, concepto)`** · _función_
  Cliente de cobro y concepto de una empresa del cuadro. Si el nombre es una
  variante de un cliente de la lista (ALIAS_COBRO), el cliente es el de la
  lista y el concepto es lo que sobra del nombre ("URBANO", "RECONOCIDO",
  "CARTON"). Si no, el cliente es la misma empresa. `concepto` (el de un
  reconocido del cuadro) se usa si el nombre no trae uno.

### `src/config.ts`

> Configuracion del backend, leida del .env al arrancar.
>
> Agrupa en el objeto `config` la base de datos, los datos de la empresa, el
> ambiente del RNDC (pruebas o produccion, con su URL, credenciales, modo
> simulacion y reintentos), la numeracion de consecutivos y los filtros de
> SICETAC. Tiene frenos de seguridad: no arranca si el ambiente dice
> "pruebas" pero la URL apunta a produccion, ni expide en produccion sin la
> frase de confirmacion RNDC_CONFIRMO_PRODUCCION.

- **`leerAmbiente()`** · _función_
  Lee RNDC_AMBIENTE del .env ("pruebas" por defecto) y falla al arrancar si
  no es "pruebas" ni "produccion": un error de escritura no debe caer en
  produccion por accidente.

- **`hostDe(url)`** · _función_
  Nombre del servidor de una URL en minuscula, o "" si la URL no es valida.
  Sirve para comparar contra el host de pruebas (lista blanca).

- **`describirAmbiente()`** · _función_
  Banner de arranque: que ambiente esta activo nunca deberia ser una sorpresa.

### `src/consecutivos.ts`

> Numeracion de remesas y manifiestos.
>
> Convencion historica de la empresa: un mismo numero base identifica todo el
> viaje. El manifiesto lo usa tal cual, y cuando el viaje lleva varias remesas,
> la primera tambien va sin sufijo y las siguientes llevan una letra.
>
>   Un cliente:    REM 00006692            MAN 00006692
>   Tres clientes: REM 00006692            MAN 00006692
>                  REM 00006692A
>                  REM 00006692B
>
> Asi, viendo cualquier remesa se sabe a que manifiesto pertenece.
>
> El RNDC solo exige que el consecutivo sea alfanumerico, de maximo 15
> caracteres y que no se repita dentro de la empresa [MANIFIESTO V7 pag. 5,
> REMESA V5 pag. 7]. La convencion de la letra cabe sin problema.

- **`consecutivoRemesa(base, orden)`** · _función_
  Consecutivo de una remesa segun su posicion en el viaje.

  @param base  Numero base del viaje, ej. "00006692".
  @param orden Posicion de la remesa, empezando en 1.

- **`consecutivosDeViaje(base, cantidadRemesas)`** · _función_
  Los consecutivos de todas las remesas de un viaje, en orden.

- **`siguienteBase(ultimoUsado, longitud, prefijo)`** · _función_
  Siguiente numero base a partir del ultimo usado.

  Solo mira la parte numerica, asi que ignora los sufijos de letra: si el
  ultimo viaje llego hasta 00006692B, el siguiente base es 00006693.

- **`mayorConsecutivo(...candidatos)`** · _función_
  El mayor de varios consecutivos, comparando solo sus digitos. Sirve para que
  el siguiente sugerido no quede por debajo de la numeracion del portal.

- **`validarBase(base, cantidadRemesas, yaUsados)`** · _función_
  Revisa que el numero base sirva antes de intentar el despacho.

  El RNDC rechaza el manifiesto completo si el consecutivo se repite, y ese
  rechazo llega despues de haber creado las remesas: mas vale atajarlo aqui.

### `src/contingencia.ts`

> Manifiestos de contingencia (ver rndc/manifiesto-contingencia.ts): cuando
> el RNDC no deja expedir el manifiesto o no entrega su PDF, la empresa
> imprime uno propio para que el carro salga. El viaje queda marcado
> (viajes.contingenciaEn) y con alerta en la campana hasta que se imprime el
> manifiesto oficial.

- **`t(x)`** · _función_
  Valor del manifiesto como texto; vacio -> null.

- **`n(x)`** · _función_
  Valor del manifiesto como numero; vacio -> 0.

- **`nombresMunicipios(codigos)`** · _función_
  Nombre "MUNICIPIO DEPARTAMENTO" de cada codigo de 8 digitos: del catalogo de
  municipios; si no se importo, la ciudad de algun tercero de ese municipio
  (como el cuadro pagos).

- **`nombreTitular(numId, nombreFlota)`** · _función_
  Nombre del titular del manifiesto: el de Flota, o el tercero o conductor con esa cedula.

- **`datosContingencia(viaje, manifiesto, via, motivo)`** · _función_
  Datos del manifiesto de contingencia de un viaje, a partir de lo que se
  envia (o se enviaria) al RNDC (manifiesto = construirDatosManifiesto) y de
  las plantillas de sus remesas.

- **`contingencia`** · _módulo_
  Repositorio de la marca de contingencia de los viajes.

  - **`contingencia.marcar(viajeId, motivo)`** · _método_
    Marca el viaje: se imprimio de contingencia (conserva la primera fecha; el motivo, el ultimo).

  - **`contingencia.resolver(viajeId)`** · _método_
    Se imprimio el manifiesto oficial: ya no hay contingencia pendiente.

  - **`contingencia.pendientes()`** · _método_
    Viajes con contingencia pendiente (no anulados), los mas viejos primero.

### `src/correo.ts`

> Envio de correos por SMTP (cuenta de Gmail / Google Workspace).
>
> Se configura en el .env:
>   SMTP_HOST=smtp.gmail.com
>   SMTP_PUERTO=465
>   SMTP_USUARIO=cuenta@gmail.com
>   SMTP_CLAVE=<contrasena de aplicacion de 16 letras>
>   SMTP_REMITENTE="Transportes Lopez <cuenta@gmail.com>"   (opcional)
>
> Gmail no acepta la contrasena normal de la cuenta por SMTP: hay que activar
> la verificacion en dos pasos y crear una "contrasena de aplicacion"
> (myaccount.google.com/apppasswords). El puerto 465 usa TLS directo.
> Otro proveedor (Office 365, hosting) funciona cambiando host y puerto.
>
> Si no esta configurado, correoConfigurado() es false y quien lo usa debe
> tener un plan B (por ejemplo, mostrar la clave temporal en pantalla).

- **`correoConfigurado()`** · _función_
  true si hay usuario y clave SMTP en el .env. Si es false, quien envia
  correos debe tener un plan B (mostrar la clave temporal en pantalla).

- **`obtenerTransporte()`** · _función_
  Conexion SMTP de nodemailer, creada una sola vez y reutilizada. Puerto 465
  = TLS directo (Gmail); cualquier otro exige STARTTLS.

- **`enviarCorreo(para, asunto, texto, html)`** · _función_
  Envia un correo en texto y HTML desde el remitente configurado. Lanza error
  si el correo no esta configurado o el servidor lo rechaza.

- **`verificarCorreo()`** · _función_
  Verifica conexion y credenciales sin enviar nada.

- **`escapar(s)`** · _función_
  Escapa &, <, > y comillas para meter texto en el HTML del correo.

- **`envoltura(titulo, cuerpo)`** · _función_
  Plantilla HTML comun de los correos: tarjeta blanca con el nombre de la
  empresa, el titulo, el cuerpo y el pie de "correo automatico".

- **`bloqueCodigo(codigo)`** · _función_
  Recuadro destacado para un codigo o clave temporal dentro del correo.

- **`correoClaveTemporal(nombre, email, claveTemp, motivo)`** · _función_
  Correo con usuario y clave temporal, para una cuenta nueva o una clave
  restablecida. Devuelve asunto, texto plano y HTML.

- **`correoCodigoRecuperacion(nombre, codigo, minutos)`** · _función_
  Correo con el codigo de 6 digitos para recuperar la contrasena y los
  minutos de vigencia. Devuelve asunto, texto plano y HTML.

### `src/cuadro.ts`

> Cuadro pagos: control operativo y financiero de los viajes.
>
> Reemplaza la hoja "CUADRO PAGOS" de Excel. Cada fila es un viaje
> facturable (empresa + remision), tenga manifiesto o no. El estado no se
> pinta a mano como en el Excel: se deduce de los datos.
>
> Colores del Excel y su equivalente aqui:
> - blanco: en proceso (EN_RUTA, o sin nada especial)
> - morado: descargo y los papeles aun no estan radicados (las secretarias
>   llaman al conductor)
> - verde (remision): papeles radicados en el cliente
> - azul (fecha): facturado, pero sin numero ni fecha de factura anotados
> - naranja: revisado por contabilidad, falta la gerente
> - amarillo: todo pagado

- **`papelesListos(e)`** · _función_
  Papeles listos para facturar: "listo para facturar" o, en CORAME, ya radicados.

- **`datosAHeredar(anulada, nueva)`** · _función_
  Que hereda la fila del manifiesto nuevo de la del manifiesto anulado al que
  reemplaza: solo lo que en la nueva esta vacio (nunca pisa lo que ya tiene).

  - Los campos de CAMPOS_HEREDABLES (remision, flete, factura, pagos,
    revisiones) si en la nueva son null o vacios.
  - El flete completo (tipo, tarifa y valor fijo) como un bloque, solo si la
    nueva no tiene ni tarifa ni valor fijo: asi no se mezclan dos fletes.
  - Los papeles, si la nueva sigue EN_RUTA y la anulada ya habia avanzado.
  - "Facturado", si la anulada ya estaba facturada.
  Lo que sale del manifiesto (placa, conductor, peso, fecha) es el de la nueva.

- **`reconocidosCorame(v)`** · _función_
  Que reconoce Cartones America por un viaje despachado desde alla (pueden
  ser los dos): 2.000 kg si lleva 4 o mas clientes, y lo que le falte para
  32.000 kg si sus remesas suman menos. Lo de los 32.000 kg es solo para
  tractomulas (configuracion articulada: 2S, 3S...); un camion de 16
  toneladas no se completa. Sin configuracion conocida, se completa.

- **`requiereAnticipoEmpresa(f)`** · _función_
  true si el viaje lleva anticipo de la empresa (ver CLIENTES_CON_ANTICIPO).
  Los urbanos no llevan: los que se facturan con una tarifa URBANO de la
  matriz ("ABURRA LIMPIO URBANO", "RECICLAJES URBANO TOCANCIPA") y, sin
  manifiesto, los que dicen URBANO en la empresa o la ruta.

- **`estadoAnticipoEmpresa(f)`** · _función_
  Estado del anticipo de la empresa de un viaje.

- **`esUrbano(f)`** · _función_
  Viaje urbano: su tarifa de la matriz dice URBANO, o dice URBANO en la
  empresa o la ruta escrita a mano, o sale y llega al mismo municipio. (La
  tarifa solo se conoce al facturar; por eso se mira tambien la ruta.)

- **`num(v)`** · _función_
  Numero de MySQL (DECIMAL llega como texto) a number; null se conserva.

- **`dia(v)`** · _función_
  DATE de MySQL como "AAAA-MM-DD". El pool trabaja en UTC (timezone "Z"): un
  DATE llega como medianoche UTC, asi que se lee en UTC para no correrse un dia.

- **`hoyColombia()`** · _función_
  Fecha de hoy en Colombia (el servidor corre en UTC: de noche ya seria manana).

- **`sumarDias(fecha, dias)`** · _función_
  Suma dias a una fecha "AAAA-MM-DD" y devuelve otra "AAAA-MM-DD".
  Trabaja a mediodia UTC para que ningun cambio de zona la corra de dia.
  Se usa para el vencimiento del saldo de terceros (descargue + 15 dias).

- **`estadoDe(f)`** · _función_
  Estado de una fila a partir de sus datos (exportado para las pruebas).

  - Todo pagado: solo cuando el cliente pago la factura (facturaFechaPago,
    "fecha pago factura"). La "fecha pago cliente" (facturaVence) es solo el
    vencimiento. El saldo del tercero y
    los anticipos de bomba se siguen aparte (columnas y "Saldos vencidos").
  - Papeles y factura son dos estados aparte: un viaje facturado sigue
    diciendo si sus papeles estan radicados o no. `estado` es el de los
    papeles (en proceso, sin radicar, listo para facturar, radicados) y
    `estadoFactura` el de la factura. Solo "todo pagado" (y anulado)
    reemplaza a los dos.
  - Facturado: cuando la factura tiene numero Y fecha, escritos a mano o con
    "Facturar varios". Con solo uno de los dos, o solo marcado, queda como
    "facturado sin datos".

- **`nombreMunicipio(codigo)`** · _función_
  Nombre de un municipio a partir de su codigo DIVIPOLA (expresion SQL):
  primero el catalogo de municipios; si no se importo, la ciudad de algun
  tercero de ese municipio. El RNDC devuelve los de Antioquia sin el cero
  inicial (5308000), por eso se comparan a 8 digitos.

- **`mapear(r)`** · _función_
  Fila de SELECT_CUADRO -> FilaCuadro.

  Normaliza tipos (fechas a texto, numeros, booleanos), calcula el valor del
  flete (kilos x tarifa, o el fijo), el vencimiento del saldo si es tercero, y
  el estado con estadoDe.

- **`anioPosible(f)`** · _función_
  true si la fecha "AAAA-MM-DD" tiene un año posible (ANIO_MINIMO a ANIO_MAXIMO).

- **`ErrorCuadro`** · _clase_
  Error de validacion del cuadro: la ruta lo responde como 422 con su mensaje.

- **`valorCampo(campo, tipo, crudo)`** · _función_
  Convierte un valor del formulario al tipo de su columna.

  booleano -> 1/0; vacio -> null; numero -> number >= 0 (si no, ErrorCuadro);
  fecha -> "AAAA-MM-DD" valida; texto -> recortado.

- **`validar(datos)`** · _función_
  Revisa y normaliza los datos antes de guardar: tipo de flete KILO/FIJO,
  estado de papeles valido, placa en mayuscula sin guiones ni espacios, y
  empresa en mayuscula. Lanza ErrorCuadro si algo no es valido.

- **`aPosible(t)`** · _función_
  Tarifa posible de la matriz como va en la fila.

- **`cuadro`** · _módulo_
  Repositorio del cuadro pagos: viajes, notas y anticipos de bomba.

  - **`cuadro.sincronizarManifiestos()`** · _método_
    Trae al cuadro los viajes con manifiesto expedido (una fila por remesa) y
    marca como anulados los que se anularon. Es idempotente: la llave unica
    de viajeRemesaId impide repetirlos, y no toca lo que ya se diligencio.

  - **`cuadro.generarReconocidosCorame()`** · _método_
    Reconocidos de Cartones America: por cada manifiesto despachado desde alla
    (alguna remesa con remitente Cartones America) se genera solo un viaje sin
    manifiesto por cada reconocido que le toque (ver reconocidosCorame):
    empresa CARTONES AMERICA, la fecha, la placa y el descargue del viaje, el
    peso reconocido y su concepto, sin anticipo de la empresa. Va con su
    propia factura y sus propias alertas, como cualquier viaje.

    Es idempotente (uno por manifiesto y tipo). Si el viaje cambia (peso,
    clientes) y el reconocido aun no se factura, se actualiza su peso; si ya
    no le toca o el manifiesto se anulo, queda anulado.

  - **`cuadro.reemplazarAnulados()`** · _método_
    Un manifiesto anulado y vuelto a expedir es el MISMO viaje: en el cuadro
    debe quedar una sola fila, la del manifiesto nuevo.

    Como funciona: para cada fila anulada busca la de un manifiesto vigente de
    la misma placa y empresa expedido despues, dentro de DIAS_REEXPEDICION
    dias (el mas cercano). Si la hay, en una transaccion le pasa lo que se
    habia diligenciado (datosAHeredar), le mueve los anticipos y las notas,
    deja una nota de que reemplaza al anulado y borra la fila anulada. Si no
    la hay (se anulo y no se volvio a expedir), la fila sigue como anulada.

  - **`cuadro.mantener()`** · _método_
    Mantenimiento del cuadro, aparte de las lecturas: pasa al cuadro los
    manifiestos nuevos (con los reconocidos de Cartones America), asigna las
    vueltas de anticipos de ida y vuelta y guarda los fletes exactos de la
    matriz. Corre cada MANTENIMIENTO_CADA_MS (ver index.ts) y despues de cada
    cambio (mantenerPronto). Una sola vuelta a la vez.

  - **`cuadro.mantenerPronto()`** · _método_
    Pide una vuelta de mantenimiento sin esperarla (despues de expedir,
    editar, importar...). Varias seguidas se juntan en una.

  - **`cuadro.listar()`** · _método_
    Todos los viajes del cuadro, del mas reciente al mas antiguo. Solo lee: el
    mantenimiento corre aparte (ver mantener). Si esta corriendo, espera a que
    termine; si nunca ha corrido o se atraso, lo corre antes. A los que no
    tienen flete les pone las tarifas posibles de la matriz (de memoria).

  - **`cuadro.agregarTarifasPosibles(filas)`** · _método_
    Tarifas posibles de la matriz en las filas sin flete (para elegir). Si la
    deduccion es exacta y aun no se guardo, va como unica posible.

  - **`cuadro.deducirFletes(filas)`** · _método_
    Deduce el flete de la matriz (ver src/tarifasFlete.ts) de los viajes sin
    flete, sin tarifa, no anulados, no enviados a facturar y no puestos a
    mano. Solo se guarda el exacto; los demas quedan para elegir (ver
    agregarTarifasPosibles). Devuelve cuantos se guardaron.

  - **`cuadro.aplicarTarifa(id, tarifaId)`** · _método_
    Pone en un viaje el flete de una tarifa de la matriz elegida a mano (una
    de las posibles, o cualquiera). Queda como manual: la deduccion ya no lo
    cambia.

  - **`cuadro.obtener(id)`** · _método_
    Un viaje con sus anticipos (cada tramo con efectivo, combustible y bomba;
    ver src/anticipos.ts) y sus notas (con autor), la mas reciente primero.
    null si no existe.

  - **`cuadro.crear(datos, usuarioId)`** · _método_
    Viaje sin manifiesto (urbano o planillado por el generador de carga).

  - **`cuadro.actualizar(id, datos)`** · _método_
    Guarda solo los campos que vienen en 'datos' (validados).

    Ademas: al pasar los papeles a RADICADO o RADICADOS sin fecha, se pone la de hoy en
    Colombia; al devolverlos a otro estado, se borra. Si cambia la placa, se
    vuelve a enlazar el vehiculo del catalogo.

  - **`cuadro.borrar(id)`** · _método_
    Solo los viajes creados a mano (sin manifiesto) se pueden borrar.

  - **`cuadro.revisar(id, quien, usuarioId, revisado)`** · _método_
    Revisado por contabilidad o por la gerente (o se quita la marca).

  - **`cuadro.facturar(ids, datos)`** · _método_
    Una factura que cubre varios viajes (los urbanos se facturan juntos).

  - **`cuadro.agregarNota(id, texto, usuarioId)`** · _método_
    Agrega una nota (maximo 1000 caracteres) con su autor. Una nota vacia es un error.

  - **`cuadro.borrarNota(id, notaId)`** · _método_
    Borra una nota de ese viaje.

  - **`cuadro.agregarAnticipo(id, d, usuarioId)`** · _método_
    Registra un anticipo en el viaje: efectivo y combustible, bomba, fecha y,
    si es de ida y vuelta, el anticipo de vuelta (queda para el proximo viaje
    de la placa). Ver anticipos.registrar.

  - **`cuadro.actualizarAnticipo(id, anticipoId, d)`** · _método_
    Solo la fecha de pago a la bomba y la nota se editan; lo demas se borra y se vuelve a crear.

  - **`cuadro.borrarAnticipo(id, anticipoId)`** · _método_
    Quita un anticipo de ese viaje (y la vuelta pendiente si era la ida; ver anticipos.borrarTramo).

- **`bombas`** · _módulo_
  Catalogo de bombas aliadas que entregan anticipos a los conductores.

  - **`bombas.listar()`** · _método_
    Todas las bombas, las activas primero.

  - **`bombas.crear(d)`** · _método_
    Crea una bomba (nombre y ciudad en mayuscula). Nombre + ciudad no se repiten.

  - **`bombas.actualizar(id, d)`** · _método_
    Cambia nombre, ciudad y/o si esta activa. Una bomba inactiva ya no se
    ofrece al registrar anticipos, pero sus anticipos viejos se conservan.

### `src/db.ts`

> Conexion a MySQL y esquema de la base.
>
> - `pool`: conexiones compartidas (mysql2, en UTC: timezone "Z").
> - `conCandado`: ejecuta una funcion con un candado de MySQL (GET_LOCK), por
>   ejemplo para que dos despachos no tomen el mismo consecutivo.
> - `initSchema`: crea las tablas y agrega las columnas que falten al arrancar.

- **`conCandado(nombre, fn, segundos)`** · _función_
  Ejecuta `fn` con un candado de MySQL (GET_LOCK) tomado: si otra peticion
  tiene el mismo candado, esta espera a que lo suelte.

  Se usa para la numeracion del despacho: elegir el siguiente consecutivo y
  guardar el viaje tiene que ser un solo paso. Sin el candado, dos personas
  que despachan al mismo tiempo leen el mismo "ultimo numero" y ambas toman
  el siguiente. El candado vive en MySQL (no en memoria), asi que sirve
  aunque algun dia corran varias copias del backend.

  GET_LOCK pertenece a la conexion, por eso se aparta una del pool durante
  todo el bloque. `fn` puede usar el pool normal para sus consultas.

- **`initSchema()`** · _función_
  Crea o actualiza el esquema de la base al arrancar el servidor.

  Como funciona:
  1. CREATE TABLE IF NOT EXISTS de cada tabla (no toca las que ya existen).
  2. Lista 'columnas': agrega las columnas nuevas que falten, consultando
     information_schema (MySQL no tiene ADD COLUMN IF NOT EXISTS).
  3. Indices y ajustes de datos idempotentes (se pueden correr en cada
     arranque sin pisar lo que ya esta).
  Asi un despliegue nuevo actualiza la base solo, sin migraciones manuales.

- **`unificarCollation()`** · _función_
  Deja todas las tablas con la misma collation que la tabla viajes.

  Por que: las tablas que se crean en un arranque toman la collation por
  defecto del servidor (en MySQL 8 es utf8mb4_0900_ai_ci), pero las que venian
  de antes pueden tener otra (utf8mb4_general_ci, como en MariaDB). Al
  comparar textos de dos tablas distintas en una consulta, MySQL responde
  "Illegal mix of collations ... for operation '='". Convirtiendo las que no
  coinciden, todas quedan iguales (solo se tocan las distintas, que suelen ser
  las nuevas y pequenas). Si algo falla se avisa y el sistema sigue.

### `src/duenos.ts`

> Duenos de los vehiculos, para separar la cartera por socio (filtro de
> Cartera). Cada vehiculo tiene su dueno en vehiculos.dueno; NULL = tercero.

- **`grupoDe(dueno)`** · _función_
  Grupo del vehiculo a partir de su dueno (vacio o desconocido = terceros).

### `src/facturacion.ts`

> Envio a facturacion: el cuadro que se le manda a la contadora (que factura
> en World Office) con los viajes listos para facturar, y la matriz de fletes
> de la que salen los valores sugeridos.
>
> - La matriz se importa desde el Excel "MATRIZ FLETES" (el frontend lo lee y
>   manda las filas); no vive en el repositorio porque son precios reales.
> - Lo que la matriz sugiere (valor, peso minimo) se puede cambiar en cada
>   viaje: hay valores negociados aparte. Al enviar, lo editado queda en el
>   viaje del cuadro pagos (flete, peso facturado, nota, remision, factura).

- **`texto(v, max)`** · _función_
  Texto recortado; vacio -> null.

- **`numero(v)`** · _función_
  Numero positivo; vacio o invalido -> null.

- **`normalizarTarifa(t)`** · _función_
  Valida y normaliza una tarifa recibida (de la importacion o de una edicion).

- **`mapearTarifa(r)`** · _función_
  Fila de tarifas_flete -> TarifaFlete.

- **`facturacion`** · _módulo_
  Matriz de fletes y envio a facturacion: lectura y escritura en la base.

  - **`facturacion.tarifas()`** · _método_
    La matriz de fletes, por nombre.

  - **`facturacion.reemplazarTarifas(lista)`** · _método_
    Reemplaza la matriz completa por la importada (en una transaccion: si algo
    falla queda la anterior). Los viajes que apuntaban a tarifas viejas
    conservan su valor; solo pierden el enlace a la tarifa.

  - **`facturacion.crearTarifa(datos)`** · _método_
    Agrega una tarifa a la matriz sin importar el Excel, y la devuelve.

  - **`facturacion.actualizarTarifa(id, datos)`** · _método_
    Cambia una tarifa (nombre, razon social, valor, tipo, pesos, observaciones) y la devuelve.

  - **`facturacion.porFacturar()`** · _método_
    Viajes listos para facturar (papeles radicados, sin factura con fecha), y
    los ya enviados a la contadora que aun no tienen fecha de factura (para
    poder volver a generar el cuadro). Con el radicado de la remesa y la
    ultima tarifa usada con cada cliente (para sugerirla).

  - **`facturacion.guardarEnvio(filas)`** · _método_
    Guarda en cada viaje lo que se envia a facturar y marca la fecha de envio.

    Por viaje: tarifa de la matriz, tipo (TON: valor por tonelada y peso
    facturado; FIJO: el total), remision, nota de la factura y consecutivo de
    factura (manual: hay varias empresas). El flete del cuadro pagos queda con
    estos valores. Todo en una transaccion.

### `src/fechas.ts`

> Fechas que llegan del formulario.
>
> <input type="datetime-local"> entrega la hora SIN zona ("2026-10-01T11:00").
> new Date() la interpreta en la zona del SERVIDOR: en el computador de la
> oficina (Colombia) daba la hora correcta, pero el servidor corre en UTC y la
> corria 5 horas (11:00 quedaba como 06:00 en el RNDC). La hora que escribe el
> despachador es SIEMPRE hora de Colombia, asi que se interpreta asi, sin
> depender de la zona del servidor. Colombia no tiene horario de verano: UTC-5.

- **`fechaHoraColombia(valor)`** · _función_
  Fecha y hora escritas en Colombia. Si ya trae zona (ISO con Z u offset), se respeta.

### `src/flota.ts`

> Flota de un vehiculo: propia (Transportes Lopez o Transportes M&C) o de un
> tercero. Va en su propio archivo porque la usan cuadro, anticipos y
> reportes al armar sus consultas (cuadro y anticipos se importan entre si).

- **`sqlFlota(ve)`** · _función_
  Expresion SQL con la flota del vehiculo de alias `ve`: la que tenga escrita
  (LOPEZ o MYC) o, si dice TERCERO o no esta en Flota, la que sale del
  propietario o del tenedor: con el NIT de Transportes Lopez es LOPEZ, con el
  de M&C es MYC y con cualquier otro, TERCERO. Asi un carro de la empresa que
  nadie marco como propio no aparece en Pago a terceros. Los NIT se comparan
  con sus primeros 9 digitos (sin el digito de verificacion).

### `src/importaciones.ts`

> Carga inicial desde los Excel de la empresa (una sola vez, con revision):
>
> - Cartera ("Cartera Total"): las facturas de antes de septiembre de 2026
>   quedan como saldos sin viaje (cartera_saldos) con su valor por placa; las
>   de septiembre en adelante se ligan a sus viajes del cuadro pagos (numero,
>   fecha y vencimiento de factura en cada viaje) para seguir el flujo normal.
> - Anticipos (hoja de las EDS): cada fila es un anticipo de un viaje; se
>   crea el tanqueo y su tramo en el viaje elegido.
>
> El navegador lee el Excel y manda las filas. Primero se pide la propuesta
> (proponerCartera / proponerAnticipos: que viaje parece ser cada linea y que
> tan seguro es) y la persona corrige en pantalla las dudosas; luego se
> confirma (importarCartera / importarAnticipos). Reimportar no duplica.

- **`limpio(s)`** · _función_
  Mayusculas, sin tildes ni puntuacion.

- **`mismoCliente(corto, empresa)`** · _función_
  true si el nombre corto del Excel corresponde a la empresa del cuadro: el
  nombre completo contenido (sin espacios: "VILLA PAPEL" = "VILLAPAPEL") o
  alguna palabra significativa (4+ letras) en comun.

- **`candidato(v, cliente)`** · _función_
  Viaje del cuadro como candidato de una linea, marcando si es del mismo cliente.

- **`anticipoDe(f)`** · _función_
  Anticipo del cliente implicito: lo que suman las placas menos lo que se debe.

- **`proponerCartera(facturas, viajes)`** · _función_
  Propone como cargar cada factura:
  - Antes del corte (septiembre): saldo sin viaje.
  - Desde el corte: ligada a viajes. Para cada placa se buscan sus viajes del
    cuadro de los 75 dias anteriores a la factura que no esten anulados, ni
    pagados, ni facturados con otro numero. Primero los que ya tienen este
    numero (reimportacion); si no, el mas reciente del mismo cliente que no se
    haya propuesto ya para otra factura. Si una placa no tiene ningun viaje,
    la factura se propone como saldo (sus viajes no estan en el sistema).

- **`fechaONull(v)`** · _función_
  Fecha "AAAA-MM-DD" o null.

- **`importarCartera(facturas)`** · _función_
  Carga las facturas confirmadas en una transaccion:
  - SALDO: crea o reemplaza el saldo (numero + cliente) con sus placas.
  - VIAJES: pone numero, fecha y vencimiento de factura en cada viaje (y lo
    marca facturado). Si el viaje no tenia flete, queda el valor del Excel
    como flete fijo (repartido si la placa tiene varios viajes).
  - El anticipo del cliente queda con la llave de la cartera (numero + cliente
    del saldo, o + empresa de los viajes).
  Valida que cada linea de una factura por viajes tenga viaje, que ningun
  viaje quede en dos facturas y que no este facturado con otro numero.

- **`dias(a, b)`** · _función_
  Dias entre dos fechas "AAAA-MM-DD" (b - a).

- **`llaveAnticipo(placa, fecha, efectivo, combustible)`** · _función_
  Llave para reconocer un anticipo ya cargado.

- **`proponerAnticipos(filas, viajes, existentes)`** · _función_
  Propone el viaje de cada anticipo entre los de la misma placa desde 3 dias
  antes hasta 20 despues del anticipo, en dos pasadas por fecha:
  1. Cada anticipo toma el viaje libre mas cercano de su mismo cliente.
  2. Los que quedaron sin viaje toman el mas cercano que siga libre (dos
     anticipos de la misma placa el mismo dia suelen ser ida y regreso: el
     segundo va al viaje siguiente); si no queda ninguno libre, el mas
     cercano aunque ya tenga otro anticipo.
  "Mas cercano": mejor el mismo dia o despues (el anticipo se da al cargar).
  Seguro si es del mismo cliente y a lo sumo 2 dias despues, o si es el unico
  viaje de la placa ese dia.

- **`anticiposExistentes()`** · _función_
  Cuantos anticipos ya cargados hay de cada llave (placa, fecha, efectivo, combustible).

- **`importarAnticipos(filas, usuarioId)`** · _función_
  Carga los anticipos confirmados en una transaccion: por cada uno, la bomba
  (se crea si no existe), el tanqueo con la factura de la bomba y el tramo de
  IDA en el viaje con efectivo, combustible, galones, descuento y fecha de
  pago a la bomba. Se saltan tantos de cada llave como ya haya en la base
  (reimportar no duplica; dos filas iguales del mismo Excel si se cargan).

- **`propuestaCartera(facturas)`** · _función_
  Propuesta de la cartera con los viajes actuales del cuadro.

- **`propuestaAnticipos(filas)`** · _función_
  Propuesta de los anticipos con los viajes actuales del cuadro.

### `src/index.ts`

> Punto de entrada del backend: crea el esquema, arma el servidor Express con
> sus rutas (/api/auth, /api/catalogo, /api/despacho, /api/usuarios,
> /api/cuadro), sirve el frontend compilado si existe y escucha en PORT.

- **`main()`** · _función_
  Arranque del servidor:
  1. initSchema(): crea o actualiza las tablas.
  2. Express con CORS (la sesion viaja en cookie) y JSON.
  3. Rutas: /api/auth abierta; catalogo, despacho, usuarios y cuadro exigen
     sesion (exigirSesion).
  4. Si existe el frontend compilado, lo sirve, con caida a index.html para
     las rutas de React.
  5. Manejador de errores comun y escucha en el puerto configurado.

### `src/relacionesBomba.ts`

> Cruce con la bomba: la relacion quincenal de vales que manda la bomba
> (COESCO: "RELACION VALES DESPACHO - CONSUMO", una por factura, p. ej.
> AE5044797) contra los anticipos de combustible del TMS.
>
> Cada vale trae EDS, numero de vale, fecha, placa, galones y valor. La
> bomba da combustible y tambien efectivo: cada vale es de uno de los dos
> (tipo) y se compara con ese valor del tramo; un tramo puede quedar cruzado
> con un vale de combustible y otro de efectivo. El
> navegador lee el PDF o el Excel de la relacion (o se arma a mano eligiendo
> los tanqueos) y manda los vales; aqui se propone a que tramo corresponde
> cada uno (emparejarVales) y, al confirmar, se guarda la relacion:
> - el tramo queda cruzado con su vale: el combustible pasa a ser el valor
>   del vale (lo que cobra la bomba) y se guarda lo que se habia registrado
>   antes, para ver la diferencia; los galones son los del vale;
> - el tanqueo queda con el numero y la fecha de la factura de la bomba.
> Borrar la relacion devuelve los tramos como estaban.

- **`montoTramo(t, tipo)`** · _función_
  Lo que el tramo tiene registrado del tipo del vale.

- **`yaCruzado(t, tipo)`** · _función_
  El tramo ya tiene vale de ese tipo.

- **`estacionNormal(nombre)`** · _función_
  Estacion comparable: sin "EDS", "S." como "SAN", sin tildes ni signos.
  "EDS SAN ESTEBAN" y "S. ESTEBAN" -> "SAN ESTEBAN".

- **`diasEntre(a, b)`** · _función_
  Dias entre dos fechas "AAAA-MM-DD" (sin signo).

- **`emparejarVales(vales, tramos)`** · _función_
  Propone el tramo de cada vale. Candidatos: misma placa, misma estacion (si
  el tramo tiene bomba), a lo sumo 2 dias de diferencia, con valor del tipo
  del vale (combustible o efectivo) y sin un vale de ese tipo. Se reparten
  primero los que coinciden en valor (los mas cercanos en fecha), y luego los
  demas al tramo libre mas cercano. Un tramo va con un solo vale de cada tipo.

- **`leerVales(lista)`** · _función_
  Valida los vales que manda el navegador.

- **`tramosCruzables()`** · _función_
  Tramos que aun pueden cruzarse (y los ya cruzados, marcados por tipo).

- **`valorAPagarBomba(totalFacturas, totalAbonos)`** · _función_
  Lo que se le paga a la bomba: el total de las facturas menos lo que abonaron los socios.

- **`relacionesBomba`** · _módulo_
  Relaciones de la bomba: proponer, guardar, listar, pagar y borrar.

  - **`relacionesBomba.proponer(d)`** · _método_
    Propone el tramo de cada vale (no guarda). Avisa si la factura ya se cargo.

  - **`relacionesBomba.guardar(d, usuarioId)`** · _método_
    Guarda la relacion con sus vales y cruza los tramos elegidos ({ numero,
    fecha, nota, vales: [{ ...vale, tramoId }] }). En una transaccion.

  - **`relacionesBomba.listar()`** · _método_
    Relaciones cruzadas, la mas reciente primero, con sus vales.

  - **`relacionesBomba.vencimiento(id, d)`** · _método_
    Cambia la fecha de vencimiento de una factura de la bomba (vacia la quita).

  - **`relacionesBomba.pagos()`** · _método_
    Pagos a la bomba registrados, el mas reciente primero, con sus facturas y abonos.

  - **`relacionesBomba.registrarPago(d, usuarioId)`** · _método_
    Registra el pago de la quincena ({ relaciones, abonos, fecha, referencia }):
    las facturas elegidas (sin pagar) quedan pagadas en esa fecha, con sus
    tramos, y los abonos del socio elegidos quedan usados en este pago (no se
    vuelven a descontar). Valor pagado = facturas - abonos. En una transaccion.

  - **`relacionesBomba.borrarPago(id)`** · _método_
    Deshace un pago: sus facturas y tramos quedan sin pagar y los abonos libres.

  - **`relacionesBomba.pagar(id, d)`** · _método_
    Se le pago a la bomba la factura: fecha de pago en la relacion y en sus tramos.

  - **`relacionesBomba.borrar(id)`** · _método_
    Borra una relacion: los tramos vuelven al combustible que tenian antes del
    cruce y los tanqueos quedan sin el numero de esa factura.

### `src/rentabilidad.ts`

> Rentabilidad: cuanto deja cada viaje cuando el cliente le paga a la empresa
> (reemplaza el Excel "ejemplo rentabilidad", una hoja por grupo de carros).
>
> Se alimenta de lo que ya esta en el sistema: el Cuadro pagos (flete,
> factura y fechas), Anticipos (efectivo y combustible de la bomba) y Pago a
> terceros (lo pactado con el tercero y su ICA). Lo que no esta en ningun
> lado se escribe en el viaje (columnas rent* de cuadro_viajes); vacio = el
> valor de siempre.
>
> Dos clases de grupo:
> - TERCEROS: lo que paga el cliente con sus descuentos (saldo empresa) menos
>   lo que se le paga al tercero con los suyos (saldo tercero) = rentabilidad,
>   sin contar los otros descuentos (prestamos, descuentos del cliente), que
>   bajan el saldo del tercero pero no son ganancia de la empresa;
>   menos el anticipo de renta 3,5 % = ganancia. La comision de la matriz
>   (como en los demas carros) se le descuenta a la empresa, no al tercero.
> - Socios y carros propios (CELSO, MAURICIO, MILLER, SOCIEDAD, JTY-221,
>   SWK-973, XGJ-197...): lo que paga el cliente menos todos los descuentos y
>   el anticipo = lo que se le paga al dueno. La empresa se queda con la
>   comision y T. Lopez.

- **`grupoDe(placa, flota, dueno)`** · _función_
  Grupo de un viaje: por la placa; si no, los terceros, el socio dueno o PROPIOS.

- **`normalizar(s)`** · _función_
  Texto sin tildes ni signos, en mayuscula, para comparar nombres de clientes.

- **`buscarEnMatriz(matriz, empresa, urbano)`** · _función_
  La fila de una matriz que le toca a una empresa: la de nombre mas largo que
  aparezca en ella (como el SEARCH del Excel). Las de URBANO solo para urbanos
  y, para un urbano, primero esas.

- **`leerRetenciones(texto)`** · _función_
  Texto guardado en rentRetenciones -> ajustes validos (lo demas se ignora).

- **`calcular(e)`** · _función_
  Calcula la rentabilidad de un viaje (exportado para las pruebas).

- **`rentabilidad`** · _módulo_
  Repositorio de la rentabilidad y sus matrices.

  - **`rentabilidad.listar()`** · _método_
    Todos los viajes no anulados, con su grupo y su rentabilidad (los mas recientes primero).

  - **`rentabilidad.matrices()`** · _método_
    Las dos matrices (comisiones y retenciones por cliente).

  - **`rentabilidad.guardarMatrices(d)`** · _método_
    Reemplaza las matrices ({ comisiones: [{ cliente, comision, tLopez }],
    retenciones: [{ cliente, reteicaPorMil, ciudad }] }). Las filas sin
    cliente se ignoran. En una transaccion.

### `src/repo.ts`

> Capa de acceso a datos: SQL explicito y tipado, un objeto por tabla.
>
> remolques, vehiculos, conductores, terceros, rutas, municipios, vias,
> empresasMonitoreo, parametros, plantillas, viajeRemesas, viajes y
> consecutivos. Las rutas no escriben SQL: usan estos repositorios.
> actualizarFila permite editar desde el catalogo solo los campos enviados.

- **`mapBool(row)`** · _función_
  Normaliza 'activo' (TINYINT 0/1 de MySQL) a boolean.

- **`aNumero(valor)`** · _función_
  MySQL devuelve DECIMAL como string para no perder precision.

- **`mapViaje(row)`** · _función_
  Normaliza un viaje leido de MySQL: fopatPagado llega como 0/1 y se pasa a boolean.

- **`mapTercero(row)`** · _función_
  Normaliza un tercero: latitud y longitud (DECIMAL, llegan como texto) a number.

- **`mapVehiculo(row)`** · _función_
  MySQL devuelve TINYINT(1) como 0/1; aqui se normaliza a boolean real. La
  clave cifrada del GPS se quita: solo se entrega por vehiculos.accesoGps.

- **`fechaMysql(d)`** · _función_
  Date -> "AAAA-MM-DD HH:MM:SS" en UTC, el formato que espera MySQL. null se conserva.

- **`ErrorDuplicado`** · _clase_
  Otra fila ya usa ese valor unico (placa, cedula, NIT...).

- **`ErrorValidacion`** · _clase_
  Un valor no tiene el formato esperado.

- **`actualizarFila(tabla, id, datos, campos)`** · _función_
  Actualiza solo las columnas permitidas que vengan en `datos`.

  La lista blanca `campos` es la que arma el SQL: nunca se interpola una llave
  que venga del cliente. Cada columna y su valor se agregan juntos, asi que el
  numero de placeholders siempre coincide con el de valores (ver el incidente
  del INSERT en CONTEXTO-PROYECTO.md).

  Las llaves ausentes no se tocan; un texto vacio se guarda como NULL.

- **`remolques`** · _módulo_
  Repositorio de remolques (tabla remolques).

  - **`remolques.findMany()`** · _método_
    Todos los remolques, por placa.

  - **`remolques.findById(id)`** · _método_
    Un remolque por id, o null.

  - **`remolques.create(data)`** · _método_
    Crea un remolque (placa, ejes, capacidad y vencimientos) y lo devuelve.

  - **`remolques.update(id, datos)`** · _método_
    Edita un remolque desde el catalogo: solo los campos enviados (ver actualizarFila).

- **`vehiculos`** · _módulo_
  Repositorio de vehiculos (tabla vehiculos): datos RNDC, flota, GPS y
  borrado logico (eliminado = 1, se recupera al crear la misma placa).

  - **`vehiculos.fijarMonitoreo(id, nit)`** · _método_
    Cambia el proveedor de GPS (EMF) por defecto de un vehiculo.

  - **`vehiculos.actualizarPorPlaca(placa, datos)`** · _método_
    Refresca vencimientos de SOAT y tecnomecanica de una placa existente.

  - **`vehiculos.findMany()`** · _método_
    Todos menos los eliminados (activos e inactivos).

  - **`vehiculos.findByPlacaConEliminados(placa)`** · _método_
    Busca por placa INCLUYENDO eliminados (para recuperarlo al recrearlo).

  - **`vehiculos.eliminar(id)`** · _método_
    Borrado logico: sale de todas las listas y queda inactivo. Los viajes que
    lo usaron lo siguen encontrando por id (historial, PDF, anulaciones).

  - **`vehiculos.restaurar(id)`** · _método_
    Deshace el borrado logico (al volver a crear la misma placa).

  - **`vehiculos.findById(id)`** · _método_
    Un vehiculo por id, o null.

  - **`vehiculos.create(data)`** · _método_
    Crea un vehiculo con los datos que exige el RNDC (configuracion, titular,
    carroceria, peso vacio) y lo devuelve.

  - **`vehiculos.update(id, datos)`** · _método_
    Edita un vehiculo desde el catalogo (incluida la flota: LOPEZ, MYC o
    TERCERO). Solo cambia los campos enviados (ver actualizarFila).

  - **`vehiculos.fijarClaveGps(id, cifrada)`** · _método_
    Guarda la clave del GPS ya cifrada (null la borra).

  - **`vehiculos.accesoGps(id)`** · _método_
    Datos para entrar al GPS del vehiculo: link (el del vehiculo o el de su
    empresa de monitoreo), usuario y clave cifrada, y el nombre del proveedor.

- **`conductores`** · _módulo_
  Repositorio de conductores (tabla conductores).

  - **`conductores.actualizarPorCedula(cedula, datos)`** · _método_
    Refresca los datos que el RNDC toma del RUNT (licencia, categoria y
    vencimiento) de un conductor que ya existe.

    Es lo que permite reimportar el Maestro de Terceros periodicamente y que
    las alertas de vencimiento queden al dia sin crear duplicados.

  - **`conductores.findMany()`** · _método_
    Todos los conductores, por nombre.

  - **`conductores.findById(id)`** · _método_
    Un conductor por id, o null.

  - **`conductores.create(data)`** · _método_
    Crea un conductor (cedula, nombre, licencia y su vencimiento) y lo devuelve.
    El tipo de identificacion por defecto es C (cedula).

  - **`conductores.update(id, datos)`** · _método_
    Edita un conductor desde el catalogo: solo los campos enviados.

- **`terceros`** · _módulo_
  Repositorio de terceros: clientes, remitentes y destinatarios con su sede,
  municipio y coordenadas (tabla terceros).

  - **`terceros.findMany()`** · _método_
    Todos los terceros (clientes, remitentes, destinatarios), por nombre.

  - **`terceros.findById(id)`** · _método_
    Un tercero por id, o null.

  - **`terceros.create(data)`** · _método_
    Crea un tercero con su sede, municipio RNDC y coordenadas, y lo devuelve.
    Por defecto es NIT (N) y sede "0".

  - **`terceros.update(id, datos)`** · _método_
    Edita un tercero desde el catalogo: solo los campos enviados.

- **`rutas`** · _módulo_
  Repositorio de rutas (tabla en desuso: la ruta sale de la plantilla).

  - **`rutas.findMany()`** · _método_
    Todas las rutas (tabla en desuso: hoy la ruta sale de la plantilla).

  - **`rutas.findById(id)`** · _método_
    Una ruta por id, o null.

  - **`rutas.create(data)`** · _método_
    Crea una ruta origen-destino con sus codigos DIVIPOLA y distancia.

- **`municipios`** · _módulo_
  Maestro de municipios DIVIPOLA (codigo de 8 digitos y nombre).

  - **`municipios.findMany()`** · _método_
    Todos los municipios, por nombre.

  - **`municipios.buscar(texto, limite)`** · _método_
    Busca municipios por parte del nombre o por el comienzo del codigo
    (para el buscador de municipios). Maximo 'limite' resultados.

  - **`municipios.crearLote(lista)`** · _método_
    Inserta en lote. Los codigos repetidos se ignoran.

- **`vias`** · _módulo_
  Vias (CODVIA) de cada par origen-destino, como las devuelve SICETAC, con
  el ultimo piso verificado. Se usan en Despachar para elegir la via.

  - **`vias.findByRuta(origen, destino)`** · _método_
    Vias disponibles para un par origen-destino. La estandar va primero.

  - **`vias.findMany()`** · _método_
    Todas las vias guardadas. Un piso guardado antes de corregir el filtro de
    SICETAC (pisoVerificado = 0) se devuelve como desconocido (null).

  - **`vias.guardar(v)`** · _método_
    Crea o actualiza una via. Se reemplaza la descripcion y el valor de
    SICETAC porque ambos cambian cuando el Ministerio actualiza las tarifas.

- **`empresasMonitoreo`** · _módulo_
  Empresas de monitoreo de flota (proveedores de GPS) registradas en el
  RNDC. El manifiesto lleva el NIT de la del vehiculo (NITMONITOREOFLOTA).

  - **`empresasMonitoreo.findMany()`** · _método_
    Las empresas de monitoreo activas, por nombre.

  - **`empresasMonitoreo.findByNit(nit)`** · _método_
    Una empresa de monitoreo por NIT (activa o no), o null.

  - **`empresasMonitoreo.guardar(nit, nombre, urlPlataforma)`** · _método_
    Crea o renombra por NIT. El nombre puede cambiar; el NIT es la llave.

  - **`empresasMonitoreo.update(id, datos)`** · _método_
    Cambia NIT, nombre y/o link de la plataforma y la devuelve.

  - **`empresasMonitoreo.desactivar(id)`** · _método_
    Desactiva una empresa de monitoreo (no se borra: viajes viejos la usan).

- **`parametros`** · _módulo_
  Parametros de la empresa (una sola fila, id = 1): poliza de carga,
  tomador, aseguradora, etc. Se usan en cada remesa.

  - **`parametros.obtener()`** · _método_
    Lee los parametros de la empresa con valores por defecto para lo que falte.

  - **`parametros.guardar(data)`** · _método_
    Guarda los parametros: mezcla lo actual con lo enviado (lo que no viene no
    cambia), actualiza la fila 1 con la fecha de actualizacion y devuelve lo
    guardado.

  - **`parametros.revisarVigenciaPoliza(diasAviso)`** · _método_
    Avisa si la poliza esta vencida o por vencerse. No bloquea nada: es un
    recordatorio para que no se pase la renovacion anual.

- **`columnasPlantilla(data)`** · _función_
  Columnas que se escriben al crear o editar una plantilla, con su valor.

  El INSERT y el UPDATE se arman desde esta misma lista, asi columnas,
  placeholders y valores cuadran por construccion. Un INSERT con mas `?` que
  valores ya tumbo el servidor una vez; escribirlos a mano en paralelo es
  justo lo que lo permitio.

  fleteActualizadoEn no esta aqui: depende de si la tarifa cambio, y eso solo
  lo sabe quien llama.

- **`plantillas`** · _módulo_
  Plantillas de viaje: cliente, remitente, destinatario, mercancia, tiempos
  pactados y valores. Cada remesa de un despacho sale de una plantilla.

  - **`plantillas.desactivar(id)`** · _método_
    "Elimina" una plantilla. En realidad la desactiva (activa = 0): el
    historial de viajes y remesas la referencia por id, asi que borrarla de
    verdad rompería esos registros. findMany ya filtra por activa = 1, asi
    que desaparece de la lista y de los selectores sin perder el historial.

  - **`plantillas.findMany()`** · _método_
    Las plantillas activas, cada una con sus terceros.

  - **`plantillas.findById(id)`** · _método_
    Una plantilla (activa o no) con sus relaciones, o null.

  - **`plantillas.resolverRuta(remitenteId, destinatarioId, municipioOrigen, municipioDestino)`** · _método_
    Ruta con la que se guarda una plantilla.

    Lo que llegue explicito manda. Lo que falte se precarga con el municipio
    del remitente (origen) y del destinatario (destino), que es lo que el
    despachador usaria en el caso normal. Puede devolver null si el tercero
    tampoco tiene municipio: quien llama decide si eso es un error.

  - **`plantillas.buscarPorRuta(codMunicipioOrigen, codMunicipioDestino)`** · _método_
    Plantillas cuya ruta coincide con un par de municipios.

    El cruce va contra la ruta explicita de la plantilla, que es la misma con
    la que se consultan las vias y el piso de SICETAC. Asi lo que se actualiza
    es exactamente lo que se va a despachar por esa ruta.

  - **`plantillas.actualizarFletePorRuta(codMunicipioOrigen, codMunicipioDestino, valorFleteBase)`** · _método_
    Actualiza la tarifa base de todas las plantillas de una ruta.

    Pensado para cuando cambia SICETAC: en vez de entrar plantilla por
    plantilla, se corrige la ruta completa de una sola vez.

  - **`plantillas.rutasConTarifas()`** · _método_
    Rutas distintas que hoy existen entre las plantillas activas, con cuantas
    plantillas tiene cada una y el rango de tarifas. Es el punto de partida
    para actualizar: muestra donde hay tarifas dispares en la misma ruta.

  - **`plantillas.conRelaciones(p)`** · _método_
    Completa una plantilla con sus terceros (contratante, remitente y
    destinatario), consultados en paralelo.

  - **`plantillas.create(data)`** · _método_
    Crea una plantilla. Si no viene la ruta (origen y destino), se deduce del
    municipio del remitente y del destinatario, como en el formulario.

  - **`plantillas.update(id, data)`** · _método_
    Reemplaza los datos de una plantilla existente.

    Los viajes ya despachados no cambian: el XML que se envio al RNDC quedo
    registrado con los valores de ese momento. Esto solo afecta lo que se
    despache de aqui en adelante.

- **`viajeRemesas`** · _módulo_
  Remesas de cada viaje (tabla viaje_remesas): una por plantilla, con su
  consecutivo, radicado, estado y los datos de su cumplido.

  - **`viajeRemesas.findById(id)`** · _método_
    Una remesa por id, o null.

  - **`viajeRemesas.findByViaje(viajeId)`** · _método_
    Las remesas de un viaje, en orden (la 1 es la principal).

  - **`viajeRemesas.crearParaViaje(viajeId, remesas)`** · _método_
    Crea las remesas de un viaje y les asigna su consecutivo.

    El consecutivo sale del id de la propia fila, no del id del viaje: con
    varias remesas por viaje, usar el id del viaje las repetiria, y el RNDC
    rechaza consecutivos duplicados dentro de la empresa.

  - **`viajeRemesas.borrarDeViaje(viajeId)`** · _método_
    Borra las remesas de un viaje. Solo para reemplazarlas en un reintento
    cuando NINGUNA existe en el RNDC (lo verifica la ruta de reintento).

  - **`viajeRemesas.tomarConEstado(id, permitidos, nuevoEstado)`** · _método_
    Pasa la remesa a `nuevoEstado` solo si esta en uno de los permitidos, en
    una sola sentencia: es el candado contra el doble clic al cumplir.

  - **`viajeRemesas.update(id, data)`** · _método_
    Actualiza solo los campos enviados de una remesa.

- **`viajes`** · _módulo_
  Repositorio de viajes (tabla viajes): cada viaje es un manifiesto con su
  estado, radicados, valores y quien lo creo, cumplio o anulo.

  - **`viajes.findById(id)`** · _método_
    Un viaje por id (con nombres de quien lo creo, cumplio o anulo), o null.

  - **`viajes.findMany(limit)`** · _método_
    Los ultimos 'limit' viajes, del mas reciente al mas antiguo.

  - **`viajes.marcarFopatPagado(ids, fechaPago)`** · _método_
    Marca uno o varios viajes como incluidos en un pago de FOPAT a la DIAN.
    El pago es mensual y agrupado, asi que se marca por lote.

  - **`viajes.resumenFopat()`** · _método_
    FOPAT causado y pendiente de pago, agrupado por mes de expedicion.
    Es el insumo para la declaracion mensual a la DIAN.

  - **`viajes.consecutivosUsados()`** · _método_
    Todos los consecutivos ya usados, de manifiestos y de remesas.

    El RNDC no permite repetirlos dentro de la empresa, y el rechazo llega
    despues de haber creado las remesas. Sale mas barato comprobarlo aqui.

  - **`viajes.ultimoConsecutivo()`** · _método_
    Ultimo numero base usado, para sugerir el siguiente.

  - **`viajes.contarPorVehiculoYFecha(vehiculoId, fecha, excluirViajeId)`** · _método_
    Cuenta los manifiestos ya expedidos para un vehiculo en una fecha de
    expedicion. El RNDC no permite mas de 10 por placa y dia (salvo los
    municipales), asi que conviene saberlo antes de intentar el numero 11.

    Solo cuenta los que llegaron al RNDC: los que fallaron antes de enviarse
    no ocupan cupo alla.
    Manifiestos de la placa en ese dia. `excluirViajeId` evita que un viaje
    que se esta reintentando (en MANIFIESTO_ERROR) se cuente a si mismo.

  - **`viajes.habitualesDeVehiculo(vehiculoId, limite)`** · _método_
    Remolque y conductor mas usados por un vehiculo en sus viajes con
    manifiesto (confirmados o anulados despues). A igual cantidad, gana el
    mas reciente. Mira los ultimos `limite` viajes.

  - **`viajes.tomarParaReintento(id, estadosPermitidos)`** · _método_
    Toma el viaje para reintentarlo solo si sigue en un estado reintentable.
    Es un UPDATE condicional (atomico): si llegan dos reintentos a la vez (doble
    clic), solo uno lo consigue y el otro no reenvia remesas al RNDC.

  - **`viajes.tomarConEstado(id, estadosPermitidos, nuevoEstado)`** · _método_
    Candado generico: pasa el viaje a `nuevoEstado` solo si esta en uno de
    los permitidos. UPDATE condicional = atomico frente al doble clic.

  - **`viajes.conteoManifiestosMes(mes)`** · _método_
    Manifiestos expedidos y anulados en un mes ("AAAA-MM", por fecha de
    expedicion), para el tope de anulaciones del Manual 6.1.5.

  - **`viajes.create(data)`** · _método_
    Crea el viaje (cabecera del manifiesto) y lo devuelve.

    El consecutivo del manifiesto va en el mismo INSERT: si el indice unico lo
    rechaza por repetido, no queda un viaje a medias sin numero. Las remesas se
    crean aparte (viajeRemesas.crearParaViaje).

  - **`viajes.update(id, data)`** · _método_
    Actualiza solo los campos enviados de un viaje y lo devuelve leido de nuevo.

- **`consecutivos`** · _módulo_
  Libro de consecutivos de manifiestos y remesas (una fila por remesa).

  - **`consecutivos.listar(limite)`** · _método_
    Una fila por remesa con las columnas de la hoja de control de la empresa:
    fecha planillada, placa, cliente, valor del manifiesto y FOPAT (solo en la
    remesa 1), citas, numeros y radicados, municipios, producto, remitente y
    destinatario, y el valor a facturar de la remesa en el Cuadro pagos (el
    flete que se envia en el cuadro de facturacion). Del mas reciente al mas antiguo.

### `src/reportes.ts`

> Reportes contables de los cuadros: estado de cuenta por periodo (saldo
> inicial, movimientos con su saldo, saldo final) y totales por mes, como los
> de un programa contable.
>
> La parte generica (estadoDeCuenta, porMes) no conoce de donde salen los
> movimientos: cada cuadro arma los suyos (hoy la bomba; despues cartera,
> terceros...). Cargo = aumenta lo que se debe; abono = lo disminuye.

- **`fechaReporte(v, campo)`** · _función_
  Fecha "AAAA-MM-DD" valida o ErrorCuadro.

- **`estadoDeCuenta(movimientos, desde, hasta)`** · _función_
  Estado de cuenta entre dos fechas (incluidas): el saldo inicial suma todo
  lo anterior, y cada movimiento del periodo lleva el saldo acumulado. Los
  movimientos del mismo dia van primero los cargos.

- **`porMes(movimientos)`** · _función_
  Totales de cargos y abonos por mes ("2026-09") y por tipo de movimiento.

- **`motivoFechaRara(fechaAnticipo, fechaPago, hoy)`** · _función_
  Por que una fecha de pago es imposible; null si esta bien.

- **`movimientosBomba(entregas, abonos, pagos, pagosSueltos)`** · _función_
  Movimientos de la cuenta con la bomba:
  - PRESTAMO: los anticipos entregados (efectivo + combustible), uno por dia y bomba.
  - ABONO_SOCIO: lo que los socios le pagaron directamente a la bomba.
  - PAGO_EMPRESA: los pagos de la quincena (facturas - abonos de los socios).
  - PAGO: anticipos marcados como pagados sin un pago de la quincena (los
    cargados del Excel, o con la fecha escrita a mano), por dia.
  Asi el saldo es la deuda con la bomba: los abonos usados en un pago se
  restan en su fecha y el pago solo resta lo que puso la empresa.

- **`totalesPor(entregas, llave)`** · _función_
  Totales de lo entregado agrupado por una llave (bomba, empresa del vehiculo).

- **`flotaTexto(f)`** · _función_
  Nombre de la empresa del vehiculo como en el Excel de anticipos.

- **`reporteBomba(datos, desde, hasta)`** · _función_
  Reporte de la bomba entre dos fechas: estado de cuenta (deuda al inicio,
  prestamos, abonos de los socios, pagos de la empresa, deuda al final),
  resumen del periodo y lo prestado por mes, por bomba y por empresa del
  vehiculo.

- **`reportes`** · _módulo_
  Repositorio: lee de la base lo que necesitan los reportes.

  - **`reportes.bomba(q, hoy)`** · _método_
    Reporte de la bomba entre dos fechas ({ desde, hasta }).

### `src/rndc/builders.ts`

> Construccion del XML que exige el Web Service del RNDC.
>
> Verificado contra:
>  - "GUIA DE MANIFIESTO" V7 (Ministerio de Transporte, 02/09/2026) -> [MAN]
>  - "GUIA REGISTRO REMESA" V5 (Ministerio de Transporte, 14/07/2026) -> [REM]
>
> Estructura general:
> <root>
>   <acceso><username/><password/></acceso>
>   <solicitud><tipo/><procesoid/></solicitud>
>   <variables>...</variables>
> </root>
>
> ALCANCE DE ESTA EMPRESA (decision de negocio, no limitacion tecnica):
>  - Solo se mueve carga general (reciclaje, triplex, pegantes base agua).
>    Por eso CODNATURALEZACARGA queda fijo en "1" y NO se implementan los
>    campos de mercancia peligrosa ni residuos peligrosos (CODIGOUN,
>    GRUPOEMBALAJEENVASE, ESTADOMERCANCIA, RESIDUO, PELIGROSIDAD, etc.).
>    Si algun dia entra una mercancia marcada como peligrosa en el maestro del
>    RNDC, el sistema la rechazara con un error explicito -- no la enviara mal.
>  - La poliza de carga es siempre la misma (la de la empresa), asi que los
>    campos de seguro no se envian por webservice. Sus nombres de etiqueta no
>    aparecen en ningun XML de ejemplo oficial y no vale la pena adivinarlos.

- **`construirDatosAnularCumplidoManifiesto(numManifiesto, motivo, observaciones)`** · _función_
  Datos del proceso 29 (anular el cumplido de un manifiesto): numero del
  manifiesto, motivo (D u O) y observaciones (maximo 200 caracteres).

- **`construirDatosAnularCumplidoRemesa(consecutivoRemesa, motivo, observaciones)`** · _función_
  Datos del proceso 28 (anular el cumplido de una remesa): consecutivo de la
  remesa, motivo (D u O) y observaciones (maximo 200 caracteres).

- **`escapeXml(valor)`** · _función_
  Escapa los caracteres especiales del XML (&, <, >, comillas y apostrofo).

- **`escapeTexto(valor)`** · _función_
  Texto de un elemento XML: solo hay que escapar &, < y >. Las comillas se
  dejan tal cual porque los filtros de las consultas van entre comillas
  sencillas ('TDM735') y el RNDC no esta documentado como decodificador de
  &apos;.

- **`tag(nombre, valor)`** · _función_
  Emite una etiqueta. Omite null/undefined/cadena vacia, pero SI emite el
  cero: hay campos (retenciones, anticipo) donde 0 es un valor valido y
  distinto de "no informado".

- **`partesBogota(fecha)`** · _función_
  Dia, mes, anio, hora y minuto de una fecha en hora de Colombia, en texto
  de dos digitos. Base de formatearFecha, formatearHora y diaBogota.

- **`formatearFecha(fecha)`** · _función_
  DD/MM/AAAA, formato exigido por el RNDC.

- **`formatearFechaCalendario(fecha)`** · _función_
  DD/MM/AAAA de una fecha SIN hora (columna DATE, o "AAAA-MM-DD" del
  formulario). Llega como medianoche UTC; pasarla a hora de Colombia la
  corria al dia anterior (el 30 salia como 29). Se usa el dia tal cual.

- **`mediodiaColombia(fecha)`** · _función_
  La misma fecha sin hora, a mediodia de Colombia: para contar dias sin correrse.

- **`formatearHora(fecha)`** · _función_
  HH:MM en formato militar (00:00 a 23:59) [REM pag. 13].

- **`diaBogota(fecha)`** · _función_
  Fecha calendario en Bogota, normalizada a medianoche, para comparar dias.

- **`diferenciaEnDias(a, b)`** · _función_
  Dias calendario (en Colombia) entre dos fechas: positivo si a es posterior a b.

- **`diasHabilesEntre(desde, hasta)`** · _función_
  Cuenta dias habiles (lunes a viernes) entre dos fechas. No contempla
  festivos colombianos, asi que sirve como alerta temprana y no como verdad
  final: el RNDC tiene la ultima palabra.

- **`baseRetenciones(valorAPagar, valorTrayectoVacio1, valorTrayectoVacio2)`** · _función_
  Base para retenciones: valor a pagar menos los dos trayectos en vacio
  [MAN pag. 15: "El valor base para aplicar la retencion de ICA es el
  resultado de la resta del valor a pagar menos valor trayecto vacio 1 y
  valor trayecto vacio 2"].

- **`calcularRetencionFuente(base, tarifa, titularEsRegimenSimple)`** · _función_
  Retencion en la fuente, en PESOS ENTEROS (sin centavos), obligatorio desde
  el 31/07/2026 [MAN pag. 15].

  El RNDC valida que sea > 0 si el titular del manifiesto pertenece al Regimen
  Ordinario, y solo permite 0 si pertenece al Regimen Simple de Tributacion.

- **`calcularFopat(valorAPagar, aplicaFopat)`** · _función_
  Aporte FOPAT: 0.1% del valor a pagar, ajustado al peso mas cercano y sin
  decimales. Aplica solo a vehiculos con peso bruto vehicular mayor a 10.5 t
  [MAN pag. 15]. El RNDC verifica el monto exacto, asi que enviarlo cuando no
  aplica es tan problematico como omitirlo cuando si.

- **`fopatEfectivo(v, valorAPagar)`** · _función_
  Retencion de ICA en pesos. El manifiesto lleva el FACTOR (por mil), pero el
  monto hace falta para calcular el neto a pagar.
  FOPAT que finalmente se envia: el valor explicito si lo hay, o el calculado.
  Un cero explicito se respeta (caso de vehiculo que no llega a 10.5 t).

- **`calcularIca(base, factorPorMil)`** · _función_
  Retencion de ICA en pesos: base x factor por mil / 1000, redondeado al peso.

- **`calcularNetoAPagar(valorAPagar, retencionFuente, retencionIca, retencionFopat)`** · _función_
  Neto a pagar: valor a pagar menos las tres retenciones
  [Manual de Operacion General del RNDC, 5.2.4].

  Importa porque el tope del anticipo se mide contra este numero, no contra el
  valor a pagar: "El valor del anticipo no puede ser mayor al valor a pagar
  menos la sumatoria de las tres retenciones".

- **`mismaIdentificacion(a, b)`** · _función_
  Compara dos identificaciones tolerando el digito de verificacion.

  Un NIT se escribe indistintamente con o sin DV (901319583 vs 9013195831), y
  la empresa suele registrarlo de las dos formas en sitios distintos. Sin esto,
  la deteccion de flota propia falla justo cuando importa.

- **`decimalesDe(valor)`** · _función_
  Cuenta los decimales significativos de una coordenada.

  Importa porque el RNDC exige minimo 6. Un grado son unos 111 km, asi que
  cada decimal que falta multiplica por diez el error: con 4 decimales la
  posicion se corre unos 11 metros, y con 2 mas de un kilometro. Si el cerco
  con el que el RNDC verifica el GPS del vehiculo es mas estrecho que ese
  error, el cargue no se va a poder validar nunca.

- **`revisarCoordenadaSede(latitud, longitud, descripcionSede)`** · _función_
  Revisa la coordenada de una sede contra las reglas del RNDC.

  Nunca bloquea el despacho: el RNDC usa SU copia de la coordenada, no la
  nuestra, asi que una coordenada local mala no impide expedir el documento.
  Lo que hace es avisar, porque casi siempre significa que la sede tambien
  esta mal registrada en el portal, y eso si rompe la verificacion de GPS.

- **`normalizarCodigoMercancia(codigo)`** · _función_
  El codigo de producto lleva "00" a la izquierda del capitulo+partida
  (ej. partida 2710 -> "002710"). Si el usuario no los escribe, el RNDC los
  agrega solo, pero se normaliza aqui para que lo guardado y lo enviado
  coincidan siempre [REM pag. 15].

- **`construirXmlMensaje(credenciales, procesoId, datos, tipoSolicitud, xmlCrudoAdicional)`** · _función_
  Arma el XML que se envia al RNDC (metodo AtenderMensajeRNDC).

  Estructura: <acceso> con usuario y clave, <solicitud> con el tipo (1 =
  registrar, por defecto) y el procesoid, y <variables> con el NIT de la
  empresa mas cada dato de 'datos' como <ETIQUETA>valor</ETIQUETA> (los
  vacios no se emiten, ver tag). xmlCrudoAdicional permite agregar bloques ya
  armados, como la lista de remesas del manifiesto.

- **`fechaExpedicionDe(remesas)`** · _función_
  La fecha de expedicion del manifiesto es la del cargue de la PRIMERA
  mercancia [MAN pag. 9]. Con varias remesas, la mas temprana.

- **`ultimoDescargueDe(remesas)`** · _función_
  Fecha de descargue mas tardia de todo el manifiesto. Es contra ella que el
  RNDC valida el SOAT, la RTM y la licencia [MAN pag. 12-13], asi que con
  multiparada manda la ultima parada, no la primera.

- **`calcularIcaPonderado(remesas)`** · _función_
  Calcula el factor de ICA del manifiesto a partir de las remesas.

  Cuando el manifiesto lleva varias remesas cargadas en municipios distintos y
  con factores distintos, el RNDC espera el promedio ponderado [MAN pag. 15].

  La ponderacion se hace por la parte del flete que corresponde a cada remesa.
  Si no se informa, se reparte proporcionalmente al peso, que es la
  aproximacion razonable cuando la empresa no desglosa el flete por cliente.

  OJO: la guia dice "promedio ponderado" sin precisar la base. Este calculo
  usa la participacion en el flete, que es la lectura natural del texto
  ("la suma en dinero de los valores de retencion... comparado con el valor a
  pagar"). Vale la pena confirmarlo con el contador la primera vez que salga
  un manifiesto multiparada con municipios de factores distintos.

- **`construirDatosRemesa(r)`** · _función_
  Diccionario de datos de Remesa Terrestre de Carga [REM pag. 46-50].

  Hay dos unidades de medida distintas, y es la parte que mas se presta a
  confusion [REM pag. 44]:
    - UNIDADMEDIDACAPACIDAD + CANTIDADCARGADA = unidad de TRANSPORTE, siempre
      en kilos. Sirve para el control de peso en carreteras y puentes.
    - UNIDADMEDIDAPRODUCTO + CANTIDADPRODUCTO = unidad COMERCIAL, la que el
      generador usa para facturar (kilos, unidades, metros cubicos...).

- **`construirDatosManifiesto(v, consecutivoManifiesto)`** · _función_
  Diccionario de datos del Manifiesto Electronico de Carga [MAN pag. 20].

  El manifiesto referencia las remesas por CONSECUTIVOREMESA (el consecutivo
  propio de la empresa, dentro del bloque <REMESASMAN>), no por el radicado
  que devuelve el RNDC.

- **`construirBloqueRemesasManifiesto(consecutivosRemesa)`** · _función_
  Bloque <REMESASMAN> que enlaza el manifiesto con sus remesas
  [MAN pag. 20, ejemplo XML]. El atributo procesoid="43" viene literal del
  ejemplo oficial.

- **`validarReglasRndc(v, consecutivoManifiesto, ahora)`** · _función_
  Reglas del RNDC que se pueden verificar localmente. Cada llamada rechazada
  cuesta tiempo en el despacho nocturno, y algunas cuentan contra cupos de la
  empresa (manifiestos tardios), asi que conviene atajarlas antes de enviar.

  Los ERROR detienen el envio. Los AVISO solo se registran: la operacion es
  valida pero tiene un costo administrativo que el despachador debe conocer.

- **`revisarExtremoRuta(p)`** · _función_
  Verifica un extremo de la ruta contra los sitios de las remesas [Manual 5.2.4].

  Bloquea si ninguna remesa carga (o descarga) en ese municipio. Si a algun
  tercero le falta el municipio no se puede afirmar que no calce: se avisa en
  vez de bloquear, porque el RNDC tiene su propio maestro de terceros.

- **`municipioOrigenDe(origenRuta, vacio1)`** · _función_
  Municipio de origen del manifiesto: donde empieza el trayecto en vacio si lo
  hay, y si no, el origen de la ruta [MANIFIESTO V7 pag. 9].

  `origenRuta` es el origen explicito de la plantilla principal. Antes salia
  del remitente de la primera remesa; ahora es un dato propio y editable, y
  validarReglasRndc verifica que calce con algun sitio de cargue.

- **`municipioDestinoDe(destinoRuta, vacio2)`** · _función_
  Municipio de destino: donde termina el trayecto en vacio final si lo hay, y
  si no, el destino de la ruta.

  `destinoRuta` es el destino explicito de la plantilla de la ULTIMA remesa:
  en multiparada el viaje termina donde descarga el ultimo cliente.

- **`construirDatosAnularCumplidoInicial(consecutivoRemesa, numManifiesto, motivo, observaciones)`** · _función_
  Proceso 54. Se hace mientras el manifiesto existe (pide su numero).

- **`construirDatosAnularManifiesto(numManifiesto, motivo, observaciones)`** · _función_
  Proceso 32. NUMMANIFIESTOCARGANUEVO solo aplica a reemplazos (R, T, G, C).

- **`construirDatosAnularRemesa(consecutivoRemesa, motivo, observaciones)`** · _función_
  Proceso 9. La remesa no puede estar ligada a un manifiesto vigente
  (ANR030): se anula despues del manifiesto.

- **`porcentajeTopeAnulaciones(expedidosMes)`** · _función_
  Tope de manifiestos anulados por mes, segun cuantos expidio la empresa ese
  mes [Manual RNDC 2026, 6.1.5, tabla 2]. Pasarlo exige una manifestacion
  expresa en el portal y se reporta a la Superintendencia.

- **`construirDatosCumplidoRemesa(d)`** · _función_
  Proceso 5 [Guia Cumplido de Remesa y Manifiesto V1, pag. 18].

- **`construirDatosCumplidoManifiesto(d)`** · _función_
  Proceso 6. Etiquetas: lista de variables del wstest del RNDC (proceso 6) y
  ejemplo de la Guia de Cumplido, pag. 19. Verificado en pruebas (2026-10-05,
  radicado 900000917): con fecha de entrega, retencion en la fuente y FOPAT
  correctos el cumplido normal pasa. Los ceros no se envian.

- **`valorFinalCumplido(d)`** · _función_
  Valor a pagar final del cumplido: el del manifiesto mas los adicionales y
  menos el descuento [Guia Cumplido 3.3 y 3.4].

- **`validarCumplidoRemesa(d, ahora)`** · _función_
  Revisiones locales antes de enviar el cumplido de una remesa, para que el
  error llegue en claro y no como codigo del RNDC. El RNDC valida ademas
  contra los tiempos del GPS (llegada y salida) y la velocidad maxima de
  90 km/h, que aqui no se conocen [Guia Cumplido 2.5; Manual RNDC 5.3.4].

- **`plazoCumplido(entrega, ahora)`** · _función_
  Plazo del cumplido contado desde la entrega (la cita de descargue, mientras
  no haya cumplido de remesa). No contempla festivos: sirve como alerta
  temprana, y por eso avisa un poco antes, nunca despues.

- **`radicadoDeDuplicado(errorCrudo)`** · _función_
  Cuando el cumplido ya existe en el RNDC (hecho en el portal, o un envio
  anterior que respondio tarde), el RNDC contesta "DUPLICADO:<radicado> ...",
  igual que con la remesa repetida (REM030, verificado en produccion el
  29/09). Ese radicado es el del cumplido que ya estaba.

### `src/rndc/client.ts`

> Cliente para consumir el Web Service SOAP del RNDC.
>
> El metodo documentado es 'AtenderMensajeRNDC', que recibe el XML armado en
> rndc/builders.ts como un unico parametro de texto.
>
> Antes de produccion:
> 1. Descarga y revisa el WSDL vigente (rndcws.mintransporte.gov.co:8080/ws).
> 2. Verifica que el nombre del metodo y sus parametros coincidan con el WSDL real.
> 3. Prueba primero con RNDC_SIMULAR=true para validar que el XML se arma bien.

- **`RndcError`** · _clase_
  Falla de comunicacion con el RNDC o envio bloqueado (no es un rechazo del documento).

- **`extraerCodigoError(mensaje)`** · _función_
  Extrae el codigo tipo REM112 / MAN006 del texto que devuelve el RNDC.

- **`explicarError(mensajeCrudo, procesoId)`** · _función_
  Convierte el error del RNDC en algo que el despachador pueda resolver solo.
  Si el codigo no esta en la tabla, se devuelve el mensaje original mas la ruta
  para buscarlo: es preferible a inventar una explicacion equivocada.

- **`decodificar(texto)`** · _función_
  Limpia el texto de una etiqueta de la respuesta: quita CDATA, decodifica
  las entidades XML (&amp;, &lt;, &#233;...) y recorta espacios.

- **`leerEtiqueta(xml, nombre)`** · _función_
  Lee el contenido de una etiqueta del XML de respuesta.

  Se hace a mano en vez de con una libreria porque la respuesta del RNDC es
  plana y no vale la pena una dependencia mas. Pero a diferencia de la version
  anterior, esta contempla lo que si aparece en respuestas reales: atributos en
  la etiqueta, prefijos de namespace, contenido en varias lineas y CDATA.

- **`leerEtiquetas(xml, nombre)`** · _función_
  Devuelve todas las ocurrencias: el RNDC puede reportar varios errores.

- **`esConsulta(xmlMensaje)`** · _función_
  true si el mensaje es de solo lectura: tipo 3 (consultar registros propios)
  o tipo 6 (consultar maestros especiales) [Guia Uso del Web Service V5,
  seccion 5]. Ninguno de los dos crea nada en el RNDC.

- **`esperar(ms)`** · _función_
  Pausa de 'ms' milisegundos (entre reintentos).

- **`RndcClient`** · _clase_
  Cliente SOAP del web service del RNDC.

  Un solo metodo publico, enviar(xml): manda el mensaje y devuelve el
  resultado ya interpretado (radicado o error). Tres protecciones:
  - soloConsultas: rechaza antes de salir cualquier mensaje que no sea
    consulta (tipo 3 o 6), para clientes que apuntan a produccion.
  - simular: no envia nada y responde un radicado SIMULADO (desarrollo).
  - Reintentos solo ante fallas de red, nunca ante un rechazo del RNDC.

  - **`RndcClient.constructor(config)`** · _método_
    Recibe la URL del WSDL, credenciales, modo simulacion, reintentos y soloConsultas.

  - **`RndcClient.enviar(xmlMensaje, procesoId)`** · _método_
    Envia un mensaje XML al RNDC y devuelve el resultado interpretado.

    Como funciona:
    1. Bloquea el envio si el cliente es solo de consultas y el mensaje no lo es.
    2. En simulacion responde un radicado ficticio sin conectarse.
    3. Crea el cliente SOAP desde el WSDL y llama AtenderMensajeRNDC con la
       parte "Request"; la respuesta viene en "return".
    4. Si falla la red, reintenta con espera creciente (2 s, 4 s...).
    5. Interpreta la respuesta con parsearRespuesta.
    Si todos los intentos fallan por red, lanza RndcError.

  - **`RndcClient.parsearRespuesta(xml, procesoId, consulta)`** · _método_
    Convierte el XML de respuesta en un ResultadoRndc.

    - Busca errores en ErrorMSG, ErrorMessage o error (las guias no documentan
      la etiqueta; se prueban las conocidas).
    - Consulta (tipo 3/6) sin error y con <documento>: exito sin radicado.
    - Sin radicado y sin error: se trata como FALLO ("no se pudo interpretar"),
      para no dar por expedido algo que quiza no lo esta.
    - Con error: extrae el codigo (MAN045, CRE111...) y una explicacion en
      espanol (explicarError).
    - Con radicado: exito, con MEC y codigo de seguridad QR si vienen.

### `src/rndc/conexion.ts`

> Credenciales y clientes del RNDC armados desde la configuracion, para no
> repetirlos en cada ruta. Tres clientes:
>
> - clienteRegistro: expide, cumple y anula (servidor del ambiente). Respeta
>   la simulacion (RNDC_SIMULAR).
> - clienteLectura: consultas de solo lectura (tipo 3/6) al mismo servidor.
>   soloConsultas bloquea cualquier mensaje que registre algo.
> - clienteSicetac: consultas de SICETAC al servidor de consultas
>   (config.rndc.consultasWsdlUrl), tambien solo lectura.
>
> Las lecturas no simulan por defecto (se usan solo cuando no hay simulacion);
> quien quiera respetar RNDC_SIMULAR pasa simular = config.rndc.simular.

- **`credencialesRndc()`** · _función_
  Usuario, clave y NIT de la empresa ante el RNDC.

- **`clienteRegistro()`** · _función_
  Cliente que registra documentos (expedir, cumplir, anular).

- **`clienteLectura(simular)`** · _función_
  Cliente de solo lectura contra el servidor del ambiente.

- **`clienteSicetac(simular)`** · _función_
  Cliente de solo lectura contra el servidor de consultas (SICETAC).

### `src/rndc/consultas.ts`

> Consultas de solo lectura al RNDC.
>
> Sirven para averiguar QUE EXISTE realmente en el ambiente al que estamos
> apuntando, antes de intentar expedir nada. Es especialmente util contra el
> ambiente de pruebas, que es una copia de produccion de una fecha pasada: un
> vehiculo o un tercero que diste de alta el mes pasado puede sencillamente no
> estar alli.
>
> A diferencia del registro (tipo de solicitud 1), las consultas usan el tipo 6
> y llevan un bloque <documento> con los filtros.

- **`construirXmlConsulta(credenciales, procesoId, variables, filtros)`** · _función_
  Arma el XML de una consulta (tipo 6).

  Formato segun el ejemplo de la guia de placa [Manual WebServicePlaca, pag. 3]:
  - <variables> es una lista de nombres separados por coma, en texto plano; no
    un elemento vacio por campo.
  - Los filtros van dentro de <documento> y su valor entre comillas sencillas:
    <PLACA>'TDM735'</PLACA>. Las comillas las pone esta funcion.

  @param variables Nombres de los campos que se quieren de vuelta.
  @param filtros   Criterios de busqueda (van dentro de <documento>), sin comillas.

- **`consultarPlaca(cliente, credenciales, placa)`** · _función_
  Consulta una placa en el RNA. El RNDC exige que la matricula este activa y
  que el vehiculo sea de servicio publico y modalidad de carga
  [MANIFIESTO V7 pag. 12].

- **`probarAcceso(cliente, credenciales, placaCualquiera)`** · _función_
  Prueba de acceso: manda una consulta trivial solo para ver si el usuario y la
  contrasena son validos y si el servidor responde.

  No hay un proceso documentado de "ping", asi que se reutiliza la consulta de
  placa con una placa cualquiera: si las credenciales estan mal, el RNDC lo
  dice antes de mirar el filtro.

- **`xmlDocumentoPropio(credenciales, procesoId, variables, filtroEtiqueta, filtroValor)`** · _función_
  XML de una consulta tipo 3 (documentos propios): pide las 'variables' del
  proceso indicado, filtrando por el NIT de la empresa y por un campo, con el
  valor entre comillas sencillas como exige el RNDC (sin ellas, RNDC027).

- **`consultarDocumentoPropio(cliente, credenciales, procesoId, variables, filtroEtiqueta, filtroValor)`** · _función_
  null = el RNDC dice que no existe (RNDC11). Cualquier otro error se lanza.

- **`numeroDe(v)`** · _función_
  Texto numerico de la respuesta -> number; vacio o ausente -> null.

- **`buscarManifiestoRadicado(cliente, credenciales, numero)`** · _función_
  El manifiesto con ese numero, si ya esta radicado en el RNDC para la empresa.

- **`buscarRemesaRadicada(cliente, credenciales, consecutivo)`** · _función_
  Radicado de la remesa con ese consecutivo, si ya esta en el RNDC.

- **`fechaHoraRndc(fecha, hora)`** · _función_
  "29/09/2026" + "14:13" en hora de Colombia (UTC-5).

- **`leerTiemposCumplidoRemesa(cliente, credenciales, consecutivo)`** · _función_
  Lee del RNDC el cumplido de una remesa (tipo 3, proceso 5): radicado, fecha
  de registro, kilos entregados y los seis tiempos (llegada, entrada y salida
  del cargue y del descargue), convertidos de "DD/MM/AAAA" + "HH:MM" (hora de
  Colombia) a Date. null si la remesa no esta cumplida.

- **`leerCumplidoInicial(cliente, credenciales, consecutivo)`** · _función_
  Lee el cumplido inicial del GPS de una remesa (tipo 3, proceso 45): llegada
  y salida del cargue y del descargue. Puede haber varios registros (cargue y
  descargue por separado): toma el primer valor no vacio de cada tiempo.
  null si el GPS no reporto nada.

- **`leerCumplidoManifiesto(cliente, credenciales, numero)`** · _función_
  Lee del RNDC el cumplido de un manifiesto (tipo 3, proceso 6): radicado,
  fecha de registro, retencion en la fuente y FOPAT. null si no esta cumplido
  (RNDC11). Se usa para adoptar cumplidos hechos en el portal.

- **`leerAnulacion(cliente, credenciales, procesoId, variables, filtro, valor, etiquetaMotivo)`** · _función_
  Consulta una anulacion por numero (tipo 3) y devuelve su radicado, fecha,
  motivo y observaciones; null si no existe (RNDC11).

- **`leerAnulacionManifiesto(cliente, credenciales, numero)`** · _función_
  Anulacion del manifiesto (proceso 32), si existe.

- **`leerAnulacionRemesa(cliente, credenciales, consecutivo)`** · _función_
  Anulacion de la remesa (proceso 9), si existe.

- **`leerAnulacionCumplidoInicial(cliente, credenciales, consecutivo)`** · _función_
  Anulacion del cumplido inicial de la remesa (proceso 54), si existe.

### `src/rndc/estampado.ts`

> Logo de la empresa sobre los PDF oficiales del RNDC.
>
> Decision de la empresa (2026-09-28): se puede superponer el logo en el
> manifiesto y en la remesa, siempre que el codigo QR quede visible, porque es
> lo que escanea la policia para verificar que el documento es el original del
> RNDC. Por eso el logo va en una zona fija que se midio sobre PDF oficiales
> reales (docs/Manifiesto DE ejemplo.pdf y docs/Remesa de ejemplo.pdf): el
> espacio en blanco entre los logos del Ministerio y el titulo. El QR del
> manifiesto esta en el extremo opuesto de la pagina.
>
> Nunca se tapa nada: si el PDF no tiene la orientacion esperada (el RNDC
> cambio el formato), no se estampa y se devuelve el original sin tocar.

- **`rutaLogo()`** · _función_
  Ruta del logo. Se puede cambiar con LOGO_EMPRESA en el .env.

- **`leerLogo()`** · _función_
  Lee el logo de la empresa una sola vez y lo guarda en memoria. Si no existe,
  lo avisa en consola y devuelve null (los PDF salen sin logo).

- **`estamparLogo(pdf, documento)`** · _función_
  Devuelve el PDF con el logo estampado en la primera pagina. Si no hay logo
  o la pagina no coincide con el formato esperado, devuelve el original.

- **`logoComoDataUri()`** · _función_
  El logo como data URI, para incrustarlo en documentos HTML (la remesa).

### `src/rndc/maestros.ts`

> Registro de los maestros en el RNDC desde la aplicacion: terceros (clientes,
> remitentes, destinatarios, propietarios y conductores) y vehiculos y
> remolques. Asi no hay que entrar al portal del RNDC para crearlos o
> actualizarlos.
>
> Procesos [Guia Uso del Web Service V5, pag. 9 y 12]:
> - 11: Crear o actualizar datos de Tercero.
> - 12: Crear o actualizar datos de Vehiculo (tambien remolques).
>
> Etiquetas: las del ejemplo de la guia (pag. 12) y SEGUNDOAPELLIDOIDTERCERO,
> verificadas en rndcpruebas el 2026-10-13 (el RNDC rechaza con "Error 13"
> cualquier etiqueta que no este en su diccionario, y estas las acepto).
>
> Lo que se vio en rndcpruebas ese dia:
> - Persona natural: obligatorios tipo y numero de identificacion, nombre,
>   direccion y municipio. El nombre lo toma el RNDC del registro oficial
>   (se mando "PRUEBA DE TERCERO" y quedo "JAIRO VESGA MARTINEZ").
> - NIT: ademas, codigo y nombre de sede (TER090, TER100). En personas
>   naturales la sede va en 0.
> - Vehiculo: obligatorio el peso vacio (VEH090: de 200 kg al peso bruto, de 3
>   a 5 digitos). La configuracion y la carroceria las toma del RUNT (se
>   mando 3S3/55 y 0 y quedo 54 y 7), por eso no se envian.
> - Remolque: basta la placa.
> - Telefono: es opcional, pero si se envia debe tener 10 digitos (fijo con
>   indicativo 60X o celular). Con el formato viejo de 7 digitos rechaza todo
>   el registro (TER190); por eso solo se envia si tiene 10 digitos.
> - Si todo es igual a lo que ya tiene, responde con error
>   "DUPLICADO:<radicado> ... VEH015 ... ya existe con todos los datos iguales":
>   se toma como "ya estaba al dia", no como fallo.
>
> La guia pide registrar solo cuando algo cambio (cada envio guarda historia
> en el RNDC): por eso el registro es una accion explicita del usuario.

- **`texto(v)`** · _función_
  Texto recortado; vacio, null o undefined -> undefined (la etiqueta no se envia).

- **`telefonoRndc(v)`** · _función_
  Telefono con solo digitos si tiene 10 (formato que acepta el RNDC); si no, undefined.

- **`variablesTercero(t)`** · _función_
  Variables del proceso 11 para un tercero del catalogo.

  - Sede: la del catalogo ("0" por defecto). Con NIT el RNDC exige ademas el
    nombre de la sede: el escrito, o el municipio, o el nombre del tercero.
  - Coordenadas: solo si estan (el RNDC verifica el GPS del cargue contra ellas).

- **`variablesConductor(c)`** · _función_
  Variables del proceso 11 para un conductor: en el RNDC es un tercero mas
  (persona natural, sede 0). La licencia la toma el RNDC del RUNT.

- **`variablesVehiculo(v)`** · _función_
  Variables del proceso 12 para un vehiculo: placa, peso vacio (en kg, sin
  decimales) y tenedor si lo hay. Configuracion y carroceria no: el RNDC las
  toma del RUNT.

- **`variablesRemolque(r)`** · _función_
  Variables del proceso 12 para un remolque: solo la placa.

- **`interpretarRegistro(r)`** · _función_
  Interpreta la respuesta del RNDC. "DUPLICADO:<radicado>" significa que ya
  tiene exactamente esos datos: es exito (nada que actualizar).

- **`MaestroNoEncontrado`** · _clase_
  Error de uso (registro inexistente): la ruta lo responde como 404.

- **`registrarMaestro(maestro, id)`** · _función_
  Registra (crea o actualiza) en el RNDC el tercero, conductor, vehiculo o
  remolque con ese id, con los datos que tiene hoy el catalogo. Guarda en la
  fila el radicado y la fecha, o el error del RNDC.

### `src/rndc/manifiesto-contingencia.ts`

> Manifiesto de contingencia: lo imprime la empresa cuando la plataforma del
> RNDC no deja expedir el manifiesto o no entrega su PDF, para que el carro no
> se quede sin documento mientras tanto.
>
> Replica la organizacion del manifiesto oficial (docs/Manifiesto DE
> ejemplo.pdf) con los mismos datos que se envian al RNDC (ver
> construirDatosManifiesto), pero SIN el codigo QR ni los logos del
> Ministerio, y con un aviso arriba y abajo de que es de contingencia. El
> viaje queda con alerta hasta que se imprime el oficial.
>
> HTML listo para imprimir, como la remesa (remesa-impresion.ts).

- **`escapar(valor)`** · _función_
  Texto seguro para el HTML (vacio para null/undefined).

- **`pesos(n)`** · _función_
  4,489,141.00, como en el manifiesto oficial.

- **`cientos(n)`** · _función_
  Numero de 0 a 999 en letras ("QUINIENTOS TREINTA Y NUEVE").

- **`enLetras(valor)`** · _función_
  Valor en letras como en el manifiesto oficial: "CUATRO MILLONES QUINIENTOS
  TREINTA Y NUEVE MIL SETENTA Y UNO PESOS". Pesos enteros.

- **`construirHtmlManifiestoContingencia(d)`** · _función_
  HTML imprimible del manifiesto de contingencia.

### `src/rndc/pdf.ts`

> Descarga del PDF del manifiesto.
>
> El RNDC entrega el PDF por un servicio APARTE del webservice SOAP: una API
> REST en otro puerto [GUIA DE MANIFIESTO V7, seccion 9].
>
> Peticion (POST al recurso /Rest/rndc):
> {
>   "acceso":    { "usuario": "...", "clave": "..." },
>   "solicitud": { "tipo": "21", "procesoid": "4" },
>   "documento": { "IngresoId": "<radicado>", "InformeId": "1",
>                  "formato": "Json", "Base64": "S" }
> }
>
> tipo 21   = consultar el PDF de un proceso
> procesoid 4 = manifiesto de carga
> IngresoId = numero de radicado que devolvio el RNDC al expedirlo
> InformeId = 1 (unico diseno por ahora)
> Base64 "S" devuelve el PDF como cadena base64 dentro de un JSON, que es lo
> aconsejado por la guia; con "N" el cuerpo de la respuesta es el PDF crudo.
>
> NOTA: el RNDC no expone un servicio equivalente para el PDF de la remesa. El
> Manual de Operacion General dice que la empresa de transporte "podra generar
> un documento en formato PDF" con los datos de la remesa radicada, bajo su
> responsabilidad. Es decir, ese lo tenemos que componer nosotros.

- **`RndcPdfError`** · _clase_
  Falla al descargar el PDF del manifiesto desde el RNDC.

- **`descargarPdfManifiesto(config, radicado, consecutivoParaNombre)`** · _función_
  Pide el PDF de un manifiesto ya radicado.

  @param radicado Numero de radicado (ingresoid) devuelto al expedir.

- **`descargarPdfProceso(config, procesoId, radicado, nombreArchivo)`** · _función_
  Descarga generica: tipo 21 = consultar el pdf de un proceso.

- **`pdfDePrueba(radicado)`** · _función_
  PDF de una sola pagina, generado a mano, para el modo simulacion.

### `src/rndc/remesa-impresion.ts`

> Representacion impresa de la remesa terrestre de carga.
>
> El RNDC genera un PDF oficial de la remesa solo desde su portal web; por
> webservice responde "RNDC12: El procesoid 3 no es correcto para generar el
> PDF" (verificado 2026-09-26). El Manual de Operacion General del RNDC
> (5.2.3, salidas de informacion) autoriza a la empresa de transporte a usar
> los datos de la remesa radicada y "bajo su responsabilidad" generar su
> propio documento.
>
> Esto es ese documento. Replica la organizacion y los campos de la remesa
> oficial que produce el portal (ejemplo en docs/Remesa de ejemplo.pdf), con
> el logo de la empresa, pero SIN los logos del Ministerio: la genera la
> empresa, no el RNDC. Lleva el numero de radicado (autorizacion) del RNDC
> para que se pueda verificar.
>
> Se entrega como HTML listo para imprimir: el navegador ya sabe imprimir y
> guardar como PDF, sin meter un motor de renderizado solo para esto.

- **`escapar(valor)`** · _función_
  Texto seguro para el HTML de la remesa: vacio para null/undefined/"" y
  caracteres especiales escapados.

- **`partesFecha(valor)`** · _función_
  AAAA/MM/DD y HH:MM en hora de Colombia, como en la remesa oficial.

- **`dia(valor)`** · _función_
  Columna DATE (sin hora): se lee el dia guardado, sin zona horaria.

- **`numero(valor)`** · _función_
  Numero con separador de miles colombiano (34.000); vacio si no hay valor.

- **`coordenadas(t)`** · _función_
  "Latitud: x  Longitud: y" de una sede, o vacio si no tiene coordenadas.

- **`texto(tabla, codigo)`** · _función_
  Nombre de un codigo segun su tabla; si no esta, "Codigo N" (nunca se
  inventa un nombre). Vacio si no hay codigo.

- **`construirHtmlRemesa(d)`** · _función_
  HTML imprimible de una remesa con el formato de la remesa oficial del RNDC:
  empresa y logo, numeros y radicado, remitente y destinatario con citas y
  tiempos pactados, mercancia (cantidad, peso, empaque, naturaleza),
  vehiculo y conductor, y poliza de carga. Si la unidad comercial es kilos y
  no hay cantidad, la cantidad es el peso (igual que al enviarla).

### `src/rndc/sicetac.ts`

> Consulta de valores de referencia SICETAC.
>
> Fuentes:
>  - "GUIA CONSULTA SICETAC PARA WEB SERVICE" (Ministerio de Transporte,
>    11/08/2025) -> estructura de la peticion y de la respuesta [SIC25]
>  - "Consulta de SiceTac desde RNDC" (agosto 2021) -> formula del valor
>    minimo y regla de los codigos de municipio [SIC21]
>
> Va por el mismo WSDL SOAP del resto del RNDC, con tipo 6 y procesoid 26.
>
> Para que sirve aqui: la respuesta trae, por cada ruta posible entre dos
> municipios, su identificador (`rutasid`), su descripcion (`via`), si es la
> estandar y su valor de movilizacion. Eso es exactamente lo que alimenta el
> desplegable de "Via a Utilizar" del manifiesto y el piso del flete.

- **`aCabeceraMunicipal(codigo)`** · _función_
  Los municipios de la consulta deben ser cabecera municipal: los ultimos tres
  digitos del codigo DIVIPOLA en 000 [SIC21].

  Importa porque nuestros terceros pueden estar en veredas o centros poblados,
  y con ese codigo SICETAC no devuelve nada. Para efectos de tarifa, la vereda
  cotiza como su cabecera.

- **`periodoDe(fecha)`** · _función_
  Periodo AñoMes de una fecha, en hora de Colombia.

- **`periodoAnterior(periodo, meses)`** · _función_
  Retrocede n meses sobre un periodo AñoMes.

- **`construirXmlSicetac(credenciales, filtros)`** · _función_
  XML de la consulta de SICETAC (tipo 6, proceso 26): periodo, configuracion,
  condicion de carga, origen, destino y unidad de transporte. Los valores van
  entre comillas sencillas dentro de la etiqueta, como en los ejemplos
  oficiales; los filtros vacios no se envian.

- **`aNumero(valor)`** · _función_
  Texto -> number; null si viene vacio o no es un numero valido.

- **`parsearRespuestaSicetac(xml)`** · _función_
  Parte la respuesta en bloques <documento> y lee cada uno.

  Es necesario leer por bloque y no con un buscador plano de etiquetas: la
  respuesta trae una fila por cada combinacion de ruta, tipo de carga y unidad
  de transporte, y mezclarlas daria valores de rutas distintas en una misma
  fila.

- **`calcularPisoSicetac(fila, horasPactadas)`** · _función_
  Valor minimo a pagar del viaje [SIC21]:

    valor movilizacion + (valor hora * horas pactadas de cargue, descargue y espera)

  El valor de movilizacion por si solo NO es el piso: si se compara el flete
  contra el, se subestima el minimo y el RNDC rechaza el manifiesto.

- **`horasPactadasTotales(tiempos)`** · _función_
  Horas pactadas totales, con los minutos convertidos a fraccion de hora.

- **`consultarSicetac(cliente, credenciales, filtros, mesesHaciaAtras)`** · _función_
  Consulta SICETAC con cache, para no chocar con el limite de consultas.

  Como funciona:
  1. Si la misma consulta respondio hace menos de 6 horas (en memoria), la reusa.
  2. Si no, consulta en vivo (consultarSicetacSinCache).
  3. Si SICETAC falla (casi siempre RNDC13 por el limite), usa la ultima
     respuesta buena guardada en la tabla sicetac_respuestas, marcando
     guardadoEn; si no hay ninguna, propaga el error.
  4. Cada respuesta con vias se guarda en memoria y en la tabla.

- **`consultarSicetacSinCache(cliente, credenciales, filtros, mesesHaciaAtras)`** · _función_
  Consulta SICETAC en vivo, retrocediendo de periodo si hace falta.

  La guia advierte que un mes puede no tener registros porque siguen
  aplicando los del anterior: si responde "documento no encontrado" (RNDC11)
  prueba el mes previo, hasta 'mesesHaciaAtras'. Cualquier otro error (por
  ejemplo RNDC13) se lanza: no es un mes vacio.

- **`normalizar(texto)`** · _función_
  Sin tildes, en minuscula y sin espacios sobrantes: "Granel Sólido" = "granel solido".

- **`esFilaVacia(f)`** · _función_
  Filas de vehiculo vacio: no son el piso de un viaje cargado.

- **`filasDeLaOperacion(filas, unidadTransporte, tipoCarga)`** · _función_
  Deja una sola fila por ruta: la de la operacion de la empresa (unidad de
  transporte y tipo de carga).

  SICETAC devuelve una fila por cada combinacion de ruta, tipo de carga y
  unidad de transporte, y cada una tiene un piso distinto.

  Se compara sin tildes: el RNDC responde "Granel Sólido" y la configuracion
  dice "Granel Solido". Antes la comparacion era exacta, nunca coincidia, y se
  caia a TODAS las filas quedandose con la mas barata: "Contenedor vacio",
  cuyo piso es mucho menor. El sistema mostraba ese piso, el flete lo pasaba
  y el RNDC rechazaba el manifiesto (MAN045).

  Si la combinacion exacta no existe, se descartan las filas de vehiculo vacio
  y se toma el piso MAS ALTO de las que quedan (primero las del mismo tipo de
  carga): con un piso de mas el flete pasa; con uno de menos, el RNDC rechaza.

- **`pisoSicetacEnVivo(cliente, credenciales, datos, mesesHaciaAtras)`** · _función_
  Piso de SICETAC de la via del viaje, consultado en el momento.

  Es lo que el RNDC va a exigir, asi que se usa justo antes de enviar. Si la
  via va vacia, el RNDC asigna la estandar: se toma esa. La consulta a veces
  responde RNDC13 y al repetirla funciona (visto el 2026-10-01 con los mismos
  datos, sobre todo con consultas muy seguidas), por eso se intenta otra vez
  tras una pausa antes de rendirse.

  Devuelve null si la via no aparece entre las de la ruta. Lanza si SICETAC
  no responde.

### `src/rndc/sincronizacion.ts`

> Sincronizacion automatica con el RNDC: el TMS refleja lo que de verdad hay
> en el RNDC, aunque se haya hecho en el portal.
>
> Que hace, con consultas de SOLO LECTURA (tipo 3) por rango de fechas:
> - Manifiestos (proceso 4) y remesas (3) expedidos en el portal: se crean como
>   viajes de origen PORTAL, para no perder el control de los consecutivos ni
>   el cuadro pagos. Si el numero ya existe en el TMS se completa su radicado.
> - Cumplidos de manifiesto (6) y de remesa (5): el viaje o la remesa pasa a
>   cumplido.
> - Anulaciones de manifiesto (32) y de remesa (9): pasa a anulado.
> - Cumplido inicial del GPS (45) y su anulacion (54): se guarda en la remesa,
>   para saber que hay que anularlo antes que el manifiesto.
>
> Todas las consultas, sus variables y el formato del rango (iniFECHAING /
> finFECHAING 'AAAA/MM/DD', fin no incluido) se verificaron en produccion el
> 2026-10-10 con manifiestos reales de la empresa.
>
> Cuando corre: al arrancar el servidor y cada 10 minutos sobre los ultimos
> dias; una vez al dia recorre todo desde RNDC_SINCRONIZAR_DESDE (por defecto
> 2026-09-01), mes por mes. Nunca toca un viaje que se esta enviando en ese
> momento (estados PENDIENTE, REINTENTANDO, ANULANDO o CUMPLIENDO).

- **`fechaIngresoRndc(texto)`** · _función_
  FECHAING del RNDC ("09/10/2026 10:08:12 p. m." o "1/10/2026 5:48:55 a. m.",
  hora de Colombia) -> Date. null si no tiene ese formato.

- **`fechaHoraCitaRndc(fecha, hora)`** · _función_
  "DD/MM/AAAA" y "HH:MM" en hora de Colombia -> Date. Sin hora: mediodia.

- **`fechaConsulta(d)`** · _función_
  Date -> "AAAA/MM/DD" (dia de Colombia), el formato del rango de las consultas.

- **`tramosMensuales(desde, hasta)`** · _función_
  Tramos de hasta un mes entre dos fechas: una consulta por tramo, para no pesar al RNDC.

- **`manifiestoSinLetra(numero)`** · _función_
  Numero de un manifiesto re-expedido sin su letra final: "00006579A" ->
  "00006579". Cuando un manifiesto se anula y se vuelve a expedir, el RNDC le
  agrega una letra y la remesa sigue con el numero original (verificado en
  produccion 2026-10-19: 00006549A, 00006579A y 00006670A llevan las remesas
  00006549, 00006579 y 00006670; los manifiestos sin letra estan anulados).
  null si el numero no termina en letra.

- **`partesConsecutivoRemesa(consecutivo)`** · _función_
  "00006692B" -> { base: "00006692", orden: 3 }: la remesa A es la 2, la B la 3.

- **`leerDocumentos(xml)`** · _función_
  Parte la respuesta en documentos: cada uno, sus etiquetas en minuscula -> valor.

- **`consultarRango(cliente, cred, procesoId, variables, desde, hasta)`** · _función_
  Documentos de un proceso registrados entre dos fechas (tipo 3, filtrado por
  el NIT de la empresa). "Documento no encontrado" (RNDC11) = ninguno.

- **`consultarTramos(cliente, cred, procesoId, variables, desde, hasta)`** · _función_
  Lo mismo por tramos mensuales, con una pausa corta entre consultas.

- **`num(v)`** · _función_
  Texto numerico del RNDC -> number; vacio o ausente -> null.

- **`q(sql, params)`** · _función_
  Ejecuta una consulta SQL y devuelve solo las filas (o el resultado del INSERT/UPDATE).

- **`idPor(tabla, campo, valor)`** · _función_
  Id del catalogo por un campo (placa, cedula) o null si no esta.

- **`crearViajePortal(m, remesas, resumen)`** · _función_
  Crea en el TMS un viaje expedido en el portal, con sus remesas.

- **`crearRemesaPortal(viajeId, r, resumen)`** · _función_
  Crea una remesa del portal ligada a su viaje (si su consecutivo no existe ya).

- **`viajeParaRemesa(base)`** · _función_
  Viaje al que va una remesa del portal: el manifiesto con su numero si esta
  vigente; si se anulo, el re-expedido con letra (00006579 -> 00006579A); si
  no hay otro, el anulado (como antes).

- **`reubicarRemesasDeReexpedidos(resumen)`** · _función_
  Remesas que quedaron en un manifiesto anulado cuando ya hay uno vigente
  re-expedido con letra (antes la sincronizacion las pegaba al anulado y el
  vigente quedaba sin remesas, fuera del cuadro pagos): pasan al vigente, con
  su fila del cuadro. No toca viajes que se estan enviando.

- **`viajePorManifiesto(numero)`** · _función_
  Viaje del TMS por numero de manifiesto, con la placa con que se expidio.

- **`remesaPorConsecutivo(consecutivo)`** · _función_
  Remesa del TMS por consecutivo, con el estado de su viaje.

- **`sincronizarRango(cliente, cred, desde, hasta)`** · _función_
  Trae del RNDC todo lo registrado entre dos fechas y lo refleja en el TMS.
  Ver la cabecera del modulo. Devuelve lo que cambio.

- **`buscarRemesasFaltantes(cliente, cred, resumen)`** · _función_
  Manifiestos vigentes sin ninguna remesa en el TMS (no salen en el cuadro
  pagos): se pide al RNDC (tipo 3, solo lectura) la remesa con el numero del
  manifiesto, o sin su letra si es re-expedido (00006549A -> 00006549). Pasa
  cuando la remesa se registro antes del rango que se sincroniza.

- **`crearViajeAnulado(a)`** · _función_
  Viaje anulado en el RNDC que el TMS no conocia. Solo se sabe lo que guarda
  la anulacion (numero, radicado, motivo, observacion y fecha): el RNDC ya no
  entrega los datos del manifiesto anulado.

- **`crearRemesaAnulada(viajeId, a)`** · _función_
  Remesa anulada en el RNDC que el TMS no conocia, ligada a su viaje.

- **`desdeCompleto()`** · _función_
  Fecha desde la que se recorre todo (RNDC_SINCRONIZAR_DESDE, por defecto 2026-09-01).

- **`sincronizarConRndc(opciones)`** · _función_
  Una sincronizacion: los ultimos DIAS_VENTANA_CORTA dias, o todo desde
  RNDC_SINCRONIZAR_DESDE si `completa` (o si hace mas de 24 h del ultimo
  barrido completo). No corre dos a la vez. Guarda el resultado en
  sincronizacion_rndc.

- **`estadoSincronizacion()`** · _función_
  Estado de la ultima sincronizacion, para mostrarlo en pantalla.

- **`iniciarSincronizacionAutomatica()`** · _función_
  Arranca la sincronizacion automatica: una al minuto de iniciar el servidor y
  luego cada MINUTOS_ENTRE_SINCRONIZACIONES. Los errores (por ejemplo, el RNDC
  caido) se registran y se reintenta en la siguiente vuelta.

### `src/routes/auth.ts`

> Rutas de sesion (/api/auth): login con limite de intentos, logout,
> "quien soy", cambio de clave y recuperacion de clave por codigo al correo.

- **`POST /login`** · _ruta HTTP_
  Inicio de sesion con email y contrasena. El mensaje de error es el mismo
  para email inexistente y clave errada: no revela que correos tienen cuenta.

- **`POST /logout`** · _ruta HTTP_
  POST /api/auth/logout: cierra la sesion del token de la cookie (si hay) y
  borra la cookie. Responde 204 sin cuerpo.

- **`GET /sesion`** · _ruta HTTP_
  Quien soy: lo usa el frontend al abrir para saber si hay sesion.

- **`POST /cambiar-clave`** · _ruta HTTP_
  Cambiar la propia contrasena (obligatorio tras una clave temporal).

- **`POST /recuperar`** · _ruta HTTP_
  Paso 1: pedir un codigo. La respuesta es la MISMA exista o no el correo: no
  revela que cuentas existen. Tras 5 pedidos seguidos para el mismo correo,
  se bloquea un rato.

- **`POST /recuperar/confirmar`** · _ruta HTTP_
  Paso 2: con el codigo recibido, crear la contrasena nueva.

### `src/routes/catalogo.ts`

> Rutas del catalogo (/api/catalogo): vehiculos, remolques, conductores,
> terceros, empresas de monitoreo, municipios, vias y SICETAC, plantillas,
> tarifas por ruta, alertas de vencimiento y parametros de la empresa.
> Requieren sesion.

- **`responderEdicion(res, editar, extra)`** · _función_
  Corre una edicion y traduce los errores conocidos a respuestas claras:
  404 si no existe, 409 si choca con otro registro (placa/cedula/NIT
  repetidos) y 422 si un dato no tiene el formato esperado.

- **`soloPresentes(b, llaves)`** · _función_
  Copia del body solo las llaves que llegaron, para no pisar lo que no se edito.

- **`soloDigitos(v)`** · _función_
  Deja solo los digitos de un valor (NIT, cedula). null/undefined se conservan.

- **`mayusculas(v)`** · _función_
  Texto en mayuscula y sin espacios en los extremos (placas, categorias). null/undefined se conservan.

- **`GET /remolques`** · _ruta HTTP_
  GET /api/catalogo/remolques: todos los remolques.

- **`POST /remolques`** · _ruta HTTP_
  POST /api/catalogo/remolques: crea un remolque (placa en mayuscula). 201 con el creado.

- **`PUT /remolques/:id`** · _ruta HTTP_
  PUT /api/catalogo/remolques/:id: edita solo los campos enviados.

- **`ErrorGps`** · _clase_
  Link del GPS no valido: la ruta lo responde como 422.

- **`urlGps(valor)`** · _función_
  Link de una plataforma GPS: vacio -> null; solo http(s), para que nadie
  guarde un "javascript:..." que se ejecute al hacer clic. Lanza ErrorGps.

- **`guardarGpsVehiculo(id, b)`** · _función_
  Guarda los datos del GPS que vengan en el cuerpo (gpsUrl, gpsUsuario,
  gpsClave). gpsClave vacia o ausente no cambia la guardada; null la borra.

- **`guardarGpsO422(res, id, b)`** · _función_
  guardarGpsVehiculo respondiendo 422 si el link esta mal o falta la llave de
  cifrado. Devuelve false si ya respondio el error (la ruta debe terminar).

- **`GET /vehiculos/:id/gps`** · _ruta HTTP_
  GET /api/catalogo/vehiculos/:id/gps: link, usuario y clave (descifrada) de
  la plataforma GPS del vehiculo, para revisar a que hora salio del cargue
  mientras se despacha. Es la unica ruta que entrega la clave.

- **`GET /vehiculos`** · _ruta HTTP_
  GET /api/catalogo/vehiculos: vehiculos del catalogo (sin los eliminados).

- **`POST /vehiculos`** · _ruta HTTP_
  POST /api/catalogo/vehiculos: crea un vehiculo.

  El FOPAT por defecto sale de los parametros de la empresa. Si la placa
  existia y fue eliminada, se recupera con los datos nuevos en vez de fallar
  por placa repetida.

- **`DELETE /vehiculos/:id`** · _ruta HTTP_
  "Elimina" un vehiculo: borrado logico. Sale del catalogo, del despacho y de
  las alertas, pero se conserva para los viajes que ya lo usaron.

- **`PUT /vehiculos/:id`** · _ruta HTTP_
  Edicion completa de un vehiculo desde el catalogo.

  El titular del manifiesto (codTipoIdTenedor + numIdTenedor) es lo que viaja
  en CODIDTITULARMANIFIESTO / NUMIDTITULARMANIFIESTO [MANIFIESTO V7 pag. 11].
  En la flota propia la empresa usa la cedula del propietario y no su NIT,
  porque con la empresa como titular el RNDC exige valor a pagar 0 (MAN006).

- **`GET /conductores`** · _ruta HTTP_
  GET /api/catalogo/conductores: todos los conductores.

- **`POST /conductores`** · _ruta HTTP_
  POST /api/catalogo/conductores: crea un conductor (cedula por defecto). 201 con el creado.

- **`PUT /conductores/:id`** · _ruta HTTP_
  PUT /api/catalogo/conductores/:id: edita los campos enviados. La cedula
  queda solo con digitos, la categoria en mayuscula; cedula y nombre no pueden
  quedar vacios.

- **`GET /terceros`** · _ruta HTTP_
  GET /api/catalogo/terceros: clientes, remitentes y destinatarios.

- **`POST /terceros`** · _ruta HTTP_
  POST /api/catalogo/terceros: crea un cliente, remitente o destinatario.

  Las coordenadas se revisan contra las reglas del RNDC (6 decimales, dentro
  de Colombia) y el problema se devuelve como aviso (avisoCoordenada), sin
  rechazar el registro.

- **`PUT /terceros/:id`** · _ruta HTTP_
  PUT /api/catalogo/terceros/:id: edita los campos enviados. NIT y nombre
  obligatorios; el municipio debe ser un codigo DIVIPOLA de 8 digitos.

- **`POST /:maestro/:id/rndc`** · _ruta HTTP_
  POST /api/catalogo/:maestro/:id/rndc: crea o actualiza en el RNDC el
  tercero, conductor, vehiculo o remolque con los datos que tiene hoy el
  catalogo (procesos 11 y 12, ver src/rndc/maestros.ts). Responde
  { ok, radicado, yaEstabaIgual, error } y deja el resultado guardado en la fila.

- **`GET /rutas`** · _ruta HTTP_
  GET /api/catalogo/rutas: rutas guardadas (tabla en desuso).

- **`POST /rutas`** · _ruta HTTP_
  POST /api/catalogo/rutas: crea una ruta origen-destino (tabla en desuso).

- **`GET /municipios`** · _ruta HTTP_
  Para elegir la ruta de una plantilla por nombre y no por codigo. Puede venir
  vacio si aun no se importo el CSV de municipios.

- **`GET /monitoreo`** · _ruta HTTP_
  GET /api/catalogo/monitoreo: empresas de monitoreo de flota activas.

- **`POST /monitoreo`** · _ruta HTTP_
  POST /api/catalogo/monitoreo: registra (o reactiva) una empresa de
  monitoreo de flota con NIT (maximo 15 digitos) y nombre.

- **`PUT /monitoreo/:id`** · _ruta HTTP_
  PUT /api/catalogo/monitoreo/:id: cambia NIT y/o nombre de una empresa de monitoreo.

- **`DELETE /monitoreo/:id`** · _ruta HTTP_
  DELETE /api/catalogo/monitoreo/:id: desactiva la empresa de monitoreo (204).

- **`PUT /vehiculos/:id/monitoreo`** · _ruta HTTP_
  Fija el proveedor de GPS por defecto de un vehiculo.

- **`GET /vias/sicetac`** · _ruta HTTP_
  Vias consultadas en linea a SICETAC para un par de municipios.

  Devuelve tambien el piso tarifario de cada via, que es el dato que decide si
  el flete pactado es valido. Las vias se guardan en la tabla local para poder
  seguir despachando si el servicio del Ministerio no responde.

- **`GET /vias`** · _ruta HTTP_
  GET /api/catalogo/vias?origen=&destino=: vias guardadas de un par de
  municipios (codigos DIVIPOLA de 8 digitos), la estandar primero.

- **`POST /vias`** · _ruta HTTP_
  POST /api/catalogo/vias: guarda o actualiza una via (CODVIA) de un par
  origen-destino con su descripcion y, si se conoce, su valor SICETAC.

- **`GET /tarifas/rutas`** · _ruta HTTP_
  Rutas existentes con su rango de tarifas, para ver donde hay dispersion.

- **`GET /tarifas/previsualizar`** · _ruta HTTP_
  Plantillas afectadas por una ruta, para revisar ANTES de actualizar.

- **`PUT /tarifas`** · _ruta HTTP_
  Aplica la nueva tarifa a todas las plantillas de la ruta.

- **`GET /alertas`** · _ruta HTTP_
  El RNDC valida SOAT, tecnomecanica y licencia contra la fecha de descargue,
  no contra hoy: conviene ver lo que vence pronto y no solo lo vencido.

- **`datosFijosEmpresa()`** · _función_
  Poliza de carga, FOPAT y tarifa de retefuente. Cambian una vez al ano, asi
  que viven aqui y no en cada plantilla.
  nitEmpresa / nombreEmpresa / ambienteRndc vienen del .env y son de solo
  lectura: el catalogo los muestra (y usa el NIT para marcar los vehiculos
  cuyo titular es la propia empresa), pero no se editan desde la pantalla.

- **`GET /parametros`** · _ruta HTTP_
  GET /api/catalogo/parametros: parametros de la empresa, sus datos fijos
  (nombre, NIT) y el aviso de vigencia de la poliza de carga.

- **`PUT /parametros`** · _ruta HTTP_
  PUT /api/catalogo/parametros: guarda los parametros de la empresa. Solo
  cambian los campos que llegan: un guardado parcial no borra la poliza.

- **`GET /plantillas`** · _ruta HTTP_
  GET /api/catalogo/plantillas: plantillas activas con sus terceros.

- **`DELETE /plantillas/:id`** · _ruta HTTP_
  "Elimina" una plantilla (en realidad la desactiva: ver plantillas.desactivar
  en el repo). No se borra de verdad porque el historial de viajes y remesas
  la referencia por id.

- **`plantillaDesdeCuerpo(b)`** · _función_
  Convierte el cuerpo de la peticion en los datos de una plantilla.

  Lo comparten la creacion y la edicion, para que las dos normalicen igual.
  Devuelve un mensaje de error si falta algo sin lo cual no se puede
  despachar.

- **`POST /plantillas`** · _ruta HTTP_
  POST /api/catalogo/plantillas: valida el cuerpo (plantillaDesdeCuerpo) y
  crea la plantilla. 422 con el problema si algo no es valido.

- **`PUT /plantillas/:id`** · _ruta HTTP_
  Edita una plantilla.

  Lo que no venga en el cuerpo conserva su valor actual (se mezcla sobre la
  plantilla guardada), asi un cliente que mande solo algunos campos no borra
  el resto con los valores por defecto.

### `src/routes/cuadro.ts`

- **`responder(res, fn)`** · _función_
  Errores de validacion (ErrorCuadro) como 422 con su mensaje; lo demas sigue
  al manejador general. Tambien lo usan las rutas de seguimiento.

- **`GET /`** · _ruta HTTP_
  GET /api/cuadro: todos los viajes del cuadro (sincroniza antes los manifiestos).

- **`GET /bombas`** · _ruta HTTP_
  GET /api/cuadro/bombas: catalogo de bombas aliadas.

- **`POST /bombas`** · _ruta HTTP_
  POST /api/cuadro/bombas: crea una bomba ({ nombre, ciudad }). Devuelve su id.

- **`PUT /bombas/:bombaId`** · _ruta HTTP_
  PUT /api/cuadro/bombas/:bombaId: cambia nombre, ciudad o activa; devuelve la lista.

- **`GET /anticipos`** · _ruta HTTP_
  GET /api/cuadro/anticipos: todos los tramos de anticipo (ida y vuelta), lo mas reciente primero.

- **`POST /anticipos/importar/previa`** · _ruta HTTP_
  POST /api/cuadro/anticipos/importar/previa: propone el viaje de cada fila del
  Excel de anticipos ({ filas }). No guarda nada.

- **`POST /anticipos/importar`** · _ruta HTTP_
  POST /api/cuadro/anticipos/importar: carga las filas confirmadas ({ filas: [{ ...fila, viajeId }] }).

- **`GET /anticipos/resumen`** · _ruta HTTP_
  GET /api/cuadro/anticipos/resumen: deuda, pagado, abonado por el socio, pendiente y cupo con la bomba.

- **`PUT /anticipos/parametros`** · _ruta HTTP_
  PUT /api/cuadro/anticipos/parametros: cupo de credito con la bomba y precio
  y descuento por galon sugeridos ({ cupoBomba, precioGalonBomba, descuentoGalonBomba }).
  Va antes de /anticipos/:anticipoId para que "parametros" no se tome como id.

- **`POST /anticipos/juntar`** · _ruta HTTP_
  POST /api/cuadro/anticipos/juntar: junta dos tanqueos de la misma placa como
  ida y vuelta ({ ida, vuelta }: ids de tanqueo). Devuelve el cuadro.

- **`POST /anticipos/separar/:tanqueoId`** · _ruta HTTP_
  POST /api/cuadro/anticipos/separar/:tanqueoId: separa la vuelta de un tanqueo de ida y vuelta.

- **`GET /relaciones-bomba`** · _ruta HTTP_
  GET /api/cuadro/relaciones-bomba: facturas (relaciones de vales) de la bomba ya cruzadas.

- **`POST /relaciones-bomba/previa`** · _ruta HTTP_
  POST /api/cuadro/relaciones-bomba/previa: propone el tanqueo de cada vale ({ numero, vales }). No guarda.

- **`POST /relaciones-bomba`** · _ruta HTTP_
  POST /api/cuadro/relaciones-bomba: guarda la relacion y cruza los tanqueos ({ numero, fecha, nota, vales }).

- **`PUT /relaciones-bomba/:relacionId/pago`** · _ruta HTTP_
  PUT /api/cuadro/relaciones-bomba/:relacionId/pago: fecha de pago de la factura ({ fechaPago }; vacia la quita).

- **`PUT /relaciones-bomba/:relacionId/vencimiento`** · _ruta HTTP_
  PUT /api/cuadro/relaciones-bomba/:relacionId/vencimiento: fecha de vencimiento de la factura ({ fechaVencimiento }).

- **`GET /reportes/bomba`** · _ruta HTTP_
  GET /api/cuadro/reportes/bomba?desde=AAAA-MM-DD&hasta=AAAA-MM-DD: estado de
  cuenta con la bomba (deuda al inicio, prestamos, abonos de los socios,
  pagos de la empresa, deuda al final) y lo prestado por mes, bomba y empresa.

- **`GET /pagos-bomba`** · _ruta HTTP_
  GET /api/cuadro/pagos-bomba: pagos a la bomba (facturas de la quincena menos abonos de los socios).

- **`POST /pagos-bomba`** · _ruta HTTP_
  POST /api/cuadro/pagos-bomba: registra el pago ({ relaciones, abonos, fecha, referencia }). Devuelve los pagos.

- **`DELETE /pagos-bomba/:pagoId`** · _ruta HTTP_
  DELETE /api/cuadro/pagos-bomba/:pagoId: deshace un pago a la bomba.

- **`DELETE /relaciones-bomba/:relacionId`** · _ruta HTTP_
  DELETE /api/cuadro/relaciones-bomba/:relacionId: borra la relacion y deshace el cruce.

- **`GET /abonos-socio`** · _ruta HTTP_
  GET /api/cuadro/abonos-socio: abonos del socio a la bomba, con sus viajes.

- **`POST /abonos-socio`** · _ruta HTTP_
  POST /api/cuadro/abonos-socio: registra un abono ({ socio, fecha, nota, viajes: [{ cuadroViajeId, valor }] }).

- **`DELETE /abonos-socio/:abonoId`** · _ruta HTTP_
  DELETE /api/cuadro/abonos-socio/:abonoId: borra un abono.

- **`PUT /anticipos/:anticipoId`** · _ruta HTTP_
  PUT /api/cuadro/anticipos/:anticipoId: fecha de pago, nota, viaje o datos del cruce (galones, precio y descuento: recalcula el combustible) de un tramo.

- **`PUT /tanqueos/:tanqueoId`** · _ruta HTTP_
  PUT /api/cuadro/tanqueos/:tanqueoId: factura de la bomba (numero, fecha) o la bomba del tanqueo.

- **`GET /tarifas`** · _ruta HTTP_
  GET /api/cuadro/tarifas: la matriz de fletes.

- **`PUT /tarifas`** · _ruta HTTP_
  PUT /api/cuadro/tarifas: reemplaza la matriz completa con la importada del
  Excel ({ tarifas: [{ nombre, razonSocial, valor, tipo, pesoMinimoKg, observaciones }] }).

- **`POST /tarifas`** · _ruta HTTP_
  POST /api/cuadro/tarifas: agrega una tarifa a la matriz ({ nombre, razonSocial, valor, tipo, ... }).

- **`PUT /tarifas/:tarifaId`** · _ruta HTTP_
  PUT /api/cuadro/tarifas/:tarifaId: cambia una tarifa y la devuelve (404 si no existe).

- **`GET /por-facturar`** · _ruta HTTP_
  GET /api/cuadro/por-facturar: viajes listos para facturar (y los ya enviados sin fecha de factura).

- **`POST /enviar-facturacion`** · _ruta HTTP_
  POST /api/cuadro/enviar-facturacion: guarda en cada viaje lo que va en el
  cuadro de la contadora ({ filas: [{ id, tarifaFleteId, tipo, valorTon,
  pesoFacturadoKg, total, remision, notaFactura, facturaNumero }] }).

- **`POST /facturar`** · _ruta HTTP_
  Asigna una misma factura a varios viajes.

- **`GET /:id`** · _ruta HTTP_
  GET /api/cuadro/:id: un viaje con sus anticipos y notas (404 si no existe).

- **`POST /`** · _ruta HTTP_
  POST /api/cuadro: crea un viaje sin manifiesto (urbano o planillado por el
  cliente). Placa, empresa y fecha obligatorias. Devuelve el viaje creado.

- **`PUT /:id`** · _ruta HTTP_
  PUT /api/cuadro/:id: guarda los campos enviados (papeles, flete, factura,
  pagos...) y devuelve el viaje actualizado.

- **`POST /:id/tarifa`** · _ruta HTTP_
  POST /api/cuadro/:id/tarifa: pone el flete de una tarifa de la matriz
  elegida a mano ({ tarifaFleteId }) y devuelve el viaje actualizado.

- **`DELETE /:id`** · _ruta HTTP_
  DELETE /api/cuadro/:id: borra un viaje creado a mano. Los que tienen
  manifiesto no se borran aqui (409): se anulan desde Viajes.

- **`POST /:id/revision`** · _ruta HTTP_
  POST /api/cuadro/:id/revision: marca o quita la revision de CONTABILIDAD o
  GERENCIA ({ quien, revisado }), con el usuario y la hora.

- **`POST /:id/notas`** · _ruta HTTP_
  POST /api/cuadro/:id/notas: agrega una nota ({ texto }) con su autor.

- **`DELETE /:id/notas/:notaId`** · _ruta HTTP_
  DELETE /api/cuadro/:id/notas/:notaId: borra una nota.

- **`POST /:id/anticipos`** · _ruta HTTP_
  POST /api/cuadro/:id/anticipos: registra un anticipo de bomba
  ({ bombaId, valor, fecha, fechaPago?, nota? }).

- **`PUT /:id/anticipos/:anticipoId`** · _ruta HTTP_
  PUT /api/cuadro/:id/anticipos/:anticipoId: cambia la fecha de pago a la
  bomba y/o la nota del anticipo.

- **`DELETE /:id/anticipos/:anticipoId`** · _ruta HTTP_
  DELETE /api/cuadro/:id/anticipos/:anticipoId: quita un anticipo.

### `src/routes/despacho.ts`

> Rutas del despacho (/api/despacho): todo lo que se hace con el RNDC.
>
> - Despachar: valida, expide las remesas (proceso 3) y el manifiesto (4).
> - Reintentar un viaje fallido y adoptar documentos que ya existian
>   (DUPLICADO o expedidos en el portal).
> - Anular: cumplido inicial (54), manifiesto (32) y remesas (9).
> - Cumplir remesas (5) con los tiempos del GPS (45), anular su cumplido (28)
>   y cumplir el manifiesto (6) con el piso SICETAC del cumplido.
> - Consultas: historial, consecutivos, detalle, datos enviados, FOPAT.
> - Documentos: PDF del manifiesto y remesa imprimible.
> Requieren sesion.

- **`validarDocumentos(vehiculo, conductor, conductor2, ultimoDescargue)`** · _función_
  Vigencia de documentos. El RNDC compara contra la fecha mas alta de cita de
  DESCARGUE de las remesas del manifiesto, no contra el dia de hoy
  [MANIFIESTO V7 pag. 12-13]. Con multiparada eso significa la ultima parada.

- **`validarPisoSicetac(datos)`** · _función_
  Piso de SICETAC antes de enviar: el flete debe ser igual o mayor al costo
  eficiente de la via, o el RNDC rechaza el manifiesto (MAN045).

  Se consulta SICETAC EN EL MOMENTO, con la misma configuracion, ruta, via y
  horas pactadas del viaje: es el valor que va a exigir el RNDC. Antes se usaba
  el ultimo valor guardado, que podia estar desactualizado o mal filtrado, y
  dejaba pasar fletes que el RNDC rechazaba DESPUES de crear la remesa.

  Si SICETAC no responde, se usa el valor guardado y se avisa que no se pudo
  verificar en vivo: es peor no poder despachar que despachar con la duda, y
  el RNDC tiene la ultima palabra.

- **`sinVacios(datos)`** · _función_
  Quita los campos vacios: el XML tampoco los lleva.

- **`armarDatosRndc(viaje, filas, datosViaje, datosRemesas, consecutivoManifiesto, rutaBase)`** · _función_
  Todos los datos del manifiesto y de cada remesa tal como van al RNDC (mismas
  funciones que arman el XML), mas la via elegida con su piso de SICETAC. Si
  algun bloque no se puede armar, se informa el motivo en vez de fallar.

- **`mensajesDe(problemas, gravedad)`** · _función_
  Mensajes de los problemas de validacion de una gravedad (ERROR o AVISO).

- **`aTerceroRndc(t)`** · _función_
  Tercero de la plantilla -> los datos que necesita el RNDC (tipo y numero de
  identificacion, sede, nombre, municipio y coordenadas).

- **`aDatosRemesa(fila, plantilla)`** · _función_
  Arma los datos de una remesa a partir de su plantilla y sus datos variables.

- **`POST /`** · _ruta HTTP_
  El "boton unico" del despacho.

  Recibe el vehiculo, el conductor y una lista de remesas (una por cada cliente
  o parada), crea las remesas en el RNDC y luego el manifiesto que las agrupa.

- **`resumenParcial(creadas, fallida, detalle)`** · _función_
  Mensaje de error cuando el viaje quedo a medias: unas remesas creadas en el
  RNDC y otras no. Decirlo explicitamente evita que alguien reintente el viaje
  completo y duplique las que ya pasaron.

- **`procesarViaje(viajeId, opciones)`** · _función_
  Valida y envia al RNDC lo que le falte a un viaje ya guardado.

  La usan el despacho y el reintento. Lee todo de la base (viaje, remesas,
  plantillas, vehiculo, conductor...), asi que lo corregido en el catalogo
  antes de reintentar se toma en cuenta.

  Las remesas que ya estan CREADA en el RNDC no se reenvian: se reutilizan en
  el manifiesto. Reenviarlas duplicaria el documento, y el manifiesto acepta
  remesas activas (ni cumplidas ni anuladas) [MANIFIESTO V7, validaciones de
  REMESASMAN].

- **`POST /remesas/:remesaId/usar-existente`** · _ruta HTTP_
  "Ya existe" en el RNDC: la remesa o el manifiesto quedaron creados en un
  intento anterior aunque aqui figure el error (por ejemplo, se perdio la
  respuesta). El RNDC lo dice con "DUPLICADO:<radicado>".

  No se adopta solo: el numero repetido tambien puede ser de OTRO documento
  (asi paso con la remesa 00006728, expedida desde el portal). La persona
  confirma que es el mismo y entonces se toma ese radicado. Solo se acepta el
  radicado que el propio RNDC informo en el error.

- **`POST /:id/usar-manifiesto-existente`** · _ruta HTTP_
  POST /api/despacho/:id/usar-manifiesto-existente: adopta un manifiesto que
  el RNDC reporto como existente ("DUPLICADO:<radicado>").

  Solo para viajes en MANIFIESTO_ERROR con ese radicado en el error: el viaje
  queda CONFIRMADO con el radicado y un aviso de que se tomo del RNDC.

- **`tomarSiYaExpedido(viaje, numeroPedido)`** · _función_
  Antes de reintentar: el manifiesto con este numero ya existe en el RNDC?

  Pasa cuando el viaje se expide por fuera del sistema (por ejemplo en el
  portal, porque el carro tenia que salir) o cuando se perdio la respuesta de
  un envio. Si existe y es de la misma placa, el viaje queda CONFIRMADO con el
  radicado y los valores que tiene el RNDC (flete, FOPAT, anticipo, via), y se
  buscan los radicados de las remesas pendientes. Si es de otra placa, el
  numero lo uso otro despacho: no se toma nada.

  Devuelve null para seguir con el reintento normal: si no existe, si se esta
  simulando, o si la consulta falla (el reintento no se bloquea por eso).

- **`GET /:id/datos-rndc`** · _ruta HTTP_
  Todos los datos que el viaje envia (o enviaria) al RNDC, sin enviar nada.
  Para revisarlos antes de reintentar.

- **`POST /:id/reintentar`** · _ruta HTTP_
  Reintenta un viaje que quedo a medias, despues de corregir lo necesario.

  Caso tipico: la remesa se creo pero el manifiesto fue rechazado (ej. MAN130,
  el titular no existe como tercero). Se corrige en el catalogo o en el portal
  del RNDC y se reintenta: las remesas ya creadas se reutilizan y solo se envia
  lo que falta.

  El body puede corregir los datos del manifiesto: vehiculo, conductores,
  remolque, valores, via, EMF, vacios, viajes del dia y el numero.

  Tambien las cargas (`remesas`), pero solo las que el RNDC aun no creo:
    - Si ninguna remesa esta creada, se reemplazan todas (se pueden agregar o
      quitar cargas) y se renumeran con el numero base del viaje.
    - Si alguna ya esta creada, esas no se tocan (en el RNDC ya existen; si
      tienen un error se anulan) y no se pueden agregar ni quitar cargas: solo
      se corrigen las pendientes, en el mismo orden.
  Es lo que usa "Despachar" cuando el RNDC rechaza: reintenta el mismo viaje
  en vez de crear otro con el mismo numero.

- **`consultarEstadoParaAnular(viaje, remesas)`** · _función_
  Lo que falta anular de un viaje, en el orden en que se hara.
  Antes de anular, pregunta al RNDC (solo lectura) que existe de verdad y lo
  guarda en el viaje y sus remesas:
  - el cumplido inicial del GPS de cada remesa (45) y si ya se anulo (54);
  - si la remesa (9) o el manifiesto (32) ya se anularon, por ejemplo en el portal.
  Asi la anulacion solo envia lo que falta y en el orden correcto. Devuelve
  false si el RNDC no respondio (entonces se anula como antes, a ciegas).

- **`planDeAnulacion(viaje, remesas, consultado)`** · _función_
  Lo que falta anular de un viaje. Con `consultado` (se sabe del RNDC que
  existe), solo se anulan los cumplidos iniciales que existen y siguen
  vigentes; sin consulta, se intenta en todas las remesas (como antes).

- **`cumplidoManifiestoExiste(numero)`** · _función_
  true si el RNDC todavia tiene el cumplido del manifiesto (consulta de solo
  lectura). Si no se puede consultar, se asume que si (no se salta el error).

- **`cumplidoRemesaExiste(consecutivo)`** · _función_
  Igual para el cumplido de una remesa.

- **`mesDe(fecha)`** · _función_
  Mes "AAAA-MM" de una fecha (para el tope mensual de anulaciones).

- **`GET /:id/anulacion`** · _ruta HTTP_
  Vista previa: que pasos se van a ejecutar, que motivos acepta el RNDC y como
  va el tope mensual de anulaciones de manifiestos.

- **`POST /:id/anular`** · _ruta HTTP_
  Anula un viaje en el RNDC, en el orden que exige:
    0. si el viaje ya estaba cumplido: el cumplido del manifiesto (29) y
       luego el de cada remesa cumplida (28). Con el manifiesto cumplido el
       RNDC no deja anular el cumplido de una remesa (ACR070), y una remesa
       cumplida no se puede anular (Manual 6.1);
    1. cumplido inicial de cada remesa (54): lo genera el satelital y pide el
       numero del manifiesto, asi que va mientras este exista;
    2. el manifiesto (32);
    3. cada remesa (9): el RNDC no deja anular una remesa ligada a un
       manifiesto vigente (ANR030).

  Si el cumplido del manifiesto no se puede anular (por ejemplo, ya esta
  facturado o el titular lo acepto), el viaje vuelve a CUMPLIDO con el error:
  no se toco nada en el RNDC.

  Cada paso exitoso se guarda en el momento. Si uno falla, el viaje queda en
  ANULACION_ERROR y al volver a llamar se retoma desde ahi.

  Un error en el paso 1 NO detiene la anulacion: no sabemos que responde el
  RNDC cuando la remesa no tiene cumplido inicial (sin satelital, como en
  pruebas). Si el cumplido existia y no se anulo, el paso 2 falla con su
  propio mensaje y no se pierde nada.

- **`POST /remesas/:remesaId/cumplir`** · _ruta HTTP_
  Cumplido de una remesa (proceso 5): reporta los kilos entregados y la hora
  real de entrada al cargue y al descargue. El RNDC completa la llegada y la
  salida con el cumplido inicial que genera el GPS [Guia Cumplido 2.3].

  Solo cumplido normal (tipo C); el de suspension se hace en el portal (ver
  construirDatosCumplidoRemesa).

- **`gpsDeRemesa(consecutivo)`** · _función_
  Cumplido inicial (GPS) de una remesa. undefined = no se pudo consultar;
  null = no hay cumplido inicial (sin GPS).

- **`GET /remesas/:remesaId/gps`** · _ruta HTTP_
  Tiempos que ya reporto el GPS, para mostrarlos bloqueados al cumplir.

- **`GET /remesas/:remesaId/cumplido`** · _ruta HTTP_
  Lo que quedo registrado en el cumplido de una remesa: kilos entregados y
  los seis tiempos, leidos del RNDC (la verdad, incluso si se cumplio en el
  portal). Si el RNDC no responde, lo que se envio desde este sistema.

- **`POST /remesas/:remesaId/anular-cumplido`** · _ruta HTTP_
  Anula el cumplido de una remesa (proceso 28) para corregirlo y volver a
  cumplirla. La remesa vuelve a "creada" con los datos que tenia, para
  corregir solo lo que estaba mal. Si el manifiesto ya esta cumplido, el RNDC
  lo rechaza (ACR070): primero hay que anular el cumplido del manifiesto.

- **`baseCumplidoManifiesto(viaje)`** · _función_
  Lo que necesita la ventana de cumplido del manifiesto para calcular en
  pantalla: valor del manifiesto, tarifa de retencion, si causa FOPAT y los
  motivos que acepta el RNDC.

- **`tiemposLogisticos(viaje)`** · _función_
  Tiempos logisticos del manifiesto, como los muestra el portal al cumplir:
  pactados (de la plantilla de cada remesa) contra ejecutados (los que tiene
  el RNDC en el cumplido de cada remesa: los del GPS o los reportados). El
  ejecutado es salida menos entrada; asi lo calcula el portal (remesa 00006733:
  entrada 19:10, salida 20:13 -> 1 h 3 min).

  Con el valor hora de SICETAC de la via se sugiere el adicional por las horas
  de mas (o el descuento por las de menos): es el mismo valor con que SICETAC
  suma las horas pactadas al piso.

- **`sincronizarCumplidos(viajeId)`** · _función_
  Trae del RNDC los cumplidos hechos por fuera de este sistema (en el portal):
  remesas que aqui siguen CREADA pero en el RNDC ya estan cumplidas, y el
  cumplido del manifiesto. Sin esto el viaje quedaba trabado: el sistema pedia
  cumplir remesas que el RNDC ya tenia (y rechazaba el reenvio). Solo lectura
  (tipo 3). Devuelve lo que adopto, para mostrarlo.

- **`revisarCumplidosTrasError(viajeId)`** · _función_
  Despues de un rechazo del cumplido (remesa o manifiesto) revisa en el RNDC
  todo lo pendiente del viaje con sincronizarCumplidos. Si el RNDC no
  responde, no cambia nada: el error original es el que se muestra.

- **`POST /:id/cumplir/sincronizar`** · _ruta HTTP_
  POST /api/despacho/:id/cumplir/sincronizar: adopta lo cumplido en el portal
  (sincronizarCumplidos) y devuelve lo adoptado, el viaje y sus remesas. Si el
  RNDC no responde, devuelve el error sin fallar: la ventana sigue con lo local.

- **`GET /:id/cumplir/previa`** · _ruta HTTP_
  GET /api/despacho/:id/cumplir/previa: datos para el formulario del cumplido
  del manifiesto: flete, anticipo, vacios, retencion y FOPAT calculados,
  tiempos logisticos con el piso SICETAC del cumplido, y los motivos
  permitidos de adicional y descuento.

- **`POST /:id/cumplir`** · _ruta HTTP_
  POST /api/despacho/:id/cumplir: cumple el manifiesto en el RNDC (proceso 6).

  Como funciona:
  1. Solo viajes CONFIRMADO. Antes de enviar adopta lo cumplido en el portal;
     si el manifiesto ya estaba cumplido, no lo reenvia.
  2. No bloquea por remesas pendientes: el RNDC exige todas cumplidas y lo
     dira con su error si falta alguna.
  3. Calcula el valor final (flete + adicionales - descuento) y, si no se
     escribieron a mano, la retencion en la fuente y el FOPAT sobre ese valor.
  4. Toma el viaje (estado CUMPLIENDO) para evitar dos envios a la vez.
  5. Envia fecha de entrega, via, valores y retenciones. Con radicado (o
     DUPLICADO) queda CUMPLIDO; con rechazo vuelve a CONFIRMADO con el error.

- **`GET /:id/manifiesto.pdf`** · _ruta HTTP_
  PDF del manifiesto, tal como lo genera el Ministerio.

  Se pide al RNDC en vez de componerlo aqui: el formato es el oficial y trae el
  codigo QR de seguridad que las autoridades verifican en via.

- **`GET /:id/manifiesto-contingencia`** · _ruta HTTP_
  Manifiesto de contingencia (HTML para imprimir): cuando el RNDC no deja
  expedir el manifiesto o no entrega su PDF. Lleva los mismos datos que se
  envian al RNDC, sin QR y con el aviso de contingencia. El viaje queda
  marcado y con alerta hasta que se imprime el oficial. ?motivo= el error
  que se vio.

- **`GET /remesas/:remesaId/imprimir`** · _ruta HTTP_
  Impresion de una remesa.

  Primero se intenta el PDF oficial del RNDC. Ese proceso NO esta documentado
  para remesa (la guia solo describe el del manifiesto), asi que si el
  Ministerio no lo entrega se cae a la representacion propia, que el Manual de
  Operacion General autoriza expresamente.

  Con ?propia=1 se salta el intento y se va directo a la nuestra.

- **`GET /:id/remesas`** · _ruta HTTP_
  Remesas de un viaje, con su consecutivo y radicado.

- **`GET /sugerencias/:vehiculoId`** · _ruta HTTP_
  Remolque y conductor sugeridos para un vehiculo: el que mas ha usado en sus
  ultimos viajes; si no tiene historial, el habitual del catalogo
  (placaRemolque y cedulaConductorHabitual). Solo sugiere: el despachador
  puede cambiarlos.

- **`GET /siguiente-consecutivo`** · _ruta HTTP_
  Siguiente numero disponible, para precargar el campo del despacho.
  Se puede cambiar: lo devuelto es una sugerencia, no una reserva.

- **`GET /consecutivos`** · _ruta HTTP_
  Libro de consecutivos: una fila por remesa (la hoja de control de la empresa).

- **`GET /:id/detalle`** · _ruta HTTP_
  Todo lo que se registro al despachar un viaje, para leerlo en una sola
  ventana: documentos y radicados, vehiculo y conductores, cada remesa con sus
  partes y su mercancia, valores, tiempos pactados, y quien hizo que.

- **`GET /sincronizacion`** · _ruta HTTP_
  GET /api/despacho/sincronizacion: estado de la sincronizacion automatica con el RNDC.

- **`POST /sincronizacion`** · _ruta HTTP_
  POST /api/despacho/sincronizacion: sincroniza ya con el RNDC (los ultimos
  dias, o todo desde septiembre con { completa: true }) y devuelve lo que cambio.

- **`GET /historial`** · _ruta HTTP_
  GET /api/despacho/historial: todos los viajes (la tabla pagina de a 50 en
  el navegador). A los manifiestos vigentes sin cumplir cuya cita de descargue
  ya paso les agrega el plazo del cumplido (5 dias habiles).

- **`GET /fopat`** · _ruta HTTP_
  FOPAT causado por mes, con lo que falta pagar a la DIAN.

  El RNDC verifica que la empresa este al dia con el FOPAT del tercer mes
  anterior antes de dejar expedir manifiestos nuevos, asi que conviene tener
  el corte a la mano y no descubrirlo el dia que se bloquee el despacho.

- **`POST /fopat/pagar`** · _ruta HTTP_
  Marca un lote de manifiestos como incluidos en un pago de FOPAT.

- **`GET /:id`** · _ruta HTTP_
  Detalle de un viaje con sus remesas.

### `src/routes/seguimiento.ts`

- **`GET /alertas`** · _ruta HTTP_
  GET /api/seguimiento/alertas: alertas de papeles, facturacion y cartera.

- **`GET /papeles`** · _ruta HTTP_
  GET /api/seguimiento/papeles: viajes sin factura con su alerta de papeles y de facturacion.

- **`POST /papeles/:id`** · _ruta HTTP_
  POST /api/seguimiento/papeles/:id: registra lo que se supo de los papeles
  ({ estadoPapeles?, papelesTiene?, papelesCompletos?, papelesFaltan?, nota? }).
  Devuelve el viaje del cuadro actualizado (404 si no existe).

- **`GET /cartera`** · _ruta HTTP_
  GET /api/seguimiento/cartera?dueno=: facturas por cobrar, totales por cliente
  y facturados sin datos. Con dueno (MAURICIO, CELSO, MILLER, LUISA o
  TERCEROS), solo la parte de los vehiculos de ese dueno.

- **`GET /anticipos-empresas`** · _ruta HTTP_
  GET /api/seguimiento/anticipos-empresas: viajes con anticipo que da la
  empresa (Zorro, Aburra Limpio, sin manifiesto) y lo que debe cada cliente.

- **`POST /anticipos-empresas/pago`** · _ruta HTTP_
  POST /api/seguimiento/anticipos-empresas/pago: la empresa pago el anticipo de esos viajes ({ ids, fecha }).

- **`GET /terceros`** · _ruta HTTP_
  GET /api/seguimiento/terceros: viajes de vehiculos terceros con lo que se
  les paga (valor pactado - anticipos - retenciones si aplican) y el resumen
  por tercero.

- **`POST /terceros/nombres/previa`** · _ruta HTTP_
  POST /api/seguimiento/terceros/nombres/previa: a que vehiculos se le pone
  cada nombre de la Matriz Terceros ({ terceros: [{ nombre, cedula, placas }] }).
  No guarda.

- **`POST /terceros/nombres`** · _ruta HTTP_
  POST /api/seguimiento/terceros/nombres: pone esos nombres como titular de los vehiculos.

- **`GET /rentabilidad`** · _ruta HTTP_
  GET /api/seguimiento/rentabilidad: todos los viajes no anulados con su grupo
  (TERCEROS, CELSO, MAURICIO...) y lo que deja cada uno (ver src/rentabilidad.ts).

- **`GET /rentabilidad/matrices`** · _ruta HTTP_
  GET /api/seguimiento/rentabilidad/matrices: comisiones y retenciones por cliente.

- **`PUT /rentabilidad/matrices`** · _ruta HTTP_
  PUT /api/seguimiento/rentabilidad/matrices: reemplaza las matrices ({ comisiones?, retenciones? }).

- **`POST /terceros/pago`** · _ruta HTTP_
  POST /api/seguimiento/terceros/pago: se le pago al tercero esos viajes ({ ids, fecha, cuentaCobro? }).

- **`PUT /cartera/anticipo`** · _ruta HTTP_
  PUT /api/seguimiento/cartera/anticipo: anticipo del cliente de una factura ({ facturaNumero, empresa, valor }).

- **`POST /cartera/importar/previa`** · _ruta HTTP_
  POST /api/seguimiento/cartera/importar/previa: propone como cargar cada
  factura del Excel "Cartera Total" ({ facturas }): saldo sin viaje o ligada a
  sus viajes. No guarda nada.

- **`POST /cartera/importar`** · _ruta HTTP_
  POST /api/seguimiento/cartera/importar: carga las facturas confirmadas ({ facturas }).

- **`PUT /cartera/plazos`** · _ruta HTTP_
  PUT /api/seguimiento/cartera/plazos: plazo y contacto de cobro de un cliente.

- **`GET /cartera/gestiones`** · _ruta HTTP_
  GET /api/seguimiento/cartera/gestiones?factura=&empresa=: gestiones de cobro de una factura.

- **`POST /cartera/gestiones`** · _ruta HTTP_
  POST /api/seguimiento/cartera/gestiones: anota una gestion de cobro
  ({ facturaNumero, empresa, texto, compromisoPago? }). Devuelve las de esa factura.

- **`POST /cartera/pago`** · _ruta HTTP_
  POST /api/seguimiento/cartera/pago: pago de una factura ({ facturaNumero, empresa, fecha }).

### `src/routes/usuarios.ts`

- **`entregarClave(nombre, email, clave, motivo)`** · _función_
  Envia la clave temporal al correo del usuario. Si el correo no esta
  configurado o falla, devuelve la clave para mostrarla en pantalla: nunca se
  pierde la forma de entregarla.

- **`GET /`** · _ruta HTTP_
  GET /api/usuarios: lista de usuarios del sistema.

- **`POST /`** · _ruta HTTP_
  POST /api/usuarios: crea un usuario con una clave temporal.

  Valida correo y nombre, rechaza correos repetidos (409), genera la clave
  temporal (debe cambiarla al entrar) y la entrega por correo, o en la
  respuesta si el correo no esta configurado (entregarClave).

- **`PUT /:id`** · _ruta HTTP_
  PUT /api/usuarios/:id: cambia nombre y/o estado activo.

  No deja desactivar la propia cuenta ni al ultimo usuario activo. Al
  desactivar a alguien se cierran sus sesiones.

- **`POST /:id/restablecer-clave`** · _ruta HTTP_
  Genera una clave temporal nueva y cierra las sesiones de ese usuario.

### `src/scripts/borrar-viaje.ts`

> Borra viajes de PRUEBA: los simulados y los hechos contra el servidor de
> pruebas del Ministerio. Nunca uno real.
>
> Con Docker (servidor):
>   docker compose --env-file .env.production exec backend node dist/scripts/borrar-viaje.js --listar
>   docker compose --env-file .env.production exec backend node dist/scripts/borrar-viaje.js 00006735
>   docker compose --env-file .env.production exec backend node dist/scripts/borrar-viaje.js 00006735 --confirmar
>
> Sin Docker:  npm run borrar-viaje -- 00006735 [--confirmar]
>
> El viaje se busca por numero de manifiesto (00006735) o por id (#36 o 36).
> Sin --confirmar solo muestra lo que borraria.
>
> Por que hace falta: el numero de un viaje de prueba queda como "usado" y el
> despacho propone el siguiente; y sus radicados no existen en produccion, asi
> que el viaje falla al imprimir. Borrarlo libera el numero.
>
> Por que se niega con los reales: si el viaje tiene un radicado de produccion,
> su numero YA existe en el RNDC. Borrarlo aqui lo liberaria, el despacho lo
> volveria a proponer y el RNDC lo rechazaria por repetido. Un viaje real que
> sobra se ANULA (boton Anular en Viajes), no se borra.
>
> Como se distingue cada radicado:
>   - "SIMULADO-..."      -> simulacion (nunca salio del servidor).
>   - numero >= 900000000 -> ambiente de pruebas del Ministerio [Guia Uso del
>                            Web Service V5, pag. 11: "la respuesta del
>                            ambiente de pruebas es con un radicado mayor a
>                            900,000,000"].
>   - cualquier otro      -> PRODUCCION: no se borra.

- **`tipoDeRadicado(radicado)`** · _función_
  De donde sale un radicado: "SIMULADO-..." = simulado; un numero desde
  RADICADO_MINIMO_PRUEBAS = ambiente de pruebas; cualquier otro = produccion
  (real: ese viaje no se puede borrar).

- **`radicadosDe(v, remesas)`** · _función_
  Todos los radicados del viaje y de sus remesas, con de donde salen.

- **`siguienteNumero()`** · _función_
  Siguiente numero de manifiesto que propondria el despacho (para mostrar el
  efecto de borrar un viaje de prueba).

- **`buscar(texto)`** · _función_
  Busca el viaje por numero de manifiesto (como lo conoce la gente) o por id
  ("#36" o "36"). null si no existe.

- **`listar()`** · _función_
  Viajes que se pueden borrar: sin ningun radicado de produccion.

- **`main()`** · _función_
  Punto de entrada: --listar muestra los viajes de prueba borrables; con un
  numero o id muestra el viaje, sus remesas y radicados, y solo con
  --confirmar lo borra. Se niega si tiene algun radicado de produccion.
  Un viaje sin ningun radicado exige ademas --sin-radicado: no se sabe si su
  numero llego al RNDC por otro lado (el portal).

### `src/scripts/cargar-datos.ts`

> Carga la base local a partir de datos-empresa.json.
>
> Se corre con:  npm run cargar-datos
>
> A diferencia del seed de ejemplo, esto no inventa nada: toma los datos reales
> de la empresa desde un archivo JSON y los deja en la base local para poder
> despachar. No crea nada en el RNDC; todo lo que se cargue aqui tiene que
> existir ya alla.
>
> Es idempotente: si se corre dos veces, no duplica registros.

- **`fecha(valor)`** · _función_
  Texto de fecha del JSON -> Date; vacio -> null.

- **`buscarPendientes(objeto, ruta, encontrados)`** · _función_
  Detecta los "REEMPLAZAR" que quedaron sin llenar.

- **`main()`** · _función_
  Punto de entrada: lee datos-empresa.json, se detiene si quedan valores
  "REEMPLAZAR" sin llenar, y carga en la base local (sin duplicar) los datos
  reales de la empresa. No crea nada en el RNDC.

### `src/scripts/crear-usuario.ts`

> Crea un usuario desde la terminal (sirve para el primero, cuando aun nadie
> puede entrar a la pantalla de Usuarios).
>
>   npm run crear-usuario -- correo@empresa.com "Nombre Apellido"
>
> Genera una contrasena temporal, la muestra UNA vez y obliga a cambiarla en
> el primer ingreso. Si el email ya existe, le restablece la clave.

- **`main()`** · _función_
  Punto de entrada: valida correo y nombre, crea el usuario con una clave
  temporal (o, si ya existe, se la restablece, lo reactiva y cierra sus
  sesiones) y muestra la clave una sola vez.

### `src/scripts/habituales.ts`

> Carga el remolque, el conductor y el proveedor de GPS (empresa de
> monitoreo) habituales de cada vehiculo a partir del historial real de
> manifiestos de la empresa en el RNDC.
>
> Se corre con:  npm run habituales             (solo muestra, no guarda)
>                npm run habituales -- --aplicar (guarda)
>                npm run habituales -- --meses 6 (ventana; por defecto 6)
>
> Usa una consulta tipo 3 del proceso 4 (manifiestos), que es de SOLO LECTURA
> [Guia Uso del Web Service V5, seccion 5]. El cliente va con soloConsultas,
> asi que no puede enviar nada que cree documentos.
>
> Solo llena campos VACIOS del catalogo (placaRemolque,
> cedulaConductorHabitual y nitMonitoreoFlota): no pisa lo que alguien ya
> configuro a mano. Y solo si el remolque, el conductor o la empresa de
> monitoreo existen en el catalogo local.

- **`xmlConsultaMes(ini, fin)`** · _función_
  XML de la consulta tipo 3 del proceso 4 (manifiestos propios) entre dos
  fechas (AAAA/MM/DD): placa, remolque, conductor y empresa de monitoreo de
  cada manifiesto. Solo lectura.

- **`fechaRndc(d)`** · _función_
  Date -> "AAAA/MM/DD", el formato del rango de fechas de la consulta.

- **`leer(bloque, etiqueta)`** · _función_
  Valor de una etiqueta dentro de un bloque <documento>, en mayuscula; "" si no esta.

- **`masFrecuente(valores)`** · _función_
  El valor mas frecuente y cuantas veces aparece.

- **`main()`** · _función_
  Punto de entrada: consulta mes a mes los manifiestos de los ultimos N meses,
  calcula por placa el remolque, conductor y GPS mas frecuentes, y (con
  --aplicar) llena solo los campos vacios del catalogo con los que existan
  localmente. Sin --aplicar solo muestra lo que haria.

### `src/scripts/importar.ts`

> Carga masiva desde archivos CSV.
>
> Se corre con:
>   npm run importar -- <tipo> <archivo.csv>            (revisa, no escribe)
>   npm run importar -- <tipo> <archivo.csv> --aplicar  (escribe)
>
> Tipos: municipios | terceros | vehiculos | conductores | remolques | rutas
>
> Por defecto NO escribe nada: valida todo el archivo y muestra el informe.
> Con 600 terceros, descubrir los errores uno por uno a medida que fallan es
> insoportable; asi se ven todos de una vez, se corrige el archivo y se aplica.
>
> Es idempotente: las filas que ya existen se saltan, no se duplican.

- **`leerCsv(contenido)`** · _función_
  Lee un CSV sin dependencias externas.

  Contempla lo que de verdad sale de un Excel colombiano: separador ; o ,
  (se detecta solo), comillas dobles con comas adentro, comillas escapadas
  duplicadas, BOM al inicio y saltos de linea de Windows.

- **`leerArchivo(ruta)`** · _función_
  Los archivos guardados desde Excel como "CSV (delimitado por comas)" salen en
  Windows-1252 y las tildes llegan rotas. Se detecta y se reinterpreta.

- **`Informe`** · _clase_
  Resultado de validar o importar un CSV: problemas por fila (errores que
  impiden importar y avisos que no) y contadores de nuevos, existentes y
  actualizados.

  - **`Informe.error(fila, mensaje)`** · _método_
    Registra un error grave en una fila (impide aplicar).

  - **`Informe.aviso(fila, mensaje)`** · _método_
    Registra un aviso en una fila (no impide aplicar).

- **`validarIdentificacion(inf, nFila, tipo, numero, etiqueta)`** · _función_
  Valida un numero de identificacion: obligatorio y solo digitos (error si
  no); un tipo poco comun solo genera aviso. true si se puede usar.

- **`limpioTexto(valor)`** · _función_
  Texto recortado; vacio -> null.

- **`numeroOpcional(valor)`** · _función_
  Numero escrito como en Excel colombiano (punto de miles, coma decimal) ->
  number; vacio o invalido -> null.

- **`fechaOpcional(inf, nFila, valor, campo)`** · _función_
  Fecha AAAA-MM-DD o DD/MM/AAAA (como sale de Excel) -> Date. Vacia -> null;
  ilegible -> null y un error en el informe.

- **`main()`** · _función_
  Punto de entrada: npm run importar -- <tipo> <archivo.csv> [--aplicar]
  [--actualizar]. Valida todo el archivo y muestra el informe; solo escribe
  con --aplicar. --actualizar refresca fechas de documentos de conductores y
  vehiculos que ya existen.

### `src/scripts/probar-correo.ts`

> Prueba la configuracion de correo del .env.
>
>   npm run probar-correo                     (solo verifica conexion y clave)
>   npm run probar-correo -- destino@x.com    (ademas envia un correo de prueba)

- **`main()`** · _función_
  Punto de entrada: verifica conexion y credenciales SMTP y, si se pasa un
  correo de destino, envia un correo de prueba.

### `src/scripts/respaldo.ts`

> Respaldo de la base de datos: un volcado comprimido (.sql.gz) por corrida.
>
> Uso:  npm run respaldo
>
> Pensado para correr una vez al dia con el Programador de tareas de Windows
> (ver docs/DESPLIEGUE.md). Guarda en RESPALDO_DIR (por defecto ../respaldos,
> fuera del repo) y borra los respaldos con mas de RESPALDO_DIAS dias
> (30 por defecto).
>
> La contrasena de la base va por la variable MYSQL_PWD y no en la linea de
> comandos, donde cualquiera que liste los procesos la veria.
>
> Para restaurar:  descomprimir el .gz y luego
>   mysql -u root -p rndc_tms < rndc_tms-AAAA-MM-DD_HHMM.sql

- **`rutaMysqldump()`** · _función_
  mysqldump del PATH, o el de XAMPP si no esta en el PATH.

- **`marcaDeTiempo(d)`** · _función_
  "AAAA-MM-DD_HHMM" de la fecha, para el nombre del archivo de respaldo.

- **`main()`** · _función_
  Punto de entrada: corre mysqldump (copia consistente sin bloquear tablas),
  lo comprime en .sql.gz (primero como .parcial y luego lo renombra) y borra
  los respaldos mas viejos que RESPALDO_DIAS.

### `src/scripts/verificar-rndc.ts`

> Verificacion previa contra el RNDC.
>
> Se corre con:  npm run verificar
>
> Comprueba, en orden, lo que tiene que estar bien ANTES de intentar expedir un
> documento. Cada paso que falla se explica en vez de dejar un error suelto.
>
> No escribe nada: solo hace consultas de lectura.

- **`titulo(texto)`** · _función_
  Imprime un titulo de seccion entre lineas.

- **`ok(texto)`** · _función_
  Imprime un paso correcto: [OK].

- **`falla(texto)`** · _función_
  Imprime un paso fallido: [FALLA].

- **`nota(texto)`** · _función_
  Imprime una linea de explicacion debajo de un paso.

- **`main()`** · _función_
  Punto de entrada: verifica en orden (1) la configuracion local y las
  credenciales, (2) los vehiculos de la base, (3) la conexion con el RNDC y
  (4) el estado de las placas en el RNA, y muestra un resumen. Solo lectura.

### `src/seed.ts`

> Datos de ejemplo para desarrollo (npm run seed). No crea nada en el RNDC.

- **`main()`** · _función_
  Carga datos de EJEMPLO para desarrollo (vehiculo ABC123, conductor,
  cliente, plantilla...). Si ya se cargaron, no los duplica.

### `src/seguimiento.ts`

> Seguimiento despues del descargue y cartera.
>
> Toma las filas del cuadro pagos (src/cuadro.ts) y responde tres preguntas:
>
> 1. Papeles: ¿de que viajes ya descargados hay que perseguir los papeles?
>    Desde el dia del descargue hay que comunicarse con el conductor todos
>    los dias hasta que los papeles queden listos para facturar.
> 2. Por facturar: viajes con los papeles listos y sin factura, o facturados
>    sin numero o fecha (sin fecha no se sabe cuando vence).
> 3. Cartera: facturas con numero y fecha que el cliente aun no paga (sin
>    "fecha pago factura"), con su vencimiento ("fecha pago cliente", o si no
>    esta, fecha de factura + dias de credito del cliente), las gestiones de
>    cobro y la fecha en que el cliente prometio pagar. Avisa desde que pasa
>    el vencimiento: hay que llamar y cobrar.
>
> Todas las alertas se activan cada dia: lo pendiente avisa todos los dias
> hasta que alguien lo atiende ese dia (registra el seguimiento de los
> papeles o una gestion de cobro); al dia siguiente vuelve a avisar. Lo
> pendiente de facturar avisa todos los dias hasta que se factura.
>
> Las alertas se calculan con funciones puras (alertaPapeles, agruparCartera,
> alertasDe) para poder probarlas sin base de datos.

- **`diasEntre(desde, hasta)`** · _función_
  Dias de `desde` a `hasta` ("AAAA-MM-DD"); negativo si `hasta` es anterior.

- **`diaColombia(iso)`** · _función_
  Dia en Colombia ("AAAA-MM-DD") de un instante ISO.

- **`sinFactura(f)`** · _función_
  Viaje que aun no tiene factura (ni marcada ni con numero) y no esta anulado.

- **`descargo(f, hoy)`** · _función_
  El viaje ya descargo: paso la fecha de descargue o los papeles ya salieron de "en ruta".

- **`alertaPapeles(f, hoy, desde)`** · _función_
  Alerta de papeles de un viaje descargado que aun no esta listo para
  facturar, o null si no hay nada que hacer.

  - Todos los clientes, desde el dia del descargue: si nadie ha preguntado
    hoy, hay que comunicarse con el conductor. Registrar el seguimiento la
    apaga hasta el dia siguiente.
  - Urgente si faltan papeles o si ya pasaron DIAS_PAPELES_DEMORADOS dias.
  - Sin alerta si el viaje cargo antes de `desde` (ver SEGUIMIENTO_DESDE).

- **`alertaFacturacion(f, hoy, desde)`** · _función_
  Alerta de facturacion, todos los dias hasta que se factura: papeles listos
  y sin factura (urgente desde DIAS_PAPELES_DEMORADOS dias), o facturado sin numero o sin fecha (no puede entrar a cartera).
  Sin alerta si el viaje cargo antes de `desde`.

- **`alertaFactura(vence, compromisoPago, hoy, gestionHoy)`** · _función_
  Alerta de cobro de una factura sin pagar: empieza cuando pasa la fecha pago
  cliente (el vencimiento) o la fecha en que el cliente prometio pagar, y
  avisa todos los dias hasta que se registra la fecha pago factura. El dia en
  que ya se anoto una gestion de cobro (`gestionHoy`) no avisa. Antes del
  vencimiento no hay alerta.

- **`repartirPorDueno(placas, neto)`** · _función_
  Reparte lo que debe el cliente (neto) entre los duenos de las placas, en
  proporcion al valor de cada placa: si hubo anticipo del cliente, cada dueno
  carga su parte. Los redondeos se ajustan en el grupo mas grande para que la
  suma de exactamente el neto.

- **`agruparCartera(filas, plazos, gestiones, hoy, extras)`** · _función_
  Agrupa por factura (numero + empresa) los viajes facturados con numero y
  fecha que aun no se han cobrado, les suma los saldos sin viaje pendientes,
  resta el anticipo del cliente de cada factura y calcula vencimiento y
  alerta. Las facturas mas vencidas primero.

- **`carteraDeDueno(facturas, grupo)`** · _función_
  Solo la parte de un dueno: las facturas con vehiculos suyos, cada una con
  lo que le toca (porDueno) como valor. Asi los totales y las edades de
  cartera quedan por dueno.

- **`resumirPorCliente(facturas)`** · _función_
  Totales por cliente de cobro con edades de vencimiento (0, 1-30, 31-60,
  61-90, +90 dias). Las variantes de un cliente (CARTONES AMERICA URBANO,
  RECONOCIDO...) quedan en el mismo cliente, con sus conceptos.

- **`alertaFacturaBomba(r, hoy)`** · _función_
  Alerta de una factura de la bomba sin pagar: urgente si ya vencio,
  atencion si vence en los proximos DIAS_AVISO_BOMBA dias. Sin vencimiento
  escrito o ya pagada, no avisa.

- **`alertaAnticipoEmpresa(f, desde)`** · _función_
  Alerta del anticipo que da la empresa (clientes del Zorro, Aburra Limpio y
  viajes sin manifiesto): avisa todos los dias hasta que se escriben el valor
  y la fecha en que se pago. El del Zorro lo abona a la bomba; el de los demas
  nos lo pagan a nosotros. Sin alerta antes de `desde`.

- **`resumirAnticiposEmpresa(filas)`** · _función_
  Resumen por cliente de los viajes con anticipo de la empresa (mas por cobrar primero).

- **`alertaContingencia(v)`** · _función_
  Alerta de un manifiesto impreso de contingencia (siempre urgente): sin
  radicado hay que reintentar expedirlo en el RNDC; con radicado, imprimir el
  oficial. Se quita sola cuando se imprime el oficial.

- **`fechaTexto(f)`** · _función_
  "2026-10-05" -> "05/10/2026".

- **`pesosTexto(n)`** · _función_
  1234567 -> "$1.234.567".

- **`alertasCarteraPorEmpresa(facturas)`** · _función_
  Alertas de cartera, una por cliente de cobro: junta sus facturas vencidas
  (o con el pago prometido incumplido) citando numero, concepto, fecha,
  vencimiento y valor, y suma el total. Si es una sola factura, la alerta
  abre esa factura.

- **`alertasDe(filas, facturas, hoy, desde)`** · _función_
  Todas las alertas: urgentes primero, luego papeles, facturacion y cartera.

- **`llaveFactura(numero, empresa)`** · _función_
  Llave de una factura en los mapas: "numero|empresa" (el mismo numero puede repetirse entre clientes).

- **`seguimiento`** · _módulo_
  Lectura y escritura del seguimiento de papeles y de la cartera.

  - **`seguimiento.papeles()`** · _método_
    Viajes sin factura (descargados o en ruta) con su alerta de papeles y de
    facturacion: lo que se persigue antes de facturar.

  - **`seguimiento.registrarPapeles(id, d, usuarioId)`** · _método_
    Registra lo que se supo de los papeles (al llamar al conductor): donde
    estan, quien los tiene, si estan completos y que falta. Marca la hora y el
    usuario (asi la alerta de "comunicarse" se apaga por hoy) y deja una nota
    en el viaje con lo registrado.

  - **`seguimiento.plazos()`** · _método_
    Plazos de credito y contactos de cobro de los clientes.

  - **`seguimiento.guardarPlazo(d)`** · _método_
    Crea o cambia el plazo y el contacto de cobro de un cliente.

  - **`seguimiento.ultimasGestiones()`** · _método_
    Ultima gestion de cobro de cada factura, por llave "numero|empresa".

  - **`seguimiento.cartera(dueno)`** · _método_
    Cartera completa: facturas por cobrar con vencimiento y alerta, totales
    por cliente, y los viajes facturados que no tienen numero o fecha (no
    pueden calcular su vencimiento).

  - **`seguimiento.saldosPendientes()`** · _método_
    Saldos sin viaje que el cliente aun no paga, con su valor por placa y el
    dueno de cada placa (segun el vehiculo del catalogo; si no esta, tercero).

  - **`seguimiento.anticiposCliente()`** · _método_
    Anticipo del cliente de cada factura, por llave "numero|empresa".

  - **`seguimiento.guardarAnticipoCliente(d)`** · _método_
    Guarda el anticipo (o abono) que el cliente ya pago de una factura; 0 o
    vacio lo quita. Se resta de lo que debe en la cartera.

  - **`seguimiento.anticiposEmpresas()`** · _método_
    Anticipos que dan las empresas: los viajes que lo llevan (o a los que se
    les escribio), con su estado, y el resumen por cliente para cobrar.

  - **`seguimiento.pagarAnticiposEmpresa(d)`** · _método_
    Registra que la empresa pago el anticipo de varios viajes ({ ids, fecha }).
    Solo los que tienen valor escrito y aun no tienen fecha de pago.

  - **`seguimiento.gestiones(facturaNumero, empresa)`** · _método_
    Gestiones de cobro de una factura, la mas reciente primero.

  - **`seguimiento.agregarGestion(d, usuarioId)`** · _método_
    Anota una gestion de cobro (llamada, correo) y, si la hay, la fecha que prometio el cliente.

  - **`seguimiento.registrarPago(d)`** · _método_
    Registra el pago de una factura: pone la fecha de pago en todos sus
    viajes que aun no la tenian. Devuelve cuantos viajes quedaron pagados.

  - **`seguimiento.alertas()`** · _método_
    Alertas de la campana de seguimiento: papeles, facturacion y cartera.

- **`mapearGestion(r)`** · _función_
  Fila de cartera_gestiones -> GestionCobro.

### `src/tarifasFlete.ts`

> Deducir el flete de un viaje del cuadro con la matriz de fletes, apenas el
> viaje entra al cuadro (con o sin manifiesto), para que el valor este para
> los reportes de fin de mes aunque se demore la facturacion. El envio a
> facturacion lo puede reemplazar despues.
>
> Solo se pone solo cuando es exacto: una tarifa del cliente claramente mejor
> que las demas (por destino, origen, producto, tipo de carro y urbano), con
> valor, y sin tarifas de varios clientes o ciudades adicionales (Tolua,
> Porcelatino: no se sabe cuantos clientes lleva). Si no es exacto, el viaje
> queda manual y se muestran las tarifas posibles para elegir.

- **`normalizarNombre(s)`** · _función_
  Nombre comparable: mayusculas, sin tildes, sin puntuacion y sin sufijos legales.

- **`palabras(s)`** · _función_
  Palabras del nombre, sin la "S" final para que RECICLAJE y RECICLAJES coincidan.

- **`parecido(empresa, tarifa)`** · _función_
  Que tanto se parece una tarifa al cliente (0 = nada): 3 = igual, 2 = uno
  contiene al otro, 1 = comparten la mayoria de palabras (sin las de enlace
  ni las letras sueltas). Contra la razon social y contra el nombre.

- **`esDeVarios(t)`** · _función_
  La tarifa es para varios clientes o ciudades adicionales (no se sabe solo con el viaje).

- **`puntajeTarifa(tarifa, v)`** · _función_
  Puntaje de una tarifa para un viaje (mas alto = mejor): cada palabra de su
  nombre (sin las del cliente) que esta en el destino (+2), el origen (+1) o
  el producto (+1,5); las que no estan en ninguno restan un poco. Mas el tipo
  de carro (MULA / VOLVO), urbano, y abajo las de reconocidos de cartulina y
  las de varios clientes.

- **`ciudadesDe(v)`** · _función_
  Primera palabra del origen y del destino del viaje ("YUMBO", "DUITAMA").

- **`nombraCiudad(tarifa, ciudad)`** · _función_
  true si el nombre de la tarifa (con las abreviaturas resueltas) trae esa ciudad.

- **`nombraDestino(tarifa, v)`** · _función_
  true si el nombre de la tarifa trae la ciudad de destino del viaje.

- **`nombraOrigenSinDestino(tarifa, v)`** · _función_
  true si el nombre de la tarifa trae la ciudad de origen del viaje pero no la de destino.

- **`deducirTarifa(v, tarifas)`** · _función_
  Deduce la tarifa de un viaje. Exacta solo si: el cliente tiene tarifas, la
  mejor tiene valor, ninguna otra queda a menos de medio punto, y el cliente no
  tiene tarifas de varios clientes o ciudades adicionales. Si no, las
  posibles: la mejor, las que quedan cerca y las de varios clientes.

- **`fleteDeTarifa(t, pesoKg)`** · _función_
  Lo que va en el viaje con una tarifa: tipo de flete, tarifa por kilo o fijo, adicional y peso a facturar.

- **`invalidarTarifas()`** · _función_
  La matriz cambio: se vuelve a leer y a deducir.

- **`deducirConMatriz(v)`** · _función_
  Deduce la tarifa de un viaje con la matriz en memoria y recuerda el
  resultado: el mismo cliente, ruta, producto, carro y urbano dan siempre lo
  mismo mientras la matriz no cambie.

- **`cargarTarifas()`** · _función_
  La matriz de fletes para deducir (sin las observaciones), de memoria si ya se leyo.

### `src/terceros.ts`

> Pago a terceros: lo que se le paga al dueno de un vehiculo tercero por cada
> viaje. Reemplaza la "Matriz Terceros" de Excel (una hoja por tercero).
>
> Por viaje se pacta el valor con el tercero (por tonelada o fijo). De ahi se
> descuentan los anticipos: el efectivo y el combustible de la bomba (los de
> cuadro_anticipos) y el adicional por transferencia. Las retenciones
> (retefuente 1 %, ICA, FOPAT 0,1 % y la poliza de 3.000) se muestran siempre;
> solo se descuentan si se marca el viaje (aplicaDescuentosTercero), porque en
> la matriz casi nunca se restan.
>
> Se le paga el viernes: si descargo lunes o martes, el de esa semana; de
> miercoles en adelante, el de la semana siguiente. La fecha se puede cambiar
> a mano (fechaPagoTerceroProgramada). Ya pagado, la fecha real es
> fechaPagoSaldo.

- **`icaSugerido(empresa)`** · _función_
  ICA por mil que se sugiere para un cliente (0 si no esta en la lista: RECOLAM, APROREC...).

- **`viernesDePago(fechaDescargue)`** · _función_
  Viernes en que se le paga a un tercero ("AAAA-MM-DD"): lunes o martes ->
  el viernes de esa semana; miercoles a domingo -> el de la semana siguiente.

- **`liquidar(f, bomba, cobraPoliza)`** · _función_
  Calcula lo que se le paga al tercero por un viaje (exportado para las
  pruebas). cobraPoliza: false en las demas filas de un manifiesto con varios
  clientes (la poliza va solo en una, ver filasConPoliza).

- **`pactado(f)`** · _función_
  true si la fila ya tiene pactado lo que se le paga al tercero.

- **`filasConPoliza(filas)`** · _función_
  Filas (ids) que llevan la poliza RCE: una por manifiesto, la primera ya
  pactada (la de menor id); las filas sin manifiesto la llevan cada una.

- **`estadoPagoTercero(f, l, hoy)`** · _función_
  Estado del pago de un viaje al tercero (ver EstadoPagoTercero).

- **`resumirTerceros(viajes)`** · _función_
  Agrupa los viajes por tercero (exportado para las pruebas). Los que mas se deben primero.

- **`leerNombres(lista)`** · _función_
  Normaliza la lista que llega del navegador (nombres recortados, placas sin guion).

- **`terceros`** · _módulo_
  Repositorio del pago a terceros.

  - **`terceros.listar(filasCuadro)`** · _método_
    Viajes de vehiculos terceros (flota TERCERO y sin socio dueno), sin los
    reconocidos de Cartones America (no se le pagan al tercero), no
    anulados, con su liquidacion, y el resumen por tercero.

  - **`terceros.proponerNombres(lista)`** · _método_
    Propone a que vehiculos terceros (sin socio dueno) se le pone cada nombre
    de la matriz: por placa y, si ninguna placa coincide, por la cedula del
    tenedor. Un vehiculo va con un solo nombre (gana la placa). No guarda.

  - **`terceros.importarNombres(lista)`** · _método_
    Pone el nombre de la matriz como titular de los vehiculos propuestos. Devuelve cuantos cambio.

  - **`terceros.pagar(d)`** · _método_
    Registra el pago al tercero de varios viajes ({ ids, fecha, cuentaCobro? }):
    pone la fecha de pago (y el numero de la cuenta de cobro, si se escribe y
    el viaje no lo tiene) en los que aun no estaban pagados.

<!-- REFERENCIA:FIN -->
