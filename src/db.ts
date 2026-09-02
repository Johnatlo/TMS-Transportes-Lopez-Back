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
});

export async function initSchema(): Promise<void> {
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
      rutaId INT NOT NULL,
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
      CONSTRAINT fk_viaje_plantilla FOREIGN KEY (plantillaId) REFERENCES plantillas_viaje(id),
      CONSTRAINT fk_viaje_vehiculo FOREIGN KEY (vehiculoId) REFERENCES vehiculos(id),
      CONSTRAINT fk_viaje_conductor FOREIGN KEY (conductorId) REFERENCES conductores(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Migraciones aditivas para bases de datos creadas con una version anterior del esquema.
  // MariaDB 10.0.2+ / MySQL 8.0.29+ soportan "ADD COLUMN IF NOT EXISTS".
  const migraciones = [
    `ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS codTipoIdTenedor VARCHAR(2) NOT NULL DEFAULT 'N'`,
    `ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS numIdTenedor VARCHAR(20)`,
    `ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS codTipoCarroceria VARCHAR(5) NOT NULL DEFAULT '0'`,
    `ALTER TABLE vehiculos ADD COLUMN IF NOT EXISTS pesoVehiculoVacio DOUBLE`,
    `ALTER TABLE conductores ADD COLUMN IF NOT EXISTS codTipoId VARCHAR(2) NOT NULL DEFAULT 'C'`,
    `ALTER TABLE terceros ADD COLUMN IF NOT EXISTS codTipoId VARCHAR(2) NOT NULL DEFAULT 'N'`,
    `ALTER TABLE terceros ADD COLUMN IF NOT EXISTS codSede VARCHAR(10) NOT NULL DEFAULT '0'`,
    `ALTER TABLE plantillas_viaje ADD COLUMN IF NOT EXISTS codOperacionTransporte VARCHAR(2) NOT NULL DEFAULT 'G'`,
    `ALTER TABLE plantillas_viaje ADD COLUMN IF NOT EXISTS codNaturalezaCarga VARCHAR(5) NOT NULL DEFAULT '1'`,
    `ALTER TABLE plantillas_viaje ADD COLUMN IF NOT EXISTS codUnidadMedida VARCHAR(5) NOT NULL DEFAULT '1'`,
    `ALTER TABLE plantillas_viaje ADD COLUMN IF NOT EXISTS codTipoEmpaque VARCHAR(5) NOT NULL DEFAULT '0'`,
    `ALTER TABLE plantillas_viaje ADD COLUMN IF NOT EXISTS codMercancia VARCHAR(15)`,
    `ALTER TABLE plantillas_viaje ADD COLUMN IF NOT EXISTS horasPactoCargue INT NOT NULL DEFAULT 1`,
    `ALTER TABLE plantillas_viaje ADD COLUMN IF NOT EXISTS minutosPactoCargue INT NOT NULL DEFAULT 0`,
    `ALTER TABLE plantillas_viaje ADD COLUMN IF NOT EXISTS horasPactoDescargue INT NOT NULL DEFAULT 1`,
    `ALTER TABLE plantillas_viaje ADD COLUMN IF NOT EXISTS minutosPactoDescargue INT NOT NULL DEFAULT 0`,
    `ALTER TABLE viajes ADD COLUMN IF NOT EXISTS consecutivoRemesa VARCHAR(30)`,
    `ALTER TABLE viajes ADD COLUMN IF NOT EXISTS consecutivoManifiesto VARCHAR(30)`,
  ];
  for (const sql of migraciones) {
    await pool.query(sql);
  }
}
