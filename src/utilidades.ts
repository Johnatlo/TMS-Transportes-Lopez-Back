/**
 * Utilidades (fases 3 y 4 del modulo de gastos): cascada de rentabilidad por
 * vehiculo, fondo de cada vehiculo y reparto entre socios mes a mes,
 * participaciones (quien es dueno de que vehiculo y en que porcentaje, con
 * vigencia), rentabilidad de la empresa y la cuenta de cada socio. Los
 * calculos estan en calculoUtilidades.ts.
 *
 * - Viajes: los de Rentabilidad (flete, descuentos, anticipos y saldo del
 *   dueno, ya calculados) de los vehiculos de la flota propia, por su fecha.
 * - Libro de gastos: lo que le toco a cada vehiculo, socio o a la empresa
 *   (gastos_reparto) en el mes, por fecha de causacion; los ingresos restan.
 * - Fondo de cada vehiculo: arranca en el mes de inicio de los gastos con su
 *   saldo inicial; cada mes suma la utilidad, resta lo que se le pago al dueno
 *   por los viajes (por la fecha de pago) y lo que se reparte. La base
 *   (10.000.000 por defecto) no se reparte. Todo editable (fondos_vehiculo).
 * - Aprobar un mes: el mes debe estar cerrado en Gastos y el anterior
 *   aprobado (el saldo de cada fondo sale de ahi). Se guarda la foto
 *   (repartos_utilidades) con lo que se decidio repartir de cada vehiculo.
 *   Solo se anula el ultimo mes aprobado.
 * - Empresa (estado de resultados, ver estadoEmpresa): la rentabilidad de los
 *   viajes de terceros + los reconocidos (de todos los carros) + T. Lopez
 *   cobrado en los viajes - los gastos que asume la empresa. El anticipo de
 *   renta va aparte (impuesto pagado por adelantado). No se reparte.
 * - Los reconocidos no entran a la cascada de los carros: son de la empresa.
 * - Socios: los de la empresa y los externos. La cuenta de cada socio arranca
 *   en su saldo inicial, suma el neto de cada mes aprobado y resta los pagos
 *   (pagos_socios); lo que no le alcanza se acumula para el mes siguiente.
 */
import type { RowDataPacket } from "mysql2/promise";
import { pool } from "./db";
import { dia, ErrorCuadro, hoyColombia } from "./cuadro";
import { rentabilidad } from "./rentabilidad";
import { cascadas, cuentaSocio, estadoEmpresa, finDeMes, participacionPonderada, pasoDe, repartoMes } from "./calculoUtilidades";
import type {
  Cascada,
  EstadoEmpresa,
  FondoVehiculo,
  MesCuenta,
  Participacion,
  PartidaGasto,
  ReconocidoEmpresa,
  RepartoSocio,
  TLopezVehiculo,
  ViajeCascada,
} from "./calculoUtilidades";
import type { EmpresaVehiculo } from "./roles";

/** Un viaje de terceros en la rentabilidad de la empresa. */
export interface ViajeTercero {
  id: number;
  fecha: string;
  placa: string;
  tercero: string | null;
  cliente: string;
  manifiesto: string | null;
  /** Remision del viaje en el Cuadro pagos. */
  remision: string | null;
  /** Link (Drive) de la remision escaneada. */
  remisionUrl: string | null;
  /** Link (Drive) de la factura. */
  facturaUrl: string | null;
  flete: number;
  saldoEmpresa: number;
  saldoTercero: number;
  rentabilidad: number;
  anticipoRenta: number;
  ganancia: number;
  /** Sin valor pactado con el tercero en Pago a terceros: su rentabilidad no es real (sale todo el flete). */
  sinPactar: boolean;
}

/** La cascada, el fondo y el reparto de un mes. */
export interface UtilidadesMes {
  mes: string;
  /** Mes en que arrancan los fondos (el de la fecha de inicio de los gastos). */
  inicio: string;
  /** Mes cerrado en Gastos. */
  cerrado: boolean;
  /** Si esta aprobado: quien y cuando (y entonces los datos son la foto guardada). */
  aprobado: { por: string | null; en: string } | null;
  /** Meses anteriores sin aprobar (el saldo anterior de los fondos no los incluye). */
  pendientes: string[];
  gmfPorMil: number;
  vehiculos: Array<{
    vehiculoId: number;
    placa: string;
    empresa: EmpresaVehiculo;
    dueno: string | null;
    /** Participacion del mes, ponderada por los dias. */
    participaciones: Array<{ socioId: number; socio: string; porcentaje: number }>;
    cascada: Cascada;
    detalleViajes: ViajeCascada[];
    fondo: FondoVehiculo | null;
  }>;
  socios: Array<RepartoSocio & { nombre: string; externo: boolean }>;
  /** Vehiculos que reparten o liquidan algo sin participacion que sume 100 %. */
  sinParticipacion: string[];
  /** Estado de resultados de la empresa (no se reparte). */
  empresa: EstadoEmpresa & {
    detalleTerceros: ViajeTercero[];
    detalleReconocidos: ReconocidoEmpresa[];
    detalleTLopez: TLopezVehiculo[];
    gastos: PartidaGasto[];
  };
}

