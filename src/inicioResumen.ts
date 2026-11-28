/**
 * Resumen del Inicio (GET /api/inicio/resumen): lo que necesitan las tarjetas
 * de "Sofi te cuenta" y de dinero, armado en el servidor con los mismos
 * calculos de cada modulo (alertas de documentos, seguimiento de papeles y
 * facturacion, cartera, rentabilidad y reparto). Solo se calcula lo que pide
 * el Inicio (las tarjetas que el usuario tiene) y lo que su rol puede ver.
 *
 * "Sofi te cuenta" ordena lo pendiente en cuatro prioridades:
 * 1. Documentos por vencer: de la flota (SOAT y tecnomecanica), de los
 *    conductores (licencia) y de las dos empresas (poliza de carga y los
 *    documentos de Configuracion > Documentos de las empresas). De la flota y
 *    los conductores, solo los propios y los que viajaron hace poco (vigilados).
 * 2. Papeles: los que se deben (el viaje descargo y los papeles no han
 *    llegado) y el seguimiento de los que ya entrego el conductor.
 * 3. Facturacion: listos para facturar, enviados sin factura y facturados sin
 *    numero o sin fecha.
 * 4. Incidencias del sistema: errores del RNDC que quedaron de dias
 *    anteriores, manifiestos de contingencia, cumplidos con el plazo vencido,
 *    la sincronizacion con el RNDC y lo que SOFI dejo para revisar.
 */
import type { RowDataPacket } from "mysql2";
import { pool } from "./db";
import { cuadro, hoyColombia, papelesListos } from "./cuadro";
import type { FilaCuadro } from "./cuadro";
import { revisarVencimientos } from "./alertas";
import type { AlertaDocumento } from "./alertas";
import { documentosEmpresa, NOMBRE_EMPRESA } from "./documentosEmpresa";
import type { DocumentoEmpresa } from "./documentosEmpresa";
import { alertaContingencia, alertaFacturacion, alertaPapeles, diasEntre, DIAS_PAPELES_DEMORADOS, SEGUIMIENTO_DESDE, seguimiento } from "./seguimiento";
import type { NivelAlerta } from "./seguimiento";
import { contingencia } from "./contingencia";
import { plazoCumplido } from "./rndc/builders";
import { estadoSincronizacion } from "./rndc/sincronizacion";
import { filtroCuentas } from "./accesos";
import { puede, veRentabilidadEmpresa, veRentabilidadTerceros } from "./roles";
import type { Rol } from "./roles";
import { utilidades, vehiculosDeMyc } from "./utilidades";
import type { UtilidadesMes, VistaUtilidades } from "./utilidades";
import { rentabilidad } from "./rentabilidad";
import { sqlFlota } from "./flota";

/** Partes del resumen que se pueden pedir. */
export type ParteResumen = "sofi" | "cifras" | "cobros" | "rentabilidad" | "reparto";
export const PARTES_RESUMEN: ParteResumen[] = ["sofi", "cifras", "cobros", "rentabilidad", "reparto"];

/** Una cosa pendiente de "Sofi te cuenta". */
export interface ItemSofi {
  nivel: NivelAlerta;
  texto: string;
  detalle?: string;
  /** Pantalla que lo resuelve (con el viaje o el registro a abrir). */
  ruta: string;
}

/** Un grupo dentro de una prioridad (por ejemplo, "Papeles que se deben"). */
export interface GrupoSofi {
  titulo: string;
  total: number;
  urgentes: number;
  /** Los primeros MAX_ITEMS_GRUPO (urgentes primero). */
  items: ItemSofi[];
  /** Pantalla con la lista completa. */
  ruta: string;
}

/** Una de las cuatro prioridades. */
export interface PrioridadSofi {
  numero: number;
  titulo: string;
  grupos: GrupoSofi[];
}

