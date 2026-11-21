/**
 * Cuentas de viaje y liquidacion de conductores, sin base de datos (se
 * prueba en calculoConductores.test.ts con las hojas de "cuentas de viaje" y
 * el cuadro SWK-973).
 *
 * - Producido conductor: lo que vale el viaje para el conductor, segun la
 *   matriz de fletes conductor (aparte de la de la empresa y mas baja): por
 *   tonelada (valor x toneladas reales) o fijo por viaje, con el valor vigente
 *   en la fecha del viaje. Sobre el sale el % del conductor (4 % salarial, que
 *   genera prestaciones, y 5 % de viaticos, que no).
 * - Cuenta de viaje (la hoja que llena el conductor): lo que recibio (anticipo
 *   de la bomba y transferencia) y lo que gasto por concepto. El saldo es
 *   gastos - recibido: positivo, la empresa le debe al conductor; negativo, el
 *   conductor debe (el "rojo" de la hoja).
 * - Prestamos al conductor: un monto con su saldo; cada mes se decide si se
 *   descuenta y cuanto.
 * - Liquidacion del mes: lo de la nomina (sueldo, % y aportes) + el saldo de
 *   las cuentas de viaje - lo que se descuenta de los prestamos.
 */

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

/** Un valor de la matriz de fletes conductor desde una fecha. */
export interface FleteConductor {
  tarifaFleteId: number;
  valor: number;
  /** TON: por tonelada; FIJO: por viaje. */
  tipo: "TON" | "FIJO";
  desde: string;
}

/** El flete conductor vigente de una tarifa en una fecha (el ultimo que empezo antes o ese dia). */
export function fleteConductorEn(fletes: FleteConductor[], tarifaFleteId: number | null, fecha: string): FleteConductor | null {
  if (!tarifaFleteId) return null;
  return fletes.filter((f) => f.tarifaFleteId === tarifaFleteId && f.desde <= fecha).sort((a, b) => b.desde.localeCompare(a.desde))[0] ?? null;
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
  if (f.tipo === "FIJO") return c2(f.valor);
  if (!viaje.pesoKg) return null;
  return c2((f.valor * viaje.pesoKg) / 1000);
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
  /** Suma del producido conductor de sus viajes (sin los que no tienen valor). */
  producido: number;
  viajesSinProducido: number;
  /** % salarial y de viaticos sobre el producido conductor. */
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
  viajes: Array<{ producido: number | null; saldo: number | null }>;
  pctSalarial: number;
  pctViaticos: number;
  nomina: NominaConductor | null;
  prestamos: number;
}): LiquidacionConductor {
  const conProducido = e.viajes.filter((v) => v.producido !== null);
  const producido = suma(conProducido.map((v) => v.producido!));
  const saldoCuentas = suma(e.viajes.filter((v) => v.saldo !== null).map((v) => v.saldo!));
  const netoNomina = e.nomina ? c2(e.nomina.neto) : null;
  return {
    viajes: e.viajes.length,
    producido,
    viajesSinProducido: e.viajes.length - conProducido.length,
    salarial: c2((producido * e.pctSalarial) / 100),
    viaticos: c2((producido * e.pctViaticos) / 100),
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
