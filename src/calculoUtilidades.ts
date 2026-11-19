/**
 * Cascada de rentabilidad por vehiculo y reparto de utilidades por socio
 * (fase 3 del modulo de gastos), sin base de datos: se prueba en
 * calculoUtilidades.test.ts.
 *
 * Cascada de un vehiculo en un mes:
 *   1. Ingresos por fletes (lo que paga el cliente, de Rentabilidad).
 *   2. - Descuentos del viaje (retencion, ReteICA, anticipo de renta, 4x1000,
 *        Supertransporte, comision, T. Lopez, descargue, poliza, otros).
 *   3. - Costos directos: anticipos del viaje (combustible, efectivo,
 *        transferencia) y los gastos del libro que van completos a ese carro.
 *   4. - Costo total de la nomina del conductor (salario + carga del empleador).
 *   5. - Gastos generales prorrateados (lo que le toco de los gastos repartidos
 *        entre varios carros: oficina, creditos, nomina de oficina...).
 *   6. = Utilidad neta del vehiculo.
 * Los viajes van por su fecha; los gastos, por su fecha de causacion.
 *
 * Fondo de cada vehiculo (como la hoja de la SWK-973): la utilidad no se
 * reparte toda. Cada mes:
 *   saldo anterior + utilidad - liquidado al dueno por los viajes = antes de repartir
 *   disponible = antes de repartir - base (lo que se deja por si el carro se
 *   accidenta o necesita un arreglo mayor; por defecto 10.000.000)
 *   "Repartimos" = lo que se decide repartir (se sugiere el disponible)
 *   saldo final = antes de repartir - repartimos (pasa al mes siguiente; puede
 *   quedar negativo despues de un arreglo grande y se recupera con los meses).
 *
 * Reparto por socio: lo repartido y lo liquidado de cada vehiculo se dividen
 * segun la participacion, ponderada por los dias del mes (si cambia a mitad de
 * mes, cada socio pesa por los dias que la tuvo). A cada socio:
 *   + su parte de lo repartido - el 4 x 1000 de esa parte (lo que cuesta transferirla)
 *   + su parte de lo liquidado por los viajes - la liquidacion que el recibio
 *     (el dueno del vehiculo en Flota; asi en una sociedad el que recibio la
 *     plata de los viajes le queda debiendo al otro socio)
 *   - sus gastos propios del libro
 *   = neto del mes (si es negativo, lo debe; se acumula para el mes siguiente).
 *
 * Gastos de la empresa: los que van a la empresa (no a un carro ni a un
 * socio) bajan la rentabilidad de la empresa, que no se reparte.
 *
 * Todo en pesos con dos decimales; las partes se reparten en centavos para que
 * sumen exacto (ver prorrateo.ts).
 */
import { aCentavos, aPesos, repartir } from "./prorrateo";

/** Los valores de un viaje que usa la cascada (salen de Rentabilidad). */
export interface ViajeCascada {
  id: number;
  vehiculoId: number;
  fecha: string;
  manifiesto: string | null;
  cliente: string;
  flete: number;
  retencion: number;
  reteIca: number;
  anticipoRenta: number;
  bancaria: number;
  supertransporte: number;
  comision: number;
  tLopez: number;
  descargue: number;
  poliza: number;
  otrosDescuentos: number;
  /** Anticipos del viaje: combustible + efectivo + transferencia. */
  anticipo: number;
  /** El anticipo por partes (para mostrarlo; la cascada usa el total). */
  combustible?: number;
  efectivo?: number;
  transferencia?: number;
  /** Lo que se le liquida al dueno por el viaje. */
  saldoBeneficiario: number;
}

/** De que paso de la cascada es un gasto del libro. */
/** EMPRESA: lo asume la empresa (no va a ningun vehiculo ni socio). */
export type PasoGasto = "DIRECTO" | "CONDUCTOR" | "GENERAL" | "EMPRESA";

/** Lo que le toco a un vehiculo o a un socio de un gasto del libro en el mes. */
export interface PartidaGasto {
  gastoId: number;
  descripcion: string;
  categoria: string;
  /** Positivo: gasto; negativo: ingreso. */
  monto: number;
  vehiculoId: number | null;
  socioId: number | null;
  paso: PasoGasto;
  /** Empresa del gasto (LOPEZ o MYC). */
  empresa: string;
}

