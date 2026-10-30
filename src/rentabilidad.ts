/**
 * Rentabilidad: cuanto deja cada viaje cuando el cliente le paga a la empresa
 * (reemplaza el Excel "ejemplo rentabilidad", una hoja por grupo de carros).
 *
 * Se alimenta de lo que ya esta en el sistema: el Cuadro pagos (flete,
 * factura y fechas), Anticipos (efectivo y combustible de la bomba) y Pago a
 * terceros (lo pactado con el tercero y su ICA). Lo que no esta en ningun
 * lado se escribe en el viaje (columnas rent* de cuadro_viajes); vacio = el
 * valor de siempre.
 *
 * Dos clases de grupo:
 * - TERCEROS: lo que paga el cliente con sus descuentos (saldo empresa) menos
 *   lo que se le paga al tercero con los suyos (saldo tercero) = rentabilidad,
 *   sin contar los otros descuentos (prestamos, descuentos del cliente), que
 *   bajan el saldo del tercero pero no son ganancia de la empresa;
 *   menos el anticipo de renta 3,5 % = ganancia. La comision de la matriz
 *   (como en los demas carros) se le descuenta a la empresa, no al tercero.
 * - Socios y carros propios (CELSO, MAURICIO, MILLER, SOCIEDAD, JTY-221,
 *   SWK-973, XGJ-197...): lo que paga el cliente menos todos los descuentos y
 *   el anticipo = lo que se le paga al dueno. La empresa se queda con la
 *   comision y T. Lopez.
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "./db";
import { cuadro, dia, ErrorCuadro } from "./cuadro";
import type { FilaCuadro } from "./cuadro";
import { icaSugerido, terceros } from "./terceros";

/** Retefuente 1 % + FOPAT 0,1 % (el FOPAT se suma desde que se genera el manifiesto). */
export const RETENCION_CLIENTE = 0.011;
/** Comision bancaria: 4 x 1000 + 5.000 por viaje. */
export const BANCARIA_POR_MIL = 4;
export const BANCARIA_FIJA = 5000;
/** Contribucion a la Supertransporte. */
export const SUPERTRANSPORTE = 0.001201;
/** Anticipo de renta. */
export const ANTICIPO_RENTA = 0.035;
/** Descargue en Cartones America (valor actual; ha cambiado con el tiempo). */
export const DESCARGUE_CAME = 198000;
/** Planilla - poliza RCE por manifiesto. */
export const POLIZA_RCE = 3000;

/** Grupos (hojas del Excel). Los que no estan aqui van por su socio o como PROPIOS. */
export const PLACAS_GRUPO: Record<string, string> = {
  SZX826: "CELSO",
  TLN860: "CELSO",
  TEK298: "CELSO",
  SOR429: "CELSO",
  JTY219: "MAURICIO",
  SZX880: "MAURICIO",
  SWO594: "MAURICIO",
  SRO029: "MAURICIO",
  SZP339: "MILLER",
  SKX202: "MILLER",
  XJB207: "SOCIEDAD",
  SPI982: "SOCIEDAD",
  JTY221: "JTY-221",
  SWK973: "SWK-973",
  XGJ197: "XGJ-197",
};
/** Orden de las pestanas y de las hojas del Excel. */
export const ORDEN_GRUPOS = ["TERCEROS", "CELSO", "MAURICIO", "MILLER", "SOCIEDAD", "JTY-221", "SWK-973", "XGJ-197"];
/** Dobletroque: sin descargue ni poliza (y el anticipo va en efectivo y combustible). */
const SIN_DESCARGUE_NI_POLIZA = new Set(["XGJ-197"]);

/** Grupo de un viaje: por la placa; si no, los terceros, el socio dueno o PROPIOS. */
export function grupoDe(placa: string, flota: string, dueno: string | null): string {
  const g = PLACAS_GRUPO[placa.replace(/[^A-Z0-9]/gi, "").toUpperCase()];
  if (g) return g;
  if (flota === "TERCERO" && !dueno) return "TERCEROS";
  return dueno ? dueno.toUpperCase() : "PROPIOS";
}

/** Una fila de la Matriz Comisiones: el cliente (texto que se busca en la empresa), comision y T. Lopez. */
export interface ComisionCliente {
  cliente: string;
  comision: number;
  tLopez: number;
}