/** Cuantas cosas se muestran por grupo (el resto se ve en su pantalla). */
export const MAX_ITEMS_GRUPO = 5;
/** Dias antes del vencimiento en que un documento ya es urgente. */
export const DIAS_DOCUMENTO_URGENTE = 7;
/** Dias antes del vencimiento en que avisa un documento de la empresa. */
export const DIAS_AVISO_EMPRESA = 30;
/**
 * Dias hacia atras en que un vehiculo o conductor de afuera cuenta como
 * activo: sus documentos avisan si viajo con nosotros en ese tiempo (los de
 * la flota propia y los empleados avisan siempre).
 */
export const DIAS_RECIENTE = 90;

/**
 * Los vehiculos y conductores cuyos documentos importan: la flota propia y
 * los empleados (sin retiro), y los de afuera que viajaron en los ultimos
 * DIAS_RECIENTE dias. Un tercero que no volvio no es una alarma.
 */
async function vigilados(): Promise<{ vehiculos: Set<number>; conductores: Set<number> }> {
  const [[vehiculos], [conductores]] = await Promise.all([
    pool.query<RowDataPacket[]>(
      `SELECT ve.id FROM vehiculos ve
        WHERE ${sqlFlota("ve")} <> 'TERCERO'
           OR EXISTS (SELECT 1 FROM viajes v WHERE v.vehiculoId = ve.id AND v.estado <> 'ANULADO' AND v.fechaCreacion >= DATE_SUB(NOW(), INTERVAL ? DAY))`,
      [DIAS_RECIENTE],
    ),
    pool.query<RowDataPacket[]>(
      `SELECT c.id FROM conductores c
        WHERE EXISTS (SELECT 1 FROM empleados e WHERE e.fechaRetiro IS NULL AND (e.conductorId = c.id OR e.cedula = c.cedula))
           OR EXISTS (SELECT 1 FROM viajes v WHERE (v.conductorId = c.id OR v.conductor2Id = c.id) AND v.estado <> 'ANULADO'
                        AND v.fechaCreacion >= DATE_SUB(NOW(), INTERVAL ? DAY))`,
      [DIAS_RECIENTE],
    ),
  ]);
  return { vehiculos: new Set(vehiculos.map((v) => Number(v.id))), conductores: new Set(conductores.map((c) => Number(c.id))) };
}

/** Solo las alertas de los vehiculos y conductores vigilados (la de la empresa siempre). Exportado para las pruebas. */
export function alertasVigiladas(alertas: AlertaDocumento[], v: { vehiculos: Set<number>; conductores: Set<number> }): AlertaDocumento[] {
  return alertas.filter((a) => {
    if (a.origen.entidad === "vehiculo") return v.vehiculos.has(a.origen.id ?? -1);
    if (a.origen.entidad === "conductor") return v.conductores.has(a.origen.id ?? -1);
    return true;
  });
}

/** Nombre de cada estado de los papeles (igual que en el Cuadro pagos). */
const ESTADO_PAPELES: Record<string, string> = {
  EN_RUTA: "En ruta",
  DESCARGADO: "Ya descargo",
  CONDUCTOR: "Con el conductor",
  PARQUEADERO: "En el parqueadero",
  OFICINA: "Donde Don Alexander",
};
/** El conductor ya los entrego (en el parqueadero o en la oficina): se les hace seguimiento hasta facturar. */
const ENTREGADOS = new Set(["PARQUEADERO", "OFICINA"]);

/** Arma un grupo: urgentes primero, cortado en MAX_ITEMS_GRUPO. */
export function grupo(titulo: string, items: ItemSofi[], ruta: string): GrupoSofi {
  const ordenados = [...items].sort((a, b) => (a.nivel === b.nivel ? 0 : a.nivel === "urgente" ? -1 : 1));
  return { titulo, total: items.length, urgentes: items.filter((i) => i.nivel === "urgente").length, items: ordenados.slice(0, MAX_ITEMS_GRUPO), ruta };
}

/** "vence en 3 dia(s)", "vence hoy" o "vencio hace 2 dia(s)". */
function cuandoVence(dias: number): string {
  if (dias < 0) return `vencio hace ${Math.abs(dias)} dia(s)`;
  if (dias === 0) return "vence hoy";
  return `vence en ${dias} dia(s)`;
}

