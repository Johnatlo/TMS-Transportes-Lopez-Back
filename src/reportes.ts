/**
 * Reportes contables de los cuadros: estado de cuenta por periodo (saldo
 * inicial, movimientos con su saldo, saldo final) y totales por mes, como los
 * de un programa contable.
 *
 * La parte generica (estadoDeCuenta, porMes) no conoce de donde salen los
 * movimientos: cada cuadro arma los suyos (hoy la bomba; despues cartera,
 * terceros...). Cargo = aumenta lo que se debe; abono = lo disminuye.
 */
import type { RowDataPacket } from "mysql2";
import { pool } from "./db";
import { dia, ErrorCuadro } from "./cuadro";

/** Un movimiento de la cuenta. */
export interface Movimiento {
  fecha: string;
  /** Clase de movimiento (para agrupar y filtrar): PRESTAMO, PAGO_EMPRESA, ABONO_SOCIO... */
  tipo: string;
  descripcion: string;
  /** Lo que aumenta la deuda. */
  cargo: number;
  /** Lo que la disminuye. */
  abono: number;
}

/** Movimiento del estado de cuenta, con el saldo despues de el. */
export type MovimientoConSaldo = Movimiento & { saldo: number };

/** Estado de cuenta de un periodo. */
export interface EstadoDeCuenta {
  desde: string;
  hasta: string;
  /** Saldo (cargos - abonos) de todo lo anterior al periodo. */
  saldoInicial: number;
  movimientos: MovimientoConSaldo[];
  totalCargos: number;
  totalAbonos: number;
  saldoFinal: number;
}

