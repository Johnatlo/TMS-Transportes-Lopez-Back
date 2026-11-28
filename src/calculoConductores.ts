/**
 * Cuentas de viaje y liquidacion de conductores, sin base de datos (se
 * prueba en calculoConductores.test.ts con las hojas de "cuentas de viaje" y
 * el cuadro SWK-973).
 *
 * - Producido conductor: lo que vale el viaje para el conductor, segun la
 *   matriz de fletes conductor (aparte de la de la empresa y mas baja): por
 *   tonelada (valor x toneladas reales) o fijo por viaje, con el valor vigente
 *   en la fecha del viaje. Sobre el sale el % del conductor (4 % salarial, que
 *   genera prestaciones, y 5 % de viaticos, que no). INTEGRO: un valor por
 *   viaje que se le paga completo (los urbanos, que con el % quedarian muy
 *   bajos); no va al %.
 * - Cuenta de viaje (la hoja que llena el conductor): lo que recibio (anticipo
 *   de la bomba y transferencia) y lo que gasto por concepto. El saldo es
 *   gastos - recibido: positivo, la empresa le debe al conductor; negativo, el
 *   conductor debe (el "rojo" de la hoja).
 * - Prestamos al conductor: un monto con su saldo; cada mes se decide si se
 *   descuenta y cuanto.
 * - Liquidacion del mes: lo de la nomina (sueldo, % y aportes) + el saldo de
 *   las cuentas de viaje - lo que se descuenta de los prestamos.
 */

import { pagoProducido } from "./calculoNomina";

/**
 * Dia de cierre de las cuentas de los conductores: el "mes" de un conductor
 * va del dia siguiente al cierre del mes anterior hasta el cierre de este (con
 * 26: noviembre = del 27 de octubre al 26 de noviembre). Asi los viajes de los
 * ultimos dias del mes no quedan por fuera de ninguna liquidacion.
 */
export const DIA_CORTE = 26;

/** El mes anterior ("AAAA-MM"). */
const mesAnterior = (mes: string) => {
  const [a, m] = mes.split("-").map(Number);
  return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, "0")}`;
};

/** Fechas del periodo de las cuentas de los conductores de un mes ("AAAA-MM"). */
export function periodoConductores(mes: string): { desde: string; hasta: string } {
  return { desde: `${mesAnterior(mes)}-${DIA_CORTE + 1}`, hasta: `${mes}-${DIA_CORTE}` };
}

/** El mes de las cuentas de los conductores al que pertenece un viaje (despues del cierre, el siguiente). */
export function mesConductores(fecha: string): string {
  const [a, m, d] = fecha.slice(0, 10).split("-").map(Number);
  if (d <= DIA_CORTE) return fecha.slice(0, 7);
  return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, "0")}`;
}

/** Centavos exactos. */
const c2 = (v: number) => Math.round(v * 100 + Number.EPSILON) / 100;
/** Suma a centavos. */
const suma = (xs: number[]) => c2(xs.reduce((s, x) => s + x, 0));

/** Conceptos de gasto de la hoja de cuenta de viaje, en su orden. */
export const CONCEPTOS = [
  ["acpm", "ACPM"],
  ["peajes", "Peajes"],
  ["cargue", "Cargue"],
  ["descargue", "Descargue"],
  ["parqueo", "Parqueo"],
  ["llantas", "Llantas"],
  ["lavada", "Lavada"],
  ["comision", "Comision"],
  ["engrase", "Engrase"],
  ["propinas", "Propinas"],
  ["arreglos", "Arreglos"],
  ["accesorios", "Accesorios"],
  ["otros", "Otros"],
] as const;
export type Concepto = (typeof CONCEPTOS)[number][0];
export type GastosCuenta = Record<Concepto, number>;

