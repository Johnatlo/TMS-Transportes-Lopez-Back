/**
 * Manifiesto de contingencia: lo imprime la empresa cuando la plataforma del
 * RNDC no deja expedir el manifiesto o no entrega su PDF, para que el carro no
 * se quede sin documento mientras tanto.
 *
 * Replica la organizacion del manifiesto oficial (docs/Manifiesto DE
 * ejemplo.pdf) con los mismos datos que se envian al RNDC (ver
 * construirDatosManifiesto), pero SIN el codigo QR ni los logos del
 * Ministerio, y con un aviso arriba y abajo de que es de contingencia. El
 * viaje queda con alerta hasta que se imprime el oficial.
 *
 * HTML listo para imprimir, como la remesa (remesa-impresion.ts).
 */

/** Una parte de la remesa (remitente o destinatario) como se imprime. */
export interface ParteContingencia {
  id: string;
  nombre: string;
  direccion: string | null;
  municipio: string | null;
}

/** Una remesa del manifiesto. */
export interface RemesaContingencia {
  consecutivo: string;
  radicado: string | null;
  unidad: string;
  cantidad: number | null;
  naturaleza: string;
  empaque: string;
  codMercancia: string | null;
  producto: string | null;
  remitente: ParteContingencia;
  destinatario: ParteContingencia;
}

/** Todo lo que lleva el manifiesto de contingencia. */
export interface DatosManifiestoContingencia {
  empresa: { nombre: string; nit: string; direccion: string; telefono: string; municipio: string };
  logoDataUri?: string | null;
  consecutivo: string;
  /** Radicado (autorizacion) del RNDC; null si aun no se pudo expedir. */
  radicado: string | null;
  /** Cuando se genero este documento. */
  generadoEn: Date;
  /** Por que se uso la contingencia (el error del RNDC). */
  motivo: string | null;
  fechaExpedicion: string;
  tipoManifiesto: string;
  origen: string;
  destino: string;
  via: string | null;
  titular: { nombre: string; id: string; direccion: string | null; municipio: string | null };
  vehiculo: { placa: string; marca: string | null; configuracion: string | null; pesoVacio: number | null; remolque: string | null; soatVence: string | null };
  conductor: { nombre: string; cedula: string; licencia: string | null; direccion: string | null; municipio: string | null };
  conductor2: { nombre: string; cedula: string } | null;
  remesas: RemesaContingencia[];
  valores: {
    total: number;
    retencionFuente: number;
    /** Factor ReteICA por mil (promedio ponderado de las remesas). */
    icaPorMil: number;
    retencionIca: number;
    retencionFopat: number;
    anticipo: number;
    lugarPago: string | null;
    fechaPago: string | null;
    cargue: string;
    descargue: string;
  };
  observaciones: string | null;
}

