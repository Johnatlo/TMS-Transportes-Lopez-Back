/**
 * Cuadro pagos: control operativo y financiero de los viajes.
 *
 * Reemplaza la hoja "CUADRO PAGOS" de Excel. Cada fila es un viaje
 * facturable (empresa + remision), tenga manifiesto o no. El estado no se
 * pinta a mano como en el Excel: se deduce de los datos.
 *
 * Colores del Excel y su equivalente aqui:
 * - blanco: en proceso (EN_RUTA, o sin nada especial)
 * - morado: descargo y los papeles aun no estan radicados (las secretarias
 *   llaman al conductor)
 * - verde (remision): papeles radicados en el cliente
 * - azul (fecha): facturado, pero sin numero ni fecha de factura anotados
 * - naranja: revisado por contabilidad, falta la gerente
 * - amarillo: todo pagado
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "./db";

export type EstadoPapeles = "EN_RUTA" | "CONDUCTOR" | "PARQUEADERO" | "OFICINA" | "RADICADO";
export const ESTADOS_PAPELES: EstadoPapeles[] = ["EN_RUTA", "CONDUCTOR", "PARQUEADERO", "OFICINA", "RADICADO"];
/** Fuera del flujo de CORAME no hay parqueadero ni oficina: del conductor se pasa a radicado. */
export const ESTADOS_PAPELES_OTROS_CLIENTES: EstadoPapeles[] = ["EN_RUTA", "CONDUCTOR", "RADICADO"];

export type Flota = "LOPEZ" | "MYC" | "TERCERO";
export const FLOTAS: Flota[] = ["LOPEZ", "MYC", "TERCERO"];

/** Dias para pagarle el saldo a un tercero despues de entregar el viaje. */
export const DIAS_PAGO_TERCEROS = 15;

/** El flujo largo de papeles (parqueadero, Don Alexander) es solo de este cliente. */
export const CLIENTE_FLUJO_LARGO = /CORAME|CARTONES\s+AMERICA/i;

export type EstadoCuadro = "ANULADO" | "PAGADO" | "FACTURADO" | "FACTURADO_SIN_DATOS" | "RADICADO" | "SIN_RADICAR" | "EN_RUTA";

export interface FilaCuadro {
  id: number;
  fecha: string;
  vehiculoId: number | null;
  placa: string;
  flota: Flota;
  conductor: string | null;
  empresa: string;
  viajeId: number | null;
  viajeRemesaId: number | null;
  manifiesto: string | null;
  remesa: string | null;
  remision: string | null;
  pesoKg: number | null;
  tipoFlete: "KILO" | "FIJO";
  tarifaKilo: number | null;
  valorFijo: number | null;
  /** KILO: kilos x tarifa. FIJO: el valor fijo. */
  valorFlete: number | null;
  fechaDescargue: string | null;
  estadoPapeles: EstadoPapeles;
  flujoCorame: boolean;
  fechaRadicado: string | null;
  facturado: boolean;
  facturaNumero: string | null;
  facturaFecha: string | null;
  facturaFechaPago: string | null;
  fechaPagoSaldo: string | null;
  /** Terceros: fecha de descargue + 15 dias. Flota propia: null. */
  venceSaldo: string | null;
  revisadoContabilidadPor: string | null;
  revisadoContabilidadEn: string | null;
  revisadoGerenciaPor: string | null;
  revisadoGerenciaEn: string | null;
  anulado: boolean;
  totalAnticipos: number;
  anticiposSinPagar: number;
  notas: number;
  ultimaNota: string | null;
  estado: EstadoCuadro;
  /** Factura cobrada, saldo del tercero pagado y anticipos pagados a la bomba (amarillo). */
  todoPagado: boolean;
}

/** Numero de MySQL (DECIMAL llega como texto) a number; null se conserva. */
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
/**
 * DATE de MySQL como "AAAA-MM-DD". El pool trabaja en UTC (timezone "Z"): un
 * DATE llega como medianoche UTC, asi que se lee en UTC para no correrse un dia.
 */
const dia = (v: unknown): string | null => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
/** Fecha de hoy en Colombia (el servidor corre en UTC: de noche ya seria manana). */
const hoyColombia = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
/**
 * Suma dias a una fecha "AAAA-MM-DD" y devuelve otra "AAAA-MM-DD".
 * Trabaja a mediodia UTC para que ningun cambio de zona la corra de dia.
 * Se usa para el vencimiento del saldo de terceros (descargue + 15 dias).
 */