/** Los descuentos del viaje, uno por uno. */
export const DESCUENTOS = [
  ["retencion", "Retencion en la fuente + FOPAT"],
  ["reteIca", "ReteICA"],
  ["anticipoRenta", "Anticipo de renta"],
  ["bancaria", "4 x 1000 y comision bancaria"],
  ["supertransporte", "Supertransporte"],
  ["comision", "Comision"],
  ["tLopez", "T. Lopez"],
  ["descargue", "Descargue"],
  ["poliza", "Poliza RCE"],
  ["otrosDescuentos", "Otros descuentos"],
] as const;
export type ClaveDescuento = (typeof DESCUENTOS)[number][0];

/** La cascada de un vehiculo en el periodo. */
export interface Cascada {
  vehiculoId: number;
  viajes: number;
  /** 1. */
  ingresos: number;
  /** 2. Por concepto y total. */
  descuentos: Record<ClaveDescuento, number>;
  totalDescuentos: number;
  /** 3. Anticipos de los viajes + gastos directos del libro. */
  anticipos: number;
  directos: PartidaGasto[];
  totalDirectos: number;
  /** 4. */
  conductor: PartidaGasto[];
  totalConductor: number;
  /** 5. */
  generales: PartidaGasto[];
  totalGenerales: number;
  /** 6. */
  utilidad: number;
  /** Lo que se le liquido al dueno por los viajes (referencia). */
  saldoViajes: number;
}

/** Redondea a centavos. */
const c2 = (v: number) => Math.round(v * 100 + Number.EPSILON) / 100;
/** Suma a centavos. */
const sumar = (xs: number[]) => c2(xs.reduce((s, x) => s + x, 0));

/** Cascada de cada vehiculo con los viajes y las partidas del libro del periodo. */
export function cascadas(vehiculos: number[], viajes: ViajeCascada[], partidas: PartidaGasto[]): Cascada[] {
  return vehiculos.map((vehiculoId) => {
    const suyos = viajes.filter((v) => v.vehiculoId === vehiculoId);
    const descuentos = Object.fromEntries(DESCUENTOS.map(([k]) => [k, sumar(suyos.map((v) => v[k]))])) as Record<ClaveDescuento, number>;
    const deLibro = (paso: PasoGasto) => partidas.filter((p) => p.vehiculoId === vehiculoId && p.paso === paso);
    const ingresos = sumar(suyos.map((v) => v.flete));
    const totalDescuentos = sumar(Object.values(descuentos));
    const anticipos = sumar(suyos.map((v) => v.anticipo));
    const directos = deLibro("DIRECTO");
    const totalDirectos = sumar([anticipos, ...directos.map((p) => p.monto)]);
    const conductor = deLibro("CONDUCTOR");
    const totalConductor = sumar(conductor.map((p) => p.monto));
    const generales = deLibro("GENERAL");
    const totalGenerales = sumar(generales.map((p) => p.monto));
    return {
      vehiculoId,
      viajes: suyos.length,
      ingresos,
      descuentos,
      totalDescuentos,
      anticipos,
      directos,
      totalDirectos,
      conductor,
      totalConductor,
      generales,
      totalGenerales,
      utilidad: c2(ingresos - totalDescuentos - totalDirectos - totalConductor - totalGenerales),
      saldoViajes: sumar(suyos.map((v) => v.saldoBeneficiario)),
    };
  });
}

/** Participacion de un socio en un vehiculo, con vigencia. */
export interface Participacion {
  vehiculoId: number;
  socioId: number;
  /** En % (50 = 50 %). */
  porcentaje: number;
  desde: string;
  hasta: string | null;
}

/** Participaciones de un vehiculo vigentes en una fecha. */
export function participacionesEn(todas: Participacion[], vehiculoId: number, fecha: string): Participacion[] {
  return todas.filter((p) => p.vehiculoId === vehiculoId && p.desde <= fecha && (!p.hasta || p.hasta >= fecha));
}

/**
 * Participacion de cada socio en un vehiculo en un periodo, ponderada por los
 * dias: si del 1 al 15 era 100 % de A y desde el 16 50/50 con B, A pesa
 * (15 x 100 + 16 x 50) / 31. Si hay dias sin participacion, la suma queda por
 * debajo de 100 %.
 */
export function participacionPonderada(
  todas: Participacion[],
  vehiculoId: number,
  desde: string,
  hasta: string,
): Array<{ socioId: number; porcentaje: number }> {
  const suma = new Map<number, number>();
  let dias = 0;
  for (let t = Date.parse(desde); t <= Date.parse(hasta); t += 86_400_000) {
    const fecha = new Date(t).toISOString().slice(0, 10);
    dias += 1;
    for (const p of participacionesEn(todas, vehiculoId, fecha)) suma.set(p.socioId, (suma.get(p.socioId) ?? 0) + p.porcentaje);
  }
  return [...suma.entries()].map(([socioId, total]) => ({ socioId, porcentaje: Math.round((total / Math.max(1, dias)) * 10000) / 10000 }));
}