/** Tipos de flete conductor. */
export type TipoFleteConductor = "TON" | "FIJO" | "INTEGRO";
/** El tipo de un texto (de la base o del Excel): por defecto TON. */
export const tipoFleteConductor = (t: unknown): TipoFleteConductor => {
  const x = String(t ?? "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return x === "FIJO" ? "FIJO" : x === "INTEGRO" ? "INTEGRO" : "TON";
};

/** Un valor de la matriz de fletes conductor desde una fecha. */
export interface FleteConductor {
  tarifaFleteId: number;
  valor: number;
  /** TON: por tonelada; FIJO: por viaje (va al %); INTEGRO: por viaje, se le paga completo. */
  tipo: TipoFleteConductor;
  desde: string;
}

/** El flete conductor vigente de una tarifa en una fecha (el ultimo que empezo antes o ese dia). */
export function fleteConductorEn(fletes: FleteConductor[], tarifaFleteId: number | null, fecha: string): FleteConductor | null {
  if (!tarifaFleteId) return null;
  return fletes.filter((f) => f.tarifaFleteId === tarifaFleteId && f.desde <= fecha).sort((a, b) => b.desde.localeCompare(a.desde))[0] ?? null;
}

/**
 * Tarifa con que se saca el flete conductor de un viaje que no tiene tarifa
 * en el Cuadro (flete traido del Excel o sin elegir): la que el Cuadro deduce
 * exacta o, si quedan varias posibles y todas tienen el mismo flete conductor
 * en esa fecha (por ejemplo las urbanas de un cliente), la primera. null si
 * no hay forma de saberlo.
 */
export function tarifaConductorDeducida(fecha: string, exacta: number | null, posibles: number[], fletes: FleteConductor[]): number | null {
  if (exacta) return exacta;
  if (!posibles.length) return null;
  const valores = posibles.map((id) => fleteConductorEn(fletes, id, fecha));
  if (valores.some((v) => !v)) return null;
  const mismo = valores.every((v) => v!.valor === valores[0]!.valor && v!.tipo === valores[0]!.tipo);
  return mismo ? posibles[0] : null;
}

/**
 * Producido conductor de un viaje: el escrito a mano (si lo hay) o el de la
 * matriz (por tonelada: valor x toneladas reales; fijo: el valor). null si no
 * hay valor (sin tarifa en la matriz o sin peso).
 */
export function producidoConductor(
  viaje: { fecha: string; tarifaFleteId: number | null; pesoKg: number | null },
  fletes: FleteConductor[],
  manual: number | null = null,
): number | null {
  if (manual !== null && manual !== undefined) return c2(manual);
  const f = fleteConductorEn(fletes, viaje.tarifaFleteId, viaje.fecha);
  if (!f) return null;
  if (f.tipo === "FIJO" || f.tipo === "INTEGRO") return c2(f.valor);
  if (!viaje.pesoKg) return null;
  return c2((f.valor * viaje.pesoKg) / 1000);
}

/** true si el flete conductor del viaje es INTEGRO (se le paga completo, sin %). */
export function esIntegro(viaje: { fecha: string; tarifaFleteId: number | null }, fletes: FleteConductor[]): boolean {
  return fleteConductorEn(fletes, viaje.tarifaFleteId, viaje.fecha)?.tipo === "INTEGRO";
}

/** Total de los gastos de una cuenta de viaje. */
export const totalGastos = (g: Partial<GastosCuenta>) => suma(CONCEPTOS.map(([k]) => Number(g[k] ?? 0)));

/**
 * Saldo de una cuenta de viaje con el conductor: gastos - lo que recibio
 * (anticipo + transferencia). Positivo: la empresa le debe; negativo: el
 * conductor debe (el "rojo").
 */
export const saldoCuenta = (gastos: number, recibido: number) => c2(gastos - recibido);

/** Saldo de un prestamo: el monto menos lo descontado. */
export const saldoPrestamo = (monto: number, descuentos: number[]) => c2(monto - suma(descuentos));

/** Lo de la nomina del conductor que entra a su liquidacion (null si aun no hay nomina del mes). */
export interface NominaConductor {
  /** Basico + auxilio + % salarial + viaticos. */
  devengado: number;
  /** Salud y pension del conductor. */
  deducciones: number;
  /** Devengado - deducciones. */
  neto: number;
}

/** La liquidacion de un conductor en el mes. */
export interface LiquidacionConductor {
  viajes: number;
  /** Suma del producido conductor de sus viajes que van al % (sin los que no tienen valor). */
  producido: number;
  /** Suma de los viajes integros: se le pagan completos. */
  integro: number;
  viajesSinProducido: number;
  /** % salarial y de viaticos sobre el producido conductor, mas los integros (en la proporcion de los %). */
  salarial: number;
  viaticos: number;
  /** Suma de los saldos de sus cuentas de viaje (positivo: se le debe). */
  saldoCuentas: number;
  viajesSinCuenta: number;
  /** Lo que se le descuenta de prestamos este mes. */
  prestamos: number;
  /** Neto de la nomina (null si no hay nomina del mes). */
  netoNomina: number | null;
  /** Neto de la nomina + saldo de las cuentas - prestamos. */
  totalAPagar: number | null;
}

/**
 * Liquidacion del conductor en el mes: el % sobre el producido conductor de
 * sus viajes (que la nomina paga con el sueldo), el saldo de sus cuentas de
 * viaje y lo que se descuenta de prestamos. El total a pagar es el neto de la
 * nomina + el saldo de las cuentas - los prestamos.
 */
export function liquidarConductor(e: {
  viajes: Array<{ producido: number | null; saldo: number | null; integro?: boolean }>;
  pctSalarial: number;
  pctViaticos: number;
  nomina: NominaConductor | null;
  prestamos: number;
}): LiquidacionConductor {
  const conProducido = e.viajes.filter((v) => v.producido !== null);
  const producido = suma(conProducido.filter((v) => !v.integro).map((v) => v.producido!));
  const integro = suma(conProducido.filter((v) => v.integro).map((v) => v.producido!));
  const pago = pagoProducido(producido, integro, e.pctSalarial, e.pctViaticos);
  const saldoCuentas = suma(e.viajes.filter((v) => v.saldo !== null).map((v) => v.saldo!));
  const netoNomina = e.nomina ? c2(e.nomina.neto) : null;
  return {
    viajes: e.viajes.length,
    producido,
    integro,
    viajesSinProducido: e.viajes.length - conProducido.length,
    salarial: pago.variable,
    viaticos: pago.viaticos,
    saldoCuentas,
    viajesSinCuenta: e.viajes.filter((v) => v.saldo === null).length,
    prestamos: c2(e.prestamos),
    netoNomina,
    totalAPagar: netoNomina === null ? null : c2(netoNomina + saldoCuentas - e.prestamos),
  };
}

/** Texto comparable de un nombre de tarifa (sin tildes ni signos, en mayuscula). */
export const nombreComparable = (t: unknown) =>
  String(t ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
