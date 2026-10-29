/**
 * Manifiestos de contingencia (ver rndc/manifiesto-contingencia.ts): cuando
 * el RNDC no deja expedir el manifiesto o no entrega su PDF, la empresa
 * imprime uno propio para que el carro salga. El viaje queda marcado
 * (viajes.contingenciaEn) y con alerta en la campana hasta que se imprime el
 * manifiesto oficial.
 */
import type { RowDataPacket } from "mysql2";
import { pool } from "./db";
import { config } from "./config";
import { conductores, plantillas, remolques, vehiculos, viajeRemesas } from "./repo";
import type { Viaje } from "./repo";
import { TIPOS_EMPAQUE, TIPO_MANIFIESTO } from "./rndc/builders";
import type { DatosManifiestoContingencia, ParteContingencia } from "./rndc/manifiesto-contingencia";
import { logoComoDataUri } from "./rndc/estampado";

/** Nombre del tipo de manifiesto (codigos de TIPO_MANIFIESTO). */
const TIPOS: Record<string, string> = {
  [TIPO_MANIFIESTO.GENERAL]: "General",
  [TIPO_MANIFIESTO.VACIO]: "Vacio",
  [TIPO_MANIFIESTO.IDA_Y_REGRESO]: "Ida y regreso",
  [TIPO_MANIFIESTO.MULTIPARADA]: "Multiparada",
  [TIPO_MANIFIESTO.URBANO]: "Urbano",
  [TIPO_MANIFIESTO.VARIOS_VIAJES_DIA]: "Varios viajes en el dia",
};
/** Quien paga el cargue y el descargue: solo los codigos que se conocen; el resto, el codigo. */
const RESPONSABLE: Record<string, string> = { R: "REMITENTE", D: "DESTINATARIO" };
/** Naturaleza de la carga: la empresa solo lleva carga normal (codigo 1). */
const NATURALEZA: Record<string, string> = { "1": "Carga Normal" };

/** Texto que puede faltar. */
type Texto = string | null | undefined;
/** Valor del manifiesto como texto; vacio -> null. */
const t = (x: unknown) => (x === null || x === undefined || x === "" ? null : String(x));
/** Valor del manifiesto como numero; vacio -> 0. */
const n = (x: unknown) => (x === null || x === undefined || x === "" ? 0 : Number(x));

/**
 * Nombre "MUNICIPIO DEPARTAMENTO" de cada codigo de 8 digitos: del catalogo de
 * municipios; si no se importo, la ciudad de algun tercero de ese municipio
 * (como el cuadro pagos).
 */
async function nombresMunicipios(codigos: Texto[]): Promise<Map<string, string>> {
  const lista = [...new Set(codigos.filter((c): c is string => !!c).map((c) => c.padStart(8, "0")))];
  if (!lista.length) return new Map();
  const [catalogo] = await pool.query<RowDataPacket[]>("SELECT codigo, nombre, departamento FROM municipios WHERE codigo IN (?)", [lista]);
  const nombres = new Map(catalogo.map((r) => [String(r.codigo), [r.nombre, r.departamento].filter(Boolean).join(" ")]));
  const faltan = lista.filter((c) => !nombres.has(c));
  if (faltan.length) {
    const [ciudades] = await pool.query<RowDataPacket[]>(
      "SELECT LPAD(codMunicipioRndc, 8, '0') AS codigo, MAX(ciudad) AS ciudad FROM terceros WHERE LPAD(codMunicipioRndc, 8, '0') IN (?) GROUP BY 1",
      [faltan]
    );
    for (const r of ciudades) if (r.ciudad) nombres.set(String(r.codigo), String(r.ciudad));
  }
  return nombres;
}

/** Nombre del titular del manifiesto: el de Flota, o el tercero o conductor con esa cedula. */
async function nombreTitular(numId: Texto, nombreFlota: Texto): Promise<string> {
  if (nombreFlota?.trim()) return nombreFlota.trim();
  if (!numId) return "";
  const [[r]] = await pool.query<RowDataPacket[]>(
    `SELECT COALESCE((SELECT MIN(nombre) FROM terceros WHERE nit = ?), (SELECT MIN(nombre) FROM conductores WHERE cedula = ?)) AS nombre`,
    [numId, numId]
  );
  return r?.nombre ?? "";
}

