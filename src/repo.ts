import { pool } from "./db";
import { config } from "./config";
import { RowDataPacket, ResultSetHeader } from "mysql2";

// ---------- Tipos ----------
export interface Remolque {
  id: number;
  placa: string;
  numEjes: number | null;
  capacidadKg: number | null;
  fechaVencSoat: Date | null;
  fechaVencTecnomecanica: Date | null;
  activo: boolean;
}

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
  /**
   * true si el peso bruto vehicular supera 10.5 t y por lo tanto el manifiesto
   * debe llevar el aporte FOPAT (0.1% del valor a pagar, Ley 2251 de 2022).
   */
  aplicaFopat: boolean;
  /** NIT de la empresa de monitoreo (proveedor GPS) por defecto del vehiculo. */
  nitMonitoreoFlota: string | null;
  /** Nombre del titular (tenedor). Solo informativo: no se envia al RNDC. */
  nombreTenedor: string | null;
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
  /**
   * Coordenadas de la sede, copiadas del maestro de terceros del RNDC.
   * No se envian: el RNDC usa las suyas. Sirven para validar y mostrar cual es
   * el punto contra el que se va a verificar el GPS del vehiculo.
   */
  latitud: number | null;
  longitud: number | null;
  /** Codigo DIVIPOLA (8 digitos) del municipio de la sede. */
  codMunicipioRndc: string | null;
}

export interface Ruta {
  id: number;
  ciudadOrigen: string;
  ciudadDestino: string;
  codigoOrigenRndc: string | null; // codigo de municipio RNDC (8 digitos, ej "11001000")
  codigoDestinoRndc: string | null;
  distanciaKm: number | null;
  /** CODVIA. Si es null, el RNDC asigna la via estandar de SICETAC. */
  codVia: string | null;
}

export interface PlantillaViaje {
  id: number;
  nombre: string;
  contratanteId: number;
  remitenteId: number;
  destinatarioId: number;
  /** @deprecated Reemplazado por municipioOrigen + municipioDestino. */
  rutaId: number | null;
  /**
   * Ruta del viaje (DIVIPOLA, 8 digitos). Dato explicito y editable: se
   * precarga con el municipio del remitente y del destinatario, pero puede
   * diferir (tramo en vacio, ida y regreso). Con este par se piden las vias a
   * SICETAC. Antes de despachar se valida contra los municipios reales de
   * cargue y descargue de las remesas [Manual 5.2.4].
   */
  municipioOrigen: string | null;
  municipioDestino: string | null;
  /**
   * Tarifa pactada para esta ruta. Se actualiza solo cuando cambia el valor de
   * SICETAC, no viaje por viaje: en el despacho se precarga y se puede ajustar.
   */
  valorFleteBase: number | null;
  fleteActualizadoEn: Date | null;
  tipoMercancia: string | null; // usado como DESCRIPCIONCORTAPRODUCTO (texto libre)
  naturalezaCarga: string | null;
  unidadMedida: string | null;
  observaciones: string | null;
  activa: boolean;
  /** @deprecated Reemplazado por tipoOperacionRemesa + tipoManifiesto. */
  codOperacionTransporte: string;
  /** CODOPERACIONTRANSPORTE de la remesa (proceso 3). 'G' = General. */
  tipoOperacionRemesa: string;
  /** CODOPERACIONTRANSPORTE del manifiesto (proceso 4): G/W/I/M/U/D. */
  tipoManifiesto: string;
  /** Municipio de retorno. Obligatorio solo si tipoManifiesto = 'I'. */
  codMunicipioIntermedio: string | null;
  codNaturalezaCarga: string; // CODNATURALEZACARGA (codigo de catalogo RNDC)
  codUnidadMedida: string; // UNIDADMEDIDACAPACIDAD (codigo de catalogo RNDC)
  codTipoEmpaque: string; // CODTIPOEMPAQUE (codigo de catalogo RNDC)
  codMercancia: string | null; // MERCANCIAREMESA (codigo de producto, 6 digitos)
  subpartidaCode: string | null; // SUBPARTIDA_CODE (2 digitos, solo ciertas partidas)
  codigoArancelCode: string | null; // CODIGOARANCEL_CODE (2 digitos, solo ciertas subpartidas)
  empaquePrimario: string | null; // EMPAQUEPRIMARIO (opcional)
  unidadMedidaProducto: string; // UNIDADMEDIDAPRODUCTO: unidad COMERCIAL (KGM, GLL, UN...)
  horasPactoCargue: number;
  minutosPactoCargue: number;
  horasPactoDescargue: number;
  minutosPactoDescargue: number;
  retencionIcaManifiesto: number; // RETENCIONICAMANIFIESTOCARGA (%, ej. 3 para 3 por mil)
  /**
   * CODRESPONSABLEPAGOCARGUE: solo admite 'R' (remitente) o 'D' (destinatario)
   * [MANIFIESTO V7 pag. 15 y ejemplo XML pag. 20]. No existe la opcion
   * "empresa" ni "conductor".
   */
  codResponsablePagoCargue: string;
  codResponsablePagoDescargue: string;
  aceptacionElectronica: string; // 'SI' | 'NO'
  codMunicipioPagoSaldo: string | null; // si es null, se usa el municipio destino de la ruta
  /**
   * Factor de ICA (por mil) del municipio donde carga esta plantilla.
   * Reemplaza a retencionIcaManifiesto cuando el manifiesto lleva varias
   * remesas: alli el factor final es el promedio ponderado de todas.
   */
  factorIcaCargue: number;
  /** Tarifa de retencion en la fuente (0.01 = 1%). */
  tarifaRetencionFuente: number;
  /** Si el titular del manifiesto esta en Regimen Simple, el RNDC acepta retefuente en 0. */
  titularEsRegimenSimple: boolean;
  // Seguro de mercancia. NO se envia al RNDC: la poliza de carga de la empresa
  // cubre toda la mercancia (propia y de terceros) y los nombres de etiqueta no
  // aparecen en ningun XML de ejemplo oficial. Se conservan como dato interno.
  tomadorPolizaCarga: string;
  numeroPolizaTransporte: string | null;
  companiaSeguro: string | null;
  fechaVencimientoPolizaCarga: Date | null;
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
  valorAnticipoManifiesto: number; // VALORANTICIPOMANIFIESTO, varia cada noche
  fechaPagoSaldo: Date | null; // FECHAPAGOSALDOMANIFIESTO, si es null se usa la fecha de cargue
  conductor2Id: number | null; // segundo conductor opcional (CODIDCONDUCTOR2/NUMIDCONDUCTOR2)
  remolqueId: number | null; // el remolque/trailer USADO ESTA NOCHE (puede variar por viaje)
  /** Cita pactada de descargue. De ella dependen las validaciones de vigencia. */
  fechaHoraDescargue: Date | null;
  viajesDia: number | null; // solo para manifiesto tipo 'D'
  ordenServicioGenerador: string | null; // ORDENSERVICIOGENERADOR
  vacio1Origen: string | null;
  vacio1Destino: string | null;
  vacio1Valor: number;
  vacio2Origen: string | null;
  vacio2Destino: string | null;
  vacio2Valor: number;
  /** Avisos no bloqueantes registrados al despachar (ej. manifiesto tardio). */
  avisos: string | null;
  /** Via elegida para el viaje (CODVIA). Cambia el piso tarifario. */
  codVia: string | null;
  /** NIT de la empresa de monitoreo que reporta los tiempos del viaje. */
  nitMonitoreoFlota: string | null;
  /** FOPAT efectivamente reportado en el manifiesto. */
  retencionFopat: number | null;
  /** true cuando ese FOPAT ya se pago a la DIAN. */
  fopatPagado: boolean;
  fechaPagoFopat: Date | null;
  /** Codigo de error del RNDC (ej. "REM112"), para soporte. */
  codigoError: string | null;
  /** Texto original del RNDC, sin traducir. */
  errorCrudo: string | null;
}

