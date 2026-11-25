/**
 * Envio a facturacion: el cuadro que se le manda a la contadora (que factura
 * en World Office) con los viajes listos para facturar, y la matriz de fletes
 * de la que salen los valores sugeridos.
 *
 * - La matriz se importa desde el Excel "MATRIZ FLETES" (el frontend lo lee y
 *   manda las filas); no vive en el repositorio porque son precios reales.
 * - Lo que la matriz sugiere (valor, peso minimo) se puede cambiar en cada
 *   viaje: hay valores negociados aparte. Al enviar, lo editado queda en el
 *   viaje del cuadro pagos (flete, peso facturado, nota, remision, factura).
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "./db";
import { cuadro, dia, ErrorCuadro, TARIFA_KILO_MAXIMA } from "./cuadro";
import type { FilaCuadro } from "./cuadro";
import { invalidarTarifas } from "./tarifasFlete";

export type TipoTarifa = "TON" | "FIJO" | "POR" | "POR3";
export const TIPOS_TARIFA: TipoTarifa[] = ["TON", "FIJO", "POR", "POR3"];

export interface TarifaFlete {
  id: number;
  /** Como la llaman en la matriz: cliente y ruta ("CORAME", "TOLUA BOGOTA"...). */
  nombre: string;
  /** Cliente que se factura. */
  razonSocial: string | null;
  /** TON: por tonelada. FIJO: por viaje. POR / POR3: por tonelada + 300.000 / 600.000 (2 o 3 clientes). */
  valor: number | null;
  tipo: TipoTarifa;
  /** Si va por menos de este peso, se factura este (34000, 32000 kg). */
  pesoMinimoKg: number | null;
  /** Peso que se factura siempre, sin importar el tiquete (33000 kg). */
  pesoFijoKg: number | null;
  observaciones: string | null;
  /** Sus viajes son urbanos aunque el nombre no diga URBANO (sin poliza RCE). */
  urbano: boolean;
}

/** Texto recortado; vacio -> null. */
const texto = (v: unknown, max: number): string | null => {
  const t = String(v ?? "").trim();
  return t ? t.slice(0, max) : null;
};
/** Numero positivo; vacio o invalido -> null. */
const numero = (v: unknown): number | null => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Valida y normaliza una tarifa recibida (de la importacion o de una edicion). */
export function normalizarTarifa(t: Record<string, unknown>): Omit<TarifaFlete, "id"> {
  const nombre = texto(t.nombre, 200);
  if (!nombre) throw new ErrorCuadro("Cada tarifa necesita un nombre.");
  const tipo = String(t.tipo ?? "TON")
    .trim()
    .toUpperCase();
  return {
    nombre,
    razonSocial: texto(t.razonSocial, 200),
    valor: numero(t.valor),
    tipo: (TIPOS_TARIFA as string[]).includes(tipo) ? (tipo as TipoTarifa) : "TON",
    pesoMinimoKg: numero(t.pesoMinimoKg) === null ? null : Math.round(numero(t.pesoMinimoKg)!),
    pesoFijoKg: numero(t.pesoFijoKg) === null ? null : Math.round(numero(t.pesoFijoKg)!),
    observaciones: texto(t.observaciones, 500),
    urbano: t.urbano === true || t.urbano === 1 || t.urbano === "1",
  };
}

/** Fila de tarifas_flete -> TarifaFlete. */
const mapearTarifa = (r: RowDataPacket): TarifaFlete => ({
  id: r.id,
  nombre: r.nombre,
  razonSocial: r.razonSocial ?? null,
  valor: r.valor === null ? null : Number(r.valor),
  tipo: r.tipo,
  pesoMinimoKg: r.pesoMinimoKg ?? null,
  pesoFijoKg: r.pesoFijoKg ?? null,
  observaciones: r.observaciones ?? null,
  urbano: !!r.urbano,
});

/** Un viaje listo para facturar, con lo que hace falta para el cuadro de la contadora. */
export type FilaPorFacturar = FilaCuadro & {
  /** Radicado de la remesa en el RNDC (puede no haber: viajes sin planillar). */
  radicadoRemesa: string | null;
};

/** Un viaje quitado del envio a facturacion (no se factura). */
export interface QuitadoEnvio {
  id: number;
  fecha: string;
  placa: string;
  empresa: string;
  manifiesto: string | null;
  remision: string | null;
  motivo: string | null;
  /** Cuando se quito (ISO) y quien. */
  en: string;
  por: string | null;
}

