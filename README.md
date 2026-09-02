# Backend - Modulo RNDC (Especificacion tecnica)

Especificacion tecnica del backend del modulo de remesas y manifiestos del RNDC.
Para instrucciones rapidas de instalacion ver el `README.md` en la raiz del
proyecto; este documento cubre el detalle interno: arquitectura, modelo de
datos, contrato de la API y el flujo de integracion con el RNDC.

## 1. Stack tecnico

| Capa | Tecnologia | Version |
|---|---|---|
| Runtime | Node.js | 20.x o superior |
| Lenguaje | TypeScript | 5.5 |
| Framework HTTP | Express | 4.19 |
| Base de datos | MySQL / MariaDB | via `mysql2` 3.x (promise API) |
| Cliente SOAP (RNDC) | `soap` (npm) | 1.1.x |
| CORS | `cors` (npm) | 2.8.x |
| Entorno de desarrollo | `ts-node-dev` (recarga en caliente) | 2.x |

No hay ORM: el acceso a datos es SQL explicito y tipado, encapsulado en un
unico archivo (`src/repo.ts`) para que sea facil de migrar a otro motor
(Postgres, MySQL) o a un ORM (Prisma, TypeORM) sin tocar rutas ni logica de
negocio — ver seccion 8.

## 2. Estructura de carpetas

```
backend/
├── src/
│   ├── index.ts              Punto de entrada: crea el servidor Express
│   ├── config.ts             Lee variables de entorno (.env)
│   ├── db.ts                 Pool de conexiones MySQL + creacion del esquema (DDL)
│   ├── repo.ts                Capa de acceso a datos (repositorio tipado)
│   ├── seed.ts                Script para precargar datos de prueba
│   ├── rndc/
│   │   ├── builders.ts        Arma el XML que exige el Web Service del RNDC
│   │   └── client.ts          Cliente SOAP: envia el XML y parsea la respuesta
│   └── routes/
│       ├── catalogo.ts        CRUD de vehiculos, conductores, terceros, rutas, plantillas
│       └── despacho.ts        El "boton unico": valida, crea remesa, crea manifiesto
├── package.json
├── tsconfig.json
└── .env.example
```

## 3. Variables de entorno

Definidas en `.env` (copiar desde `.env.example`):

| Variable | Descripcion | Valor por defecto |
|---|---|---|
| `DB_HOST` | Host del servidor MySQL/MariaDB | `localhost` |
| `DB_PORT` | Puerto del servidor MySQL/MariaDB | `3306` |
| `DB_USER` | Usuario de la base de datos | `rndc_app` |
| `DB_PASSWORD` | Contrasena del usuario de la base de datos | *(sin valor por defecto)* |
| `DB_NAME` | Nombre de la base de datos | `rndc_tms` |
| `PORT` | Puerto del servidor Express | `3000` |
| `CORS_ORIGIN` | Origen permitido para CORS (URL del frontend) | `http://localhost:4200` |
| `RNDC_WSDL_URL` | URL del WSDL del Web Service del RNDC | endpoint publico del Ministerio |
| `RNDC_USUARIO` | Usuario de acceso al RNDC | *(vacio hasta tener credenciales)* |
| `RNDC_PASSWORD` | Contrasena de acceso al RNDC | *(vacio)* |
| `RNDC_EMPRESA_NIT` | NIT de la empresa transportadora | *(vacio)* |
| `RNDC_SIMULAR` | Si es `true`, no llama al RNDC real — simula una respuesta exitosa | `true` |

## 4. Modelo de datos

El esquema completo (DDL) vive en `src/db.ts` y se crea automaticamente al
arrancar el servidor si las tablas no existen (`CREATE TABLE IF NOT EXISTS`).
La base de datos (`rndc_tms` por defecto) debe existir de antemano en tu
servidor MySQL/MariaDB — ver el `README.md` de la raiz para el comando de
creacion. Las claves foraneas entre tablas (`plantillas_viaje` -> `terceros` y
`rutas`; `viajes` -> `plantillas_viaje`, `vehiculos`, `conductores`) se crean
como `CONSTRAINT ... FOREIGN KEY` de MySQL.

