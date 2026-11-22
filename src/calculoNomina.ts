/**
 * Calculo de una linea de nomina (empleado y empleador), sin base de datos
 * (se prueba en calculoNomina.test.ts con los casos del Excel "Modelo Nomina
 * Transportes M&C & Transportes Lopez C 2026").
 *
 * - Basico: el salario del mes (minimo del ano, o el que tenga el empleado,
 *   mas su adicional) por los dias trabajados / 30.
 * - Conductor: + % salarial del producido (4 %) y % de viaticos (5 %), que no
 *   es salario: no paga aportes ni genera prestaciones (salvo lo que pase del
 *   limite no salarial de la Ley 1393, 40 % del total, que entra al IBC).
 *   Los viajes con flete conductor INTEGRO (urbanos con valor fijo) no van al
 *   %: su valor se le paga completo, repartido entre salarial y viaticos en la
 *   misma proporcion de los porcentajes (4/9 y 5/9).
 * - Auxilio de transporte: si el empleado lo tiene y gana hasta 2 minimos.
 * - Aportes (salud y pension del empleado; pension, salud, ARL y caja del
 *   empleador) se redondean hacia arriba a la centena, como la PILA.
 * - Prima y cesantias sobre salarial + auxilio; intereses = 12 % de las
 *   cesantias; vacaciones sobre el salarial. Se provisionan (no se redondean).
 * - Ajuste: una diferencia manual con nota (lo que en el Excel eran los
 *   "-15200" sueltos). Suma al costo del empleador.
 * - UPC adicional: lo que se paga por los beneficiarios adicionales en salud
 *   (va en la planilla con la salud). Lo asume la empresa: suma al costo y no
 *   se le descuenta al empleado.
 * - Costo total = lo que se le paga al empleado (devengado) + costo del
 *   empleador.
 * - Gasto: lo que se carga a los vehiculos (o al reparto del de oficina): la
 *   suma de los conceptos que se marcan (por defecto todos = el costo total).
 *   Un empleado puede no cargar algunos (por ejemplo solo cesantias e
 *   intereses); lo que se le paga no cambia.
 *
 * Todo en pesos con dos decimales. Los porcentajes vienen en % (12 = 12 %).
 */

/** Parametros de nomina de un ano (tabla parametros_nomina). */
export interface ParametrosNomina {
  anio: number;
  smmlv: number;
  auxilioTransporte: number;
  pensionEmpleador: number;
  saludEmpleador: number;
  /** ARL por nivel de riesgo I a V. */
  arl: [number, number, number, number, number];
  caja: number;
  prima: number;
  cesantias: number;
  interesesCesantias: number;
  vacaciones: number;
  saludEmpleado: number;
  pensionEmpleado: number;
  /** % del total que puede ser no salarial sin pagar aportes (Ley 1393: 40). */
  limiteNoSalarial: number;
}

/** Lo que entra al calculo de una linea. */
export interface EntradaLinea {
  /** Salario mensual fijo; null = el minimo del ano. */
  salarioBase: number | null;
  /** Lo que se suma al salario (por ejemplo minimo + 200.000). */
  salarioAdicional: number;
  pctSalarial: number;
  pctViaticos: number;
  auxilio: boolean;
  /** Nivel de riesgo ARL, 1 a 5. */
  riesgoArl: number;
  /** Dias trabajados (30 = el mes completo). */
  dias: number;
  /** Producido al que se le saca el % (sin los viajes integros). */
  producido: number;
  /** Viajes con flete conductor INTEGRO: se pagan completos (no van al %). */
  integro?: number;
  ajuste: number;
  /** UPC adicional del mes (salud de beneficiarios adicionales; la paga la empresa). */
  upcAdicional?: number;
}

