/**
 * Inspeccion preoperacional de vehiculos (Resolucion 40595, Plan Estrategico
 * de Seguridad Vial): reemplaza el Google Forms "Inspeccion Preoperacional de
 * Vehiculos" y la hoja de respuestas. Se llena con cada viaje despachado (la
 * ventana sale al expedir el manifiesto) y queda el historico.
 *
 * Las respuestas se guardan como JSON por clave (las preguntas y su orden
 * viven en el frontend, ver preguntasPreoperacional.ts); aparte van la fecha,
 * la placa, el conductor, el viaje y si aprobo, para filtrar.
 *
 * Respuestas sugeridas (todo en "Si" / "Cumple", como los enlaces
 * precargados): la ultima inspeccion de la placa con ese conductor; si no hay,
 * la base importada de la Matriz Control Integral (un juego por placa y
 * conductor, y EPS / ARL / pension por cedula); encima, lo del viaje (placa,
 * conductor, origen) y los vencimientos de SOAT y tecnomecanica del catalogo.
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "./db";
import { dia, ErrorCuadro, hoyColombia } from "./cuadro";

/** Respuestas de una inspeccion: clave de la pregunta -> valor en texto. */
export type Respuestas = Record<string, string>;

/** Una inspeccion guardada. */
export interface Preoperacional {
  id: number;
  viajeId: number | null;
  manifiesto: string | null;
  fecha: string;
  placa: string;
  conductor: string;
  aprobo: boolean;
  respuestas: Respuestas;
  creadoPor: string | null;
  creadoEn: string;
}

/** Un viaje con manifiesto que aun no tiene inspeccion. */
export interface PreoperacionalPendiente {
  viajeId: number;
  manifiesto: string | null;
  fecha: string;
  placa: string | null;
  conductor: string | null;
}

/** Texto sin tildes ni signos, en mayuscula, para comparar nombres. */
const normal = (s: string | null | undefined) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Placa sin guion ni espacios ("JTY-219" -> "JTY219"). */
export const placaComparable = (p: string | null | undefined) => normal(p).replace(/ /g, "");

/**
 * El mismo conductor aunque el nombre venga distinto ("MAURICIO LOPEZ CUENCA"
 * y "CELSO MAURICIO LÓPEZ CUENCA"): todas las palabras del nombre corto estan
 * en el largo (y al menos dos).
 */
export function mismoConductor(a: string | null | undefined, b: string | null | undefined): boolean {
  const pa = normal(a).split(" ").filter((x) => x.length > 1);
  const pb = normal(b).split(" ").filter((x) => x.length > 1);
  if (!pa.length || !pb.length) return false;
  const [corto, largo] = pa.length <= pb.length ? [pa, new Set(pb)] : [pb, new Set(pa)];
  return corto.length >= Math.min(2, largo.size) && corto.every((p) => largo.has(p));
}

/** Respuestas sin las que son de cada inspeccion (fecha, kilometraje, novedades). */
function sinLoDelDia(r: Respuestas): Respuestas {
  const copia = { ...r };
  for (const k of Object.keys(copia)) if (k === "fechaInspeccion" || k === "kilometraje" || k === "otrasNovedades" || k.endsWith("Novedad")) delete copia[k];
  return copia;
}

/** Lee un JSON de respuestas (lo que no sea texto se ignora). */
function leerRespuestas(x: unknown): Respuestas {
  let crudo: unknown = x;
  if (typeof x === "string") {
    try {
      crudo = JSON.parse(x);
    } catch {
      return {};
    }
  }
  if (!crudo || typeof crudo !== "object") return {};
  const r: Respuestas = {};
  for (const [k, v] of Object.entries(crudo as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9]{1,40}$/.test(k) || v === null || v === undefined) continue;
    r[k] = String(v).slice(0, 500);
  }
  return r;
}

/** Fila de la tabla -> inspeccion. */
const mapear = (r: RowDataPacket): Preoperacional => ({
  id: Number(r.id),
  viajeId: r.viajeId ?? null,
  manifiesto: r.manifiesto ?? null,
  fecha: dia(r.fecha)!,
  placa: String(r.placa),
  conductor: String(r.conductor ?? ""),
  aprobo: !!r.aprobo,
  respuestas: leerRespuestas(r.respuestas),
  creadoPor: r.creadoPor ?? null,
  creadoEn: new Date(r.creadoEn).toISOString(),
});