### `vehiculos`
| Campo | Tipo | Notas |
|---|---|---|
| id | INT PK | autoincremental |
| placa | TEXT UNIQUE | |
| placaRemolque | TEXT | nullable |
| marca | TEXT | nullable |
| configuracion | TEXT | **codigo** RNDC de configuracion (`CODCONFIGURACIONUNIDADCARGA`), no texto libre |
| capacidadKg | DOUBLE | nullable |
| propietarioNit | TEXT | nullable — NIT del propietario si es afiliado (uso interno) |
| fechaVencSoat | DATE | nullable |
| fechaVencTecnomecanica | DATE | nullable |
| activo | TINYINT(1) | default 1 |
| codTipoIdTenedor | VARCHAR(2) | default `N` — tipo de ID del tenedor/propietario ante el RNDC |
| numIdTenedor | TEXT | nullable |
| codTipoCarroceria | VARCHAR(5) | default `0` — codigo RNDC |
| pesoVehiculoVacio | DOUBLE | nullable — `PESOVEHICULOVACIO` |

### `conductores`
| Campo | Tipo | Notas |
|---|---|---|
| id | INT PK | |
| cedula | TEXT UNIQUE | |
| nombre | TEXT | |
| licencia | TEXT | nullable |
| categoriaLicencia | TEXT | nullable |
| fechaVencLicencia | DATE | nullable |
| activo | TINYINT(1) | default 1 |
| codTipoId | VARCHAR(2) | default `C` (Cedula) — `CODIDCONDUCTOR` |

### `terceros`
Clientes: remitente, destinatario o contratante.

| Campo | Tipo | Notas |
|---|---|---|
| id | INT PK | |
| nit | TEXT | |
| nombre | TEXT | |
| direccion | TEXT | nullable |
| ciudad | TEXT | nullable |
| telefono | TEXT | nullable |
| rol | TEXT | `REMITENTE` / `DESTINATARIO` / `CONTRATANTE` (informativo, uso interno) |
| codTipoId | VARCHAR(2) | default `N` (NIT) — `CODTIPOIDREMITENTE`/`...DESTINATARIO`/`...PROPIETARIO` segun el rol que cumpla en cada plantilla |
| codSede | VARCHAR(10) | default `0` — `CODSEDEREMITENTE`/etc. |

### `rutas`
| Campo | Tipo | Notas |
|---|---|---|
| id | INT PK | |
| ciudadOrigen | TEXT | |
| ciudadDestino | TEXT | |
| codigoOrigenRndc | TEXT | nullable — **codigo de municipio RNDC de 8 digitos** (ej. Bogota D.C.=`11001000`), no DIVIPOLA de 5 digitos |
| codigoDestinoRndc | TEXT | nullable |
| distanciaKm | DOUBLE | nullable |

### `plantillas_viaje`
El "combo" precargado: todo lo fijo y repetitivo de un cliente/ruta.