/** Una fila de la Matriz Retenciones: el cliente y su ReteICA por mil. */
export interface RetencionCliente {
  cliente: string;
  reteicaPorMil: number;
  ciudad: string | null;
}

/** Texto sin tildes ni signos, en mayuscula, para comparar nombres de clientes. */
export const normalizar = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Otros nombres con que aparece un cliente en las matrices. */
const SINONIMOS: Array<[RegExp, string[]]> = [[/CORAME|CARTONES AMERICA/, ["CORAME", "CARTONES AMERICA"]]];

/**
 * La fila de una matriz que le toca a una empresa: la de nombre mas largo que
 * aparezca en ella (como el SEARCH del Excel). Las de URBANO solo para urbanos
 * y, para un urbano, primero esas.
 */
export function buscarEnMatriz<T extends { cliente: string }>(matriz: T[], empresa: string, urbano = false): T | null {
  const e = normalizar(empresa);
  const nombres = [e, ...SINONIMOS.filter(([re]) => re.test(e)).flatMap(([, s]) => s)];
  // Un urbano tambien se busca como "<cliente> URBANO" (CORAME URBANO).
  const textos = urbano ? [...nombres, ...nombres.map((t) => `${t} URBANO`)] : nombres;
  const candidatas = matriz
    .map((m) => ({ m, clave: normalizar(m.cliente) }))
    .filter(({ clave }) => clave && textos.some((t) => t.includes(clave)))
    .filter(({ clave }) => urbano || !clave.includes("URBANO"))
    .sort((a, b) => Number(b.clave.includes("URBANO")) - Number(a.clave.includes("URBANO")) || b.clave.length - a.clave.length);
  return candidatas[0]?.m ?? null;
}

/** Lo escrito a mano en el viaje para la rentabilidad (null = el de siempre). */
export interface AjustesRentabilidad {
  rentComision: number | null;
  rentTLopez: number | null;
  rentDescargue: number | null;
  rentPoliza: number | null;
  rentIcaPorMil: number | null;
  fechaPagoRentabilidad: string | null;
  /** Retenciones corregidas o desmarcadas; las que no estan, se calculan y aplican. */
  rentRetenciones: Partial<Record<ClaveRetencion, AjusteRetencion>>;
  /** Otros descuentos al tercero o dueno, y su concepto. */
  rentOtrosDescuentos: number | null;
  rentOtrosConcepto: string | null;
}

/**
 * Retenciones que se pueden corregir en cada viaje: `retencion`,
 * `reteIca` y `supertransporte` se sacan del flete de la empresa; las
 * `...Tercero`, del flete pactado con el tercero; `bancaria` (4 x 1000 + 5.000),
 * del flete del tercero o del dueno.
 */
export const CLAVES_RETENCION = ["retencion", "reteIca", "supertransporte", "bancaria", "retencionTercero", "reteIcaTercero", "supertransporteTercero"] as const;
export type ClaveRetencion = (typeof CLAVES_RETENCION)[number];

/** Lo escrito en una retencion: su valor (null = el calculado) y si aplica. */
export interface AjusteRetencion {
  valor: number | null;
  aplica: boolean;
}

/** Texto guardado en rentRetenciones -> ajustes validos (lo demas se ignora). */
export function leerRetenciones(texto: unknown): Partial<Record<ClaveRetencion, AjusteRetencion>> {
  let crudo: Record<string, { valor?: unknown; aplica?: unknown }> = {};
  try {
    crudo = JSON.parse(String(texto ?? "{}")) ?? {};
  } catch {
    return {};
  }
  const ajustes: Partial<Record<ClaveRetencion, AjusteRetencion>> = {};
  for (const clave of CLAVES_RETENCION) {
    const a = crudo[clave];
    if (!a) continue;
    const valor = a.valor === null || a.valor === undefined || a.valor === "" ? null : Number(a.valor);
    ajustes[clave] = { valor: valor !== null && Number.isFinite(valor) && valor >= 0 ? valor : null, aplica: a.aplica !== false };
  }
  return ajustes;
}

