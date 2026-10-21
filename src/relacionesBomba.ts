/**
 * Cruce con la bomba: la relacion quincenal de vales que manda la bomba
 * (COESCO: "RELACION VALES DESPACHO - CONSUMO", una por factura, p. ej.
 * AE5044797) contra los anticipos de combustible del TMS.
 *
 * Cada vale trae EDS, numero de vale, fecha, placa, galones y valor. El
 * navegador lee el PDF o el Excel de la relacion (o se arma a mano eligiendo
 * los tanqueos) y manda los vales; aqui se propone a que tramo corresponde
 * cada uno (emparejarVales) y, al confirmar, se guarda la relacion:
 * - el tramo queda cruzado con su vale: el combustible pasa a ser el valor
 *   del vale (lo que cobra la bomba) y se guarda lo que se habia registrado
 *   antes, para ver la diferencia; los galones son los del vale;
 * - el tanqueo queda con el numero y la fecha de la factura de la bomba.
 * Borrar la relacion devuelve los tramos como estaban.
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "./db";
import { dia, ErrorCuadro } from "./cuadro";
import { placaNormal } from "./anticipos";

/** Un vale de la relacion de la bomba. */
export interface ValeBomba {
  /** Estacion como la escribe la bomba ("EDS CHUSACA", "EDS SAN ESTEBAN"). */
  eds: string;
  /** Numero del vale ("V56300011898"); null si la relacion se armo a mano. */
  vale: string | null;
  fecha: string;
  hora: string | null;
  placa: string;
  galones: number | null;
  valor: number;
}

/** Tramo con combustible que puede cruzarse con un vale. */
export interface TramoCruzable {
  id: number;
  placa: string;
  fecha: string;
  bomba: string | null;
  combustible: number;
  /** Ya cruzado con un vale de otra relacion. */
  cruzado: boolean;
}

/**
 * Como quedo un vale frente a los tramos:
 * - COINCIDE: misma placa, misma estacion, fecha cercana y el mismo valor
 *   (a lo sumo 1.000 de diferencia, por redondeos).
 * - DIFERENCIA: el tramo es ese (placa, estacion y fecha) pero el valor no
 *   coincide: hay que revisar.
 * - SIN_TANQUEO: no hay ningun tramo de esa placa en esa estacion por esas
 *   fechas (la bomba cobra algo que no esta registrado).
 */
export type EstadoVale = "COINCIDE" | "DIFERENCIA" | "SIN_TANQUEO";

export interface ValePropuesto extends ValeBomba {
  tramoId: number | null;
  estado: EstadoVale;
  /** Combustible registrado en el tramo propuesto. */
  combustibleTramo: number | null;
}

/** Diferencia de valor que se acepta como la misma (redondeos de la bomba). */
export const TOLERANCIA_VALE = 1000;
/** Dias de diferencia entre el vale y el anticipo que se aceptan. */
const DIAS_VALE = 2;

/**
 * Estacion comparable: sin "EDS", "S." como "SAN", sin tildes ni signos.
 * "EDS SAN ESTEBAN" y "S. ESTEBAN" -> "SAN ESTEBAN".
 */
export function estacionNormal(nombre: string | null | undefined): string {
  return String(nombre ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\bEDS\b/g, " ")
    .replace(/\bS\.\s*/g, "SAN ")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Dias entre dos fechas "AAAA-MM-DD" (sin signo). */
const diasEntre = (a: string, b: string) => Math.abs(Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000));

/**
 * Propone el tramo de cada vale. Candidatos: misma placa, misma estacion (si
 * el tramo tiene bomba), a lo sumo 2 dias de diferencia, con combustible y
 * sin cruzar. Se reparten primero los que coinciden en valor (los mas
 * cercanos en fecha), y luego los demas al tramo libre mas cercano. Un tramo
 * va con un solo vale.
 */