/** Pantalla donde se corrige la fecha de un documento. */
const rutaDocumento = (a: AlertaDocumento) =>
  a.origen.entidad === "conductor" ? "/conductores" : a.origen.entidad === "empresa" ? "/configuracion" : "/flota";

/**
 * Prioridad 1: documentos vencidos o por vencer. Los de la flota y los
 * conductores salen de las alertas de documentos (30 dias); los de las
 * empresas, de su fecha (DIAS_AVISO_EMPRESA). Urgente si faltan
 * DIAS_DOCUMENTO_URGENTE dias o menos.
 */
export function prioridadDocumentos(alertas: AlertaDocumento[], empresa: DocumentoEmpresa[], hoy: string): PrioridadSofi {
  const nivel = (dias: number): NivelAlerta => (dias <= DIAS_DOCUMENTO_URGENTE ? "urgente" : "atencion");
  const ordenar = (a: { dias: number }, b: { dias: number }) => a.dias - b.dias;
  const flota = alertas
    .filter((a) => a.diasRestantes !== null && a.origen.entidad !== "conductor" && a.origen.entidad !== "empresa")
    .map((a) => ({ dias: a.diasRestantes!, item: { nivel: nivel(a.diasRestantes!), texto: a.mensaje, ruta: rutaDocumento(a) } }));
  const conductores = alertas
    .filter((a) => a.diasRestantes !== null && a.origen.entidad === "conductor")
    .map((a) => ({ dias: a.diasRestantes!, item: { nivel: nivel(a.diasRestantes!), texto: a.mensaje, ruta: rutaDocumento(a) } }));
  const deEmpresas = [
    // La poliza de carga de Transportes Lopez (Configuracion > Empresa).
    ...alertas
      .filter((a) => a.diasRestantes !== null && a.origen.entidad === "empresa")
      .map((a) => ({
        dias: a.diasRestantes!,
        item: { nivel: nivel(a.diasRestantes!), texto: `Poliza de carga de ${NOMBRE_EMPRESA.LOPEZ} ${cuandoVence(a.diasRestantes!)}`, ruta: "/configuracion" },
      })),
    ...empresa
      .filter((d) => d.fechaVencimiento && diasEntre(hoy, d.fechaVencimiento) <= DIAS_AVISO_EMPRESA)
      .map((d) => {
        const dias = diasEntre(hoy, d.fechaVencimiento!);
        return {
          dias,
          item: {
            nivel: nivel(dias),
            texto: `${d.nombre} de ${NOMBRE_EMPRESA[d.empresa]} ${cuandoVence(dias)}`,
            detalle: d.numero ? `Numero ${d.numero}` : undefined,
            ruta: "/configuracion",
          },
        };
      }),
  ];
  return {
    numero: 1,
    titulo: "Documentos por vencer",
    grupos: [
      grupo(
        "De la flota",
        flota.sort(ordenar).map((x) => x.item),
        "/flota",
      ),
      grupo(
        "De los conductores",
        conductores.sort(ordenar).map((x) => x.item),
        "/conductores",
      ),
      grupo(
        "De las empresas",
        deEmpresas.sort(ordenar).map((x) => x.item),
        "/configuracion",
      ),
    ],
  };
}

/** "SKN250 · CLIENTE · manifiesto 123". */
const tituloViaje = (f: FilaCuadro) =>
  `${f.placa} · ${f.empresa}${f.manifiesto ? ` · manifiesto ${f.manifiesto}` : f.remision ? ` · remision ${f.remision}` : ""}`;

/** Viaje sin factura y no anulado (lo mismo que mira el seguimiento de papeles). */
const sinFactura = (f: FilaCuadro) => !f.anulado && !f.facturado && !f.facturaNumero && !f.facturaFecha && !f.facturaFechaPago;

/**
 * Prioridad 2: papeles. "Se deben": el viaje descargo y los papeles no han
 * llegado (alerta de papeles del seguimiento). "Entregados": el conductor ya
 * los dejo en el parqueadero o donde Don Alexander y falta pasarlos a listos
 * para facturar (urgente desde DIAS_PAPELES_DEMORADOS dias del descargue).
 */
