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
 * - Auxilio de transporte: si el empleado lo tiene y gana hasta 2 minimos.
 * - Aportes (salud y pension del empleado; pension, salud, ARL y caja del
 *   empleador) se redondean hacia arriba a la centena, como la PILA.
 * - Prima y cesantias sobre salarial + auxilio; intereses = 12 % de las
 *   cesantias; vacaciones sobre el salarial. Se provisionan (no se redondean).
 * - Ajuste: una diferencia manual con nota (lo que en el Excel eran los
 *   "-15200" sueltos). Suma al costo del empleador.
 * - Costo total = lo que se le paga al empleado (devengado) + costo del
 *   empleador. Eso es lo que va a la rentabilidad.
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
  producido: number;
  ajuste: number;
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
  ajuste: number;
  /** Aportes + provisiones + ajuste. */
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

/** Calcula una linea de nomina. */
export function calcularLinea(e: EntradaLinea, p: ParametrosNomina): CalculoLinea {
  const dias = Math.max(0, Math.min(30, e.dias));
  const mensual = (e.salarioBase ?? p.smmlv) + e.salarioAdicional;
  const basico = c2((mensual * dias) / 30);
  const variable = pct(e.producido, e.pctSalarial);
  const viaticos = pct(e.producido, e.pctViaticos);
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
  const costoEmpleador = c2(pensionEmpleador + saludEmpleador + arl + caja + prima + cesantias + interesesCesantias + vacaciones + ajuste);
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
    ajuste,
    costoEmpleador,
    costoTotal: c2(devengado + costoEmpleador),
  };
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
  total: number;
  porVehiculo: Array<{ vehiculoId: number; producido: number; viajes: number; sinTarifa: number }>;
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
    const p = resultado.get(a.empleadoId) ?? { total: 0, porVehiculo: [], viajes: [] };
    let pv = p.porVehiculo.find((x) => x.vehiculoId === v.vehiculoId);
    if (!pv) {
      pv = { vehiculoId: v.vehiculoId, producido: 0, viajes: 0, sinTarifa: 0 };
      p.porVehiculo.push(pv);
    }
    pv.viajes += 1;
    if (v.flete === null) pv.sinTarifa += 1;
    else {
      pv.producido = c2(pv.producido + v.flete);
      p.total = c2(p.total + v.flete);
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
