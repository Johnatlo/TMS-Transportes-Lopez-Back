/**
 * Sincronizacion automatica con el RNDC: el TMS refleja lo que de verdad hay
 * en el RNDC, aunque se haya hecho en el portal.
 *
 * Que hace, con consultas de SOLO LECTURA (tipo 3) por rango de fechas:
 * - Manifiestos (proceso 4) y remesas (3) expedidos en el portal: se crean como
 *   viajes de origen PORTAL, para no perder el control de los consecutivos ni
 *   el cuadro pagos. Si el numero ya existe en el TMS se completa su radicado.
 * - Cumplidos de manifiesto (6) y de remesa (5): el viaje o la remesa pasa a
 *   cumplido.
 * - Anulaciones de manifiesto (32) y de remesa (9): pasa a anulado.
 * - Cumplido inicial del GPS (45) y su anulacion (54): se guarda en la remesa,
 *   para saber que hay que anularlo antes que el manifiesto.
 *
 * Todas las consultas, sus variables y el formato del rango (iniFECHAING /
 * finFECHAING 'AAAA/MM/DD', fin no incluido) se verificaron en produccion el
 * 2026-10-10 con manifiestos reales de la empresa.
 *
 * Cuando corre: al arrancar el servidor y cada 10 minutos sobre los ultimos
 * dias; una vez al dia recorre todo desde RNDC_SINCRONIZAR_DESDE (por defecto
 * 2026-09-01), mes por mes. Nunca toca un viaje que se esta enviando en ese
 * momento (estados PENDIENTE, REINTENTANDO, ANULANDO o CUMPLIENDO).
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../db";
import { config } from "../config";
import { RndcClient } from "./client";
import type { CredencialesRndc } from "./builders";

/** Estados en los que el viaje se esta enviando: la sincronizacion no lo toca. */
const ESTADOS_EN_CURSO = ["PENDIENTE", "REINTENTANDO", "ANULANDO", "CUMPLIENDO"];
/** Estados de error de despacho: si el RNDC tiene el manifiesto, se adopta. */
const ESTADOS_ERROR = ["VALIDACION_ERROR", "REMESA_ERROR", "MANIFIESTO_ERROR"];

const MINUTOS_ENTRE_SINCRONIZACIONES = 10;
const DIAS_VENTANA_CORTA = 5;
const HORAS_ENTRE_BARRIDOS_COMPLETOS = 24;

/** Registro de una consulta: etiquetas en minuscula -> valor. */
export type Registro = Record<string, string>;

export interface ResumenSincronizacion {
  desde: string;
  hasta: string;
  manifiestosNuevos: string[];
  remesasNuevas: string[];
  adoptados: string[];
  cumplidos: string[];
  remesasCumplidas: string[];
  anulados: string[];
  remesasAnuladas: string[];
  cumplidosIniciales: number;
  anulacionesCumplidoInicial: number;
  /** Remesas anuladas en el RNDC sin manifiesto (en el RNDC ni en el TMS): solo se informan. */
  remesasAnuladasSinViaje: string[];
  conflictos: string[];
}

// ---------------------------------------------------------------------------
// Fechas del RNDC
// ---------------------------------------------------------------------------

/**
 * FECHAING del RNDC ("09/10/2026 10:08:12 p. m." o "1/10/2026 5:48:55 a. m.",
 * hora de Colombia) -> Date. null si no tiene ese formato.
 */
export function fechaIngresoRndc(texto: string | null | undefined): Date | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i.exec((texto ?? "").trim());
  if (!m) return null;
  let hora = Number(m[4]) % 12;
  if (m[7].toLowerCase() === "p") hora += 12;
  return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], hora + 5, +m[5], Number(m[6] ?? 0)));
}

/** "DD/MM/AAAA" y "HH:MM" en hora de Colombia -> Date. Sin hora: mediodia. */
export function fechaHoraCitaRndc(fecha: string | null | undefined, hora?: string | null): Date | null {
  const f = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((fecha ?? "").trim());
  if (!f) return null;
  const h = /^(\d{1,2}):(\d{2})/.exec((hora ?? "").trim());
  return new Date(Date.UTC(+f[3], +f[2] - 1, +f[1], (h ? +h[1] : 12) + 5, h ? +h[2] : 0));
}

