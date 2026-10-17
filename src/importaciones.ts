/**
 * Carga inicial desde los Excel de la empresa (una sola vez, con revision):
 *
 * - Cartera ("Cartera Total"): las facturas de antes de septiembre de 2026
 *   quedan como saldos sin viaje (cartera_saldos) con su valor por placa; las
 *   de septiembre en adelante se ligan a sus viajes del cuadro pagos (numero,
 *   fecha y vencimiento de factura en cada viaje) para seguir el flujo normal.
 * - Anticipos (hoja de las EDS): cada fila es un anticipo de un viaje; se
 *   crea el tanqueo y su tramo en el viaje elegido.
 *
 * El navegador lee el Excel y manda las filas. Primero se pide la propuesta
 * (proponerCartera / proponerAnticipos: que viaje parece ser cada linea y que
 * tan seguro es) y la persona corrige en pantalla las dudosas; luego se
 * confirma (importarCartera / importarAnticipos). Reimportar no duplica.
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "./db";
import { cuadro, ErrorCuadro, sumarDias } from "./cuadro";
import type { FilaCuadro } from "./cuadro";
import { placaNormal } from "./anticipos";

/** Desde esta fecha de factura todo va por el cuadro pagos; antes, saldos sin viaje. */
export const CORTE_CARTERA = "2026-09-01";
/** Dias antes de la factura en que se buscan sus viajes. */
const DIAS_VIAJES_FACTURA = 75;

// ---------------------------------------------------------------------------
// Clientes: el Excel usa nombres cortos ("CORAME", "VILLA PAPEL") y el cuadro
// el del RNDC ("CARTONES AMERICA", "GESTION AMBIENTAL VILLAPAPEL").
// ---------------------------------------------------------------------------

/** Nombre corto del Excel -> como aparece en el cuadro, cuando no se parecen. */
const ALIAS_CLIENTE: Record<string, string> = {
  CORAME: "CARTONES AMERICA",
};

/** Palabras que no ayudan a reconocer al cliente. */
const RELLENO = new Set(["SAS", "LTDA", "S", "A", "SA", "EN", "C", "DE", "DEL", "LA", "EL", "Y", "LOS", "LAS", "INDUSTRIAL", "INDUSTRIALES"]);

/** Mayusculas, sin tildes ni puntuacion. */
const limpio = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * true si el nombre corto del Excel corresponde a la empresa del cuadro: el
 * nombre completo contenido (sin espacios: "VILLA PAPEL" = "VILLAPAPEL") o
 * alguna palabra significativa (4+ letras) en comun.
 */
export function mismoCliente(corto: string | null | undefined, empresa: string | null | undefined): boolean {
  if (!corto || !empresa) return false;
  const c = limpio(ALIAS_CLIENTE[limpio(corto)] ?? corto);
  const e = limpio(empresa);
  const junto = (t: string) => t.replace(/ /g, "");
  if (junto(e).includes(junto(c)) || junto(c).includes(junto(e))) return true;
  const palabras = c.split(" ").filter((p) => p.length >= 4 && !RELLENO.has(p));
  return palabras.some((p) => junto(e).includes(p));
}

/** Viaje del cuadro ofrecido para una linea (lo que se muestra al elegir). */
export interface CandidatoViaje {
  id: number;
  fecha: string;
  placa: string;
  empresa: string;
  manifiesto: string | null;
  remision: string | null;
  valorFlete: number | null;
  facturaNumero: string | null;
  /** El cliente del viaje corresponde al de la linea. */
  mismoCliente: boolean;
}

/** Viaje del cuadro como candidato de una linea, marcando si es del mismo cliente. */
const candidato = (v: FilaCuadro, cliente: string): CandidatoViaje => ({
  id: v.id,
  fecha: v.fecha,
  placa: v.placa,
  empresa: v.empresa,
  manifiesto: v.manifiesto,
  remision: v.remision,
  valorFlete: v.valorFlete,
  facturaNumero: v.facturaNumero,
  mismoCliente: mismoCliente(cliente, v.empresa),
});

// ---------------------------------------------------------------------------
// Cartera
// ---------------------------------------------------------------------------