/** El resultado de una linea. */
export interface CalculoLinea {
  basico: number;
  variable: number;
  salarial: number;
  viaticos: number;
  auxilio: number;
  devengado: number;
  /** Base de aportes. */
  ibc: number;
  saludEmpleado: number;
  pensionEmpleado: number;
  /** Lo que se le paga al empleado. */
  neto: number;
  pensionEmpleador: number;
  saludEmpleador: number;
  arl: number;
  caja: number;
  prima: number;
  cesantias: number;
  interesesCesantias: number;
  vacaciones: number;
  /** UPC adicional (va con la salud en la planilla; la paga la empresa). */
  upcAdicional: number;
  ajuste: number;
  /** Aportes + UPC adicional + provisiones + ajuste. */
  costoEmpleador: number;
  /** Devengado + costo del empleador: lo que va a la rentabilidad. */
  costoTotal: number;
}

/** Redondea a centavos. */
const c2 = (v: number) => Math.round(v * 100 + Number.EPSILON) / 100;
/** Hacia arriba a la centena (PILA); tolera el ruido de punto flotante. */
export const pila = (v: number) => (v <= 0 ? 0 : Math.ceil(c2(v) / 100 - 1e-9) * 100);
/** Un porcentaje (en %) de un valor, a centavos. */
const pct = (v: number, p: number) => c2((v * p) / 100);

/**
 * Lo que el conductor gana por sus viajes: el % salarial y de viaticos del
 * producido, mas los viajes integros completos, repartidos entre salarial y
 * viaticos en la proporcion de los porcentajes (sin porcentajes, todo salarial).
 */
export function pagoProducido(producido: number, integro: number, pctSalarial: number, pctViaticos: number): { variable: number; viaticos: number } {
  const total = pctSalarial + pctViaticos;
  const integroSalarial = total > 0 ? c2((integro * pctSalarial) / total) : c2(integro);
  return {
    variable: c2(pct(producido, pctSalarial) + integroSalarial),
    viaticos: c2(pct(producido, pctViaticos) + c2(integro) - integroSalarial),
  };
}

/** Calcula una linea de nomina. */
export function calcularLinea(e: EntradaLinea, p: ParametrosNomina): CalculoLinea {
  const dias = Math.max(0, Math.min(30, e.dias));
  const mensual = (e.salarioBase ?? p.smmlv) + e.salarioAdicional;
  const basico = c2((mensual * dias) / 30);
  const { variable, viaticos } = pagoProducido(e.producido, e.integro ?? 0, e.pctSalarial, e.pctViaticos);
  const salarial = c2(basico + variable);
  const tieneAuxilio = e.auxilio && dias > 0 && (salarial * 30) / dias <= 2 * p.smmlv;
  const auxilio = tieneAuxilio ? c2((p.auxilioTransporte * dias) / 30) : 0;
  const devengado = c2(salarial + viaticos + auxilio);
  // Ley 1393: lo no salarial que pase del limite sobre el total entra al IBC.
  const exceso = Math.max(0, viaticos - pct(salarial + viaticos, p.limiteNoSalarial));
  const ibc = c2(salarial + exceso);
  const saludEmpleado = pila(pct(ibc, p.saludEmpleado));
  const pensionEmpleado = pila(pct(ibc, p.pensionEmpleado));
  const riesgo = Math.max(1, Math.min(5, Math.round(e.riesgoArl))) - 1;
  const pensionEmpleador = pila(pct(ibc, p.pensionEmpleador));
  const saludEmpleador = pila(pct(ibc, p.saludEmpleador));
  const arl = pila(pct(ibc, p.arl[riesgo]));
  const caja = pila(pct(ibc, p.caja));
  const prima = pct(salarial + auxilio, p.prima);
  const cesantias = pct(salarial + auxilio, p.cesantias);
  const interesesCesantias = pct(cesantias, p.interesesCesantias);
  const vacaciones = pct(salarial, p.vacaciones);
  const ajuste = c2(e.ajuste);
  const upcAdicional = c2(e.upcAdicional ?? 0);
  const costoEmpleador = c2(pensionEmpleador + saludEmpleador + upcAdicional + arl + caja + prima + cesantias + interesesCesantias + vacaciones + ajuste);
  return {
    basico,
    variable,
    salarial,
    viaticos,
    auxilio,
    devengado,
    ibc,
    saludEmpleado,
    pensionEmpleado,
    neto: c2(devengado - saludEmpleado - pensionEmpleado),
    pensionEmpleador,
    saludEmpleador,
    arl,
    caja,
    prima,
    cesantias,
    interesesCesantias,
    vacaciones,
    upcAdicional,
    ajuste,
    costoEmpleador,
    costoTotal: c2(devengado + costoEmpleador),
  };
}