// ---------- Helpers ----------
function mapBool<T extends { activo: any }>(row: T): T {
  return { ...row, activo: !!row.activo };
}

/** MySQL devuelve DECIMAL como string para no perder precision. */
function aNumero(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === "") return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

function mapViaje<T extends { fopatPagado?: any }>(row: T): T {
  return { ...row, fopatPagado: !!row.fopatPagado };
}

function mapTercero(row: Tercero): Tercero {
  return { ...row, latitud: aNumero(row.latitud), longitud: aNumero(row.longitud) };
}

/** MySQL devuelve TINYINT(1) como 0/1; aqui se normaliza a boolean real. */
function mapVehiculo(row: Vehiculo): Vehiculo {
  return { ...row, activo: !!row.activo, aplicaFopat: !!row.aplicaFopat };
}

function fechaMysql(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// ---------- Edicion desde el catalogo ----------

/** Otra fila ya usa ese valor unico (placa, cedula, NIT...). */
export class ErrorDuplicado extends Error {}
/** Un valor no tiene el formato esperado. */
export class ErrorValidacion extends Error {}

export type TipoCampo = "texto" | "numero" | "fecha" | "booleano";

/**
 * Actualiza solo las columnas permitidas que vengan en `datos`.
 *
 * La lista blanca `campos` es la que arma el SQL: nunca se interpola una llave
 * que venga del cliente. Cada columna y su valor se agregan juntos, asi que el
 * numero de placeholders siempre coincide con el de valores (ver el incidente
 * del INSERT en CONTEXTO-PROYECTO.md).
 *
 * Las llaves ausentes no se tocan; un texto vacio se guarda como NULL.
 */
export async function actualizarFila(
  tabla: string,
  id: number,
  datos: Record<string, unknown>,
  campos: Record<string, TipoCampo>
): Promise<boolean> {
  const sets: string[] = [];
  const valores: unknown[] = [];

  for (const [columna, tipo] of Object.entries(campos)) {
    if (!(columna in datos)) continue;
    const crudo = datos[columna];
    const vacio = crudo === null || crudo === undefined || String(crudo).trim() === "";
    let valor: unknown;
    if (tipo === "booleano") {
      valor = crudo ? 1 : 0;
    } else if (vacio) {
      valor = null;
    } else if (tipo === "numero") {
      const n = Number(crudo);
      if (!Number.isFinite(n)) throw new ErrorValidacion(`"${columna}" debe ser un numero`);
      valor = n;
    } else if (tipo === "fecha") {
      const d = new Date(String(crudo));
      if (Number.isNaN(d.getTime())) throw new ErrorValidacion(`"${columna}" no es una fecha valida`);
      valor = fechaMysql(d);
    } else {
      valor = String(crudo).trim();
    }
    sets.push(`\`${columna}\` = ?`);
    valores.push(valor);
  }

  if (sets.length === 0) return false;
  try {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE \`${tabla}\` SET ${sets.join(", ")} WHERE id = ?`,
      [...valores, id]
    );
    return res.affectedRows > 0;
  } catch (exc: any) {
    if (exc?.code === "ER_DUP_ENTRY") {
      throw new ErrorDuplicado("Ya existe otro registro con ese mismo valor (placa, cedula o NIT).");
    }
    if (exc?.code === "ER_BAD_NULL_ERROR") {
      throw new ErrorValidacion(`Falta un dato obligatorio: ${exc.sqlMessage ?? ""}`);
    }
    throw exc;
  }
}