const SELECT = `
  SELECT p.*, v.consecutivoManifiesto AS manifiesto, u.nombre AS creadoPor
    FROM preoperacionales p
    LEFT JOIN viajes v ON v.id = p.viajeId
    LEFT JOIN usuarios u ON u.id = p.creadoPorId`;

/** Repositorio de las inspecciones preoperacionales. */
export const preoperacional = {
  /** Todas las inspecciones, las mas recientes primero. */
  async listar(): Promise<Preoperacional[]> {
    const [rows] = await pool.query<RowDataPacket[]>(`${SELECT} ORDER BY p.fecha DESC, p.id DESC`);
    return rows.map(mapear);
  },

  /** Viajes con manifiesto de los ultimos dias (no anulados) que aun no tienen inspeccion. */
  async pendientes(dias = 30): Promise<PreoperacionalPendiente[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT v.id, v.consecutivoManifiesto, v.fechaCreacion, COALESCE(ve.placa, v.placaRndc) AS placa,
              COALESCE(c.nombre, v.conductorRndc) AS conductor
         FROM viajes v
         LEFT JOIN vehiculos ve ON ve.id = v.vehiculoId
         LEFT JOIN conductores c ON c.id = v.conductorId
        WHERE v.numeroManifiestoRndc IS NOT NULL AND v.estado <> 'ANULADO'
          AND v.fechaCreacion >= DATE_SUB(NOW(), INTERVAL ? DAY)
          AND NOT EXISTS (SELECT 1 FROM preoperacionales p WHERE p.viajeId = v.id)
        ORDER BY v.fechaCreacion DESC`,
      [dias]
    );
    return rows.map((r) => ({
      viajeId: Number(r.id),
      manifiesto: r.consecutivoManifiesto ?? null,
      fecha: new Date(r.fechaCreacion).toISOString(),
      placa: r.placa ?? null,
      conductor: r.conductor ?? null,
    }));
  },

  /**
   * Respuestas sugeridas para un viaje ({ viajeId }) o una placa y conductor
   * ({ placa, conductor }). Ver el comentario del archivo.
   */
  async sugerido(d: { viajeId?: number | null; placa?: string | null; conductor?: string | null }): Promise<Respuestas> {
    let placa = d.placa ?? null;
    let conductor = d.conductor ?? null;
    let cedula: string | null = null;
    let origen: string | null = null;
    let origenCodigo: string | null = null;
    let vencSoat: string | null = null;
    let vencTecno: string | null = null;
    if (d.viajeId) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT COALESCE(ve.placa, v.placaRndc) AS placa, c.nombre AS conductor, COALESCE(c.cedula, v.conductorRndc) AS cedula,
                ve.fechaVencSoat, ve.fechaVencTecnomecanica,
                -- Origen: el de la plantilla o, en los viajes sin plantilla, el que reporta el RNDC.
                LPAD(COALESCE((SELECT COALESCE(p.municipioOrigen, t.codMunicipioRndc)
                                 FROM viaje_remesas vr
                                 LEFT JOIN plantillas_viaje p ON p.id = vr.plantillaId
                                 LEFT JOIN terceros t ON t.id = p.remitenteId
                                WHERE vr.viajeId = v.id ORDER BY vr.orden LIMIT 1), v.origenRndc), 8, '0') AS origenCodigo
           FROM viajes v
           LEFT JOIN vehiculos ve ON ve.id = v.vehiculoId
           LEFT JOIN conductores c ON c.id = v.conductorId
          WHERE v.id = ?`,
        [d.viajeId]
      );
      const v = rows[0];
      if (!v) throw new ErrorCuadro("Ese viaje no existe.");
      placa = v.placa ?? placa;
      conductor = v.conductor ?? conductor;
      cedula = v.cedula ?? null;
      origenCodigo = v.origenCodigo ?? null;
      if (origenCodigo) {
        const [m] = await pool.query<RowDataPacket[]>("SELECT nombre FROM municipios WHERE codigo = ?", [origenCodigo]);
        origen = m[0]?.nombre ?? null;
      }
      vencSoat = dia(v.fechaVencSoat) ?? null;
      vencTecno = dia(v.fechaVencTecnomecanica) ?? null;
    } else if (placa) {
      const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT fechaVencSoat, fechaVencTecnomecanica FROM vehiculos WHERE REPLACE(placa, '-', '') = ? LIMIT 1",
        [placaComparable(placa)]
      );
      vencSoat = dia(rows[0]?.fechaVencSoat) ?? null;
      vencTecno = dia(rows[0]?.fechaVencTecnomecanica) ?? null;
    }
    const clavePlaca = placaComparable(placa);

    // 1. La ultima inspeccion de la placa (mejor si es del mismo conductor).
    const [ultimas] = await pool.query<RowDataPacket[]>(
      "SELECT conductor, respuestas FROM preoperacionales WHERE REPLACE(placa, '-', '') = ? ORDER BY fecha DESC, id DESC LIMIT 20",
      [clavePlaca]
    );
    const ultima = ultimas.find((u) => mismoConductor(u.conductor, conductor)) ?? null;
    // 2. La base importada de la matriz (placa y conductor; si no, solo la placa).
    const [bases] = await pool.query<RowDataPacket[]>("SELECT conductor, respuestas FROM preoperacional_base WHERE placa = ?", [clavePlaca]);
    const base = bases.find((b) => mismoConductor(b.conductor, conductor)) ?? bases[0] ?? null;
    const previa = ultima ?? ultimas[0] ?? null;

    const r: Respuestas = {
      ...(base ? sinLoDelDia(leerRespuestas(base.respuestas)) : {}),
      ...(previa ? sinLoDelDia(leerRespuestas(previa.respuestas)) : {}),
    };
    // EPS, ARL y pension del conductor del viaje, por su cedula.
    if (cedula) {
      const [c] = await pool.query<RowDataPacket[]>("SELECT eps, arl, pension FROM preoperacional_conductores WHERE cedula = ?", [cedula]);
      if (c[0]) {
        if (c[0].eps) r.eps = c[0].eps;
        if (c[0].arl) r.arl = c[0].arl;
        if (c[0].pension) r.pension = c[0].pension;
      }
    }
    if (placa) r.placa = placa;
    if (conductor) {
      // Si la base era de otro conductor, quien inspecciona pasa a ser el del viaje.
      if (!r.responsable || mismoConductor(r.responsable, r.conductor)) r.responsable = conductor;
      r.conductor = conductor;
    }
    if (origen) r.ciudadOrigenViaje = origen;
    if (origenCodigo) r.ciudadOrigenCodigo = origenCodigo;
    // SOAT y tecnomecanica: el vencimiento mas reciente entre el catalogo y lo anterior.
    if (vencSoat && (!r.vencSoat || vencSoat > r.vencSoat)) r.vencSoat = vencSoat;
    if (vencTecno && (!r.vencTecno || vencTecno > r.vencTecno)) r.vencTecno = vencTecno;
    r.fechaInspeccion = hoyColombia();
    return r;
  },

  /**
   * Guarda una inspeccion ({ viajeId?, respuestas }). Si el viaje ya tiene
   * una, la reemplaza. Necesita placa, conductor y fecha de inspeccion.
   */
  async guardar(d: Record<string, unknown>, usuarioId: number | null, id?: number): Promise<Preoperacional> {
    const respuestas = leerRespuestas(d.respuestas);
    const fecha = String(respuestas.fechaInspeccion ?? "").slice(0, 10);
    const placa = String(respuestas.placa ?? "").trim().toUpperCase();
    const conductor = String(respuestas.conductor ?? "").trim().toUpperCase();
    if (!placa) throw new ErrorCuadro("Falta la placa del vehiculo.");
    if (!conductor) throw new ErrorCuadro("Falta el nombre del conductor.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new ErrorCuadro("Falta la fecha de la inspeccion.");
    const viajeId = d.viajeId ? Number(d.viajeId) : null;
    const aprobo = /^s/i.test(respuestas.aprobo ?? "");
    const valores = [viajeId, fecha, placa, conductor, aprobo, JSON.stringify(respuestas)];
    let nuevoId = id ?? null;
    if (nuevoId) {
      await pool.query("UPDATE preoperacionales SET viajeId = ?, fecha = ?, placa = ?, conductor = ?, aprobo = ?, respuestas = ? WHERE id = ?", [
        ...valores,
        nuevoId,
      ]);
    } else {
      if (viajeId) {
        const [ya] = await pool.query<RowDataPacket[]>("SELECT id FROM preoperacionales WHERE viajeId = ?", [viajeId]);
        nuevoId = ya[0] ? Number(ya[0].id) : null;
      }
      if (nuevoId) {
        await pool.query("UPDATE preoperacionales SET viajeId = ?, fecha = ?, placa = ?, conductor = ?, aprobo = ?, respuestas = ? WHERE id = ?", [
          ...valores,
          nuevoId,
        ]);
      } else {
        const [res] = await pool.query<ResultSetHeader>(
          "INSERT INTO preoperacionales (viajeId, fecha, placa, conductor, aprobo, respuestas, creadoPorId) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [...valores, usuarioId]
        );
        nuevoId = res.insertId;
      }
    }
    const [rows] = await pool.query<RowDataPacket[]>(`${SELECT} WHERE p.id = ?`, [nuevoId]);
    return mapear(rows[0]);
  },

  /** Borra una inspeccion. */
  async borrar(id: number): Promise<void> {
    await pool.query("DELETE FROM preoperacionales WHERE id = ?", [id]);
  },

  /**
   * Reemplaza la base de respuestas importada de la Matriz Control Integral
   * ({ vehiculos: [{ placa, conductor, respuestas }], conductores: [{ cedula,
   * nombre, eps, arl, pension }] }). En una transaccion.
   */
  async importarBase(d: Record<string, unknown>): Promise<{ vehiculos: number; conductores: number }> {
    const vehiculos = (Array.isArray(d.vehiculos) ? d.vehiculos : []) as Record<string, unknown>[];
    const conductores = (Array.isArray(d.conductores) ? d.conductores : []) as Record<string, unknown>[];
    const filasV = vehiculos
      .map((v) => ({ placa: placaComparable(String(v.placa ?? "")), conductor: String(v.conductor ?? "").trim().toUpperCase().slice(0, 150), respuestas: leerRespuestas(v.respuestas) }))
      .filter((v) => v.placa);
    const filasC = conductores
      .map((c) => ({
        cedula: String(c.cedula ?? "").replace(/\D/g, ""),
        nombre: String(c.nombre ?? "").trim().toUpperCase().slice(0, 150),
        eps: String(c.eps ?? "").trim().slice(0, 80) || null,
        arl: String(c.arl ?? "").trim().slice(0, 80) || null,
        pension: String(c.pension ?? "").trim().slice(0, 80) || null,
      }))
      .filter((c) => c.cedula);
    if (!filasV.length && !filasC.length) throw new ErrorCuadro("El archivo no trae vehiculos ni conductores.");
    const con = await pool.getConnection();
    try {
      await con.beginTransaction();
      if (filasV.length) {
        await con.query("DELETE FROM preoperacional_base");
        for (const v of filasV) {
          await con.query("INSERT INTO preoperacional_base (placa, conductor, respuestas) VALUES (?, ?, ?)", [v.placa, v.conductor, JSON.stringify(v.respuestas)]);
        }
      }
      if (filasC.length) {
        await con.query("DELETE FROM preoperacional_conductores");
        for (const c of filasC) {
          await con.query("REPLACE INTO preoperacional_conductores (cedula, nombre, eps, arl, pension) VALUES (?, ?, ?, ?, ?)", [c.cedula, c.nombre, c.eps, c.arl, c.pension]);
        }
      }
      await con.commit();
    } catch (exc) {
      await con.rollback();
      throw exc;
    } finally {
      con.release();
    }
    return { vehiculos: filasV.length, conductores: filasC.length };
  },
};
