/**
 * Representacion impresa de la remesa terrestre de carga.
 *
 * El RNDC genera un PDF oficial de la remesa solo desde su portal web; por
 * webservice responde "RNDC12: El procesoid 3 no es correcto para generar el
 * PDF" (verificado 2026-09-26). El Manual de Operacion General del RNDC
 * (5.2.3, salidas de informacion) autoriza a la empresa de transporte a usar
 * los datos de la remesa radicada y "bajo su responsabilidad" generar su
 * propio documento.
 *
 * Esto es ese documento. Replica la organizacion y los campos de la remesa
 * oficial que produce el portal (ejemplo en docs/Remesa de ejemplo.pdf), con
 * el logo de la empresa, pero SIN los logos del Ministerio: la genera la
 * empresa, no el RNDC. Lleva el numero de radicado (autorizacion) del RNDC
 * para que se pueda verificar.
 *
 * Se entrega como HTML listo para imprimir: el navegador ya sabe imprimir y
 * guardar como PDF, sin meter un motor de renderizado solo para esto.
 */

import {
  ViajeRemesa,
  PlantillaViajeConRelaciones,
  Viaje,
  Vehiculo,
  Conductor,
  Tercero,
  ParametrosEmpresa,
} from "../repo";
import { TIPOS_EMPAQUE } from "./builders";

function escapar(valor: unknown): string {
  if (valor === null || valor === undefined || valor === "") return "";
  return String(valor)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** AAAA/MM/DD y HH:MM en hora de Colombia, como en la remesa oficial. */
function partesFecha(valor: Date | null | undefined): { fecha: string; hora: string } {
  if (!valor) return { fecha: "", hora: "" };
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(valor))) {
    p[x.type] = x.value;
  }
  return { fecha: `${p.year}/${p.month}/${p.day}`, hora: `${p.hour}:${p.minute}` };
}