| Campo | Tipo | Notas |
|---|---|---|
| id | INT PK | |
| nombre | TEXT | |
| contratanteId | INTEGER FK -> terceros.id | tambien usado como "propietario de la carga" y "titular del manifiesto" (ver nota en `builders.ts`) |
| remitenteId | INTEGER FK -> terceros.id | |
| destinatarioId | INTEGER FK -> terceros.id | |
| rutaId | INTEGER FK -> rutas.id | |
| tipoMercancia | TEXT | nullable — usado como `DESCRIPCIONCORTAPRODUCTO` (texto libre) |
| naturalezaCarga | TEXT | nullable, uso interno (no confundir con `codNaturalezaCarga`) |
| unidadMedida | TEXT | nullable, uso interno |
| valorFleteBase | DOUBLE | nullable |
| observaciones | TEXT | nullable |
| activa | TINYINT(1) | default 1 |
| codOperacionTransporte | VARCHAR(2) | default `G` — `CODOPERACIONTRANSPORTE` |
| codNaturalezaCarga | VARCHAR(5) | default `1` — `CODNATURALEZACARGA` (codigo de catalogo) |
| codUnidadMedida | VARCHAR(5) | default `1` — `UNIDADMEDIDACAPACIDAD` (codigo de catalogo) |
| codTipoEmpaque | VARCHAR(5) | default `0` — `CODTIPOEMPAQUE` (codigo de catalogo) |
| codMercancia | VARCHAR(15) | nullable — `MERCANCIAREMESA` (codigo de producto) |
| horasPactoCargue | INT | default 1 |
| minutosPactoCargue | INT | default 0 |
| horasPactoDescargue | INT | default 1 |
| minutosPactoDescargue | INT | default 0 |

### `viajes`
El despacho real: hereda de la plantilla + los datos variables de esa noche.

| Campo | Tipo | Notas |
|---|---|---|
| id | INT PK | |
| plantillaId | INTEGER FK | |
| vehiculoId | INTEGER FK | |
| conductorId | INTEGER FK | |
| fechaHoraCargue | DATETIME | |
| pesoReal | DOUBLE | nullable |
| cantidadReal | DOUBLE | nullable |
| valorFleteReal | DOUBLE | nullable — si es null, se usa `valorFleteBase` de la plantilla |
| estado | TEXT | ver seccion 6 (maquina de estados) |
| numeroRemesaRndc | TEXT | nullable — el **radicado** (`ingresoid`) que devuelve el RNDC al crear la remesa (solo trazabilidad) |
| numeroManifiestoRndc | TEXT | nullable — el radicado que devuelve el RNDC al crear el manifiesto |
| consecutivoRemesa | TEXT | generado automaticamente (`REM{id}`) — es el `CONSECUTIVOREMESA` **propio** que el manifiesto usa para referenciar la remesa |
| consecutivoManifiesto | TEXT | generado automaticamente (`MAN{id}`) — es el `NUMMANIFIESTOCARGA` propio |
| mec | TEXT | nullable |
| codigoSeguridadQr | TEXT | nullable |
| mensajeError | TEXT | nullable — detalle si algo fallo |
| fechaCreacion | DATETIME | default CURRENT_TIMESTAMP |

## 5. Contrato de la API REST

Base URL: `http://localhost:3000/api`

### Salud
```
GET /health
200 -> { "ok": true, "rndcSimulado": true }
```

### Catalogo

| Metodo | Ruta | Body (POST) | Respuesta |
|---|---|---|---|
| GET | `/catalogo/vehiculos` | — | `Vehiculo[]` |
| POST | `/catalogo/vehiculos` | `{ placa, placaRemolque?, marca?, configuracion?, capacidadKg?, propietarioNit?, fechaVencSoat?, fechaVencTecnomecanica? }` | `201 Vehiculo` |
| GET | `/catalogo/conductores` | — | `Conductor[]` |
| POST | `/catalogo/conductores` | `{ cedula, nombre, licencia?, categoriaLicencia?, fechaVencLicencia? }` | `201 Conductor` |
| GET | `/catalogo/terceros` | — | `Tercero[]` |
| POST | `/catalogo/terceros` | `{ nit, nombre, direccion?, ciudad?, telefono?, rol? }` | `201 Tercero` |
| GET | `/catalogo/rutas` | — | `Ruta[]` |
| POST | `/catalogo/rutas` | `{ ciudadOrigen, ciudadDestino, codigoOrigenRndc?, codigoDestinoRndc?, distanciaKm? }` | `201 Ruta` |
| GET | `/catalogo/plantillas` | — | `PlantillaViaje[]` (con `contratante`, `remitente`, `destinatario`, `ruta` anidados) |
| POST | `/catalogo/plantillas` | `{ nombre, contratanteId, remitenteId, destinatarioId, rutaId, tipoMercancia?, naturalezaCarga?, unidadMedida?, valorFleteBase?, observaciones? }` | `201 PlantillaViaje` |