/**
 * Conceptos de la nomina que pueden ir o no al gasto (los vehiculos): todo lo
 * que la empresa paga por el empleado. Sumados dan el costo total.
 */
export const CONCEPTOS_GASTO = [
  ["basico", "Sueldo basico"],
  ["auxilio", "Auxilio de transporte"],
  ["variable", "% salarial del producido"],
  ["viaticos", "Viaticos"],
  ["saludEmpleador", "Salud (empresa)"],
  ["upcAdicional", "UPC adicional"],
  ["pensionEmpleador", "Pension (empresa)"],
  ["arl", "ARL"],
  ["caja", "Caja de compensacion"],
  ["prima", "Prima"],
  ["cesantias", "Cesantias"],
  ["interesesCesantias", "Intereses de cesantias"],
  ["vacaciones", "Vacaciones"],
  ["ajuste", "Ajuste"],
] as const;
export type ConceptoGasto = (typeof CONCEPTOS_GASTO)[number][0];

/**
 * Lo que va al gasto de una linea: la suma de los conceptos que no se
 * excluyeron, separando la UPC adicional (va al vehiculo que se elija, no al
 * reparto del empleado). Sin exclusiones, general + upc = costo total.
 */
export function gastoDeLinea(c: CalculoLinea, excluidos: readonly string[] = []): { general: number; upc: number; total: number } {
  const incluido = (k: ConceptoGasto) => !excluidos.includes(k);
  const general = c2(CONCEPTOS_GASTO.filter(([k]) => k !== "upcAdicional" && incluido(k)).reduce((s, [k]) => s + c[k], 0));
  const upc = incluido("upcAdicional") ? c.upcAdicional : 0;
  return { general, upc, total: c2(general + upc) };
}

/**
 * Reparto del costo de un conductor entre sus vehiculos en porcentajes que
 * suman 100 (con dos decimales; el redondeo lo absorbe el mayor). Viene de
 * los pesos de pesosConductor.
 */
export function porcentajesDe(pesos: Map<number, number>): Array<{ vehiculoId: number; porcentaje: number }> {
  const lista = [...pesos.entries()].filter(([, p]) => p > 0).map(([vehiculoId, p]) => ({ vehiculoId, porcentaje: c2(p * 100) }));
  if (!lista.length) return [];
  const diferencia = c2(100 - lista.reduce((s, x) => s + x.porcentaje, 0));
  const mayor = lista.reduce((a, b) => (b.porcentaje > a.porcentaje ? b : a));
  mayor.porcentaje = c2(mayor.porcentaje + diferencia);
  return lista;
}

/** Revisa un reparto escrito a mano: vehiculos distintos, porcentajes positivos que suman 100. Devuelve el error o null. */
export function errorReparto(reparto: Array<{ vehiculoId: number; porcentaje: number }>): string | null {
  if (!reparto.length) return "Elige al menos un vehiculo.";
  if (new Set(reparto.map((r) => r.vehiculoId)).size !== reparto.length) return "Un vehiculo esta repetido en el reparto.";
  if (reparto.some((r) => !Number.isFinite(r.porcentaje) || r.porcentaje <= 0)) return "Cada porcentaje debe ser mayor que cero.";
  const suma = c2(reparto.reduce((s, r) => s + r.porcentaje, 0));
  if (Math.abs(suma - 100) > 0.01) return `Los porcentajes suman ${suma} %: deben sumar 100 %.`;
  return null;
}

