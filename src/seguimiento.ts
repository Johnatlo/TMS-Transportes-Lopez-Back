/**
 * Seguimiento despues del descargue y cartera.
 *
 * Toma las filas del cuadro pagos (src/cuadro.ts) y responde tres preguntas:
 *
 * 1. Papeles: ¿de que viajes ya descargados hay que perseguir los papeles?
 *    Desde el dia del descargue hay que comunicarse con el conductor todos
 *    los dias hasta que los papeles queden listos para facturar.
 * 2. Por facturar: viajes con los papeles listos y sin factura, o facturados
 *    sin numero o fecha (sin fecha no se sabe cuando vence).
 * 3. Cartera: facturas con numero y fecha que el cliente aun no paga (sin
 *    "fecha pago factura"), con su vencimiento ("fecha pago cliente", o si no
 *    esta, fecha de factura + dias de credito del cliente), las gestiones de
 *    cobro y la fecha en que el cliente prometio pagar. Avisa desde que pasa
 *    el vencimiento: hay que llamar y cobrar.
 *
 * Todas las alertas se activan cada dia: lo pendiente avisa todos los dias
 * hasta que alguien lo atiende ese dia (registra el seguimiento de los
 * papeles o una gestion de cobro); al dia siguiente vuelve a avisar. Lo
 * pendiente de facturar avisa todos los dias hasta que se factura.
 *
 * Las alertas se calculan con funciones puras (alertaPapeles, agruparCartera,
 * alertasDe) para poder probarlas sin base de datos.
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "./db";
import { cuadro, dia, ErrorCuadro, ESTADOS_PAPELES, hoyColombia, papelesListos, sumarDias } from "./cuadro";
import type { EstadoPapeles, FilaCuadro } from "./cuadro";
import { grupoDe, GRUPOS_DUENO } from "./duenos";
import type { GrupoDueno } from "./duenos";

/** Dias de credito si el cliente no tiene plazo configurado. */
export const DIAS_CREDITO_DEFECTO = 30;
/** Dias despues del descargue en que unos papeles sin radicar ya son urgentes. */
export const DIAS_PAPELES_DEMORADOS = 5;
/**
 * Los viajes cargados antes de esta fecha no generan alertas de papeles ni de
 * facturacion: se manejaron en el Excel y nunca se actualizaron en el TMS
 * (siguen en la lista, pero no llenan la campana). Las facturas con numero y
 * fecha si avisan siempre. Se cambia con SEGUIMIENTO_DESDE en el .env.
 */
export const SEGUIMIENTO_DESDE = /^\d{4}-\d{2}-\d{2}$/.test(process.env.SEGUIMIENTO_DESDE ?? "")
  ? process.env.SEGUIMIENTO_DESDE!
  : "2026-10-01";

export type NivelAlerta = "urgente" | "atencion";

export interface AlertaFila {
  nivel: NivelAlerta;
  motivos: string[];
  /** Hay que comunicarse con el conductor (nadie ha preguntado hoy). */
  comunicarse: boolean;
}

