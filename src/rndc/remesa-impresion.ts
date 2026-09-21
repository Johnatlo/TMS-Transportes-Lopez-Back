/**
 * Representacion impresa de la remesa terrestre de carga.
 *
 * El RNDC entrega el PDF oficial del MANIFIESTO, pero no documenta uno
 * equivalente para la remesa. Lo que si autoriza el Manual de Operacion General
 * del RNDC (5.2.3, salidas de informacion) es que la empresa de transporte use
 * los datos de la remesa radicada y "bajo su responsabilidad podra generar un
 * documento en formato PDF".
 *
 * Esto es exactamente eso: una representacion propia, generada con los datos
 * que quedaron radicados. Lleva el numero de radicado del RNDC para que el
 * cliente pueda verificarla, y dice de forma visible que es un documento
 * generado por la empresa y no por el Ministerio, para que nadie la confunda
 * con el manifiesto oficial.
 *
 * Se entrega como HTML listo para imprimir en vez de un PDF binario: el
 * navegador ya sabe imprimir y guardar como PDF, y asi no hace falta meter un
 * motor de renderizado (Chrome headless o similar) solo para esto.
 */

import { ViajeRemesa, PlantillaViajeConRelaciones, Viaje, Vehiculo, Conductor } from "../repo";

function escapar(valor: unknown): string {
  if (valor === null || valor === undefined || valor === "") return "-";
  return String(valor)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const FORMATO_FECHA = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function fechaHora(valor: Date | null | undefined): string {
  if (!valor) return "-";
  return FORMATO_FECHA.format(new Date(valor));
}

function numero(valor: number | null | undefined, sufijo = ""): string {
  if (valor === null || valor === undefined) return "-";
  return `${new Intl.NumberFormat("es-CO").format(valor)}${sufijo}`;
}

export interface DatosImpresionRemesa {
  remesa: ViajeRemesa;
  plantilla: PlantillaViajeConRelaciones;
  viaje: Viaje;
  vehiculo: Vehiculo | null;
  conductor: Conductor | null;
  nombreEmpresa: string;
  nitEmpresa: string;
  /** Texto que advierte que el RNDC no entrego el documento oficial. */
  motivoRepresentacionPropia?: string | null;
}

export function construirHtmlRemesa(d: DatosImpresionRemesa): string {
  const { remesa, plantilla, viaje, vehiculo, conductor } = d;

  const filaTercero = (titulo: string, t: { nombre: string; nit: string; codSede: string; direccion: string | null; ciudad: string | null }) => `
    <div class="bloque">
      <h3>${escapar(titulo)}</h3>
      <table class="datos">
        <tr><th>Nombre</th><td>${escapar(t.nombre)}</td></tr>
        <tr><th>Identificacion</th><td>${escapar(t.nit)}</td></tr>
        <tr><th>Sede</th><td>${escapar(t.codSede)}</td></tr>
        <tr><th>Direccion</th><td>${escapar(t.direccion)}</td></tr>
        <tr><th>Municipio</th><td>${escapar(t.ciudad)}</td></tr>
      </table>
    </div>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Remesa ${escapar(remesa.consecutivoRemesa)}</title>
<style>
  @page { size: letter; margin: 1.2cm; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #111; margin: 0; }
  .encabezado { display: flex; justify-content: space-between; align-items: flex-start;
                border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 12px; }
  .encabezado h1 { font-size: 16px; margin: 0 0 2px; }
  .encabezado .empresa { font-size: 12px; font-weight: bold; }
  .radicado { text-align: right; font-size: 12px; }
  .radicado strong { display: block; font-size: 15px; }
  .aviso { border: 1px solid #b45309; background: #fffbeb; color: #7c2d12;
           padding: 7px 9px; margin-bottom: 12px; font-size: 10px; }
  .columnas { display: flex; gap: 12px; }
  .columnas > * { flex: 1; }
  .bloque { border: 1px solid #cbd5e1; padding: 8px 10px; margin-bottom: 10px; }
  .bloque h3 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase;
               letter-spacing: .4px; border-bottom: 1px solid #e2e8f0; padding-bottom: 3px; }
  table.datos { width: 100%; border-collapse: collapse; }
  table.datos th { text-align: left; font-weight: normal; color: #475569;
                   width: 38%; padding: 2px 0; vertical-align: top; }
  table.datos td { padding: 2px 0; font-weight: bold; }
  .firmas { display: flex; gap: 40px; margin-top: 28px; }
  .firmas > div { flex: 1; border-top: 1px solid #111; padding-top: 4px;
                  text-align: center; font-size: 10px; }
  .pie { margin-top: 16px; font-size: 9px; color: #64748b; border-top: 1px solid #e2e8f0;
         padding-top: 6px; }
  @media print { .no-imprimir { display: none; } }
  .no-imprimir { margin-bottom: 12px; }
  .no-imprimir button { font-size: 12px; padding: 7px 14px; cursor: pointer; }
</style>
</head>
<body>

<div class="no-imprimir">
  <button onclick="window.print()">Imprimir o guardar como PDF</button>
</div>

<div class="encabezado">
  <div>
    <h1>REMESA TERRESTRE DE CARGA</h1>
    <div class="empresa">${escapar(d.nombreEmpresa)}</div>
    <div>NIT ${escapar(d.nitEmpresa)}</div>
  </div>
  <div class="radicado">
    <span>Consecutivo</span>
    <strong>${escapar(remesa.consecutivoRemesa)}</strong>
    <span>Radicado RNDC</span>
    <strong>${escapar(remesa.numeroRemesaRndc)}</strong>
  </div>
</div>

<div class="aviso">
  Documento generado por la empresa de transporte con los datos radicados en el RNDC bajo el
  numero indicado arriba, conforme al Manual de Operacion General del RNDC. <strong>No es el
  manifiesto electronico de carga</strong> ni reemplaza el documento que ampara el transporte
  ante las autoridades.${
    d.motivoRepresentacionPropia
      ? ` <br>${escapar(d.motivoRepresentacionPropia)}`
      : ""
  }
</div>

<div class="columnas">
  ${filaTercero("Generador de carga", plantilla.contratante)}
  ${filaTercero("Remitente / sitio de cargue", plantilla.remitente)}
  ${filaTercero("Destinatario / sitio de descargue", plantilla.destinatario)}
</div>

<div class="columnas">
  <div class="bloque">
    <h3>Mercancia</h3>
    <table class="datos">
      <tr><th>Descripcion</th><td>${escapar(plantilla.tipoMercancia)}</td></tr>
      <tr><th>Codigo producto</th><td>${escapar(plantilla.codMercancia)}</td></tr>
      <tr><th>Naturaleza</th><td>Carga general</td></tr>
      <tr><th>Peso</th><td>${numero(remesa.pesoReal, " kg")}</td></tr>
      <tr><th>Cantidad</th><td>${numero(remesa.cantidadReal)} ${escapar(plantilla.unidadMedidaProducto)}</td></tr>
      <tr><th>Orden de servicio</th><td>${escapar(remesa.ordenServicioGenerador)}</td></tr>
    </table>
  </div>

  <div class="bloque">
    <h3>Citas y tiempos pactados</h3>
    <table class="datos">
      <tr><th>Cita de cargue</th><td>${fechaHora(remesa.fechaHoraCargue)}</td></tr>
      <tr><th>Tiempo de cargue</th><td>${plantilla.horasPactoCargue} h ${plantilla.minutosPactoCargue} min</td></tr>
      <tr><th>Cita de descargue</th><td>${fechaHora(remesa.fechaHoraDescargue)}</td></tr>
      <tr><th>Tiempo de descargue</th><td>${plantilla.horasPactoDescargue} h ${plantilla.minutosPactoDescargue} min</td></tr>
    </table>
  </div>

  <div class="bloque">
    <h3>Transporte</h3>
    <table class="datos">
      <tr><th>Placa</th><td>${escapar(vehiculo?.placa)}</td></tr>
      <tr><th>Conductor</th><td>${escapar(conductor?.nombre)}</td></tr>
      <tr><th>Identificacion</th><td>${escapar(conductor?.cedula)}</td></tr>
      <tr><th>Manifiesto</th><td>${escapar(viaje.consecutivoManifiesto)}</td></tr>
      <tr><th>Radicado manifiesto</th><td>${escapar(viaje.numeroManifiestoRndc)}</td></tr>
    </table>
  </div>
</div>

<div class="firmas">
  <div>Entregado por (remitente)</div>
  <div>Recibido por (conductor)</div>
  <div>Recibido por (destinatario)</div>
</div>

<div class="pie">
  Impreso el ${fechaHora(new Date())}. La informacion oficial de esta remesa es la radicada en el
  Registro Nacional de Despachos de Carga del Ministerio de Transporte.
</div>

</body>
</html>`;
}