/** Lo que ve cada rol de Utilidades. */
export interface VistaUtilidades {
  /** Fondos y reparto por socio (administrativas: no). */
  reparto: boolean;
  /** Rentabilidad de los viajes de terceros (M&C: no). */
  terceros: boolean;
  /** Estado de resultados de la empresa (solo el rol total); sin el, la empresa va en cero. */
  empresa: boolean;
}

/** Configuracion del fondo de un vehiculo. */
export interface ConfigFondo {
  vehiculoId: number;
  placa: string;
  empresa: EmpresaVehiculo;
  base: number;
  saldoInicial: number;
  nota: string | null;
}

/** Un socio: de la empresa o externo (solo esta en una sociedad). */
export interface Socio {
  id: number;
  nombre: string;
  activo: boolean;
  externo: boolean;
  documento: string | null;
  nota: string | null;
  /** Lo que se le debia (o el debia, negativo) antes de empezar en el sistema. */
  saldoInicial: number;
}

/** La cuenta de un socio: cada mes con su detalle, sus pagos y el saldo. */
export interface CuentaSocio extends Socio {
  meses: Array<MesCuenta & { detalle: Pick<RepartoSocio, "repartido" | "gmf" | "liquidado" | "recibido" | "totalGastosPropios"> | null }>;
  pagos: Array<{ id: number; fecha: string; monto: number; nota: string | null; soporteUrl: string | null; registradoPor: string | null }>;
  /** Lo que se le debe hoy (negativo = lo que debe el). */
  saldo: number;
}

/** Lo que se lee de la foto de un mes aprobado para el fondo del siguiente. */
type FotoMes = { vehiculos?: Array<{ fondo: FondoVehiculo | null }> };

/** Base de un fondo cuando no se ha configurado. */
export const BASE_POR_DEFECTO = 10_000_000;

/** Normaliza una placa ("SZX-880" -> "SZX880"). */
const placaClave = (p: string) => p.replace(/[^A-Z0-9]/gi, "").toUpperCase();
/** El dia anterior a una fecha. */
const diaAntes = (f: string) => new Date(Date.parse(f) - 86_400_000).toISOString().slice(0, 10);
/** Redondea a centavos. */
const c2 = (v: number) => Math.round(v * 100) / 100;
/** JSON guardado a objeto. */
function json<T>(v: unknown, defecto: T): T {
  try {
    return typeof v === "string" && v ? (JSON.parse(v) as T) : defecto;
  } catch {
    return defecto;
  }
}
/** Mes "AAAA-MM" valido. */
function mesDe(v: unknown): string {
  const m = String(v ?? "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new ErrorCuadro("Elige el mes.");
  return m;
}
/** El mes anterior a "AAAA-MM". */
const mesAnterior = (m: string) => {
  const [a, n] = m.split("-").map(Number);
  return n === 1 ? `${a - 1}-12` : `${a}-${String(n - 1).padStart(2, "0")}`;
};
/** Fecha (Date o texto) a ISO. */
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

/** Mes de inicio de los fondos (el de la fecha de inicio de los gastos) y el 4 x 1000. */
async function parametros(): Promise<{ inicio: string; gmfPorMil: number }> {
  const [[p]] = await pool.query<RowDataPacket[]>("SELECT gastosDesde, gmfPorMil FROM parametros_empresa WHERE id = 1");
  return {
    inicio: (dia(p?.gastosDesde) ?? "2026-10-01").slice(0, 7),
    gmfPorMil: p?.gmfPorMil === undefined || p?.gmfPorMil === null ? 4 : Number(p.gmfPorMil),
  };
}

/** Lo que se decidio repartir de cada vehiculo ({ vehiculoId: monto }), validado. */
function repartimosDe(x: unknown): Map<number, number> {
  const r = new Map<number, number>();
  if (!x || typeof x !== "object") return r;
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if (v === null || v === undefined || v === "") continue;
    const monto = Number(v);
    if (!Number.isFinite(monto) || monto < 0) throw new ErrorCuadro("Lo que se reparte de cada vehiculo debe ser un valor de cero o mas.");
    r.set(Number(k), Math.round(monto * 100) / 100);
  }
  return r;
}

/** El estado de resultados de la empresa con su detalle. */
function armarEmpresa(d: {
  detalleTerceros: ViajeTercero[];
  detalleReconocidos: ReconocidoEmpresa[];
  detalleTLopez: TLopezVehiculo[];
  anticipoSocios: number;
  gastos: PartidaGasto[];
  totalGastos: number;
}): UtilidadesMes["empresa"] {
  return {
    ...estadoEmpresa({
      terceros: d.detalleTerceros,
      reconocidos: d.detalleReconocidos,
      tLopez: d.detalleTLopez,
      anticipoSocios: d.anticipoSocios,
      totalGastos: d.totalGastos,
    }),
    detalleTerceros: d.detalleTerceros,
    detalleReconocidos: d.detalleReconocidos,
    detalleTLopez: d.detalleTLopez,
    gastos: d.gastos,
  };
}