export const sumarDias = (fecha: string, dias: number) => {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

/** Estado de una fila a partir de sus datos (exportado para las pruebas). */
export function estadoDe(f: Omit<FilaCuadro, "estado" | "todoPagado">): { estado: EstadoCuadro; todoPagado: boolean } {
  const saldoPagado = f.flota !== "TERCERO" || !!f.fechaPagoSaldo;
  const todoPagado = !!f.facturaFechaPago && saldoPagado && f.anticiposSinPagar === 0;
  if (f.anulado) return { estado: "ANULADO", todoPagado: false };
  if (f.facturaFechaPago) return { estado: "PAGADO", todoPagado };
  if (f.facturaNumero) return { estado: "FACTURADO", todoPagado };
  if (f.facturado) return { estado: "FACTURADO_SIN_DATOS", todoPagado };
  if (f.estadoPapeles === "RADICADO") return { estado: "RADICADO", todoPagado };
  if (f.estadoPapeles !== "EN_RUTA") return { estado: "SIN_RADICAR", todoPagado };
  return { estado: "EN_RUTA", todoPagado };
}

const SELECT_CUADRO = `
  SELECT c.*, COALESCE(ve.flota, 'TERCERO') AS flota,
         uc.nombre AS revisadoContabilidadPor, ug.nombre AS revisadoGerenciaPor,
         COALESCE(a.total, 0) AS totalAnticipos, COALESCE(a.sinPagar, 0) AS anticiposSinPagar,
         COALESCE(n.cuantas, 0) AS notas,
         (SELECT texto FROM cuadro_notas WHERE cuadroViajeId = c.id ORDER BY id DESC LIMIT 1) AS ultimaNota
    FROM cuadro_viajes c
    LEFT JOIN vehiculos ve ON ve.id = c.vehiculoId
    LEFT JOIN usuarios uc ON uc.id = c.revisadoContabilidadPorId
    LEFT JOIN usuarios ug ON ug.id = c.revisadoGerenciaPorId
    LEFT JOIN (SELECT cuadroViajeId, SUM(valor) AS total, SUM(fechaPago IS NULL) AS sinPagar
                 FROM cuadro_anticipos GROUP BY cuadroViajeId) a ON a.cuadroViajeId = c.id
    LEFT JOIN (SELECT cuadroViajeId, COUNT(*) AS cuantas FROM cuadro_notas GROUP BY cuadroViajeId) n
           ON n.cuadroViajeId = c.id`;

/**
 * Fila de SELECT_CUADRO -> FilaCuadro.
 *
 * Normaliza tipos (fechas a texto, numeros, booleanos), calcula el valor del
 * flete (kilos x tarifa, o el fijo), el vencimiento del saldo si es tercero, y
 * el estado con estadoDe.
 */
function mapear(r: RowDataPacket): FilaCuadro {
  const base = {
    id: r.id,
    fecha: dia(r.fecha)!,
    vehiculoId: r.vehiculoId,
    placa: r.placa,
    flota: (r.flota ?? "TERCERO") as Flota,
    conductor: r.conductor,
    empresa: r.empresa,
    viajeId: r.viajeId,
    viajeRemesaId: r.viajeRemesaId,
    manifiesto: r.manifiesto,
    remesa: r.remesa,
    remision: r.remision,
    pesoKg: num(r.pesoKg),
    tipoFlete: r.tipoFlete === "FIJO" ? ("FIJO" as const) : ("KILO" as const),
    tarifaKilo: num(r.tarifaKilo),
    valorFijo: num(r.valorFijo),
    valorFlete:
      r.tipoFlete === "FIJO"
        ? num(r.valorFijo)
        : r.pesoKg !== null && r.tarifaKilo !== null
          ? Math.round(Number(r.pesoKg) * Number(r.tarifaKilo))
          : null,
    fechaDescargue: dia(r.fechaDescargue),
    estadoPapeles: r.estadoPapeles as EstadoPapeles,
    flujoCorame: !!r.flujoCorame,
    fechaRadicado: dia(r.fechaRadicado),
    facturado: !!r.facturado,
    facturaNumero: r.facturaNumero,
    facturaFecha: dia(r.facturaFecha),
    facturaFechaPago: dia(r.facturaFechaPago),
    fechaPagoSaldo: dia(r.fechaPagoSaldo),
    venceSaldo: null as string | null,
    revisadoContabilidadPor: r.revisadoContabilidadPor ?? null,
    revisadoContabilidadEn: r.revisadoContabilidadEn ? new Date(r.revisadoContabilidadEn).toISOString() : null,
    revisadoGerenciaPor: r.revisadoGerenciaPor ?? null,
    revisadoGerenciaEn: r.revisadoGerenciaEn ? new Date(r.revisadoGerenciaEn).toISOString() : null,
    anulado: !!r.anulado,
    totalAnticipos: Number(r.totalAnticipos ?? 0),
    anticiposSinPagar: Number(r.anticiposSinPagar ?? 0),
    notas: Number(r.notas ?? 0),
    ultimaNota: r.ultimaNota ?? null,
  };
  if (base.flota === "TERCERO" && base.fechaDescargue) base.venceSaldo = sumarDias(base.fechaDescargue, DIAS_PAGO_TERCEROS);
  return { ...base, ...estadoDe(base) };
}

/** Campos que se pueden editar de una fila, con su tipo. */
const CAMPOS_EDITABLES: Record<string, "texto" | "numero" | "fecha" | "booleano"> = {
  fecha: "fecha",
  placa: "texto",
  conductor: "texto",
  empresa: "texto",
  manifiesto: "texto",
  remision: "texto",
  pesoKg: "numero",
  tipoFlete: "texto",
  tarifaKilo: "numero",
  valorFijo: "numero",
  fechaDescargue: "fecha",
  estadoPapeles: "texto",
  flujoCorame: "booleano",
  fechaRadicado: "fecha",
  facturado: "booleano",
  facturaNumero: "texto",
  facturaFecha: "fecha",
  facturaFechaPago: "fecha",
  fechaPagoSaldo: "fecha",
};

/** Error de validacion del cuadro: la ruta lo responde como 422 con su mensaje. */
export class ErrorCuadro extends Error {}

/**
 * Convierte un valor del formulario al tipo de su columna.
 *
 * booleano -> 1/0; vacio -> null; numero -> number >= 0 (si no, ErrorCuadro);
 * fecha -> "AAAA-MM-DD" valida; texto -> recortado.
 */
function valorCampo(campo: string, tipo: string, crudo: unknown): unknown {
  const vacio = crudo === null || crudo === undefined || String(crudo).trim() === "";
  if (tipo === "booleano") return crudo ? 1 : 0;
  if (vacio) return null;
  if (tipo === "numero") {
    const n = Number(crudo);
    if (!Number.isFinite(n) || n < 0) throw new ErrorCuadro(`"${campo}" debe ser un numero positivo.`);
    return n;
  }
  if (tipo === "fecha") {
    const t = String(crudo).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new ErrorCuadro(`"${campo}" no es una fecha valida.`);
    return t;
  }
  return String(crudo).trim();
}

/**
 * Revisa y normaliza los datos antes de guardar: tipo de flete KILO/FIJO,
 * estado de papeles valido, placa en mayuscula sin guiones ni espacios, y
 * empresa en mayuscula. Lanza ErrorCuadro si algo no es valido.
 */
function validar(datos: Record<string, unknown>) {
  if ("tipoFlete" in datos && !["KILO", "FIJO"].includes(String(datos.tipoFlete))) {
    throw new ErrorCuadro("El flete es por kilo (KILO) o fijo (FIJO).");
  }
  if ("estadoPapeles" in datos && !(ESTADOS_PAPELES as string[]).includes(String(datos.estadoPapeles))) {
    throw new ErrorCuadro("Estado de papeles no valido.");
  }
  if ("placa" in datos) datos.placa = String(datos.placa ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if ("empresa" in datos) datos.empresa = String(datos.empresa ?? "").trim().toUpperCase();
}

/** Repositorio del cuadro pagos: viajes, notas y anticipos de bomba. */
export const cuadro = {
  /**
   * Trae al cuadro los viajes con manifiesto expedido (una fila por remesa) y
   * marca como anulados los que se anularon. Es idempotente: la llave unica
   * de viajeRemesaId impide repetirlos, y no toca lo que ya se diligencio.
   */
  async sincronizarManifiestos(): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT IGNORE INTO cuadro_viajes
         (fecha, vehiculoId, placa, conductor, empresa, viajeId, viajeRemesaId,
          manifiesto, remesa, pesoKg, fechaDescargue, flujoCorame, creadoPorId)
       SELECT DATE(DATE_SUB(v.fechaCreacion, INTERVAL 5 HOUR)), v.vehiculoId, ve.placa, c.nombre,
              UPPER(COALESCE(con.nombre, 'SIN CLIENTE')), v.id, vr.id,
              v.consecutivoManifiesto, vr.consecutivoRemesa, vr.pesoReal,
              DATE(DATE_SUB(vr.fechaHoraDescargue, INTERVAL 5 HOUR)),
              COALESCE(con.nombre, '') REGEXP 'CORAME|CARTONES[[:space:]]+AMERICA', v.creadoPorId
         FROM viaje_remesas vr
         JOIN viajes v ON v.id = vr.viajeId
         JOIN vehiculos ve ON ve.id = v.vehiculoId
         LEFT JOIN conductores c ON c.id = v.conductorId
         LEFT JOIN plantillas_viaje p ON p.id = vr.plantillaId
         LEFT JOIN terceros con ON con.id = p.contratanteId
        WHERE v.estado IN ('CONFIRMADO', 'CUMPLIDO') AND vr.estado <> 'ANULADA'`
    );
    await pool.query(
      `UPDATE cuadro_viajes cv JOIN viajes v ON v.id = cv.viajeId
          SET cv.anulado = (v.estado = 'ANULADO')
        WHERE cv.anulado <> (v.estado = 'ANULADO')`
    );
    return res.affectedRows;
  },

  /**
   * Todos los viajes del cuadro, del mas reciente al mas antiguo. Antes de
   * listar sincroniza los manifiestos expedidos, para que siempre esten todos.
   */
  async listar(): Promise<FilaCuadro[]> {
    await this.sincronizarManifiestos();
    const [rows] = await pool.query<RowDataPacket[]>(`${SELECT_CUADRO} ORDER BY c.fecha DESC, c.id DESC`);
    return rows.map(mapear);
  },

  /**
   * Un viaje con sus anticipos (con nombre de la bomba y quien los registro) y
   * sus notas (con autor), la mas reciente primero. null si no existe.
   */
  async obtener(id: number) {
    const [rows] = await pool.query<RowDataPacket[]>(`${SELECT_CUADRO} WHERE c.id = ?`, [id]);
    if (!rows[0]) return null;
    const [anticipos] = await pool.query<RowDataPacket[]>(
      `SELECT a.id, a.bombaId, b.nombre AS bomba, b.ciudad, a.valor, a.fecha, a.fechaPago, a.nota,
              u.nombre AS creadoPor, a.creadoEn
         FROM cuadro_anticipos a JOIN bombas b ON b.id = a.bombaId
         LEFT JOIN usuarios u ON u.id = a.creadoPorId
        WHERE a.cuadroViajeId = ? ORDER BY a.fecha, a.id`,
      [id]
    );
    const [notas] = await pool.query<RowDataPacket[]>(
      `SELECT n.id, n.texto, n.creadaEn, u.nombre AS autor
         FROM cuadro_notas n LEFT JOIN usuarios u ON u.id = n.usuarioId
        WHERE n.cuadroViajeId = ? ORDER BY n.id DESC`,
      [id]
    );
    return {
      ...mapear(rows[0]),
      anticipos: anticipos.map((a) => ({
        ...a,
        valor: Number(a.valor),
        fecha: dia(a.fecha),
        fechaPago: dia(a.fechaPago),
        creadoEn: new Date(a.creadoEn).toISOString(),
      })),
      listaNotas: notas.map((n) => ({ ...n, creadaEn: new Date(n.creadaEn).toISOString() })),
    };
  },

  /** Viaje sin manifiesto (urbano o planillado por el generador de carga). */
  async crear(datos: Record<string, unknown>, usuarioId: number | null): Promise<number> {
    validar(datos);
    if (!datos.placa) throw new ErrorCuadro("La placa es obligatoria.");
    if (!datos.empresa) throw new ErrorCuadro("La empresa es obligatoria.");
    if (!datos.fecha) throw new ErrorCuadro("La fecha es obligatoria.");
    const [ve] = await pool.query<RowDataPacket[]>("SELECT id FROM vehiculos WHERE placa = ?", [datos.placa]);
    const columnas: string[] = ["vehiculoId", "creadoPorId"];
    const valores: unknown[] = [ve[0]?.id ?? null, usuarioId];
    if (!("flujoCorame" in datos)) datos.flujoCorame = CLIENTE_FLUJO_LARGO.test(String(datos.empresa));
    for (const [campo, tipo] of Object.entries(CAMPOS_EDITABLES)) {
      if (!(campo in datos)) continue;
      columnas.push(campo);
      valores.push(valorCampo(campo, tipo, datos[campo]));
    }
    const [res] = await pool.query<ResultSetHeader>(
      `INSERT INTO cuadro_viajes (${columnas.join(", ")}) VALUES (${columnas.map(() => "?").join(", ")})`,
      valores
    );
    return res.insertId;
  },

  /**
   * Guarda solo los campos que vienen en 'datos' (validados).
   *
   * Ademas: al pasar los papeles a RADICADO sin fecha, se pone la de hoy en
   * Colombia; al devolverlos a otro estado, se borra. Si cambia la placa, se
   * vuelve a enlazar el vehiculo del catalogo.
   */
  async actualizar(id: number, datos: Record<string, unknown>): Promise<boolean> {
    validar(datos);
    const sets: string[] = [];
    const valores: unknown[] = [];
    for (const [campo, tipo] of Object.entries(CAMPOS_EDITABLES)) {
      if (!(campo in datos)) continue;
      sets.push(`${campo} = ?`);
      valores.push(valorCampo(campo, tipo, datos[campo]));
    }
    // Radicado sin fecha: hoy. Volver atras borra la fecha.
    if (datos.estadoPapeles === "RADICADO" && !("fechaRadicado" in datos)) {
      sets.push("fechaRadicado = COALESCE(fechaRadicado, ?)");
      valores.push(hoyColombia());
    } else if ("estadoPapeles" in datos && datos.estadoPapeles !== "RADICADO") {
      sets.push("fechaRadicado = NULL");
    }
    if ("placa" in datos) {
      sets.push("vehiculoId = (SELECT id FROM vehiculos WHERE placa = ?)");
      valores.push(datos.placa);
    }
    if (sets.length === 0) return false;
    const [res] = await pool.query<ResultSetHeader>(`UPDATE cuadro_viajes SET ${sets.join(", ")} WHERE id = ?`, [
      ...valores,
      id,
    ]);
    return res.affectedRows > 0;
  },

  /** Solo los viajes creados a mano (sin manifiesto) se pueden borrar. */
  async borrar(id: number): Promise<boolean> {
    const [res] = await pool.query<ResultSetHeader>("DELETE FROM cuadro_viajes WHERE id = ? AND viajeId IS NULL", [id]);
    return res.affectedRows > 0;
  },

  /** Revisado por contabilidad o por la gerente (o se quita la marca). */
  async revisar(id: number, quien: "CONTABILIDAD" | "GERENCIA", usuarioId: number | null, revisado: boolean) {
    const col = quien === "CONTABILIDAD" ? "revisadoContabilidad" : "revisadoGerencia";
    await pool.query(`UPDATE cuadro_viajes SET ${col}PorId = ?, ${col}En = ? WHERE id = ?`, [
      revisado ? usuarioId : null,
      revisado ? new Date() : null,
      id,
    ]);
  },

  /** Una factura que cubre varios viajes (los urbanos se facturan juntos). */
  async facturar(ids: number[], datos: { facturaNumero?: string | null; facturaFecha?: string | null }) {
    if (ids.length === 0) throw new ErrorCuadro("Selecciona al menos un viaje.");
    const numero = valorCampo("facturaNumero", "texto", datos.facturaNumero);
    const fecha = valorCampo("facturaFecha", "fecha", datos.facturaFecha);
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE cuadro_viajes SET facturado = 1,
              facturaNumero = COALESCE(?, facturaNumero), facturaFecha = COALESCE(?, facturaFecha)
        WHERE id IN (?)`,
      [numero, fecha, ids]
    );
    return res.affectedRows;
  },

  /** Agrega una nota (maximo 1000 caracteres) con su autor. Una nota vacia es un error. */
  async agregarNota(id: number, texto: string, usuarioId: number | null) {
    const limpio = texto.trim();
    if (!limpio) throw new ErrorCuadro("La nota esta vacia.");
    await pool.query("INSERT INTO cuadro_notas (cuadroViajeId, texto, usuarioId) VALUES (?, ?, ?)", [
      id,
      limpio.slice(0, 1000),
      usuarioId,
    ]);
  },

  /** Borra una nota de ese viaje. */
  async borrarNota(id: number, notaId: number) {
    await pool.query("DELETE FROM cuadro_notas WHERE id = ? AND cuadroViajeId = ?", [notaId, id]);
  },

  /**
   * Registra un anticipo entregado por una bomba aliada: bomba, valor, fecha,
   * fecha de pago a la bomba (opcional) y nota. Bomba, valor y fecha son
   * obligatorios.
   */
  async agregarAnticipo(id: number, d: Record<string, unknown>, usuarioId: number | null) {
    const valor = valorCampo("valor", "numero", d.valor);
    const fecha = valorCampo("fecha", "fecha", d.fecha);
    if (!d.bombaId) throw new ErrorCuadro("Elige la bomba que entrego el anticipo.");
    if (!valor) throw new ErrorCuadro("Escribe el valor del anticipo.");
    if (!fecha) throw new ErrorCuadro("Escribe la fecha del anticipo.");
    await pool.query(
      `INSERT INTO cuadro_anticipos (cuadroViajeId, bombaId, valor, fecha, fechaPago, nota, creadoPorId)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, Number(d.bombaId), valor, fecha, valorCampo("fechaPago", "fecha", d.fechaPago), valorCampo("nota", "texto", d.nota), usuarioId]
    );
  },

  /** Solo la fecha de pago a la bomba y la nota se editan; lo demas se borra y se vuelve a crear. */
  async actualizarAnticipo(id: number, anticipoId: number, d: Record<string, unknown>) {
    const sets: string[] = [];
    const valores: unknown[] = [];
    if ("fechaPago" in d) {
      sets.push("fechaPago = ?");
      valores.push(valorCampo("fechaPago", "fecha", d.fechaPago));
    }
    if ("nota" in d) {
      sets.push("nota = ?");
      valores.push(valorCampo("nota", "texto", d.nota));
    }
    if (sets.length === 0) return;
    await pool.query(`UPDATE cuadro_anticipos SET ${sets.join(", ")} WHERE id = ? AND cuadroViajeId = ?`, [
      ...valores,
      anticipoId,
      id,
    ]);
  },

  /** Quita un anticipo de ese viaje. */
  async borrarAnticipo(id: number, anticipoId: number) {
    await pool.query("DELETE FROM cuadro_anticipos WHERE id = ? AND cuadroViajeId = ?", [anticipoId, id]);
  },
};

/** Catalogo de bombas aliadas que entregan anticipos a los conductores. */
export const bombas = {
  /** Todas las bombas, las activas primero. */
  async listar() {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM bombas ORDER BY activa DESC, nombre, ciudad");
    return rows.map((b) => ({ ...b, activa: !!b.activa }));
  },
  /** Crea una bomba (nombre y ciudad en mayuscula). Nombre + ciudad no se repiten. */
  async crear(d: Record<string, unknown>) {
    const nombre = String(d.nombre ?? "").trim().toUpperCase();
    if (!nombre) throw new ErrorCuadro("Escribe el nombre de la bomba.");
    const ciudad = String(d.ciudad ?? "").trim().toUpperCase() || null;
    try {
      const [res] = await pool.query<ResultSetHeader>("INSERT INTO bombas (nombre, ciudad) VALUES (?, ?)", [nombre, ciudad]);
      return res.insertId;
    } catch (exc: any) {
      if (exc?.code === "ER_DUP_ENTRY") throw new ErrorCuadro("Ya existe una bomba con ese nombre en esa ciudad.");
      throw exc;
    }
  },
  /**
   * Cambia nombre, ciudad y/o si esta activa. Una bomba inactiva ya no se
   * ofrece al registrar anticipos, pero sus anticipos viejos se conservan.
   */
  async actualizar(id: number, d: Record<string, unknown>) {
    const sets: string[] = [];
    const valores: unknown[] = [];
    if ("nombre" in d) {
      sets.push("nombre = ?");
      valores.push(String(d.nombre ?? "").trim().toUpperCase());
    }
    if ("ciudad" in d) {
      sets.push("ciudad = ?");
      valores.push(String(d.ciudad ?? "").trim().toUpperCase() || null);
    }
    if ("activa" in d) {
      sets.push("activa = ?");
      valores.push(d.activa ? 1 : 0);
    }
    if (sets.length) await pool.query(`UPDATE bombas SET ${sets.join(", ")} WHERE id = ?`, [...valores, id]);
  },
};