/** Lo que entra al calculo de un viaje. */
export interface EntradaRentabilidad extends AjustesRentabilidad {
  grupo: string;
  /** Lo que paga el cliente (valor del flete). */
  valorEmpresa: number;
  empresa: string;
  urbano: boolean;
  /** Reconocido de Cartones America (no es un viaje: sin descargue ni poliza). */
  reconocido: boolean;
  /** La primera fila de su remision (la comision va una vez por remision). */
  primeraDeRemision: boolean;
  /** La primera fila de su manifiesto (descargue y poliza van una vez por manifiesto). */
  primeraDeManifiesto: boolean;
  efectivo: number;
  combustible: number;
  transferencia: number;
  /** Terceros: valor pactado con el tercero (null = sin pactar) y su ICA por mil. */
  valorTercero: number | null;
  icaTerceroPorMil: number;
  comisionMatriz: ComisionCliente | null;
  icaMatriz: number | null;
}

/** Valores calculados de un viaje (en pesos, redondeados). */
export interface CalculoRentabilidad {
  retencion: number;
  icaPorMil: number;
  reteIca: number;
  /** Comision bancaria (4 x 1000 + 5.000): al flete del tercero o del dueno, nunca al de la empresa. */
  bancaria: number;
  supertransporte: number;
  /** Lo que da cada retencion sin ajustes (para mostrarlo en gris al editar). */
  retencionesCalculadas: Record<ClaveRetencion, number>;
  comision: number;
  tLopez: number;
  descargue: number;
  poliza: number;
  anticipo: number;
  anticipoRenta: number;
  /** Terceros: lo que le queda a la empresa del flete despues de sus descuentos. */
  saldoEmpresa: number;
  /** Terceros: lo pactado con el tercero y sus descuentos. */
  fleteTercero: number;
  retencionTercero: number;
  reteIcaTercero: number;
  supertransporteTercero: number;
  /** Otros descuentos al tercero o dueno (prestamos, descuentos del cliente): no son ganancia de la empresa. */
  otrosDescuentos: number;
  /** Terceros: lo que se le paga al tercero; socios: lo que se le paga al dueno. */
  saldoBeneficiario: number;
  /** Terceros: saldo empresa - saldo tercero - otros descuentos (antes del anticipo de renta). */
  rentabilidad: number;
  /** Lo que gana la empresa con el viaje. */
  ganancia: number;
}

const r = Math.round;