/** Utilidades, fondos, participaciones y socios. */
export const utilidades = {
  /** Cascada, fondo y reparto del mes, segun lo que ve el rol. Con `repartimos`, simula (aunque este aprobado). */
  async mes(mesTexto: unknown, vista: VistaUtilidades, repartimos?: unknown): Promise<UtilidadesMes> {
    const mes = mesDe(mesTexto);
    const [[aprob]] = await pool.query<RowDataPacket[]>(
      "SELECT r.datos, r.aprobadoEn, u.nombre AS por FROM repartos_utilidades r LEFT JOIN usuarios u ON u.id = r.aprobadoPorId WHERE r.mes = ?",
      [mes],
    );
    const [[cierre]] = await pool.query<RowDataPacket[]>("SELECT 1 AS si FROM periodos_cierre WHERE mes = ?", [mes]);
    const datos: Omit<UtilidadesMes, "cerrado" | "aprobado"> =
      aprob && repartimos === undefined ? json(aprob.datos, null)! : await this.calcular(mes, repartimosDe(repartimos));
    const resultado: UtilidadesMes = {
      ...datos,
      cerrado: !!cierre,
      aprobado: aprob ? { por: aprob.por ?? null, en: iso(aprob.aprobadoEn) } : null,
    };
    return this.recortar(resultado, vista);
  },

  /** Quita lo que el rol no ve: el reparto (administrativas) o los terceros (M&C). */
  recortar(u: UtilidadesMes, vista: VistaUtilidades): UtilidadesMes {
    let r = u;
    if (!vista.reparto) r = { ...r, vehiculos: r.vehiculos.map((v) => ({ ...v, fondo: null })), socios: [], sinParticipacion: [] };
    if (!vista.empresa) {
      // Sin nada de la empresa (ni terceros, ni reconocidos, ni T. Lopez, ni sus gastos).
      r = {
        ...r,
        empresa: armarEmpresa({ detalleTerceros: [], detalleReconocidos: [], detalleTLopez: [], anticipoSocios: 0, gastos: [], totalGastos: 0 }),
      };
    } else if (!vista.terceros) {
      // Sin los viajes de terceros ni lo cobrado en ellos (reconocidos y T. Lopez de carros de terceros).
      const e = r.empresa;
      r = {
        ...r,
        empresa: armarEmpresa({
          detalleTerceros: [],
          detalleReconocidos: (e.detalleReconocidos ?? []).filter((x) => x.propio),
          detalleTLopez: (e.detalleTLopez ?? []).filter((x) => x.propio),
          anticipoSocios: e.anticipoRenta?.descontadoSocios ?? 0,
          gastos: e.gastos,
          totalGastos: e.totalGastos,
        }),
      };
    }
    return r;
  },

  /** Calcula el mes con los datos actuales y lo que se reparte de cada vehiculo (lo que falte: el sugerido). */
  async calcular(mes: string, repartimos: Map<number, number>): Promise<Omit<UtilidadesMes, "cerrado" | "aprobado">> {
    const { inicio, gmfPorMil } = await parametros();
    const desde = `${mes}-01`;
    const hasta = finDeMes(mes);
    const [flota] = await pool.query<RowDataPacket[]>(
      "SELECT id, placa, empresa, dueno FROM vehiculos WHERE eliminado = 0 AND empresa IS NOT NULL ORDER BY empresa, placa",
    );
    const porPlaca = new Map(flota.map((v) => [placaClave(v.placa), v.id as number]));
    const filasRent = await rentabilidad.listar();
    // Viajes con cuenta de viaje (modulo Cuentas vehiculos): su costo es lo gastado, que llega por el libro de gastos
    // como gasto directo del vehiculo; su anticipo ya no se cuenta (seria contar dos veces la plata del viaje).
    const [conCuenta] = await pool.query<RowDataPacket[]>("SELECT cuadroViajeId FROM cuentas_viaje WHERE gastoId IS NOT NULL");
    const viajesConCuenta = new Set(conCuenta.map((c) => c.cuadroViajeId as number));
    const delMes = filasRent.filter((f) => f.fecha >= desde && f.fecha <= hasta);
    // 1 y 2 (y los anticipos del 3): los viajes de Rentabilidad de la flota propia en el mes (sin los reconocidos: son de la empresa).
    const viajes: ViajeCascada[] = delMes
      .filter((f) => !f.concepto && porPlaca.has(placaClave(f.placa)))
      .map((f) => ({
        id: f.id,
        vehiculoId: porPlaca.get(placaClave(f.placa))!,
        fecha: f.fecha,
        manifiesto: f.manifiesto,
        remisionUrl: f.remisionUrl,
        facturaUrl: f.facturaUrl,
        cliente: f.empresa,
        flete: f.valorEmpresa,
        retencion: f.retencion,
        reteIca: f.reteIca,
        anticipoRenta: f.anticipoRenta,
        bancaria: f.bancaria,
        supertransporte: f.supertransporte,
        comision: f.comision,
        tLopez: f.tLopez,
        descargue: f.descargue,
        poliza: f.poliza,
        otrosDescuentos: f.otrosDescuentos,
        anticipo: viajesConCuenta.has(f.id) ? 0 : f.anticipo,
        combustible: viajesConCuenta.has(f.id) ? 0 : f.combustible,
        efectivo: viajesConCuenta.has(f.id) ? 0 : f.efectivo,
        transferencia: viajesConCuenta.has(f.id) ? 0 : f.transferencia,
        conCuenta: viajesConCuenta.has(f.id),
        saldoBeneficiario: f.saldoBeneficiario,
      }));
    // Lo que se le pago al dueno por los viajes en el mes (por la fecha de pago, sea cual sea la del viaje).
    const liquidado = new Map<number, number>();
    for (const f of filasRent) {
      const id = porPlaca.get(placaClave(f.placa));
      if (!id || !f.fechaPagoBeneficiario || f.fechaPagoBeneficiario < desde || f.fechaPagoBeneficiario > hasta) continue;
      liquidado.set(id, c2((liquidado.get(id) ?? 0) + f.saldoBeneficiario));
    }
    // Empresa: los viajes de terceros del mes (sin reconocidos), los reconocidos de todos los carros y T. Lopez cobrado.
    const detalleTerceros: ViajeTercero[] = delMes
      .filter((f) => f.grupo === "TERCEROS" && !f.concepto)
      .map((f) => ({
        id: f.id,
        fecha: f.fecha,
        placa: f.placa,
        tercero: f.tercero,
        cliente: f.empresa,
        manifiesto: f.manifiesto,
        remision: f.remision,
        remisionUrl: f.remisionUrl,
        facturaUrl: f.facturaUrl,
        flete: f.valorEmpresa,
        saldoEmpresa: f.saldoEmpresa,
        saldoTercero: f.saldoBeneficiario,
        rentabilidad: f.rentabilidad,
        anticipoRenta: f.anticipoRenta,
        ganancia: f.ganancia,
        sinPactar: f.fleteTercero <= 0 && f.valorEmpresa > 0,
      }));
    const detalleReconocidos: ReconocidoEmpresa[] = delMes
      .filter((f) => !!f.concepto)
      .map((f) => ({
        id: f.id,
        fecha: f.fecha,
        placa: f.placa,
        propio: porPlaca.has(placaClave(f.placa)),
        cliente: f.empresa,
        manifiesto: f.manifiesto,
        remisionUrl: f.remisionUrl,
        facturaUrl: f.facturaUrl,
        flete: f.valorEmpresa,
        descuentos: c2(f.valorEmpresa - f.rentabilidad),
        ingreso: f.rentabilidad,
        anticipoRenta: f.anticipoRenta,
      }));
    const tl = new Map<string, TLopezVehiculo>();
    for (const f of delMes.filter((x) => x.tLopez > 0)) {
      const k = placaClave(f.placa);
      const x = tl.get(k) ?? { placa: f.placa, propio: porPlaca.has(k), viajes: 0, total: 0 };
      x.viajes += 1;
      x.total = c2(x.total + f.tLopez);
      tl.set(k, x);
    }
    const detalleTLopez = [...tl.values()].sort((a, b) => b.total - a.total);
    // El anticipo de renta que se les descuenta a los socios (viajes de la flota propia, sin reconocidos).
    const anticipoSocios = c2(viajes.reduce((t, v) => t + v.anticipoRenta, 0));
    // 3, 4, 5 y lo de la empresa: lo que le toco a cada vehiculo, socio o a la empresa del libro de gastos.
    const [filas] = await pool.query<RowDataPacket[]>(
      `SELECT r.gastoId, r.vehiculoId, r.socioId, SUM(r.monto) AS monto, g.descripcion, g.categoria, g.tipo, g.destinos, g.empresa,
              MAX(e.tipo = 'CONDUCTOR') AS nominaConductor
         FROM gastos_reparto r JOIN gastos g ON g.id = r.gastoId
         LEFT JOIN nomina_lineas nl ON nl.gastoId = g.id LEFT JOIN empleados e ON e.id = nl.empleadoId
        WHERE g.anulado = 0 AND r.fecha BETWEEN ? AND ?
        GROUP BY r.gastoId, r.vehiculoId, r.socioId, g.descripcion, g.categoria, g.tipo, g.destinos, g.empresa`,
      [desde, hasta],
    );
    const partidas: PartidaGasto[] = filas.map((f) => {
      const destinos = json<Array<{ tipo: string }>>(f.destinos, []);
      return {
        gastoId: f.gastoId,
        descripcion: f.descripcion,
        categoria: f.categoria,
        monto: c2((f.tipo === "INGRESO" ? -1 : 1) * Number(f.monto)),
        vehiculoId: f.vehiculoId ?? null,
        socioId: f.socioId ?? null,
        empresa: f.empresa,
        paso: pasoDe({
          esNominaConductor: !!Number(f.nominaConductor),
          destinosVehiculo: destinos.filter((d) => d.tipo === "VEHICULO").length,
          destinosSocio: destinos.filter((d) => d.tipo === "SOCIO").length,
          aLaEmpresa: !f.vehiculoId && !f.socioId,
        }),
      };
    });
    const lista = cascadas(
      flota.map((v) => v.id),
      viajes,
      partidas,
    );
    // Fondos: saldo anterior = saldo final del mes anterior aprobado (o el inicial en el mes de inicio).
    const config = new Map((await this.fondos()).map((f) => [f.vehiculoId, f]));
    const pendientes: string[] = [];
    let anterior = null as FotoMes | null;
    if (mes > inicio) {
      const [aprobados] = await pool.query<RowDataPacket[]>("SELECT mes, datos FROM repartos_utilidades WHERE mes >= ? AND mes < ? ORDER BY mes", [
        inicio,
        mes,
      ]);
      const hechos = new Set(aprobados.map((a) => String(a.mes)));
      for (let m = mesAnterior(mes); m >= inicio; m = mesAnterior(m)) if (!hechos.has(m)) pendientes.unshift(m);
      const ultimo = aprobados.at(-1);
      anterior = ultimo ? json<FotoMes | null>(ultimo.datos, null) : null;
    }
    const fondosPrevios = (anterior?.vehiculos ?? []).map((v) => v.fondo).filter((f): f is FondoVehiculo => !!f);
    const fondos = new Map<number, { base: number; saldoAnterior: number }>();
    for (const v of flota) {
      const cfg = config.get(v.id);
      const previo = fondosPrevios.find((f) => f.vehiculoId === v.id);
      fondos.set(v.id, { base: cfg?.base ?? BASE_POR_DEFECTO, saldoAnterior: previo ? previo.saldoFinal : (cfg?.saldoInicial ?? 0) });
    }
    const participaciones = await this.participacionesTodas();
    const [socios] = await pool.query<RowDataPacket[]>("SELECT id, nombre, externo FROM socios");
    const nombre = new Map(socios.map((s) => [s.id as number, s.nombre as string]));
    const externo = new Map(socios.map((s) => [s.id as number, !!s.externo]));
    // Quien recibe la liquidacion de los viajes de cada carro: su dueno en Flota (si es un socio).
    const idSocio = new Map(socios.map((s) => [String(s.nombre).toUpperCase(), s.id as number]));
    const receptor = new Map<number, number>();
    for (const v of flota) {
      const id = v.dueno ? idSocio.get(String(v.dueno).trim().toUpperCase()) : undefined;
      if (id) receptor.set(v.id, id);
    }
    const reparto = repartoMes({ lista, fondos, liquidado, repartimos, participaciones, partidas, desde, hasta, receptor, gmfPorMil });
    const gastosEmpresa = partidas.filter((p) => p.paso === "EMPRESA");
    const totalGastosEmpresa = c2(gastosEmpresa.reduce((t, p) => t + p.monto, 0));
    const conFondo = mes >= inicio;
    return {
      mes,
      inicio,
      pendientes,
      gmfPorMil,
      vehiculos: flota.map((v, i) => ({
        vehiculoId: v.id,
        placa: v.placa,
        empresa: v.empresa,
        dueno: v.dueno ?? null,
        participaciones: participacionPonderada(participaciones, v.id, desde, hasta).map((p) => ({ ...p, socio: nombre.get(p.socioId) ?? "?" })),
        cascada: lista[i],
        detalleViajes: viajes.filter((x) => x.vehiculoId === v.id),
        fondo: conFondo ? reparto.fondos[i] : null,
      })),
      socios: conFondo
        ? reparto.socios
            .map((s) => ({ ...s, nombre: nombre.get(s.socioId) ?? "?", externo: externo.get(s.socioId) ?? false }))
            .sort((a, b) => a.nombre.localeCompare(b.nombre))
        : [],
      sinParticipacion: conFondo ? reparto.sinParticipacion.map((id) => flota.find((v) => v.id === id)?.placa ?? "?") : [],
      empresa: armarEmpresa({ detalleTerceros, detalleReconocidos, detalleTLopez, anticipoSocios, gastos: gastosEmpresa, totalGastos: totalGastosEmpresa }),
    };
  },

  /**
   * Aprueba el mes con lo que se decidio repartir de cada vehiculo: guarda la
   * foto. El mes debe estar cerrado en Gastos, ser desde el inicio y tener el
   * anterior aprobado.
   */
  async aprobar(mesTexto: unknown, repartimos: unknown, usuarioId: number | null): Promise<void> {
    const mes = mesDe(mesTexto);
    const { inicio } = await parametros();
    if (mes < inicio) throw new ErrorCuadro(`Los repartos empiezan en ${inicio} (la fecha de inicio de los gastos).`);
    const [[cierre]] = await pool.query<RowDataPacket[]>("SELECT 1 AS si FROM periodos_cierre WHERE mes = ?", [mes]);
    if (!cierre) throw new ErrorCuadro(`Primero cierra el mes ${mes} en Gastos (Mas > Cierre de meses): asi sus gastos ya no cambian.`);
    const datos = await this.calcular(mes, repartimosDe(repartimos));
    if (datos.pendientes.length) throw new ErrorCuadro(`Primero aprueba ${datos.pendientes.join(", ")}: el saldo de los fondos sale del mes anterior.`);
    if (datos.sinParticipacion.length) throw new ErrorCuadro(`Falta la participacion de ${datos.sinParticipacion.join(", ")}: registrala en Participaciones.`);
    await pool.query("REPLACE INTO repartos_utilidades (mes, datos, aprobadoPorId) VALUES (?, ?, ?)", [mes, JSON.stringify(datos), usuarioId]);
  },

  /** Anula la aprobacion del ultimo mes aprobado (los siguientes dependen de el). */
  async anular(mesTexto: unknown): Promise<void> {
    const mes = mesDe(mesTexto);
    const [[despues]] = await pool.query<RowDataPacket[]>("SELECT MIN(mes) AS mes FROM repartos_utilidades WHERE mes > ?", [mes]);
    if (despues?.mes) throw new ErrorCuadro(`Primero anula ${despues.mes}: su fondo sale de este mes.`);
    await pool.query("DELETE FROM repartos_utilidades WHERE mes = ?", [mes]);
  },

  /** Meses con reparto aprobado. */
  async aprobados(): Promise<string[]> {
    const [filas] = await pool.query<RowDataPacket[]>("SELECT mes FROM repartos_utilidades ORDER BY mes");
    return filas.map((f) => String(f.mes));
  },

  /** Configuracion del fondo de cada vehiculo de la flota propia (base y saldo inicial). */
  async fondos(): Promise<ConfigFondo[]> {
    const [filas] = await pool.query<RowDataPacket[]>(
      `SELECT v.id, v.placa, v.empresa, f.base, f.saldoInicial, f.nota FROM vehiculos v LEFT JOIN fondos_vehiculo f ON f.vehiculoId = v.id
        WHERE v.eliminado = 0 AND v.empresa IS NOT NULL ORDER BY v.empresa, v.placa`,
    );
    return filas.map((f) => ({
      vehiculoId: f.id,
      placa: f.placa,
      empresa: f.empresa,
      base: f.base === null || f.base === undefined ? BASE_POR_DEFECTO : Number(f.base),
      saldoInicial: f.saldoInicial === null || f.saldoInicial === undefined ? 0 : Number(f.saldoInicial),
      nota: f.nota ?? null,
    }));
  },

  /** Cambia la base y el saldo inicial del fondo de un vehiculo ({ base, saldoInicial, nota? }). */
  async guardarFondo(vehiculoId: number, d: Record<string, unknown>): Promise<void> {
    const base = Number(d.base);
    if (!Number.isFinite(base) || base < 0) throw new ErrorCuadro("La base debe ser un valor de cero o mas.");
    const saldoInicial = Number(d.saldoInicial ?? 0);
    if (!Number.isFinite(saldoInicial)) throw new ErrorCuadro("Revisa el saldo inicial.");
    const [[aprob]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM repartos_utilidades");
    const [[actual]] = await pool.query<RowDataPacket[]>("SELECT saldoInicial FROM fondos_vehiculo WHERE vehiculoId = ?", [vehiculoId]);
    if (aprob.n > 0 && Number(actual?.saldoInicial ?? 0) !== saldoInicial)
      throw new ErrorCuadro("Ya hay meses aprobados: el saldo inicial no se cambia (anula las aprobaciones primero).");
    const nota =
      String(d.nota ?? "")
        .trim()
        .slice(0, 300) || null;
    await pool.query(
      `INSERT INTO fondos_vehiculo (vehiculoId, base, saldoInicial, nota) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE base = VALUES(base), saldoInicial = VALUES(saldoInicial), nota = VALUES(nota)`,
      [vehiculoId, base.toFixed(2), saldoInicial.toFixed(2), nota],
    );
  },

  /** Cambia el 4 x 1000 que se descuenta al repartir ({ gmfPorMil }). */
  async guardarGmf(d: Record<string, unknown>): Promise<void> {
    const v = Number(d.gmfPorMil);
    if (!Number.isFinite(v) || v < 0 || v > 100) throw new ErrorCuadro("Revisa el 4 x 1000 (por mil).");
    await pool.query("UPDATE parametros_empresa SET gmfPorMil = ? WHERE id = 1", [v]);
  },

  /** Todas las participaciones (para el calculo). */
  async participacionesTodas(): Promise<Participacion[]> {
    const [filas] = await pool.query<RowDataPacket[]>("SELECT vehiculoId, socioId, porcentaje, desde, hasta FROM participaciones ORDER BY vehiculoId, desde");
    return filas.map((f) => ({ vehiculoId: f.vehiculoId, socioId: f.socioId, porcentaje: Number(f.porcentaje), desde: dia(f.desde)!, hasta: dia(f.hasta) }));
  },

  /** Vehiculos de la flota propia con su participacion vigente y su historial. */
  async participaciones() {
    const [flota] = await pool.query<RowDataPacket[]>(
      "SELECT id, placa, empresa, dueno FROM vehiculos WHERE eliminado = 0 AND empresa IS NOT NULL ORDER BY empresa, placa",
    );
    const [filas] = await pool.query<RowDataPacket[]>(
      "SELECT p.id, p.vehiculoId, p.socioId, s.nombre AS socio, s.externo, p.porcentaje, p.desde, p.hasta FROM participaciones p JOIN socios s ON s.id = p.socioId ORDER BY p.desde, s.nombre",
    );
    const hoy = hoyColombia();
    return flota.map((v) => {
      const historial = filas
        .filter((f) => f.vehiculoId === v.id)
        .map((f) => ({
          id: f.id,
          socioId: f.socioId,
          socio: f.socio,
          externo: !!f.externo,
          porcentaje: Number(f.porcentaje),
          desde: dia(f.desde)!,
          hasta: dia(f.hasta),
        }));
      const vigentes = historial.filter((p) => p.desde <= hoy && (!p.hasta || p.hasta >= hoy));
      return { vehiculoId: v.id, placa: v.placa, empresa: v.empresa as EmpresaVehiculo, dueno: v.dueno ?? null, vigentes, historial };
    });
  },

  /**
   * Registra la participacion de un vehiculo desde una fecha ({ desde, partes: [{ socioId, porcentaje }] }),
   * que debe sumar 100 %. La anterior se cierra el dia antes; lo que empezaba desde esa fecha se reemplaza.
   */
  async guardarParticipacion(vehiculoId: number, d: Record<string, unknown>): Promise<void> {
    const desde = String(d.desde ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) throw new ErrorCuadro("Escribe desde cuando aplica.");
    const partes = (Array.isArray(d.partes) ? d.partes : []) as Array<Record<string, unknown>>;
    const limpias = partes.map((p) => ({ socioId: Number(p.socioId), porcentaje: Number(p.porcentaje) })).filter((p) => p.socioId > 0 && p.porcentaje > 0);
    if (!limpias.length) throw new ErrorCuadro("Agrega al menos un socio.");
    if (new Set(limpias.map((p) => p.socioId)).size !== limpias.length) throw new ErrorCuadro("Un socio esta repetido.");
    const suma = limpias.reduce((s, p) => s + p.porcentaje, 0);
    if (Math.abs(suma - 100) > 0.001) throw new ErrorCuadro(`Los porcentajes suman ${suma} %: deben sumar 100 %.`);
    const [[aprob]] = await pool.query<RowDataPacket[]>("SELECT MAX(mes) AS mes FROM repartos_utilidades");
    if (aprob?.mes && desde <= finDeMes(String(aprob.mes)))
      throw new ErrorCuadro(`El reparto de ${aprob.mes} ya esta aprobado: la nueva participacion debe empezar despues.`);
    await pool.query("DELETE FROM participaciones WHERE vehiculoId = ? AND desde >= ?", [vehiculoId, desde]);
    await pool.query("UPDATE participaciones SET hasta = ? WHERE vehiculoId = ? AND (hasta IS NULL OR hasta >= ?)", [diaAntes(desde), vehiculoId, desde]);
    await pool.query("INSERT INTO participaciones (vehiculoId, socioId, porcentaje, desde) VALUES ?", [
      limpias.map((p) => [vehiculoId, p.socioId, p.porcentaje, desde]),
    ]);
  },

  /** Socios (activos primero). */
  async socios(): Promise<Socio[]> {
    const [filas] = await pool.query<RowDataPacket[]>(
      "SELECT id, nombre, activo, externo, documento, nota, saldoInicial FROM socios ORDER BY activo DESC, nombre",
    );
    return filas.map((f) => ({
      id: f.id as number,
      nombre: f.nombre as string,
      activo: !!f.activo,
      externo: !!f.externo,
      documento: f.documento ?? null,
      nota: f.nota ?? null,
      saldoInicial: Number(f.saldoInicial ?? 0),
    }));
  },

  /** Crea o cambia un socio ({ nombre, externo, documento?, nota?, saldoInicial? }). Externo = no hace parte de la empresa, solo de una sociedad. */
  async guardarSocio(d: Record<string, unknown>, id?: number): Promise<void> {
    const nombre = String(d.nombre ?? "")
      .trim()
      .toUpperCase()
      .slice(0, 80);
    if (!nombre) throw new ErrorCuadro("Escribe el nombre del socio.");
    const [[existe]] = await pool.query<RowDataPacket[]>("SELECT id FROM socios WHERE nombre = ? AND id <> ?", [nombre, id ?? 0]);
    if (existe) throw new ErrorCuadro("Ya hay un socio con ese nombre.");
    const saldoInicial = Number(d.saldoInicial ?? 0);
    if (!Number.isFinite(saldoInicial)) throw new ErrorCuadro("Revisa el saldo inicial.");
    const texto = (v: unknown, max: number) =>
      String(v ?? "")
        .trim()
        .slice(0, max) || null;
    const valores = [nombre, d.externo ? 1 : 0, texto(d.documento, 20), texto(d.nota, 300), saldoInicial.toFixed(2)];
    if (id) await pool.query("UPDATE socios SET nombre = ?, externo = ?, documento = ?, nota = ?, saldoInicial = ? WHERE id = ?", [...valores, id]);
    else await pool.query("INSERT INTO socios (nombre, externo, documento, nota, saldoInicial) VALUES (?, ?, ?, ?, ?)", valores);
  },

  /**
   * Cuenta de cada socio mes a mes: saldo inicial + neto de cada mes aprobado
   * - pagos. Lo que no le alcanza (saldo negativo) se acumula para el mes siguiente.
   */
  async cuentas(): Promise<CuentaSocio[]> {
    const socios = await this.socios();
    const [repartos] = await pool.query<RowDataPacket[]>("SELECT mes, datos FROM repartos_utilidades ORDER BY mes");
    const [pagos] = await pool.query<RowDataPacket[]>(
      "SELECT p.id, p.socioId, p.fecha, p.monto, p.nota, p.soporteUrl, u.nombre AS registradoPor FROM pagos_socios p LEFT JOIN usuarios u ON u.id = p.creadoPorId ORDER BY p.fecha, p.id",
    );
    const fotos = repartos.map((r) => ({ mes: String(r.mes), socios: json<{ socios?: RepartoSocio[] } | null>(r.datos, null)?.socios ?? [] }));
    return socios.map((s) => {
      const detalle = new Map<string, RepartoSocio>();
      for (const f of fotos) {
        const suyo = f.socios.find((x) => x.socioId === s.id);
        if (suyo) detalle.set(f.mes, suyo);
      }
      const suyos = pagos
        .filter((p) => p.socioId === s.id)
        .map((p) => ({
          id: p.id as number,
          fecha: dia(p.fecha)!,
          monto: Number(p.monto),
          nota: p.nota ?? null,
          soporteUrl: p.soporteUrl ?? null,
          registradoPor: p.registradoPor ?? null,
        }));
      const netos = new Map([...detalle.entries()].map(([m, d]) => [m, d.neto]));
      const meses = cuentaSocio(s.saldoInicial, netos, suyos).map((m) => {
        const d = detalle.get(m.mes);
        return {
          ...m,
          detalle: d ? { repartido: d.repartido, gmf: d.gmf, liquidado: d.liquidado, recibido: d.recibido, totalGastosPropios: d.totalGastosPropios } : null,
        };
      });
      return { ...s, meses, pagos: suyos, saldo: meses.at(-1)?.saldo ?? s.saldoInicial };
    });
  },

  /** Registra un pago a un socio ({ fecha, monto, nota?, soporteUrl? }). Negativo = lo que el socio le devolvio a la empresa. */
  async registrarPago(socioId: number, d: Record<string, unknown>, usuarioId: number | null): Promise<void> {
    const fecha = String(d.fecha ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new ErrorCuadro("Escribe la fecha del pago.");
    const monto = Number(d.monto);
    if (!Number.isFinite(monto) || monto === 0) throw new ErrorCuadro("Escribe el valor del pago.");
    const soporte = String(d.soporteUrl ?? "").trim() || null;
    if (soporte && !/^https?:\/\/\S+$/i.test(soporte)) throw new ErrorCuadro("El soporte debe ser un link (https://...).");
    const [[s]] = await pool.query<RowDataPacket[]>("SELECT id FROM socios WHERE id = ?", [socioId]);
    if (!s) throw new ErrorCuadro("Ese socio no existe.");
    await pool.query("INSERT INTO pagos_socios (socioId, fecha, monto, nota, soporteUrl, creadoPorId) VALUES (?, ?, ?, ?, ?, ?)", [
      socioId,
      fecha,
      monto.toFixed(2),
      String(d.nota ?? "")
        .trim()
        .slice(0, 300) || null,
      soporte?.slice(0, 500) ?? null,
      usuarioId,
    ]);
  },

  /** Borra un pago a un socio (si se registro por error). */
  async borrarPago(id: number): Promise<void> {
    await pool.query("DELETE FROM pagos_socios WHERE id = ?", [id]);
  },

  /** Activa o desactiva un socio (los inactivos no salen al registrar gastos). */
  async activarSocio(id: number, activo: boolean): Promise<void> {
    await pool.query("UPDATE socios SET activo = ? WHERE id = ?", [activo ? 1 : 0, id]);
  },
};