export function prioridadPapeles(filas: FilaCuadro[], hoy: string, desde = SEGUIMIENTO_DESDE): PrioridadSofi {
  const deben: ItemSofi[] = [];
  const entregados: ItemSofi[] = [];
  for (const f of filas) {
    if (ENTREGADOS.has(f.estadoPapeles)) {
      if (!sinFactura(f) || f.fecha < desde || papelesListos(f.estadoPapeles)) continue;
      const dias = f.fechaDescargue ? Math.max(0, diasEntre(f.fechaDescargue, hoy)) : null;
      entregados.push({
        nivel: dias !== null && dias >= DIAS_PAPELES_DEMORADOS ? "urgente" : "atencion",
        texto: tituloViaje(f),
        detalle: `${ESTADO_PAPELES[f.estadoPapeles]}${dias !== null ? `, descargo hace ${dias} dia(s)` : ""}: revisalos y pasalos a listos para facturar.${
          f.papelesCompletos === false ? ` Faltan papeles${f.papelesFaltan ? `: ${f.papelesFaltan}` : ""}.` : ""
        }`,
        ruta: `/cuadro?papeles=${f.id}`,
      });
      continue;
    }
    const p = alertaPapeles(f, hoy, desde);
    if (p)
      deben.push({
        nivel: p.nivel,
        texto: tituloViaje(f),
        detalle: `${ESTADO_PAPELES[f.estadoPapeles] ?? f.estadoPapeles}. ${p.motivos.join(" ")}`,
        ruta: `/cuadro?papeles=${f.id}`,
      });
  }
  return {
    numero: 2,
    titulo: "Papeles",
    grupos: [grupo("Papeles que se deben", deben, "/cuadro?papeles=0"), grupo("Seguimiento de los papeles entregados", entregados, "/cuadro?papeles=0")],
  };
}

/** Prioridad 3: facturacion (la alerta de facturacion del seguimiento de cada viaje). */
export function prioridadFacturacion(filas: FilaCuadro[], hoy: string, desde = SEGUIMIENTO_DESDE): PrioridadSofi {
  const porFacturar: ItemSofi[] = [];
  const enviados: ItemSofi[] = [];
  for (const f of filas) {
    const a = alertaFacturacion(f, hoy, desde);
    if (!a) continue;
    const item = { nivel: a.nivel, texto: tituloViaje(f), detalle: a.motivos.join(" "), ruta: `/cuadro?viaje=${f.id}` };
    (f.enviadoFacturarEn || f.facturado || f.facturaNumero || f.facturaFecha ? enviados : porFacturar).push(item);
  }
  return {
    numero: 3,
    titulo: "Facturacion",
    grupos: [grupo("Listos para facturar", porFacturar, "/cuadro"), grupo("Enviados o facturados sin numero o sin fecha", enviados, "/cuadro")],
  };
}

/** Viaje del RNDC con un error o un envio que no termino. */
export interface ViajeIncidencia {
  id: number;
  estado: string;
  placa: string | null;
  consecutivoManifiesto: string | null;
  /** "AAAA-MM-DD" (Colombia) en que se creo. */
  dia: string;
  mensajeError: string | null;
}

/** Lo que alimenta la prioridad 4. */
export interface EntradaIncidencias {
  /** Viajes con error o con un envio a medias, de antes de hoy. */
  viajes: ViajeIncidencia[];
  contingencias: Awaited<ReturnType<typeof contingencia.pendientes>>;
  /** Manifiestos vigentes con el plazo del cumplido vencido. */
  cumplidosVencidos: Array<{ id: number; placa: string | null; consecutivoManifiesto: string | null; dias: number }>;
  /** Error de la ultima sincronizacion con el RNDC (null si salio bien o esta apagada). */
  errorSincronizacion: string | null;
  /** Fletes que puso SOFI y nadie ha revisado. */
  fletesAutomaticos: number;
  /** Vueltas de anticipo sin viaje asignado. */
  vueltasSinViaje: number;
}