/** Date -> "AAAA/MM/DD" (dia de Colombia), el formato del rango de las consultas. */
export function fechaConsulta(d: Date): string {
  const c = new Date(d.getTime() - 5 * 3_600_000);
  return `${c.getUTCFullYear()}/${String(c.getUTCMonth() + 1).padStart(2, "0")}/${String(c.getUTCDate()).padStart(2, "0")}`;
}

/** Tramos de hasta un mes entre dos fechas: una consulta por tramo, para no pesar al RNDC. */
export function tramosMensuales(desde: Date, hasta: Date): Array<[Date, Date]> {
  const tramos: Array<[Date, Date]> = [];
  let ini = new Date(desde);
  while (ini < hasta) {
    const fin = new Date(Date.UTC(ini.getUTCFullYear(), ini.getUTCMonth() + 1, 1, 12));
    tramos.push([ini, fin < hasta ? fin : hasta]);
    ini = fin;
  }
  return tramos;
}

/** "00006692B" -> { base: "00006692", orden: 3 }: la remesa A es la 2, la B la 3. */
export function partesConsecutivoRemesa(consecutivo: string): { base: string; orden: number } {
  const m = /^(.*?\d)([A-Z]?)$/i.exec(consecutivo.trim());
  if (!m || !m[2]) return { base: consecutivo.trim(), orden: 1 };
  return { base: m[1], orden: m[2].toUpperCase().charCodeAt(0) - 63 };
}

// ---------------------------------------------------------------------------
// Consultas al RNDC
// ---------------------------------------------------------------------------

const VARIABLES = {
  manifiestos: [
    "INGRESOID", "FECHAING", "NUMMANIFIESTOCARGA", "FECHAEXPEDICIONMANIFIESTO", "CODMUNICIPIOORIGENMANIFIESTO",
    "CODMUNICIPIODESTINOMANIFIESTO", "CODVIA", "NUMPLACA", "NUMPLACAREMOLQUE", "NUMIDCONDUCTOR", "NITMONITOREOFLOTA",
    "VALORFLETEPACTADOVIAJE", "RETENCIONFOPAT", "VALORANTICIPOMANIFIESTO", "FECHAPAGOSALDOMANIFIESTO",
  ],
  remesas: [
    "INGRESOID", "FECHAING", "CONSECUTIVOREMESA", "MERCANCIAREMESA", "DESCRIPCIONCORTAPRODUCTO", "CANTIDADCARGADA",
    "CODTIPOIDREMITENTE", "NUMIDREMITENTE", "CODSEDEREMITENTE", "CODTIPOIDDESTINATARIO", "NUMIDDESTINATARIO",
    "CODSEDEDESTINATARIO", "CODTIPOIDPROPIETARIO", "NUMIDPROPIETARIO", "CODSEDEPROPIETARIO", "FECHACITAPACTADACARGUE",
    "HORACITAPACTADACARGUE", "FECHACITAPACTADADESCARGUE", "HORACITAPACTADADESCARGUEREMESA",
  ],
  cumplidosManifiesto: ["INGRESOID", "FECHAING", "NUMMANIFIESTOCARGA"],
  cumplidosRemesa: ["INGRESOID", "FECHAING", "CONSECUTIVOREMESA"],
  cumplidosIniciales: ["INGRESOID", "FECHAING", "CONSECUTIVOREMESA", "NUMMANIFIESTOCARGA"],
  anulacionesCumplidoInicial: ["INGRESOID", "FECHAING", "CONSECUTIVOREMESA"],
  anulacionesManifiesto: ["INGRESOID", "FECHAING", "NUMMANIFIESTOCARGA", "MOTIVOANULACIONMANIFIESTO", "OBSERVACIONES"],
  anulacionesRemesa: ["INGRESOID", "FECHAING", "CONSECUTIVOREMESA"],
};