// ---------- Remolques (trailers) ----------
export const remolques = {
  async findMany(): Promise<Remolque[]> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM remolques ORDER BY placa");
    return (rows as unknown as Remolque[]).map(mapBool);
  },
  async findById(id: number): Promise<Remolque | null> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM remolques WHERE id = ?", [id]);
    const row = rows[0] as unknown as Remolque | undefined;
    return row ? mapBool(row) : null;
  },
  async create(data: Omit<Remolque, "id" | "activo">): Promise<Remolque> {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO remolques (placa, numEjes, capacidadKg, fechaVencSoat, fechaVencTecnomecanica)
       VALUES (?, ?, ?, ?, ?)`,
      [
        data.placa,
        data.numEjes,
        data.capacidadKg,
        fechaMysql(data.fechaVencSoat),
        fechaMysql(data.fechaVencTecnomecanica),
      ]
    );
    return (await this.findById(result.insertId))!;
  },
  async update(id: number, datos: Record<string, unknown>): Promise<Remolque | null> {
    await actualizarFila("remolques", id, datos, {
      placa: "texto",
      numEjes: "numero",
      capacidadKg: "numero",
      fechaVencSoat: "fecha",
      fechaVencTecnomecanica: "fecha",
      activo: "booleano",
    });
    return this.findById(id);
  },
};

// ---------- Vehiculos ----------
export const vehiculos = {
  /** Cambia el proveedor de GPS (EMF) por defecto de un vehiculo. */
  async fijarMonitoreo(id: number, nit: string | null): Promise<void> {
    await pool.query("UPDATE vehiculos SET nitMonitoreoFlota = ? WHERE id = ?", [nit, id]);
  },

  /** Refresca vencimientos de SOAT y tecnomecanica de una placa existente. */
  async actualizarPorPlaca(
    placa: string,
    datos: {
      fechaVencSoat?: Date | null;
      fechaVencTecnomecanica?: Date | null;
      configuracion?: string | null;
      pesoVehiculoVacio?: number | null;
    }
  ): Promise<boolean> {
    const campos: string[] = [];
    const valores: unknown[] = [];
    if (datos.fechaVencSoat !== undefined) {
      campos.push("fechaVencSoat = ?");
      valores.push(fechaMysql(datos.fechaVencSoat ?? null));
    }
    if (datos.fechaVencTecnomecanica !== undefined) {
      campos.push("fechaVencTecnomecanica = ?");
      valores.push(fechaMysql(datos.fechaVencTecnomecanica ?? null));
    }
    if (datos.configuracion) {
      campos.push("configuracion = ?");
      valores.push(datos.configuracion);
    }
    if (datos.pesoVehiculoVacio !== undefined && datos.pesoVehiculoVacio !== null) {
      campos.push("pesoVehiculoVacio = ?");
      valores.push(datos.pesoVehiculoVacio);
    }
    if (campos.length === 0) return false;

    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE vehiculos SET ${campos.join(", ")} WHERE placa = ?`,
      [...valores, placa.toUpperCase()]
    );
    return res.affectedRows > 0;
  },

  async findMany(): Promise<Vehiculo[]> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM vehiculos ORDER BY placa");
    return (rows as Vehiculo[]).map(mapVehiculo);
  },
  async findById(id: number): Promise<Vehiculo | null> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM vehiculos WHERE id = ?", [id]);
    const row = rows[0] as Vehiculo | undefined;
    return row ? mapVehiculo(row) : null;
  },
  async create(
    data: Omit<
      Vehiculo,
      | "id"
      | "activo"
      | "codTipoIdTenedor"
      | "numIdTenedor"
      | "codTipoCarroceria"
      | "pesoVehiculoVacio"
      | "aplicaFopat"
      | "nitMonitoreoFlota"
      | "nombreTenedor"
    > &
      Partial<
        Pick<
          Vehiculo,
          | "codTipoIdTenedor"
          | "numIdTenedor"
          | "codTipoCarroceria"
          | "pesoVehiculoVacio"
          | "aplicaFopat"
          | "nitMonitoreoFlota"
          | "nombreTenedor"
        >
      >
  ): Promise<Vehiculo> {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO vehiculos
        (placa, placaRemolque, marca, configuracion, capacidadKg, propietarioNit, fechaVencSoat, fechaVencTecnomecanica,
         codTipoIdTenedor, numIdTenedor, codTipoCarroceria, pesoVehiculoVacio, aplicaFopat, nitMonitoreoFlota,
         nombreTenedor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        // Por defecto SI aplica: casi toda la flota de carga supera 10.5 t.
        (data.aplicaFopat ?? true) ? 1 : 0,
        data.nitMonitoreoFlota ?? null,
        data.nombreTenedor ?? null,
      ]
    );
    return (await this.findById(result.insertId))!;
  },
  async update(id: number, datos: Record<string, unknown>): Promise<Vehiculo | null> {
    await actualizarFila("vehiculos", id, datos, {
      placa: "texto",
      placaRemolque: "texto",
      marca: "texto",
      configuracion: "texto",
      capacidadKg: "numero",
      pesoVehiculoVacio: "numero",
      codTipoCarroceria: "texto",
      propietarioNit: "texto",
      codTipoIdTenedor: "texto",
      numIdTenedor: "texto",
      nombreTenedor: "texto",
      fechaVencSoat: "fecha",
      fechaVencTecnomecanica: "fecha",
      aplicaFopat: "booleano",
      nitMonitoreoFlota: "texto",
      activo: "booleano",
    });
    return this.findById(id);
  },
};

// ---------- Conductores ----------
export const conductores = {
  /**
   * Refresca los datos que el RNDC toma del RUNT (licencia, categoria y
   * vencimiento) de un conductor que ya existe.
   *
   * Es lo que permite reimportar el Maestro de Terceros periodicamente y que
   * las alertas de vencimiento queden al dia sin crear duplicados.
   */
  async actualizarPorCedula(
    cedula: string,
    datos: {
      licencia?: string | null;
      categoriaLicencia?: string | null;
      fechaVencLicencia?: Date | null;
      nombre?: string | null;
    }
  ): Promise<boolean> {
    const campos: string[] = [];
    const valores: unknown[] = [];
    if (datos.licencia !== undefined) {
      campos.push("licencia = ?");
      valores.push(datos.licencia);
    }
    if (datos.categoriaLicencia !== undefined) {
      campos.push("categoriaLicencia = ?");
      valores.push(datos.categoriaLicencia);
    }
    if (datos.fechaVencLicencia !== undefined) {
      campos.push("fechaVencLicencia = ?");
      valores.push(fechaMysql(datos.fechaVencLicencia ?? null));
    }
    if (datos.nombre) {
      campos.push("nombre = ?");
      valores.push(datos.nombre);
    }
    if (campos.length === 0) return false;

    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE conductores SET ${campos.join(", ")} WHERE cedula = ?`,
      [...valores, cedula]
    );
    return res.affectedRows > 0;
  },

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
  async update(id: number, datos: Record<string, unknown>): Promise<Conductor | null> {
    await actualizarFila("conductores", id, datos, {
      codTipoId: "texto",
      cedula: "texto",
      nombre: "texto",
      licencia: "texto",
      categoriaLicencia: "texto",
      fechaVencLicencia: "fecha",
      activo: "booleano",
    });
    return this.findById(id);
  },
};

// ---------- Terceros ----------
export const terceros = {
  async findMany(): Promise<Tercero[]> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM terceros ORDER BY nombre");
    return (rows as Tercero[]).map(mapTercero);
  },
  async findById(id: number): Promise<Tercero | null> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM terceros WHERE id = ?", [id]);
    const row = rows[0] as Tercero | undefined;
    return row ? mapTercero(row) : null;
  },
  async create(
    data: Omit<
      Tercero,
      "id" | "codTipoId" | "codSede" | "latitud" | "longitud" | "codMunicipioRndc"
    > &
      Partial<
        Pick<Tercero, "codTipoId" | "codSede" | "latitud" | "longitud" | "codMunicipioRndc">
      >
  ): Promise<Tercero> {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO terceros (nit, nombre, direccion, ciudad, telefono, rol, codTipoId, codSede, latitud, longitud, codMunicipioRndc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.nit,
        data.nombre,
        data.direccion,
        data.ciudad,
        data.telefono,
        data.rol,
        data.codTipoId ?? "N",
        data.codSede ?? "0",
        data.latitud ?? null,
        data.longitud ?? null,
        data.codMunicipioRndc ?? null,
      ]
    );
    return (await this.findById(result.insertId))!;
  },
  async update(id: number, datos: Record<string, unknown>): Promise<Tercero | null> {
    await actualizarFila("terceros", id, datos, {
      codTipoId: "texto",
      nit: "texto",
      nombre: "texto",
      codSede: "texto",
      direccion: "texto",
      ciudad: "texto",
      telefono: "texto",
      codMunicipioRndc: "texto",
      latitud: "numero",
      longitud: "numero",
    });
    return this.findById(id);
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
  async create(data: Omit<Ruta, "id" | "codVia"> & Partial<Pick<Ruta, "codVia">>): Promise<Ruta> {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO rutas (ciudadOrigen, ciudadDestino, codigoOrigenRndc, codigoDestinoRndc, distanciaKm, codVia)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        data.ciudadOrigen,
        data.ciudadDestino,
        data.codigoOrigenRndc,
        data.codigoDestinoRndc,
        data.distanciaKm,
        data.codVia ?? null,
      ]
    );
    return (await this.findById(result.insertId))!;
  },
};

// ---------- Municipios (DIVIPOLA) ----------

export interface Municipio {
  codigo: string; // 8 digitos: 5 municipio + 3 centro poblado
  nombre: string;
  departamento: string | null;
}

export const municipios = {
  async findMany(): Promise<Municipio[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM municipios ORDER BY nombre"
    );
    return rows as Municipio[];
  },

  async buscar(texto: string, limite = 20): Promise<Municipio[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT * FROM municipios
        WHERE nombre LIKE ? OR codigo LIKE ?
        ORDER BY nombre LIMIT ?`,
      [`%${texto}%`, `${texto}%`, limite]
    );
    return rows as Municipio[];
  },

  /** Inserta en lote. Los codigos repetidos se ignoran. */
  async crearLote(lista: Municipio[]): Promise<number> {
    if (lista.length === 0) return 0;
    // En bloques para no armar una sentencia gigante con los 1.100 municipios.
    let total = 0;
    for (let i = 0; i < lista.length; i += 500) {
      const bloque = lista.slice(i, i + 500);
      const [res] = await pool.query<ResultSetHeader>(
        `INSERT IGNORE INTO municipios (codigo, nombre, departamento) VALUES ${bloque
          .map(() => "(?, ?, ?)")
          .join(", ")}`,
        bloque.flatMap((m) => [m.codigo, m.nombre, m.departamento])
      );
      total += res.affectedRows;
    }
    return total;
  },
};