/** El fondo de un vehiculo en el mes. */
export interface FondoVehiculo {
  vehiculoId: number;
  /** Lo que se deja en el carro (no se reparte). */
  base: number;
  saldoAnterior: number;
  utilidad: number;
  /** Lo que se le pago al dueno por los viajes en el mes (sale del fondo). */
  liquidado: number;
  /** saldo anterior + utilidad - liquidado. */
  antesDeRepartir: number;
  /** antes de repartir - base. */
  disponible: number;
  /** Lo que se sugiere repartir: el disponible, si es positivo (en pesos enteros). */
  sugerido: number;
  /** Lo que se reparte. */
  repartimos: number;
  /** antes de repartir - repartimos: pasa al mes siguiente. */
  saldoFinal: number;
}

/** Lo que le toca a un socio en el mes. */
export interface RepartoSocio {
  socioId: number;
  porVehiculo: Array<{ vehiculoId: number; porcentaje: number; repartido: number; liquidado: number; recibido: number }>;
  /** Su parte de lo que se repartio. */
  repartido: number;
  /** El 4 x 1000 de lo que se le reparte (transferirlo). */
  gmf: number;
  /** Su parte de lo liquidado por los viajes. */
  liquidado: number;
  /** La liquidacion de viajes que el recibio (dueno del vehiculo en Flota). */
  recibido: number;
  /** Lo que va directo a el en el libro (positivo = gasto, negativo = ingreso). */
  gastosPropios: PartidaGasto[];
  totalGastosPropios: number;
  /** repartido - gmf + liquidado - recibido - gastos propios: lo que se le debe del mes (negativo = lo que debe el). */
  neto: number;
}

/**
 * El fondo de cada vehiculo y el reparto por socio del mes. `repartimos`
 * trae lo que se decidio repartir de cada vehiculo; si falta uno, se usa el
 * sugerido. Los vehiculos que reparten o liquidan algo sin participacion que
 * sume 100 % quedan en `sinParticipacion`.
 */
export function repartoMes(e: {
  lista: Cascada[];
  fondos: Map<number, { base: number; saldoAnterior: number }>;
  liquidado: Map<number, number>;
  repartimos: Map<number, number>;
  participaciones: Participacion[];
  partidas: PartidaGasto[];
  desde: string;
  hasta: string;
  /** Vehiculo -> socio que recibe la liquidacion de sus viajes (el dueno en Flota). */
  receptor: Map<number, number>;
  /** 4 x 1000: el gravamen sobre lo que se transfiere al repartir. */
  gmfPorMil: number;
}): { fondos: FondoVehiculo[]; socios: RepartoSocio[]; sinParticipacion: number[] } {
  const socios = new Map<number, RepartoSocio>();
  const de = (socioId: number) => {
    let x = socios.get(socioId);
    if (!x) {
      x = { socioId, porVehiculo: [], repartido: 0, gmf: 0, liquidado: 0, recibido: 0, gastosPropios: [], totalGastosPropios: 0, neto: 0 };
      socios.set(socioId, x);
    }
    return x;
  };
  const sinParticipacion: number[] = [];
  const fondos = e.lista.map((c): FondoVehiculo => {
    const f = e.fondos.get(c.vehiculoId) ?? { base: 0, saldoAnterior: 0 };
    const liquidado = c2(e.liquidado.get(c.vehiculoId) ?? 0);
    const antesDeRepartir = c2(f.saldoAnterior + c.utilidad - liquidado);
    const disponible = c2(antesDeRepartir - f.base);
    const sugerido = Math.max(0, Math.floor(disponible));
    const repartimos = c2(e.repartimos.get(c.vehiculoId) ?? sugerido);
    return {
      vehiculoId: c.vehiculoId,
      base: f.base,
      saldoAnterior: f.saldoAnterior,
      utilidad: c.utilidad,
      liquidado,
      antesDeRepartir,
      disponible,
      sugerido,
      repartimos,
      saldoFinal: c2(antesDeRepartir - repartimos),
    };
  });
  for (const f of fondos) {
    if (f.repartimos === 0 && f.liquidado === 0) continue;
    const ps = participacionPonderada(e.participaciones, f.vehiculoId, e.desde, e.hasta);
    if (!ps.length || Math.abs(ps.reduce((t, p) => t + p.porcentaje, 0) - 100) > 0.01) {
      sinParticipacion.push(f.vehiculoId);
      continue;
    }
    const pesos = ps.map((p) => p.porcentaje);
    const repartidos = repartir(aCentavos(f.repartimos), pesos);
    const liquidados = repartir(aCentavos(f.liquidado), pesos);
    // Quien recibio la liquidacion: el dueno en Flota; si no hay, cada socio su parte.
    const dueno = e.receptor.get(f.vehiculoId);
    const recibidos = dueno ? ps.map((p) => (p.socioId === dueno ? aCentavos(f.liquidado) : 0)) : liquidados;
    ps.forEach((p, i) =>
      de(p.socioId).porVehiculo.push({
        vehiculoId: f.vehiculoId,
        porcentaje: p.porcentaje,
        repartido: aPesos(repartidos[i]),
        liquidado: aPesos(liquidados[i]),
        recibido: aPesos(recibidos[i]),
      }),
    );
    // El dueno que recibio la liquidacion pero no tiene participacion en el carro.
    if (dueno && !ps.some((p) => p.socioId === dueno) && f.liquidado !== 0)
      de(dueno).porVehiculo.push({ vehiculoId: f.vehiculoId, porcentaje: 0, repartido: 0, liquidado: 0, recibido: f.liquidado });
  }
  for (const p of e.partidas.filter((x) => x.socioId !== null)) de(p.socioId!).gastosPropios.push(p);
  for (const x of socios.values()) {
    x.repartido = sumar(x.porVehiculo.map((v) => v.repartido));
    x.gmf = sumar(x.porVehiculo.map((v) => Math.round((Math.max(0, v.repartido) * e.gmfPorMil) / 1000)));
    x.liquidado = sumar(x.porVehiculo.map((v) => v.liquidado));
    x.recibido = sumar(x.porVehiculo.map((v) => v.recibido));
    x.totalGastosPropios = sumar(x.gastosPropios.map((g) => g.monto));
    x.neto = c2(x.repartido - x.gmf + x.liquidado - x.recibido - x.totalGastosPropios);
  }
  return { fondos, socios: [...socios.values()], sinParticipacion };
}