/** Escapa &, < y > para el XML de la consulta. */
const escapar = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Parte la respuesta en documentos: cada uno, sus etiquetas en minuscula -> valor. */
export function leerDocumentos(xml: string): Registro[] {
  return (xml.match(/<documento>[\s\S]*?<\/documento>/gi) ?? []).map((bloque) => {
    const r: Registro = {};
    for (const m of bloque.matchAll(/<([a-z0-9_]+)>([^<]*)<\/\1>/gi)) {
      if (m[1].toLowerCase() !== "documento") r[m[1].toLowerCase()] = m[2].trim();
    }
    return r;
  });
}

/**
 * Documentos de un proceso registrados entre dos fechas (tipo 3, filtrado por
 * el NIT de la empresa). "Documento no encontrado" (RNDC11) = ninguno.
 */
async function consultarRango(
  cliente: RndcClient,
  cred: CredencialesRndc,
  procesoId: string,
  variables: string[],
  desde: Date,
  hasta: Date
): Promise<Registro[]> {
  const xml = `<?xml version='1.0' encoding='ISO-8859-1' ?>
<root>
 <acceso><username>${escapar(cred.usuario)}</username><password>${escapar(cred.password)}</password></acceso>
 <solicitud><tipo>3</tipo><procesoid>${procesoId}</procesoid></solicitud>
 <variables>${variables.join(",")}</variables>
 <documento><NUMNITEMPRESATRANSPORTE>${escapar(cred.nitEmpresa)}</NUMNITEMPRESATRANSPORTE></documento>
 <documentorango><iniFECHAING>'${fechaConsulta(desde)}'</iniFECHAING><finFECHAING>'${fechaConsulta(hasta)}'</finFECHAING></documentorango>
</root>`;
  const r = await cliente.enviar(xml, procesoId);
  if (!r.ok && /RNDC11/i.test(r.errorCrudo ?? "")) return [];
  if (!r.ok) throw new Error(`Proceso ${procesoId}: ${r.errorCrudo ?? r.error}`);
  return leerDocumentos(r.xmlRespuesta ?? "");
}

/** Lo mismo por tramos mensuales, con una pausa corta entre consultas. */
async function consultarTramos(
  cliente: RndcClient,
  cred: CredencialesRndc,
  procesoId: string,
  variables: string[],
  desde: Date,
  hasta: Date
): Promise<Registro[]> {
  const todos: Registro[] = [];
  for (const [ini, fin] of tramosMensuales(desde, hasta)) {
    todos.push(...(await consultarRango(cliente, cred, procesoId, variables, ini, fin)));
    await new Promise((listo) => setTimeout(listo, 1500));
  }
  return todos;
}

// ---------------------------------------------------------------------------
// Aplicar lo que dice el RNDC
// ---------------------------------------------------------------------------

/** Texto numerico del RNDC -> number; vacio o ausente -> null. */
const num = (v: string | undefined) => (v === undefined || v === "" ? null : Number(v));
/** Ejecuta una consulta SQL y devuelve solo las filas (o el resultado del INSERT/UPDATE). */
const q = async <T = RowDataPacket[]>(sql: string, params: unknown[] = []) => (await pool.query(sql, params))[0] as T;

/** Id del catalogo por un campo (placa, cedula) o null si no esta. */
async function idPor(tabla: string, campo: string, valor: string | undefined): Promise<number | null> {
  if (!valor) return null;
  const filas = await q(`SELECT id FROM ${tabla} WHERE ${campo} = ? LIMIT 1`, [valor]);
  return filas[0]?.id ?? null;
}