/** Texto seguro para el HTML (vacio para null/undefined). */
function escapar(valor: unknown): string {
  if (valor === null || valor === undefined || valor === "") return "";
  return String(valor).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 4,489,141.00, como en el manifiesto oficial. */
const pesos = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const UNIDADES = ["", "UNO", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE", "DIEZ", "ONCE", "DOCE", "TRECE", "CATORCE", "QUINCE", "DIECISEIS", "DIECISIETE", "DIECIOCHO", "DIECINUEVE", "VEINTE", "VEINTIUNO", "VEINTIDOS", "VEINTITRES", "VEINTICUATRO", "VEINTICINCO", "VEINTISEIS", "VEINTISIETE", "VEINTIOCHO", "VEINTINUEVE"];
const DECENAS = ["", "", "", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA"];
const CENTENAS = ["", "CIENTO", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS", "SEISCIENTOS", "SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS"];

/** Numero de 0 a 999 en letras ("QUINIENTOS TREINTA Y NUEVE"). */
function cientos(n: number): string {
  if (n === 100) return "CIEN";
  const c = Math.floor(n / 100);
  const r = n % 100;
  const resto = r < 30 ? UNIDADES[r] : `${DECENAS[Math.floor(r / 10)]}${r % 10 ? ` Y ${UNIDADES[r % 10]}` : ""}`;
  return [CENTENAS[c], resto].filter(Boolean).join(" ");
}

/**
 * Valor en letras como en el manifiesto oficial: "CUATRO MILLONES QUINIENTOS
 * TREINTA Y NUEVE MIL SETENTA Y UNO PESOS". Pesos enteros.
 */
export function enLetras(valor: number): string {
  const n = Math.round(Math.abs(valor));
  if (n === 0) return "CERO PESOS";
  const millones = Math.floor(n / 1_000_000);
  const miles = Math.floor((n % 1_000_000) / 1000);
  const resto = n % 1000;
  const partes: string[] = [];
  if (millones) partes.push(millones === 1 ? "UN MILLON" : `${cientos(millones).replace(/UNO$/, "UN")} MILLONES`);
  if (miles) partes.push(miles === 1 ? "MIL" : `${cientos(miles).replace(/UNO$/, "UN")} MIL`);
  if (resto) partes.push(cientos(resto));
  // "UN MILLON DE PESOS" cuando no hay miles ni unidades.
  const de = !miles && !resto && millones ? " DE" : "";
  return `${partes.join(" ")}${de} PESOS`;
}

/** HTML imprimible del manifiesto de contingencia. */
export function construirHtmlManifiestoContingencia(d: DatosManifiestoContingencia): string {
  const v = d.valores;
  const neto = v.total - v.retencionFuente - v.retencionIca - v.retencionFopat;
  const saldo = neto - v.anticipo;
  const generado = new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota",
    dateStyle: "short",
    timeStyle: "short",
  }).format(d.generadoEn);
  const parte = (p: ParteContingencia) =>
    `${escapar(p.id)} ${escapar(p.nombre)}<br>${escapar(p.direccion)}<br>${escapar(p.municipio)}`;
  const aviso = `MANIFIESTO DE CONTINGENCIA: generado por ${escapar(d.empresa.nombre)} el ${escapar(generado)} porque la plataforma del RNDC
    no esta disponible para ${d.radicado ? "imprimir" : "expedir"} el manifiesto electronico. No reemplaza al manifiesto oficial:
    se debe ${d.radicado ? "imprimir" : "expedir e imprimir"} el oficial apenas el RNDC responda.`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Manifiesto de contingencia ${escapar(d.consecutivo)}</title>
<style>
  @page { size: letter landscape; margin: 0.8cm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 9.5px; color: #111; margin: 0; }
  .hoja { max-width: 26cm; margin: 0 auto; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #333; padding: 2px 4px; vertical-align: top; text-align: left; }
  th { font-size: 8px; font-weight: bold; color: #333; }
  .grande { font-size: 11px; }
  .seccion { background: #e5e7eb; text-align: center; font-size: 11px; font-weight: bold; }
  .encabezado { display: grid; grid-template-columns: 1fr 2fr 1.3fr; gap: 8px; align-items: center; margin-bottom: 4px; }
  .encabezado img { max-height: 60px; max-width: 100%; }
  .centro { text-align: center; line-height: 1.35; }
  .centro .titulo { font-size: 13px; font-weight: bold; }
  .numeros { border: 2px solid #b91c1c; padding: 4px 6px; font-size: 11px; font-weight: bold; line-height: 1.6; }
  .contingencia { color: #b91c1c; font-weight: bold; text-align: center; font-size: 12px; letter-spacing: 1px; }
  .aviso { margin-top: 5px; border: 1px dashed #b91c1c; color: #7f1d1d; padding: 4px 6px; font-size: 9px; }
  .firmas td { height: 42px; vertical-align: bottom; text-align: center; font-size: 8.5px; }
  .num { text-align: right; }
  @media print { .no-imprimir { display: none; } }
  .no-imprimir { margin: 8px 0 10px; }
  .no-imprimir button { font-size: 12px; padding: 7px 14px; cursor: pointer; }
</style>
</head>
<body>
<div class="hoja">
<div class="no-imprimir"><button onclick="window.print()">Imprimir o guardar como PDF</button></div>

<div class="encabezado">
  <div>${d.logoDataUri ? `<img src="${d.logoDataUri}" alt="Logo de la empresa">` : ""}</div>
  <div class="centro">
    <div class="titulo">MANIFIESTO ELECTRONICO DE CARGA</div>
    <div class="contingencia">DE CONTINGENCIA</div>
    <div><strong>${escapar(d.empresa.nombre)}</strong> · Nit: ${escapar(d.empresa.nit)}</div>
    <div>${escapar(d.empresa.direccion)} · ${d.empresa.telefono ? `Tel: ${escapar(d.empresa.telefono)} · ` : ""}${escapar(d.empresa.municipio)}</div>
  </div>
  <div class="numeros">
    <div>Manifiesto : ${escapar(d.consecutivo)}</div>
    <div>Autorizacion: ${d.radicado ? escapar(d.radicado) : "PENDIENTE (sin radicar en el RNDC)"}</div>
  </div>
</div>

<table>
  <tr>
    <th>FECHA DE EXPEDICION<div class="grande">${escapar(d.fechaExpedicion)}</div></th>
    <th>TIPO DE MANIFIESTO<div class="grande">${escapar(d.tipoManifiesto)}</div></th>
    <th>ORIGEN DEL VIAJE<div class="grande">${escapar(d.origen)}</div></th>
    <th>DESTINO DEL VIAJE<div class="grande">${escapar(d.destino)}</div></th>
  </tr>
  <tr><th colspan="4">VIA A UTILIZAR: <span style="font-weight:normal">${escapar(d.via ?? "La estandar de SICETAC")}</span></th></tr>
</table>

<table style="margin-top:3px">
  <tr><td colspan="6" class="seccion">INFORMACION DEL TITULAR, VEHICULO Y CONDUCTORES</td></tr>
  <tr>
    <th>TITULAR MANIFIESTO<div class="grande">${escapar(d.titular.nombre)}</div></th>
    <th>DOCUMENTO IDENTIFICACION<div class="grande">${escapar(d.titular.id)}</div></th>
    <th colspan="2">DIRECCION<div class="grande">${escapar(d.titular.direccion)}</div></th>
    <th colspan="2">CIUDAD<div class="grande">${escapar(d.titular.municipio)}</div></th>
  </tr>
  <tr>
    <th>PLACA<div class="grande">${escapar(d.vehiculo.placa)}</div></th>
    <th>MARCA<div class="grande">${escapar(d.vehiculo.marca)}</div></th>
    <th>PLACA SEMIREMOLQUE<div class="grande">${escapar(d.vehiculo.remolque)}</div></th>
    <th>CONFIGURACION<div class="grande">${escapar(d.vehiculo.configuracion)}</div></th>
    <th>PESO VACIO<div class="grande">${escapar(d.vehiculo.pesoVacio)}</div></th>
    <th>F. VENCIMIENTO SOAT<div class="grande">${escapar(d.vehiculo.soatVence)}</div></th>
  </tr>
  <tr>
    <th>CONDUCTOR<div class="grande">${escapar(d.conductor.nombre)}</div></th>
    <th>DOCUMENTO IDENTIFICACION<div class="grande">${escapar(d.conductor.cedula)}</div></th>
    <th colspan="2">DIRECCION<div class="grande">${escapar(d.conductor.direccion)}</div></th>
    <th>No de LICENCIA<div class="grande">${escapar(d.conductor.licencia)}</div></th>
    <th>CIUDAD CONDUCTOR<div class="grande">${escapar(d.conductor.municipio)}</div></th>
  </tr>
  <tr>
    <th>CONDUCTOR Nro. 2<div class="grande">${escapar(d.conductor2?.nombre)}</div></th>
    <th colspan="5">DOCUMENTO IDENTIFICACION<div class="grande">${escapar(d.conductor2?.cedula)}</div></th>
  </tr>
</table>

<table style="margin-top:3px">
  <tr><td colspan="9" class="seccion">INFORMACION DE LA MERCANCIA TRANSPORTADA</td></tr>
  <tr>
    <th>Nro. Remesa</th><th>Unidad Medida</th><th>Cantidad</th><th>Naturaleza</th><th>Empaque</th>
    <th>Producto Transportado</th><th>Informacion Remitente / Lugar Cargue</th><th>Informacion Destinatario / Lugar Descargue</th><th>Autorizacion remesa</th>
  </tr>
  ${d.remesas
    .map(
      (r) => `<tr>
    <td>${escapar(r.consecutivo)}</td><td>${escapar(r.unidad)}</td><td class="num">${r.cantidad === null ? "" : pesos(r.cantidad)}</td>
    <td>${escapar(r.naturaleza)}</td><td>${escapar(r.empaque)} ${escapar(r.codMercancia)}</td><td>${escapar(r.producto)}</td>
    <td>${parte(r.remitente)}</td><td>${parte(r.destinatario)}</td><td>${escapar(r.radicado ?? "Pendiente")}</td>
  </tr>`
    )
    .join("")}
</table>

<table style="margin-top:3px">
  <tr><td colspan="2" class="seccion">VALORES</td><td colspan="2" class="seccion">PAGO DEL SALDO</td><td class="seccion">OBSERVACIONES</td></tr>
  <tr><td>VALOR TOTAL DEL VIAJE</td><td class="num">${pesos(v.total)}</td><th>LUGAR DE PAGO</th><td>${escapar(v.lugarPago)}</td><td rowspan="7">${escapar(d.observaciones)}</td></tr>
  <tr><td>RETENCION EN LA FUENTE</td><td class="num">${pesos(v.retencionFuente)}</td><th>FECHA</th><td>${escapar(v.fechaPago)}</td></tr>
  <tr><td>RETENCION ICA (${escapar(v.icaPorMil)} por mil)</td><td class="num">${pesos(v.retencionIca)}</td><th>CARGUE PAGADO POR</th><td>${escapar(v.cargue)}</td></tr>
  <tr><td>RETENCION FOPAT</td><td class="num">${pesos(v.retencionFopat)}</td><th>DESCARGUE PAGADO POR</th><td>${escapar(v.descargue)}</td></tr>
  <tr><td>VALOR NETO A PAGAR</td><td class="num">${pesos(neto)}</td><td colspan="2" rowspan="3"></td></tr>
  <tr><td>VALOR ANTICIPO</td><td class="num">${pesos(v.anticipo)}</td></tr>
  <tr><td>SALDO A PAGAR</td><td class="num">${pesos(saldo)}</td></tr>
  <tr><td>VALOR TOTAL DEL VIAJE EN LETRAS:</td><td colspan="4">${escapar(enLetras(v.total))}</td></tr>
</table>

<table class="firmas" style="margin-top:3px">
  <tr><td>Firma y Huella TITULAR MANIFIESTO</td><td>Firma y Huella del CONDUCTOR</td></tr>
</table>

<div class="aviso">${aviso}${d.motivo ? `<br>Motivo: ${escapar(d.motivo)}` : ""}</div>
</div>
</body>
</html>`;
}