/** Dias de nomina de un periodo (mes comercial de 30 dias): del 21/10 al 20/11 son 30. */
export function diasPeriodo(desde: string, hasta: string): number {
  const [a1, m1, d1] = desde.split("-").map(Number);
  const [a2, m2, d2] = hasta.split("-").map(Number);
  const dia = (d: number) => Math.min(d, 30);
  const dias = (a2 - a1) * 360 + (m2 - m1) * 30 + (dia(d2) - dia(d1)) + 1;
  return Math.max(0, Math.min(30, dias));
}

/** Un viaje del cuadro para el producido: su vehiculo, fecha y flete (null = sin tarifa). */
export interface ViajeProducido {
  id: number;
  fecha: string;
  vehiculoId: number;
  flete: number | null;
  /** Flete conductor INTEGRO: se paga completo, no va al %. */
  integro?: boolean;
}

/** Vehiculo de un conductor con fechas (empleados_vehiculos). */
export interface AsignacionVehiculo {
  empleadoId: number;
  vehiculoId: number;
  desde: string;
  hasta: string | null;
}

/** Producido de un conductor: el total y cuanto en cada vehiculo. */
export interface ProducidoConductor {
  /** Todo lo de sus viajes (con los integros). */
  total: number;
  /** Lo de los viajes integros (se pagan completos; las nominas viejas no lo traen). */
  integro?: number;
  porVehiculo: Array<{ vehiculoId: number; producido: number; integro?: number; viajes: number; sinTarifa: number }>;
  /** Viajes que le tocaron (ids), para ver el detalle. */
  viajes: number[];
}

/**
 * Producido de cada conductor (como el Excel): la suma del flete de los
 * viajes de los vehiculos que manejaba, segun la fecha del viaje y su
 * asignacion de vehiculo. Si un conductor cambio de carro en el mes, suma los
 * dos (Ferney en octubre: SZX-880 y SOR-429). Si dos asignaciones cubren la
 * misma fecha, gana la que empezo despues. Los viajes sin tarifa no suman y
 * se cuentan aparte.
 */
export function producidoPorConductor(viajes: ViajeProducido[], asignaciones: AsignacionVehiculo[]): Map<number, ProducidoConductor> {
  const resultado = new Map<number, ProducidoConductor>();
  for (const v of viajes) {
    const a = asignaciones
      .filter((x) => x.vehiculoId === v.vehiculoId && x.desde <= v.fecha && (!x.hasta || x.hasta >= v.fecha))
      .sort((x, y) => y.desde.localeCompare(x.desde))[0];
    if (!a) continue;
    const p = resultado.get(a.empleadoId) ?? { total: 0, integro: 0, porVehiculo: [], viajes: [] };
    let pv = p.porVehiculo.find((x) => x.vehiculoId === v.vehiculoId);
    if (!pv) {
      pv = { vehiculoId: v.vehiculoId, producido: 0, integro: 0, viajes: 0, sinTarifa: 0 };
      p.porVehiculo.push(pv);
    }
    pv.viajes += 1;
    if (v.flete === null) pv.sinTarifa += 1;
    else {
      pv.producido = c2(pv.producido + v.flete);
      p.total = c2(p.total + v.flete);
      if (v.integro) {
        pv.integro = c2((pv.integro ?? 0) + v.flete);
        p.integro = c2((p.integro ?? 0) + v.flete);
      }
    }
    p.viajes.push(v.id);
    resultado.set(a.empleadoId, p);
  }
  return resultado;
}

/** Mes calendario de una fecha: el producido de la nomina del 21/10 al 20/11 es el de octubre. */
export function mesDe(fecha: string): { desde: string; hasta: string } {
  const [a, m] = fecha.split("-").map(Number);
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { desde: `${a}-${mm}-01`, hasta: `${a}-${mm}-${ultimo}` };
}

/**
 * Pesos para repartir el costo de un conductor entre los vehiculos que
 * manejo en el periodo: la parte que sale del producido (variable y viaticos)
 * segun lo que produjo en cada carro, y el resto (basico, auxilio y su carga)
 * segun los dias que manejo cada uno. Si no produjo nada, todo por dias; si no
 * hay dias, todo por producido. Los pesos suman 1.
 */