/** Crea en el TMS un viaje expedido en el portal, con sus remesas. */
async function crearViajePortal(m: Registro, remesas: Registro[], resumen: ResumenSincronizacion) {
  const primera = remesas.find((r) => partesConsecutivoRemesa(r.consecutivoremesa).orden === 1) ?? remesas[0];
  const cargue = (primera && fechaHoraCitaRndc(primera.fechacitapactadacargue, primera.horacitapactadacargue))
    ?? fechaIngresoRndc(m.fechaing) ?? new Date();
  const ultima = remesas.reduce<Date | null>((max, r) => {
    const d = fechaHoraCitaRndc(r.fechacitapactadadescargue, r.horacitapactadadescargueremesa);
    return d && (!max || d > max) ? d : max;
  }, null);
  const res = await q<ResultSetHeader>(
    `INSERT INTO viajes
       (plantillaId, vehiculoId, conductorId, remolqueId, fechaHoraCargue, fechaHoraDescargue, pesoReal, estado,
        numeroManifiestoRndc, consecutivoManifiesto, valorFleteReal, retencionFopat, valorAnticipoManifiesto,
        fechaPagoSaldo, codVia, nitMonitoreoFlota, fechaCreacion, origen, placaRndc, conductorRndc, remolqueRndc,
        origenRndc, destinoRndc, avisos)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, 'CONFIRMADO', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PORTAL', ?, ?, ?, ?, ?, ?)`,
    [
      await idPor("vehiculos", "placa", m.numplaca),
      await idPor("conductores", "cedula", m.numidconductor),
      await idPor("remolques", "placa", m.numplacaremolque),
      cargue,
      ultima,
      remesas.reduce((t, r) => t + (num(r.cantidadcargada) ?? 0), 0) || null,
      m.ingresoid,
      m.nummanifiestocarga,
      num(m.valorfletepactadoviaje),
      num(m.retencionfopat),
      num(m.valoranticipomanifiesto) ?? 0,
      fechaHoraCitaRndc(m.fechapagosaldomanifiesto),
      m.codvia || null,
      m.nitmonitoreoflota || null,
      fechaIngresoRndc(m.fechaing) ?? new Date(),
      m.numplaca || null,
      m.numidconductor || null,
      m.numplacaremolque || null,
      m.codmunicipioorigenmanifiesto || null,
      m.codmunicipiodestinomanifiesto || null,
      "Expedido en el portal del RNDC: lo trajo la sincronizacion automatica.",
    ]
  );
  resumen.manifiestosNuevos.push(m.nummanifiestocarga);
  for (const r of remesas) await crearRemesaPortal(res.insertId, r, resumen);
}

