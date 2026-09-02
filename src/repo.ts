import { pool } from "./db";
import { RowDataPacket, ResultSetHeader } from "mysql2";

// ---------- Tipos ----------
export interface Vehiculo {
  id: number;
  placa: string;
  placaRemolque: string | null;
  marca: string | null;
  configuracion: string | null; // codigo RNDC de configuracion (CODCONFIGURACIONUNIDADCARGA)
  capacidadKg: number | null;
  propietarioNit: string | null;
  fechaVencSoat: Date | null;
  fechaVencTecnomecanica: Date | null;
  activo: boolean;
  codTipoIdTenedor: string; // C, N, etc. (tipo de identificacion del tenedor/propietario)
  numIdTenedor: string | null;
  codTipoCarroceria: string;
  pesoVehiculoVacio: number | null;
}

export interface Conductor {
  id: number;
  cedula: string;
  nombre: string;
  licencia: string | null;
  categoriaLicencia: string | null;
  fechaVencLicencia: Date | null;
  activo: boolean;
  codTipoId: string; // C = Cedula (default), otros codigos segun diccionario RNDC
}

export interface Tercero {
  id: number;
  nit: string;
  nombre: string;
  direccion: string | null;
  ciudad: string | null;
  telefono: string | null;
  rol: string | null;
  codTipoId: string; // N = NIT (default para empresas), C = Cedula para personas naturales
  codSede: string; // codigo de sede del tercero, '0' por defecto
}

export interface Ruta {
  id: number;
  ciudadOrigen: string;
  ciudadDestino: string;
  codigoOrigenRndc: string | null; // codigo de municipio RNDC (8 digitos, ej "11001000")
  codigoDestinoRndc: string | null;
  distanciaKm: number | null;
}

export interface PlantillaViaje {
  id: number;
  nombre: string;
  contratanteId: number;
  remitenteId: number;
  destinatarioId: number;
  rutaId: number;
  tipoMercancia: string | null; // usado como DESCRIPCIONCORTAPRODUCTO (texto libre)
  naturalezaCarga: string | null;
  unidadMedida: string | null;
  valorFleteBase: number | null;
  observaciones: string | null;
  activa: boolean;
  codOperacionTransporte: string; // CODOPERACIONTRANSPORTE, ej 'G'
  codNaturalezaCarga: string; // CODNATURALEZACARGA (codigo de catalogo RNDC)
  codUnidadMedida: string; // UNIDADMEDIDACAPACIDAD (codigo de catalogo RNDC)
  codTipoEmpaque: string; // CODTIPOEMPAQUE (codigo de catalogo RNDC)
  codMercancia: string | null; // MERCANCIAREMESA (codigo de producto RNDC)
  horasPactoCargue: number;
  minutosPactoCargue: number;
  horasPactoDescargue: number;
  minutosPactoDescargue: number;
}

export interface PlantillaViajeConRelaciones extends PlantillaViaje {
  contratante: Tercero;
  remitente: Tercero;
  destinatario: Tercero;
  ruta: Ruta;
}

export interface Viaje {
  id: number;
  plantillaId: number;
  vehiculoId: number;
  conductorId: number;
  fechaHoraCargue: Date;
  pesoReal: number | null;
  cantidadReal: number | null;
  valorFleteReal: number | null;
  estado: string;
  numeroRemesaRndc: string | null; // radicado (ingresoid) que devuelve el RNDC para la remesa
  numeroManifiestoRndc: string | null; // radicado (ingresoid) que devuelve el RNDC para el manifiesto
  mec: string | null;
  codigoSeguridadQr: string | null;
  mensajeError: string | null;
  fechaCreacion: Date;
  consecutivoRemesa: string | null; // CONSECUTIVOREMESA propio, generado por nosotros
  consecutivoManifiesto: string | null; // NUMMANIFIESTOCARGA propio, generado por nosotros
}

// ---------- Helpers ----------
function mapBool<T extends { activo: any }>(row: T): T {
  return { ...row, activo: !!row.activo };
}