/** Una factura pendiente leida del Excel "Cartera Total". */
export interface FacturaImportada {
  numero: string;
  /** Cliente como lo escribe el Excel (nombre corto). */
  empresa: string;
  fecha: string;
  vence: string | null;
  /** Lo que debe el cliente (columna "Valor Factura"). */
  valor: number;
  /** Valor de cada placa (columnas de placas); suman valor + anticipo. */
  placas: Array<{ placa: string; valor: number }>;
}

export interface LineaPropuesta {
  placa: string;
  valor: number;
  candidatos: CandidatoViaje[];
  /** Viajes propuestos (normalmente uno). */
  propuestos: number[];
  /** true: la propuesta es clara (mismo cliente y unica, o ya tenia este numero). */
  seguro: boolean;
}

export interface FacturaPropuesta extends FacturaImportada {
  /** Anticipo o abono del cliente: placas - valor. */
  anticipo: number;
  modo: "SALDO" | "VIAJES";
  /** Por que se propone como saldo (o null). */
  motivo: string | null;
  lineas: LineaPropuesta[];
}

/** Anticipo del cliente implicito: lo que suman las placas menos lo que se debe. */
export const anticipoDe = (f: FacturaImportada) =>
  Math.max(0, Math.round(f.placas.reduce((s, p) => s + p.valor, 0) - f.valor));

/**
 * Propone como cargar cada factura:
 * - Antes del corte (septiembre): saldo sin viaje.
 * - Desde el corte: ligada a viajes. Para cada placa se buscan sus viajes del
 *   cuadro de los 75 dias anteriores a la factura que no esten anulados, ni
 *   pagados, ni facturados con otro numero. Primero los que ya tienen este
 *   numero (reimportacion); si no, el mas reciente del mismo cliente que no se
 *   haya propuesto ya para otra factura. Si una placa no tiene ningun viaje,
 *   la factura se propone como saldo (sus viajes no estan en el sistema).
 */
export function proponerCartera(facturas: FacturaImportada[], viajes: FilaCuadro[]): FacturaPropuesta[] {
  const usados = new Set<number>();
  const vivos = viajes.filter((v) => !v.anulado && !v.facturaFechaPago);
  const orden = [...facturas].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.numero.localeCompare(b.numero));
  const propuestas = new Map<FacturaImportada, FacturaPropuesta>();
  for (const f of orden) {
    const desde = sumarDias(f.fecha, -DIAS_VIAJES_FACTURA);
    const lineas: LineaPropuesta[] = f.placas.map((l) => {
      const candidatos = vivos
        .filter(
          (v) =>
            placaNormal(v.placa) === placaNormal(l.placa) &&
            v.fecha <= f.fecha &&
            v.fecha >= desde &&
            (!v.facturaNumero || v.facturaNumero === f.numero)
        )
        .map((v) => candidato(v, f.empresa))
        .sort(
          (a, b) =>
            Number(b.facturaNumero === f.numero) - Number(a.facturaNumero === f.numero) ||
            Number(b.mismoCliente) - Number(a.mismoCliente) ||
            b.fecha.localeCompare(a.fecha)
        );
      const yaLigados = candidatos.filter((c) => c.facturaNumero === f.numero);
      if (yaLigados.length) {
        yaLigados.forEach((c) => usados.add(c.id));
        return { ...l, candidatos, propuestos: yaLigados.map((c) => c.id), seguro: true };
      }
      const delCliente = candidatos.filter((c) => c.mismoCliente && !usados.has(c.id));
      const elegido = delCliente[0];
      if (elegido) usados.add(elegido.id);
      return { ...l, candidatos, propuestos: elegido ? [elegido.id] : [], seguro: delCliente.length === 1 };
    });
    const sinViajes = lineas.find((l) => l.candidatos.length === 0);
    const antes = f.fecha < CORTE_CARTERA;
    propuestas.set(f, {
      ...f,
      anticipo: anticipoDe(f),
      modo: antes || sinViajes ? "SALDO" : "VIAJES",
      motivo: antes
        ? "Factura de antes de septiembre: va como saldo sin viaje."
        : sinViajes
          ? `La placa ${sinViajes.placa} no tiene viajes en el cuadro antes de esta factura.`
          : null,
      lineas,
    });
  }
  return facturas.map((f) => propuestas.get(f)!);
}