/** Crea una remesa del portal ligada a su viaje (si su consecutivo no existe ya). */
async function crearRemesaPortal(viajeId: number, r: Registro, resumen: ResumenSincronizacion) {
  if (await idPor("viaje_remesas", "consecutivoRemesa", r.consecutivoremesa)) return;
  await q(
    `INSERT INTO viaje_remesas
       (viajeId, plantillaId, orden, fechaHoraCargue, fechaHoraDescargue, pesoReal, consecutivoRemesa, numeroRemesaRndc,
        estado, propietarioTipoId, propietarioNit, propietarioSede, remitenteTipoId, remitenteNit, remitenteSede,
        destinatarioTipoId, destinatarioNit, destinatarioSede, producto, codMercancia)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'CREADA', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      viajeId,
      partesConsecutivoRemesa(r.consecutivoremesa).orden,
      fechaHoraCitaRndc(r.fechacitapactadacargue, r.horacitapactadacargue) ?? fechaIngresoRndc(r.fechaing) ?? new Date(),
      fechaHoraCitaRndc(r.fechacitapactadadescargue, r.horacitapactadadescargueremesa) ?? fechaIngresoRndc(r.fechaing) ?? new Date(),
      num(r.cantidadcargada),
      r.consecutivoremesa,
      r.ingresoid,
      r.codtipoidpropietario || null, r.numidpropietario || null, r.codsedepropietario || null,
      r.codtipoidremitente || null, r.numidremitente || null, r.codsederemitente || null,
      r.codtipoiddestinatario || null, r.numiddestinatario || null, r.codsededestinatario || null,
      r.descripcioncortaproducto || null, r.mercanciaremesa || null,
    ]
  );
  resumen.remesasNuevas.push(r.consecutivoremesa);
}

/** Viaje del TMS por numero de manifiesto, con la placa con que se expidio. */
async function viajePorManifiesto(numero: string) {
  const filas = await q(
    `SELECT v.id, v.estado, v.numeroManifiestoRndc, COALESCE(ve.placa, v.placaRndc) AS placa
       FROM viajes v LEFT JOIN vehiculos ve ON ve.id = v.vehiculoId
      WHERE v.consecutivoManifiesto = ?`,
    [numero]
  );
  return filas[0] as { id: number; estado: string; numeroManifiestoRndc: string | null; placa: string | null } | undefined;
}

/** Remesa del TMS por consecutivo, con el estado de su viaje. */
async function remesaPorConsecutivo(consecutivo: string) {
  const filas = await q(
    `SELECT vr.*, v.estado AS estadoViaje FROM viaje_remesas vr JOIN viajes v ON v.id = vr.viajeId
      WHERE vr.consecutivoRemesa = ?`,
    [consecutivo]
  );
  return filas[0] as (RowDataPacket & { id: number; estado: string; estadoViaje: string }) | undefined;
}

/**
 * Trae del RNDC todo lo registrado entre dos fechas y lo refleja en el TMS.
 * Ver la cabecera del modulo. Devuelve lo que cambio.
 */
export async function sincronizarRango(cliente: RndcClient, cred: CredencialesRndc, desde: Date, hasta: Date): Promise<ResumenSincronizacion> {
  const resumen: ResumenSincronizacion = {
    desde: fechaConsulta(desde), hasta: fechaConsulta(hasta), manifiestosNuevos: [], remesasNuevas: [], adoptados: [],
    cumplidos: [], remesasCumplidas: [], anulados: [], remesasAnuladas: [], cumplidosIniciales: 0,
    anulacionesCumplidoInicial: 0, remesasAnuladasSinViaje: [], conflictos: [],
  };
  const consultar = (proc: string, vars: string[]) => consultarTramos(cliente, cred, proc, vars, desde, hasta);

  // 1. Manifiestos y remesas.
  const manifiestos = await consultar("4", VARIABLES.manifiestos);
  const remesas = await consultar("3", VARIABLES.remesas);
  const remesasPorBase = new Map<string, Registro[]>();
  for (const r of remesas) {
    const base = partesConsecutivoRemesa(r.consecutivoremesa).base;
    remesasPorBase.set(base, [...(remesasPorBase.get(base) ?? []), r]);
  }
  for (const m of manifiestos) {
    const local = await viajePorManifiesto(m.nummanifiestocarga);
    if (!local) {
      await crearViajePortal(m, remesasPorBase.get(m.nummanifiestocarga) ?? [], resumen);
      continue;
    }
    if (ESTADOS_EN_CURSO.includes(local.estado)) continue;
    if (local.placa && m.numplaca && local.placa.toUpperCase() !== m.numplaca.toUpperCase()) {
      resumen.conflictos.push(
        `El manifiesto ${m.nummanifiestocarga} esta en el RNDC con la placa ${m.numplaca}, pero en el TMS es de ${local.placa}.`
      );
      continue;
    }
    if (!local.numeroManifiestoRndc && ESTADOS_ERROR.includes(local.estado)) {
      await q(
        `UPDATE viajes SET estado = 'CONFIRMADO', numeroManifiestoRndc = ?, mensajeError = NULL, codigoError = NULL,
                errorCrudo = NULL, avisos = ? WHERE id = ?`,
        [m.ingresoid, `Manifiesto encontrado en el RNDC (radicado ${m.ingresoid}): se tomo automaticamente.`, local.id]
      );
      resumen.adoptados.push(m.nummanifiestocarga);
    } else if (!local.numeroManifiestoRndc) {
      await q("UPDATE viajes SET numeroManifiestoRndc = ? WHERE id = ?", [m.ingresoid, local.id]);
    }
  }
  // Remesas de viajes que ya existian: completar el radicado y, si quedaron con
  // error, marcarlas creadas. Las de un viaje del portal ya se crearon arriba.
  for (const r of remesas) {
    const local = await remesaPorConsecutivo(r.consecutivoremesa);
    if (local) {
      if (!local.numeroRemesaRndc && !ESTADOS_EN_CURSO.includes(local.estadoViaje) && !["ANULADA", "CUMPLIDA"].includes(local.estado)) {
        await q("UPDATE viaje_remesas SET numeroRemesaRndc = ?, estado = 'CREADA', mensajeError = NULL WHERE id = ?", [r.ingresoid, local.id]);
      }
      continue;
    }
    // Remesa del portal cuyo manifiesto ya existe en el TMS (por ejemplo, expedido en otro rango).
    const viaje = await viajePorManifiesto(partesConsecutivoRemesa(r.consecutivoremesa).base);
    if (viaje && !ESTADOS_EN_CURSO.includes(viaje.estado)) await crearRemesaPortal(viaje.id, r, resumen);
  }

  // 2. Cumplido inicial del GPS y su anulacion.
  for (const c of await consultar("45", VARIABLES.cumplidosIniciales)) {
    const res = await q<ResultSetHeader>(
      "UPDATE viaje_remesas SET radicadoCumplidoInicial = ? WHERE consecutivoRemesa = ? AND radicadoCumplidoInicial IS NULL",
      [c.ingresoid, c.consecutivoremesa]
    );
    resumen.cumplidosIniciales += res.affectedRows;
  }
  for (const a of await consultar("54", VARIABLES.anulacionesCumplidoInicial)) {
    const res = await q<ResultSetHeader>(
      "UPDATE viaje_remesas SET radicadoAnulacionCumplido = ? WHERE consecutivoRemesa = ? AND radicadoAnulacionCumplido IS NULL",
      [a.ingresoid, a.consecutivoremesa]
    );
    resumen.anulacionesCumplidoInicial += res.affectedRows;
  }

  // 3. Cumplidos.
  for (const c of await consultar("5", VARIABLES.cumplidosRemesa)) {
    const local = await remesaPorConsecutivo(c.consecutivoremesa);
    if (!local || local.estado !== "CREADA" || ESTADOS_EN_CURSO.includes(local.estadoViaje)) continue;
    await q(
      `UPDATE viaje_remesas SET estado = 'CUMPLIDA', radicadoCumplido = ?, fechaCumplido = ?,
              mensajeError = 'Cumplida en el RNDC (sincronizacion automatica).' WHERE id = ?`,
      [c.ingresoid, fechaIngresoRndc(c.fechaing) ?? new Date(), local.id]
    );
    resumen.remesasCumplidas.push(c.consecutivoremesa);
  }
  for (const c of await consultar("6", VARIABLES.cumplidosManifiesto)) {
    const local = await viajePorManifiesto(c.nummanifiestocarga);
    if (!local || local.estado !== "CONFIRMADO") continue;
    await q(
      `UPDATE viajes SET estado = 'CUMPLIDO', radicadoCumplido = ?, fechaCumplido = ?, mensajeError = NULL,
              codigoError = NULL, errorCrudo = NULL WHERE id = ?`,
      [c.ingresoid, fechaIngresoRndc(c.fechaing) ?? new Date(), local.id]
    );
    resumen.cumplidos.push(c.nummanifiestocarga);
  }

  // 4. Anulaciones (al final: el estado anulado prevalece).
  //    Un manifiesto anulado ya no aparece en la consulta de manifiestos (4) ni
  //    su remesa en la de remesas (3): si el TMS no lo tenia, se crea aqui
  //    como anulado para no perder el consecutivo (verificado con 00006805).
  for (const a of await consultar("32", VARIABLES.anulacionesManifiesto)) {
    const local = await viajePorManifiesto(a.nummanifiestocarga);
    if (!local) {
      await crearViajeAnulado(a);
      resumen.anulados.push(a.nummanifiestocarga);
      continue;
    }
    if (local.estado === "ANULADO" || ESTADOS_EN_CURSO.includes(local.estado)) continue;
    await q(
      `UPDATE viajes SET estado = 'ANULADO', radicadoAnulacion = ?, motivoAnulacion = ?, observacionesAnulacion = ?,
              fechaAnulacion = ?, mensajeError = NULL, codigoError = NULL, errorCrudo = NULL WHERE id = ?`,
      [a.ingresoid, a.motivoanulacionmanifiesto || null, (a.observaciones || "Anulado en el RNDC").slice(0, 255),
        fechaIngresoRndc(a.fechaing) ?? new Date(), local.id]
    );
    resumen.anulados.push(a.nummanifiestocarga);
  }
  for (const a of await consultar("9", VARIABLES.anulacionesRemesa)) {
    const local = await remesaPorConsecutivo(a.consecutivoremesa);
    if (!local) {
      // Remesa anulada que el TMS no tenia: se liga al viaje de su manifiesto.
      const viaje = await viajePorManifiesto(partesConsecutivoRemesa(a.consecutivoremesa).base);
      if (viaje && !ESTADOS_EN_CURSO.includes(viaje.estado)) {
        await crearRemesaAnulada(viaje.id, a);
        resumen.remesasAnuladas.push(a.consecutivoremesa);
      } else if (!viaje) {
        // Nunca hubo manifiesto con ese numero: no se inventa un viaje.
        resumen.remesasAnuladasSinViaje.push(a.consecutivoremesa);
      }
      continue;
    }
    if (local.estado === "ANULADA" || ESTADOS_EN_CURSO.includes(local.estadoViaje)) continue;
    await q("UPDATE viaje_remesas SET estado = 'ANULADA', radicadoAnulacion = ?, mensajeError = NULL WHERE id = ?", [a.ingresoid, local.id]);
    resumen.remesasAnuladas.push(a.consecutivoremesa);
  }
  return resumen;
}

/**
 * Viaje anulado en el RNDC que el TMS no conocia. Solo se sabe lo que guarda
 * la anulacion (numero, radicado, motivo, observacion y fecha): el RNDC ya no
 * entrega los datos del manifiesto anulado.
 */
async function crearViajeAnulado(a: Registro) {
  const fecha = fechaIngresoRndc(a.fechaing) ?? new Date();
  await q(
    `INSERT INTO viajes
       (plantillaId, vehiculoId, conductorId, fechaHoraCargue, estado, consecutivoManifiesto, radicadoAnulacion,
        motivoAnulacion, observacionesAnulacion, fechaAnulacion, fechaCreacion, origen, avisos)
     VALUES (NULL, NULL, NULL, ?, 'ANULADO', ?, ?, ?, ?, ?, ?, 'PORTAL', ?)`,
    [fecha, a.nummanifiestocarga, a.ingresoid, a.motivoanulacionmanifiesto || null,
      (a.observaciones || "Anulado en el RNDC").slice(0, 255), fecha, fecha,
      "Manifiesto anulado en el RNDC: lo trajo la sincronizacion. El RNDC ya no entrega sus datos (placa, valores)."]
  );
}

/** Remesa anulada en el RNDC que el TMS no conocia, ligada a su viaje. */
async function crearRemesaAnulada(viajeId: number, a: Registro) {
  const fecha = fechaIngresoRndc(a.fechaing) ?? new Date();
  await q(
    `INSERT INTO viaje_remesas (viajeId, plantillaId, orden, fechaHoraCargue, fechaHoraDescargue, consecutivoRemesa, estado, radicadoAnulacion)
     VALUES (?, NULL, ?, ?, ?, ?, 'ANULADA', ?)`,
    [viajeId, partesConsecutivoRemesa(a.consecutivoremesa).orden, fecha, fecha, a.consecutivoremesa, a.ingresoid]
  );
}

// ---------------------------------------------------------------------------
// Ejecucion automatica
// ---------------------------------------------------------------------------

let corriendo = false;

/** Fecha desde la que se recorre todo (RNDC_SINCRONIZAR_DESDE, por defecto 2026-09-01). */
function desdeCompleto(): Date {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(process.env.RNDC_SINCRONIZAR_DESDE ?? "") ? process.env.RNDC_SINCRONIZAR_DESDE! : "2026-09-01";
  return new Date(`${t}T12:00:00Z`);
}

/**
 * Una sincronizacion: los ultimos DIAS_VENTANA_CORTA dias, o todo desde
 * RNDC_SINCRONIZAR_DESDE si `completa` (o si hace mas de 24 h del ultimo
 * barrido completo). No corre dos a la vez. Guarda el resultado en
 * sincronizacion_rndc.
 */
export async function sincronizarConRndc(opciones: { completa?: boolean } = {}): Promise<ResumenSincronizacion | null> {
  if (config.rndc.simular || corriendo) return null;
  corriendo = true;
  try {
    const [estado] = await q("SELECT ultimoBarridoCompleto FROM sincronizacion_rndc WHERE id = 1");
    const ultimoCompleto = estado?.ultimoBarridoCompleto ? new Date(estado.ultimoBarridoCompleto) : null;
    const completa =
      opciones.completa || !ultimoCompleto || Date.now() - ultimoCompleto.getTime() > HORAS_ENTRE_BARRIDOS_COMPLETOS * 3_600_000;
    const hasta = new Date(Date.now() + 24 * 3_600_000); // el fin del rango no se incluye
    const desde = completa ? desdeCompleto() : new Date(Date.now() - DIAS_VENTANA_CORTA * 24 * 3_600_000);
    const cliente = new RndcClient({
      wsdlUrl: config.rndc.wsdlUrl,
      usuario: config.rndc.usuario,
      password: config.rndc.password,
      simular: false,
      reintentos: config.rndc.reintentos,
      soloConsultas: true,
    });
    const cred = { usuario: config.rndc.usuario, password: config.rndc.password, nitEmpresa: config.rndc.empresaNit };
    try {
      const resumen = await sincronizarRango(cliente, cred, desde, hasta);
      await q(
        `INSERT INTO sincronizacion_rndc (id, ultimaEjecucion, ultimoBarridoCompleto, resumen, error)
         VALUES (1, UTC_TIMESTAMP(), ?, ?, NULL)
         ON DUPLICATE KEY UPDATE ultimaEjecucion = VALUES(ultimaEjecucion),
           ultimoBarridoCompleto = COALESCE(VALUES(ultimoBarridoCompleto), ultimoBarridoCompleto),
           resumen = VALUES(resumen), error = NULL`,
        [completa ? new Date() : null, JSON.stringify(resumen)]
      );
      return resumen;
    } catch (exc) {
      await q(
        `INSERT INTO sincronizacion_rndc (id, ultimaEjecucion, error) VALUES (1, UTC_TIMESTAMP(), ?)
         ON DUPLICATE KEY UPDATE ultimaEjecucion = VALUES(ultimaEjecucion), error = VALUES(error)`,
        [(exc as Error).message.slice(0, 2000)]
      );
      throw exc;
    }
  } finally {
    corriendo = false;
  }
}

/** Estado de la ultima sincronizacion, para mostrarlo en pantalla. */
export async function estadoSincronizacion() {
  const [fila] = await q("SELECT * FROM sincronizacion_rndc WHERE id = 1");
  return {
    activa: !config.rndc.simular,
    corriendo,
    ultimaEjecucion: fila?.ultimaEjecucion ? new Date(fila.ultimaEjecucion).toISOString() : null,
    ultimoBarridoCompleto: fila?.ultimoBarridoCompleto ? new Date(fila.ultimoBarridoCompleto).toISOString() : null,
    resumen: fila?.resumen ? (JSON.parse(fila.resumen) as ResumenSincronizacion) : null,
    error: fila?.error ?? null,
    cadaMinutos: MINUTOS_ENTRE_SINCRONIZACIONES,
  };
}

/**
 * Arranca la sincronizacion automatica: una al minuto de iniciar el servidor y
 * luego cada MINUTOS_ENTRE_SINCRONIZACIONES. Los errores (por ejemplo, el RNDC
 * caido) se registran y se reintenta en la siguiente vuelta.
 */
export function iniciarSincronizacionAutomatica(): void {
  if (config.rndc.simular) {
    console.log("Sincronizacion con el RNDC: desactivada (RNDC_SIMULAR=true).");
    return;
  }
  const correr = () =>
    sincronizarConRndc().catch((exc) => console.warn("Sincronizacion con el RNDC fallo:", (exc as Error).message));
  setTimeout(correr, 60_000);
  setInterval(correr, MINUTOS_ENTRE_SINCRONIZACIONES * 60_000);
  console.log(`Sincronizacion con el RNDC: cada ${MINUTOS_ENTRE_SINCRONIZACIONES} minutos.`);
}
