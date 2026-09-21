import mysql from "mysql2/promise";
import "dotenv/config";

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
  ];

  // Ajustes de columnas existentes (no son altas, son cambios de definicion).
  // rutaId dejo de ser obligatorio cuando el origen y el destino pasaron a
  // deducirse de los terceros.
  await pool.query("ALTER TABLE plantillas_viaje MODIFY rutaId INT NULL").catch(() => undefined);

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
}