// ---------- Vias (CODVIA) ----------

export interface Via {
  id: number;
  codVia: string;
  codMunicipioOrigen: string;
  codMunicipioDestino: string;
  descripcion: string;
  /** Minimo de referencia de SICETAC para esta via, si se conoce. */
  valorSicetac: number | null;
  esEstandar: boolean;
  actualizadoEn: Date | null;
}

export const vias = {
  /** Vias disponibles para un par origen-destino. La estandar va primero. */
  async findByRuta(origen: string, destino: string): Promise<Via[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT * FROM vias
        WHERE codMunicipioOrigen = ? AND codMunicipioDestino = ?
        ORDER BY esEstandar DESC, descripcion`,
      [origen, destino]
    );
    return (rows as Via[]).map((v) => ({
      ...v,
      esEstandar: !!v.esEstandar,
      valorSicetac: v.valorSicetac === null ? null : Number(v.valorSicetac),
    }));
  },

  async findMany(): Promise<Via[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM vias ORDER BY codMunicipioOrigen, codMunicipioDestino, descripcion"
    );
    return (rows as Via[]).map((v) => ({
      ...v,
      esEstandar: !!v.esEstandar,
      valorSicetac: v.valorSicetac === null ? null : Number(v.valorSicetac),
    }));
  },

  /**
   * Crea o actualiza una via. Se reemplaza la descripcion y el valor de
   * SICETAC porque ambos cambian cuando el Ministerio actualiza las tarifas.
   */
  async guardar(v: Omit<Via, "id" | "actualizadoEn">): Promise<void> {
    await pool.query(
      `INSERT INTO vias
         (codVia, codMunicipioOrigen, codMunicipioDestino, descripcion, valorSicetac, esEstandar, actualizadoEn)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         descripcion = VALUES(descripcion),
         valorSicetac = VALUES(valorSicetac),
         esEstandar = VALUES(esEstandar),
         actualizadoEn = VALUES(actualizadoEn)`,
      [
        v.codVia,
        v.codMunicipioOrigen,
        v.codMunicipioDestino,
        v.descripcion,
        v.valorSicetac,
        v.esEstandar ? 1 : 0,
        fechaMysql(new Date()),
      ]
    );
  },
};

// ---------- Empresas de monitoreo de flota ----------

export interface EmpresaMonitoreo {
  id: number;
  /** Lo que viaja en NITMONITOREOFLOTA. */
  nit: string;
  nombre: string;
  activa: boolean;
}

export const empresasMonitoreo = {
  async findMany(): Promise<EmpresaMonitoreo[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM empresas_monitoreo WHERE activa = 1 ORDER BY nombre"
    );
    return (rows as EmpresaMonitoreo[]).map((e) => ({ ...e, activa: !!e.activa }));
  },

  async findByNit(nit: string): Promise<EmpresaMonitoreo | null> {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM empresas_monitoreo WHERE nit = ?",
      [nit]
    );
    const row = rows[0] as EmpresaMonitoreo | undefined;
    return row ? { ...row, activa: !!row.activa } : null;
  },

  /** Crea o renombra por NIT. El nombre puede cambiar; el NIT es la llave. */
  async guardar(nit: string, nombre: string): Promise<void> {
    await pool.query(
      `INSERT INTO empresas_monitoreo (nit, nombre) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), activa = 1`,
      [nit, nombre]
    );
  },

  async update(id: number, datos: { nit?: string; nombre?: string }): Promise<EmpresaMonitoreo | null> {
    await actualizarFila("empresas_monitoreo", id, datos, { nit: "texto", nombre: "texto" });
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM empresas_monitoreo WHERE id = ?", [id]);
    const row = rows[0] as EmpresaMonitoreo | undefined;
    return row ? { ...row, activa: !!row.activa } : null;
  },

  async desactivar(id: number): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      "UPDATE empresas_monitoreo SET activa = 0 WHERE id = ?",
      [id]
    );
    return res.affectedRows > 0;
  },
};

// ---------- Parametros de la empresa ----------

/**
 * Datos que cambian una vez al ano o casi nunca. Viven en una fila unica en vez
 * de repetirse en cada plantilla: la poliza de carga es la misma para toda la
 * mercancia, propia o de terceros, y el FOPAT aplica a toda la flota.
 */
export interface ParametrosEmpresa {
  tomadorPolizaCarga: string;
  numeroPolizaTransporte: string | null;
  companiaSeguro: string | null;
  fechaVencimientoPolizaCarga: Date | null;
  /** Si toda la flota supera 10.5 t, el manifiesto siempre lleva FOPAT. */
  aplicaFopat: boolean;
  /** Tarifa por defecto de retencion en la fuente (0.01 = 1%). */
  tarifaRetencionFuente: number;
  actualizadoEn: Date | null;
}

export const parametros = {
  async obtener(): Promise<ParametrosEmpresa> {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM parametros_empresa WHERE id = 1"
    );
    const row = rows[0] as any;
    return {
      tomadorPolizaCarga: row?.tomadorPolizaCarga ?? "Empresa Transporte",
      numeroPolizaTransporte: row?.numeroPolizaTransporte ?? null,
      companiaSeguro: row?.companiaSeguro ?? null,
      fechaVencimientoPolizaCarga: row?.fechaVencimientoPolizaCarga ?? null,
      aplicaFopat: !!(row?.aplicaFopat ?? 1),
      tarifaRetencionFuente: Number(row?.tarifaRetencionFuente ?? 0.01),
      actualizadoEn: row?.actualizadoEn ?? null,
    };
  },

  async guardar(data: Partial<ParametrosEmpresa>): Promise<ParametrosEmpresa> {
    const actual = await this.obtener();
    // El spread copia tambien las llaves con valor undefined y pisaria lo
    // actual: se descartan, para que "no vino" signifique "no cambiar".
    const definidos = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v !== undefined)
    ) as Partial<ParametrosEmpresa>;
    const nuevo = { ...actual, ...definidos };
    await pool.query(
      `UPDATE parametros_empresa SET
         tomadorPolizaCarga = ?, numeroPolizaTransporte = ?, companiaSeguro = ?,
         fechaVencimientoPolizaCarga = ?, aplicaFopat = ?, tarifaRetencionFuente = ?,
         actualizadoEn = ?
       WHERE id = 1`,
      [
        nuevo.tomadorPolizaCarga,
        nuevo.numeroPolizaTransporte,
        nuevo.companiaSeguro,
        fechaMysql(nuevo.fechaVencimientoPolizaCarga),
        nuevo.aplicaFopat ? 1 : 0,
        nuevo.tarifaRetencionFuente,
        fechaMysql(new Date()),
      ]
    );
    return this.obtener();
  },

  /**
   * Avisa si la poliza esta vencida o por vencerse. No bloquea nada: es un
   * recordatorio para que no se pase la renovacion anual.
   */
  async revisarVigenciaPoliza(diasAviso = 30): Promise<string | null> {
    const p = await this.obtener();
    if (!p.fechaVencimientoPolizaCarga) return null;
    const dias = Math.ceil(
      (new Date(p.fechaVencimientoPolizaCarga).getTime() - Date.now()) / 86_400_000
    );
    if (dias < 0) {
      return `La poliza de carga de la empresa vencio hace ${Math.abs(dias)} dia(s).`;
    }
    if (dias <= diasAviso) {
      return `La poliza de carga de la empresa vence en ${dias} dia(s).`;
    }
    return null;
  },
};

// ---------- Plantillas de viaje ----------

/** Campos sin los cuales una plantilla no tiene sentido. El resto tiene default. */
type CamposObligatoriosPlantilla =
  | "nombre"
  | "contratanteId"
  | "remitenteId"
  | "destinatarioId"
  | "rutaId";

export type NuevaPlantilla = Pick<PlantillaViaje, CamposObligatoriosPlantilla> &
  Partial<Omit<PlantillaViaje, "id" | "activa" | CamposObligatoriosPlantilla>>;

/**
 * Nombres legibles del origen y destino de la ruta de una plantilla (alias
 * mo/md y co/cd).
 *
 * Primero el catalogo de municipios; si no se ha importado, la ciudad de algun
 * tercero en ese municipio, que es lo que se mostraba cuando la ruta salia de
 * los terceros. El codigo queda como ultimo recurso en el COALESCE.
 */
const JOIN_NOMBRES_RUTA = `
  LEFT JOIN municipios mo ON mo.codigo = p.municipioOrigen
  LEFT JOIN municipios md ON md.codigo = p.municipioDestino
  LEFT JOIN (SELECT codMunicipioRndc, MAX(ciudad) AS ciudad FROM terceros GROUP BY codMunicipioRndc) co
         ON co.codMunicipioRndc = p.municipioOrigen
  LEFT JOIN (SELECT codMunicipioRndc, MAX(ciudad) AS ciudad FROM terceros GROUP BY codMunicipioRndc) cd
         ON cd.codMunicipioRndc = p.municipioDestino`;

/**
 * Columnas que se escriben al crear o editar una plantilla, con su valor.
 *
 * El INSERT y el UPDATE se arman desde esta misma lista, asi columnas,
 * placeholders y valores cuadran por construccion. Un INSERT con mas `?` que
 * valores ya tumbo el servidor una vez; escribirlos a mano en paralelo es
 * justo lo que lo permitio.
 *
 * fleteActualizadoEn no esta aqui: depende de si la tarifa cambio, y eso solo
 * lo sabe quien llama.
 */
function columnasPlantilla(data: NuevaPlantilla): Array<[columna: string, valor: unknown]> {
  return [
    ["nombre", data.nombre],
    ["contratanteId", data.contratanteId],
    ["remitenteId", data.remitenteId],
    ["destinatarioId", data.destinatarioId],
    ["rutaId", data.rutaId],
    ["municipioOrigen", data.municipioOrigen ?? null],
    ["municipioDestino", data.municipioDestino ?? null],
    ["tipoMercancia", data.tipoMercancia ?? null],
    ["naturalezaCarga", data.naturalezaCarga ?? null],
    ["unidadMedida", data.unidadMedida ?? null],
    ["valorFleteBase", data.valorFleteBase ?? null],
    ["observaciones", data.observaciones ?? null],
    // Columna heredada, ya sin uso: se conserva sincronizada con el tipo de
    // manifiesto para no romper bases de datos existentes.
    ["codOperacionTransporte", data.tipoManifiesto ?? "G"],
    ["tipoOperacionRemesa", data.tipoOperacionRemesa ?? "G"],
    ["tipoManifiesto", data.tipoManifiesto ?? "G"],
    ["codMunicipioIntermedio", data.codMunicipioIntermedio ?? null],
    // Esta empresa solo mueve carga general.
    ["codNaturalezaCarga", data.codNaturalezaCarga ?? "1"],
    ["codUnidadMedida", data.codUnidadMedida ?? "1"],
    ["codTipoEmpaque", data.codTipoEmpaque ?? "0"],
    ["codMercancia", data.codMercancia ?? null],
    ["subpartidaCode", data.subpartidaCode ?? null],
    ["codigoArancelCode", data.codigoArancelCode ?? null],
    ["empaquePrimario", data.empaquePrimario ?? null],
    ["unidadMedidaProducto", data.unidadMedidaProducto ?? "KGM"],
    ["horasPactoCargue", data.horasPactoCargue ?? 1],
    ["minutosPactoCargue", data.minutosPactoCargue ?? 0],
    ["horasPactoDescargue", data.horasPactoDescargue ?? 1],
    ["minutosPactoDescargue", data.minutosPactoDescargue ?? 0],
    ["retencionIcaManifiesto", data.retencionIcaManifiesto ?? 0],
    // Si no se informa aparte, el factor de cargue es el mismo del manifiesto.
    ["factorIcaCargue", data.factorIcaCargue ?? data.retencionIcaManifiesto ?? 0],
    ["tarifaRetencionFuente", data.tarifaRetencionFuente ?? 0.01],
    ["titularEsRegimenSimple", (data.titularEsRegimenSimple ?? false) ? 1 : 0],
    ["codResponsablePagoCargue", data.codResponsablePagoCargue ?? "R"],
    ["codResponsablePagoDescargue", data.codResponsablePagoDescargue ?? "D"],
    ["aceptacionElectronica", data.aceptacionElectronica ?? "NO"],
    ["codMunicipioPagoSaldo", data.codMunicipioPagoSaldo ?? null],
    ["tomadorPolizaCarga", data.tomadorPolizaCarga ?? "Empresa Transporte"],
    ["numeroPolizaTransporte", data.numeroPolizaTransporte ?? null],
    ["companiaSeguro", data.companiaSeguro ?? null],
    ["fechaVencimientoPolizaCarga", fechaMysql(data.fechaVencimientoPolizaCarga ?? null)],
  ];
}

export const plantillas = {
  /**
   * "Elimina" una plantilla. En realidad la desactiva (activa = 0): el
   * historial de viajes y remesas la referencia por id, asi que borrarla de
   * verdad rompería esos registros. findMany ya filtra por activa = 1, asi
   * que desaparece de la lista y de los selectores sin perder el historial.
   */
  async desactivar(id: number): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      "UPDATE plantillas_viaje SET activa = 0 WHERE id = ?",
      [id]
    );
    return res.affectedRows > 0;
  },

  async findMany(): Promise<PlantillaViajeConRelaciones[]> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM plantillas_viaje WHERE activa = 1");
    return Promise.all((rows as PlantillaViaje[]).map((p) => this.conRelaciones(p)));
  },
  async findById(id: number): Promise<PlantillaViajeConRelaciones | null> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM plantillas_viaje WHERE id = ?", [id]);
    const row = rows[0] as PlantillaViaje | undefined;
    return row ? this.conRelaciones(row) : null;
  },
  /**
   * Ruta con la que se guarda una plantilla.
   *
   * Lo que llegue explicito manda. Lo que falte se precarga con el municipio
   * del remitente (origen) y del destinatario (destino), que es lo que el
   * despachador usaria en el caso normal. Puede devolver null si el tercero
   * tampoco tiene municipio: quien llama decide si eso es un error.
   */
  async resolverRuta(
    remitenteId: number,
    destinatarioId: number,
    municipioOrigen?: string | null,
    municipioDestino?: string | null
  ): Promise<{ municipioOrigen: string | null; municipioDestino: string | null }> {
    const limpio = (c?: string | null) => (c ? String(c).replace(/\D/g, "") || null : null);
    let origen = limpio(municipioOrigen);
    let destino = limpio(municipioDestino);
    if (!origen) origen = limpio((await terceros.findById(remitenteId))?.codMunicipioRndc);
    if (!destino) destino = limpio((await terceros.findById(destinatarioId))?.codMunicipioRndc);
    return { municipioOrigen: origen, municipioDestino: destino };
  },

  /**
   * Plantillas cuya ruta coincide con un par de municipios.
   *
   * El cruce va contra la ruta explicita de la plantilla, que es la misma con
   * la que se consultan las vias y el piso de SICETAC. Asi lo que se actualiza
   * es exactamente lo que se va a despachar por esa ruta.
   */
  async buscarPorRuta(
    codMunicipioOrigen: string,
    codMunicipioDestino: string
  ): Promise<Array<PlantillaViaje & { municipioCargue: string; municipioDescargue: string }>> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT p.*,
              COALESCE(mo.nombre, co.ciudad, p.municipioOrigen) AS municipioCargue,
              COALESCE(md.nombre, cd.ciudad, p.municipioDestino) AS municipioDescargue
         FROM plantillas_viaje p
         ${JOIN_NOMBRES_RUTA}
        WHERE p.activa = 1
          AND p.municipioOrigen = ?
          AND p.municipioDestino = ?
        ORDER BY p.nombre`,
      [codMunicipioOrigen, codMunicipioDestino]
    );
    return rows as any[];
  },

  /**
   * Actualiza la tarifa base de todas las plantillas de una ruta.
   *
   * Pensado para cuando cambia SICETAC: en vez de entrar plantilla por
   * plantilla, se corrige la ruta completa de una sola vez.
   */
  async actualizarFletePorRuta(
    codMunicipioOrigen: string,
    codMunicipioDestino: string,
    valorFleteBase: number
  ): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE plantillas_viaje p
          SET p.valorFleteBase = ?, p.fleteActualizadoEn = ?
        WHERE p.activa = 1
          AND p.municipioOrigen = ?
          AND p.municipioDestino = ?`,
      [valorFleteBase, fechaMysql(new Date()), codMunicipioOrigen, codMunicipioDestino]
    );
    return res.affectedRows;
  },

  /**
   * Rutas distintas que hoy existen entre las plantillas activas, con cuantas
   * plantillas tiene cada una y el rango de tarifas. Es el punto de partida
   * para actualizar: muestra donde hay tarifas dispares en la misma ruta.
   */
  async rutasConTarifas(): Promise<
    Array<{
      codMunicipioOrigen: string;
      codMunicipioDestino: string;
      municipioOrigen: string;
      municipioDestino: string;
      plantillas: number;
      fleteMinimo: number | null;
      fleteMaximo: number | null;
      sinTarifa: number;
      ultimaActualizacion: Date | null;
    }>
  > {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT p.municipioOrigen AS codMunicipioOrigen,
              p.municipioDestino AS codMunicipioDestino,
              COALESCE(MAX(mo.nombre), MAX(co.ciudad), p.municipioOrigen) AS municipioOrigen,
              COALESCE(MAX(md.nombre), MAX(cd.ciudad), p.municipioDestino) AS municipioDestino,
              COUNT(*) AS plantillas,
              MIN(p.valorFleteBase) AS fleteMinimo,
              MAX(p.valorFleteBase) AS fleteMaximo,
              SUM(CASE WHEN p.valorFleteBase IS NULL THEN 1 ELSE 0 END) AS sinTarifa,
              MAX(p.fleteActualizadoEn) AS ultimaActualizacion
         FROM plantillas_viaje p
         ${JOIN_NOMBRES_RUTA}
        WHERE p.activa = 1
          AND p.municipioOrigen IS NOT NULL
          AND p.municipioDestino IS NOT NULL
        GROUP BY p.municipioOrigen, p.municipioDestino
        ORDER BY plantillas DESC`
    );
    return (rows as any[]).map((r) => ({
      ...r,
      plantillas: Number(r.plantillas),
      fleteMinimo: r.fleteMinimo === null ? null : Number(r.fleteMinimo),
      fleteMaximo: r.fleteMaximo === null ? null : Number(r.fleteMaximo),
      sinTarifa: Number(r.sinTarifa),
    }));
  },

  async conRelaciones(p: PlantillaViaje): Promise<PlantillaViajeConRelaciones> {
    const [contratante, remitente, destinatario, ruta] = await Promise.all([
      terceros.findById(p.contratanteId),
      terceros.findById(p.remitenteId),
      terceros.findById(p.destinatarioId),
      // La ruta es opcional y esta en desuso; se conserva para plantillas viejas.
      p.rutaId ? rutas.findById(p.rutaId) : Promise.resolve(null),
    ]);
    return {
      ...p,
      activa: !!(p as any).activa,
      titularEsRegimenSimple: !!p.titularEsRegimenSimple,
      contratante: contratante!,
      remitente: remitente!,
      destinatario: destinatario!,
      ruta: ruta!,
    };
  },
  async create(data: NuevaPlantilla): Promise<PlantillaViaje> {
    // Red de seguridad para quien no mande la ruta (seed, cargas masivas): se
    // precarga igual que en el formulario, desde el remitente y el destinatario.
    const ruta = await this.resolverRuta(
      data.remitenteId,
      data.destinatarioId,
      data.municipioOrigen,
      data.municipioDestino
    );
    const columnas = columnasPlantilla({ ...data, ...ruta });
    columnas.push(["fleteActualizadoEn", data.valorFleteBase ? fechaMysql(new Date()) : null]);

    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO plantillas_viaje (${columnas.map(([c]) => c).join(", ")})
       VALUES (${columnas.map(() => "?").join(", ")})`,
      columnas.map(([, v]) => v)
    );
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM plantillas_viaje WHERE id = ?", [
      result.insertId,
    ]);
    return rows[0] as PlantillaViaje;
  },

  /**
   * Reemplaza los datos de una plantilla existente.
   *
   * Los viajes ya despachados no cambian: el XML que se envio al RNDC quedo
   * registrado con los valores de ese momento. Esto solo afecta lo que se
   * despache de aqui en adelante.
   */
  async update(id: number, data: NuevaPlantilla): Promise<PlantillaViaje | null> {
    const [actuales] = await pool.query<RowDataPacket[]>(
      "SELECT valorFleteBase FROM plantillas_viaje WHERE id = ?",
      [id]
    );
    const actual = actuales[0] as Pick<PlantillaViaje, "valorFleteBase"> | undefined;
    if (!actual) return null;

    const columnas = columnasPlantilla(data);
    // La fecha de la tarifa solo se mueve si la tarifa cambio: es la que dice
    // que plantillas quedaron rezagadas tras un cambio de SICETAC.
    const fleteNuevo = data.valorFleteBase ?? null;
    const fleteAnterior = actual.valorFleteBase === null ? null : Number(actual.valorFleteBase);
    if (fleteNuevo !== fleteAnterior) {
      columnas.push(["fleteActualizadoEn", fleteNuevo ? fechaMysql(new Date()) : null]);
    }

    await pool.query(
      `UPDATE plantillas_viaje SET ${columnas.map(([c]) => `${c} = ?`).join(", ")} WHERE id = ?`,
      [...columnas.map(([, v]) => v), id]
    );
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM plantillas_viaje WHERE id = ?", [id]);
    return rows[0] as PlantillaViaje;
  },
};

// ---------- Remesas de un viaje ----------

/**
 * Una remesa concreta dentro de un viaje. Un manifiesto general lleva una;
 * uno multiparada, hasta cinco.
 */
export interface ViajeRemesa {
  id: number;
  viajeId: number;
  plantillaId: number;
  orden: number;
  consecutivoRemesa: string | null;
  numeroRemesaRndc: string | null;
  pesoReal: number | null;
  cantidadReal: number | null;
  fechaHoraCargue: Date;
  fechaHoraDescargue: Date;
  ordenServicioGenerador: string | null;
  /** Parte del flete que corresponde a esta remesa, para ponderar el ICA. */
  valorFleteRemesa: number | null;
  estado: string; // PENDIENTE | CREADA | ERROR
  mensajeError: string | null;
}

export interface NuevaViajeRemesa {
  plantillaId: number;
  orden: number;
  pesoReal: number | null;
  cantidadReal: number | null;
  fechaHoraCargue: Date;
  fechaHoraDescargue: Date;
  ordenServicioGenerador?: string | null;
  valorFleteRemesa?: number | null;
  /** Consecutivo ya calculado a partir del numero base del viaje. */
  consecutivoRemesa?: string | null;
}

export const viajeRemesas = {
  async findById(id: number): Promise<ViajeRemesa | null> {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM viaje_remesas WHERE id = ?",
      [id]
    );
    return (rows[0] as ViajeRemesa) ?? null;
  },

  async findByViaje(viajeId: number): Promise<ViajeRemesa[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM viaje_remesas WHERE viajeId = ? ORDER BY orden",
      [viajeId]
    );
    return rows as ViajeRemesa[];
  },

  /**
   * Crea las remesas de un viaje y les asigna su consecutivo.
   *
   * El consecutivo sale del id de la propia fila, no del id del viaje: con
   * varias remesas por viaje, usar el id del viaje las repetiria, y el RNDC
   * rechaza consecutivos duplicados dentro de la empresa.
   */
  async crearParaViaje(viajeId: number, remesas: NuevaViajeRemesa[]): Promise<ViajeRemesa[]> {
    for (const r of remesas) {
      const [result] = await pool.query<ResultSetHeader>(
        `INSERT INTO viaje_remesas
          (viajeId, plantillaId, orden, pesoReal, cantidadReal, fechaHoraCargue,
           fechaHoraDescargue, ordenServicioGenerador, valorFleteRemesa)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          viajeId,
          r.plantillaId,
          r.orden,
          r.pesoReal,
          r.cantidadReal,
          fechaMysql(r.fechaHoraCargue),
          fechaMysql(r.fechaHoraDescargue),
          r.ordenServicioGenerador ?? null,
          r.valorFleteRemesa ?? null,
        ]
      );
      // El consecutivo viene calculado desde el numero base del viaje
      // (00006692, 00006692A...), no del id interno: la empresa numera por
      // viaje y el manifiesto comparte el mismo numero.
      if (r.consecutivoRemesa) {
        await pool.query("UPDATE viaje_remesas SET consecutivoRemesa = ? WHERE id = ?", [
          r.consecutivoRemesa,
          result.insertId,
        ]);
      }
    }
    return this.findByViaje(viajeId);
  },

  async update(id: number, data: Partial<Omit<ViajeRemesa, "id">>): Promise<void> {
    const campos = Object.keys(data);
    if (campos.length === 0) return;
    const sets = campos.map((c) => `${c} = ?`).join(", ");
    const valores = campos.map((c) => (data as any)[c]);
    await pool.query(`UPDATE viaje_remesas SET ${sets} WHERE id = ?`, [...valores, id]);
  },
};