export function emparejarVales(vales: ValeBomba[], tramos: TramoCruzable[]): ValePropuesto[] {
  const usados = new Set<number>();
  const elegido = new Map<number, TramoCruzable>();
  const candidatos = vales.map((v) =>
    tramos
      .filter(
        (t) =>
          !t.cruzado &&
          t.combustible > 0 &&
          placaNormal(t.placa) === placaNormal(v.placa) &&
          (!t.bomba || estacionNormal(t.bomba) === estacionNormal(v.eds)) &&
          diasEntre(t.fecha, v.fecha) <= DIAS_VALE
      )
      .sort((a, b) => diasEntre(a.fecha, v.fecha) - diasEntre(b.fecha, v.fecha) || a.id - b.id)
  );
  // 1. Mismo valor.
  vales.forEach((v, i) => {
    const t = candidatos[i].find((c) => !usados.has(c.id) && Math.abs(c.combustible - v.valor) <= TOLERANCIA_VALE);
    if (t) {
      elegido.set(i, t);
      usados.add(t.id);
    }
  });
  // 2. Lo que quede: el tramo libre mas cercano.
  vales.forEach((_, i) => {
    if (elegido.has(i)) return;
    const t = candidatos[i].find((c) => !usados.has(c.id));
    if (t) {
      elegido.set(i, t);
      usados.add(t.id);
    }
  });
  return vales.map((v, i) => {
    const t = elegido.get(i) ?? null;
    return {
      ...v,
      tramoId: t?.id ?? null,
      combustibleTramo: t?.combustible ?? null,
      estado: !t ? "SIN_TANQUEO" : Math.abs(t.combustible - v.valor) <= TOLERANCIA_VALE ? "COINCIDE" : "DIFERENCIA",
    };
  });
}

/** Una relacion (factura) de la bomba ya cruzada. */
export interface RelacionBomba {
  id: number;
  numero: string;
  fecha: string;
  /** Cuando vence la factura de la bomba (hay que pagarla antes). */
  fechaVencimiento: string | null;
  total: number;
  fechaPago: string | null;
  nota: string | null;
  vales: Array<ValeBomba & { id: number; tramoId: number | null }>;
}

/** Valida los vales que manda el navegador. */
function leerVales(lista: unknown): Array<ValeBomba & { tramoId: number | null }> {
  if (!Array.isArray(lista) || lista.length === 0) throw new ErrorCuadro("La relacion no trae vales.");
  return lista.map((v, i) => {
    const fecha = String(v?.fecha ?? "").slice(0, 10);
    const valor = Number(v?.valor);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new ErrorCuadro(`Vale ${i + 1}: la fecha no es valida.`);
    if (!Number.isFinite(valor) || valor <= 0) throw new ErrorCuadro(`Vale ${i + 1}: falta el valor.`);
    const placa = placaNormal(v?.placa);
    if (!placa) throw new ErrorCuadro(`Vale ${i + 1}: falta la placa.`);
    const galones = v?.galones === null || v?.galones === undefined || v?.galones === "" ? null : Number(v.galones);
    return {
      eds: String(v?.eds ?? "").trim().slice(0, 80),
      vale: String(v?.vale ?? "").trim().slice(0, 40) || null,
      fecha,
      hora: String(v?.hora ?? "").trim().slice(0, 8) || null,
      placa,
      galones: galones !== null && Number.isFinite(galones) ? galones : null,
      valor: Math.round(valor),
      tramoId: v?.tramoId ? Number(v.tramoId) : null,
    };
  });
}