### Despacho (el endpoint critico)

```
POST /despacho
Body: {
  plantillaId: number,
  vehiculoId: number,
  conductorId: number,
  fechaHoraCargue: string,   // ISO 8601, ej "2026-09-01T02:30:00"
  pesoReal?: number,
  cantidadReal?: number,
  valorFleteReal?: number
}
```

Respuestas posibles:

| Codigo | Cuando ocurre | Body |
|---|---|---|
| `201` | Remesa y manifiesto creados exitosamente | `Viaje` con `estado: "CONFIRMADO"`, `numeroRemesaRndc` y `numeroManifiestoRndc` llenos |
| `404` | Plantilla, vehiculo o conductor no existen | `{ error: string }` |
| `422` | Validacion de documentos fallo, o el RNDC rechazo la remesa/manifiesto | `Viaje` con `estado` de error y `mensajeError` |
| `502` | Fallo de comunicacion (red/timeout) con el RNDC | `Viaje` con `estado` de error y `mensajeError` |

```
GET /despacho/historial
200 -> Viaje[]   (ultimos 100, mas reciente primero)
```

## 6. Maquina de estados del viaje

```
PENDIENTE (al crearse, antes de validar)
   │
   ├─ falla validacion de documentos ──────────► VALIDACION_ERROR (fin)
   │
   ├─ ok ─► intenta crear REMESA
   │           │
   │           ├─ falla (red o rechazo RNDC) ──► REMESA_ERROR (fin)
   │           │
   │           └─ ok ─► intenta crear MANIFIESTO
   │                       │
   │                       ├─ falla ───────────► MANIFIESTO_ERROR (remesa SI quedo creada)
   │                       │
   │                       └─ ok ──────────────► CONFIRMADO (fin exitoso)
```

Un viaje en `MANIFIESTO_ERROR` ya tiene `numeroRemesaRndc` guardado — la
remesa no se duplica si se reintenta manualmente (el reintento automatico del
solo-manifiesto no esta implementado todavia, ver seccion 9).

## 7. Integracion con el RNDC