/** Dias de `desde` a `hasta` ("AAAA-MM-DD"); negativo si `hasta` es anterior. */
export function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T12:00:00Z`) - Date.parse(`${desde}T12:00:00Z`)) / 86_400_000);
}

/** Dia en Colombia ("AAAA-MM-DD") de un instante ISO. */
export const diaColombia = (iso: string) => new Date(Date.parse(iso) - 5 * 3_600_000).toISOString().slice(0, 10);

/** Viaje que aun no tiene factura (ni marcada ni con numero) y no esta anulado. */
const sinFactura = (f: FilaCuadro) =>
  !f.anulado && !f.facturado && !f.facturaNumero && !f.facturaFecha && !f.facturaFechaPago;

/** El viaje ya descargo: paso la fecha de descargue o los papeles ya salieron de "en ruta". */
export const descargo = (f: FilaCuadro, hoy: string) =>
  f.estadoPapeles !== "EN_RUTA" || (!!f.fechaDescargue && f.fechaDescargue <= hoy);

/**
 * Alerta de papeles de un viaje descargado que aun no esta listo para
 * facturar, o null si no hay nada que hacer.
 *
 * - Todos los clientes, desde el dia del descargue: si nadie ha preguntado
 *   hoy, hay que comunicarse con el conductor. Registrar el seguimiento la
 *   apaga hasta el dia siguiente.
 * - Urgente si faltan papeles o si ya pasaron DIAS_PAPELES_DEMORADOS dias.
 * - Sin alerta si el viaje cargo antes de `desde` (ver SEGUIMIENTO_DESDE).
 */
export function alertaPapeles(f: FilaCuadro, hoy: string, desde = ""): AlertaFila | null {
  if (f.fecha < desde) return null;
  if (!sinFactura(f) || papelesListos(f.estadoPapeles) || !descargo(f, hoy)) return null;
  const dias = f.fechaDescargue ? Math.max(0, diasEntre(f.fechaDescargue, hoy)) : null;
  const revisadoHoy = !!f.papelesRevisadoEn && diaColombia(f.papelesRevisadoEn) === hoy;
  // Ya se atendio hoy: vuelve a avisar manana.
  if (revisadoHoy) return null;
  const motivos: string[] = [
    f.papelesRevisadoEn
      ? `Comunicarse con el conductor: no se ha preguntado hoy por los papeles (ultima vez ${diaColombia(f.papelesRevisadoEn)}).`
      : "Comunicarse con el conductor: nadie ha preguntado por los papeles.",
  ];
  if (f.papelesCompletos === false) {
    motivos.push(`Faltan papeles${f.papelesFaltan ? `: ${f.papelesFaltan}` : ""}.`);
  }
  const demorado = dias !== null && dias >= DIAS_PAPELES_DEMORADOS;
  if (demorado) motivos.push(`Descargo hace ${dias} dias y los papeles aun no estan listos para facturar.`);

  return { nivel: demorado || f.papelesCompletos === false ? "urgente" : "atencion", motivos, comunicarse: true };
}

/**
 * Alerta de facturacion, todos los dias hasta que se factura: papeles listos
 * y sin factura (urgente desde DIAS_PAPELES_DEMORADOS dias), o facturado sin numero o sin fecha (no puede entrar a cartera).
 * Sin alerta si el viaje cargo antes de `desde`.
 */
export function alertaFacturacion(f: FilaCuadro, hoy: string, desde = ""): AlertaFila | null {
  if (f.anulado || f.facturaFechaPago || f.fecha < desde) return null;
  if (sinFactura(f) && papelesListos(f.estadoPapeles)) {
    const dias = f.fechaRadicado ? Math.max(0, diasEntre(f.fechaRadicado, hoy)) : null;
    return {
      nivel: dias !== null && dias >= DIAS_PAPELES_DEMORADOS ? "urgente" : "atencion",
      motivos: [
        dias === null || dias === 0 ? "Listo para facturar: falta la factura." : `Listo para facturar hace ${dias} dias y sin factura.`,
      ],
      comunicarse: false,
    };
  }
  if ((f.facturado || f.facturaNumero || f.facturaFecha) && (!f.facturaNumero || !f.facturaFecha)) {
    return {
      nivel: "atencion",
      motivos: [`Facturado sin ${!f.facturaNumero ? "numero" : "fecha"} de factura: no entra a cartera hasta tenerlo.`],
      comunicarse: false,
    };
  }
  return null;
}

/** Plazo y contacto de cobro de un cliente. */
export interface PlazoCliente {
  empresa: string;
  diasCredito: number;
  contacto: string | null;
  telefono: string | null;
  correo: string | null;
}

/** Ultima gestion de cobro de una factura. */
export interface GestionCobro {
  id: number;
  facturaNumero: string;
  empresa: string;
  texto: string;
  compromisoPago: string | null;
  autor: string | null;
  creadaEn: string;
}

export interface ViajeFactura {
  id: number;
  fecha: string;
  placa: string;
  manifiesto: string | null;
  remision: string | null;
  valorFlete: number | null;
  /** Socio dueno del vehiculo o TERCEROS (filtro por dueno). */
  dueno: GrupoDueno;
}

/** Valor de una placa dentro de una factura (antes del anticipo del cliente). */
export interface PlacaFactura {
  placa: string;
  dueno: GrupoDueno;
  valor: number;
}

/**
 * Saldo de cartera sin viaje (cartera_saldos): factura pendiente de antes de
 * septiembre de 2026, cargada con su valor por placa.
 */
export interface SaldoCartera {
  facturaNumero: string;
  empresa: string;
  fechaFactura: string;
  fechaVence: string | null;
  placas: PlacaFactura[];
}

/** Una factura por cobrar (puede cubrir varios viajes). */
export interface FacturaCartera {
  facturaNumero: string;
  empresa: string;
  facturaFecha: string;
  diasCredito: number;
  /** "Fecha pago cliente" escrita en el cuadro, o fecha de factura + dias de credito. */
  vence: string;
  /** true si el vencimiento es la "fecha pago cliente" escrita a mano. */
  venceManual: boolean;
  /** Positivo: dias vencida. Negativo: dias que faltan. */
  diasVencida: number;
  /** Lo que el cliente debe: valorBruto - anticipoCliente. */
  valor: number;
  /** Valor de los viajes (o de las placas, en un saldo) antes del anticipo del cliente. */
  valorBruto: number;
  /** Anticipo o abono que el cliente ya pago de esta factura. */
  anticipoCliente: number;
  /** true: saldo de antes de septiembre cargado sin viajes. */
  sinViaje: boolean;
  /** Viajes sin valor de flete: el total de la factura esta incompleto. */
  viajesSinValor: number;
  viajes: ViajeFactura[];
  /** Valor por placa (de los viajes, o del saldo). */
  placas: PlacaFactura[];
  /** Lo que debe el cliente repartido por dueno de los vehiculos (suma `valor`). */
  porDueno: Partial<Record<GrupoDueno, number>>;
  ultimaGestion: GestionCobro | null;
  /** Ultimo compromiso de pago del cliente. */
  compromisoPago: string | null;
  alerta: AlertaFila | null;
}

/** Totales de cartera de un cliente, por edades de vencimiento. */
export interface ResumenCliente {
  empresa: string;
  diasCredito: number;
  facturas: number;
  total: number;
  porVencer: number;
  vencido1a30: number;
  vencido31a60: number;
  vencido61a90: number;
  vencidoMas90: number;
}

/**
 * Alerta de cobro de una factura sin pagar: empieza cuando pasa la fecha pago
 * cliente (el vencimiento) o la fecha en que el cliente prometio pagar, y
 * avisa todos los dias hasta que se registra la fecha pago factura. El dia en
 * que ya se anoto una gestion de cobro (`gestionHoy`) no avisa. Antes del
 * vencimiento no hay alerta.
 */
export function alertaFactura(vence: string, compromisoPago: string | null, hoy: string, gestionHoy = false): AlertaFila | null {
  if (gestionHoy) return null;
  const motivos: string[] = [];
  const diasVencida = diasEntre(vence, hoy);
  if (diasVencida > 0) motivos.push(`Vencida hace ${diasVencida} dias: llamar al cliente y cobrar.`);
  if (compromisoPago && compromisoPago < hoy) {
    motivos.push(`El cliente prometio pagar el ${compromisoPago} y no se ha registrado el pago.`);
  }
  return motivos.length ? { nivel: "urgente", motivos, comunicarse: false } : null;
}

/**
 * Reparte lo que debe el cliente (neto) entre los duenos de las placas, en
 * proporcion al valor de cada placa: si hubo anticipo del cliente, cada dueno
 * carga su parte. Los redondeos se ajustan en el grupo mas grande para que la
 * suma de exactamente el neto.
 */
export function repartirPorDueno(placas: PlacaFactura[], neto: number): Partial<Record<GrupoDueno, number>> {
  const bruto = placas.reduce((s, p) => s + p.valor, 0);
  const reparto: Partial<Record<GrupoDueno, number>> = {};
  if (bruto <= 0 || neto <= 0) return reparto;
  for (const p of placas) reparto[p.dueno] = (reparto[p.dueno] ?? 0) + Math.round((p.valor * neto) / bruto);
  const grupos = Object.keys(reparto) as GrupoDueno[];
  const diferencia = neto - grupos.reduce((s, g) => s + reparto[g]!, 0);
  if (diferencia) {
    const mayor = grupos.sort((a, b) => reparto[b]! - reparto[a]!)[0];
    reparto[mayor] = reparto[mayor]! + diferencia;
  }
  return reparto;
}

/**
 * Agrupa por factura (numero + empresa) los viajes facturados con numero y
 * fecha que aun no se han cobrado, les suma los saldos sin viaje pendientes,
 * resta el anticipo del cliente de cada factura y calcula vencimiento y
 * alerta. Las facturas mas vencidas primero.
 */
export function agruparCartera(
  filas: FilaCuadro[],
  plazos: Map<string, number>,
  gestiones: Map<string, GestionCobro>,
  hoy: string,
  extras: { saldos?: SaldoCartera[]; anticipos?: Map<string, number> } = {}
): FacturaCartera[] {
  const anticipos = extras.anticipos ?? new Map<string, number>();
  const grupos = new Map<string, FilaCuadro[]>();
  for (const f of filas) {
    if (f.anulado || f.facturaFechaPago || !f.facturaNumero || !f.facturaFecha) continue;
    const llave = `${f.facturaNumero}|${f.empresa}`;
    grupos.set(llave, [...(grupos.get(llave) ?? []), f]);
  }

  /** Arma la factura con lo comun a viajes y saldos. */
  const factura = (
    llave: string,
    base: { facturaNumero: string; empresa: string; facturaFecha: string; venceEscrito: string | null },
    placas: PlacaFactura[],
    resto: Pick<FacturaCartera, "sinViaje" | "viajesSinValor" | "viajes">
  ): FacturaCartera => {
    const diasCredito = plazos.get(base.empresa) ?? DIAS_CREDITO_DEFECTO;
    // La fecha pago cliente escrita manda; si no hay, se calcula.
    const vence = base.venceEscrito ?? sumarDias(base.facturaFecha, diasCredito);
    const ultimaGestion = gestiones.get(llave) ?? null;
    const compromisoPago = ultimaGestion?.compromisoPago ?? null;
    const valorBruto = placas.reduce((s, p) => s + p.valor, 0);
    const anticipoCliente = anticipos.get(llave) ?? 0;
    const valor = Math.max(0, valorBruto - anticipoCliente);
    return {
      facturaNumero: base.facturaNumero,
      empresa: base.empresa,
      facturaFecha: base.facturaFecha,
      diasCredito,
      vence,
      venceManual: !!base.venceEscrito,
      diasVencida: diasEntre(vence, hoy),
      valor,
      valorBruto,
      anticipoCliente,
      ...resto,
      placas,
      porDueno: repartirPorDueno(placas, valor),
      ultimaGestion,
      compromisoPago,
      alerta: alertaFactura(vence, compromisoPago, hoy, !!ultimaGestion && diaColombia(ultimaGestion.creadaEn) === hoy),
    };
  };

  const facturas: FacturaCartera[] = [];
  for (const [llave, viajes] of grupos) {
    const { facturaNumero, empresa } = viajes[0];
    facturas.push(
      factura(
        llave,
        {
          facturaNumero: facturaNumero!,
          empresa,
          // Si los viajes tienen fechas distintas, cuenta la mas antigua.
          facturaFecha: viajes.map((v) => v.facturaFecha!).sort()[0],
          venceEscrito: viajes.map((v) => v.facturaVence).filter((v): v is string => !!v).sort()[0] ?? null,
        },
        viajes.map((v) => ({ placa: v.placa, dueno: grupoDe(v.dueno), valor: v.valorFlete ?? 0 })),
        {
          sinViaje: false,
          viajesSinValor: viajes.filter((v) => v.valorFlete === null).length,
          viajes: viajes.map((v) => ({
            id: v.id,
            fecha: v.fecha,
            placa: v.placa,
            manifiesto: v.manifiesto,
            remision: v.remision,
            valorFlete: v.valorFlete,
            dueno: grupoDe(v.dueno),
          })),
        }
      )
    );
  }
  for (const s of extras.saldos ?? []) {
    facturas.push(
      factura(
        `${s.facturaNumero}|${s.empresa}`,
        { facturaNumero: s.facturaNumero, empresa: s.empresa, facturaFecha: s.fechaFactura, venceEscrito: s.fechaVence },
        s.placas,
        { sinViaje: true, viajesSinValor: 0, viajes: [] }
      )
    );
  }
  return facturas.sort((a, b) => b.diasVencida - a.diasVencida || a.facturaNumero.localeCompare(b.facturaNumero));
}

/**
 * Solo la parte de un dueno: las facturas con vehiculos suyos, cada una con
 * lo que le toca (porDueno) como valor. Asi los totales y las edades de
 * cartera quedan por dueno.
 */
export function carteraDeDueno(facturas: FacturaCartera[], grupo: GrupoDueno): FacturaCartera[] {
  return facturas
    .filter((f) => (f.porDueno[grupo] ?? 0) > 0)
    .map((f) => ({ ...f, valor: f.porDueno[grupo]! }));
}

/** Totales por cliente con edades de vencimiento (0, 1-30, 31-60, 61-90, +90 dias). */
export function resumirPorCliente(facturas: FacturaCartera[]): ResumenCliente[] {
  const porCliente = new Map<string, ResumenCliente>();
  for (const f of facturas) {
    const r = porCliente.get(f.empresa) ?? {
      empresa: f.empresa,
      diasCredito: f.diasCredito,
      facturas: 0,
      total: 0,
      porVencer: 0,
      vencido1a30: 0,
      vencido31a60: 0,
      vencido61a90: 0,
      vencidoMas90: 0,
    };
    r.facturas++;
    r.total += f.valor;
    const d = f.diasVencida;
    if (d <= 0) r.porVencer += f.valor;
    else if (d <= 30) r.vencido1a30 += f.valor;
    else if (d <= 60) r.vencido31a60 += f.valor;
    else if (d <= 90) r.vencido61a90 += f.valor;
    else r.vencidoMas90 += f.valor;
    porCliente.set(f.empresa, r);
  }
  return [...porCliente.values()].sort((a, b) => b.total - a.total);
}

export type TipoAlerta = "PAPELES" | "FACTURACION" | "CARTERA" | "ANTICIPO_EMPRESA";

/**
 * Alerta del anticipo que da la empresa (clientes del Zorro, Aburra Limpio y
 * viajes sin manifiesto): avisa todos los dias hasta que se escriben el valor
 * y la fecha en que la empresa lo pago. Sin alerta antes de `desde`.
 */
export function alertaAnticipoEmpresa(f: FilaCuadro, desde = ""): AlertaFila | null {
  if (f.fecha < desde) return null;
  if (f.estadoAnticipoEmpresa === "FALTA_REGISTRAR") {
    return { nivel: "atencion", motivos: ["Falta registrar el anticipo que da la empresa y la fecha en que lo pago."], comunicarse: false };
  }
  if (f.estadoAnticipoEmpresa === "POR_COBRAR") {
    return {
      nivel: "atencion",
      motivos: [`La empresa debe el anticipo de ${Math.round(f.anticipoEmpresa ?? 0).toLocaleString("es-CO")}: registra la fecha en que lo pague.`],
      comunicarse: false,
    };
  }
  return null;
}

/** Totales del anticipo de la empresa por cliente (para cobrar). */
export interface ResumenAnticipoEmpresa {
  empresa: string;
  /** Viajes a los que aun no se les escribe el anticipo. */
  faltaRegistrar: number;
  /** Viajes con anticipo escrito y sin pagar, y cuanto suman. */
  viajesPorCobrar: number;
  porCobrar: number;
  /** Lo que ya pago. */
  pagado: number;
}

/** Resumen por cliente de los viajes con anticipo de la empresa (mas por cobrar primero). */
export function resumirAnticiposEmpresa(filas: FilaCuadro[]): ResumenAnticipoEmpresa[] {
  const porEmpresa = new Map<string, ResumenAnticipoEmpresa>();
  for (const f of filas) {
    if (f.estadoAnticipoEmpresa === "NO_APLICA") continue;
    const r = porEmpresa.get(f.empresa) ?? { empresa: f.empresa, faltaRegistrar: 0, viajesPorCobrar: 0, porCobrar: 0, pagado: 0 };
    if (f.estadoAnticipoEmpresa === "FALTA_REGISTRAR") r.faltaRegistrar++;
    if (f.estadoAnticipoEmpresa === "POR_COBRAR") {
      r.viajesPorCobrar++;
      r.porCobrar += f.anticipoEmpresa ?? 0;
    }
    if (f.estadoAnticipoEmpresa === "PAGADO") r.pagado += f.anticipoEmpresa ?? 0;
    porEmpresa.set(f.empresa, r);
  }
  return [...porEmpresa.values()].sort((a, b) => b.porCobrar - a.porCobrar || b.faltaRegistrar - a.faltaRegistrar);
}

/** Una alerta de la campana de seguimiento. */
export interface AlertaSeguimiento {
  tipo: TipoAlerta;
  nivel: NivelAlerta;
  titulo: string;
  motivos: string[];
  /** Fila del cuadro (papeles y facturacion). */
  cuadroId?: number;
  /** Factura (cartera). */
  facturaNumero?: string;
  empresa?: string;
}

/** Todas las alertas: urgentes primero, luego papeles, facturacion y cartera. */
export function alertasDe(filas: FilaCuadro[], facturas: FacturaCartera[], hoy: string, desde = ""): AlertaSeguimiento[] {
  const titulo = (f: FilaCuadro) =>
    `${f.placa} · ${f.empresa}${f.manifiesto ? ` · manifiesto ${f.manifiesto}` : f.remision ? ` · remision ${f.remision}` : ""}`;
  const lista: AlertaSeguimiento[] = [];
  for (const f of filas) {
    const p = alertaPapeles(f, hoy, desde);
    if (p) lista.push({ tipo: "PAPELES", nivel: p.nivel, titulo: titulo(f), motivos: p.motivos, cuadroId: f.id });
    const fa = alertaFacturacion(f, hoy, desde);
    if (fa) lista.push({ tipo: "FACTURACION", nivel: fa.nivel, titulo: titulo(f), motivos: fa.motivos, cuadroId: f.id });
    const ae = alertaAnticipoEmpresa(f, desde);
    if (ae) lista.push({ tipo: "ANTICIPO_EMPRESA", nivel: ae.nivel, titulo: titulo(f), motivos: ae.motivos, cuadroId: f.id });
  }
  for (const fc of facturas) {
    if (!fc.alerta) continue;
    lista.push({
      tipo: "CARTERA",
      nivel: fc.alerta.nivel,
      titulo: `Factura ${fc.facturaNumero} · ${fc.empresa}`,
      motivos: fc.alerta.motivos,
      facturaNumero: fc.facturaNumero,
      empresa: fc.empresa,
    });
  }
  const orden: Record<TipoAlerta, number> = { PAPELES: 0, FACTURACION: 1, CARTERA: 2, ANTICIPO_EMPRESA: 3 };
  return lista.sort((a, b) => (a.nivel === b.nivel ? orden[a.tipo] - orden[b.tipo] : a.nivel === "urgente" ? -1 : 1));
}

/** Fila del cuadro con su alerta de papeles y de facturacion. */
export type FilaSeguimiento = FilaCuadro & { alertaPapeles: AlertaFila | null; alertaFacturacion: AlertaFila | null };

/** Llave de una factura en los mapas: "numero|empresa" (el mismo numero puede repetirse entre clientes). */
const llaveFactura = (numero: string, empresa: string) => `${numero}|${empresa}`;

/** Lectura y escritura del seguimiento de papeles y de la cartera. */
export const seguimiento = {
  /**
   * Viajes sin factura (descargados o en ruta) con su alerta de papeles y de
   * facturacion: lo que se persigue antes de facturar.
   */
  async papeles(): Promise<FilaSeguimiento[]> {
    const hoy = hoyColombia();
    const filas = await cuadro.listar();
    return filas
      .filter((f) => !f.anulado && !f.facturaFechaPago && (!f.facturaNumero || !f.facturaFecha))
      .map((f) => ({
        ...f,
        alertaPapeles: alertaPapeles(f, hoy, SEGUIMIENTO_DESDE),
        alertaFacturacion: alertaFacturacion(f, hoy, SEGUIMIENTO_DESDE),
      }));
  },

  /**
   * Registra lo que se supo de los papeles (al llamar al conductor): donde
   * estan, quien los tiene, si estan completos y que falta. Marca la hora y el
   * usuario (asi la alerta de "comunicarse" se apaga por hoy) y deja una nota
   * en el viaje con lo registrado.
   */
  async registrarPapeles(id: number, d: Record<string, unknown>, usuarioId: number | null) {
    const actual = await cuadro.obtener(id);
    if (!actual) return null;
    if ("estadoPapeles" in d) {
      if (!(ESTADOS_PAPELES as string[]).includes(String(d.estadoPapeles))) throw new ErrorCuadro("Estado de papeles no valido.");
      if (d.estadoPapeles !== actual.estadoPapeles) await cuadro.actualizar(id, { estadoPapeles: d.estadoPapeles });
    }
    const texto = (v: unknown, max: number) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim().slice(0, max));
    const tiene = "papelesTiene" in d ? texto(d.papelesTiene, 150) : actual.papelesTiene;
    const completos = "papelesCompletos" in d ? (d.papelesCompletos === null ? null : !!d.papelesCompletos) : actual.papelesCompletos;
    // Si estan completos no falta nada.
    const faltan = completos ? null : "papelesFaltan" in d ? texto(d.papelesFaltan, 300) : actual.papelesFaltan;
    if (completos === false && !faltan) throw new ErrorCuadro("Escribe que papeles faltan.");
    await pool.query(
      `UPDATE cuadro_viajes SET papelesTiene = ?, papelesCompletos = ?, papelesFaltan = ?,
              papelesRevisadoEn = ?, papelesRevisadoPorId = ? WHERE id = ?`,
      [tiene, completos === null ? null : completos ? 1 : 0, faltan, new Date(), usuarioId, id]
    );

    const estado = (("estadoPapeles" in d ? d.estadoPapeles : actual.estadoPapeles) as EstadoPapeles);
    const partes = [`Papeles: ${ETIQUETA_PAPELES[estado]}`];
    if (tiene) partes.push(`los tiene ${tiene}`);
    if (completos === true) partes.push("estan completos");
    if (completos === false) partes.push(`faltan: ${faltan}`);
    const nota = texto(d.nota, 600);
    await cuadro.agregarNota(id, `${partes.join(" · ")}.${nota ? ` ${nota}` : ""}`, usuarioId);
    return cuadro.obtener(id);
  },

  /** Plazos de credito y contactos de cobro de los clientes. */
  async plazos(): Promise<PlazoCliente[]> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM cartera_clientes ORDER BY empresa");
    return rows.map((r) => ({
      empresa: r.empresa,
      diasCredito: Number(r.diasCredito),
      contacto: r.contacto ?? null,
      telefono: r.telefono ?? null,
      correo: r.correo ?? null,
    }));
  },

  /** Crea o cambia el plazo y el contacto de cobro de un cliente. */
  async guardarPlazo(d: Record<string, unknown>) {
    const empresa = String(d.empresa ?? "").trim().toUpperCase();
    if (!empresa) throw new ErrorCuadro("Falta la empresa.");
    const dias = Number(d.diasCredito);
    if (!Number.isInteger(dias) || dias < 0 || dias > 365) throw new ErrorCuadro("Los dias de credito van de 0 a 365.");
    const texto = (v: unknown) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim());
    await pool.query(
      `INSERT INTO cartera_clientes (empresa, diasCredito, contacto, telefono, correo) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE diasCredito = VALUES(diasCredito), contacto = VALUES(contacto),
                               telefono = VALUES(telefono), correo = VALUES(correo)`,
      [empresa, dias, texto(d.contacto), texto(d.telefono), texto(d.correo)]
    );
  },

  /** Ultima gestion de cobro de cada factura, por llave "numero|empresa". */
  async ultimasGestiones(): Promise<Map<string, GestionCobro>> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT g.*, u.nombre AS autor FROM cartera_gestiones g
         LEFT JOIN usuarios u ON u.id = g.usuarioId
        WHERE g.id IN (SELECT MAX(id) FROM cartera_gestiones GROUP BY facturaNumero, empresa)`
    );
    return new Map(rows.map((r) => [llaveFactura(r.facturaNumero, r.empresa), mapearGestion(r)]));
  },

  /**
   * Cartera completa: facturas por cobrar con vencimiento y alerta, totales
   * por cliente, y los viajes facturados que no tienen numero o fecha (no
   * pueden calcular su vencimiento).
   */
  async cartera(dueno?: string) {
    const hoy = hoyColombia();
    const [filas, plazos, gestiones, saldos, anticipos] = await Promise.all([
      cuadro.listar(),
      this.plazos(),
      this.ultimasGestiones(),
      this.saldosPendientes(),
      this.anticiposCliente(),
    ]);
    const todas = agruparCartera(filas, new Map(plazos.map((p) => [p.empresa, p.diasCredito])), gestiones, hoy, {
      saldos,
      anticipos,
    });
    // Filtro por dueno: solo la parte de sus vehiculos en cada factura.
    const grupo = GRUPOS_DUENO.find((g) => g === String(dueno ?? "").toUpperCase());
    const facturas = grupo ? carteraDeDueno(todas, grupo) : todas;
    return {
      hoy,
      dueno: grupo ?? null,
      facturas,
      clientes: resumirPorCliente(facturas),
      sinDatos: filas.filter((f) => !f.anulado && !f.facturaFechaPago && (f.facturado || f.facturaNumero || f.facturaFecha) && (!f.facturaNumero || !f.facturaFecha)),
      plazos,
    };
  },

  /**
   * Saldos sin viaje que el cliente aun no paga, con su valor por placa y el
   * dueno de cada placa (segun el vehiculo del catalogo; si no esta, tercero).
   */
  async saldosPendientes(): Promise<SaldoCartera[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT s.id, s.facturaNumero, s.empresa, s.fechaFactura, s.fechaVence, p.placa, p.valor,
              (SELECT ve.dueno FROM vehiculos ve WHERE REPLACE(ve.placa, '-', '') = REPLACE(p.placa, '-', '') LIMIT 1) AS dueno
         FROM cartera_saldos s
         LEFT JOIN cartera_saldos_placas p ON p.saldoId = s.id
        WHERE s.fechaPago IS NULL
        ORDER BY s.id, p.id`
    );
    const porId = new Map<number, SaldoCartera>();
    for (const r of rows) {
      const saldo: SaldoCartera = porId.get(r.id) ?? {
        facturaNumero: r.facturaNumero,
        empresa: r.empresa,
        fechaFactura: dia(r.fechaFactura)!,
        fechaVence: dia(r.fechaVence),
        placas: [],
      };
      if (r.placa) saldo.placas.push({ placa: r.placa, dueno: grupoDe(r.dueno), valor: Number(r.valor) });
      porId.set(r.id, saldo);
    }
    return [...porId.values()];
  },

  /** Anticipo del cliente de cada factura, por llave "numero|empresa". */
  async anticiposCliente(): Promise<Map<string, number>> {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT facturaNumero, empresa, valor FROM cartera_anticipos_cliente");
    return new Map(rows.map((r) => [`${r.facturaNumero}|${r.empresa}`, Number(r.valor)]));
  },

  /**
   * Guarda el anticipo (o abono) que el cliente ya pago de una factura; 0 o
   * vacio lo quita. Se resta de lo que debe en la cartera.
   */
  async guardarAnticipoCliente(d: Record<string, unknown>): Promise<void> {
    const facturaNumero = String(d.facturaNumero ?? "").trim();
    const empresa = String(d.empresa ?? "").trim();
    if (!facturaNumero || !empresa) throw new ErrorCuadro("Falta la factura.");
    const valor = d.valor === null || d.valor === undefined || String(d.valor).trim() === "" ? 0 : Number(d.valor);
    if (!Number.isFinite(valor) || valor < 0) throw new ErrorCuadro("El anticipo debe ser un valor positivo.");
    if (valor === 0) {
      await pool.query("DELETE FROM cartera_anticipos_cliente WHERE facturaNumero = ? AND empresa = ?", [facturaNumero, empresa]);
      return;
    }
    await pool.query(
      `INSERT INTO cartera_anticipos_cliente (facturaNumero, empresa, valor) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
      [facturaNumero, empresa, Math.round(valor)]
    );
  },

  /**
   * Anticipos que dan las empresas: los viajes que lo llevan (o a los que se
   * les escribio), con su estado, y el resumen por cliente para cobrar.
   */
  async anticiposEmpresas() {
    const filas = (await cuadro.listar()).filter((f) => f.estadoAnticipoEmpresa !== "NO_APLICA" || f.anticipoEmpresaNoAplica);
    return {
      viajes: filas.filter((f) => !f.anulado),
      empresas: resumirAnticiposEmpresa(filas),
    };
  },

  /**
   * Registra que la empresa pago el anticipo de varios viajes ({ ids, fecha }).
   * Solo los que tienen valor escrito y aun no tienen fecha de pago.
   */
  async pagarAnticiposEmpresa(d: Record<string, unknown>): Promise<number> {
    const ids = (Array.isArray(d.ids) ? d.ids : []).map(Number).filter((x) => x > 0);
    const fecha = String(d.fecha ?? "").slice(0, 10);
    if (ids.length === 0) throw new ErrorCuadro("Elige al menos un viaje.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new ErrorCuadro("Escribe la fecha en que pago la empresa.");
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE cuadro_viajes SET anticipoEmpresaFechaPago = ?
        WHERE id IN (?) AND anticipoEmpresa > 0 AND anticipoEmpresaFechaPago IS NULL`,
      [fecha, ids]
    );
    return res.affectedRows;
  },

  /** Gestiones de cobro de una factura, la mas reciente primero. */
  async gestiones(facturaNumero: string, empresa: string): Promise<GestionCobro[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT g.*, u.nombre AS autor FROM cartera_gestiones g
         LEFT JOIN usuarios u ON u.id = g.usuarioId
        WHERE g.facturaNumero = ? AND g.empresa = ? ORDER BY g.id DESC`,
      [facturaNumero, empresa]
    );
    return rows.map(mapearGestion);
  },

  /** Anota una gestion de cobro (llamada, correo) y, si la hay, la fecha que prometio el cliente. */
  async agregarGestion(d: Record<string, unknown>, usuarioId: number | null) {
    const facturaNumero = String(d.facturaNumero ?? "").trim();
    const empresa = String(d.empresa ?? "").trim();
    const texto = String(d.texto ?? "").trim();
    if (!facturaNumero || !empresa) throw new ErrorCuadro("Falta la factura.");
    if (!texto) throw new ErrorCuadro("Escribe que se hablo con el cliente.");
    const compromiso = d.compromisoPago ? String(d.compromisoPago).slice(0, 10) : null;
    if (compromiso && !/^\d{4}-\d{2}-\d{2}$/.test(compromiso)) throw new ErrorCuadro("La fecha de compromiso no es valida.");
    await pool.query(
      "INSERT INTO cartera_gestiones (facturaNumero, empresa, texto, compromisoPago, usuarioId) VALUES (?, ?, ?, ?, ?)",
      [facturaNumero, empresa, texto.slice(0, 1000), compromiso, usuarioId]
    );
  },

  /**
   * Registra el pago de una factura: pone la fecha de pago en todos sus
   * viajes que aun no la tenian. Devuelve cuantos viajes quedaron pagados.
   */
  async registrarPago(d: Record<string, unknown>): Promise<number> {
    const facturaNumero = String(d.facturaNumero ?? "").trim();
    const empresa = String(d.empresa ?? "").trim();
    const fecha = String(d.fecha ?? "").slice(0, 10);
    if (!facturaNumero || !empresa) throw new ErrorCuadro("Falta la factura.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new ErrorCuadro("Escribe la fecha en que pago el cliente.");
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE cuadro_viajes SET facturaFechaPago = ?
        WHERE facturaNumero = ? AND empresa = ? AND facturaFechaPago IS NULL AND anulado = 0`,
      [fecha, facturaNumero, empresa]
    );
    // Si es un saldo sin viaje, queda pagado el saldo.
    const [saldo] = await pool.query<ResultSetHeader>(
      "UPDATE cartera_saldos SET fechaPago = ? WHERE facturaNumero = ? AND empresa = ? AND fechaPago IS NULL",
      [fecha, facturaNumero, empresa]
    );
    return res.affectedRows + saldo.affectedRows;
  },

  /** Alertas de la campana de seguimiento: papeles, facturacion y cartera. */
  async alertas() {
    const hoy = hoyColombia();
    const [filas, plazos, gestiones, saldos, anticipos] = await Promise.all([
      cuadro.listar(),
      this.plazos(),
      this.ultimasGestiones(),
      this.saldosPendientes(),
      this.anticiposCliente(),
    ]);
    const facturas = agruparCartera(filas, new Map(plazos.map((p) => [p.empresa, p.diasCredito])), gestiones, hoy, {
      saldos,
      anticipos,
    });
    const alertas = alertasDe(filas, facturas, hoy, SEGUIMIENTO_DESDE);
    return {
      hoy,
      urgentes: alertas.filter((a) => a.nivel === "urgente").length,
      alertas,
    };
  },
};

/** Nombre de cada estado de papeles para las notas (igual que en pantalla). */
const ETIQUETA_PAPELES: Record<EstadoPapeles, string> = {
  EN_RUTA: "en ruta",
  DESCARGADO: "ya descargo",
  CONDUCTOR: "con el conductor",
  PARQUEADERO: "en el parqueadero",
  OFICINA: "donde Don Alexander",
  RADICADO: "listos para facturar",
  RADICADOS: "radicados",
};

/** Fila de cartera_gestiones -> GestionCobro. */
function mapearGestion(r: RowDataPacket): GestionCobro {
  return {
    id: r.id,
    facturaNumero: r.facturaNumero,
    empresa: r.empresa,
    texto: r.texto,
    compromisoPago: dia(r.compromisoPago),
    autor: r.autor ?? null,
    creadaEn: new Date(r.creadaEn).toISOString(),
  };
}