// ---------- Viajes ----------
export const viajes = {
  async findById(id: number): Promise<Viaje | null> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM viajes WHERE id = ?", [id]);
    const row = rows[0] as Viaje | undefined;
    return row ? mapViaje(row) : null;
  },
  async findMany(limit = 100): Promise<Viaje[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM viajes ORDER BY fechaCreacion DESC LIMIT ?",
      [limit]
    );
    return (rows as Viaje[]).map(mapViaje);
  },

  /**
   * Marca uno o varios viajes como incluidos en un pago de FOPAT a la DIAN.
   * El pago es mensual y agrupado, asi que se marca por lote.
   */
  async marcarFopatPagado(ids: number[], fechaPago: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE viajes SET fopatPagado = 1, fechaPagoFopat = ?
        WHERE id IN (${ids.map(() => "?").join(",")})`,
      [fechaMysql(fechaPago), ...ids]
    );
    return res.affectedRows;
  },

  /**
   * FOPAT causado y pendiente de pago, agrupado por mes de expedicion.
   * Es el insumo para la declaracion mensual a la DIAN.
   */
  async resumenFopat(): Promise<
    Array<{ mes: string; manifiestos: number; causado: number; pendiente: number }>
  > {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT DATE_FORMAT(fechaHoraCargue, '%Y-%m') AS mes,
              COUNT(*) AS manifiestos,
              COALESCE(SUM(retencionFopat), 0) AS causado,
              COALESCE(SUM(CASE WHEN fopatPagado = 0 THEN retencionFopat ELSE 0 END), 0) AS pendiente
         FROM viajes
        WHERE estado = 'CONFIRMADO' AND retencionFopat IS NOT NULL
        GROUP BY mes
        ORDER BY mes DESC`
    );
    return (rows as any[]).map((r) => ({
      mes: r.mes,
      manifiestos: Number(r.manifiestos),
      causado: Number(r.causado),
      pendiente: Number(r.pendiente),
    }));
  },

  /**
   * Todos los consecutivos ya usados, de manifiestos y de remesas.
   *
   * El RNDC no permite repetirlos dentro de la empresa, y el rechazo llega
   * despues de haber creado las remesas. Sale mas barato comprobarlo aqui.
   */
  async consecutivosUsados(): Promise<Set<string>> {
    const [manifiestos] = await pool.query<RowDataPacket[]>(
      "SELECT consecutivoManifiesto AS c FROM viajes WHERE consecutivoManifiesto IS NOT NULL"
    );
    const [remesas] = await pool.query<RowDataPacket[]>(
      "SELECT consecutivoRemesa AS c FROM viaje_remesas WHERE consecutivoRemesa IS NOT NULL"
    );
    const usados = new Set<string>();
    for (const fila of [...(manifiestos as any[]), ...(remesas as any[])]) {
      if (fila.c) usados.add(String(fila.c).toUpperCase());
    }
    return usados;
  },

  /** Ultimo numero base usado, para sugerir el siguiente. */
  async ultimoConsecutivo(): Promise<string | null> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT consecutivoManifiesto AS c FROM viajes
        WHERE consecutivoManifiesto IS NOT NULL
        ORDER BY CAST(REGEXP_REPLACE(consecutivoManifiesto, '[^0-9]', '') AS UNSIGNED) DESC
        LIMIT 1`
    );
    return (rows[0] as any)?.c ?? null;
  },

  /**
   * Cuenta los manifiestos ya expedidos para un vehiculo en una fecha de
   * expedicion. El RNDC no permite mas de 10 por placa y dia (salvo los
   * municipales), asi que conviene saberlo antes de intentar el numero 11.
   *
   * Solo cuenta los que llegaron al RNDC: los que fallaron antes de enviarse
   * no ocupan cupo alla.
   */
  /**
   * Manifiestos de la placa en ese dia. `excluirViajeId` evita que un viaje
   * que se esta reintentando (en MANIFIESTO_ERROR) se cuente a si mismo.
   */
  async contarPorVehiculoYFecha(vehiculoId: number, fecha: Date, excluirViajeId = 0): Promise<number> {
    const dia = fecha.toISOString().slice(0, 10);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM viajes
        WHERE vehiculoId = ?
          AND DATE(fechaHoraCargue) = ?
          AND estado IN ('CONFIRMADO', 'MANIFIESTO_ERROR')
          AND id <> ?`,
      [vehiculoId, dia, excluirViajeId]
    );
    return Number((rows[0] as any).total ?? 0);
  },

  /**
   * Toma el viaje para reintentarlo solo si sigue en un estado reintentable.
   * Es un UPDATE condicional (atomico): si llegan dos reintentos a la vez (doble
   * clic), solo uno lo consigue y el otro no reenvia remesas al RNDC.
   */
  async tomarParaReintento(id: number, estadosPermitidos: string[]): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE viajes SET estado = 'REINTENTANDO' WHERE id = ? AND estado IN (?)`,
      [id, estadosPermitidos]
    );
    return res.affectedRows === 1;
  },
  async create(data: {
    plantillaId: number;
    vehiculoId: number;
    conductorId: number;
    fechaHoraCargue: Date;
    pesoReal: number | null;
    cantidadReal: number | null;
    valorFleteReal: number | null;
    valorAnticipoManifiesto?: number;
    retencionFopat?: number | null;
    codVia?: string | null;
    nitMonitoreoFlota?: string | null;
    /** Numero base del viaje. Tambien es el consecutivo del manifiesto. */
    consecutivoManifiesto?: string | null;
    fechaPagoSaldo?: Date | null;
    conductor2Id?: number | null;
    remolqueId?: number | null;
    fechaHoraDescargue: Date;
    viajesDia?: number | null;
    ordenServicioGenerador?: string | null;
    vacio1Origen?: string | null;
    vacio1Destino?: string | null;
    vacio1Valor?: number;
    vacio2Origen?: string | null;
    vacio2Destino?: string | null;
    vacio2Valor?: number;
  }): Promise<Viaje> {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO viajes
        (plantillaId, vehiculoId, conductorId, fechaHoraCargue, fechaHoraDescargue, pesoReal, cantidadReal,
         valorFleteReal, valorAnticipoManifiesto, retencionFopat, codVia, nitMonitoreoFlota, fechaPagoSaldo, conductor2Id, remolqueId,
         viajesDia, ordenServicioGenerador,
         vacio1Origen, vacio1Destino, vacio1Valor, vacio2Origen, vacio2Destino, vacio2Valor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.plantillaId,
        data.vehiculoId,
        data.conductorId,
        fechaMysql(data.fechaHoraCargue),
        fechaMysql(data.fechaHoraDescargue),
        data.pesoReal,
        data.cantidadReal,
        data.valorFleteReal,
        data.valorAnticipoManifiesto ?? 0,
        data.retencionFopat ?? null,
        data.codVia ?? null,
        data.nitMonitoreoFlota ?? null,
        fechaMysql(data.fechaPagoSaldo ?? null),
        data.conductor2Id ?? null,
        data.remolqueId ?? null,
        data.viajesDia ?? null,
        data.ordenServicioGenerador ?? null,
        data.vacio1Origen ?? null,
        data.vacio1Destino ?? null,
        data.vacio1Valor ?? 0,
        data.vacio2Origen ?? null,
        data.vacio2Destino ?? null,
        data.vacio2Valor ?? 0,
      ]
    );
    // El consecutivo del manifiesto (NUMMANIFIESTOCARGA) es el numero base del
    // viaje, que el despachador puede editar. El de las remesas sale del mismo
    // base con sufijo de letra y se asigna en viajeRemesas.crearParaViaje.
    const id = result.insertId;
    if (data.consecutivoManifiesto) {
      await pool.query("UPDATE viajes SET consecutivoManifiesto = ? WHERE id = ?", [
        data.consecutivoManifiesto,
        id,
      ]);
    }
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
