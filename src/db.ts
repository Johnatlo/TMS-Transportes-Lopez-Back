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
import { DUENOS, PLACAS_POR_DUENO } from "./duenos";
import { correosSiempreTotal, EMPRESA_INICIAL, NOMBRES_TOTAL_INICIAL, VISIBLES_PARA_TODOS_INICIAL } from "./roles";

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
  // Inspeccion preoperacional de vehiculos (ver src/preoperacional.ts): una por
  // viaje despachado, con las respuestas en JSON; y la base importada de la
  // Matriz Control Integral (respuestas por placa y conductor, y EPS / ARL /
  // pension por cedula) para sugerir las respuestas.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS preoperacionales (
      id INT AUTO_INCREMENT PRIMARY KEY,
      viajeId INT NULL,
      fecha DATE NOT NULL,
      placa VARCHAR(15) NOT NULL,
      conductor VARCHAR(150) NOT NULL,
      aprobo TINYINT(1) NOT NULL DEFAULT 1,
      respuestas MEDIUMTEXT NOT NULL,
      creadoPorId INT,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_preop_viaje (viajeId),
      KEY idx_preop_placa (placa),
      KEY idx_preop_fecha (fecha)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS preoperacional_base (
      id INT AUTO_INCREMENT PRIMARY KEY,
      placa VARCHAR(15) NOT NULL,
      conductor VARCHAR(150) NOT NULL DEFAULT '',
      respuestas MEDIUMTEXT NOT NULL,
      KEY idx_preop_base_placa (placa)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS preoperacional_conductores (
      cedula VARCHAR(20) PRIMARY KEY,
      nombre VARCHAR(150) NOT NULL DEFAULT '',
      eps VARCHAR(80),
      arl VARCHAR(80),
      pension VARCHAR(80)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Descuento por galon de cada bomba (estacion), con vigencia (ver
  // anticipos.descuentosGalon): solo Chuzaca lo tiene. Un cambio agrega una
  // fila que rige desde una fecha; los anticipos ya cruzados no cambian.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS descuentos_galon_bomba (
      id INT AUTO_INCREMENT PRIMARY KEY,
      bombaId INT NOT NULL,
      descuentoGalon DOUBLE NOT NULL DEFAULT 0,
      vigenteDesde DATE,
      KEY idx_descuento_bomba (bombaId),
      CONSTRAINT fk_descuento_bomba FOREIGN KEY (bombaId) REFERENCES bombas(id) ON DELETE CASCADE
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
  // Cruce con la bomba (ver src/relacionesBomba.ts): cada relacion quincenal
  // de vales que manda la bomba (una por factura, p. ej. AE5044797) y sus
  // vales, cada uno con el tramo de anticipo con que se cruzo.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bomba_relaciones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      numero VARCHAR(40) NOT NULL UNIQUE,
      fecha DATE NOT NULL,
      total DOUBLE NOT NULL,
      fechaPago DATE,
      nota VARCHAR(200),
      creadoPorId INT,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bomba_relacion_vales (
      id INT AUTO_INCREMENT PRIMARY KEY,
      relacionId INT NOT NULL,
      eds VARCHAR(80),
      vale VARCHAR(40),
      fecha DATE NOT NULL,
      hora VARCHAR(8),
      placa VARCHAR(15) NOT NULL,
      galones DOUBLE,
      valor DOUBLE NOT NULL,
      cuadroAnticipoId INT,
      tipo VARCHAR(12) NOT NULL DEFAULT 'COMBUSTIBLE',
      UNIQUE KEY uq_vale_tramo_tipo (cuadroAnticipoId, tipo),
      CONSTRAINT fk_vale_relacion FOREIGN KEY (relacionId) REFERENCES bomba_relaciones(id) ON DELETE CASCADE,
      CONSTRAINT fk_vale_tramo FOREIGN KEY (cuadroAnticipoId) REFERENCES cuadro_anticipos(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Matriz Comisiones de la rentabilidad (ver src/rentabilidad.ts): por
  // cliente, la comision y T. Lopez que se cobran una vez por remision.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rentabilidad_comisiones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cliente VARCHAR(160) NOT NULL,
      comision DOUBLE NOT NULL DEFAULT 0,
      tLopez DOUBLE NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Liquidaciones a los duenos (ver src/liquidacionDuenos.ts): foto en JSON de
  // los viajes y conceptos, y el saldo pendiente que pasa a la siguiente.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS liquidaciones_duenos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      grupo VARCHAR(40) NOT NULL,
      nombre VARCHAR(80) NOT NULL,
      fecha DATE NOT NULL,
      filas MEDIUMTEXT NOT NULL,
      conceptos MEDIUMTEXT NOT NULL,
      totalViajes DOUBLE NOT NULL,
      total DOUBLE NOT NULL,
      pagado DOUBLE NOT NULL,
      saldoPendiente DOUBLE NOT NULL,
      creadaEn TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_liquidacion_grupo (grupo)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Matriz Retenciones de la rentabilidad: ReteICA por mil de cada cliente.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rentabilidad_retenciones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cliente VARCHAR(160) NOT NULL,
      reteicaPorMil DOUBLE NOT NULL DEFAULT 0,
      ciudad VARCHAR(160)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Pago a la bomba (ver pagos en src/relacionesBomba.ts): cada quincena se
  // pagan varias facturas (relaciones) de la bomba de una vez, descontando
  // los abonos que hicieron los socios. bomba_relaciones.pagoId y
  // abonos_socio.pagoId dicen en que pago quedo cada una.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bomba_pagos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      fecha DATE NOT NULL,
      totalFacturas DOUBLE NOT NULL,
      totalAbonos DOUBLE NOT NULL DEFAULT 0,
      valorPagado DOUBLE NOT NULL,
      referencia VARCHAR(80),
      creadoPorId INT,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  // Los anticipos del cliente, uno por transferencia (valor y fecha en que el
  // cliente transfirio), que se pueden borrar. La factura descuenta la suma.
  // origen: MANUAL (en la cartera), EXCEL (de la importacion) o ANTERIOR (el
  // valor unico que habia antes, sin fecha).
  const [conRegistros] = await pool.query(
    `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cartera_anticipos_cliente_registros'`
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cartera_anticipos_cliente_registros (
      id INT AUTO_INCREMENT PRIMARY KEY,
      facturaNumero VARCHAR(30) NOT NULL,
      empresa VARCHAR(200) NOT NULL,
      valor DOUBLE NOT NULL,
      fecha DATE,
      origen VARCHAR(10) NOT NULL DEFAULT 'MANUAL',
      creadoPorId INT,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_anticipo_factura (facturaNumero, empresa)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Notas credito: por ley, cada factura anulada se reemplaza con una nota
  // credito. Se guarda su consecutivo y fecha, la factura que anula (numero y
  // cliente, como la cartera), la factura que la reemplaza, el valor y el motivo.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notas_credito (
      id INT AUTO_INCREMENT PRIMARY KEY,
      numero VARCHAR(40) NOT NULL,
      fecha DATE NOT NULL,
      empresa VARCHAR(200) NOT NULL,
      facturaAnulada VARCHAR(30) NOT NULL,
      facturaReemplazo VARCHAR(30),
      valor DOUBLE,
      motivo VARCHAR(300),
      creadoPorId INT,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_nota_factura (facturaAnulada, empresa)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Una sola vez: el anticipo que ya tenia cada factura queda como un registro (sin fecha).
  if ((conRegistros as unknown[]).length === 0) {
    await pool.query(
      `INSERT INTO cartera_anticipos_cliente_registros (facturaNumero, empresa, valor, origen)
       SELECT facturaNumero, empresa, valor, 'ANTERIOR' FROM cartera_anticipos_cliente WHERE valor > 0`
    );
  }

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
    // Ya se paso el descuento por galon de arriba a la bomba de Chuzaca (una sola vez).
    ["parametros_empresa", "descuentosBombaMigrado", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["cuadro_viajes", "tarifaFleteId", "INT"],
    ["cuadro_viajes", "pesoFacturadoKg", "DOUBLE"],
    ["cuadro_viajes", "notaFactura", "VARCHAR(300)"],
    ["cuadro_viajes", "enviadoFacturarEn", "DATETIME"],
    // Quitado del envio a facturacion (no se factura: p. ej. el manifiesto se anulo): cuando, quien y por que.
    ["cuadro_viajes", "sinFacturarEn", "DATETIME"],
    ["cuadro_viajes", "sinFacturarPorId", "INT"],
    ["cuadro_viajes", "sinFacturarMotivo", "VARCHAR(200)"],
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
    // Radicado de la anulacion del cumplido del manifiesto (proceso 29), al
    // anular un viaje que ya estaba cumplido.
    ["viajes", "radicadoAnulacionCumplidoManifiesto", "VARCHAR(30)"],
    // Manifiesto de contingencia (ver src/contingencia.ts): cuando se imprimio
    // uno propio porque el RNDC no dejo expedir o imprimir, y por que. Se
    // limpia al imprimir el oficial.
    ["viajes", "contingenciaEn", "DATETIME"],
    ["viajes", "contingenciaMotivo", "VARCHAR(300)"],
    // Anticipo que da la empresa (cliente) en algunos viajes: los del Zorro
    // (Ecoambiental, Reciclajes Bogota, Bodegas de Reciclaje), Aburra Limpio y
    // los viajes sin manifiesto. Es aparte de los anticipos de la bomba; la
    // empresa lo debe hasta que se registra la fecha en que lo pago.
    ["cuadro_viajes", "anticipoEmpresa", "DOUBLE"],
    ["cuadro_viajes", "anticipoEmpresaFechaPago", "DATE"],
    // El viaje no lleva anticipo de la empresa (por ejemplo, un urbano).
    ["cuadro_viajes", "anticipoEmpresaNoAplica", "TINYINT(1) NOT NULL DEFAULT 0"],
    // Pago a terceros (ver src/terceros.ts): valor pactado con el tercero
    // (por tonelada o fijo), adicional por transferencia (con fecha y enlace
    // al comprobante), entrega de documentos, cuenta de cobro, si se le
    // descuentan las retenciones, su ICA por mil y la fecha de pago escrita a
    // mano (si no, el viernes que toca). La fecha real es fechaPagoSaldo.
    ["cuadro_viajes", "valorTerceroTon", "DOUBLE"],
    ["cuadro_viajes", "valorTerceroFijo", "DOUBLE"],
    ["cuadro_viajes", "anticipoTransferencia", "DOUBLE"],
    ["cuadro_viajes", "anticipoTransferenciaFecha", "DATE"],
    ["cuadro_viajes", "anticipoTransferenciaLink", "VARCHAR(500)"],
    ["cuadro_viajes", "fechaEntregaDocsTercero", "DATE"],
    ["cuadro_viajes", "cuentaCobroTercero", "VARCHAR(40)"],
    ["cuadro_viajes", "aplicaDescuentosTercero", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["cuadro_viajes", "icaTerceroPorMil", "DOUBLE"],
    ["cuadro_viajes", "fechaPagoTerceroProgramada", "DATE"],
    // Rentabilidad (ver src/rentabilidad.ts): lo escrito a mano en el viaje
    // (vacio = el valor de siempre: matriz de comisiones, descargue CAME,
    // poliza RCE, ReteICA del cliente) y cuando se repartio la ganancia.
    ["cuadro_viajes", "rentComision", "DOUBLE"],
    ["cuadro_viajes", "rentTLopez", "DOUBLE"],
    ["cuadro_viajes", "rentDescargue", "DOUBLE"],
    ["cuadro_viajes", "rentPoliza", "DOUBLE"],
    ["cuadro_viajes", "rentIcaPorMil", "DOUBLE"],
    ["cuadro_viajes", "fechaPagoRentabilidad", "DATE"],
    // Retenciones corregidas o desmarcadas (JSON por retencion) y otros
    // descuentos al tercero o dueno, con su concepto.
    ["cuadro_viajes", "rentRetenciones", "VARCHAR(800)"],
    ["cuadro_viajes", "rentOtrosDescuentos", "DOUBLE"],
    ["cuadro_viajes", "rentOtrosConcepto", "VARCHAR(200)"],
    // Peso vacio del remolque: el RNDC lo exige al registrarlo (VEH090).
    ["remolques", "pesoVehiculoVacio", "DOUBLE"],
    // El flete se escribio o se eligio a mano: la deduccion de la matriz no lo toca (ver src/tarifasFlete.ts).
    ["cuadro_viajes", "fleteManual", "TINYINT(1) NOT NULL DEFAULT 0"],
    // Matrices con vigencia (ver src/vigencias.ts): desde cuando rige cada fila
    // (null = desde siempre) y si desde esa fecha se quito.
    ["rentabilidad_comisiones", "vigenteDesde", "DATE"],
    ["rentabilidad_comisiones", "eliminado", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["rentabilidad_retenciones", "vigenteDesde", "DATE"],
    ["rentabilidad_retenciones", "eliminado", "TINYINT(1) NOT NULL DEFAULT 0"],
    // Revisado en Rentabilidad: quien y cuando (ver cuadro.revisar).
    ["cuadro_viajes", "rentRevisadoPorId", "INT"],
    ["cuadro_viajes", "rentRevisadoEn", "DATETIME"],
    // Reconocidos de Cartones America (ver generarReconocidosCorame en
    // src/cuadro.ts): viajes sin manifiesto que se generan solos por cada
    // manifiesto despachado desde alla con 4 o mas clientes (+2 toneladas) o
    // con menos de 32.000 kg (lo que falta). concepto es lo que dice la fila.
    ["cuadro_viajes", "concepto", "VARCHAR(120)"],
    ["cuadro_viajes", "reconocidoDeViajeId", "INT"],
    ["cuadro_viajes", "reconocidoTipo", "VARCHAR(12)"],
    // La bomba da combustible y efectivo: cada vale es de uno de los dos. El
    // efectivo cruzado guarda lo que se habia registrado antes, como el combustible.
    ["bomba_relacion_vales", "tipo", "VARCHAR(12) NOT NULL DEFAULT 'COMBUSTIBLE'"],
    ["cuadro_anticipos", "efectivoEntregado", "DOUBLE"],
    // Pago a la bomba en que quedo cada factura y cada abono del socio.
    ["bomba_relaciones", "pagoId", "INT"],
    ["abonos_socio", "pagoId", "INT"],
    // Abono del socio cruzado a mano (sin pago a la bomba): desde esa fecha se descuenta de la deuda.
    ["abonos_socio", "cruzadoFecha", "DATE"],
    // Tramo de anticipo marcado a mano como cruzado con la bomba (sin vale): fecha en que se marco.
    ["cuadro_anticipos", "cruzadoManual", "DATE"],
    // Roles (ver src/roles.ts): TOTAL, ADMINISTRATIVO o MYC.
    ["usuarios", "rol", "VARCHAR(20) NOT NULL DEFAULT 'ADMINISTRATIVO'"],
    // Fecha desde la que se registran gastos (los de antes se cargaran despues).
    ["parametros_empresa", "gastosDesde", "DATE NOT NULL DEFAULT '2026-10-01'"],
    // Gastos de la nomina: causados por dias hasta causaHasta, y de que nomina salen.
    ["gastos", "causaHasta", "DATE"],
    ["gastos", "nominaId", "INT"],
    // Producido de la nomina desde los viajes del sistema (o escrito a mano).
    ["nominas", "producidoDesde", "DATE"],
    ["nominas", "producidoHasta", "DATE"],
    ["nomina_lineas", "producidoManual", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["nomina_lineas", "detalleProducido", "TEXT"],
    // Conceptos que no van al gasto, UPC adicional (y el vehiculo al que va) y el reparto del conductor entre vehiculos.
    ["nomina_lineas", "excluidos", "TEXT"],
    ["nomina_lineas", "upcAdicional", "DECIMAL(15,2) NOT NULL DEFAULT 0"],
    // UPC adicional por beneficiario ([{ cedula, nombre, valor, vehiculoId }]); upcAdicional es su suma.
    ["nomina_lineas", "upcs", "TEXT"],
    ["nomina_lineas", "reparto", "TEXT"],
    // Socios externos (solo estan en una sociedad, no en la empresa) y sus datos.
    ["socios", "externo", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["socios", "documento", "VARCHAR(20)"],
    ["socios", "nota", "VARCHAR(300)"],
    // Lo que el socio debia (o se le debia) antes del sistema, y el 4 x 1000 que se descuenta al repartir.
    ["socios", "saldoInicial", "DECIMAL(15,2) NOT NULL DEFAULT 0"],
    ["parametros_empresa", "gmfPorMil", "DECIMAL(7,3) NOT NULL DEFAULT 4"],
    // Creditos: 4 x 1000 de cada cuota y lo que de verdad se pago (la tasa cambia mes a mes).
    ["creditos", "gmfPorMil", "DECIMAL(7,3) NOT NULL DEFAULT 4"],
    ["creditos_cuotas", "valorPagado", "DECIMAL(15,2)"],
    // Tiempos pactados de cada remesa si se cambian al despachar (vacios = los de la plantilla).
    ["viaje_remesas", "horasPactoCargue", "INT"],
    // Links (Drive) de la remision escaneada y de la factura de cada viaje del Cuadro pagos.
    ["cuadro_viajes", "remisionUrl", "VARCHAR(500)"],
    // El gasto del libro que sale de una cuenta de viaje (modulo Cuentas vehiculos).
    ["gastos", "cuentaViajeId", "INT"],
    // Tarifa que ya no viene en la matriz importada pero la usan viajes o la matriz de fletes conductor: queda, retirada.
    ["tarifas_flete", "retirada", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["cuadro_viajes", "facturaUrl", "VARCHAR(500)"],
    // Gastos: forma (unico, diferido, recurrente), quincenal, proveedor y factura (numero y credito o debito), y el recurrente que lo genero.
    ["gastos", "forma", "VARCHAR(10) NOT NULL DEFAULT 'UNICO'"],
    ["gastos", "periodicidad", "VARCHAR(10) NOT NULL DEFAULT 'MENSUAL'"],
    ["gastos", "proveedor", "VARCHAR(150)"],
    ["gastos", "numeroFactura", "VARCHAR(40)"],
    ["gastos", "tipoFactura", "VARCHAR(10)"],
    ["gastos", "recurrenteId", "INT"],
    ["gastos", "periodo", "DATE"],
    ["viaje_remesas", "minutosPactoCargue", "INT"],
    ["viaje_remesas", "horasPactoDescargue", "INT"],
    ["viaje_remesas", "minutosPactoDescargue", "INT"],
    // Empresa que liquida el vehiculo (LOPEZ o MYC; NULL = tercero) y si lo ven todos los roles.
    ["vehiculos", "empresa", "VARCHAR(10)"],
    ["vehiculos", "visibleTodos", "TINYINT(1) NOT NULL DEFAULT 0"],
    // Fecha de vencimiento de la factura de la bomba: avisa cuando hay que pagarla.
    ["bomba_relaciones", "fechaVencimiento", "DATE"],
    // Una sola vez: las facturas de la bomba cruzadas solo con el combustible toman el efectivo registrado (ver abajo).
    ["parametros_empresa", "efectivoBombaMigrado", "TINYINT(1) NOT NULL DEFAULT 0"],
    // Tarifa que siempre se factura con el mismo peso (PEGANTE URBANO: 33.000 kg).
    ["tarifas_flete", "pesoFijoKg", "INT"],
    // Tarifa urbana aunque su nombre no diga URBANO (COOP DE LA SABANA): sus viajes no llevan poliza RCE.
    ["tarifas_flete", "urbano", "TINYINT(1) NOT NULL DEFAULT 0"],
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

  // ---------- Gastos, prorrateo y creditos (ver src/gastos.ts) ----------
  // Socios: a quien va una parte directa de un gasto (y, despues, el reparto de utilidades).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS socios (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(80) NOT NULL UNIQUE,
      activo TINYINT(1) NOT NULL DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query("INSERT IGNORE INTO socios (nombre) VALUES ?", [DUENOS.map((d) => [d])]);
  // Libro de gastos: el movimiento (flujo de caja por fechaPago). Montos en DECIMAL.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gastos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      empresa VARCHAR(10) NOT NULL,
      tipo VARCHAR(10) NOT NULL DEFAULT 'GASTO',
      categoria VARCHAR(20) NOT NULL,
      descripcion VARCHAR(300) NOT NULL,
      monto DECIMAL(15,2) NOT NULL,
      fechaPago DATE,
      soporteUrl VARCHAR(500),
      causaDesde DATE NOT NULL,
      causaCuotas INT NOT NULL DEFAULT 1,
      destinos TEXT NOT NULL,
      origen VARCHAR(12) NOT NULL DEFAULT 'MANUAL',
      creditoId INT,
      anulado TINYINT(1) NOT NULL DEFAULT 0,
      creadoPorId INT,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_gasto_empresa (empresa, causaDesde)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Causaciones: a que mes corresponde cada parte del gasto (rentabilidad por fecha de causacion).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gastos_causaciones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      gastoId INT NOT NULL,
      fecha DATE NOT NULL,
      monto DECIMAL(15,2) NOT NULL,
      INDEX idx_causacion_fecha (fecha),
      CONSTRAINT fk_causacion_gasto FOREIGN KEY (gastoId) REFERENCES gastos(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Reparto ya calculado: cuanto le toco a cada vehiculo o socio en cada causacion. No se recalcula solo.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gastos_reparto (
      id INT AUTO_INCREMENT PRIMARY KEY,
      gastoId INT NOT NULL,
      causacionId INT NOT NULL,
      fecha DATE NOT NULL,
      vehiculoId INT,
      socioId INT,
      monto DECIMAL(15,2) NOT NULL,
      INDEX idx_reparto_vehiculo (vehiculoId, fecha),
      INDEX idx_reparto_socio (socioId, fecha),
      CONSTRAINT fk_reparto_gasto FOREIGN KEY (gastoId) REFERENCES gastos(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Meses cerrados ("AAAA-MM"): sus gastos no se cambian.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS periodos_cierre (
      mes CHAR(7) PRIMARY KEY,
      cerradoPorId INT,
      cerradoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Creditos y su tabla de amortizacion (capital, interes y saldo por cuota).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS creditos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      empresa VARCHAR(10) NOT NULL,
      nombre VARCHAR(150) NOT NULL,
      entidad VARCHAR(100),
      obligacion VARCHAR(60),
      monto DECIMAL(15,2) NOT NULL,
      tasaMensual DECIMAL(9,6) NOT NULL,
      plazo INT NOT NULL,
      primeraCuota DATE NOT NULL,
      cuotaFija DECIMAL(15,2),
      prorratea VARCHAR(20) NOT NULL DEFAULT 'CAPITAL_E_INTERES',
      destinos TEXT NOT NULL,
      nota VARCHAR(300),
      creadoPorId INT,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS creditos_cuotas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      creditoId INT NOT NULL,
      numero INT NOT NULL,
      fecha DATE NOT NULL,
      cuota DECIMAL(15,2) NOT NULL,
      capital DECIMAL(15,2) NOT NULL,
      interes DECIMAL(15,2) NOT NULL,
      saldo DECIMAL(15,2) NOT NULL,
      fechaPago DATE,
      gastoId INT,
      UNIQUE KEY uq_credito_cuota (creditoId, numero),
      CONSTRAINT fk_cuota_credito FOREIGN KEY (creditoId) REFERENCES creditos(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ---------- Participaciones y reparto de utilidades (ver src/utilidades.ts) ----------
  const [habiaParticipaciones] = await pool.query(
    "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'participaciones'"
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS participaciones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      vehiculoId INT NOT NULL,
      socioId INT NOT NULL,
      porcentaje DECIMAL(7,4) NOT NULL,
      desde DATE NOT NULL,
      hasta DATE,
      INDEX idx_participacion_vehiculo (vehiculoId, desde)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Una sola vez: cada vehiculo propio al 100 % de su dueno (si el dueno es un socio). Las sociedades se registran en la pantalla.
  if ((habiaParticipaciones as unknown[]).length === 0) {
    await pool.query(
      `INSERT INTO participaciones (vehiculoId, socioId, porcentaje, desde)
       SELECT v.id, s.id, 100, '2000-01-01' FROM vehiculos v JOIN socios s ON s.nombre = UPPER(TRIM(v.dueno))
        WHERE v.eliminado = 0 AND v.empresa IS NOT NULL`
    );
  }
  // Pagos hechos a cada socio (o lo que el socio devolvio, en negativo): la cuenta del socio.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pagos_socios (
      id INT AUTO_INCREMENT PRIMARY KEY,
      socioId INT NOT NULL,
      fecha DATE NOT NULL,
      monto DECIMAL(15,2) NOT NULL,
      nota VARCHAR(300),
      soporteUrl VARCHAR(500),
      creadoPorId INT,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_pago_socio (socioId, fecha)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Fondo de cada vehiculo: base que no se reparte y saldo con que arranca.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fondos_vehiculo (
      vehiculoId INT PRIMARY KEY,
      base DECIMAL(15,2) NOT NULL DEFAULT 10000000,
      saldoInicial DECIMAL(15,2) NOT NULL DEFAULT 0,
      nota VARCHAR(300)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Gastos recurrentes (arriendo, honorarios, servicios) y el historial de su valor.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gastos_recurrentes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      empresa VARCHAR(10) NOT NULL,
      tipo VARCHAR(10) NOT NULL DEFAULT 'GASTO',
      categoria VARCHAR(20) NOT NULL,
      descripcion VARCHAR(300) NOT NULL,
      proveedor VARCHAR(150),
      tipoFactura VARCHAR(10),
      destinos TEXT NOT NULL,
      periodicidad VARCHAR(10) NOT NULL DEFAULT 'MENSUAL',
      desde DATE NOT NULL,
      hasta DATE,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      creadoPorId INT,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gastos_recurrentes_valores (
      id INT AUTO_INCREMENT PRIMARY KEY,
      recurrenteId INT NOT NULL,
      desde DATE NOT NULL,
      monto DECIMAL(15,2) NOT NULL,
      creadoPorId INT,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_valor_recurrente FOREIGN KEY (recurrenteId) REFERENCES gastos_recurrentes(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Foto del reparto aprobado de cada mes.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS repartos_utilidades (
      mes CHAR(7) PRIMARY KEY,
      datos LONGTEXT NOT NULL,
      aprobadoPorId INT,
      aprobadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ---------- Empleados y nomina (ver src/nomina.ts) ----------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS empleados (
      id INT AUTO_INCREMENT PRIMARY KEY,
      empresa VARCHAR(10) NOT NULL,
      tipo VARCHAR(10) NOT NULL DEFAULT 'CONDUCTOR',
      nombre VARCHAR(150) NOT NULL,
      cedula VARCHAR(20),
      cargo VARCHAR(80),
      conductorId INT,
      riesgoArl TINYINT NOT NULL DEFAULT 4,
      salarioBase DECIMAL(15,2),
      salarioAdicional DECIMAL(15,2) NOT NULL DEFAULT 0,
      pctSalarial DECIMAL(7,3) NOT NULL DEFAULT 0,
      pctViaticos DECIMAL(7,3) NOT NULL DEFAULT 0,
      auxilio TINYINT(1) NOT NULL DEFAULT 0,
      destinos TEXT,
      fechaIngreso DATE NOT NULL,
      fechaRetiro DATE,
      nota VARCHAR(300),
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Vehiculo de cada conductor con fechas (un conductor puede cambiar de carro).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS empleados_vehiculos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      empleadoId INT NOT NULL,
      vehiculoId INT NOT NULL,
      desde DATE NOT NULL,
      hasta DATE,
      CONSTRAINT fk_asignacion_empleado FOREIGN KEY (empleadoId) REFERENCES empleados(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Liquidacion de conductores (modulo Cuentas vehiculos): matriz de fletes conductor (aparte de la de la empresa,
  // con su vigencia), cuentas de viaje (la hoja de gastos del conductor), prestamos al conductor con lo que se
  // descuenta cada mes, y la liquidacion pagada de cada conductor y mes.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fletes_conductor (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tarifaFleteId INT NOT NULL,
      valor DECIMAL(15,2) NOT NULL,
      tipo VARCHAR(5) NOT NULL DEFAULT 'TON',
      desde DATE NOT NULL,
      creadoPorId INT,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_flete_conductor (tarifaFleteId, desde),
      CONSTRAINT fk_flete_conductor_tarifa FOREIGN KEY (tarifaFleteId) REFERENCES tarifas_flete(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cuentas_viaje (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cuadroViajeId INT NOT NULL,
      producidoManual DECIMAL(15,2),
      acpm DECIMAL(15,2),
      peajes DECIMAL(15,2) NOT NULL DEFAULT 0,
      cargue DECIMAL(15,2) NOT NULL DEFAULT 0,
      descargue DECIMAL(15,2) NOT NULL DEFAULT 0,
      parqueo DECIMAL(15,2) NOT NULL DEFAULT 0,
      llantas DECIMAL(15,2) NOT NULL DEFAULT 0,
      lavada DECIMAL(15,2) NOT NULL DEFAULT 0,
      comision DECIMAL(15,2) NOT NULL DEFAULT 0,
      engrase DECIMAL(15,2) NOT NULL DEFAULT 0,
      propinas DECIMAL(15,2) NOT NULL DEFAULT 0,
      arreglos DECIMAL(15,2) NOT NULL DEFAULT 0,
      accesorios DECIMAL(15,2) NOT NULL DEFAULT 0,
      otros DECIMAL(15,2) NOT NULL DEFAULT 0,
      otrosConcepto VARCHAR(200),
      nota VARCHAR(300),
      gastoId INT,
      actualizadoPorId INT,
      actualizadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_cuenta_viaje (cuadroViajeId),
      CONSTRAINT fk_cuenta_viaje FOREIGN KEY (cuadroViajeId) REFERENCES cuadro_viajes(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prestamos_empleado (
      id INT AUTO_INCREMENT PRIMARY KEY,
      empleadoId INT NOT NULL,
      fecha DATE NOT NULL,
      monto DECIMAL(15,2) NOT NULL,
      cuota DECIMAL(15,2),
      nota VARCHAR(300),
      creadoPorId INT,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_prestamo_empleado FOREIGN KEY (empleadoId) REFERENCES empleados(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prestamos_descuentos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      prestamoId INT NOT NULL,
      mes CHAR(7) NOT NULL,
      valor DECIMAL(15,2) NOT NULL,
      creadoPorId INT,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_descuento_mes (prestamoId, mes),
      CONSTRAINT fk_descuento_prestamo FOREIGN KEY (prestamoId) REFERENCES prestamos_empleado(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS liquidaciones_conductor (
      id INT AUTO_INCREMENT PRIMARY KEY,
      empleadoId INT NOT NULL,
      mes CHAR(7) NOT NULL,
      fechaPago DATE NOT NULL,
      total DECIMAL(15,2) NOT NULL,
      detalle TEXT,
      creadoPorId INT,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_liquidacion_mes (empleadoId, mes),
      CONSTRAINT fk_liquidacion_empleado FOREIGN KEY (empleadoId) REFERENCES empleados(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Parametros de nomina por ano (porcentajes en %).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS parametros_nomina (
      anio INT PRIMARY KEY,
      smmlv DECIMAL(15,2) NOT NULL,
      auxilioTransporte DECIMAL(15,2) NOT NULL,
      pensionEmpleador DECIMAL(7,3) NOT NULL,
      saludEmpleador DECIMAL(7,3) NOT NULL,
      arl1 DECIMAL(7,3) NOT NULL,
      arl2 DECIMAL(7,3) NOT NULL,
      arl3 DECIMAL(7,3) NOT NULL,
      arl4 DECIMAL(7,3) NOT NULL,
      arl5 DECIMAL(7,3) NOT NULL,
      caja DECIMAL(7,3) NOT NULL,
      prima DECIMAL(7,3) NOT NULL,
      cesantias DECIMAL(7,3) NOT NULL,
      interesesCesantias DECIMAL(7,3) NOT NULL,
      vacaciones DECIMAL(7,3) NOT NULL,
      saludEmpleado DECIMAL(7,3) NOT NULL,
      pensionEmpleado DECIMAL(7,3) NOT NULL,
      limiteNoSalarial DECIMAL(7,3) NOT NULL DEFAULT 40
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // 2025 y 2026 (del Excel de nomina); se cambian en la pantalla. INSERT IGNORE: no pisa lo que se edite.
  await pool.query(
    `INSERT IGNORE INTO parametros_nomina (anio, smmlv, auxilioTransporte, pensionEmpleador, saludEmpleador, arl1, arl2, arl3, arl4, arl5,
       caja, prima, cesantias, interesesCesantias, vacaciones, saludEmpleado, pensionEmpleado, limiteNoSalarial) VALUES ?`,
    [
      [
        [2025, 1423500, 200000, 12, 0, 0.522, 1.044, 2.436, 4.35, 6.96, 4, 8.33, 8.33, 12, 4.17, 4, 4, 40],
        [2026, 1750905, 249095, 12, 0, 0.522, 1.044, 2.436, 4.35, 6.96, 4, 8.33, 8.33, 12, 4.17, 4, 4, 40],
      ],
    ],
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nominas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      desde DATE NOT NULL,
      hasta DATE NOT NULL,
      estado VARCHAR(10) NOT NULL DEFAULT 'BORRADOR',
      nota VARCHAR(300),
      parametros TEXT,
      creadoPorId INT,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      aprobadaPorId INT,
      aprobadaEn DATETIME
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // Una linea por empleado; al aprobar se guarda lo que entro al calculo y el resultado.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nomina_lineas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nominaId INT NOT NULL,
      empleadoId INT NOT NULL,
      vehiculoId INT,
      dias DECIMAL(5,2) NOT NULL DEFAULT 30,
      producido DECIMAL(15,2) NOT NULL DEFAULT 0,
      ajuste DECIMAL(15,2) NOT NULL DEFAULT 0,
      notaAjuste VARCHAR(300),
      entrada TEXT,
      calculo TEXT,
      gastoId INT,
      UNIQUE KEY uq_nomina_empleado (nominaId, empleadoId),
      CONSTRAINT fk_linea_nomina FOREIGN KEY (nominaId) REFERENCES nominas(id) ON DELETE CASCADE
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
  // Al crear el cruce de los abonos del socio se pasan una sola vez los abonos
  // que ya habia al cuadro de anticipos del Zorro (ver despues del ciclo).
  const [conCruceAbono] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'abonos_socio' AND COLUMN_NAME = 'cruzadoFecha'`
  );
  const cruceAbonoEsNuevo = (conCruceAbono as unknown[]).length === 0;
  // Al crear los roles y la empresa de los vehiculos se llenan una sola vez (ver despues del ciclo).
  const [conRol] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios' AND COLUMN_NAME = 'rol'`
  );
  const rolEsNuevo = (conRol as unknown[]).length === 0;
  const [conEmpresa] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vehiculos' AND COLUMN_NAME = 'empresa'`
  );
  const empresaEsNuevo = (conEmpresa as unknown[]).length === 0;
  // ¿Ya existia el producido a mano de la nomina? Si no, los producidos ya escritos quedan como manuales (abajo).
  const [conProducidoManual] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nomina_lineas' AND COLUMN_NAME = 'producidoManual'`
  );
  const producidoManualEsNuevo = (conProducidoManual as unknown[]).length === 0;
  // ¿Ya existia la forma de los gastos? Si no, los que se causaban en varias cuotas quedan como diferidos (abajo).
  const [conForma] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gastos' AND COLUMN_NAME = 'forma'`
  );
  const formaEsNueva = (conForma as unknown[]).length === 0;

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

  // Una sola vez: los gastos que se causaban en varias cuotas quedan como diferidos.
  if (formaEsNueva) {
    await pool.query("UPDATE gastos SET forma = 'DIFERIDO' WHERE causaCuotas > 1 AND causaHasta IS NULL AND origen = 'MANUAL'");
  }
  // Una sola vez: lo que ya se habia escrito como producido en la nomina se respeta (queda como manual).
  if (producidoManualEsNuevo) {
    await pool.query("UPDATE nomina_lineas SET producidoManual = 1 WHERE producido > 0");
  }
  // La cuenta principal de la empresa siempre con acceso total (nunca queda el sistema sin quien administre).
  await pool.query("UPDATE usuarios SET rol = 'TOTAL' WHERE LOWER(email) IN (?) AND rol <> 'TOTAL'", [correosSiempreTotal()]);
  // Una sola vez: Principal y Admin con acceso total; los demas quedan administrativos (el valor por defecto).
  if (rolEsNuevo) {
    await pool.query("UPDATE usuarios SET rol = 'TOTAL' WHERE UPPER(TRIM(nombre)) IN (?)", [NOMBRES_TOTAL_INICIAL]);
  }
  // Una sola vez: la empresa de los vehiculos propios y el Volvo que ven todos.
  if (empresaEsNuevo) {
    for (const [empresa, placas] of Object.entries(EMPRESA_INICIAL)) {
      await pool.query("UPDATE vehiculos SET empresa = ? WHERE REPLACE(UPPER(placa), '-', '') IN (?)", [empresa, placas]);
    }
    await pool.query("UPDATE vehiculos SET visibleTodos = 1 WHERE REPLACE(UPPER(placa), '-', '') IN (?)", [VISIBLES_PARA_TODOS_INICIAL]);
  }

  // Correccion unica: los viajes de los abonos que ya habia quedan con el
  // anticipo del Zorro pagado (valor y fecha del abono), sin pisar lo escrito.
  if (cruceAbonoEsNuevo) {
    const [abonos] = await pool.query<RowDataPacket[]>("SELECT id FROM abonos_socio");
    if (abonos.length) {
      await pool.query(
        `UPDATE cuadro_viajes c
       JOIN (SELECT av.cuadroViajeId, SUM(av.valor) AS valor, MIN(a.fecha) AS fecha
               FROM abonos_socio_viajes av JOIN abonos_socio a ON a.id = av.abonoId
              WHERE av.abonoId IN (?) GROUP BY av.cuadroViajeId) x ON x.cuadroViajeId = c.id
        SET c.anticipoEmpresa = IF(c.anticipoEmpresa IS NULL OR c.anticipoEmpresa = 0, x.valor, c.anticipoEmpresa),
            c.anticipoEmpresaFechaPago = COALESCE(c.anticipoEmpresaFechaPago, x.fecha),
            c.anticipoEmpresaNoAplica = 0`,
        [abonos.map((a) => a.id)]
      );
    }
  }

  // La vuelta de un anticipo de ida y vuelta no tiene viaje todavia, y un
  // anticipo solo en efectivo no tiene bomba.
  await pool.query("ALTER TABLE cuadro_anticipos MODIFY cuadroViajeId INT NULL, MODIFY bombaId INT NULL").catch(() => undefined);
  // Fletes conductor: cabe INTEGRO (se le paga completo al conductor, sin %).
  await pool.query("ALTER TABLE fletes_conductor MODIFY tipo VARCHAR(10) NOT NULL DEFAULT 'TON'").catch(() => undefined);
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

  // Un tramo puede tener un vale de combustible y otro de efectivo: el indice
  // unico pasa de (tramo) a (tramo, tipo). Se crea el nuevo antes de quitar el
  // viejo, en la misma orden: la llave foranea siempre tiene un indice.
  const [valeViejo] = await pool.query(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bomba_relacion_vales' AND INDEX_NAME = 'uq_vale_tramo'`
  );
  if ((valeViejo as unknown[]).length > 0) {
    await pool.query("ALTER TABLE bomba_relacion_vales ADD UNIQUE KEY uq_vale_tramo_tipo (cuadroAnticipoId, tipo), DROP INDEX uq_vale_tramo");
  }

  // Un recurrente crea un solo gasto por periodo (aunque dos personas abran el libro al tiempo).
  const [indiceRecurrente] = await pool.query(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gastos' AND INDEX_NAME = 'uk_gasto_recurrente'`
  );
  if ((indiceRecurrente as unknown[]).length === 0) {
    await pool.query("ALTER TABLE gastos ADD UNIQUE KEY uk_gasto_recurrente (recurrenteId, periodo)");
  }

  // Un solo reconocido de Cartones America por manifiesto y tipo.
  const [indiceReconocido] = await pool.query(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cuadro_viajes' AND INDEX_NAME = 'uk_reconocido'`
  );
  if ((indiceReconocido as unknown[]).length === 0) {
    await pool.query("ALTER TABLE cuadro_viajes ADD UNIQUE KEY uk_reconocido (reconocidoDeViajeId, reconocidoTipo)");
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

  // El descuento por galon era uno solo para todas las bombas; ahora va por
  // bomba y solo Chuzaca lo tiene. Una sola vez: a las bombas de Chuzaca se
  // les pasa el valor que habia (desde siempre).
  const [[migracion]] = await pool.query<RowDataPacket[]>(
    "SELECT descuentosBombaMigrado AS hecho, descuentoGalonBomba AS valor FROM parametros_empresa WHERE id = 1"
  );
  if (migracion && !migracion.hecho) {
    await pool.query(
      "INSERT INTO descuentos_galon_bomba (bombaId, descuentoGalon) SELECT id, ? FROM bombas WHERE UPPER(nombre) REGEXP 'CHUSACA|CHUZACA'",
      [Number(migracion.valor ?? 0)]
    );
    await pool.query("UPDATE parametros_empresa SET descuentosBombaMigrado = 1 WHERE id = 1");
  }

  await efectivoEnFacturasBomba();

  await unificarCollation();
}

/**
 * Una sola vez: la relacion de la bomba (el PDF de COESCO) solo trae el
 * combustible y las facturas se cruzaron sin el efectivo, que la bomba si
 * cobra. A cada factura ya cruzada se le pone el efectivo registrado de sus
 * tanqueos (ya verificado): un vale de efectivo por tanqueo, sube el total de
 * la factura (y el del pago a la bomba en que va) y, si ya se pago, ese
 * efectivo queda pagado con ella. Las facturas nuevas ya lo traen al cruzarse.
 */
async function efectivoEnFacturasBomba(): Promise<void> {
  const [[p]] = await pool.query<RowDataPacket[]>("SELECT efectivoBombaMigrado AS hecho FROM parametros_empresa WHERE id = 1");
  if (!p || p.hecho) return;
  const conexion = await pool.getConnection();
  try {
    await conexion.beginTransaction();
    const [tramos] = await conexion.query<RowDataPacket[]>(
      `SELECT v.relacionId, r.pagoId, r.fechaPago, a.id AS tramoId, a.efectivo, a.fecha, v.eds, v.placa
         FROM bomba_relacion_vales v
         JOIN bomba_relaciones r ON r.id = v.relacionId
         JOIN cuadro_anticipos a ON a.id = v.cuadroAnticipoId
        WHERE v.tipo = 'COMBUSTIBLE' AND a.efectivo > 0
          AND NOT EXISTS (SELECT 1 FROM bomba_relacion_vales e WHERE e.cuadroAnticipoId = a.id AND e.tipo = 'EFECTIVO')`,
    );
    const porRelacion = new Map<number, number>();
    const porPago = new Map<number, number>();
    const hechos = new Set<number>();
    for (const t of tramos) {
      if (hechos.has(t.tramoId)) continue;
      hechos.add(t.tramoId);
      const valor = Number(t.efectivo);
      await conexion.query(
        `INSERT INTO bomba_relacion_vales (relacionId, tipo, eds, vale, fecha, hora, placa, galones, valor, cuadroAnticipoId)
         VALUES (?, 'EFECTIVO', ?, NULL, ?, NULL, ?, NULL, ?, ?)`,
        [t.relacionId, t.eds, t.fecha, t.placa, valor, t.tramoId],
      );
      await conexion.query("UPDATE cuadro_anticipos SET efectivoEntregado = COALESCE(efectivoEntregado, efectivo) WHERE id = ?", [t.tramoId]);
      if (t.fechaPago) await conexion.query("UPDATE cuadro_anticipos SET fechaPago = ? WHERE id = ?", [t.fechaPago, t.tramoId]);
      porRelacion.set(t.relacionId, (porRelacion.get(t.relacionId) ?? 0) + valor);
      if (t.pagoId) porPago.set(t.pagoId, (porPago.get(t.pagoId) ?? 0) + valor);
    }
    for (const [id, suma] of porRelacion) await conexion.query("UPDATE bomba_relaciones SET total = total + ? WHERE id = ?", [suma, id]);
    for (const [id, suma] of porPago)
      await conexion.query(
        "UPDATE bomba_pagos SET totalFacturas = totalFacturas + ?, valorPagado = GREATEST(0, ROUND(totalFacturas - totalAbonos)) WHERE id = ?",
        [suma, id],
      );
    await conexion.query("UPDATE parametros_empresa SET efectivoBombaMigrado = 1 WHERE id = 1");
    await conexion.commit();
    if (hechos.size) console.log(`Facturas de la bomba: ${hechos.size} tanqueo(s) con su efectivo en ${porRelacion.size} factura(s).`);
  } catch (err) {
    await conexion.rollback();
    console.warn("AVISO: no se pudo poner el efectivo en las facturas de la bomba:", (err as Error).message);
  } finally {
    conexion.release();
  }
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