/** Fecha "AAAA-MM-DD" valida o ErrorCuadro. */
export function fechaReporte(v: unknown, campo: string): string {
  const t = String(v ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new ErrorCuadro(`Escribe la fecha ${campo} del reporte.`);
  return t;
}

/**
 * Estado de cuenta entre dos fechas (incluidas): el saldo inicial suma todo
 * lo anterior, y cada movimiento del periodo lleva el saldo acumulado. Los
 * movimientos del mismo dia van primero los cargos.
 */
export function estadoDeCuenta(movimientos: Movimiento[], desde: string, hasta: string): EstadoDeCuenta {
  const saldoInicial = movimientos.filter((m) => m.fecha < desde).reduce((s, m) => s + m.cargo - m.abono, 0);
  const del = movimientos
    .filter((m) => m.fecha >= desde && m.fecha <= hasta)
    .sort((a, b) => a.fecha.localeCompare(b.fecha) || b.cargo - a.cargo);
  let saldo = saldoInicial;
  const conSaldo = del.map((m) => {
    saldo += m.cargo - m.abono;
    return { ...m, saldo };
  });
  const totalCargos = del.reduce((s, m) => s + m.cargo, 0);
  const totalAbonos = del.reduce((s, m) => s + m.abono, 0);
  return { desde, hasta, saldoInicial, movimientos: conSaldo, totalCargos, totalAbonos, saldoFinal: saldoInicial + totalCargos - totalAbonos };
}

/** Totales de cargos y abonos por mes ("2026-09") y por tipo de movimiento. */
export function porMes(movimientos: Movimiento[]): Array<{ mes: string; cargos: number; abonos: number; porTipo: Record<string, number> }> {
  const meses = new Map<string, { mes: string; cargos: number; abonos: number; porTipo: Record<string, number> }>();
  for (const m of movimientos) {
    const mes = m.fecha.slice(0, 7);
    const r = meses.get(mes) ?? { mes, cargos: 0, abonos: 0, porTipo: {} };
    r.cargos += m.cargo;
    r.abonos += m.abono;
    r.porTipo[m.tipo] = (r.porTipo[m.tipo] ?? 0) + m.cargo + m.abono;
    meses.set(mes, r);
  }
  return [...meses.values()].sort((a, b) => a.mes.localeCompare(b.mes));
}

// ---------------------------------------------------------------------------
// Bomba: lo que presto (anticipos de efectivo y combustible) y lo que se le pago.
// ---------------------------------------------------------------------------

/** Un anticipo entregado en la bomba (para el reporte). */
export interface EntregaBomba {
  fecha: string;
  bomba: string;
  /** LOPEZ, MYC o TERCERO. */
  flota: string | null;
  efectivo: number;
  combustible: number;
}

/** Un pago a la bomba que no paso por "Registrar pago" (fecha de pago puesta en el tramo). */
export interface PagoSuelto {
  fecha: string;
  valor: number;
}

/**
 * Movimientos de la cuenta con la bomba:
 * - PRESTAMO: los anticipos entregados (efectivo + combustible), uno por dia y bomba.
 * - ABONO_SOCIO: lo que los socios le pagaron directamente a la bomba.
 * - PAGO_EMPRESA: los pagos de la quincena (facturas - abonos de los socios).
 * - PAGO: anticipos marcados como pagados sin un pago de la quincena (los
 *   cargados del Excel, o con la fecha escrita a mano), por dia.
 * Asi el saldo es la deuda con la bomba: los abonos usados en un pago se
 * restan en su fecha y el pago solo resta lo que puso la empresa.
 */
export function movimientosBomba(
  entregas: EntregaBomba[],
  abonos: Array<{ fecha: string; socio: string; valor: number }>,
  pagos: Array<{ id: number; fecha: string; valorPagado: number; facturas: string[] }>,
  pagosSueltos: PagoSuelto[]
): Movimiento[] {
  const movs: Movimiento[] = [];
  const porDia = new Map<string, { fecha: string; bomba: string; valor: number; n: number }>();
  for (const e of entregas) {
    const k = `${e.fecha}|${e.bomba}`;
    const r = porDia.get(k) ?? { fecha: e.fecha, bomba: e.bomba, valor: 0, n: 0 };
    r.valor += e.efectivo + e.combustible;
    r.n++;
    porDia.set(k, r);
  }
  for (const r of porDia.values()) {
    movs.push({ fecha: r.fecha, tipo: "PRESTAMO", descripcion: `Anticipos ${r.bomba} (${r.n})`, cargo: r.valor, abono: 0 });
  }
  for (const a of abonos) movs.push({ fecha: a.fecha, tipo: "ABONO_SOCIO", descripcion: `Abono de ${a.socio}`, cargo: 0, abono: a.valor });
  for (const p of pagos) {
    movs.push({
      fecha: p.fecha,
      tipo: "PAGO_EMPRESA",
      descripcion: `Pago No. ${p.id}${p.facturas.length ? ` (facturas ${p.facturas.join(", ")})` : ""}`,
      cargo: 0,
      abono: p.valorPagado,
    });
  }
  const sueltos = new Map<string, number>();
  for (const p of pagosSueltos) sueltos.set(p.fecha, (sueltos.get(p.fecha) ?? 0) + p.valor);
  for (const [fecha, valor] of sueltos) movs.push({ fecha, tipo: "PAGO", descripcion: "Anticipos pagados a la bomba", cargo: 0, abono: valor });
  return movs;
}

/** Totales de lo entregado agrupado por una llave (bomba, empresa del vehiculo). */
function totalesPor(entregas: EntregaBomba[], llave: (e: EntregaBomba) => string) {
  const m = new Map<string, { nombre: string; efectivo: number; combustible: number; total: number; anticipos: number }>();
  for (const e of entregas) {
    const k = llave(e);
    const r = m.get(k) ?? { nombre: k, efectivo: 0, combustible: 0, total: 0, anticipos: 0 };
    r.efectivo += e.efectivo;
    r.combustible += e.combustible;
    r.total += e.efectivo + e.combustible;
    r.anticipos++;
    m.set(k, r);
  }
  return [...m.values()].sort((a, b) => b.total - a.total);
}

/** Nombre de la empresa del vehiculo como en el Excel de anticipos. */
const flotaTexto = (f: string | null) => (f === "MYC" ? "M&C" : f === "LOPEZ" ? "LOPEZ" : f === "TERCERO" ? "TERCERO" : "SIN DATO");

/**
 * Reporte de la bomba entre dos fechas: estado de cuenta (deuda al inicio,
 * prestamos, abonos de los socios, pagos de la empresa, deuda al final),
 * resumen del periodo y lo prestado por mes, por bomba y por empresa del
 * vehiculo.
 */
export function reporteBomba(
  datos: {
    entregas: EntregaBomba[];
    abonos: Array<{ fecha: string; socio: string; valor: number }>;
    pagos: Array<{ id: number; fecha: string; valorPagado: number; facturas: string[] }>;
    pagosSueltos: PagoSuelto[];
  },
  desde: string,
  hasta: string
) {
  const movs = movimientosBomba(datos.entregas, datos.abonos, datos.pagos, datos.pagosSueltos);
  const estado = estadoDeCuenta(movs, desde, hasta);
  const enPeriodo = (f: string) => f >= desde && f <= hasta;
  const entregas = datos.entregas.filter((e) => enPeriodo(e.fecha));
  const delPeriodo = estado.movimientos;
  const suma = (tipo: string) => delPeriodo.filter((m) => m.tipo === tipo).reduce((s, m) => s + m.abono, 0);
  const pagadoEmpresa = suma("PAGO_EMPRESA") + suma("PAGO");
  const abonadoSocios = suma("ABONO_SOCIO");
  return {
    estado,
    resumen: {
      saldoInicial: estado.saldoInicial,
      prestadoEfectivo: entregas.reduce((s, e) => s + e.efectivo, 0),
      prestadoCombustible: entregas.reduce((s, e) => s + e.combustible, 0),
      prestado: estado.totalCargos,
      anticipos: entregas.length,
      pagadoEmpresa,
      abonadoSocios,
      totalPagado: pagadoEmpresa + abonadoSocios,
      saldoFinal: estado.saldoFinal,
    },
    porMes: porMes(delPeriodo).map((m) => ({
      mes: m.mes,
      prestado: m.cargos,
      pagadoEmpresa: (m.porTipo.PAGO_EMPRESA ?? 0) + (m.porTipo.PAGO ?? 0),
      abonadoSocios: m.porTipo.ABONO_SOCIO ?? 0,
    })),
    porBomba: totalesPor(entregas, (e) => e.bomba),
    porEmpresaVehiculo: totalesPor(entregas, (e) => flotaTexto(e.flota)),
  };
}

/** Repositorio: lee de la base lo que necesitan los reportes. */
export const reportes = {
  /** Reporte de la bomba entre dos fechas ({ desde, hasta }). */
  async bomba(q: Record<string, unknown>) {
    const desde = fechaReporte(q.desde, "inicial");
    const hasta = fechaReporte(q.hasta, "final");
    if (desde > hasta) throw new ErrorCuadro("La fecha inicial es despues de la final.");
    const [tramos] = await pool.query<RowDataPacket[]>(
      `SELECT a.fecha, a.efectivo, a.combustible, a.fechaPago, b.nombre AS bomba,
              (SELECT ve.flota FROM vehiculos ve
                WHERE REPLACE(ve.placa, '-', '') = REPLACE(COALESCE(a.placa, c.placa), '-', '') LIMIT 1) AS flota,
              EXISTS (SELECT 1 FROM bomba_relacion_vales v JOIN bomba_relaciones r ON r.id = v.relacionId
                       WHERE v.cuadroAnticipoId = a.id AND r.pagoId IS NOT NULL) AS enPago
         FROM cuadro_anticipos a
         JOIN bombas b ON b.id = a.bombaId
         LEFT JOIN cuadro_viajes c ON c.id = a.cuadroViajeId`
    );
    const [abonos] = await pool.query<RowDataPacket[]>("SELECT fecha, socio, valor FROM abonos_socio");
    const [pagos] = await pool.query<RowDataPacket[]>(
      `SELECT p.id, p.fecha, p.valorPagado,
              (SELECT GROUP_CONCAT(numero ORDER BY numero SEPARATOR ', ') FROM bomba_relaciones WHERE pagoId = p.id) AS facturas
         FROM bomba_pagos p`
    );
    return reporteBomba(
      {
        entregas: tramos.map((t) => ({
          fecha: dia(t.fecha)!,
          bomba: t.bomba,
          flota: t.flota ?? null,
          efectivo: Number(t.efectivo ?? 0),
          combustible: Number(t.combustible ?? 0),
        })),
        abonos: abonos.map((a) => ({ fecha: dia(a.fecha)!, socio: a.socio, valor: Number(a.valor) })),
        pagos: pagos.map((p) => ({
          id: p.id,
          fecha: dia(p.fecha)!,
          valorPagado: Number(p.valorPagado),
          facturas: p.facturas ? String(p.facturas).split(", ") : [],
        })),
        pagosSueltos: tramos
          .filter((t) => t.fechaPago && !Number(t.enPago))
          .map((t) => ({ fecha: dia(t.fechaPago)!, valor: Number(t.efectivo ?? 0) + Number(t.combustible ?? 0) })),
      },
      desde,
      hasta
    );
  },
};
