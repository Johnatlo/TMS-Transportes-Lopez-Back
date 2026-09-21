/**
 * Alertas de vencimiento de documentos.
 *
 * Por que importa: el RNDC valida SOAT, tecnomecanica y licencia contra la
 * fecha mas alta de cita de DESCARGUE del manifiesto, no contra hoy. Un
 * documento que vence pasado manana ya bloquea un viaje que descarga el
 * viernes. Por eso las alertas miran hacia adelante y no solo a lo vencido.
 */

import { vehiculos, conductores, remolques, parametros } from "./repo";

/** Umbrales en dias. Se puede pedir otro al consultar. */
export const DIAS_AVISO_POR_DEFECTO = 30;

export type Severidad = "VENCIDO" | "POR_VENCER" | "VIGENTE";

export interface AlertaDocumento {
  tipo: "SOAT" | "TECNOMECANICA" | "LICENCIA" | "POLIZA";
  /** Placa o nombre del conductor. */
  sujeto: string;
  /** Identificacion del sujeto, para poder buscarlo. */
  identificacion: string | null;
  fechaVencimiento: Date | null;
  /** Negativo si ya vencio. */
  diasRestantes: number | null;
  severidad: Severidad;
  mensaje: string;
}

function diasHasta(fecha: Date | null): number | null {
  if (!fecha) return null;
  const hoy = new Date();
  // Se comparan dias calendario, no instantes: un documento que vence hoy
  // sigue siendo valido hoy.
  const a = Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate());
  const b = Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate());
  return Math.round((a - b) / 86_400_000);
}

function severidadDe(dias: number | null, diasAviso: number): Severidad {
  if (dias === null) return "VIGENTE";
  if (dias < 0) return "VENCIDO";
  if (dias <= diasAviso) return "POR_VENCER";
  return "VIGENTE";
}

function describir(tipo: string, sujeto: string, dias: number | null): string {
  if (dias === null) return `${tipo} de ${sujeto}: sin fecha registrada`;
  if (dias < 0) return `${tipo} de ${sujeto} vencio hace ${Math.abs(dias)} dia(s)`;
  if (dias === 0) return `${tipo} de ${sujeto} vence hoy`;
  return `${tipo} de ${sujeto} vence en ${dias} dia(s)`;
}

function alerta(
  tipo: AlertaDocumento["tipo"],
  sujeto: string,
  identificacion: string | null,
  fecha: Date | null,
  diasAviso: number
): AlertaDocumento {
  const dias = diasHasta(fecha);
  return {
    tipo,
    sujeto,
    identificacion,
    fechaVencimiento: fecha,
    diasRestantes: dias,
    severidad: severidadDe(dias, diasAviso),
    mensaje: describir(tipo, sujeto, dias),
  };
}

export interface ResumenAlertas {
  vencidos: AlertaDocumento[];
  porVencer: AlertaDocumento[];
  sinFecha: AlertaDocumento[];
  diasAviso: number;
  /** Cuantos elementos se revisaron, para dar contexto al conteo. */
  revisados: { vehiculos: number; remolques: number; conductores: number };
}

/**
 * Revisa toda la flota y los conductores activos.
 *
 * Los registros sin fecha se reportan aparte: no estan vencidos, pero tampoco
 * se puede afirmar que esten vigentes, y esa diferencia importa porque el
 * despacho si los deja pasar.
 */
export async function revisarVencimientos(
  diasAviso = DIAS_AVISO_POR_DEFECTO
): Promise<ResumenAlertas> {
  const [flota, trailers, personal, params] = await Promise.all([
    vehiculos.findMany(),
    remolques.findMany(),
    conductores.findMany(),
    parametros.obtener(),
  ]);

  const activos = flota.filter((v) => v.activo);
  const trailersActivos = trailers.filter((r) => r.activo);
  const conductoresActivos = personal.filter((c) => c.activo);

  const todas: AlertaDocumento[] = [];

  for (const v of activos) {
    todas.push(alerta("SOAT", v.placa, v.placa, v.fechaVencSoat, diasAviso));
    todas.push(
      alerta("TECNOMECANICA", v.placa, v.placa, v.fechaVencTecnomecanica, diasAviso)
    );
  }

  // Los remolques tambien llevan tecnomecanica y el RNDC la valida.
  for (const r of trailersActivos) {
    todas.push(
      alerta("TECNOMECANICA", `${r.placa} (remolque)`, r.placa, r.fechaVencTecnomecanica, diasAviso)
    );
  }

  for (const c of conductoresActivos) {
    todas.push(alerta("LICENCIA", c.nombre, c.cedula, c.fechaVencLicencia, diasAviso));
  }

  // La poliza de carga de la empresa es una sola, pero su vencimiento para el
  // mismo tipo de problema: se pasa la renovacion anual y nadie se entera.
  todas.push(
    alerta(
      "POLIZA",
      "poliza de carga de la empresa",
      params.numeroPolizaTransporte,
      params.fechaVencimientoPolizaCarga,
      diasAviso
    )
  );

  const ordenar = (a: AlertaDocumento, b: AlertaDocumento) =>
    (a.diasRestantes ?? 0) - (b.diasRestantes ?? 0);

  return {
    vencidos: todas.filter((a) => a.severidad === "VENCIDO").sort(ordenar),
    porVencer: todas.filter((a) => a.severidad === "POR_VENCER").sort(ordenar),
    sinFecha: todas.filter((a) => a.fechaVencimiento === null),
    diasAviso,
    revisados: {
      vehiculos: activos.length,
      remolques: trailersActivos.length,
      conductores: conductoresActivos.length,
    },
  };
}