function fechaMysql(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// ---------- Vehiculos ----------
export const vehiculos = {
  async findMany(): Promise<Vehiculo[]> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM vehiculos ORDER BY placa");
    return (rows as Vehiculo[]).map(mapBool);
  },
  async findById(id: number): Promise<Vehiculo | null> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM vehiculos WHERE id = ?", [id]);
    const row = rows[0] as Vehiculo | undefined;
    return row ? mapBool(row) : null;
  },
  async create(
    data: Omit<Vehiculo, "id" | "activo" | "codTipoIdTenedor" | "numIdTenedor" | "codTipoCarroceria" | "pesoVehiculoVacio"> &
      Partial<Pick<Vehiculo, "codTipoIdTenedor" | "numIdTenedor" | "codTipoCarroceria" | "pesoVehiculoVacio">>
  ): Promise<Vehiculo> {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO vehiculos
        (placa, placaRemolque, marca, configuracion, capacidadKg, propietarioNit, fechaVencSoat, fechaVencTecnomecanica,
         codTipoIdTenedor, numIdTenedor, codTipoCarroceria, pesoVehiculoVacio)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.placa,
        data.placaRemolque,
        data.marca,
        data.configuracion,
        data.capacidadKg,
        data.propietarioNit,
        fechaMysql(data.fechaVencSoat),
        fechaMysql(data.fechaVencTecnomecanica),
        data.codTipoIdTenedor ?? "N",
        data.numIdTenedor ?? null,
        data.codTipoCarroceria ?? "0",
        data.pesoVehiculoVacio ?? null,
      ]
    );
    return (await this.findById(result.insertId))!;
  },
};

// ---------- Conductores ----------
export const conductores = {
  async findMany(): Promise<Conductor[]> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM conductores ORDER BY nombre");
    return (rows as Conductor[]).map(mapBool);
  },
  async findById(id: number): Promise<Conductor | null> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM conductores WHERE id = ?", [id]);
    const row = rows[0] as Conductor | undefined;
    return row ? mapBool(row) : null;
  },
  async create(
    data: Omit<Conductor, "id" | "activo" | "codTipoId"> & Partial<Pick<Conductor, "codTipoId">>
  ): Promise<Conductor> {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO conductores (cedula, nombre, licencia, categoriaLicencia, fechaVencLicencia, codTipoId)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        data.cedula,
        data.nombre,
        data.licencia,
        data.categoriaLicencia,
        fechaMysql(data.fechaVencLicencia),
        data.codTipoId ?? "C",
      ]
    );
    return (await this.findById(result.insertId))!;
  },
};

// ---------- Terceros ----------
export const terceros = {
  async findMany(): Promise<Tercero[]> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM terceros ORDER BY nombre");
    return rows as Tercero[];
  },
  async findById(id: number): Promise<Tercero | null> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM terceros WHERE id = ?", [id]);
    return (rows[0] as Tercero) ?? null;
  },
  async create(
    data: Omit<Tercero, "id" | "codTipoId" | "codSede"> & Partial<Pick<Tercero, "codTipoId" | "codSede">>
  ): Promise<Tercero> {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO terceros (nit, nombre, direccion, ciudad, telefono, rol, codTipoId, codSede)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.nit,
        data.nombre,
        data.direccion,
        data.ciudad,
        data.telefono,
        data.rol,
        data.codTipoId ?? "N",
        data.codSede ?? "0",
      ]
    );
    return (await this.findById(result.insertId))!;
  },
};