/** Nombre de cada estado de error o de envio. */
const ESTADO_VIAJE: Record<string, string> = {
  VALIDACION_ERROR: "Error de validacion",
  REMESA_ERROR: "Error en remesa",
  MANIFIESTO_ERROR: "Error en manifiesto",
  ANULACION_ERROR: "Error al anular",
  REINTENTANDO: "Se quedo enviando",
  ANULANDO: "Se quedo anulando",
  CUMPLIENDO: "Se quedo cumpliendo",
};
export const ESTADOS_INCIDENCIA = Object.keys(ESTADO_VIAJE);

/** "2026-11-25" -> "25/11". */
const diaCorto = (d: string) => d.slice(8, 10) + "/" + d.slice(5, 7);

/**
 * Prioridad 4: incidencias del sistema que quedaron pendientes. Los errores
 * del RNDC son de dias anteriores (los de hoy se ven al despachar).
 */
export function prioridadIncidencias(e: EntradaIncidencias): PrioridadSofi {
  const rndc: ItemSofi[] = e.viajes.map((v) => ({
    nivel: "urgente",
    texto: `${v.placa ?? `Viaje #${v.id}`}${v.consecutivoManifiesto ? ` · manifiesto ${v.consecutivoManifiesto}` : ""}: ${ESTADO_VIAJE[v.estado] ?? v.estado} desde el ${diaCorto(v.dia)}`,
    detalle: v.mensajeError ? v.mensajeError.slice(0, 200) : "Abrelo en RNDC para corregir y reintentar.",
    ruta: `/historial?documentos=${v.id}`,
  }));
  for (const c of e.contingencias) {
    const a = alertaContingencia(c);
    rndc.push({ nivel: "urgente", texto: a.titulo, detalle: a.motivos[1], ruta: `/historial?documentos=${c.id}` });
  }
  for (const c of e.cumplidosVencidos) {
    rndc.push({
      nivel: "urgente",
      texto: `${c.placa ?? `Viaje #${c.id}`}${c.consecutivoManifiesto ? ` · manifiesto ${c.consecutivoManifiesto}` : ""}: cumplido vencido`,
      detalle: `Lleva ${c.dias} dias habiles sin cumplir en el RNDC (el plazo es de 5).`,
      ruta: "/historial",
    });
  }
  const sistema: ItemSofi[] = [];
  if (e.errorSincronizacion) {
    sistema.push({ nivel: "urgente", texto: "La sincronizacion con el RNDC fallo", detalle: e.errorSincronizacion.slice(0, 200), ruta: "/historial" });
  }
  if (e.fletesAutomaticos) {
    sistema.push({
      nivel: "atencion",
      texto: `${e.fletesAutomaticos} flete(s) que puso SOFI sin revisar`,
      detalle: 'En el Cuadro pagos tienen la marca "automatico": confirmalos o cambialos.',
      ruta: "/cuadro",
    });
  }
  if (e.vueltasSinViaje) {
    sistema.push({
      nivel: "atencion",
      texto: `${e.vueltasSinViaje} vuelta(s) de anticipo sin viaje`,
      detalle: 'En Anticipos, pestana "Vueltas pendientes": asigna cada una a su viaje.',
      ruta: "/anticipos",
    });
  }
  return {
    numero: 4,
    titulo: "Incidencias del sistema",
    grupos: [grupo("RNDC", rndc, "/historial"), grupo("Pendientes de revisar", sistema, "/cuadro")],
  };
}

