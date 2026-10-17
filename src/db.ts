/**
 * Conexion a MySQL y esquema de la base.
 *
 * - `pool`: conexiones compartidas (mysql2, en UTC: timezone "Z").
 * - `conCandado`: ejecuta una funcion con un candado de MySQL (GET_LOCK), por
 *   ejemplo para que dos despachos no tomen el mismo consecutivo.
 * - `initSchema`: crea las tablas y agrega las columnas que falten al arrancar.
 */
import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import "dotenv/config";
import { PLACAS_POR_DUENO } from "./duenos";

export const pool = mysql.createPool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? "root",
  password: process.env.DB_PASSWORD ?? "",
  database: process.env.DB_NAME ?? "rndc_tms",
  waitForConnections: true,
  connectionLimit: 10,
  // Las fechas se guardan y se leen SIEMPRE en UTC, sin importar la zona
  // horaria del servidor MySQL ni la del sistema operativo. La conversion a
  // hora de Colombia ocurre en un solo lugar (rndc/builders.ts) al momento de
  // formatear para el RNDC. Sin esto, escribir con toISOString() y leer con
  // mysql2 daba corrimientos de horas en los cargues de madrugada.
  timezone: "Z",
});

/**
 * Ejecuta `fn` con un candado de MySQL (GET_LOCK) tomado: si otra peticion
 * tiene el mismo candado, esta espera a que lo suelte.
 *
 * Se usa para la numeracion del despacho: elegir el siguiente consecutivo y
 * guardar el viaje tiene que ser un solo paso. Sin el candado, dos personas
 * que despachan al mismo tiempo leen el mismo "ultimo numero" y ambas toman
 * el siguiente. El candado vive en MySQL (no en memoria), asi que sirve
 * aunque algun dia corran varias copias del backend.
 *
 * GET_LOCK pertenece a la conexion, por eso se aparta una del pool durante
 * todo el bloque. `fn` puede usar el pool normal para sus consultas.
 */
export async function conCandado<T>(nombre: string, fn: () => Promise<T>, segundos = 15): Promise<T> {
  const conexion = await pool.getConnection();
  try {
    const [filas] = await conexion.query("SELECT GET_LOCK(?, ?) AS ok", [nombre, segundos]);
    if ((filas as Array<{ ok: number | null }>)[0]?.ok !== 1) {
      throw new Error("El sistema esta ocupado asignando otro numero. Intenta de nuevo en unos segundos.");
    }
    try {
      return await fn();
    } finally {
      await conexion.query("SELECT RELEASE_LOCK(?)", [nombre]);
    }
  } finally {
    conexion.release();
  }
}

/**
 * Crea o actualiza el esquema de la base al arrancar el servidor.
 *
 * Como funciona:
 * 1. CREATE TABLE IF NOT EXISTS de cada tabla (no toca las que ya existen).
 * 2. Lista 'columnas': agrega las columnas nuevas que falten, consultando
 *    information_schema (MySQL no tiene ADD COLUMN IF NOT EXISTS).
 * 3. Indices y ajustes de datos idempotentes (se pueden correr en cada
 *    arranque sin pisar lo que ya esta).
 * Asi un despliegue nuevo actualiza la base solo, sin migraciones manuales.
 */