/**
 * Datos del manifiesto de contingencia de un viaje, a partir de lo que se
 * envia (o se enviaria) al RNDC (manifiesto = construirDatosManifiesto) y de
 * las plantillas de sus remesas.
 */
export async function datosContingencia(
  viaje: Viaje,
  manifiesto: Record<string, unknown>,
  via: { codVia: string; descripcion: string } | null,
  motivo: string | null
): Promise<DatosManifiestoContingencia> {
  const [vehiculo, conductor, conductor2, remolque, filas] = await Promise.all([
    vehiculos.findById(viaje.vehiculoId),
    conductores.findById(viaje.conductorId),
    viaje.conductor2Id ? conductores.findById(viaje.conductor2Id) : Promise.resolve(null),
    viaje.remolqueId ? remolques.findById(viaje.remolqueId) : Promise.resolve(null),
    viajeRemesas.findByViaje(viaje.id),
  ]);
  const vivas = filas.filter((f) => f.estado !== "ANULADA");
  const plantillasRemesa = await Promise.all(vivas.map((f) => plantillas.findById(f.plantillaId)));
  const municipios = await nombresMunicipios([
    t(manifiesto.CODMUNICIPIOORIGENMANIFIESTO),
    t(manifiesto.CODMUNICIPIODESTINOMANIFIESTO),
    t(manifiesto.CODMUNICIPIOPAGOSALDO),
    conductor?.codMunicipioRndc,
  ]);
  const municipio = (c: unknown) => (c ? municipios.get(String(c).padStart(8, "0")) ?? String(c) : null);
  const parte = (p: { codTipoId: string; nit: string; nombre: string; direccion: string | null; ciudad: string | null } | undefined): ParteContingencia => ({
    id: p ? `${p.codTipoId === "N" ? "NIT" : p.codTipoId} ${p.nit}` : "",
    nombre: p?.nombre ?? "",
    direccion: p?.direccion ?? null,
    municipio: p?.ciudad ?? null,
  });

  const total = n(manifiesto.VALORFLETEPACTADOVIAJE);
  const icaPorMil = n(manifiesto.RETENCIONICAMANIFIESTOCARGA);
  const diaSoat = vehiculo?.fechaVencSoat ? new Date(vehiculo.fechaVencSoat) : null;
  return {
    empresa: {
      nombre: config.empresa.nombre,
      nit: config.rndc.empresaNit,
      direccion: config.empresa.direccion,
      telefono: config.empresa.telefono,
      municipio: config.empresa.municipio,
    },
    logoDataUri: logoComoDataUri(),
    consecutivo: viaje.consecutivoManifiesto ?? "",
    radicado: viaje.numeroManifiestoRndc,
    generadoEn: new Date(),
    motivo,
    fechaExpedicion: t(manifiesto.FECHAEXPEDICIONMANIFIESTO) ?? "",
    tipoManifiesto: TIPOS[String(manifiesto.CODOPERACIONTRANSPORTE)] ?? String(manifiesto.CODOPERACIONTRANSPORTE ?? ""),
    origen: municipio(manifiesto.CODMUNICIPIOORIGENMANIFIESTO) ?? "",
    destino: municipio(manifiesto.CODMUNICIPIODESTINOMANIFIESTO) ?? "",
    via: via ? `${via.codVia} ${via.descripcion ?? ""}`.trim() : t(manifiesto.CODVIA),
    titular: {
      nombre: await nombreTitular(t(manifiesto.NUMIDTITULARMANIFIESTO), vehiculo?.nombreTenedor),
      id: t(manifiesto.NUMIDTITULARMANIFIESTO) ?? "",
      direccion: null,
      municipio: null,
    },
    vehiculo: {
      placa: vehiculo?.placa ?? "",
      marca: vehiculo?.marca ?? null,
      configuracion: vehiculo?.configuracion ?? null,
      pesoVacio: vehiculo?.pesoVehiculoVacio ?? null,
      remolque: remolque?.placa ?? null,
      soatVence: diaSoat ? `${String(diaSoat.getUTCDate()).padStart(2, "0")}/${String(diaSoat.getUTCMonth() + 1).padStart(2, "0")}/${diaSoat.getUTCFullYear()}` : null,
    },
    conductor: {
      nombre: conductor?.nombre ?? "",
      cedula: conductor?.cedula ?? "",
      licencia: conductor?.licencia ?? null,
      direccion: conductor?.direccion ?? null,
      municipio: municipio(conductor?.codMunicipioRndc) ?? conductor?.ciudad ?? null,
    },
    conductor2: conductor2 ? { nombre: conductor2.nombre, cedula: conductor2.cedula } : null,
    remesas: vivas.map((f, i) => {
      const p = plantillasRemesa[i];
      return {
        consecutivo: f.consecutivoRemesa ?? "",
        radicado: f.numeroRemesaRndc ?? null,
        // Como en el oficial: la cantidad cargada en kilogramos.
        unidad: "Kilogramos",
        cantidad: f.pesoReal ?? null,
        naturaleza: p ? NATURALEZA[p.codNaturalezaCarga] ?? `Codigo ${p.codNaturalezaCarga}` : "",
        empaque: p ? TIPOS_EMPAQUE[p.codTipoEmpaque] ?? `Codigo ${p.codTipoEmpaque}` : "",
        codMercancia: p?.codMercancia ?? null,
        producto: p?.tipoMercancia ?? null,
        remitente: parte(p?.remitente),
        destinatario: parte(p?.destinatario),
      };
    }),
    valores: {
      total,
      retencionFuente: n(manifiesto.RETENCIONFUENTEMANIFIESTO),
      icaPorMil,
      retencionIca: Math.round((total * icaPorMil) / 1000),
      retencionFopat: n(manifiesto.RETENCIONFOPAT),
      anticipo: n(manifiesto.VALORANTICIPOMANIFIESTO),
      lugarPago: municipio(manifiesto.CODMUNICIPIOPAGOSALDO),
      fechaPago: t(manifiesto.FECHAPAGOSALDOMANIFIESTO),
      cargue: RESPONSABLE[String(manifiesto.CODRESPONSABLEPAGOCARGUE)] ?? String(manifiesto.CODRESPONSABLEPAGOCARGUE ?? ""),
      descargue: RESPONSABLE[String(manifiesto.CODRESPONSABLEPAGODESCARGUE)] ?? String(manifiesto.CODRESPONSABLEPAGODESCARGUE ?? ""),
    },
    observaciones: t(manifiesto.OBSERVACIONES),
  };
}