/** Lee lo que alimenta las incidencias (prioridad 4). */
async function leerIncidencias(filas: FilaCuadro[], hoy: string): Promise<EntradaIncidencias> {
  const ahora = new Date();
  const [[viajes], [cumplir], [[vueltas]], contingencias, sincronizacion] = await Promise.all([
    pool.query<RowDataPacket[]>(
      `SELECT v.id, v.estado, COALESCE(ve.placa, v.placaRndc) AS placa, v.consecutivoManifiesto, v.mensajeError,
              DATE_FORMAT(DATE_SUB(v.fechaCreacion, INTERVAL 5 HOUR), '%Y-%m-%d') AS dia
         FROM viajes v LEFT JOIN vehiculos ve ON ve.id = v.vehiculoId
        WHERE v.estado IN (?) AND DATE(DATE_SUB(v.fechaCreacion, INTERVAL 5 HOUR)) < ?
        ORDER BY v.fechaCreacion`,
      [ESTADOS_INCIDENCIA, hoy],
    ),
    pool.query<RowDataPacket[]>(
      `SELECT v.id, COALESCE(ve.placa, v.placaRndc) AS placa, v.consecutivoManifiesto, v.fechaHoraDescargue
         FROM viajes v LEFT JOIN vehiculos ve ON ve.id = v.vehiculoId
        WHERE v.estado = 'CONFIRMADO' AND v.fechaHoraDescargue IS NOT NULL AND v.fechaHoraDescargue < UTC_TIMESTAMP()`,
    ),
    pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM cuadro_anticipos WHERE tramo = 'VUELTA' AND cuadroViajeId IS NULL"),
    contingencia.pendientes(),
    estadoSincronizacion(),
  ]);
  return {
    viajes: viajes.map((v) => ({
      id: Number(v.id),
      estado: String(v.estado),
      placa: v.placa ?? null,
      consecutivoManifiesto: v.consecutivoManifiesto ?? null,
      dia: String(v.dia),
      mensajeError: v.mensajeError ?? null,
    })),
    contingencias,
    cumplidosVencidos: cumplir.flatMap((v) => {
      const p = plazoCumplido(new Date(v.fechaHoraDescargue), ahora);
      return p.vencido
        ? [{ id: Number(v.id), placa: v.placa ?? null, consecutivoManifiesto: v.consecutivoManifiesto ?? null, dias: p.diasHabilesTranscurridos }]
        : [];
    }),
    errorSincronizacion: sincronizacion.activa ? sincronizacion.error : null,
    fletesAutomaticos: filas.filter((f) => !f.anulado && f.fleteAutomatico).length,
    vueltasSinViaje: Number(vueltas?.n ?? 0),
  };
}

/** Lo que va en el mes (y la comparacion con el mes anterior hasta el mismo dia). */
export interface CifrasMes {
  mes: string;
  viajes: number;
  fletes: number;
  /** Fletes del mes anterior hasta el mismo dia (para comparar). */
  fletesMesAnteriorAlDia: number;
  viajesMesAnteriorAlDia: number;
  /** Facturado en el mes (por fecha de factura). */
  facturado: number;
  /** Cobrado en el mes (por fecha de pago del cliente). */
  cobrado: number;
  /** Facturado y aun sin pagar (todos los meses). */
  porCobrar: number;
  /** Viajes sin factura desde SEGUIMIENTO_DESDE. */
  sinFacturar: number;
}