/** Calcula la rentabilidad de un viaje (exportado para las pruebas). */
export function calcular(e: EntradaRentabilidad): CalculoRentabilidad {
  const v = e.valorEmpresa;
  const icaPorMil = e.rentIcaPorMil ?? e.icaMatriz ?? icaSugerido(e.empresa);
  const p = e.valorTercero ?? 0;
  const terceros = e.grupo === "TERCEROS";
  // La comision bancaria sale del flete de quien recibe el pago: el tercero o el dueno.
  const baseBancaria = terceros ? p : v;
  const calculadas: Record<ClaveRetencion, number> = {
    retencion: r(v * RETENCION_CLIENTE),
    reteIca: r((v * icaPorMil) / 1000),
    supertransporte: r(v * SUPERTRANSPORTE),
    bancaria: baseBancaria > 0 ? r((baseBancaria * BANCARIA_POR_MIL) / 1000 + BANCARIA_FIJA) : 0,
    retencionTercero: r(p * RETENCION_CLIENTE),
    reteIcaTercero: r((p * e.icaTerceroPorMil) / 1000),
    supertransporteTercero: r(p * SUPERTRANSPORTE),
  };
  /** La retencion con lo escrito en el viaje: desmarcada 0; si no, su valor o el calculado. */
  const aplicada = (clave: ClaveRetencion) => {
    const a = e.rentRetenciones[clave];
    return a && !a.aplica ? 0 : a?.valor ?? calculadas[clave];
  };
  const retencion = aplicada("retencion");
  const reteIca = aplicada("reteIca");
  const bancaria = aplicada("bancaria");
  const supertransporte = aplicada("supertransporte");
  const otrosDescuentos = e.rentOtrosDescuentos ?? 0;
  const anticipo = e.efectivo + e.combustible + e.transferencia;

  if (terceros) {
    // La comision de la matriz, como en los demas carros: una vez por remision y con flete.
    const comision = e.rentComision ?? (e.primeraDeRemision && v > 0 ? e.comisionMatriz?.comision ?? 0 : 0);
    const tLopez = e.rentTLopez ?? 0;
    const poliza = e.rentPoliza ?? (e.primeraDeManifiesto && p > 0 ? POLIZA_RCE : 0);
    const saldoEmpresa = v - retencion - reteIca - supertransporte - comision - tLopez;
    const retencionTercero = aplicada("retencionTercero");
    const reteIcaTercero = aplicada("reteIcaTercero");
    const supertransporteTercero = aplicada("supertransporteTercero");
    // Gestion financiera del tercero = 4 x 1000 + 5.000 (bancaria) + Supertransporte.
    const saldoBeneficiario = p - retencionTercero - reteIcaTercero - bancaria - supertransporteTercero - poliza - otrosDescuentos;
    const rentabilidad = saldoEmpresa - saldoBeneficiario - otrosDescuentos;
    const anticipoRenta = r(rentabilidad * ANTICIPO_RENTA);
    return {
      retencion,
      icaPorMil,
      reteIca,
      bancaria,
      supertransporte,
      retencionesCalculadas: calculadas,
      comision,
      tLopez,
      descargue: 0,
      poliza,
      anticipo,
      anticipoRenta,
      saldoEmpresa,
      fleteTercero: p,
      retencionTercero,
      reteIcaTercero,
      supertransporteTercero,
      otrosDescuentos,
      saldoBeneficiario,
      rentabilidad,
      ganancia: rentabilidad - anticipoRenta,
    };
  }

  // Dobletroque, reconocidos y urbanos: sin descargue ni poliza; sin flete aun, tampoco.
  const sinExtras = SIN_DESCARGUE_NI_POLIZA.has(e.grupo) || e.reconocido || e.urbano || v <= 0;
  // Comision y T. Lopez una vez por remision, y solo cuando el viaje ya tiene flete.
  const cobra = e.primeraDeRemision && v > 0;
  const comision = e.rentComision ?? (cobra ? e.comisionMatriz?.comision ?? 0 : 0);
  const tLopez = e.rentTLopez ?? (cobra ? e.comisionMatriz?.tLopez ?? 0 : 0);
  const corame = /CORAME|CARTONES\s+AMERICA/i.test(e.empresa);
  const descargue = e.rentDescargue ?? (corame && !sinExtras && e.primeraDeManifiesto ? DESCARGUE_CAME : 0);
  const poliza = e.rentPoliza ?? (!sinExtras && e.primeraDeManifiesto ? POLIZA_RCE : 0);
  const anticipoRenta = r(v * ANTICIPO_RENTA);
  const saldoBeneficiario =
    v - retencion - reteIca - anticipoRenta - bancaria - supertransporte - comision - tLopez - descargue - poliza - anticipo - otrosDescuentos;
  return {
    retencion,
    icaPorMil,
    reteIca,
    bancaria,
    supertransporte,
    retencionesCalculadas: calculadas,
    comision,
    tLopez,
    descargue,
    poliza,
    anticipo,
    anticipoRenta,
    saldoEmpresa: v - retencion - reteIca - supertransporte,
    fleteTercero: 0,
    retencionTercero: 0,
    reteIcaTercero: 0,
    supertransporteTercero: 0,
    otrosDescuentos,
    saldoBeneficiario,
    rentabilidad: comision + tLopez,
    ganancia: comision + tLopez,
  };
}

/** Un viaje en la rentabilidad: sus datos del cuadro, lo escrito a mano y lo calculado. */
export interface FilaRentabilidad extends AjustesRentabilidad, CalculoRentabilidad {
  id: number;
  grupo: string;
  fecha: string;
  placa: string;
  /** Terceros: el dueno del vehiculo (como en Pago a terceros). */
  tercero: string | null;
  empresa: string;
  remision: string | null;
  manifiesto: string | null;
  facturaNumero: string | null;
  facturaFecha: string | null;
  valorEmpresa: number;
  efectivo: number;
  combustible: number;
  transferencia: number;
  /** Dias en que se entrego el anticipo: efectivo, combustible y transferencia. */
  fechasEfectivo: string[];
  fechasCombustible: string[];
  fechaTransferencia: string | null;
  /** Cuando pago el cliente (Cartera / Cuadro pagos). */
  fechaPagoEmpresa: string | null;
  /** Cuando se le pago al tercero o al dueno. */
  fechaPagoBeneficiario: string | null;
  concepto: string | null;
}