/** Lo que se confirma de cada factura. */
export interface FacturaConfirmada extends FacturaImportada {
  anticipo: number;
  modo: "SALDO" | "VIAJES";
  lineas: Array<{ placa: string; valor: number; viajeIds: number[] }>;
}

/** Fecha "AAAA-MM-DD" o null. */
const fechaONull = (v: unknown) => {
  const t = String(v ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
};

/**
 * Carga las facturas confirmadas en una transaccion:
 * - SALDO: crea o reemplaza el saldo (numero + cliente) con sus placas.
 * - VIAJES: pone numero, fecha y vencimiento de factura en cada viaje (y lo
 *   marca facturado). Si el viaje no tenia flete, queda el valor del Excel
 *   como flete fijo (repartido si la placa tiene varios viajes).
 * - El anticipo del cliente queda con la llave de la cartera (numero + cliente
 *   del saldo, o + empresa de los viajes).
 * Valida que cada linea de una factura por viajes tenga viaje, que ningun
 * viaje quede en dos facturas y que no este facturado con otro numero.
 */
export async function importarCartera(facturas: FacturaConfirmada[]): Promise<{ saldos: number; facturas: number; viajes: number }> {
  if (!Array.isArray(facturas) || facturas.length === 0) throw new ErrorCuadro("No hay facturas para cargar.");
  const usados = new Set<number>();
  for (const f of facturas) {
    if (!f.numero || !f.empresa || !fechaONull(f.fecha)) throw new ErrorCuadro("Hay una factura sin numero, cliente o fecha.");
    if (f.modo !== "VIAJES") continue;
    for (const l of f.lineas) {
      if (!l.viajeIds?.length) throw new ErrorCuadro(`Factura ${f.numero}: elige el viaje de la placa ${l.placa} o cargala como saldo.`);
      for (const id of l.viajeIds) {
        if (usados.has(id)) throw new ErrorCuadro(`Un mismo viaje quedo en dos lineas (factura ${f.numero}, placa ${l.placa}).`);
        usados.add(id);
      }
    }
  }

  const conexion = await pool.getConnection();
  let saldos = 0;
  let ligadas = 0;
  let viajes = 0;
  try {
    await conexion.beginTransaction();
    const anticipo = async (numero: string, empresa: string, valor: number) => {
      if (valor > 0) {
        await conexion.query(
          `INSERT INTO cartera_anticipos_cliente (facturaNumero, empresa, valor) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
          [numero, empresa, Math.round(valor)]
        );
      } else {
        await conexion.query("DELETE FROM cartera_anticipos_cliente WHERE facturaNumero = ? AND empresa = ?", [numero, empresa]);
      }
    };

    for (const f of facturas) {
      const numero = String(f.numero).trim();
      const fecha = fechaONull(f.fecha)!;
      const vence = fechaONull(f.vence);
      if (f.modo === "SALDO") {
        const empresa = String(f.empresa).trim().toUpperCase();
        await conexion.query(
          `INSERT INTO cartera_saldos (facturaNumero, empresa, fechaFactura, fechaVence) VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE fechaFactura = VALUES(fechaFactura), fechaVence = VALUES(fechaVence)`,
          [numero, empresa, fecha, vence]
        );
        const [fila] = await conexion.query<RowDataPacket[]>(
          "SELECT id FROM cartera_saldos WHERE facturaNumero = ? AND empresa = ?",
          [numero, empresa]
        );
        await conexion.query("DELETE FROM cartera_saldos_placas WHERE saldoId = ?", [fila[0].id]);
        for (const l of f.lineas) {
          await conexion.query("INSERT INTO cartera_saldos_placas (saldoId, placa, valor) VALUES (?, ?, ?)", [
            fila[0].id,
            placaNormal(l.placa),
            Math.round(Number(l.valor)),
          ]);
        }
        await anticipo(numero, empresa, Number(f.anticipo) || 0);
        saldos++;
        continue;
      }

      let empresaFactura: string | null = null;
      for (const l of f.lineas) {
        const parte = Math.round(Number(l.valor) / l.viajeIds.length);
        for (const id of l.viajeIds) {
          const [actual] = await conexion.query<RowDataPacket[]>(
            "SELECT empresa, anulado, facturaNumero FROM cuadro_viajes WHERE id = ? FOR UPDATE",
            [id]
          );
          const v = actual[0];
          if (!v || v.anulado) throw new ErrorCuadro(`Factura ${numero}: el viaje ${id} no existe o esta anulado.`);
          if (v.facturaNumero && v.facturaNumero !== numero) {
            throw new ErrorCuadro(`Factura ${numero}: el viaje ${id} ya esta en la factura ${v.facturaNumero}.`);
          }
          empresaFactura ??= v.empresa;
          // Sin flete: queda el valor del Excel como flete fijo.
          await conexion.query<ResultSetHeader>(
            `UPDATE cuadro_viajes SET facturaNumero = ?, facturaFecha = ?, facturaVence = ?, facturado = 1,
                    valorFijo = CASE WHEN (tipoFlete = 'FIJO' AND valorFijo IS NULL) OR (tipoFlete <> 'FIJO' AND tarifaKilo IS NULL)
                                     THEN ? ELSE valorFijo END,
                    tipoFlete = CASE WHEN (tipoFlete = 'FIJO' AND valorFijo IS NULL) OR (tipoFlete <> 'FIJO' AND tarifaKilo IS NULL)
                                     THEN 'FIJO' ELSE tipoFlete END
              WHERE id = ?`,
            [numero, fecha, vence, parte, id]
          );
          viajes++;
        }
      }
      if (empresaFactura) await anticipo(numero, empresaFactura, Number(f.anticipo) || 0);
      ligadas++;
    }
    await conexion.commit();
  } catch (exc) {
    await conexion.rollback();
    throw exc;
  } finally {
    conexion.release();
  }
  return { saldos, facturas: ligadas, viajes };
}

// ---------------------------------------------------------------------------
// Anticipos
// ---------------------------------------------------------------------------

/** Una fila de la hoja de anticipos de las EDS. */
export interface AnticipoImportado {
  /** Numero de fila en el Excel (para mostrar). */
  fila: number;
  fecha: string;
  placa: string;
  /** Cliente del viaje ("EMPRESA PROV"). */
  cliente: string;
  efectivo: number;
  combustible: number;
  galones: number | null;
  descuento: number;
  /** Estacion (EDS): CHUSACA, S. ESTEBAN, RETORNO... */
  eds: string;
  facturaBomba: string | null;
  fechaFacturaBomba: string | null;
  /** Fecha en que se le pago a la bomba. */
  fechaPago: string | null;
}

export interface AnticipoPropuesto extends AnticipoImportado {
  candidatos: CandidatoViaje[];
  propuesto: number | null;
  seguro: boolean;
  /**
   * Ya esta en la base (misma placa, fecha y valores): no se vuelve a cargar.
   * Filas iguales dentro del mismo Excel son anticipos distintos (ida y
   * vuelta en la misma EDS): se cuentan, y solo se saltan tantas como ya haya.
   */
  yaImportado: boolean;
}

/** Dias entre dos fechas "AAAA-MM-DD" (b - a). */
const dias = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

/** Llave para reconocer un anticipo ya cargado. */
const llaveAnticipo = (placa: string, fecha: string, efectivo: number, combustible: number) =>
  `${placaNormal(placa)}|${fecha}|${Math.round(efectivo)}|${Math.round(combustible)}`;

/**
 * Propone el viaje de cada anticipo entre los de la misma placa desde 3 dias
 * antes hasta 20 despues del anticipo, en dos pasadas por fecha:
 * 1. Cada anticipo toma el viaje libre mas cercano de su mismo cliente.
 * 2. Los que quedaron sin viaje toman el mas cercano que siga libre (dos
 *    anticipos de la misma placa el mismo dia suelen ser ida y regreso: el
 *    segundo va al viaje siguiente); si no queda ninguno libre, el mas
 *    cercano aunque ya tenga otro anticipo.
 * "Mas cercano": mejor el mismo dia o despues (el anticipo se da al cargar).
 * Seguro si es del mismo cliente y a lo sumo 2 dias despues, o si es el unico
 * viaje de la placa ese dia.
 */
export function proponerAnticipos(filas: AnticipoImportado[], viajes: FilaCuadro[], existentes: Map<string, number>): AnticipoPropuesto[] {
  const vivos = viajes.filter((v) => !v.anulado);
  const orden = [...filas].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.fila - b.fila);
  const distancia = (d: number) => (d >= 0 ? d : 10 - d);
  const candidatosDe = new Map(
    orden.map((a) => [
      a,
      vivos
        .filter((v) => placaNormal(v.placa) === placaNormal(a.placa) && dias(a.fecha, v.fecha) >= -3 && dias(a.fecha, v.fecha) <= 20)
        .map((v) => candidato(v, a.cliente))
        .sort((x, y) => distancia(dias(a.fecha, x.fecha)) - distancia(dias(a.fecha, y.fecha))),
    ])
  );
  const usados = new Set<number>();
  const elegido = new Map<AnticipoImportado, CandidatoViaje>();
  // 1. Mismo cliente y libre.
  for (const a of orden) {
    const c = candidatosDe.get(a)!.find((x) => x.mismoCliente && !usados.has(x.id));
    if (c) {
      elegido.set(a, c);
      usados.add(c.id);
    }
  }
  // 2. Lo que sobre: libre primero, si no el mas cercano.
  for (const a of orden) {
    if (elegido.has(a)) continue;
    const lista = candidatosDe.get(a)!;
    const c = lista.find((x) => !usados.has(x.id)) ?? lista[0];
    if (c) {
      elegido.set(a, c);
      usados.add(c.id);
    }
  }
  const quedan = new Map(existentes);
  const propuestas = new Map<AnticipoImportado, AnticipoPropuesto>();
  for (const a of orden) {
    const candidatos = candidatosDe.get(a)!;
    const mejor = elegido.get(a) ?? null;
    const mismoDia = candidatos.filter((c) => c.fecha === a.fecha);
    const seguro =
      !!mejor &&
      ((mejor.mismoCliente && dias(a.fecha, mejor.fecha) >= 0 && dias(a.fecha, mejor.fecha) <= 2) ||
        (mismoDia.length === 1 && mismoDia[0].id === mejor.id));
    const llave = llaveAnticipo(a.placa, a.fecha, a.efectivo, a.combustible);
    const yaImportado = (quedan.get(llave) ?? 0) > 0;
    if (yaImportado) quedan.set(llave, quedan.get(llave)! - 1);
    propuestas.set(a, { ...a, candidatos, propuesto: mejor?.id ?? null, seguro, yaImportado });
  }
  return filas.map((f) => propuestas.get(f)!);
}

/** Cuantos anticipos ya cargados hay de cada llave (placa, fecha, efectivo, combustible). */
async function anticiposExistentes(): Promise<Map<string, number>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT COALESCE(a.placa, c.placa) AS placa, DATE_FORMAT(a.fecha, '%Y-%m-%d') AS fecha, a.efectivo, a.combustible FROM cuadro_anticipos a LEFT JOIN cuadro_viajes c ON c.id = a.cuadroViajeId"
  );
  const cuenta = new Map<string, number>();
  for (const r of rows) {
    const llave = llaveAnticipo(r.placa ?? "", r.fecha, Number(r.efectivo ?? 0), Number(r.combustible ?? 0));
    cuenta.set(llave, (cuenta.get(llave) ?? 0) + 1);
  }
  return cuenta;
}

/** Lo que se confirma de cada anticipo: la fila y el viaje elegido. */
export interface AnticipoConfirmado extends AnticipoImportado {
  viajeId: number;
}

/**
 * Carga los anticipos confirmados en una transaccion: por cada uno, la bomba
 * (se crea si no existe), el tanqueo con la factura de la bomba y el tramo de
 * IDA en el viaje con efectivo, combustible, galones, descuento y fecha de
 * pago a la bomba. Se saltan tantos de cada llave como ya haya en la base
 * (reimportar no duplica; dos filas iguales del mismo Excel si se cargan).
 */
export async function importarAnticipos(filas: AnticipoConfirmado[], usuarioId: number | null): Promise<{ cargados: number; repetidos: number }> {
  if (!Array.isArray(filas) || filas.length === 0) throw new ErrorCuadro("No hay anticipos para cargar.");
  const existentes = await anticiposExistentes();
  const conexion = await pool.getConnection();
  let cargados = 0;
  let repetidos = 0;
  const bombas = new Map<string, number>();
  try {
    await conexion.beginTransaction();
    const bombaDe = async (nombre: string): Promise<number> => {
      const clave = limpio(nombre);
      if (bombas.has(clave)) return bombas.get(clave)!;
      const [hay] = await conexion.query<RowDataPacket[]>("SELECT id, nombre FROM bombas");
      const existente = hay.find((b) => limpio(b.nombre) === clave);
      const id = existente
        ? existente.id
        : (await conexion.query<ResultSetHeader>("INSERT INTO bombas (nombre) VALUES (?)", [nombre.trim().toUpperCase()]))[0].insertId;
      bombas.set(clave, id);
      return id;
    };
    for (const a of filas) {
      const fecha = fechaONull(a.fecha);
      if (!fecha || !a.placa || !a.viajeId) throw new ErrorCuadro(`Fila ${a.fila}: falta la fecha, la placa o el viaje.`);
      const efectivo = Math.round(Number(a.efectivo) || 0);
      const combustible = Math.round(Number(a.combustible) || 0);
      const llave = llaveAnticipo(a.placa, fecha, efectivo, combustible);
      if ((existentes.get(llave) ?? 0) > 0) {
        existentes.set(llave, existentes.get(llave)! - 1);
        repetidos++;
        continue;
      }
      const [viaje] = await conexion.query<RowDataPacket[]>("SELECT id FROM cuadro_viajes WHERE id = ? AND anulado = 0", [a.viajeId]);
      if (!viaje[0]) throw new ErrorCuadro(`Fila ${a.fila}: el viaje elegido no existe o esta anulado.`);
      const bombaId = a.eds ? await bombaDe(a.eds) : null;
      const placa = placaNormal(a.placa);
      const galones = a.galones === null || a.galones === undefined || !Number(a.galones) ? null : Number(a.galones);
      const descuento = Math.round(Number(a.descuento) || 0);
      const [t] = await conexion.query<ResultSetHeader>(
        `INSERT INTO anticipos_tanqueo (placa, fecha, bombaId, idaYVuelta, facturaBomba, fechaFacturaBomba, nota, creadoPorId)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
        [placa, fecha, bombaId, a.facturaBomba || null, fechaONull(a.fechaFacturaBomba), "Cargado del Excel de anticipos", usuarioId]
      );
      await conexion.query(
        `INSERT INTO cuadro_anticipos
           (cuadroViajeId, tanqueoId, tramo, placa, bombaId, efectivo, combustible, valor, fecha, fechaPago,
            galones, precioGalon, descuento, nota, creadoPorId)
         VALUES (?, ?, 'IDA', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          a.viajeId,
          t.insertId,
          placa,
          bombaId,
          efectivo,
          combustible,
          efectivo + combustible,
          fecha,
          fechaONull(a.fechaPago),
          galones,
          // Precio por galon con que salio el combustible: (combustible + descuento) / galones.
          galones ? Math.round(((combustible + descuento) / galones) * 100) / 100 : null,
          descuento || null,
          "Cargado del Excel de anticipos",
          usuarioId,
        ]
      );
      cargados++;
    }
    await conexion.commit();
  } catch (exc) {
    await conexion.rollback();
    throw exc;
  } finally {
    conexion.release();
  }
  return { cargados, repetidos };
}

/** Propuesta de la cartera con los viajes actuales del cuadro. */
export async function propuestaCartera(facturas: FacturaImportada[]) {
  if (!Array.isArray(facturas) || facturas.length === 0) throw new ErrorCuadro("El archivo no trae facturas.");
  return proponerCartera(facturas, await cuadro.listar());
}

/** Propuesta de los anticipos con los viajes actuales del cuadro. */
export async function propuestaAnticipos(filas: AnticipoImportado[]) {
  if (!Array.isArray(filas) || filas.length === 0) throw new ErrorCuadro("El archivo no trae anticipos.");
  return proponerAnticipos(filas, await cuadro.listar(), await anticiposExistentes());
}