/** Un mes en la cuenta de un socio. */
export interface MesCuenta {
  mes: string;
  saldoAnterior: number;
  /** Neto del reparto aprobado del mes (0 si el mes no tiene reparto). */
  neto: number;
  /** Pagos hechos al socio en el mes (negativo = lo que el devolvio). */
  pagos: number;
  /** saldo anterior + neto - pagos: lo que se le debe (negativo = lo que debe el). Pasa al mes siguiente. */
  saldo: number;
}

/**
 * La cuenta de un socio mes a mes: arranca en su saldo inicial, suma el neto
 * de cada reparto aprobado y resta los pagos. Un saldo negativo (no le
 * alcanzo para sus gastos) se arrastra al mes siguiente.
 */
export function cuentaSocio(saldoInicial: number, netos: Map<string, number>, pagos: Array<{ fecha: string; monto: number }>): MesCuenta[] {
  const pagosMes = new Map<string, number>();
  for (const p of pagos) pagosMes.set(p.fecha.slice(0, 7), c2((pagosMes.get(p.fecha.slice(0, 7)) ?? 0) + p.monto));
  const meses = [...new Set([...netos.keys(), ...pagosMes.keys()])].sort();
  let saldo = c2(saldoInicial);
  return meses.map((mes) => {
    const saldoAnterior = saldo;
    const neto = netos.get(mes) ?? 0;
    const pagado = pagosMes.get(mes) ?? 0;
    saldo = c2(saldoAnterior + neto - pagado);
    return { mes, saldoAnterior, neto, pagos: pagado, saldo };
  });
}

/**
 * Paso de la cascada de una partida del libro: la parte que va a la empresa
 * es de la empresa; la nomina de un conductor va al paso 4; un gasto que va completo a un solo vehiculo (sin socios) es costo
 * directo (paso 3); lo repartido entre varios es gasto general (paso 5).
 */
export function pasoDe(g: { esNominaConductor: boolean; destinosVehiculo: number; destinosSocio: number; aLaEmpresa?: boolean }): PasoGasto {
  if (g.aLaEmpresa) return "EMPRESA";
  if (g.esNominaConductor) return "CONDUCTOR";
  if (g.destinosVehiculo === 1 && g.destinosSocio === 0) return "DIRECTO";
  return "GENERAL";
}

/** Ultimo dia de un mes "AAAA-MM". */
export function finDeMes(mes: string): string {
  const [a, m] = mes.split("-").map(Number);
  return `${mes}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, "0")}`;
}