/** Repositorio de la rentabilidad y sus matrices. */
export const rentabilidad = {
  /** Todos los viajes no anulados, con su grupo y su rentabilidad (los mas recientes primero). */
  async listar(): Promise<FilaRentabilidad[]> {
    const filas = await cuadro.listar();
    const [datosTerceros, [ajustes], [bomba], matrices] = await Promise.all([
      terceros.listar(filas),
      pool.query<RowDataPacket[]>(
        `SELECT id, rentComision, rentTLopez, rentDescargue, rentPoliza, rentIcaPorMil, fechaPagoRentabilidad,
                rentRetenciones, rentOtrosDescuentos, rentOtrosConcepto
           FROM cuadro_viajes WHERE anulado = 0`
      ),
      pool.query<RowDataPacket[]>(
        `SELECT cuadroViajeId, SUM(COALESCE(efectivo, 0)) AS efectivo,
                SUM(COALESCE(combustible, valor - COALESCE(efectivo, 0))) AS combustible,
                GROUP_CONCAT(DISTINCT CASE WHEN efectivo > 0 THEN DATE_FORMAT(fecha, '%Y-%m-%d') END ORDER BY fecha) AS fechasEfectivo,
                GROUP_CONCAT(DISTINCT CASE WHEN COALESCE(combustible, valor - COALESCE(efectivo, 0)) > 0 THEN DATE_FORMAT(fecha, '%Y-%m-%d') END ORDER BY fecha) AS fechasCombustible
           FROM cuadro_anticipos GROUP BY cuadroViajeId`
      ),
      this.matrices(),
    ]);
    const deTercero = new Map(datosTerceros.viajes.map((v) => [v.id, v]));
    const ajustePor = new Map(ajustes.map((a) => [Number(a.id), a]));
    const dias = (x: unknown) => (x ? String(x).split(",") : []);
    const bombaPor = new Map(
      bomba.map((b) => [
        Number(b.cuadroViajeId),
        { efectivo: Number(b.efectivo), combustible: Number(b.combustible), fechasEfectivo: dias(b.fechasEfectivo), fechasCombustible: dias(b.fechasCombustible) },
      ])
    );
    const vivos = filas.filter((f) => !f.anulado).sort((a, b) => a.id - b.id);
    const remisiones = new Set<string>();
    const manifiestos = new Set<string>();
    const resultado = vivos.map((f: FilaCuadro): FilaRentabilidad => {
      const grupo = grupoDe(f.placa, f.flota, f.dueno);
      // Comision una vez por remision y descargue/poliza una vez por manifiesto (la primera fila).
      const claveRemision = `${f.placa}|${f.remision || f.manifiesto || `id${f.id}`}`;
      const primeraDeRemision = !remisiones.has(claveRemision);
      remisiones.add(claveRemision);
      const claveManifiesto = f.manifiesto ? `m${f.manifiesto}` : `id${f.id}`;
      const primeraDeManifiesto = !manifiestos.has(claveManifiesto);
      manifiestos.add(claveManifiesto);
      const a = ajustePor.get(f.id);
      const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));
      const ajustes: AjustesRentabilidad = {
        rentComision: num(a?.rentComision),
        rentTLopez: num(a?.rentTLopez),
        rentDescargue: num(a?.rentDescargue),
        rentPoliza: num(a?.rentPoliza),
        rentIcaPorMil: num(a?.rentIcaPorMil),
        fechaPagoRentabilidad: dia(a?.fechaPagoRentabilidad) ?? null,
        rentRetenciones: leerRetenciones(a?.rentRetenciones),
        rentOtrosDescuentos: num(a?.rentOtrosDescuentos),
        rentOtrosConcepto: a?.rentOtrosConcepto ?? null,
      };
      const t = deTercero.get(f.id);
      const b = bombaPor.get(f.id) ?? { efectivo: 0, combustible: 0, fechasEfectivo: [], fechasCombustible: [] };
      const entrada: EntradaRentabilidad = {
        ...ajustes,
        grupo,
        valorEmpresa: f.valorFlete ?? 0,
        empresa: f.empresa,
        urbano: f.urbano,
        reconocido: !!f.concepto,
        primeraDeRemision,
        primeraDeManifiesto,
        efectivo: b.efectivo,
        combustible: b.combustible,
        transferencia: f.anticipoTransferencia ?? 0,
        valorTercero: t?.valorTercero ?? null,
        icaTerceroPorMil: t?.icaPorMil ?? 0,
        comisionMatriz: buscarEnMatriz(matrices.comisiones, f.empresa, f.urbano),
        icaMatriz: buscarEnMatriz(matrices.retenciones, f.empresa)?.reteicaPorMil ?? null,
      };
      return {
        ...ajustes,
        ...calcular(entrada),
        id: f.id,
        grupo,
        fecha: f.fecha,
        placa: f.placa,
        tercero: t?.tercero ?? null,
        empresa: f.concepto ? `${f.empresa} (${f.concepto})` : f.empresa,
        remision: f.remision,
        manifiesto: f.manifiesto,
        facturaNumero: f.facturaNumero,
        facturaFecha: f.facturaFecha,
        valorEmpresa: entrada.valorEmpresa,
        efectivo: b.efectivo,
        combustible: b.combustible,
        transferencia: entrada.transferencia,
        fechasEfectivo: b.fechasEfectivo,
        fechasCombustible: b.fechasCombustible,
        fechaTransferencia: entrada.transferencia ? f.anticipoTransferenciaFecha : null,
        fechaPagoEmpresa: f.facturaFechaPago,
        fechaPagoBeneficiario: f.fechaPagoSaldo,
        concepto: f.concepto,
      };
    });
    return resultado.sort((x, y) => y.fecha.localeCompare(x.fecha) || y.id - x.id);
  },

  /** Las dos matrices (comisiones y retenciones por cliente). */
  async matrices(): Promise<{ comisiones: ComisionCliente[]; retenciones: RetencionCliente[] }> {
    const [[c], [rt]] = await Promise.all([
      pool.query<RowDataPacket[]>("SELECT cliente, comision, tLopez FROM rentabilidad_comisiones ORDER BY id"),
      pool.query<RowDataPacket[]>("SELECT cliente, reteicaPorMil, ciudad FROM rentabilidad_retenciones ORDER BY id"),
    ]);
    return {
      comisiones: c.map((x) => ({ cliente: String(x.cliente), comision: Number(x.comision), tLopez: Number(x.tLopez) })),
      retenciones: rt.map((x) => ({ cliente: String(x.cliente), reteicaPorMil: Number(x.reteicaPorMil), ciudad: x.ciudad ?? null })),
    };
  },

  /**
   * Reemplaza las matrices ({ comisiones: [{ cliente, comision, tLopez }],
   * retenciones: [{ cliente, reteicaPorMil, ciudad }] }). Las filas sin
   * cliente se ignoran. En una transaccion.
   */
  async guardarMatrices(d: Record<string, unknown>) {
    const lista = (x: unknown) => (Array.isArray(x) ? (x as Record<string, unknown>[]) : null);
    const comisiones = lista(d.comisiones);
    const retenciones = lista(d.retenciones);
    if (!comisiones && !retenciones) throw new ErrorCuadro("Envia las comisiones y/o las retenciones.");
    const numero = (x: unknown, campo: string) => {
      const n = Number(x ?? 0);
      if (!Number.isFinite(n) || n < 0) throw new ErrorCuadro(`"${campo}" no es un numero valido.`);
      return n;
    };
    const texto = (x: unknown) => String(x ?? "").trim().toUpperCase().slice(0, 160);
    const con = await pool.getConnection();
    try {
      await con.beginTransaction();
      if (comisiones) {
        await con.query("DELETE FROM rentabilidad_comisiones");
        for (const c of comisiones.filter((x) => texto(x.cliente))) {
          await con.query<ResultSetHeader>("INSERT INTO rentabilidad_comisiones (cliente, comision, tLopez) VALUES (?, ?, ?)", [
            texto(c.cliente),
            numero(c.comision, "comision"),
            numero(c.tLopez, "T. Lopez"),
          ]);
        }
      }
      if (retenciones) {
        await con.query("DELETE FROM rentabilidad_retenciones");
        for (const rt of retenciones.filter((x) => texto(x.cliente))) {
          await con.query<ResultSetHeader>("INSERT INTO rentabilidad_retenciones (cliente, reteicaPorMil, ciudad) VALUES (?, ?, ?)", [
            texto(rt.cliente),
            numero(rt.reteicaPorMil, "ReteICA"),
            texto(rt.ciudad) || null,
          ]);
        }
      }
      await con.commit();
    } catch (exc) {
      await con.rollback();
      throw exc;
    } finally {
      con.release();
    }
    return this.matrices();
  },
};