/** Un viaje con manifiesto de contingencia pendiente de reemplazar por el oficial. */
export interface ViajeContingencia {
  id: number;
  consecutivoManifiesto: string | null;
  placa: string | null;
  radicado: string | null;
  estado: string;
  contingenciaEn: string;
  motivo: string | null;
}

/** Repositorio de la marca de contingencia de los viajes. */
export const contingencia = {
  /** Marca el viaje: se imprimio de contingencia (conserva la primera fecha; el motivo, el ultimo). */
  async marcar(viajeId: number, motivo: string | null) {
    await pool.query(
      "UPDATE viajes SET contingenciaEn = COALESCE(contingenciaEn, ?), contingenciaMotivo = COALESCE(?, contingenciaMotivo) WHERE id = ?",
      [new Date(), motivo?.slice(0, 300) ?? null, viajeId]
    );
  },

  /** Se imprimio el manifiesto oficial: ya no hay contingencia pendiente. */
  async resolver(viajeId: number) {
    await pool.query("UPDATE viajes SET contingenciaEn = NULL, contingenciaMotivo = NULL WHERE id = ? AND contingenciaEn IS NOT NULL", [viajeId]);
  },

  /** Viajes con contingencia pendiente (no anulados), los mas viejos primero. */
  async pendientes(): Promise<ViajeContingencia[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT v.id, v.consecutivoManifiesto, COALESCE(ve.placa, v.placaRndc) AS placa, v.numeroManifiestoRndc AS radicado,
              v.estado, v.contingenciaEn, v.contingenciaMotivo AS motivo
         FROM viajes v LEFT JOIN vehiculos ve ON ve.id = v.vehiculoId
        WHERE v.contingenciaEn IS NOT NULL AND v.estado <> 'ANULADO'
        ORDER BY v.contingenciaEn`
    );
    return rows.map((r) => ({
      id: Number(r.id),
      consecutivoManifiesto: r.consecutivoManifiesto ?? null,
      placa: r.placa ?? null,
      radicado: r.radicado ?? null,
      estado: String(r.estado),
      contingenciaEn: new Date(r.contingenciaEn).toISOString(),
      motivo: r.motivo ?? null,
    }));
  },
};
