/**
 * Modulo Cuentas vehiculos: matriz de fletes conductor, cuentas de viaje, prestamos
 * y liquidacion de los conductores (el calculo esta en calculoConductores.ts).
 * Solo lo ven el rol total y M&C; M&C solo los vehiculos de su flota y los
 * marcados para todos (vehiculos.visibleTodos, como el XGJ-197, al que le
 * hacen cuentas todos los socios), con el conductor que los maneja.
 *
 * - Matriz de fletes conductor: un valor por tarifa de la matriz de fletes de
 *   la empresa (la misma tarifa con que se cobra el viaje), por tonelada,
 *   fijo o integro (fijo que se le paga completo, sin %), con su vigencia. Se
 *   ve solo en este modulo.
 * - Producido conductor de cada viaje de la flota propia: el de la matriz, o
 *   el escrito a mano en su cuenta de viaje. Es lo que la nomina usa como
 *   producido del conductor (4 % salarial y 5 % de viaticos).
 * - Cuenta de viaje: la hoja de gastos del conductor. El ACPM sale del
 *   combustible de los anticipos del viaje (se puede corregir). Al guardarla,
 *   sus gastos quedan en el libro de gastos como un gasto del vehiculo
 *   (categoria VEHICULO, origen CUENTA_VIAJE) en la fecha del viaje; en
 *   Utilidades ese viaje cuenta lo gastado y no el anticipo.
 * - Prestamos: monto, cuota sugerida y lo descontado cada mes (se decide mes
 *   a mes; se ve y se cambia igual aqui y en la nomina).
 * - Liquidacion del mes: neto de la nomina + saldo de las cuentas de viaje -
 *   prestamos descontados. Se marca pagada con su fecha.
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "./db";
import { dia, ErrorCuadro, hoyColombia, mapear, SELECT_CUADRO } from "./cuadro";
import { cargarTarifas, clienteSoloUrbano, deducirConMatriz } from "./tarifasFlete";
import {
  mesConductores,
  mesesDelViaje,
  periodoConductores,
  problemaAlMover,
  CONCEPTOS,
  esIntegro,
  liquidarConductor,
  nombreComparable,
  producidoConductor,
  saldoCuenta,
  saldoPrestamo,
  tarifaConductorDeducida,
  tipoFleteConductor,
  totalGastos,
} from "./calculoConductores";
import type { Concepto, FleteConductor, TipoFleteConductor, GastosCuenta, LiquidacionConductor, NominaConductor } from "./calculoConductores";
import { finDeMes } from "./calculoUtilidades";
import { conductorDelViaje, nombreNormal, reconocerConductor } from "./calculoNomina";
import type { EmpleadoIdentidad } from "./calculoNomina";
import { gastos } from "./gastos";
import { mesesCongeladosConductores } from "./proteccion";
import { mesesTocados } from "./proteccionMeses";
import type { EmpresaVehiculo } from "./roles";

/** Centavos exactos. */
const c2 = (v: number) => Math.round(v * 100 + Number.EPSILON) / 100;
/** Numero de la base (null si no hay). */
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Mes "AAAA-MM" valido. */
function mesDe(v: unknown): string {
  const m = String(v ?? "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new ErrorCuadro("Elige el mes.");
  return m;
}

/** Valor en pesos >= 0 (vacio = null). */
function pesos(v: unknown, campo: string): number | null {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ErrorCuadro(`Revisa ${campo}.`);
  return c2(n);
}

/** Una tarifa de la matriz de la empresa con su flete conductor (vigente e historial). */
export interface TarifaConductor {
  tarifaFleteId: number;
  nombre: string;
  razonSocial: string | null;
  valorEmpresa: number | null;
  tipoEmpresa: string;
  vigente: { id: number; valor: number; tipo: TipoFleteConductor; desde: string } | null;
  historial: Array<{ id: number; valor: number; tipo: TipoFleteConductor; desde: string }>;
  /** Viajes de los ultimos 90 dias con esta tarifa (para saber cuales importan). */
  viajesRecientes: number;
}

/** Un viaje de la flota propia con su producido conductor y su cuenta de viaje. */
export interface ViajeConductor {
  cuadroViajeId: number;
  fecha: string;
  placa: string;
  vehiculoId: number | null;
  empresaVehiculo: EmpresaVehiculo;
  cliente: string;
  manifiesto: string | null;
  remision: string | null;
  remisionUrl: string | null;
  facturaUrl: string | null;
  pesoKg: number | null;
  tarifaFleteId: number | null;
  tarifa: string | null;
  /** true: el viaje no tiene tarifa en el Cuadro y la del flete conductor es la deducida (ver tarifaConductorDeducida). */
  tarifaDeducida: boolean;
  /** Mes de las cuentas de los conductores en que cuenta (el de su fecha, o al que se paso). */
  mesConductor: string;
  /** El mes al que se paso a mano (null si cuenta en el de su fecha). */
  mesMovido: string | null;
  notaMovido: string | null;
  /**
   * Empleado al que se le cuenta: quien manejo el viaje (Cuadro o manifiesto)
   * o, si no esta en Nomina, el asignado al vehiculo (null = de nadie).
   */
  empleadoId: number | null;
  conductor: string | null;
  /** Como se reconocio: por quien manejo o por la asignacion del vehiculo. */
  conductorPor: "conductor" | "vehiculo" | null;
  /** Quien manejo segun el viaje (puede no ser empleado). */
  conductorViaje: string | null;
  /** Por que no tiene conductor (null si tiene). */
  motivoSinConductor: string | null;
  /** Producido conductor: de la matriz o escrito a mano (null = sin valor). */
  producido: number | null;
  producidoMatriz: number | null;
  producidoManual: boolean;
  /** Flete conductor INTEGRO: se le paga completo (no va al %). */
  integro: boolean;
  /** Lo que recibio: anticipos de la bomba (efectivo + combustible), transferencia del Cuadro pagos y las del gerente. */
  efectivo: number;
  combustible: number;
  transferencia: number;
  /** Transferencias del gerente para completar el anticipo (no van al Cuadro pagos). */
  transferenciasGerente: Array<{ id: number; fecha: string; valor: number; nota: string | null }>;
  recibido: number;
  /** La cuenta de viaje (null = aun no se ha llenado). */
  cuenta:
    | (GastosCuenta & {
        id: number;
        acpmManual: boolean;
        otrosConcepto: string | null;
        nota: string | null;
        total: number;
        saldo: number;
        gastoId: number | null;
      })
    | null;
}

/** Un prestamo a un empleado con su saldo y lo descontado por mes. */
export interface Prestamo {
  id: number;
  empleadoId: number;
  empleado: string;
  empresa: EmpresaVehiculo;
  fecha: string;
  monto: number;
  cuota: number | null;
  nota: string | null;
  descuentos: Array<{ mes: string; valor: number }>;
  saldo: number;
}

/** La liquidacion de un conductor en un mes. */
export interface LiquidacionMesConductor extends LiquidacionConductor {
  empleadoId: number;
  nombre: string;
  empresa: EmpresaVehiculo;
  pctSalarial: number;
  pctViaticos: number;
  /**
   * Lo de la nomina que cubre el producido del mes. Si aun no hay nomina, el
   * calculo provisional (provisional: true, nominaId null): la liquidacion no
   * espera la nomina. null solo si faltan los parametros de nomina del ano.
   */
  nomina:
    | (NominaConductor & {
        nominaId: number | null;
        provisional: boolean;
        estado: string;
        desde: string;
        hasta: string;
        basico: number;
        auxilio: number;
        salud: number;
        pension: number;
      })
    | null;
  /** Prestamos con saldo o con descuento este mes. */
  prestamosDetalle: Array<{ prestamoId: number; fecha: string; monto: number; saldo: number; cuota: number | null; descuento: number | null }>;
  pagada: { fechaPago: string; total: number } | null;
  /** true: es la foto guardada al pagar (no se recalcula). */
  congelada?: boolean;
}

/** Los viajes de la flota propia (no anulados, sin reconocidos) entre dos fechas, con su cuenta. */
async function viajesEntre(desde: string, hasta: string, empresa: EmpresaVehiculo | null): Promise<ViajeConductor[]> {
  const [filas] = await pool.query<RowDataPacket[]>(
    `SELECT c.id, c.fecha, c.placa, COALESCE(c.vehiculoId, v.id) AS vehiculoId, v.empresa AS empresaVehiculo, c.empresa AS cliente,
            c.manifiesto, c.remision, c.remisionUrl, c.facturaUrl, COALESCE(c.pesoKg, 0) AS pesoKg, c.tarifaFleteId, tf.nombre AS tarifa,
            COALESCE(c.anticipoTransferencia, 0) AS transferencia,
            (SELECT COALESCE(SUM(a.efectivo), 0) FROM cuadro_anticipos a WHERE a.cuadroViajeId = c.id) AS efectivo,
            (SELECT COALESCE(SUM(a.combustible), 0) FROM cuadro_anticipos a WHERE a.cuadroViajeId = c.id) AS combustible,
            cv.id AS cuentaId, cv.producidoManual, cv.acpm, cv.peajes, cv.cargue, cv.descargue, cv.parqueo, cv.llantas, cv.lavada, cv.comision,
            cv.engrase, cv.propinas, cv.arreglos, cv.accesorios, cv.otros, cv.otrosConcepto, cv.nota, cv.gastoId,
            vm.mes AS mesMovido, vm.nota AS notaMovido,
            c.conductor AS conductorCuadro, c.conductorManifiesto, vj.conductorId AS conductorRndcId, co.cedula AS conductorCedula, co.nombre AS conductorNombre
       FROM cuadro_viajes c
       JOIN vehiculos v ON v.id = COALESCE(c.vehiculoId, (SELECT x.id FROM vehiculos x WHERE x.placa = c.placa AND x.eliminado = 0 LIMIT 1))
       LEFT JOIN tarifas_flete tf ON tf.id = c.tarifaFleteId
       LEFT JOIN cuentas_viaje cv ON cv.cuadroViajeId = c.id
       LEFT JOIN viajes vj ON vj.id = c.viajeId
       LEFT JOIN conductores co ON co.id = vj.conductorId
       LEFT JOIN viajes_mes_conductor vm ON vm.cuadroViajeId = c.id
      WHERE c.anulado = 0 AND c.reconocidoDeViajeId IS NULL AND c.fecha BETWEEN ? AND ?
        AND v.empresa IS NOT NULL ${empresa ? "AND (v.empresa = ? OR v.visibleTodos = 1)" : ""}
      ORDER BY c.fecha, c.placa, c.id`,
    empresa ? [desde, hasta, empresa] : [desde, hasta],
  );
  const fletes = await fletesConductor();
  // Los viajes sin tarifa en el Cuadro: la tarifa que se deduce para su flete conductor.
  const deducidas = await tarifasDeducidas(
    filas.filter((f) => !f.tarifaFleteId).map((f) => f.id),
    fletes,
  );
  // Transferencias del gerente de esos viajes.
  const ids = filas.map((f) => f.id);
  const [trs] = ids.length
    ? await pool.query<RowDataPacket[]>(
        "SELECT id, cuadroViajeId, fecha, valor, nota FROM transferencias_conductor WHERE cuadroViajeId IN (?) ORDER BY fecha, id",
        [ids],
      )
    : [[] as RowDataPacket[]];
  const [asig] = await pool.query<RowDataPacket[]>(`SELECT empleadoId, vehiculoId, desde, hasta FROM empleados_vehiculos`);
  const asignaciones = asig.map((x) => ({ empleadoId: x.empleadoId as number, vehiculoId: x.vehiculoId as number, desde: dia(x.desde)!, hasta: dia(x.hasta) }));
  const [emps] = await pool.query<RowDataPacket[]>("SELECT id, nombre, cedula, conductorId, fechaIngreso, fechaRetiro FROM empleados WHERE tipo = 'CONDUCTOR'");
  const empleados: EmpleadoIdentidad[] = emps.map((e) => ({
    id: e.id,
    nombre: e.nombre,
    cedula: e.cedula ?? null,
    conductorId: e.conductorId ?? null,
    fechaIngreso: dia(e.fechaIngreso)!,
    fechaRetiro: dia(e.fechaRetiro),
  }));
  const nombreEmpleado = new Map(empleados.map((e) => [e.id, e.nombre]));
  // Conductores del RNDC por nombre (solo los nombres sin repetir), para los cambiados a mano en el Cuadro.
  const [cats] = await pool.query<RowDataPacket[]>("SELECT id, nombre, cedula FROM conductores");
  const repetidos = new Set<string>();
  const catalogo = new Map<string, { id: number; cedula: string | null }>();
  for (const c of cats) {
    const k = nombreNormal(c.nombre);
    if (catalogo.has(k)) repetidos.add(k);
    catalogo.set(k, { id: c.id, cedula: c.cedula ?? null });
  }
  for (const k of repetidos) catalogo.delete(k);
  return filas.map((f) => {
    const fecha = dia(f.fecha)!;
    // A quien se le cuenta: quien lo manejo y, si no esta en Nomina, el asignado al vehiculo (como en la nomina).
    const manejo = conductorDelViaje(
      {
        cuadro: f.conductorCuadro ?? null,
        manifiesto: f.conductorManifiesto ?? null,
        conductorId: f.conductorRndcId ?? null,
        cedula: f.conductorCedula ?? null,
        nombre: f.conductorNombre ?? null,
      },
      catalogo,
    );
    const r = reconocerConductor({ vehiculoId: f.vehiculoId, fecha, conductor: manejo }, empleados, asignaciones);
    const deducida = f.tarifaFleteId ? null : (deducidas.get(f.id) ?? null);
    const viaje = { fecha, tarifaFleteId: f.tarifaFleteId ?? deducida?.id ?? null, pesoKg: Number(f.pesoKg) || null };
    const matriz = producidoConductor(viaje, fletes);
    const manual = num(f.producidoManual);
    const efectivo = Number(f.efectivo);
    const combustible = Number(f.combustible);
    const transferencia = Number(f.transferencia);
    const transferenciasGerente = trs
      .filter((t) => t.cuadroViajeId === f.id)
      .map((t) => ({ id: t.id, fecha: dia(t.fecha)!, valor: Number(t.valor), nota: t.nota ?? null }));
    const recibido = c2(efectivo + combustible + transferencia + transferenciasGerente.reduce((s, t) => s + t.valor, 0));
    let cuenta: ViajeConductor["cuenta"] = null;
    if (f.cuentaId) {
      const g = Object.fromEntries(CONCEPTOS.map(([k]) => [k, Number(f[k] ?? 0)])) as GastosCuenta;
      // ACPM vacio = el combustible de los anticipos del viaje.
      const acpmManual = f.acpm !== null;
      g.acpm = acpmManual ? Number(f.acpm) : combustible;
      const total = totalGastos(g);
      cuenta = {
        ...g,
        id: f.cuentaId,
        acpmManual,
        otrosConcepto: f.otrosConcepto ?? null,
        nota: f.nota ?? null,
        total,
        saldo: saldoCuenta(total, recibido),
        gastoId: f.gastoId ?? null,
      };
    }
    return {
      cuadroViajeId: f.id,
      fecha,
      placa: f.placa,
      vehiculoId: f.vehiculoId ?? null,
      empresaVehiculo: f.empresaVehiculo,
      cliente: f.cliente,
      manifiesto: f.manifiesto ?? null,
      remision: f.remision ?? null,
      remisionUrl: f.remisionUrl ?? null,
      facturaUrl: f.facturaUrl ?? null,
      pesoKg: num(f.pesoKg),
      tarifaFleteId: f.tarifaFleteId ?? deducida?.id ?? null,
      tarifa: f.tarifa ?? deducida?.nombre ?? null,
      tarifaDeducida: !!deducida,
      mesConductor: f.mesMovido ?? mesConductores(fecha),
      mesMovido: f.mesMovido && f.mesMovido !== mesConductores(fecha) ? f.mesMovido : null,
      notaMovido: f.mesMovido ? (f.notaMovido ?? null) : null,
      empleadoId: r.empleadoId,
      conductor: r.empleadoId ? (nombreEmpleado.get(r.empleadoId) ?? null) : null,
      conductorPor: r.por,
      conductorViaje: manejo?.nombre ?? manejo?.cedula ?? null,
      motivoSinConductor: r.motivo,
      producido: manual ?? matriz,
      producidoMatriz: matriz,
      producidoManual: manual !== null,
      integro: esIntegro(viaje, fletes),
      efectivo,
      combustible,
      transferencia,
      transferenciasGerente,
      recibido,
      cuenta,
    };
  });
}

/**
 * Tarifa del flete conductor de los viajes que no tienen tarifa en el Cuadro
 * (flete del Excel o sin elegir entre varias): la que deduce el Cuadro con su
 * cliente, ruta, configuracion y producto (ver tarifaConductorDeducida).
 */
async function tarifasDeducidas(ids: number[], fletes: FleteConductor[]): Promise<Map<number, { id: number; nombre: string }>> {
  const r = new Map<number, { id: number; nombre: string }>();
  if (!ids.length) return r;
  const [filas] = await pool.query<RowDataPacket[]>(`${SELECT_CUADRO} WHERE c.id IN (?)`, [ids]);
  const tarifas = await cargarTarifas();
  const nombre = new Map(tarifas.map((t) => [t.id, t.nombre]));
  for (const fila of filas.map(mapear)) {
    const urbano = fila.urbano || clienteSoloUrbano(fila.empresa, tarifas);
    const d = await deducirConMatriz({ empresa: fila.empresa, ruta: fila.ruta, urbano, configuracion: fila.configuracion, producto: fila.producto });
    const id = tarifaConductorDeducida(
      fila.fecha,
      d.exacta?.id ?? null,
      d.posibles.map((p) => p.id),
      fletes,
    );
    if (id) r.set(fila.id, { id, nombre: nombre.get(id) ?? "" });
  }
  return r;
}

/** Toda la matriz de fletes conductor. */
async function fletesConductor(): Promise<FleteConductor[]> {
  const [filas] = await pool.query<RowDataPacket[]>("SELECT tarifaFleteId, valor, tipo, desde FROM fletes_conductor");
  return filas.map((f) => ({ tarifaFleteId: f.tarifaFleteId, valor: Number(f.valor), tipo: tipoFleteConductor(f.tipo), desde: dia(f.desde)! }));
}

/**
 * Un valor de la matriz de fletes conductor desde `desde` (nuevo, corregido o
 * borrado) no puede cambiar el producido de viajes de meses congelados
 * (cerrados, con nomina aprobada o liquidacion pagada). Llenar un tramo que no
 * tenia valor si se deja (no cambia nada ya calculado con la matriz).
 */
async function exigirFleteLibre(tarifaFleteId: number, desde: string, accion: "nuevo" | "borrar"): Promise<void> {
  const [filas] = await pool.query<RowDataPacket[]>("SELECT desde FROM fletes_conductor WHERE tarifaFleteId = ? ORDER BY desde", [tarifaFleteId]);
  const fechas = filas.map((f) => dia(f.desde)!);
  const existe = fechas.includes(desde);
  // Hasta donde rige: el siguiente valor de la tarifa.
  const hasta = fechas.find((f) => f > desde) ?? null;
  // Un valor nuevo solo cambia viajes que ya tenian valor (los que caen despues de un valor anterior).
  const anterior = fechas.filter((f) => f < desde).pop() ?? null;
  if (accion === "nuevo" && !existe && !anterior) return;
  const [viajes] = await pool.query<RowDataPacket[]>(
    "SELECT DISTINCT fecha FROM cuadro_viajes WHERE tarifaFleteId = ? AND anulado = 0 AND fecha >= ? AND (? IS NULL OR fecha < ?)",
    [tarifaFleteId, desde, hasta, hasta],
  );
  const tocados = mesesTocados(
    viajes.map((v) => dia(v.fecha)!),
    desde,
    hasta,
    await mesesCongeladosConductores(),
  );
  if (!tocados.length) return;
  const ultimo = tocados[tocados.length - 1];
  const [a, m] = ultimo.split("-").map(Number);
  const libre = m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, "0")}-01`;
  throw new ErrorCuadro(
    `Ese cambio tocaria viajes de ${tocados.join(", ")}, que ya estan cerrados o con nomina aprobada o liquidacion pagada. Pon el valor nuevo desde el ${libre
      .split("-")
      .reverse()
      .join("/")} (los meses anteriores conservan el suyo).`,
  );
}

/** Un viaje de la flota propia (de la empresa, si se da), o error. */
async function viajeDeFlota(cuadroViajeId: number, empresa: EmpresaVehiculo | null): Promise<ViajeConductor> {
  const [[c]] = await pool.query<RowDataPacket[]>("SELECT fecha FROM cuadro_viajes WHERE id = ? AND anulado = 0", [cuadroViajeId]);
  if (!c) throw new ErrorCuadro("Ese viaje no existe en el cuadro.");
  const fecha = dia(c.fecha)!;
  const viaje = (await viajesEntre(fecha, fecha, empresa)).find((v) => v.cuadroViajeId === cuadroViajeId);
  if (!viaje) throw new ErrorCuadro("Ese viaje no es de la flota propia (o no es de tu empresa).");
  return viaje;
}

/** La liquidacion de ese conductor en ese mes no esta pagada (si lo esta, hay que quitar el pago para cambiar algo). */
async function exigirSinPagar(empleadoId: number | null, mes: string, que: string): Promise<void> {
  if (!empleadoId) return;
  const [[p]] = await pool.query<RowDataPacket[]>("SELECT fechaPago FROM liquidaciones_conductor WHERE empleadoId = ? AND mes = ?", [empleadoId, mes]);
  if (p) throw new ErrorCuadro(`La liquidacion de ${mes} de este conductor ya esta pagada: quita la marca de pagada para cambiar ${que}.`);
}

/** El producido conductor de un viaje que cae en una nomina aprobada no se cambia (reabre la nomina primero). */
async function exigirSinNominaAprobada(fecha: string): Promise<void> {
  const [[n]] = await pool.query<RowDataPacket[]>(
    "SELECT 1 AS si FROM nominas WHERE estado = 'APROBADA' AND ? BETWEEN COALESCE(producidoDesde, desde) AND COALESCE(producidoHasta, hasta) LIMIT 1",
    [fecha],
  );
  if (n) throw new ErrorCuadro("La nomina que cubre el producido de ese viaje esta aprobada: reabrela en Nomina para cambiar el producido conductor.");
}

/**
 * Mes de las cuentas de los conductores que cubre una nomina: el de su
 * producidoHasta (sirve con el producido del mes calendario o con el corte
 * del 27 al 26).
 */
const mesProducido = (n: { producidoHasta: string }) => n.producidoHasta.slice(0, 7);

/** Repositorio del modulo Cuentas vehiculos. */
export const conductores = {
  /** La matriz: cada tarifa de la empresa con su flete conductor vigente y su historial. */
  async fletes(): Promise<TarifaConductor[]> {
    const [tarifas] = await pool.query<RowDataPacket[]>(
      `SELECT t.id, t.nombre, t.razonSocial, t.valor, t.tipo,
              (SELECT COUNT(*) FROM cuadro_viajes c WHERE c.tarifaFleteId = t.id AND c.anulado = 0 AND c.fecha >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)) AS recientes
         FROM tarifas_flete t
        WHERE t.retirada = 0 OR EXISTS (SELECT 1 FROM fletes_conductor f WHERE f.tarifaFleteId = t.id)
        ORDER BY t.nombre`,
    );
    const [fletes] = await pool.query<RowDataPacket[]>("SELECT id, tarifaFleteId, valor, tipo, desde FROM fletes_conductor ORDER BY desde DESC");
    const hoy = new Date().toISOString().slice(0, 10);
    return tarifas.map((t) => {
      const historial = fletes
        .filter((f) => f.tarifaFleteId === t.id)
        .map((f) => ({ id: f.id as number, valor: Number(f.valor), tipo: tipoFleteConductor(f.tipo), desde: dia(f.desde)! }));
      return {
        tarifaFleteId: t.id,
        nombre: t.nombre,
        razonSocial: t.razonSocial ?? null,
        valorEmpresa: num(t.valor),
        tipoEmpresa: t.tipo,
        vigente: historial.find((h) => h.desde <= hoy) ?? null,
        historial,
        viajesRecientes: Number(t.recientes),
      };
    });
  },

  /**
   * Viajes de la flota propia de los ultimos `dias` que no tienen tarifa (ni en
   * el Cuadro ni deducida): no salen en la matriz y no tienen producido
   * conductor. Por cliente, con cuantos son, sus placas y el ultimo.
   */
  async viajesSinTarifa(dias = 90): Promise<Array<{ cliente: string; viajes: number; placas: string[]; ultimo: string; ids: number[] }>> {
    const hasta = hoyColombia();
    const desde = new Date(Date.parse(hasta) - dias * 86_400_000).toISOString().slice(0, 10);
    const r = new Map<string, { cliente: string; viajes: number; placas: string[]; ultimo: string; ids: number[] }>();
    for (const v of await viajesEntre(desde, hasta, null)) {
      if (v.tarifaFleteId || v.producidoManual) continue;
      const x = r.get(v.cliente) ?? { cliente: v.cliente, viajes: 0, placas: [], ultimo: v.fecha, ids: [] };
      x.viajes += 1;
      if (!x.placas.includes(v.placa)) x.placas.push(v.placa);
      if (v.fecha > x.ultimo) x.ultimo = v.fecha;
      x.ids.push(v.cuadroViajeId);
      r.set(v.cliente, x);
    }
    return [...r.values()].sort((a, b) => b.viajes - a.viajes);
  },

  /** Guarda el flete conductor de una tarifa desde una fecha ({ tarifaFleteId, valor, tipo TON/FIJO/INTEGRO, desde }). */
  async guardarFlete(d: Record<string, unknown>, usuarioId: number | null): Promise<void> {
    const tarifaFleteId = Number(d.tarifaFleteId);
    const [[t]] = await pool.query<RowDataPacket[]>("SELECT id FROM tarifas_flete WHERE id = ?", [tarifaFleteId]);
    if (!t) throw new ErrorCuadro("Esa tarifa no existe.");
    const valor = pesos(d.valor, "el valor");
    if (!valor || valor <= 0) throw new ErrorCuadro("Escribe el flete del conductor (mayor que cero).");
    const desde = String(d.desde ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) throw new ErrorCuadro("Escribe desde cuando aplica.");
    await exigirFleteLibre(tarifaFleteId, desde, "nuevo");
    await pool.query(
      `INSERT INTO fletes_conductor (tarifaFleteId, valor, tipo, desde, creadoPorId) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE valor = VALUES(valor), tipo = VALUES(tipo)`,
      [tarifaFleteId, valor, tipoFleteConductor(d.tipo), desde, usuarioId],
    );
  },

  /** Borra un valor de la matriz (no si cambiaria meses congelados). */
  async borrarFlete(id: number): Promise<void> {
    const [[f]] = await pool.query<RowDataPacket[]>("SELECT tarifaFleteId, desde FROM fletes_conductor WHERE id = ?", [id]);
    if (!f) return;
    await exigirFleteLibre(f.tarifaFleteId, dia(f.desde)!, "borrar");
    await pool.query("DELETE FROM fletes_conductor WHERE id = ?", [id]);
  },

  /**
   * Importa la matriz desde el Excel (filas { nombre, valor, tipo, desde }):
   * cada nombre se busca entre las tarifas de la empresa (sin tildes ni
   * signos). Con aplicar = false solo dice cuales encontro; con true las guarda.
   */
  async importarFletes(filas: unknown, aplicar: boolean, usuarioId: number | null) {
    if (!Array.isArray(filas)) throw new ErrorCuadro("No llegaron filas.");
    const [tarifas] = await pool.query<RowDataPacket[]>("SELECT id, nombre FROM tarifas_flete");
    const porNombre = new Map(tarifas.map((t) => [nombreComparable(t.nombre), t]));
    const resultado = {
      encontradas: [] as Array<{ nombre: string; tarifa: string; valor: number; tipo: string; desde: string }>,
      sinTarifa: [] as string[],
      /** Las que cambiarian meses congelados (no se importan). */
      protegidas: [] as Array<{ nombre: string; motivo: string }>,
    };
    for (const f of filas as Array<Record<string, unknown>>) {
      const nombre = String(f.nombre ?? "").trim();
      const valor = Number(f.valor);
      if (!nombre || !Number.isFinite(valor) || valor <= 0) continue;
      const t = porNombre.get(nombreComparable(nombre));
      if (!t) {
        resultado.sinTarifa.push(nombre);
        continue;
      }
      const desde = /^\d{4}-\d{2}-\d{2}$/.test(String(f.desde ?? "").slice(0, 10)) ? String(f.desde).slice(0, 10) : "1999-04-01";
      const tipo = tipoFleteConductor(f.tipo);
      // Igual a lo que ya esta: nada que hacer. Si cambiaria meses congelados, no se importa.
      const [[igual]] = await pool.query<RowDataPacket[]>(
        "SELECT 1 AS si FROM fletes_conductor WHERE tarifaFleteId = ? AND desde = ? AND valor = ? AND tipo = ?",
        [t.id, desde, valor, tipo],
      );
      if (igual) continue;
      try {
        await exigirFleteLibre(t.id, desde, "nuevo");
      } catch (exc) {
        resultado.protegidas.push({ nombre, motivo: exc instanceof Error ? exc.message : "Meses congelados" });
        continue;
      }
      resultado.encontradas.push({ nombre, tarifa: t.nombre, valor, tipo, desde });
      if (aplicar) await this.guardarFlete({ tarifaFleteId: t.id, valor, tipo, desde }, usuarioId);
    }
    return resultado;
  },

  /**
   * Los viajes de la flota propia de un mes con su producido conductor y su
   * cuenta de viaje. porCorte (lo de Cuentas conductores): del 27 del mes
   * anterior al 26 (ver periodoConductores); sin el, el mes calendario (la
   * cuenta del vehiculo en Rentabilidad).
   */
  async viajes(mes: unknown, empresa: EmpresaVehiculo | null, porCorte = true): Promise<ViajeConductor[]> {
    const m = mesDe(mes);
    if (!porCorte) return viajesEntre(`${m}-01`, finDeMes(m), empresa);
    const p = periodoConductores(m);
    // Los del periodo y los que se pasaron a este mes desde los vecinos; sin los que se pasaron a otro.
    const [[r]] = await pool.query<RowDataPacket[]>(
      "SELECT MIN(c.fecha) AS desde, MAX(c.fecha) AS hasta FROM viajes_mes_conductor vm JOIN cuadro_viajes c ON c.id = vm.cuadroViajeId WHERE vm.mes = ?",
      [m],
    );
    const desde = r?.desde && dia(r.desde)! < p.desde ? dia(r.desde)! : p.desde;
    const hasta = r?.hasta && dia(r.hasta)! > p.hasta ? dia(r.hasta)! : p.hasta;
    return (await viajesEntre(desde, hasta, empresa)).filter((v) => v.mesConductor === m);
  },

  /**
   * Viajes cerca del cierre de un mes que se pueden traer a su liquidacion o
   * que se sacaron de ella: los de la ultima semana del periodo anterior y de
   * la primera del siguiente que cuentan en otro mes, y los del mes que se
   * pasaron a otro.
   */
  async viajesCercanos(mes: unknown, empresa: EmpresaVehiculo | null): Promise<ViajeConductor[]> {
    const m = mesDe(mes);
    const p = periodoConductores(m);
    const correr = (f: string, dias: number) => new Date(Date.parse(f) + dias * 86_400_000).toISOString().slice(0, 10);
    const todos = await viajesEntre(correr(p.desde, -7), correr(p.hasta, 7), empresa);
    return todos.filter((v) => v.mesConductor !== m && (v.fecha < correr(p.desde, 0) || v.fecha > p.hasta || v.mesMovido !== null));
  },

  /**
   * Pasa un viaje a la liquidacion de otro mes ({ mes, nota }): al anterior
   * (ya se le pago ahi, por ejemplo antes del corte del 27 al 26) o al
   * siguiente; el mes del viaje (o vacio) lo devuelve a su mes. Solo a los
   * meses vecinos y sin tocar liquidaciones ya hechas (ver problemaAlMover).
   */
  async moverDeMes(cuadroViajeId: number, d: Record<string, unknown>, usuarioId: number | null, empresa: EmpresaVehiculo | null): Promise<ViajeConductor> {
    const viaje = await viajeDeFlota(cuadroViajeId, empresa);
    const meses = mesesDelViaje(viaje.fecha);
    const hasta = d.mes ? String(d.mes) : meses.suyo;
    if (![meses.anterior, meses.suyo, meses.siguiente].includes(hasta))
      throw new ErrorCuadro(`Este viaje solo puede contar en ${meses.anterior}, ${meses.suyo} o ${meses.siguiente}.`);
    if (viaje.empleadoId) {
      const [hechas] = await pool.query<RowDataPacket[]>("SELECT mes FROM liquidaciones_conductor WHERE empleadoId = ?", [viaje.empleadoId]);
      const problema = problemaAlMover(viaje.mesConductor, hasta, new Set(hechas.map((x) => String(x.mes))));
      if (problema) throw new ErrorCuadro(problema);
    }
    const nota = d.nota ? String(d.nota).trim().slice(0, 300) || null : null;
    if (hasta === meses.suyo) await pool.query("DELETE FROM viajes_mes_conductor WHERE cuadroViajeId = ?", [cuadroViajeId]);
    else
      await pool.query(
        "INSERT INTO viajes_mes_conductor (cuadroViajeId, mes, nota, creadoPorId) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE mes = VALUES(mes), nota = VALUES(nota), creadoPorId = VALUES(creadoPorId)",
        [cuadroViajeId, hasta, nota, usuarioId],
      );
    return viajeDeFlota(cuadroViajeId, empresa);
  },

  /** Producido conductor por viaje entre dos fechas y si es integro (lo usa la nomina). */
  async producidoEntre(desde: string, hasta: string): Promise<Map<number, { valor: number | null; integro: boolean; empleadoId: number | null }>> {
    return new Map((await viajesEntre(desde, hasta, null)).map((v) => [v.cuadroViajeId, { valor: v.producido, integro: v.integro, empleadoId: v.empleadoId }]));
  },

  /**
   * Guarda la cuenta de viaje de un viaje (los conceptos, el ACPM vacio = el
   * combustible de los anticipos, el producido conductor a mano o vacio = el
   * de la matriz, la nota) y deja su gasto en el libro de gastos.
   */
  async guardarCuenta(cuadroViajeId: number, d: Record<string, unknown>, usuarioId: number | null, empresa: EmpresaVehiculo | null): Promise<void> {
    const [[c]] = await pool.query<RowDataPacket[]>("SELECT fecha FROM cuadro_viajes WHERE id = ? AND anulado = 0", [cuadroViajeId]);
    if (!c) throw new ErrorCuadro("Ese viaje no existe en el cuadro.");
    const fecha = dia(c.fecha)!;
    const [viaje] = await viajesEntre(fecha, fecha, empresa).then((vs) => vs.filter((v) => v.cuadroViajeId === cuadroViajeId));
    if (!viaje) throw new ErrorCuadro("Ese viaje no es de la flota propia (o no es de tu empresa).");
    await exigirSinPagar(viaje.empleadoId, viaje.mesConductor, "la cuenta de este viaje");
    if ("producidoManual" in d) await exigirSinNominaAprobada(fecha);
    const valores: Record<string, unknown> = {};
    for (const [k, nombre] of CONCEPTOS) {
      if (k === "acpm") continue;
      if (k in d) valores[k] = pesos(d[k], nombre) ?? 0;
    }
    if ("acpm" in d) valores.acpm = pesos(d.acpm, "el ACPM");
    if ("producidoManual" in d) {
      const p = pesos(d.producidoManual, "el producido conductor");
      if (p !== null && p < 0) throw new ErrorCuadro("El producido conductor no puede ser negativo.");
      valores.producidoManual = p;
    }
    if ("otrosConcepto" in d)
      valores.otrosConcepto =
        String(d.otrosConcepto ?? "")
          .trim()
          .slice(0, 200) || null;
    if ("nota" in d)
      valores.nota =
        String(d.nota ?? "")
          .trim()
          .slice(0, 300) || null;
    const columnas = Object.keys(valores);
    if (viaje.cuenta) {
      if (columnas.length)
        await pool.query(`UPDATE cuentas_viaje SET ${columnas.map((k) => `${k} = ?`).join(", ")}, actualizadoPorId = ? WHERE id = ?`, [
          ...columnas.map((k) => valores[k]),
          usuarioId,
          viaje.cuenta.id,
        ]);
    } else {
      await pool.query<ResultSetHeader>(
        `INSERT INTO cuentas_viaje (cuadroViajeId, ${[...columnas, "actualizadoPorId"].join(", ")}) VALUES (?, ${[...columnas, "x"].map(() => "?").join(", ")})`,
        [cuadroViajeId, ...columnas.map((k) => valores[k]), usuarioId],
      );
    }
    await this.sincronizarGasto(cuadroViajeId, usuarioId);
  },

  /**
   * Deja el gasto del libro igual a la cuenta de viaje: lo borra y lo vuelve a
   * crear con el total (si es mayor que cero), en la fecha del viaje y al
   * vehiculo. Si el mes esta cerrado, no deja cambiarla.
   */
  async sincronizarGasto(cuadroViajeId: number, usuarioId: number | null): Promise<void> {
    const [[c]] = await pool.query<RowDataPacket[]>("SELECT fecha FROM cuadro_viajes WHERE id = ?", [cuadroViajeId]);
    const fecha = dia(c.fecha)!;
    const [viaje] = (await viajesEntre(fecha, fecha, null)).filter((v) => v.cuadroViajeId === cuadroViajeId);
    if (!viaje?.cuenta) return;
    await gastos.borrarDeCuenta(viaje.cuenta.id);
    let gastoId: number | null = null;
    if (viaje.cuenta.total > 0 && viaje.vehiculoId) {
      const doc = viaje.remision ? `rem. ${viaje.remision}` : viaje.manifiesto ? `manif. ${viaje.manifiesto}` : `viaje ${viaje.cuadroViajeId}`;
      gastoId = await gastos.crear(
        {
          empresa: viaje.empresaVehiculo,
          tipo: "GASTO",
          categoria: "VEHICULO",
          descripcion: `Cuenta de viaje ${viaje.placa} ${viaje.cliente} (${doc})${viaje.conductor ? ` - ${viaje.conductor}` : ""}`,
          monto: viaje.cuenta.total,
          forma: "UNICO",
          fechaPago: fecha,
          causaDesde: fecha,
          destinos: [{ tipo: "VEHICULO", id: viaje.vehiculoId, modo: "PARTE", valor: 1 }],
        },
        usuarioId,
        { origen: "CUENTA_VIAJE", creditoId: null, cuentaViajeId: viaje.cuenta.id },
      );
    }
    await pool.query("UPDATE cuentas_viaje SET gastoId = ? WHERE id = ?", [gastoId, viaje.cuenta.id]);
  },

  /**
   * Agrega una transferencia del gerente a un viaje ({ fecha, valor, nota }):
   * completa el anticipo de la bomba y baja el rojo del conductor. No va al
   * Cuadro pagos. Devuelve el viaje como queda.
   */
  async agregarTransferencia(
    cuadroViajeId: number,
    d: Record<string, unknown>,
    usuarioId: number | null,
    empresa: EmpresaVehiculo | null,
  ): Promise<ViajeConductor> {
    const viaje = await viajeDeFlota(cuadroViajeId, empresa);
    await exigirSinPagar(viaje.empleadoId, viaje.mesConductor, "las transferencias de este viaje");
    const fecha = String(d.fecha ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new ErrorCuadro("Escribe la fecha de la transferencia.");
    const valor = pesos(d.valor, "el valor de la transferencia");
    if (!valor || valor <= 0) throw new ErrorCuadro("Escribe el valor de la transferencia (mayor que cero).");
    const nota =
      String(d.nota ?? "")
        .trim()
        .slice(0, 300) || null;
    await pool.query("INSERT INTO transferencias_conductor (cuadroViajeId, fecha, valor, nota, creadoPorId) VALUES (?, ?, ?, ?, ?)", [
      cuadroViajeId,
      fecha,
      valor,
      nota,
      usuarioId,
    ]);
    return viajeDeFlota(cuadroViajeId, empresa);
  },

  /** Borra una transferencia del gerente. Devuelve el viaje como queda. */
  async borrarTransferencia(id: number, empresa: EmpresaVehiculo | null): Promise<ViajeConductor> {
    const [[t]] = await pool.query<RowDataPacket[]>("SELECT cuadroViajeId FROM transferencias_conductor WHERE id = ?", [id]);
    if (!t) throw new ErrorCuadro("Esa transferencia ya no existe.");
    const viaje = await viajeDeFlota(t.cuadroViajeId, empresa);
    await exigirSinPagar(viaje.empleadoId, viaje.mesConductor, "las transferencias de este viaje");
    await pool.query("DELETE FROM transferencias_conductor WHERE id = ?", [id]);
    return viajeDeFlota(t.cuadroViajeId, empresa);
  },

  /** Borra la cuenta de viaje de un viaje y su gasto del libro. */
  async borrarCuenta(cuadroViajeId: number, empresa: EmpresaVehiculo | null): Promise<void> {
    const [[c]] = await pool.query<RowDataPacket[]>(
      `SELECT cv.id, v.empresa, v.visibleTodos, c.fecha FROM cuentas_viaje cv JOIN cuadro_viajes c ON c.id = cv.cuadroViajeId
         LEFT JOIN vehiculos v ON v.id = COALESCE(c.vehiculoId, (SELECT x.id FROM vehiculos x WHERE x.placa = c.placa AND x.eliminado = 0 LIMIT 1))
        WHERE cv.cuadroViajeId = ?`,
      [cuadroViajeId],
    );
    if (!c) return;
    if (empresa && c.empresa !== empresa && !c.visibleTodos) throw new ErrorCuadro("Ese viaje es de la otra empresa.");
    const [viaje] = (await viajesEntre(dia(c.fecha)!, dia(c.fecha)!, null)).filter((v) => v.cuadroViajeId === cuadroViajeId);
    await exigirSinPagar(viaje?.empleadoId ?? null, viaje?.mesConductor ?? mesConductores(dia(c.fecha)!), "la cuenta de este viaje");
    await gastos.borrarDeCuenta(c.id);
    await pool.query("DELETE FROM cuentas_viaje WHERE id = ?", [c.id]);
  },

  /** Prestamos (de una empresa o de las dos) con su saldo y lo descontado por mes. */
  async prestamos(empresa: EmpresaVehiculo | null, empleadoId?: number): Promise<Prestamo[]> {
    const donde = [empresa ? "e.empresa = ?" : "", empleadoId ? "p.empleadoId = ?" : ""].filter(Boolean);
    const [filas] = await pool.query<RowDataPacket[]>(
      `SELECT p.*, e.nombre AS empleado, e.empresa FROM prestamos_empleado p JOIN empleados e ON e.id = p.empleadoId
        ${donde.length ? `WHERE ${donde.join(" AND ")}` : ""} ORDER BY p.fecha DESC, p.id DESC`,
      [empresa, empleadoId].filter((x) => x !== null && x !== undefined),
    );
    if (!filas.length) return [];
    const [desc] = await pool.query<RowDataPacket[]>("SELECT prestamoId, mes, valor FROM prestamos_descuentos WHERE prestamoId IN (?) ORDER BY mes", [
      filas.map((f) => f.id),
    ]);
    return filas.map((f) => {
      const descuentos = desc.filter((x) => x.prestamoId === f.id).map((x) => ({ mes: x.mes as string, valor: Number(x.valor) }));
      return {
        id: f.id,
        empleadoId: f.empleadoId,
        empleado: f.empleado,
        empresa: f.empresa,
        fecha: dia(f.fecha)!,
        monto: Number(f.monto),
        cuota: num(f.cuota),
        nota: f.nota ?? null,
        descuentos,
        saldo: saldoPrestamo(
          Number(f.monto),
          descuentos.map((x) => x.valor),
        ),
      };
    });
  },

  /** Registra o cambia un prestamo ({ empleadoId, fecha, monto, cuota?, nota? }). */
  async guardarPrestamo(d: Record<string, unknown>, usuarioId: number | null, empresa: EmpresaVehiculo | null, id?: number): Promise<number> {
    const empleadoId = Number(d.empleadoId);
    const [[e]] = await pool.query<RowDataPacket[]>("SELECT empresa FROM empleados WHERE id = ?", [empleadoId]);
    if (!e) throw new ErrorCuadro("Elige el empleado.");
    if (empresa && e.empresa !== empresa) throw new ErrorCuadro("Ese empleado es de la otra empresa.");
    const fecha = String(d.fecha ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new ErrorCuadro("Escribe la fecha del prestamo.");
    const monto = pesos(d.monto, "el valor del prestamo");
    if (!monto || monto <= 0) throw new ErrorCuadro("Escribe el valor del prestamo.");
    const cuota = pesos(d.cuota, "la cuota");
    const nota =
      String(d.nota ?? "")
        .trim()
        .slice(0, 300) || null;
    if (id) {
      await pool.query("UPDATE prestamos_empleado SET empleadoId = ?, fecha = ?, monto = ?, cuota = ?, nota = ? WHERE id = ?", [
        empleadoId,
        fecha,
        monto,
        cuota,
        nota,
        id,
      ]);
      return id;
    }
    const [res] = await pool.query<ResultSetHeader>(
      "INSERT INTO prestamos_empleado (empleadoId, fecha, monto, cuota, nota, creadoPorId) VALUES (?, ?, ?, ?, ?, ?)",
      [empleadoId, fecha, monto, cuota, nota, usuarioId],
    );
    return res.insertId;
  },

  /** Borra un prestamo (con lo descontado). */
  async borrarPrestamo(id: number, empresa: EmpresaVehiculo | null): Promise<void> {
    const [p] = (await this.prestamos(empresa)).filter((x) => x.id === id);
    if (!p) throw new ErrorCuadro("Ese prestamo no existe (o es de la otra empresa).");
    await pool.query("DELETE FROM prestamos_empleado WHERE id = ?", [id]);
  },

  /**
   * Lo que se descuenta de un prestamo en un mes ({ mes, valor }): valor vacio
   * o 0 = ese mes no se descuenta. No puede pasar del saldo. Es el mismo dato
   * en la nomina y en la liquidacion del conductor.
   */
  async descontar(prestamoId: number, d: Record<string, unknown>, usuarioId: number | null, empresa: EmpresaVehiculo | null): Promise<void> {
    const mes = mesDe(d.mes);
    const [p] = (await this.prestamos(empresa)).filter((x) => x.id === prestamoId);
    if (!p) throw new ErrorCuadro("Ese prestamo no existe (o es de la otra empresa).");
    await exigirSinPagar(p.empleadoId, mes, "lo descontado de este prestamo");
    const valor = pesos(d.valor, "lo que se descuenta");
    if (!valor) {
      await pool.query("DELETE FROM prestamos_descuentos WHERE prestamoId = ? AND mes = ?", [prestamoId, mes]);
      return;
    }
    if (valor < 0) throw new ErrorCuadro("Lo que se descuenta no puede ser negativo.");
    const yaEsteMes = p.descuentos.find((x) => x.mes === mes)?.valor ?? 0;
    if (valor > c2(p.saldo + yaEsteMes)) throw new ErrorCuadro(`Solo quedan ${c2(p.saldo + yaEsteMes).toLocaleString("es-CO")} por descontar de ese prestamo.`);
    await pool.query(
      `INSERT INTO prestamos_descuentos (prestamoId, mes, valor, creadoPorId) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
      [prestamoId, mes, valor, usuarioId],
    );
  },

  /** Lo que se descuenta de prestamos a cada empleado en un mes. */
  async descuentosDelMes(mes: string): Promise<Map<number, number>> {
    const [filas] = await pool.query<RowDataPacket[]>(
      `SELECT p.empleadoId, SUM(d.valor) AS valor FROM prestamos_descuentos d JOIN prestamos_empleado p ON p.id = d.prestamoId WHERE d.mes = ? GROUP BY p.empleadoId`,
      [mes],
    );
    return new Map(filas.map((f) => [f.empleadoId as number, Number(f.valor)]));
  },

  /** Saldo de las cuentas de viaje de cada conductor entre dos fechas (lo que se le debe o debe). */
  async saldosEntre(desde: string, hasta: string): Promise<Map<number, { saldo: number; sinCuenta: number }>> {
    const r = new Map<number, { saldo: number; sinCuenta: number }>();
    for (const v of await viajesEntre(desde, hasta, null)) {
      if (!v.empleadoId) continue;
      const x = r.get(v.empleadoId) ?? { saldo: 0, sinCuenta: 0 };
      if (v.cuenta) x.saldo = c2(x.saldo + v.cuenta.saldo);
      else x.sinCuenta += 1;
      r.set(v.empleadoId, x);
    }
    return r;
  },

  /**
   * Liquidacion de cada conductor en el mes (el mes del producido): sus viajes
   * con producido conductor y cuenta de viaje, la nomina que cubre ese mes
   * (sueldo, % y aportes), los prestamos y si ya se le pago.
   */
  async liquidacion(
    mes: unknown,
    empresa: EmpresaVehiculo | null,
  ): Promise<{
    mes: string;
    conductores: LiquidacionMesConductor[];
    viajesSinConductor: number;
    motivosSinConductor: Array<{ motivo: string; viajes: number }>;
  }> {
    const m = mesDe(mes);
    const viajes = await this.viajes(m, empresa);
    const { nomina } = await import("./nomina");
    // M&C: sus conductores y los que manejaron un vehiculo visible para todos en el mes (su nomina y prestamos completos).
    const nominaDelMes = (await nomina.nominas({})).find((n) => mesProducido(n) === m) ?? null;
    const deVisibles = [...new Set(viajes.map((v) => v.empleadoId).filter((x): x is number => !!x))];
    const [empleados] = await pool.query<RowDataPacket[]>(
      `SELECT id, nombre, empresa, pctSalarial, pctViaticos FROM empleados WHERE tipo = 'CONDUCTOR' ${empresa ? "AND (empresa = ? OR id IN (?))" : ""} ORDER BY nombre`,
      empresa ? [empresa, deVisibles.length ? deVisibles : [0]] : [],
    );
    const prestamos = await this.prestamos(null);
    const [pagadas] = await pool.query<RowDataPacket[]>("SELECT empleadoId, fechaPago, total, detalle FROM liquidaciones_conductor WHERE mes = ?", [m]);
    const conductores: LiquidacionMesConductor[] = [];
    for (const e of empleados) {
      const suyos = viajes.filter((v) => v.empleadoId === e.id);
      const linea = nominaDelMes?.lineas.find((l) => l.empleadoId === e.id) ?? null;
      const susPrestamos = prestamos.filter((p) => p.empleadoId === e.id);
      const descuento = (p: Prestamo) => p.descuentos.find((x) => x.mes === m)?.valor ?? null;
      const visibles = susPrestamos.filter((p) => p.saldo > 0 || descuento(p) !== null);
      if (!suyos.length && !linea && !visibles.length) continue;
      // Sin nomina del mes: el calculo provisional con su producido (no espera la nomina).
      const viajesLiq = suyos.map((v) => ({ producido: v.producido, saldo: v.cuenta?.saldo ?? null, integro: v.integro }));
      let calculo = linea?.calculo ?? null;
      if (!calculo) {
        const base = liquidarConductor({
          viajes: viajesLiq,
          pctSalarial: Number(e.pctSalarial),
          pctViaticos: Number(e.pctViaticos),
          nomina: null,
          prestamos: 0,
        });
        calculo = await nomina.provisional(e.id, m, base.producido, base.integro).catch(() => null);
      }
      const liq = liquidarConductor({
        viajes: viajesLiq,
        pctSalarial: Number(e.pctSalarial),
        pctViaticos: Number(e.pctViaticos),
        nomina: calculo ? { devengado: calculo.devengado, deducciones: c2(calculo.saludEmpleado + calculo.pensionEmpleado), neto: calculo.neto } : null,
        prestamos: susPrestamos.reduce((s, p) => s + (descuento(p) ?? 0), 0),
      });
      const pagada = pagadas.find((p) => p.empleadoId === e.id);
      // Pagada: se muestra como se pago (la foto de ese momento); asi un cambio posterior no la altera.
      if (pagada?.detalle) {
        try {
          const foto = JSON.parse(String(pagada.detalle)) as LiquidacionMesConductor;
          conductores.push({ ...foto, pagada: { fechaPago: dia(pagada.fechaPago)!, total: Number(pagada.total) }, congelada: true });
          continue;
        } catch {
          // Foto danada: se recalcula.
        }
      }
      conductores.push({
        ...liq,
        empleadoId: e.id,
        nombre: e.nombre,
        empresa: e.empresa,
        pctSalarial: Number(e.pctSalarial),
        pctViaticos: Number(e.pctViaticos),
        nomina: calculo
          ? {
              nominaId: linea && nominaDelMes ? nominaDelMes.id : null,
              provisional: !(linea && nominaDelMes),
              estado: linea && nominaDelMes ? nominaDelMes.estado : "PROVISIONAL",
              desde: linea && nominaDelMes ? nominaDelMes.desde : periodoConductores(m).desde,
              hasta: linea && nominaDelMes ? nominaDelMes.hasta : periodoConductores(m).hasta,
              devengado: calculo.devengado,
              deducciones: c2(calculo.saludEmpleado + calculo.pensionEmpleado),
              neto: calculo.neto,
              basico: calculo.basico,
              auxilio: calculo.auxilio,
              salud: calculo.saludEmpleado,
              pension: calculo.pensionEmpleado,
            }
          : null,
        prestamosDetalle: visibles.map((p) => ({ prestamoId: p.id, fecha: p.fecha, monto: p.monto, saldo: p.saldo, cuota: p.cuota, descuento: descuento(p) })),
        pagada: pagada ? { fechaPago: dia(pagada.fechaPago)!, total: Number(pagada.total) } : null,
      });
    }
    // Por que quedan viajes sin conductor (los motivos que mas se repiten primero).
    const motivos = new Map<string, number>();
    for (const v of viajes)
      if (!v.empleadoId) motivos.set(v.motivoSinConductor ?? "Sin conductor", (motivos.get(v.motivoSinConductor ?? "Sin conductor") ?? 0) + 1);
    return {
      mes: m,
      conductores,
      viajesSinConductor: viajes.filter((v) => !v.empleadoId).length,
      motivosSinConductor: [...motivos].map(([motivo, n]) => ({ motivo, viajes: n })).sort((a, b) => b.viajes - a.viajes),
    };
  },

  /** Liquida al conductor en un mes ({ fechaPago }: la fecha en que el gerente lo liquida), con su total de ese momento. No depende de la nomina. */
  async pagar(empleadoId: number, mes: unknown, d: Record<string, unknown>, usuarioId: number | null, empresa: EmpresaVehiculo | null): Promise<void> {
    const m = mesDe(mes);
    const fechaPago = String(d.fechaPago ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaPago)) throw new ErrorCuadro("Escribe la fecha en que se le pago.");
    const l = (await this.liquidacion(m, empresa)).conductores.find((c) => c.empleadoId === empleadoId);
    if (!l) throw new ErrorCuadro("Ese conductor no tiene liquidacion en el mes (o es de la otra empresa).");
    if (l.totalAPagar === null) throw new ErrorCuadro(`Faltan los parametros de nomina de ${m.slice(0, 4)}: agregalos en Nomina > Parametros.`);
    await pool.query(
      `INSERT INTO liquidaciones_conductor (empleadoId, mes, fechaPago, total, detalle, creadoPorId) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE fechaPago = VALUES(fechaPago), total = VALUES(total), detalle = VALUES(detalle)`,
      [empleadoId, m, fechaPago, l.totalAPagar, JSON.stringify(l), usuarioId],
    );
  },

  /** Quita la marca de pagada. */
  async quitarPago(empleadoId: number, mes: unknown, empresa: EmpresaVehiculo | null): Promise<void> {
    const m = mesDe(mes);
    if (empresa && !(await this.liquidacion(m, empresa)).conductores.some((c) => c.empleadoId === empleadoId))
      throw new ErrorCuadro("Ese conductor es de la otra empresa.");
    await pool.query("DELETE FROM liquidaciones_conductor WHERE empleadoId = ? AND mes = ?", [empleadoId, m]);
  },
};

/** Para las pruebas y el formulario: los conceptos con su nombre. */
export const CONCEPTOS_CUENTA: ReadonlyArray<readonly [Concepto, string]> = CONCEPTOS;