export async function initSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS remolques (
      id INT AUTO_INCREMENT PRIMARY KEY,
      placa VARCHAR(15) NOT NULL UNIQUE,
      numEjes INT,
      capacidadKg DOUBLE,
      fechaVencSoat DATE,
      fechaVencTecnomecanica DATE,
      activo TINYINT(1) NOT NULL DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS vehiculos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      placa VARCHAR(15) NOT NULL UNIQUE,
      placaRemolque VARCHAR(15),
      marca VARCHAR(50),
      configuracion VARCHAR(50),
      capacidadKg DOUBLE,
      propietarioNit VARCHAR(20),
      fechaVencSoat DATE,
      fechaVencTecnomecanica DATE,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      codTipoIdTenedor VARCHAR(2) NOT NULL DEFAULT 'N',
      numIdTenedor VARCHAR(20),
      codTipoCarroceria VARCHAR(5) NOT NULL DEFAULT '0',
      pesoVehiculoVacio DOUBLE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conductores (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cedula VARCHAR(20) NOT NULL UNIQUE,
      nombre VARCHAR(150) NOT NULL,
      licencia VARCHAR(30),
      categoriaLicencia VARCHAR(10),
      fechaVencLicencia DATE,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      codTipoId VARCHAR(2) NOT NULL DEFAULT 'C'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS terceros (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nit VARCHAR(20) NOT NULL,
      nombre VARCHAR(200) NOT NULL,
      direccion VARCHAR(200),
      ciudad VARCHAR(80),
      telefono VARCHAR(30),
      rol VARCHAR(20),
      codTipoId VARCHAR(2) NOT NULL DEFAULT 'N',
      codSede VARCHAR(10) NOT NULL DEFAULT '0'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rutas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ciudadOrigen VARCHAR(80) NOT NULL,
      ciudadDestino VARCHAR(80) NOT NULL,
      codigoOrigenRndc VARCHAR(10),
      codigoDestinoRndc VARCHAR(10),
      distanciaKm DOUBLE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS plantillas_viaje (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(150) NOT NULL,
      contratanteId INT NOT NULL,
      remitenteId INT NOT NULL,
      destinatarioId INT NOT NULL,
      rutaId INT,
      tipoMercancia VARCHAR(100),
      naturalezaCarga VARCHAR(50),
      unidadMedida VARCHAR(20),
      valorFleteBase DOUBLE,
      observaciones VARCHAR(255),
      activa TINYINT(1) NOT NULL DEFAULT 1,
      codOperacionTransporte VARCHAR(2) NOT NULL DEFAULT 'G',
      codNaturalezaCarga VARCHAR(5) NOT NULL DEFAULT '1',
      codUnidadMedida VARCHAR(5) NOT NULL DEFAULT '1',
      codTipoEmpaque VARCHAR(5) NOT NULL DEFAULT '0',
      codMercancia VARCHAR(15),
      horasPactoCargue INT NOT NULL DEFAULT 1,
      minutosPactoCargue INT NOT NULL DEFAULT 0,
      horasPactoDescargue INT NOT NULL DEFAULT 1,
      minutosPactoDescargue INT NOT NULL DEFAULT 0,
      retencionIcaManifiesto DOUBLE NOT NULL DEFAULT 0,
      codResponsablePagoCargue VARCHAR(2) NOT NULL DEFAULT 'E',
      codResponsablePagoDescargue VARCHAR(2) NOT NULL DEFAULT 'E',
      aceptacionElectronica VARCHAR(2) NOT NULL DEFAULT 'NO',
      codMunicipioPagoSaldo VARCHAR(10),
      tomadorPolizaCarga VARCHAR(50) NOT NULL DEFAULT 'Empresa Transporte',
      numeroPolizaTransporte VARCHAR(30),
      companiaSeguro VARCHAR(20),
      fechaVencimientoPolizaCarga DATE,
      CONSTRAINT fk_plantilla_contratante FOREIGN KEY (contratanteId) REFERENCES terceros(id),
      CONSTRAINT fk_plantilla_remitente FOREIGN KEY (remitenteId) REFERENCES terceros(id),
      CONSTRAINT fk_plantilla_destinatario FOREIGN KEY (destinatarioId) REFERENCES terceros(id),
      CONSTRAINT fk_plantilla_ruta FOREIGN KEY (rutaId) REFERENCES rutas(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS viajes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      plantillaId INT NOT NULL,
      vehiculoId INT NOT NULL,
      conductorId INT NOT NULL,
      fechaHoraCargue DATETIME NOT NULL,
      pesoReal DOUBLE,
      cantidadReal DOUBLE,
      valorFleteReal DOUBLE,
      estado VARCHAR(30) NOT NULL DEFAULT 'PENDIENTE',
      numeroRemesaRndc VARCHAR(30),
      numeroManifiestoRndc VARCHAR(30),
      mec VARCHAR(30),
      codigoSeguridadQr VARCHAR(60),
      mensajeError TEXT,
      fechaCreacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      consecutivoRemesa VARCHAR(30),
      consecutivoManifiesto VARCHAR(30),
      valorAnticipoManifiesto DOUBLE NOT NULL DEFAULT 0,
      fechaPagoSaldo DATE,
      conductor2Id INT,
      remolqueId INT,
      CONSTRAINT fk_viaje_plantilla FOREIGN KEY (plantillaId) REFERENCES plantillas_viaje(id),
      CONSTRAINT fk_viaje_vehiculo FOREIGN KEY (vehiculoId) REFERENCES vehiculos(id),
      CONSTRAINT fk_viaje_conductor FOREIGN KEY (conductorId) REFERENCES conductores(id),
      CONSTRAINT fk_viaje_conductor2 FOREIGN KEY (conductor2Id) REFERENCES conductores(id),
      CONSTRAINT fk_viaje_remolque FOREIGN KEY (remolqueId) REFERENCES remolques(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Un manifiesto puede llevar varias remesas (multiparada): hasta 5 en la
  // practica de esta empresa. Antes un viaje equivalia a una sola remesa y los
  // datos de la remesa vivian en la tabla viajes; ahora viven aqui.
  //
  // Las columnas de remesa que quedaron en viajes (pesoReal, cantidadReal,
  // consecutivoRemesa, numeroRemesaRndc, fechaHoraDescargue,
  // ordenServicioGenerador) siguen ahi para no romper bases existentes, pero
  // ya no se usan.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS viaje_remesas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      viajeId INT NOT NULL,
      plantillaId INT NOT NULL,
      orden INT NOT NULL DEFAULT 1,
      consecutivoRemesa VARCHAR(30),
      numeroRemesaRndc VARCHAR(50),
      pesoReal DOUBLE,
      cantidadReal DOUBLE,
      fechaHoraCargue DATETIME NOT NULL,
      fechaHoraDescargue DATETIME NOT NULL,
      ordenServicioGenerador VARCHAR(20),
      valorFleteRemesa DOUBLE,
      estado VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
      mensajeError TEXT,
      INDEX idx_viaje (viajeId),
      UNIQUE KEY uk_consecutivo (consecutivoRemesa)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Catalogo de municipios (DIVIPOLA). No es obligatorio, pero permite escribir
  // el municipio por nombre en las cargas masivas en vez de por codigo, y
  // validar que los codigos existan antes de mandarlos al RNDC.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS municipios (
      codigo VARCHAR(8) PRIMARY KEY,
      nombre VARCHAR(120) NOT NULL,
      departamento VARCHAR(80),
      INDEX idx_municipio_nombre (nombre)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Vias disponibles entre dos municipios (CODVIA del manifiesto).
  //
  // La via cambia el valor de referencia de SICETAC y por lo tanto el piso del
  // flete, asi que no es un detalle: hay que poder elegirla en cada despacho.
  // El RNDC las expone en el desplegable "Via a Utilizar" del portal; aqui se
  // guardan por par origen-destino para poder ofrecerlas sin depender de una
  // consulta en linea.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vias (
      id INT AUTO_INCREMENT PRIMARY KEY,
      codVia VARCHAR(10) NOT NULL,
      codMunicipioOrigen VARCHAR(8) NOT NULL,
      codMunicipioDestino VARCHAR(8) NOT NULL,
      descripcion VARCHAR(500) NOT NULL,
      -- Valor minimo de referencia de SICETAC para esta via, si se conoce.
      -- Sirve para avisar cuando el flete queda por debajo del piso.
      valorSicetac DOUBLE,
      esEstandar TINYINT(1) NOT NULL DEFAULT 0,
      actualizadoEn DATETIME,
      UNIQUE KEY uq_via (codVia, codMunicipioOrigen, codMunicipioDestino),
      INDEX idx_via_ruta (codMunicipioOrigen, codMunicipioDestino)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Empresas de monitoreo de flota (EMF) registradas en el RNDC.
  //
  // El manifiesto exige el NIT de la EMF que reporta los tiempos logisticos
  // del viaje (NITMONITOREOFLOTA), y ese NIT debe estar en la lista de EMF
  // registradas en el RNDC [MANIFIESTO V7, diccionario de datos y error
  // MAN067]. No es un valor fijo de la empresa: depende del proveedor de GPS
  // del vehiculo, y cuando carga un tercero suele ser otro.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS empresas_monitoreo (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nit VARCHAR(15) NOT NULL UNIQUE,
      nombre VARCHAR(150) NOT NULL,
      activa TINYINT(1) NOT NULL DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Parametros de la empresa. Es una fila unica (id = 1) con los datos que
  // cambian una vez al ano o casi nunca: la poliza de carga, la tarifa de
  // retencion en la fuente y si aplica FOPAT.
  //
  // Antes vivian en cada plantilla, lo cual obligaba a repetirlos en cada
  // cliente y a tocarlos uno por uno cuando se renovaba la poliza.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS parametros_empresa (
      id INT PRIMARY KEY,
      tomadorPolizaCarga VARCHAR(50) NOT NULL DEFAULT 'Empresa Transporte',
      numeroPolizaTransporte VARCHAR(30),
      companiaSeguro VARCHAR(50),
      fechaVencimientoPolizaCarga DATE,
      aplicaFopat TINYINT(1) NOT NULL DEFAULT 1,
      tarifaRetencionFuente DOUBLE NOT NULL DEFAULT 0.01,
      actualizadoEn DATETIME
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`INSERT IGNORE INTO parametros_empresa (id) VALUES (1)`);

  // Usuarios del sistema (login con email + contrasena). La clave se guarda
  // con scrypt y sal propia (ver auth.ts), nunca en claro.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(150) NOT NULL UNIQUE,
      nombre VARCHAR(150) NOT NULL,
      claveHash VARCHAR(255) NOT NULL,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      debeCambiarClave TINYINT(1) NOT NULL DEFAULT 1,
      ultimoAcceso DATETIME,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Ultima respuesta buena de SICETAC por filtros (periodo, configuracion,
  // origen, destino). El RNDC limita las consultas del proceso 26 (RNDC13 a
  // todas durante un buen rato): con esto el cumplido usa los valores que se
  // obtuvieron al despachar, aunque SICETAC no responda en ese momento.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sicetac_respuestas (
      clave VARCHAR(255) PRIMARY KEY,
      resultado MEDIUMTEXT NOT NULL,
      guardadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ---------------------------------------------------------------------
  // Cuadro pagos: control operativo y financiero de cada viaje, tenga o no
  // manifiesto (urbanos, o viajes que planilla el mismo generador de carga).
  // Reemplaza la hoja de Excel "CUADRO PAGOS": una fila por viaje
  // facturable (empresa + remision). Los viajes con manifiesto entran solos,
  // una fila por remesa (viajeRemesaId).
  // ---------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bombas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(120) NOT NULL,
      ciudad VARCHAR(80),
      activa TINYINT(1) NOT NULL DEFAULT 1,
      UNIQUE KEY uq_bomba (nombre, ciudad)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cuadro_viajes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      fecha DATE NOT NULL,
      vehiculoId INT NULL,
      placa VARCHAR(15) NOT NULL,
      conductor VARCHAR(150),
      empresa VARCHAR(200) NOT NULL,
      viajeId INT NULL,
      viajeRemesaId INT NULL,
      manifiesto VARCHAR(20),
      remesa VARCHAR(20),
      remision VARCHAR(60),
      pesoKg DOUBLE,
      -- KILO: pesoKg x tarifaKilo. FIJO: valorFijo.
      tipoFlete VARCHAR(5) NOT NULL DEFAULT 'KILO',
      tarifaKilo DOUBLE,
      valorFijo DOUBLE,
      fechaDescargue DATE,
      -- EN_RUTA, DESCARGADO, CONDUCTOR, PARQUEADERO, OFICINA, RADICADO, RADICADOS. Parqueadero,
      -- oficina (Don Alexander) y RADICADOS solo en el flujo de CORAME / Cartones America.
      estadoPapeles VARCHAR(15) NOT NULL DEFAULT 'EN_RUTA',
      flujoCorame TINYINT(1) NOT NULL DEFAULT 0,
      fechaRadicado DATE,
      -- Facturado aunque aun no se haya anotado numero y fecha (azul en el Excel).
      facturado TINYINT(1) NOT NULL DEFAULT 0,
      facturaNumero VARCHAR(30),
      facturaFecha DATE,
      facturaFechaPago DATE,
      -- Pago al dueno del vehiculo (terceros: 15 dias despues de entregar).
      fechaPagoSaldo DATE,
      revisadoContabilidadPorId INT,
      revisadoContabilidadEn DATETIME,
      revisadoGerenciaPorId INT,
      revisadoGerenciaEn DATETIME,
      anulado TINYINT(1) NOT NULL DEFAULT 0,
      creadoPorId INT,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_cuadro_remesa (viajeRemesaId),
      INDEX idx_cuadro_fecha (fecha),
      INDEX idx_cuadro_factura (facturaNumero)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Anticipos que entregan las bombas aliadas: van aparte del anticipo del
  // manifiesto. fechaPago = cuando la empresa le paga a la bomba.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cuadro_anticipos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cuadroViajeId INT NOT NULL,
      bombaId INT NOT NULL,
      valor DOUBLE NOT NULL,
      fecha DATE NOT NULL,
      fechaPago DATE,
      nota VARCHAR(200),
      creadoPorId INT,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_anticipo_viaje (cuadroViajeId),
      CONSTRAINT fk_anticipo_viaje FOREIGN KEY (cuadroViajeId) REFERENCES cuadro_viajes(id) ON DELETE CASCADE,
      CONSTRAINT fk_anticipo_bomba FOREIGN KEY (bombaId) REFERENCES bombas(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Tanqueos: un anticipo entregado en una bomba (EDS) de una vez, que puede
  // cubrir el viaje de ida y el de vuelta. Es lo que se corrobora con la
  // factura de la bomba. Cada tramo (ida o vuelta) va en cuadro_anticipos.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS anticipos_tanqueo (
      id INT AUTO_INCREMENT PRIMARY KEY,
      placa VARCHAR(15) NOT NULL,
      fecha DATE NOT NULL,
      bombaId INT,
      idaYVuelta TINYINT(1) NOT NULL DEFAULT 0,
      facturaBomba VARCHAR(40),
      fechaFacturaBomba DATE,
      nota VARCHAR(200),
      creadoPorId INT,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tanqueo_placa (placa),
      CONSTRAINT fk_tanqueo_bomba FOREIGN KEY (bombaId) REFERENCES bombas(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Abonos de un socio (el Zorro) que le paga directamente a la bomba los
  // anticipos de algunos viajes: cuanto, cuando y a que viajes corresponde.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS abonos_socio (
      id INT AUTO_INCREMENT PRIMARY KEY,
      socio VARCHAR(100) NOT NULL,
      fecha DATE NOT NULL,
      valor DOUBLE NOT NULL,
      nota VARCHAR(200),
      creadoPorId INT,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS abonos_socio_viajes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      abonoId INT NOT NULL,
      cuadroViajeId INT NOT NULL,
      valor DOUBLE NOT NULL,
      INDEX idx_abono_viaje (cuadroViajeId),
      CONSTRAINT fk_abono_socio FOREIGN KEY (abonoId) REFERENCES abonos_socio(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Notas del viaje con autor y fecha (como los comentarios del Excel).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cuadro_notas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cuadroViajeId INT NOT NULL,
      texto VARCHAR(1000) NOT NULL,
      usuarioId INT,
      creadaEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_nota_viaje (cuadroViajeId),
      CONSTRAINT fk_nota_viaje FOREIGN KEY (cuadroViajeId) REFERENCES cuadro_viajes(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Matriz de fletes por cliente (se importa desde el Excel "MATRIZ FLETES"):
  // nombre de la tarifa (cliente y ruta), razon social, valor, tipo (TON por
  // tonelada, FIJO por viaje, POR / POR3 con clientes adicionales), peso minimo
  // a facturar (34000 o 32000 kg segun el trato) y observaciones.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tarifas_flete (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(200) NOT NULL,
      razonSocial VARCHAR(200),
      valor DOUBLE,
      tipo VARCHAR(10) NOT NULL DEFAULT 'TON',
      pesoMinimoKg INT,
      observaciones VARCHAR(500),
      INDEX idx_tarifa_razon (razonSocial)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Cartera: plazo de pago y contacto de cobro de cada cliente del cuadro
  // (la llave es el nombre de la empresa, como en cuadro_viajes.empresa).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cartera_clientes (
      empresa VARCHAR(200) PRIMARY KEY,
      diasCredito INT NOT NULL DEFAULT 30,
      contacto VARCHAR(150),
      telefono VARCHAR(30),
      correo VARCHAR(150)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Gestiones de cobro de una factura (llamadas, correos) y la fecha en que
  // el cliente prometio pagar.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cartera_gestiones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      facturaNumero VARCHAR(30) NOT NULL,
      empresa VARCHAR(200) NOT NULL,
      texto VARCHAR(1000) NOT NULL,
      compromisoPago DATE,
      usuarioId INT,
      creadaEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_gestion_factura (facturaNumero, empresa)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Saldos de cartera sin viaje: facturas pendientes de antes de que los
  // viajes estuvieran en el sistema (antes de septiembre de 2026), cargadas
  // una sola vez desde el Excel "Cartera Total" con su valor por placa. Desde
  // septiembre todo va por el cuadro pagos (factura en cada viaje).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cartera_saldos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      facturaNumero VARCHAR(30) NOT NULL,
      empresa VARCHAR(200) NOT NULL,
      fechaFactura DATE NOT NULL,
      fechaVence DATE,
      fechaPago DATE,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_saldo_factura (facturaNumero, empresa)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cartera_saldos_placas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      saldoId INT NOT NULL,
      placa VARCHAR(15) NOT NULL,
      valor DOUBLE NOT NULL,
      INDEX idx_saldo_placa (saldoId),
      CONSTRAINT fk_saldo_placa FOREIGN KEY (saldoId) REFERENCES cartera_saldos(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Anticipo (o abono) que el cliente ya pago de una factura: se resta de lo
  // que debe. Llave: numero de factura + empresa, igual que la cartera.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cartera_anticipos_cliente (
      facturaNumero VARCHAR(30) NOT NULL,
      empresa VARCHAR(200) NOT NULL,
      valor DOUBLE NOT NULL,
      PRIMARY KEY (facturaNumero, empresa)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Sesiones abiertas. Se guarda el HASH del token (no el token): quien lea
  // esta tabla no puede suplantar a nadie.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sesiones (
      tokenHash CHAR(64) PRIMARY KEY,
      usuarioId INT NOT NULL,
      expiraEn DATETIME NOT NULL,
      creadaEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_sesion_usuario (usuarioId),
      CONSTRAINT fk_sesion_usuario FOREIGN KEY (usuarioId) REFERENCES usuarios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Codigos para recuperar la contrasena por correo. Se guarda el hash del
  // codigo, cuando vence y cuantos intentos fallidos lleva.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recuperaciones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      usuarioId INT NOT NULL,
      codigoHash CHAR(64) NOT NULL,
      expiraEn DATETIME NOT NULL,
      intentos INT NOT NULL DEFAULT 0,
      creadaEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_recuperacion_usuario (usuarioId),
      CONSTRAINT fk_recuperacion_usuario FOREIGN KEY (usuarioId) REFERENCES usuarios(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Migraciones aditivas para bases de datos creadas con una version anterior
  // del esquema.
  //
  // OJO: "ALTER TABLE ... ADD COLUMN IF NOT EXISTS" es sintaxis de MariaDB.
  // MySQL NO la soporta en ninguna version, asi que la version anterior de este
  // archivo fallaba al arrancar contra el `mysql:8` que sugiere el README.
  // Por eso ahora se consulta information_schema y se genera el ALTER solo si
  // la columna falta: funciona igual en MariaDB y en MySQL.
  const columnas: Array<[tabla: string, columna: string, definicion: string]> = [
    ["vehiculos", "codTipoIdTenedor", "VARCHAR(2) NOT NULL DEFAULT 'N'"],
    ["vehiculos", "numIdTenedor", "VARCHAR(20)"],
    ["vehiculos", "codTipoCarroceria", "VARCHAR(5) NOT NULL DEFAULT '0'"],
    ["vehiculos", "pesoVehiculoVacio", "DOUBLE"],
    ["conductores", "codTipoId", "VARCHAR(2) NOT NULL DEFAULT 'C'"],
    ["terceros", "codTipoId", "VARCHAR(2) NOT NULL DEFAULT 'N'"],
    ["terceros", "codSede", "VARCHAR(10) NOT NULL DEFAULT '0'"],
    ["plantillas_viaje", "codOperacionTransporte", "VARCHAR(2) NOT NULL DEFAULT 'G'"],
    ["plantillas_viaje", "codNaturalezaCarga", "VARCHAR(5) NOT NULL DEFAULT '1'"],
    ["plantillas_viaje", "codUnidadMedida", "VARCHAR(5) NOT NULL DEFAULT '1'"],
    ["plantillas_viaje", "codTipoEmpaque", "VARCHAR(5) NOT NULL DEFAULT '0'"],
    ["plantillas_viaje", "codMercancia", "VARCHAR(15)"],
    ["plantillas_viaje", "horasPactoCargue", "INT NOT NULL DEFAULT 1"],
    ["plantillas_viaje", "minutosPactoCargue", "INT NOT NULL DEFAULT 0"],
    ["plantillas_viaje", "horasPactoDescargue", "INT NOT NULL DEFAULT 1"],
    ["plantillas_viaje", "minutosPactoDescargue", "INT NOT NULL DEFAULT 0"],
    ["plantillas_viaje", "retencionIcaManifiesto", "DOUBLE NOT NULL DEFAULT 0"],
    // Solo admiten 'R' (remitente) o 'D' (destinatario).
    ["plantillas_viaje", "codResponsablePagoCargue", "VARCHAR(2) NOT NULL DEFAULT 'R'"],
    ["plantillas_viaje", "codResponsablePagoDescargue", "VARCHAR(2) NOT NULL DEFAULT 'D'"],
    ["plantillas_viaje", "aceptacionElectronica", "VARCHAR(2) NOT NULL DEFAULT 'NO'"],
    ["plantillas_viaje", "codMunicipioPagoSaldo", "VARCHAR(10)"],
    ["plantillas_viaje", "tomadorPolizaCarga", "VARCHAR(50) NOT NULL DEFAULT 'Empresa Transporte'"],
    ["plantillas_viaje", "numeroPolizaTransporte", "VARCHAR(30)"],
    ["plantillas_viaje", "companiaSeguro", "VARCHAR(20)"],
    ["plantillas_viaje", "fechaVencimientoPolizaCarga", "DATE"],
    ["viajes", "consecutivoRemesa", "VARCHAR(30)"],
    ["viajes", "consecutivoManifiesto", "VARCHAR(30)"],
    ["viajes", "valorAnticipoManifiesto", "DOUBLE NOT NULL DEFAULT 0"],
    ["viajes", "fechaPagoSaldo", "DATE"],
    ["viajes", "conductor2Id", "INT"],
    ["viajes", "remolqueId", "INT"],

    // --- Campos exigidos por las guias MANIFIESTO V7 y REMESA V5 ---

    // FOPAT: 0.1% del valor a pagar, solo para PBV > 10.5 t (Ley 2251 de 2022).
    // Se marca por vehiculo porque el RNDC verifica el monto exacto: enviarlo
    // cuando no aplica es tan problematico como omitirlo cuando si.
    ["vehiculos", "aplicaFopat", "TINYINT(1) NOT NULL DEFAULT 1"],

    // Via a utilizar (CODVIA). Si va vacia, el RNDC asigna la via estandar de
    // SICETAC para esa ruta origen-destino.
    ["rutas", "codVia", "VARCHAR(10)"],

    // CODOPERACIONTRANSPORTE es la misma etiqueta en remesa y en manifiesto,
    // pero con dominios de valores distintos. Se separan en dos columnas; la
    // vieja codOperacionTransporte queda sin uso (no se borra para no romper
    // bases de datos existentes).
    ["plantillas_viaje", "tipoOperacionRemesa", "VARCHAR(2) NOT NULL DEFAULT 'G'"],
    ["plantillas_viaje", "tipoManifiesto", "VARCHAR(2) NOT NULL DEFAULT 'G'"],
    ["plantillas_viaje", "codMunicipioIntermedio", "VARCHAR(10)"],

    // Codificacion armonizada: niveles 3 y 4, exigidos solo por ciertas partidas.
    ["plantillas_viaje", "subpartidaCode", "VARCHAR(2)"],
    ["plantillas_viaje", "codigoArancelCode", "VARCHAR(2)"],

    ["plantillas_viaje", "empaquePrimario", "VARCHAR(10)"],
    // Unidad COMERCIAL del producto (KGM, GLL, UN...). Distinta de la unidad de
    // transporte, que siempre son kilos.
    ["plantillas_viaje", "unidadMedidaProducto", "VARCHAR(5) NOT NULL DEFAULT 'KGM'"],

    // Retencion en la fuente: tarifa configurable (1% por defecto) y marca de
    // Regimen Simple, unico caso en que el RNDC acepta el valor en cero.
    ["plantillas_viaje", "tarifaRetencionFuente", "DOUBLE NOT NULL DEFAULT 0.01"],
    ["plantillas_viaje", "titularEsRegimenSimple", "TINYINT(1) NOT NULL DEFAULT 0"],

    // Cita real de descargue: de ella dependen las validaciones de vigencia de
    // SOAT, RTM y licencia. Antes se asumia igual a la de cargue.
    ["viajes", "fechaHoraDescargue", "DATETIME"],
    ["viajes", "viajesDia", "INT"],
    ["viajes", "ordenServicioGenerador", "VARCHAR(20)"],

    // Trayectos en vacio pactados con el transportador (varian por viaje).
    ["viajes", "vacio1Origen", "VARCHAR(10)"],
    ["viajes", "vacio1Destino", "VARCHAR(10)"],
    ["viajes", "vacio1Valor", "DOUBLE NOT NULL DEFAULT 0"],
    ["viajes", "vacio2Origen", "VARCHAR(10)"],
    ["viajes", "vacio2Destino", "VARCHAR(10)"],
    ["viajes", "vacio2Valor", "DOUBLE NOT NULL DEFAULT 0"],

    // Avisos no bloqueantes (ej. manifiesto tardio): la operacion siguio, pero
    // el despachador debe enterarse.
    ["viajes", "avisos", "TEXT"],

    // Diagnostico: el mensaje ya traducido va en mensajeError; aqui se guarda
    // el codigo y el texto original del RNDC, que es lo que pide la mesa de ayuda.
    ["viajes", "codigoError", "VARCHAR(10)"],
    ["viajes", "errorCrudo", "TEXT"],

    // FOPAT que se envio en el manifiesto. Se guarda el valor real, no se
    // recalcula al consultarlo: si la tarifa cambia, los manifiestos viejos
    // deben seguir mostrando lo que efectivamente se reporto.
    ["viajes", "retencionFopat", "DOUBLE"],
    // Control del pago mensual del FOPAT a la DIAN. El RNDC verifica que la
    // empresa este al dia antes de dejar expedir manifiestos nuevos.
    ["viajes", "fopatPagado", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["viajes", "fechaPagoFopat", "DATE"],

    // Cuando se actualizo por ultima vez la tarifa base de la plantilla. Sirve
    // para saber que plantillas quedaron rezagadas tras un cambio de SICETAC.
    ["plantillas_viaje", "fleteActualizadoEn", "DATETIME"],

    // Via elegida para este viaje (CODVIA). Cambia el piso tarifario, asi que
    // se guarda con el viaje y no se deduce.
    ["viajes", "codVia", "VARCHAR(10)"],

    // EMF por defecto del vehiculo: su proveedor de GPS. Se precarga en el
    // despacho y se puede cambiar para un viaje puntual.
    ["vehiculos", "nitMonitoreoFlota", "VARCHAR(15)"],
    // EMF efectivamente usada en el viaje (NITMONITOREOFLOTA).
    ["viajes", "nitMonitoreoFlota", "VARCHAR(15)"],

    // Coordenadas georreferenciadas de la SEDE del tercero.
    //
    // No se envian al RNDC: alli las toma de su propio maestro de terceros. Se
    // guardan aqui porque el RNDC compara el GPS del vehiculo contra ellas para
    // verificar que estuvo en el sitio durante el cargue, y conviene poder
    // revisarlas y avisar antes de despachar en vez de descubrirlo despues.
    //
    // DECIMAL(10,7) para no perder los 6 decimales que exige el RNDC: en
    // DOUBLE el redondeo binario puede correr la posicion varios metros.
    ["terceros", "latitud", "DECIMAL(10,7)"],
    ["terceros", "longitud", "DECIMAL(10,7)"],

    // Municipio de la sede, para verificar que el origen y el destino del
    // manifiesto coincidan con algun sitio de cargue y de descargue.
    ["terceros", "codMunicipioRndc", "VARCHAR(10)"],

    // Factor de ICA (por mil) del municipio donde carga esta plantilla. Con
    // varias remesas de municipios distintos, el manifiesto lleva el promedio
    // ponderado de todos.
    ["plantillas_viaje", "factorIcaCargue", "DOUBLE NOT NULL DEFAULT 0"],

    // Ruta explicita de la plantilla (DIVIPOLA, 8 digitos): origen y destino del
    // viaje. Se precargan con el municipio del remitente y del destinatario,
    // pero son editables (tramo en vacio antes del cargue, ida y regreso...).
    // De aqui sale el par con el que se consultan las vias a SICETAC.
    ["plantillas_viaje", "municipioOrigen", "VARCHAR(8)"],
    ["plantillas_viaje", "municipioDestino", "VARCHAR(8)"],

    // Nombre del titular del manifiesto (tenedor). NO se envia al RNDC: alli
    // solo viajan el tipo y el numero de identificacion. Sirve para ver en el
    // catalogo a quien corresponde la cedula, sobre todo en la flota propia,
    // donde el titular es el propietario persona natural y no la empresa.
    ["vehiculos", "nombreTenedor", "VARCHAR(150)"],

    // Anulacion de documentos (procesos 54, 32 y 9). El viaje anulado NO se
    // borra: su numero sigue contando como usado, porque el RNDC no deja
    // reutilizar un consecutivo anulado [Manual RNDC 2026, 6.1].
    ["viajes", "motivoAnulacion", "VARCHAR(2)"],
    ["viajes", "observacionesAnulacion", "VARCHAR(255)"],
    ["viajes", "radicadoAnulacion", "VARCHAR(30)"],
    ["viajes", "fechaAnulacion", "DATETIME"],
    // Por remesa: anulacion del cumplido inicial (54) y de la remesa (9).
    // Guardarlos por separado permite retomar una anulacion a medias.
    ["viaje_remesas", "radicadoAnulacionCumplido", "VARCHAR(30)"],
    ["viaje_remesas", "radicadoAnulacion", "VARCHAR(30)"],

    // Conductor que suele manejar el vehiculo (cedula). Junto con
    // placaRemolque (remolque habitual) alimenta la sugerencia del despacho
    // cuando el vehiculo aun no tiene historial en este sistema.
    ["vehiculos", "cedulaConductorHabitual", "VARCHAR(20)"],

    // Borrado logico. Un vehiculo con viajes no se puede borrar de verdad
    // (fk_viaje_vehiculo) y el historial lo necesita; "eliminado" lo saca de
    // todas las listas. Distinto de "activo": un inactivo se sigue viendo con
    // "Mostrar inactivos" y se puede reactivar desde la pantalla.
    ["vehiculos", "eliminado", "TINYINT(1) NOT NULL DEFAULT 0"],

    // Auditoria: que usuario expidio y cual anulo cada viaje. Van sin llave
    // foranea a proposito: los usuarios no se borran (se desactivan), y si
    // alguno se borrara igual, el viaje no debe quedar huerfano ni bloquearlo.
    ["viajes", "creadoPorId", "INT"],
    ["viajes", "anuladoPorId", "INT"],

    // Cumplidos (procesos 5 y 6). Por remesa: lo que se reporto y el radicado.
    // Por viaje: el radicado del cumplido del manifiesto.
    ["viaje_remesas", "cantidadEntregada", "DOUBLE"],
    ["viaje_remesas", "entradaCargue", "DATETIME"],
    ["viaje_remesas", "entradaDescargue", "DATETIME"],
    // Llegada y salida del cumplido, cuando no hay cumplido inicial del GPS.
    ["viaje_remesas", "llegadaCargue", "DATETIME"],
    ["viaje_remesas", "salidaCargue", "DATETIME"],
    ["viaje_remesas", "llegadaDescargue", "DATETIME"],
    ["viaje_remesas", "salidaDescargue", "DATETIME"],
    // Ultima anulacion del cumplido de la remesa (proceso 28).
    ["viaje_remesas", "radicadoAnulacionCumplidoRemesa", "VARCHAR(30)"],
    ["viaje_remesas", "radicadoCumplido", "VARCHAR(30)"],
    ["viaje_remesas", "fechaCumplido", "DATETIME"],
    ["viaje_remesas", "cumplidoPorId", "INT"],
    ["viajes", "radicadoCumplido", "VARCHAR(30)"],
    ["viajes", "fechaCumplido", "DATETIME"],
    ["viajes", "cumplidoPorId", "INT"],

    // Pisos de SICETAC guardados con el filtro corregido (2026-10-01). Los
    // anteriores se calcularon con la fila mas barata (contenedor vacio) y
    // quedaban muy por debajo del piso real: con 0 no se usan.
    ["vias", "pisoVerificado", "TINYINT(1) NOT NULL DEFAULT 0"],

    // Flota propia (Transportes Lopez o Transportes MYC: dos empresas que se
    // manejan como una; solo Lopez planilla) o vehiculo de un tercero, que se
    // paga aparte y a los 15 dias de entregar el viaje.
    ["vehiculos", "flota", "VARCHAR(10) NOT NULL DEFAULT 'TERCERO'"],

    // Viajes expedidos en el PORTAL del RNDC y traidos por la sincronizacion
    // (src/rndc/sincronizacion.ts). No tienen plantilla y su vehiculo,
    // conductor o remolque pueden no estar en el catalogo: se guardan tal
    // como los reporta el RNDC.
    ["viajes", "origen", "VARCHAR(10) NOT NULL DEFAULT 'TMS'"],
    ["viajes", "placaRndc", "VARCHAR(15)"],
    ["viajes", "conductorRndc", "VARCHAR(20)"],
    ["viajes", "remolqueRndc", "VARCHAR(15)"],
    ["viajes", "origenRndc", "VARCHAR(8)"],
    ["viajes", "destinoRndc", "VARCHAR(8)"],
    // Partes y mercancia de las remesas del portal (las del TMS salen de la plantilla).
    ["viaje_remesas", "propietarioTipoId", "VARCHAR(2)"],
    ["viaje_remesas", "propietarioNit", "VARCHAR(20)"],
    ["viaje_remesas", "propietarioSede", "VARCHAR(10)"],
    ["viaje_remesas", "remitenteTipoId", "VARCHAR(2)"],
    ["viaje_remesas", "remitenteNit", "VARCHAR(20)"],
    ["viaje_remesas", "remitenteSede", "VARCHAR(10)"],
    ["viaje_remesas", "destinatarioTipoId", "VARCHAR(2)"],
    ["viaje_remesas", "destinatarioNit", "VARCHAR(20)"],
    ["viaje_remesas", "destinatarioSede", "VARCHAR(10)"],
    ["viaje_remesas", "producto", "VARCHAR(120)"],
    ["viaje_remesas", "codMercancia", "VARCHAR(10)"],
    // Radicado del cumplido inicial (proceso 45, lo genera el GPS): hay que
    // anularlo (proceso 54) antes de anular el manifiesto.
    ["viaje_remesas", "radicadoCumplidoInicial", "VARCHAR(30)"],
    // Seguimiento de papeles despues del descargue (ver src/seguimiento.ts):
    // quien los tiene, si estan completos, que falta y cuando se reviso.
    ["cuadro_viajes", "papelesTiene", "VARCHAR(150)"],
    // 1 = el conductor tiene todos los papeles, 0 = falta algo, NULL = no se sabe.
    ["cuadro_viajes", "papelesCompletos", "TINYINT(1) NULL"],
    ["cuadro_viajes", "papelesFaltan", "VARCHAR(300)"],
    ["cuadro_viajes", "papelesRevisadoEn", "DATETIME"],
    ["cuadro_viajes", "papelesRevisadoPorId", "INT"],
    // "Fecha pago cliente": cuando vence la factura (el cliente debe pagar).
    // facturaFechaPago es el pago real ("fecha pago factura").
    ["cuadro_viajes", "facturaVence", "DATE"],
    // Registro en el RNDC de los maestros (procesos 11 y 12, ver
    // src/rndc/maestros.ts): ultimo radicado, cuando y el error si lo rechazo.
    ["terceros", "nombreSede", "VARCHAR(100)"],
    ["terceros", "rndcRadicado", "VARCHAR(30)"],
    ["terceros", "rndcEn", "DATETIME"],
    ["terceros", "rndcError", "TEXT"],
    // El RNDC registra al conductor como tercero: exige direccion y municipio.
    ["conductores", "direccion", "VARCHAR(200)"],
    ["conductores", "ciudad", "VARCHAR(80)"],
    ["conductores", "codMunicipioRndc", "VARCHAR(10)"],
    ["conductores", "rndcRadicado", "VARCHAR(30)"],
    ["conductores", "rndcEn", "DATETIME"],
    ["conductores", "rndcError", "TEXT"],
    ["vehiculos", "rndcRadicado", "VARCHAR(30)"],
    ["vehiculos", "rndcEn", "DATETIME"],
    ["vehiculos", "rndcError", "TEXT"],
    ["remolques", "rndcRadicado", "VARCHAR(30)"],
    ["remolques", "rndcEn", "DATETIME"],
    ["remolques", "rndcError", "TEXT"],
    // Acceso a la plataforma GPS de cada vehiculo, para ver a que hora salio
    // del cargue (ver GET /api/catalogo/vehiculos/:id/gps). La clave va
    // cifrada (src/cifrado.ts); la URL del vehiculo, si esta, manda sobre la
    // de su empresa de monitoreo.
    // Envio a facturacion (cuadro para la contadora, ver src/facturacion.ts):
    // tarifa de la matriz usada, peso que se factura (puede ser el minimo
    // pactado), nota de la factura y cuando se envio.
    // Anticipos por tramo (ver src/anticipos.ts): efectivo y combustible por
    // separado, de que tanqueo salen, si es la ida o la vuelta y la placa (la
    // vuelta queda sin viaje hasta el proximo viaje de esa placa).
    ["cuadro_anticipos", "tanqueoId", "INT"],
    ["cuadro_anticipos", "tramo", "VARCHAR(6) NOT NULL DEFAULT 'IDA'"],
    ["cuadro_anticipos", "efectivo", "DOUBLE"],
    ["cuadro_anticipos", "combustible", "DOUBLE"],
    ["cuadro_anticipos", "placa", "VARCHAR(15)"],
    // Cruce con la relacion de la bomba (como la columna COMBUST. del Excel):
    // combustible = round(galones x precio por galon - descuento en pesos).
    // Precio y descuento se sugieren desde los parametros y se pueden cambiar.
    // combustibleEntregado guarda lo que se habia registrado antes del cruce.
    ["cuadro_anticipos", "galones", "DOUBLE"],
    ["cuadro_anticipos", "precioGalon", "DOUBLE"],
    ["cuadro_anticipos", "descuento", "DOUBLE"],
    ["cuadro_anticipos", "combustibleEntregado", "DOUBLE"],
    // Bomba: cupo de credito con la empresa y valores sugeridos para el cruce.
    ["parametros_empresa", "cupoBomba", "DOUBLE NOT NULL DEFAULT 500000000"],
    ["parametros_empresa", "precioGalonBomba", "DOUBLE NOT NULL DEFAULT 11390"],
    ["parametros_empresa", "descuentoGalonBomba", "DOUBLE NOT NULL DEFAULT 250"],
    ["cuadro_viajes", "tarifaFleteId", "INT"],
    ["cuadro_viajes", "pesoFacturadoKg", "DOUBLE"],
    ["cuadro_viajes", "notaFactura", "VARCHAR(300)"],
    ["cuadro_viajes", "enviadoFacturarEn", "DATETIME"],
    // Flete por tonelada con 2 o 3 clientes (tarifas POR / POR3): se suma al
    // peso x tarifa (300.000 por cada cliente adicional).
    ["cuadro_viajes", "fleteAdicional", "DOUBLE"],
    // Conductor que dice el manifiesto. El cuadro muestra el habitual del
    // vehiculo en la flota (conductor); este queda como referencia.
    ["cuadro_viajes", "conductorManifiesto", "VARCHAR(150)"],
    // Dueno del vehiculo para separar la cartera (MAURICIO, CELSO, MILLER o
    // LUISA). NULL = tercero.
    ["vehiculos", "dueno", "VARCHAR(20)"],
    // Ruta escrita a mano en los viajes sin manifiesto ("SOACHA - CALI"). Los
    // que tienen manifiesto muestran la del RNDC y no usan esta columna.
    ["cuadro_viajes", "rutaManual", "VARCHAR(200)"],
    // Tarifa que siempre se factura con el mismo peso (PEGANTE URBANO: 33.000 kg).
    ["tarifas_flete", "pesoFijoKg", "INT"],
    ["vehiculos", "gpsUrl", "VARCHAR(300)"],
    ["vehiculos", "gpsUsuario", "VARCHAR(100)"],
    ["vehiculos", "gpsClaveCifrada", "TEXT"],
    ["empresas_monitoreo", "urlPlataforma", "VARCHAR(300)"],
  ];

  // Ajustes de columnas existentes (no son altas, son cambios de definicion).
  // rutaId dejo de ser obligatorio cuando el origen y el destino pasaron a
  // deducirse de los terceros.
  await pool.query("ALTER TABLE plantillas_viaje MODIFY rutaId INT NULL").catch(() => undefined);
  // Un viaje expedido en el portal del RNDC no tiene plantilla, y su vehiculo
  // o conductor pueden no estar en el catalogo.
  await pool
    .query("ALTER TABLE viajes MODIFY plantillaId INT NULL, MODIFY vehiculoId INT NULL, MODIFY conductorId INT NULL")
    .catch(() => undefined);
  await pool.query("ALTER TABLE viaje_remesas MODIFY plantillaId INT NULL").catch(() => undefined);
  // Estado de la sincronizacion con el RNDC (una fila).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sincronizacion_rndc (
      id INT PRIMARY KEY,
      ultimaEjecucion DATETIME,
      ultimoBarridoCompleto DATETIME,
      resumen TEXT,
      error TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ¿Ya existia el vencimiento de factura? Si no, se crea abajo y se corrige
  // una sola vez lo que se habia escrito antes (ver despues del ciclo).
  const [conVence] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cuadro_viajes' AND COLUMN_NAME = 'facturaVence'`
  );
  const venceEsNuevo = (conVence as unknown[]).length === 0;
  const [conManifiesto] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cuadro_viajes' AND COLUMN_NAME = 'conductorManifiesto'`
  );
  const conductorManifiestoEsNuevo = (conManifiesto as unknown[]).length === 0;
  const [conDueno] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vehiculos' AND COLUMN_NAME = 'dueno'`
  );
  const duenoEsNuevo = (conDueno as unknown[]).length === 0;

  for (const [tabla, columna, definicion] of columnas) {
    const [filas] = await pool.query(
      `SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [tabla, columna]
    );
    if ((filas as unknown[]).length === 0) {
      await pool.query(`ALTER TABLE \`${tabla}\` ADD COLUMN \`${columna}\` ${definicion}`);
    }
  }

  // La vuelta de un anticipo de ida y vuelta no tiene viaje todavia, y un
  // anticipo solo en efectivo no tiene bomba.
  await pool.query("ALTER TABLE cuadro_anticipos MODIFY cuadroViajeId INT NULL, MODIFY bombaId INT NULL").catch(() => undefined);
  // Los anticipos de antes eran solo de bomba (combustible): se marcan asi.
  await pool.query(
    "UPDATE cuadro_anticipos SET combustible = valor, efectivo = 0 WHERE combustible IS NULL AND efectivo IS NULL"
  );

  // Correccion unica al crear facturaVence: lo que se lleno en "fecha pago
  // cliente" (facturaFechaPago) era el vencimiento de la factura, no el pago.
  // Se pasa a facturaVence y facturaFechaPago queda para el pago real.
  if (venceEsNuevo) {
    await pool.query(
      `UPDATE cuadro_viajes SET facturaVence = facturaFechaPago, facturaFechaPago = NULL
        WHERE facturaFechaPago IS NOT NULL`
    );
  }

  // Correccion unica al crear conductorManifiesto: se guarda el conductor que
  // trajo cada manifiesto y, donde nadie lo cambio a mano, el cuadro pasa a
  // mostrar el conductor habitual del vehiculo en la flota.
  // Carga unica al crear el dueno: las placas de cada socio segun el Excel
  // "Cartera Total". Despues se cambia en Flota.
  if (duenoEsNuevo) {
    for (const [dueno, placas] of Object.entries(PLACAS_POR_DUENO)) {
      await pool.query("UPDATE vehiculos SET dueno = ? WHERE REPLACE(placa, '-', '') IN (?)", [dueno, placas]);
    }
  }

  if (conductorManifiestoEsNuevo) {
    await pool.query(
      `UPDATE cuadro_viajes cv JOIN viajes v ON v.id = cv.viajeId
         LEFT JOIN conductores c ON c.id = v.conductorId
          SET cv.conductorManifiesto = COALESCE(c.nombre, v.conductorRndc)`
    );
    await pool.query(
      `UPDATE cuadro_viajes cv
         JOIN vehiculos ve ON ve.id = cv.vehiculoId
         JOIN conductores ch ON ch.cedula = ve.cedulaConductorHabitual
          SET cv.conductor = ch.nombre
        WHERE cv.conductor <=> cv.conductorManifiesto OR cv.conductor IS NULL OR cv.conductor = ''`
    );
  }

  // Un numero de manifiesto no se puede repetir: es la ultima barrera contra
  // dos viajes con el mismo consecutivo (el candado de la numeracion es la
  // primera). Si ya hubiera duplicados en la base, no se puede crear el
  // indice: se avisa en consola y el sistema sigue funcionando sin el.
  const [indice] = await pool.query(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viajes' AND INDEX_NAME = 'uk_viaje_consecutivo'`
  );
  if ((indice as unknown[]).length === 0) {
    await pool
      .query("ALTER TABLE viajes ADD UNIQUE KEY uk_viaje_consecutivo (consecutivoManifiesto)")
      .catch((err) =>
        console.warn(
          "AVISO: no se pudo crear el indice unico de consecutivos de manifiesto " +
            `(hay numeros repetidos en la tabla viajes): ${err?.sqlMessage ?? err}`
        )
      );
  }

  // Plantillas creadas antes de que existiera la ruta explicita: se llena con
  // lo que antes se deducia (municipio del remitente y del destinatario) para
  // que no queden nulas. Solo toca las vacias, asi que correrlo en cada
  // arranque no pisa una ruta corregida a mano. Los codigos que no tienen 8
  // digitos se dejan fuera: no caben en la columna y tampoco son validos.
  await pool.query(
    `UPDATE plantillas_viaje p
       JOIN terceros tr ON tr.id = p.remitenteId
        SET p.municipioOrigen = tr.codMunicipioRndc
      WHERE p.municipioOrigen IS NULL
        AND tr.codMunicipioRndc REGEXP '^[0-9]{8}$'`
  );
  await pool.query(
    `UPDATE plantillas_viaje p
       JOIN terceros td ON td.id = p.destinatarioId
        SET p.municipioDestino = td.codMunicipioRndc
      WHERE p.municipioDestino IS NULL
        AND td.codMunicipioRndc REGEXP '^[0-9]{8}$'`
  );

  await unificarCollation();
}

/**
 * Deja todas las tablas con la misma collation que la tabla viajes.
 *
 * Por que: las tablas que se crean en un arranque toman la collation por
 * defecto del servidor (en MySQL 8 es utf8mb4_0900_ai_ci), pero las que venian
 * de antes pueden tener otra (utf8mb4_general_ci, como en MariaDB). Al
 * comparar textos de dos tablas distintas en una consulta, MySQL responde
 * "Illegal mix of collations ... for operation '='". Convirtiendo las que no
 * coinciden, todas quedan iguales (solo se tocan las distintas, que suelen ser
 * las nuevas y pequenas). Si algo falla se avisa y el sistema sigue.
 */
async function unificarCollation(): Promise<void> {
  try {
    const [ref] = await pool.query<RowDataPacket[]>(
      `SELECT TABLE_COLLATION AS collation FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'viajes'`
    );
    const collation: string | undefined = ref[0]?.collation;
    if (!collation || !/^[a-z0-9_]+$/i.test(collation)) return;
    const juego = collation.split("_")[0];
    const [distintas] = await pool.query<RowDataPacket[]>(
      `SELECT TABLE_NAME AS tabla FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_COLLATION <> ?`,
      [collation]
    );
    // Columnas sueltas con otra collation (agregadas con ALTER en otro momento).
    const [columnas] = await pool.query<RowDataPacket[]>(
      `SELECT DISTINCT TABLE_NAME AS tabla FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND COLLATION_NAME IS NOT NULL AND COLLATION_NAME <> ?`,
      [collation]
    );
    const tablas = [...new Set([...distintas, ...columnas].map((t) => String(t.tabla)))];
    for (const tabla of tablas) {
      await pool.query(`ALTER TABLE \`${tabla}\` CONVERT TO CHARACTER SET ${juego} COLLATE ${collation}`);
      console.log(`Collation: tabla ${tabla} convertida a ${collation}.`);
    }
  } catch (err) {
    console.warn("AVISO: no se pudo unificar la collation de las tablas:", (err as Error).message);
  }
}