/** Tramos con combustible que aun pueden cruzarse (y los ya cruzados, marcados). */
async function tramosCruzables(): Promise<TramoCruzable[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT a.id, COALESCE(a.placa, c.placa) AS placa, a.fecha, b.nombre AS bomba, a.combustible,
            EXISTS (SELECT 1 FROM bomba_relacion_vales rv WHERE rv.cuadroAnticipoId = a.id) AS cruzado
       FROM cuadro_anticipos a
       LEFT JOIN cuadro_viajes c ON c.id = a.cuadroViajeId
       LEFT JOIN bombas b ON b.id = a.bombaId
      WHERE a.combustible > 0`
  );
  return rows.map((r) => ({
    id: r.id,
    placa: r.placa ?? "",
    fecha: dia(r.fecha)!,
    bomba: r.bomba ?? null,
    combustible: Number(r.combustible),
    cruzado: !!r.cruzado,
  }));
}

/** Relaciones de la bomba: proponer, guardar, listar, pagar y borrar. */
export const relacionesBomba = {
  /** Propone el tramo de cada vale (no guarda). Avisa si la factura ya se cargo. */
  async proponer(d: Record<string, unknown>): Promise<{ vales: ValePropuesto[]; yaExiste: boolean }> {
    const vales = leerVales(d.vales);
    const numero = String(d.numero ?? "").trim();
    const [hay] = await pool.query<RowDataPacket[]>("SELECT id FROM bomba_relaciones WHERE numero = ?", [numero]);
    return { vales: emparejarVales(vales, await tramosCruzables()), yaExiste: !!hay[0] };
  },

  /**
   * Guarda la relacion con sus vales y cruza los tramos elegidos ({ numero,
   * fecha, nota, vales: [{ ...vale, tramoId }] }). En una transaccion.
   */
  async guardar(d: Record<string, unknown>, usuarioId: number | null): Promise<number> {
    const numero = String(d.numero ?? "").trim().toUpperCase().slice(0, 40);
    const fecha = String(d.fecha ?? "").slice(0, 10);
    if (!numero) throw new ErrorCuadro("Escribe el numero de la factura de la bomba.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new ErrorCuadro("Escribe la fecha de la factura de la bomba.");
    const vence = d.fechaVencimiento ? String(d.fechaVencimiento).slice(0, 10) : null;
    if (vence && !/^\d{4}-\d{2}-\d{2}$/.test(vence)) throw new ErrorCuadro("La fecha de vencimiento no es valida.");
    const vales = leerVales(d.vales);
    const ids = vales.map((v) => v.tramoId).filter((x): x is number => !!x);
    if (new Set(ids).size !== ids.length) throw new ErrorCuadro("Un tanqueo quedo con dos vales: revisa la relacion.");
    const total = vales.reduce((s, v) => s + v.valor, 0);
    const conexion = await pool.getConnection();
    try {
      await conexion.beginTransaction();
      const [hay] = await conexion.query<RowDataPacket[]>("SELECT id FROM bomba_relaciones WHERE numero = ?", [numero]);
      if (hay[0]) throw new ErrorCuadro(`La factura ${numero} ya se cruzo. Borrala primero si quieres cargarla de nuevo.`);
      if (ids.length) {
        const [ocupados] = await conexion.query<RowDataPacket[]>(
          "SELECT cuadroAnticipoId FROM bomba_relacion_vales WHERE cuadroAnticipoId IN (?)",
          [ids]
        );
        if (ocupados[0]) throw new ErrorCuadro("Algun tanqueo ya esta cruzado con otra factura de la bomba.");
      }
      const [r] = await conexion.query<ResultSetHeader>(
        "INSERT INTO bomba_relaciones (numero, fecha, fechaVencimiento, total, nota, creadoPorId) VALUES (?, ?, ?, ?, ?, ?)",
        [numero, fecha, vence, total, String(d.nota ?? "").trim().slice(0, 200) || null, usuarioId]
      );
      for (const v of vales) {
        await conexion.query(
          `INSERT INTO bomba_relacion_vales (relacionId, eds, vale, fecha, hora, placa, galones, valor, cuadroAnticipoId)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.insertId, v.eds, v.vale, v.fecha, v.hora, v.placa, v.galones, v.valor, v.tramoId]
        );
        if (!v.tramoId) continue;
        // El combustible pasa a ser lo que cobra la bomba; se guarda lo de antes.
        await conexion.query(
          `UPDATE cuadro_anticipos
              SET combustibleEntregado = COALESCE(combustibleEntregado, combustible),
                  combustible = ?, valor = COALESCE(efectivo, 0) + ?, galones = COALESCE(?, galones)
            WHERE id = ?`,
          [v.valor, v.valor, v.galones, v.tramoId]
        );
        await conexion.query(
          `UPDATE anticipos_tanqueo t JOIN cuadro_anticipos a ON a.tanqueoId = t.id
              SET t.facturaBomba = ?, t.fechaFacturaBomba = ?
            WHERE a.id = ?`,
          [numero, fecha, v.tramoId]
        );
      }
      await conexion.commit();
      return r.insertId;
    } catch (exc) {
      await conexion.rollback();
      throw exc;
    } finally {
      conexion.release();
    }
  },

  /** Relaciones cruzadas, la mas reciente primero, con sus vales. */
  async listar(): Promise<RelacionBomba[]> {
    const [relaciones] = await pool.query<RowDataPacket[]>("SELECT * FROM bomba_relaciones ORDER BY fecha DESC, id DESC");
    const [vales] = await pool.query<RowDataPacket[]>("SELECT * FROM bomba_relacion_vales ORDER BY fecha, hora, id");
    return relaciones.map((r) => ({
      id: r.id,
      numero: r.numero,
      fecha: dia(r.fecha)!,
      fechaVencimiento: dia(r.fechaVencimiento),
      total: Number(r.total),
      fechaPago: dia(r.fechaPago),
      nota: r.nota ?? null,
      vales: vales
        .filter((v) => v.relacionId === r.id)
        .map((v) => ({
          id: v.id,
          eds: v.eds,
          vale: v.vale ?? null,
          fecha: dia(v.fecha)!,
          hora: v.hora ?? null,
          placa: v.placa,
          galones: v.galones === null ? null : Number(v.galones),
          valor: Number(v.valor),
          tramoId: v.cuadroAnticipoId ?? null,
        })),
    }));
  },

  /** Cambia la fecha de vencimiento de una factura de la bomba (vacia la quita). */
  async vencimiento(id: number, d: Record<string, unknown>): Promise<void> {
    const fecha = d.fechaVencimiento ? String(d.fechaVencimiento).slice(0, 10) : null;
    if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new ErrorCuadro("La fecha de vencimiento no es valida.");
    await pool.query("UPDATE bomba_relaciones SET fechaVencimiento = ? WHERE id = ?", [fecha, id]);
  },

  /** Se le pago a la bomba la factura: fecha de pago en la relacion y en sus tramos. */
  async pagar(id: number, d: Record<string, unknown>): Promise<void> {
    const fecha = d.fechaPago ? String(d.fechaPago).slice(0, 10) : null;
    if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new ErrorCuadro("La fecha de pago no es valida.");
    await pool.query("UPDATE bomba_relaciones SET fechaPago = ? WHERE id = ?", [fecha, id]);
    await pool.query(
      `UPDATE cuadro_anticipos a JOIN bomba_relacion_vales v ON v.cuadroAnticipoId = a.id
          SET a.fechaPago = ? WHERE v.relacionId = ?`,
      [fecha, id]
    );
  },

  /**
   * Borra una relacion: los tramos vuelven al combustible que tenian antes del
   * cruce y los tanqueos quedan sin el numero de esa factura.
   */
  async borrar(id: number): Promise<void> {
    const [r] = await pool.query<RowDataPacket[]>("SELECT numero FROM bomba_relaciones WHERE id = ?", [id]);
    if (!r[0]) return;
    await pool.query(
      `UPDATE cuadro_anticipos a JOIN bomba_relacion_vales v ON v.cuadroAnticipoId = a.id
          SET a.combustible = COALESCE(a.combustibleEntregado, a.combustible),
              a.valor = COALESCE(a.efectivo, 0) + COALESCE(a.combustibleEntregado, a.combustible),
              a.combustibleEntregado = NULL
        WHERE v.relacionId = ?`,
      [id]
    );
    await pool.query("UPDATE anticipos_tanqueo SET facturaBomba = NULL, fechaFacturaBomba = NULL WHERE facturaBomba = ?", [r[0].numero]);
    await pool.query("DELETE FROM bomba_relaciones WHERE id = ?", [id]);
  },
};