export function pesosConductor(
  c: Pick<CalculoLinea, "variable" | "viaticos" | "devengado">,
  producidoPor: Map<number, number>,
  diasPor: Map<number, number>,
): Map<number, number> {
  const totalProd = [...producidoPor.values()].reduce((s, x) => s + Math.max(0, x), 0);
  const totalDias = [...diasPor.values()].reduce((s, x) => s + Math.max(0, x), 0);
  let f = c.devengado > 0 ? (c.variable + c.viaticos) / c.devengado : 0;
  if (totalProd <= 0) f = 0;
  if (totalDias <= 0) f = totalProd > 0 ? 1 : 0;
  const pesos = new Map<number, number>();
  for (const [v, p] of producidoPor) if (totalProd > 0 && p > 0) pesos.set(v, (pesos.get(v) ?? 0) + (f * p) / totalProd);
  for (const [v, d] of diasPor) if (totalDias > 0 && d > 0) pesos.set(v, (pesos.get(v) ?? 0) + ((1 - f) * d) / totalDias);
  return pesos;
}

/** Dias que el conductor tuvo cada vehiculo dentro del periodo (por su asignacion con fechas). */
export function diasPorVehiculo(
  asignaciones: Array<{ vehiculoId: number; desde: string; hasta: string | null }>,
  desde: string,
  hasta: string,
): Map<number, number> {
  const dias = new Map<number, number>();
  for (const a of asignaciones) {
    const ini = a.desde > desde ? a.desde : desde;
    const fin = a.hasta && a.hasta < hasta ? a.hasta : hasta;
    if (fin < ini) continue;
    const n = Math.round((Date.parse(fin) - Date.parse(ini)) / 86_400_000) + 1;
    dias.set(a.vehiculoId, (dias.get(a.vehiculoId) ?? 0) + n);
  }
  return dias;
}

/**
 * Un beneficiario de UPC adicional: la persona por la que se paga (puede no
 * ser empleado, por ejemplo un familiar del conductor), cuanto y a que
 * vehiculo se carga. El cotizante es el empleado de la linea.
 */
export interface UpcBeneficiario {
  cedula: string;
  nombre: string;
  valor: number;
  vehiculoId: number;
}

/**
 * Revisa y normaliza la lista de UPC adicional de una linea: cada uno con
 * cedula (solo numeros), nombre, valor mayor que cero y vehiculo; sin cedulas
 * repetidas. Devuelve la lista o el error.
 */
export function validarUpcs(x: unknown): { upcs: UpcBeneficiario[]; error: string | null } {
  if (!Array.isArray(x)) return { upcs: [], error: "Envia la lista de UPC adicional." };
  const upcs = x.map((u: Record<string, unknown>) => ({
    cedula: String(u?.cedula ?? "").replace(/\D/g, ""),
    nombre: String(u?.nombre ?? "")
      .trim()
      .toUpperCase()
      .slice(0, 150),
    valor: c2(Number(u?.valor)),
    vehiculoId: Number(u?.vehiculoId) || 0,
  }));
  for (const [i, u] of upcs.entries()) {
    const quien = u.nombre || `el beneficiario ${i + 1}`;
    if (u.cedula.length < 5) return { upcs, error: `Escribe la cedula de ${quien}.` };
    if (!u.nombre) return { upcs, error: `Escribe el nombre del beneficiario con cedula ${u.cedula}.` };
    if (!Number.isFinite(u.valor) || u.valor <= 0) return { upcs, error: `Escribe el valor de la UPC de ${quien}.` };
    if (!u.vehiculoId) return { upcs, error: `Elige a que vehiculo va la UPC de ${quien}.` };
  }
  if (new Set(upcs.map((u) => u.cedula)).size !== upcs.length) return { upcs, error: "Hay una cedula repetida en la UPC adicional." };
  return { upcs, error: null };
}