/** Matriz de fletes y envio a facturacion: lectura y escritura en la base. */
export const facturacion = {
  /** La matriz de fletes, por nombre (sin las retiradas). */
  async tarifas(): Promise<TarifaFlete[]> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM tarifas_flete WHERE retirada = 0 ORDER BY nombre, id");
    return rows.map(mapearTarifa);
  },

  /**
   * Deja la matriz igual a la importada (en una transaccion: si algo falla
   * queda la anterior), sin romper lo que cuelga de ella: cada tarifa se busca
   * por su nombre y se actualiza en su lugar (conserva su id, asi los viajes
   * siguen enlazados y la matriz de fletes conductor sigue colgando de ella);
   * las nuevas se agregan. Las que ya no vienen se borran si ningun viaje ni
   * la matriz de fletes conductor las usa; si las usan, quedan retiradas (no
   * salen en la matriz ni en la deduccion, pero el historial no se pierde).
   * Los viajes conservan su valor: cada uno guarda su copia del flete.
   */
  async reemplazarTarifas(lista: Record<string, unknown>[]): Promise<number> {
    if (!Array.isArray(lista) || lista.length === 0) throw new ErrorCuadro("La matriz importada no trae tarifas.");
    const tarifas = lista.map(normalizarTarifa);
    const conexion = await pool.getConnection();
    try {
      await conexion.beginTransaction();
      // El Excel no trae la marca de urbano: se conserva la de la tarifa del mismo nombre.
      const [urbanas] = await conexion.query<RowDataPacket[]>("SELECT nombre FROM tarifas_flete WHERE urbano = 1");
      const nombresUrbanos = new Set(urbanas.map((u) => String(u.nombre)));
      const [existentes] = await conexion.query<RowDataPacket[]>("SELECT id, nombre FROM tarifas_flete ORDER BY id");
      // Por nombre: si un nombre se repite (dos rutas del mismo cliente), la primera del Excel va con la primera de la base, y asi.
      const porNombre = new Map<string, number[]>();
      for (const e of existentes) porNombre.set(String(e.nombre), [...(porNombre.get(String(e.nombre)) ?? []), e.id as number]);
      const usadas = new Set<number>();
      for (const t of tarifas) {
        const valores = [t.nombre, t.razonSocial, t.valor, t.tipo, t.pesoMinimoKg, t.pesoFijoKg, t.observaciones, t.urbano || nombresUrbanos.has(t.nombre)];
        const id = porNombre.get(t.nombre)?.shift();
        if (id) {
          await conexion.query(
            "UPDATE tarifas_flete SET nombre = ?, razonSocial = ?, valor = ?, tipo = ?, pesoMinimoKg = ?, pesoFijoKg = ?, observaciones = ?, urbano = ?, retirada = 0 WHERE id = ?",
            [...valores, id],
          );
          usadas.add(id);
        } else {
          const [res] = await conexion.query<ResultSetHeader>(
            "INSERT INTO tarifas_flete (nombre, razonSocial, valor, tipo, pesoMinimoKg, pesoFijoKg, observaciones, urbano) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            valores,
          );
          usadas.add(res.insertId);
        }
      }
      // Las que ya no vienen: fuera si nadie las usa; retiradas si las usan viajes o la matriz de fletes conductor.
      const sobran = existentes.map((e) => e.id as number).filter((id) => !usadas.has(id));
      if (sobran.length) {
        const [enUso] = await conexion.query<RowDataPacket[]>(
          `SELECT DISTINCT tarifaFleteId AS id FROM cuadro_viajes WHERE tarifaFleteId IN (?)
           UNION SELECT DISTINCT tarifaFleteId FROM fletes_conductor WHERE tarifaFleteId IN (?)`,
          [sobran, sobran],
        );
        const usadasPorOtros = new Set(enUso.map((u) => u.id as number));
        const borrar = sobran.filter((id) => !usadasPorOtros.has(id));
        const retirar = sobran.filter((id) => usadasPorOtros.has(id));
        if (borrar.length) await conexion.query("DELETE FROM tarifas_flete WHERE id IN (?)", [borrar]);
        if (retirar.length) await conexion.query("UPDATE tarifas_flete SET retirada = 1 WHERE id IN (?)", [retirar]);
      }
      await conexion.commit();
    } catch (exc) {
      await conexion.rollback();
      throw exc;
    } finally {
      conexion.release();
      // La deduccion de fletes vuelve a leer la matriz.
      invalidarTarifas();
    }
    return tarifas.length;
  },

  /** Agrega una tarifa a la matriz sin importar el Excel, y la devuelve. */
  async crearTarifa(datos: Record<string, unknown>): Promise<TarifaFlete> {
    const t = normalizarTarifa(datos);
    const [res] = await pool.query<ResultSetHeader>(
      "INSERT INTO tarifas_flete (nombre, razonSocial, valor, tipo, pesoMinimoKg, pesoFijoKg, observaciones, urbano) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [t.nombre, t.razonSocial, t.valor, t.tipo, t.pesoMinimoKg, t.pesoFijoKg, t.observaciones, t.urbano],
    );
    invalidarTarifas();
    return { id: res.insertId, ...t };
  },

  /** Cambia una tarifa (nombre, razon social, valor, tipo, pesos, observaciones, urbano) y la devuelve. */
  async actualizarTarifa(id: number, datos: Record<string, unknown>): Promise<TarifaFlete | null> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM tarifas_flete WHERE id = ?", [id]);
    if (!rows[0]) return null;
    const t = normalizarTarifa({ ...mapearTarifa(rows[0]), ...datos });
    await pool.query(
      "UPDATE tarifas_flete SET nombre = ?, razonSocial = ?, valor = ?, tipo = ?, pesoMinimoKg = ?, pesoFijoKg = ?, observaciones = ?, urbano = ? WHERE id = ?",
      [t.nombre, t.razonSocial, t.valor, t.tipo, t.pesoMinimoKg, t.pesoFijoKg, t.observaciones, t.urbano, id],
    );
    invalidarTarifas();
    return { id, ...t };
  },

  /**
   * Viajes listos para facturar (papeles radicados, sin factura con fecha), y
   * los ya enviados a la contadora que aun no tienen fecha de factura (para
   * poder volver a generar el cuadro). Con el radicado de la remesa y la
   * ultima tarifa usada con cada cliente (para sugerirla).
   */
  async porFacturar(): Promise<{ filas: FilaPorFacturar[]; ultimaTarifa: Record<string, number>; quitados: QuitadoEnvio[] }> {
    // Los quitados del envio (no se facturan) no salen; van aparte para poder devolverlos.
    const [marcados] = await pool.query<RowDataPacket[]>(
      `SELECT c.id, c.fecha, c.placa, c.empresa, c.manifiesto, c.remision, c.sinFacturarEn, c.sinFacturarMotivo, u.nombre AS por
         FROM cuadro_viajes c LEFT JOIN usuarios u ON u.id = c.sinFacturarPorId
        WHERE c.sinFacturarEn IS NOT NULL AND c.anulado = 0 AND c.facturaFecha IS NULL
        ORDER BY c.sinFacturarEn DESC`,
    );
    const sinFacturar = new Set(marcados.map((m) => m.id as number));
    const filas = (await cuadro.listar()).filter(
      (f) =>
        !sinFacturar.has(f.id) &&
        !f.anulado &&
        !f.facturaFecha &&
        !f.facturaFechaPago &&
        (((f.estado === "RADICADO" || f.estado === "RADICADOS") && f.estadoFactura === "SIN_FACTURAR") || !!f.enviadoFacturarEn),
    );
    const remesas = filas.map((f) => f.viajeRemesaId).filter((x): x is number => !!x);
    const radicados = new Map<number, string>();
    if (remesas.length) {
      const [rows] = await pool.query<RowDataPacket[]>("SELECT id, numeroRemesaRndc FROM viaje_remesas WHERE id IN (?)", [remesas]);
      for (const r of rows) if (r.numeroRemesaRndc) radicados.set(r.id, String(r.numeroRemesaRndc));
    }
    // Ultima tarifa usada con cada cliente: la mas probable para el siguiente viaje.
    const [usadas] = await pool.query<RowDataPacket[]>(
      `SELECT c.empresa, c.tarifaFleteId FROM cuadro_viajes c
         JOIN (SELECT empresa, MAX(id) AS id FROM cuadro_viajes WHERE tarifaFleteId IS NOT NULL GROUP BY empresa) u
           ON u.id = c.id`,
    );
    return {
      filas: filas.map((f) => ({ ...f, radicadoRemesa: f.viajeRemesaId ? (radicados.get(f.viajeRemesaId) ?? null) : null })),
      ultimaTarifa: Object.fromEntries(usadas.map((u) => [u.empresa, u.tarifaFleteId])),
      quitados: marcados.map((m) => ({
        id: m.id,
        fecha: dia(m.fecha)!,
        placa: m.placa,
        empresa: m.empresa,
        manifiesto: m.manifiesto ?? null,
        remision: m.remision ?? null,
        motivo: m.sinFacturarMotivo ?? null,
        en: m.sinFacturarEn instanceof Date ? m.sinFacturarEn.toISOString() : String(m.sinFacturarEn),
        por: m.por ?? null,
      })),
    };
  },

  /**
   * Quita un viaje del envio a facturacion: no se factura (p. ej. el
   * manifiesto se anulo y el viaje se quedo en la lista). Deja de salir en el
   * envio hasta que se devuelva.
   */
  async quitarDelEnvio(id: number, motivo: unknown, usuarioId: number | null): Promise<void> {
    const texto =
      String(motivo ?? "")
        .trim()
        .slice(0, 200) || "No se factura";
    const [r] = await pool.query<ResultSetHeader>(
      "UPDATE cuadro_viajes SET sinFacturarEn = NOW(), sinFacturarPorId = ?, sinFacturarMotivo = ? WHERE id = ? AND facturaFecha IS NULL",
      [usuarioId, texto, id],
    );
    if (!r.affectedRows) throw new ErrorCuadro("Ese viaje no existe o ya tiene fecha de factura.");
  },

  /** Devuelve al envio a facturacion un viaje quitado (si fue un error). */
  async devolverAlEnvio(id: number): Promise<void> {
    await pool.query("UPDATE cuadro_viajes SET sinFacturarEn = NULL, sinFacturarPorId = NULL, sinFacturarMotivo = NULL WHERE id = ?", [id]);
  },

  /**
   * Guarda en cada viaje lo que se envia a facturar y marca la fecha de envio.
   *
   * Por viaje: tarifa de la matriz, tipo (TON: valor por tonelada y peso
   * facturado; FIJO: el total), remision, nota de la factura y consecutivo de
   * factura (manual: hay varias empresas). El flete del cuadro pagos queda con
   * estos valores. Todo en una transaccion.
   */
  async guardarEnvio(filas: Record<string, unknown>[]): Promise<number> {
    if (!Array.isArray(filas) || filas.length === 0) throw new ErrorCuadro("Elige al menos un viaje.");
    const conexion = await pool.getConnection();
    try {
      await conexion.beginTransaction();
      for (const f of filas) {
        const id = Number(f.id);
        if (!id) throw new ErrorCuadro("Falta el viaje.");
        const fijo = String(f.tipo ?? "TON").toUpperCase() === "FIJO";
        const valorTon = numero(f.valorTon);
        // Mismo tope que en el cuadro: mas de 1.000 $/kg es un error de digitacion.
        if (!fijo && valorTon !== null && valorTon / 1000 > TARIFA_KILO_MAXIMA) {
          throw new ErrorCuadro(
            `Viaje ${id}: ${valorTon.toLocaleString("es-CO")} por tonelada es demasiado (mas de ${TARIFA_KILO_MAXIMA.toLocaleString("es-CO")} $/kg). Revisa el valor por tonelada.`,
          );
        }
        const total = numero(f.total);
        const [res] = await conexion.query<ResultSetHeader>(
          `UPDATE cuadro_viajes SET
              tarifaFleteId = ?, tipoFlete = ?, tarifaKilo = ?, valorFijo = ?, fleteAdicional = ?, pesoFacturadoKg = ?,
              remision = ?, notaFactura = ?, facturaNumero = COALESCE(?, facturaNumero), enviadoFacturarEn = ?
            WHERE id = ? AND anulado = 0`,
          [
            numero(f.tarifaFleteId),
            fijo ? "FIJO" : "KILO",
            fijo || valorTon === null ? null : valorTon / 1000,
            fijo ? total : null,
            fijo ? null : numero(f.adicional),
            numero(f.pesoFacturadoKg),
            texto(f.remision, 60),
            texto(f.notaFactura, 300),
            texto(f.facturaNumero, 30),
            new Date(),
            id,
          ],
        );
        if (res.affectedRows === 0) throw new ErrorCuadro(`El viaje ${id} no existe o esta anulado.`);
      }
      await conexion.commit();
    } catch (exc) {
      await conexion.rollback();
      throw exc;
    } finally {
      conexion.release();
    }
    return filas.length;
  },
};