/** "2026-11" -> "2026-10". */
export function mesAnterior(mes: string): string {
  const [a, m] = mes.split("-").map(Number);
  return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, "0")}`;
}

/** Cifras del mes de los viajes que el rol ve (exportado para las pruebas). */
export function cifrasDelMes(filas: FilaCuadro[], hoy: string, ve: (placa: string) => boolean = () => true, desde = SEGUIMIENTO_DESDE): CifrasMes {
  const mes = hoy.slice(0, 7);
  const anterior = mesAnterior(mes);
  const diaHoy = hoy.slice(8, 10);
  const c: CifrasMes = {
    mes,
    viajes: 0,
    fletes: 0,
    fletesMesAnteriorAlDia: 0,
    viajesMesAnteriorAlDia: 0,
    facturado: 0,
    cobrado: 0,
    porCobrar: 0,
    sinFacturar: 0,
  };
  for (const f of filas) {
    if (f.anulado || !ve(f.placa)) continue;
    const flete = f.valorFlete ?? 0;
    if (f.fecha.startsWith(mes)) {
      c.viajes++;
      c.fletes += flete;
    } else if (f.fecha.startsWith(anterior) && f.fecha.slice(8, 10) <= diaHoy) {
      c.viajesMesAnteriorAlDia++;
      c.fletesMesAnteriorAlDia += flete;
    }
    if (f.facturaNumero && f.facturaFecha?.startsWith(mes)) c.facturado += flete;
    if (f.facturaFechaPago?.startsWith(mes)) c.cobrado += flete;
    if (f.facturaNumero && !f.facturaFechaPago) c.porCobrar += flete;
    if (sinFactura(f) && f.fecha >= desde) c.sinFacturar += flete;
  }
  for (const k of ["fletes", "fletesMesAnteriorAlDia", "facturado", "cobrado", "porCobrar", "sinFacturar"] as const) c[k] = Math.round(c[k]);
  return c;
}

/** Un dia en que vencen facturas por cobrar. */
export interface DiaCobro {
  fecha: string;
  total: number;
  facturas: Array<{ numero: string; cliente: string; valor: number }>;
}

/** Los dias de cobro: lo vencido y lo que vence en los proximos `dias` dias. */
export interface Cobros {
  vencido: { total: number; facturas: number; clientes: number };
  proximos: DiaCobro[];
}

/** Agrupa la cartera por dia de vencimiento (exportado para las pruebas). */
export function diasDeCobro(
  facturas: Array<{ facturaNumero: string; cliente: string; vence: string; valor: number; diasVencida: number }>,
  hoy: string,
  dias = 15,
): Cobros {
  const vencidas = facturas.filter((f) => f.diasVencida > 0 && f.valor > 0);
  const porDia = new Map<string, DiaCobro>();
  for (const f of facturas) {
    if (f.diasVencida > 0 || f.valor <= 0) continue;
    const faltan = diasEntre(hoy, f.vence);
    if (faltan < 0 || faltan > dias) continue;
    const d = porDia.get(f.vence) ?? { fecha: f.vence, total: 0, facturas: [] };
    d.total += f.valor;
    d.facturas.push({ numero: f.facturaNumero, cliente: f.cliente, valor: Math.round(f.valor) });
    porDia.set(f.vence, d);
  }
  return {
    vencido: {
      total: Math.round(vencidas.reduce((s, f) => s + f.valor, 0)),
      facturas: vencidas.length,
      clientes: new Set(vencidas.map((f) => f.cliente)).size,
    },
    proximos: [...porDia.values()].sort((a, b) => a.fecha.localeCompare(b.fecha)).map((d) => ({ ...d, total: Math.round(d.total) })),
  };
}

/** Lo que dejaron los carros (y la empresa) en el mes. */
export interface ResumenRentabilidad {
  mes: string;
  grupos: Array<{ nombre: string; ingresos: number; costos: number; utilidad: number }>;
  total: number;
  /** Los vehiculos que mas y menos dejaron (hasta 3 de cada uno). */
  mejores: Array<{ placa: string; utilidad: number; viajes: number }>;
  peores: Array<{ placa: string; utilidad: number; viajes: number }>;
}

/** Resume la rentabilidad del mes (exportado para las pruebas). */
export function resumirRentabilidad(u: Pick<UtilidadesMes, "mes" | "vehiculos" | "empresa">, conEmpresa: boolean): ResumenRentabilidad {
  const r = Math.round;
  const grupos: ResumenRentabilidad["grupos"] = [];
  for (const empresa of ["LOPEZ", "MYC"] as const) {
    const vs = u.vehiculos.filter((v) => v.empresa === empresa);
    if (!vs.length) continue;
    const s = (f: (v: (typeof vs)[number]) => number) => r(vs.reduce((t, v) => t + f(v), 0));
    grupos.push({
      nombre: `Carros ${NOMBRE_EMPRESA[empresa]}`,
      ingresos: s((v) => v.cascada.ingresos),
      costos: s((v) => v.cascada.totalDescuentos + v.cascada.totalDirectos + v.cascada.totalConductor + v.cascada.totalGenerales),
      utilidad: s((v) => v.cascada.utilidad),
    });
  }
  if (conEmpresa) grupos.push({ nombre: "La empresa", ingresos: r(u.empresa.ingresos), costos: r(u.empresa.totalGastos), utilidad: r(u.empresa.utilidad) });
  const conViajes = u.vehiculos
    .filter((v) => v.cascada.viajes > 0)
    .map((v) => ({ placa: v.placa, utilidad: r(v.cascada.utilidad), viajes: v.cascada.viajes }))
    .sort((a, b) => b.utilidad - a.utilidad);
  return {
    mes: u.mes,
    grupos,
    total: grupos.reduce((t, g) => t + g.utilidad, 0),
    mejores: conViajes.slice(0, 3),
    peores: conViajes.length > 3 ? conViajes.slice(-3).reverse() : [],
  };
}

/** El reparto del mes anterior (el que se aprueba ahora). */
export interface ResumenReparto {
  mes: string;
  aprobado: boolean;
  cerrado: boolean;
  /** Meses anteriores sin aprobar. */
  pendientes: string[];
  socios: Array<{ nombre: string; repartido: number; neto: number }>;
}

/** Lo que puede pedir el Inicio, ya calculado. */
export interface ResumenInicio {
  hoy: string;
  sofi?: PrioridadSofi[];
  cifras?: CifrasMes;
  cobros?: Cobros;
  rentabilidad?: ResumenRentabilidad;
  reparto?: ResumenReparto;
}

/** Las partes que el rol puede ver. */
export function partesDelRol(rol: Rol): ParteResumen[] {
  return PARTES_RESUMEN.filter((p) => {
    if (p === "sofi" || p === "cobros") return puede(rol, "OPERACION");
    // Las cifras del mes son de quien ve dinero: total y M&C (sus carros).
    if (p === "cifras") return rol === "TOTAL" || rol === "MYC";
    if (p === "rentabilidad") return puede(rol, "RENTABILIDAD");
    return puede(rol, "REPARTO");
  });
}

/**
 * Arma el resumen con las partes pedidas que el rol puede ver (las demas no
 * se calculan ni se devuelven).
 */
export async function resumenInicio(rol: Rol, pedidas: ParteResumen[]): Promise<ResumenInicio> {
  const hoy = hoyColombia();
  const partes = new Set(pedidas.filter((p) => partesDelRol(rol).includes(p)));
  const r: ResumenInicio = { hoy };
  const filas = partes.has("sofi") || partes.has("cifras") ? await cuadro.listar() : [];

  if (partes.has("sofi")) {
    const [alertas, empresa, incidencias, vigilar] = await Promise.all([
      revisarVencimientos(),
      documentosEmpresa.listar(),
      leerIncidencias(filas, hoy),
      vigilados(),
    ]);
    r.sofi = [
      prioridadDocumentos(alertasVigiladas([...alertas.vencidos, ...alertas.porVencer], vigilar), empresa, hoy),
      prioridadPapeles(filas, hoy),
      prioridadFacturacion(filas, hoy),
      prioridadIncidencias(incidencias),
    ];
  }
  if (partes.has("cifras")) {
    const ve = await filtroCuentas(rol);
    r.cifras = cifrasDelMes(filas, hoy, (placa) => ve(placa));
  }
  if (partes.has("cobros")) {
    const cartera = await seguimiento.cartera();
    r.cobros = diasDeCobro(cartera.facturas, hoy);
  }
  if (partes.has("rentabilidad") || partes.has("reparto")) {
    const vista: VistaUtilidades = {
      reparto: puede(rol, "REPARTO"),
      terceros: veRentabilidadTerceros(rol),
      empresa: veRentabilidadEmpresa(rol),
      vehiculos: rol === "MYC" ? await vehiculosDeMyc() : null,
    };
    const filasRent = await rentabilidad.listar();
    const mes = hoy.slice(0, 7);
    if (partes.has("rentabilidad")) r.rentabilidad = resumirRentabilidad(await utilidades.mes(mes, vista, undefined, filasRent), vista.empresa);
    if (partes.has("reparto")) {
      const u = await utilidades.mes(mesAnterior(mes), vista, undefined, filasRent);
      r.reparto = {
        mes: u.mes,
        aprobado: !!u.aprobado,
        cerrado: u.cerrado,
        pendientes: u.pendientes,
        socios: u.socios
          .map((s) => ({ nombre: s.nombre, repartido: Math.round(s.repartido), neto: Math.round(s.neto) }))
          .filter((s) => s.repartido || s.neto)
          .sort((a, b) => b.neto - a.neto),
      };
    }
  }
  return r;
}