/** Columna DATE (sin hora): se lee el dia guardado, sin zona horaria. */
function dia(valor: Date | null | undefined): string {
  if (!valor) return "";
  const d = new Date(valor);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

function numero(valor: number | null | undefined): string {
  if (valor === null || valor === undefined) return "";
  return new Intl.NumberFormat("es-CO").format(valor);
}

function coordenadas(t: Tercero): string {
  if (t.latitud === null || t.longitud === null) return "";
  return `Latitud: ${t.latitud}  Longitud: ${t.longitud}`;
}

// Textos de los codigos. Solo los que tienen respaldo:
// - Tipo de operacion "G" = General [REM V5, tipos de operacion].
// - Naturaleza "1": la remesa oficial la imprime como "Carga Normal"; es la
//   unica que usa la empresa (no transporta mercancia peligrosa).
// - Unidades comerciales [REM V5 pag. 47-48].
// - Tipos de empaque: ver TIPOS_EMPAQUE en builders.ts. Un codigo que no este
//   ahi se imprime como "Codigo N" en vez de inventarle nombre.
const OPERACION: Record<string, string> = { G: "General" };
const NATURALEZA: Record<string, string> = { "1": "Carga Normal" };
const UNIDAD: Record<string, string> = {
  KGM: "Kilogramos",
  GLL: "Galones",
  MTQ: "Metros cubicos",
  CMQ: "Centimetros cubicos",
  LTR: "Litros",
  MLT: "Mililitros",
  BLL: "Barriles",
  UN: "Unidades",
};
const EMPAQUE = TIPOS_EMPAQUE;

const texto = (tabla: Record<string, string>, codigo: string | null | undefined) =>
  codigo ? (tabla[codigo] ?? `Codigo ${codigo}`) : "";

export interface EmpresaImpresion {
  nombre: string;
  nit: string;
  direccion: string;
  telefono: string;
  municipio: string;
}

export interface DatosImpresionRemesa {
  remesa: ViajeRemesa;
  plantilla: PlantillaViajeConRelaciones;
  viaje: Viaje;
  vehiculo: Vehiculo | null;
  conductor: Conductor | null;
  empresa: EmpresaImpresion;
  /** La poliza de carga es una sola para toda la empresa. */
  poliza: Pick<
    ParametrosEmpresa,
    "tomadorPolizaCarga" | "numeroPolizaTransporte" | "companiaSeguro" | "fechaVencimientoPolizaCarga"
  > | null;
  /** Logo de la empresa como data URI (ver estampado.ts). */
  logoDataUri?: string | null;
}

export function construirHtmlRemesa(d: DatosImpresionRemesa): string {
  const { remesa, plantilla, viaje, vehiculo, conductor, empresa, poliza } = d;
  const rem = plantilla.remitente;
  const des = plantilla.destinatario;
  const con = plantilla.contratante;
  const cargue = partesFecha(remesa.fechaHoraCargue);
  const descargue = partesFecha(remesa.fechaHoraDescargue);
  const tiempo = (h: number, m: number) => `${h} Horas ${m} Minutos`;

  // Igual que al enviarla (construirDatosRemesa): si la unidad comercial son
  // kilos y no se digito cantidad, la cantidad es el peso.
  const cantidad =
    remesa.cantidadReal ?? (plantilla.unidadMedidaProducto === "KGM" ? remesa.pesoReal : null);

  const lugar = (titulo: string, t: Tercero, cita: { fecha: string; hora: string }, pacto: string) => `
    <td class="mitad">
      <table class="rejilla">
        <tr><th colspan="2" class="subtitulo">${titulo}</th></tr>
        <tr><th>Nombre:</th><td>${escapar(t.nombre)}</td></tr>
        <tr><th>Identificacion:</th><td>${escapar(t.codTipoId === "N" ? "NIT" : t.codTipoId)} ${escapar(t.nit)}</td></tr>
        <tr><th>Sede:</th><td>${escapar(t.codSede)}</td></tr>
        <tr><th>Direccion:</th><td>${escapar(t.direccion)}</td></tr>
        <tr><th>Coordenadas:</th><td>${escapar(coordenadas(t))}</td></tr>
        <tr><th>Municipio:</th><td>${escapar(t.ciudad)}</td></tr>
        <tr><th>Fecha Hora Cita</th><td>${escapar(cita.fecha)} &nbsp; ${escapar(cita.hora)}</td></tr>
        <tr><th>Tiempo Pactado</th><td>${escapar(pacto)}</td></tr>
        <tr><th>Trasbordo</th><td>0</td></tr>
      </table>
    </td>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Remesa ${escapar(remesa.consecutivoRemesa)}</title>
<style>
  @page { size: letter; margin: 1cm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10.5px; color: #111; margin: 0; }
  .hoja { max-width: 20cm; margin: 0 auto; }
  .encabezado { display: grid; grid-template-columns: 1fr 1.4fr 1fr; align-items: center;
                gap: 10px; margin-bottom: 8px; }
  .encabezado img { max-width: 100%; max-height: 80px; }
  .encabezado .centro { text-align: center; line-height: 1.35; }
  .encabezado .centro .titulo { font-size: 13px; font-weight: bold; text-decoration: underline; }
  .encabezado .centro .empresa { font-size: 12px; font-weight: bold; }
  .encabezado .derecha { text-align: center; font-weight: bold; font-size: 12px; line-height: 1.5; }
  .encabezado .derecha .valor { font-size: 12px; }
  table { border-collapse: collapse; width: 100%; }
  table.rejilla td, table.rejilla th { border: 1px solid #333; padding: 3px 5px; vertical-align: top; }
  table.rejilla th { text-align: left; font-weight: bold; white-space: nowrap; }
  .subtitulo { font-size: 12.5px; text-align: center !important; background: #f3f4f6; }
  .seccion { font-size: 12.5px; background: #f3f4f6; }
  .mitad { width: 50%; padding: 0; vertical-align: top; }
  .mitad table.rejilla { height: 100%; }
  .bloque { margin-top: 6px; }
  .firmas td { height: 48px; border: 1px solid #333; vertical-align: bottom;
               text-align: center; font-size: 9.5px; color: #444; }
  .pie { margin-top: 6px; font-size: 8.5px; color: #555; }
  @media print { .no-imprimir { display: none; } }
  .no-imprimir { margin: 8px 0 12px; }
  .no-imprimir button { font-size: 12px; padding: 7px 14px; cursor: pointer; }
</style>
</head>
<body>
<div class="hoja">

<div class="no-imprimir">
  <button onclick="window.print()">Imprimir o guardar como PDF</button>
</div>

<div class="encabezado">
  <div>${d.logoDataUri ? `<img src="${d.logoDataUri}" alt="Logo de la empresa">` : ""}</div>
  <div class="centro">
    <div class="titulo">REMESA TERRESTRE DE CARGA</div>
    <div class="empresa">${escapar(empresa.nombre)}</div>
    <div><strong>Nit: ${escapar(empresa.nit)}</strong></div>
    <div>${escapar(empresa.direccion)}</div>
    <div>${empresa.telefono ? `Tel: ${escapar(empresa.telefono)}` : ""}</div>
    <div>${escapar(empresa.municipio)}</div>
  </div>
  <div class="derecha">
    <div>Consecutivo REMESA</div>
    <div class="valor">${escapar(remesa.consecutivoRemesa)}</div>
    <div style="margin-top:6px">Num. AUTORIZACION</div>
    <div class="valor">${escapar(remesa.numeroRemesaRndc)}</div>
  </div>
</div>

<table class="rejilla">
  <tr>
    <th style="width:28%">Tipo de Operacion:</th><th style="width:44%">Tipo Empaque:</th><th>Orden Servicio</th>
  </tr>
  <tr>
    <td>${escapar(texto(OPERACION, plantilla.tipoOperacionRemesa))}</td>
    <td>${escapar(texto(EMPAQUE, plantilla.codTipoEmpaque))}${plantilla.empaquePrimario ? ` / ${escapar(plantilla.empaquePrimario)}` : ""}</td>
    <td>${escapar(remesa.ordenServicioGenerador)}</td>
  </tr>
  <tr><th>Contratante/Generador:</th><td colspan="2">${escapar(con.codTipoId === "N" ? "NIT" : con.codTipoId)} - ${escapar(con.nit)}</td></tr>
  <tr><th>Nombre o Razon Social:</th><td colspan="2">${escapar(con.nombre)}</td></tr>
  <tr><th>Direccion:</th><td colspan="2">${escapar(con.direccion)}</td></tr>
</table>

<table class="rejilla bloque">
  <tr><th colspan="6" class="seccion">Informacion de la Carga</th></tr>
  <tr>
    <th>Naturaleza:</th><td colspan="2">${escapar(texto(NATURALEZA, plantilla.codNaturalezaCarga))}</td>
    <th>Codigo Producto (Cod. Armonizada)</th><td colspan="2">${escapar(plantilla.codMercancia)}</td>
  </tr>
  <tr>
    <th>Cantidad Kilos:</th><td>${escapar(numero(remesa.pesoReal))}</td>
    <th>U/M Mercancia</th><td>${escapar(texto(UNIDAD, plantilla.unidadMedidaProducto))}</td>
    <th>Cantidad:</th><td>${escapar(numero(cantidad))}</td>
  </tr>
  <tr><th>Designacion</th><td colspan="5">${escapar(plantilla.tipoMercancia)}</td></tr>
  <tr><th>Mercancia peligrosa</th><td colspan="5">No aplica (carga general)</td></tr>
</table>

<table class="bloque">
  <tr>
    ${lugar("Remitente / Lugar de Cargue:", rem, cargue, tiempo(plantilla.horasPactoCargue, plantilla.minutosPactoCargue))}
    ${lugar("Destinatario / Lugar de Descargue:", des, descargue, tiempo(plantilla.horasPactoDescargue, plantilla.minutosPactoDescargue))}
  </tr>
</table>

<table class="rejilla bloque">
  <tr><th>Tomador Poliza</th><th>No. Poliza</th><th>Aseguradora</th><th>Fecha Vencimiento</th></tr>
  <tr>
    <td>${escapar(poliza?.tomadorPolizaCarga)}</td>
    <td>${escapar(poliza?.numeroPolizaTransporte)}</td>
    <td>${escapar(poliza?.companiaSeguro)}</td>
    <td>${escapar(dia(poliza?.fechaVencimientoPolizaCarga))}</td>
  </tr>
</table>

<table class="rejilla bloque">
  <tr><th>Manifiesto No.</th><th>Placa</th><th>Conductor</th><th>Identificacion</th></tr>
  <tr>
    <td>${escapar(viaje.consecutivoManifiesto)}${viaje.numeroManifiestoRndc ? ` (autorizacion ${escapar(viaje.numeroManifiestoRndc)})` : ""}</td>
    <td>${escapar(vehiculo?.placa)}</td>
    <td>${escapar(conductor?.nombre)}</td>
    <td>${escapar(conductor?.cedula)}</td>
  </tr>
</table>

<table class="rejilla bloque">
  <tr><th>OBSERVACIONES</th></tr>
  <tr><td style="height:44px">${escapar(plantilla.observaciones)}</td></tr>
</table>

<table class="firmas bloque">
  <tr>
    <td>Firma remitente</td>
    <td>Firma conductor</td>
    <td>Firma destinatario</td>
  </tr>
</table>

<div class="pie">
  Documento generado por ${escapar(empresa.nombre)} con los datos radicados en el Registro Nacional
  de Despachos de Carga (RNDC) bajo la autorizacion ${escapar(remesa.numeroRemesaRndc)}, conforme
  al Manual de Operacion del RNDC. El documento que ampara el transporte ante las autoridades es el
  manifiesto electronico de carga.
</div>

</div>
</body>
</html>`;
}
