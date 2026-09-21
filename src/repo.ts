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
  /** @deprecated La ruta se deduce de los municipios de cargue y descargue. */
  rutaId: number | null;
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
};

// ---------- Vehiculos ----------
export const vehiculos = {
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
    > &
      Partial<
        Pick<
          Vehiculo,
          "codTipoIdTenedor" | "numIdTenedor" | "codTipoCarroceria" | "pesoVehiculoVacio" | "aplicaFopat"
        >
      >
  ): Promise<Vehiculo> {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO vehiculos
        (placa, placaRemolque, marca, configuracion, capacidadKg, propietarioNit, fechaVencSoat, fechaVencTecnomecanica,
         codTipoIdTenedor, numIdTenedor, codTipoCarroceria, pesoVehiculoVacio, aplicaFopat)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ]
    );
    return (await this.findById(result.insertId))!;
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
    const nuevo = { ...actual, ...data };
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
  /**
   * Plantillas cuya ruta efectiva coincide con un par de municipios.
   *
   * "Ruta efectiva" es el municipio del sitio de cargue (remitente) y el del
   * sitio de descargue (destinatario), que es de donde salen el origen y el
   * destino del manifiesto. Por eso el cruce va contra terceros y no contra
   * una tabla de rutas: asi lo que se actualiza es exactamente lo que se va a
   * despachar por esa ruta.
   */
  async buscarPorRuta(
    codMunicipioOrigen: string,
    codMunicipioDestino: string
  ): Promise<Array<PlantillaViaje & { municipioCargue: string; municipioDescargue: string }>> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT p.*, tr.ciudad AS municipioCargue, td.ciudad AS municipioDescargue
         FROM plantillas_viaje p
         JOIN terceros tr ON tr.id = p.remitenteId
         JOIN terceros td ON td.id = p.destinatarioId
        WHERE p.activa = 1
          AND tr.codMunicipioRndc = ?
          AND td.codMunicipioRndc = ?
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
         JOIN terceros tr ON tr.id = p.remitenteId
         JOIN terceros td ON td.id = p.destinatarioId
          SET p.valorFleteBase = ?, p.fleteActualizadoEn = ?
        WHERE p.activa = 1
          AND tr.codMunicipioRndc = ?
          AND td.codMunicipioRndc = ?`,
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
      `SELECT tr.codMunicipioRndc AS codMunicipioOrigen,
              td.codMunicipioRndc AS codMunicipioDestino,
              MAX(tr.ciudad) AS municipioOrigen,
              MAX(td.ciudad) AS municipioDestino,
              COUNT(*) AS plantillas,
              MIN(p.valorFleteBase) AS fleteMinimo,
              MAX(p.valorFleteBase) AS fleteMaximo,
              SUM(CASE WHEN p.valorFleteBase IS NULL THEN 1 ELSE 0 END) AS sinTarifa,
              MAX(p.fleteActualizadoEn) AS ultimaActualizacion
         FROM plantillas_viaje p
         JOIN terceros tr ON tr.id = p.remitenteId
         JOIN terceros td ON td.id = p.destinatarioId
        WHERE p.activa = 1
          AND tr.codMunicipioRndc IS NOT NULL
          AND td.codMunicipioRndc IS NOT NULL
        GROUP BY tr.codMunicipioRndc, td.codMunicipioRndc
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
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO plantillas_viaje
        (nombre, contratanteId, remitenteId, destinatarioId, rutaId, tipoMercancia, naturalezaCarga, unidadMedida,
         valorFleteBase, fleteActualizadoEn, observaciones, codOperacionTransporte, tipoOperacionRemesa, tipoManifiesto,
         codMunicipioIntermedio, codNaturalezaCarga, codUnidadMedida, codTipoEmpaque, codMercancia,
         subpartidaCode, codigoArancelCode, empaquePrimario, unidadMedidaProducto,
         horasPactoCargue, minutosPactoCargue, horasPactoDescargue, minutosPactoDescargue,
         retencionIcaManifiesto, factorIcaCargue, tarifaRetencionFuente, titularEsRegimenSimple,
         codResponsablePagoCargue, codResponsablePagoDescargue, aceptacionElectronica, codMunicipioPagoSaldo,
         tomadorPolizaCarga, numeroPolizaTransporte, companiaSeguro, fechaVencimientoPolizaCarga)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.nombre,
        data.contratanteId,
        data.remitenteId,
        data.destinatarioId,
        data.rutaId,
        data.tipoMercancia ?? null,
        data.naturalezaCarga ?? null,
        data.unidadMedida ?? null,
        data.valorFleteBase ?? null,
        data.valorFleteBase ? fechaMysql(new Date()) : null,
        data.observaciones ?? null,
        // Columna heredada, ya sin uso: se conserva sincronizada con el tipo de
        // manifiesto para no romper bases de datos existentes.
        data.tipoManifiesto ?? "G",
        data.tipoOperacionRemesa ?? "G",
        data.tipoManifiesto ?? "G",
        data.codMunicipioIntermedio ?? null,
        // Esta empresa solo mueve carga general.
        data.codNaturalezaCarga ?? "1",
        data.codUnidadMedida ?? "1",
        data.codTipoEmpaque ?? "0",
        data.codMercancia ?? null,
        data.subpartidaCode ?? null,
        data.codigoArancelCode ?? null,
        data.empaquePrimario ?? null,
        data.unidadMedidaProducto ?? "KGM",
        data.horasPactoCargue ?? 1,
        data.minutosPactoCargue ?? 0,
        data.horasPactoDescargue ?? 1,
        data.minutosPactoDescargue ?? 0,
        data.retencionIcaManifiesto ?? 0,
        // Si no se informa aparte, el factor de cargue es el mismo del manifiesto.
        data.factorIcaCargue ?? data.retencionIcaManifiesto ?? 0,
        data.tarifaRetencionFuente ?? 0.01,
        (data.titularEsRegimenSimple ?? false) ? 1 : 0,
        data.codResponsablePagoCargue ?? "R",
        data.codResponsablePagoDescargue ?? "D",
        data.aceptacionElectronica ?? "NO",
        data.codMunicipioPagoSaldo ?? null,
        data.tomadorPolizaCarga ?? "Empresa Transporte",
        data.numeroPolizaTransporte ?? null,
        data.companiaSeguro ?? null,
        fechaMysql(data.fechaVencimientoPolizaCarga ?? null),
      ]
    );
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM plantillas_viaje WHERE id = ?", [
      result.insertId,
    ]);
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
      const consecutivo = `${config.consecutivos.prefijoRemesa}${
        config.consecutivos.inicioRemesa + result.insertId
      }`;
      await pool.query("UPDATE viaje_remesas SET consecutivoRemesa = ? WHERE id = ?", [
        consecutivo,
        result.insertId,
      ]);
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
   * Cuenta los manifiestos ya expedidos para un vehiculo en una fecha de
   * expedicion. El RNDC no permite mas de 10 por placa y dia (salvo los
   * municipales), asi que conviene saberlo antes de intentar el numero 11.
   *
   * Solo cuenta los que llegaron al RNDC: los que fallaron antes de enviarse
   * no ocupan cupo alla.
   */
  async contarPorVehiculoYFecha(vehiculoId: number, fecha: Date): Promise<number> {
    const dia = fecha.toISOString().slice(0, 10);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM viajes
        WHERE vehiculoId = ?
          AND DATE(fechaHoraCargue) = ?
          AND estado IN ('CONFIRMADO', 'MANIFIESTO_ERROR')`,
      [vehiculoId, dia]
    );
    return Number((rows[0] as any).total ?? 0);
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
         valorFleteReal, valorAnticipoManifiesto, retencionFopat, codVia, fechaPagoSaldo, conductor2Id, remolqueId,
         viajesDia, ordenServicioGenerador,
         vacio1Origen, vacio1Destino, vacio1Valor, vacio2Origen, vacio2Destino, vacio2Valor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    // El consecutivo propio (CONSECUTIVOREMESA / NUMMANIFIESTOCARGA) se genera a partir
    // del id interno una vez conocido, mas un prefijo/inicio configurable (ver config.ts)
    // para poder continuar una numeracion ya existente en la empresa sin repetir nada.
    const id = result.insertId;
    // El consecutivo de REMESA ya no se genera aqui: vive en viaje_remesas,
    // porque un viaje puede llevar varias.
    const consecutivoManifiesto = `${config.consecutivos.prefijoManifiesto}${
      config.consecutivos.inicioManifiesto + id
    }`;
    await pool.query("UPDATE viajes SET consecutivoManifiesto = ? WHERE id = ?", [
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