// ---------- Rutas ----------
export const rutas = {
  async findMany(): Promise<Ruta[]> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM rutas");
    return rows as Ruta[];
  },
  async findById(id: number): Promise<Ruta | null> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM rutas WHERE id = ?", [id]);
    return (rows[0] as Ruta) ?? null;
  },
  async create(data: Omit<Ruta, "id">): Promise<Ruta> {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO rutas (ciudadOrigen, ciudadDestino, codigoOrigenRndc, codigoDestinoRndc, distanciaKm)
       VALUES (?, ?, ?, ?, ?)`,
      [data.ciudadOrigen, data.ciudadDestino, data.codigoOrigenRndc, data.codigoDestinoRndc, data.distanciaKm]
    );
    return (await this.findById(result.insertId))!;
  },
};

// ---------- Plantillas de viaje ----------
export const plantillas = {
  async findMany(): Promise<PlantillaViajeConRelaciones[]> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM plantillas_viaje WHERE activa = 1");
    return Promise.all((rows as PlantillaViaje[]).map((p) => this.conRelaciones(p)));
  },
  async findById(id: number): Promise<PlantillaViajeConRelaciones | null> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM plantillas_viaje WHERE id = ?", [id]);
    const row = rows[0] as PlantillaViaje | undefined;
    return row ? this.conRelaciones(row) : null;
  },
  async conRelaciones(p: PlantillaViaje): Promise<PlantillaViajeConRelaciones> {
    const [contratante, remitente, destinatario, ruta] = await Promise.all([
      terceros.findById(p.contratanteId),
      terceros.findById(p.remitenteId),
      terceros.findById(p.destinatarioId),
      rutas.findById(p.rutaId),
    ]);
    return {
      ...p,
      activa: !!(p as any).activa,
      contratante: contratante!,
      remitente: remitente!,
      destinatario: destinatario!,
      ruta: ruta!,
    };
  },
  async create(
    data: Omit<
      PlantillaViaje,
      | "id"
      | "activa"
      | "codOperacionTransporte"
      | "codNaturalezaCarga"
      | "codUnidadMedida"
      | "codTipoEmpaque"
      | "codMercancia"
      | "horasPactoCargue"
      | "minutosPactoCargue"
      | "horasPactoDescargue"
      | "minutosPactoDescargue"
    > &
      Partial<
        Pick<
          PlantillaViaje,
          | "codOperacionTransporte"
          | "codNaturalezaCarga"
          | "codUnidadMedida"
          | "codTipoEmpaque"
          | "codMercancia"
          | "horasPactoCargue"
          | "minutosPactoCargue"
          | "horasPactoDescargue"
          | "minutosPactoDescargue"
        >
      >
  ): Promise<PlantillaViaje> {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO plantillas_viaje
        (nombre, contratanteId, remitenteId, destinatarioId, rutaId, tipoMercancia, naturalezaCarga, unidadMedida,
         valorFleteBase, observaciones, codOperacionTransporte, codNaturalezaCarga, codUnidadMedida, codTipoEmpaque,
         codMercancia, horasPactoCargue, minutosPactoCargue, horasPactoDescargue, minutosPactoDescargue)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.nombre,
        data.contratanteId,
        data.remitenteId,
        data.destinatarioId,
        data.rutaId,
        data.tipoMercancia,
        data.naturalezaCarga,
        data.unidadMedida,
        data.valorFleteBase,
        data.observaciones,
        data.codOperacionTransporte ?? "G",
        data.codNaturalezaCarga ?? "1",
        data.codUnidadMedida ?? "1",
        data.codTipoEmpaque ?? "0",
        data.codMercancia ?? null,
        data.horasPactoCargue ?? 1,
        data.minutosPactoCargue ?? 0,
        data.horasPactoDescargue ?? 1,
        data.minutosPactoDescargue ?? 0,
      ]
    );
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM plantillas_viaje WHERE id = ?", [
      result.insertId,
    ]);
    return rows[0] as PlantillaViaje;
  },
};

// ---------- Viajes ----------
export const viajes = {
  async findById(id: number): Promise<Viaje | null> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM viajes WHERE id = ?", [id]);
    return (rows[0] as Viaje) ?? null;
  },
  async findMany(limit = 100): Promise<Viaje[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM viajes ORDER BY fechaCreacion DESC LIMIT ?",
      [limit]
    );
    return rows as Viaje[];
  },
  async create(data: {
    plantillaId: number;
    vehiculoId: number;
    conductorId: number;
    fechaHoraCargue: Date;
    pesoReal: number | null;
    cantidadReal: number | null;
    valorFleteReal: number | null;
  }): Promise<Viaje> {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO viajes (plantillaId, vehiculoId, conductorId, fechaHoraCargue, pesoReal, cantidadReal, valorFleteReal)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        data.plantillaId,
        data.vehiculoId,
        data.conductorId,
        fechaMysql(data.fechaHoraCargue),
        data.pesoReal,
        data.cantidadReal,
        data.valorFleteReal,
      ]
    );
    // El consecutivo propio (CONSECUTIVOREMESA / NUMMANIFIESTOCARGA) se genera a partir
    // del id interno una vez conocido, para garantizar unicidad sin coordinar con el RNDC.
    const id = result.insertId;
    const consecutivoRemesa = `REM${id}`;
    const consecutivoManifiesto = `MAN${id}`;
    await pool.query("UPDATE viajes SET consecutivoRemesa = ?, consecutivoManifiesto = ? WHERE id = ?", [
      consecutivoRemesa,
      consecutivoManifiesto,
      id,
    ]);
    return (await this.findById(id))!;
  },
  async update(id: number, data: Partial<Omit<Viaje, "id">>): Promise<Viaje> {
    const campos = Object.keys(data);
    if (campos.length > 0) {
      const sets = campos.map((c) => `${c} = ?`).join(", ");
      const valores = campos.map((c) => (data as any)[c]);
      await pool.query(`UPDATE viajes SET ${sets} WHERE id = ?`, [...valores, id]);
    }
    return (await this.findById(id))!;
  },
};