**Estado: verificado contra el manual oficial** ("GUIA Uso de Web Service en el
RNDC - V5", Ministerio de Transporte, mayo 2026). La primera version de este
motor tenia varios errores estructurales que se corrigieron tras comparar
campo por campo contra los ejemplos reales del manual:

| Error encontrado | Correccion |
|---|---|
| IDs de proceso invertidos (`4`=remesa, `2`=manifiesto) | Corregido: `3`=Remesa, `4`=Manifiesto (confirmado en manual, pag. 9-10) |
| El manifiesto referenciaba la remesa con el radicado (`ingresoid`) devuelto por el RNDC | Corregido: se referencia por `CONSECUTIVOREMESA`, un consecutivo **propio** de la empresa, dentro del bloque `<REMESASMAN>` (pag. 15-16) |
| No se generaba ningun `CONSECUTIVOREMESA` ni `NUMMANIFIESTOCARGA` | Corregido: se generan automaticamente a partir del id interno del viaje (`REM{id}`, `MAN{id}`) |
| Encoding `UTF-8` en el XML | Corregido a `ISO-8859-1`, tal como usan todos los ejemplos del manual |
| Fecha y hora combinadas en un solo campo | Corregido: campos separados `FECHACITAPACTADACARGUE` (`DD/MM/AAAA`) y `HORACITAPACTADACARGUE` (`HH:MM`) |
| Tags `NITCONTRATANTE`/`NITREMITENTE`/`NITDESTINATARIO` | Corregido a pares `CODTIPOIDxxx` + `NUMIDxxx` + `CODSEDExxx`, tal como exige el diccionario real |
| Ciudad como texto en la remesa | Corregido: el municipio (codigo RNDC de 8 digitos) va en el manifiesto, no en la remesa |

El script usado para esta verificacion (armar el XML real con datos del seed y
compararlo linea por linea contra los ejemplos del manual) ya no forma parte
del repositorio, pero el resultado quedo confirmado: la estructura, nombres de
tags y orden de campos coinciden con los ejemplos de remesa y manifiesto del
manual (pag. 12-16).

### Validaciones previas (sin red)
Antes de gastar una llamada contra el RNDC, `routes/despacho.ts` valida:
- SOAT del vehiculo no vencido
- Tecnomecanica del vehiculo no vencida
- Licencia del conductor no vencida

Pendiente (marcado como `TODO` en el codigo): validacion contra el piso
tarifario SICE-TAC antes de enviar.

### Construccion del XML (`rndc/builders.ts`)
El Web Service del RNDC recibe un unico parametro de texto con un XML de la
forma (confirmada contra el manual, pag. 8):
```xml
<root>
  <acceso><username/><password/></acceso>
  <solicitud><tipo>1</tipo><procesoid/></solicitud>
  <variables><NUMNITEMPRESATRANSPORTE/> ...campos del proceso... </variables>
</root>
```
Hay dos constructores de variables: `construirDatosRemesa()` (procesoid=3) y
`construirDatosManifiesto()` (procesoid=4), mas `construirBloqueRemesasManifiesto()`
que arma el bloque `<REMESASMAN>` que enlaza el manifiesto con sus remesas.

**IDs de proceso** (constantes en `builders.ts`, confirmadas contra el manual):
- `PROCESO_ID_REMESA = "3"` — Expedir Remesa Terrestre de Carga
- `PROCESO_ID_MANIFIESTO = "4"` — Expedir Manifiesto de Carga

### Lo que sigue pendiente de catalogos reales

Varios campos del diccionario son **codigos de catalogo del RNDC**, no texto
libre, y este proyecto los deja con valores placeholder genericos que deben
verificarse antes de produccion consultando "Consultar Maestros" en el portal
del RNDC (pag. 24 del manual):

- `CODNATURALEZACARGA`, `UNIDADMEDIDACAPACIDAD`, `CODTIPOEMPAQUE`, `MERCANCIAREMESA` (configurables por plantilla, con default `1`/`1`/`0`/vacio)
- `CODCONFIGURACIONUNIDADCARGA` y `CODTIPOCARROCERIA` del vehiculo (default `0`)
- `CODMUNICIPIOORIGENMANIFIESTO`/`...DESTINOMANIFIESTO`: codigo de municipio RNDC de 8 digitos (ej. Bogota D.C.=`11001000`, Cali=`76001000`, confirmados en el manual; el resto hay que consultarlos)
- `RETENCIONICAMANIFIESTOCARGA`, `VALORANTICIPOMANIFIESTO`: quedan en `0` hasta que se defina la logica de negocio real de retenciones y anticipos
- El atributo `procesoid="43"` del bloque `<REMESASMAN>` viene tal cual del ejemplo del manual, pero no esta confirmado contra el diccionario completo de errores/procesos — verificar antes de produccion

### Cliente SOAP (`rndc/client.ts`)
- Metodo remoto esperado: `AtenderMensajeRNDC` (WSDL del Ministerio).
- Las 3 URLs oficiales balancean carga por tipo de operacion (pag. 5 del manual):
  `rndcws2.mintransporte.gov.co:8080` (expedir remesas/manifiestos),
  `plc.mintransporte.gov.co:8080` (consultas),
  `rndcws.mintransporte.gov.co:8080` (el resto de procesos). Este proyecto usa
  una sola URL configurable (`RNDC_WSDL_URL`); si se separan las operaciones
  por tipo, ese balanceo habria que implementarlo en `client.ts`.
- Existe tambien un **ambiente de pruebas real** (no solo nuestra simulacion):
  `rndcpruebas.mintransporte.gov.co:8080` (pag. 11). Los radicados de ese
  ambiente son siempre mayores a 900,000,000. Antes de ir a produccion, vale
  la pena probar ahi con las mismas credenciales del ambiente productivo.
- Si `RNDC_SIMULAR=true`: no hace ninguna llamada de red. Devuelve
  `{ ok: true, radicado: "SIMULADO-XXXXX", ... }` de forma sincrona.
- Si `RNDC_SIMULAR=false`: usa la libreria `soap` para conectarse al WSDL real
  y parsea la respuesta XML buscando `ErrorMSG`, `ingresoid`, `MEC`,
  `seguridadqr`.
- **Nota sobre encoding**: el XML se declara como `ISO-8859-1` (tal como exige
  el manual), pero no se verifico si la libreria `soap` transmite el cuerpo de
  la peticion HTTP realmente en esa codificacion de bytes o si lo hace en
  UTF-8 con la declaracion XML simplemente incluida como texto. Esto solo
  importa si tus datos llevan tildes o "ñ"; probar especificamente ese caso
  contra el ambiente de pruebas real antes de asumir que funciona.

### Antes de produccion
Ademas de los catalogos pendientes arriba, verificar:
- El diccionario de datos completo y el diccionario de errores en el portal RNDC (pag. 24-28), usando la herramienta wstest (pag. 19-23) para confirmar cada XML antes de integrarlo.
- El registro previo de terceros (procesoid=11) y vehiculos (procesoid=12) contra el RNDC real — este backend todavia asume que ya existen alla (ver seccion de pendientes).

Contacto oficial: rndc@mintransporte.gov.co / linea 018000 112042.

## 8. Decision de arquitectura: por que no hay ORM

Se penso inicialmente en Prisma, pero en el entorno donde se genero este
proyecto la descarga de sus motores binarios estaba bloqueada por
restricciones de red del sandbox de desarrollo — no es una limitacion del
proyecto en si. Se opto por acceso a datos manual con `mysql2/promise` (que
no requiere binarios nativos) y una capa de repositorio en `src/repo.ts`.

Esa capa expone funciones simples y asincronas (`vehiculos.findMany()`,
`plantillas.create()`, `viajes.update()`, etc.) que son las unicas que el
resto del codigo (rutas) conoce. Si mas adelante se quiere migrar a Prisma,
TypeORM o Sequelize, el cambio queda contenido en `db.ts` + `repo.ts` sin
tocar `routes/` ni `rndc/`.

## 9. Scripts disponibles

| Comando | Que hace |
|---|---|
| `npm run dev` | Arranca el servidor con recarga en caliente (`ts-node-dev`) |
| `npm run build` | Compila TypeScript a `dist/` |
| `npm start` | Corre la version compilada (`dist/index.js`) — usar en produccion |
| `npm run seed` | Precarga un vehiculo, conductor, cliente, ruta y plantilla de ejemplo |

## 10. Pendientes conocidos (fuera del alcance de esta fase)

- Reintento automatico de "solo manifiesto" cuando la remesa ya se creo pero
  el manifiesto fallo (hoy el numero de remesa queda guardado, pero el
  reintento seria manual).
- Validacion del piso tarifario SICE-TAC antes de enviar.
- Registro de vehiculos y terceros contra el RNDC (este backend asume que ya
  existen alla).
- Autenticacion/autorizacion de la API (hoy no tiene, pensado para uso interno
  en red local o detras de un proxy).
- Paginacion en `/despacho/historial` (hoy trae los ultimos 100 sin filtros).
- Los modulos de documentos, cartera, cuentas por pagar a afiliados,
  estacion de combustible y liquidacion de rentabilidad ya tienen su modelo de
  datos disenado (ver diagramas ER de la conversacion) pero no estan
  implementados en este codigo — son la Fase 2 en adelante.
