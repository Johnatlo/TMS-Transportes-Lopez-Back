/**
 * Rutas del despacho (/api/despacho): todo lo que se hace con el RNDC.
 *
 * - Despachar: valida, expide las remesas (proceso 3) y el manifiesto (4).
 * - Reintentar un viaje fallido y adoptar documentos que ya existian
 *   (DUPLICADO o expedidos en el portal).
 * - Anular: cumplido inicial (54), manifiesto (32) y remesas (9).
 * - Cumplir remesas (5) con los tiempos del GPS (45), anular su cumplido (28)
 *   y cumplir el manifiesto (6) con el piso SICETAC del cumplido.
 * - Consultas: historial, consecutivos, detalle, datos enviados, FOPAT.
 * - Documentos: PDF del manifiesto y remesa imprimible.
 * Requieren sesion.
 */
import { Router } from "express";
import {
  vehiculos,
  conductores,
  terceros,
  plantillas,
  viajes,
  viajeRemesas,
  remolques,
  Vehiculo,
  Conductor,
  PlantillaViajeConRelaciones,
  ViajeRemesa,
  Viaje,
  NuevaViajeRemesa,
  vias,
  empresasMonitoreo,
  consecutivos,
  parametros,
} from "../repo";
import { config } from "../config";
import {
  consecutivoRemesa,
  siguienteBase,
  validarBase,
  mayorConsecutivo,
  MAX_CARACTERES_CONSECUTIVO,
} from "../consecutivos";
import {
  construirXmlMensaje,
  construirDatosRemesa,
  construirDatosManifiesto,
  construirBloqueRemesasManifiesto,
  fopatEfectivo,
  municipioOrigenDe,
  municipioDestinoDe,
  validarReglasRndc,
  ultimoDescargueDe,
  calcularIcaPonderado,
  PROCESO_ID_REMESA,
  PROCESO_ID_MANIFIESTO,
  PROCESO_ID_ANULAR_CUMPLIDO_INICIAL,
  PROCESO_ID_ANULAR_MANIFIESTO,
  PROCESO_ID_ANULAR_REMESA,
  MOTIVOS_ANULACION_MANIFIESTO,
  MOTIVOS_ANULACION_CUMPLIDO,
  MOTIVOS_ANULACION_REMESA,
  MotivoAnulacionManifiesto,
  MotivoAnulacionCumplido,
  MotivoAnulacionRemesa,
  construirDatosAnularCumplidoInicial,
  construirDatosAnularManifiesto,
  construirDatosAnularRemesa,
  porcentajeTopeAnulaciones,
  PROCESO_ID_CUMPLIR_REMESA,
  PROCESO_ID_CUMPLIR_MANIFIESTO,
  construirDatosCumplidoRemesa,
  construirDatosCumplidoManifiesto,
  construirDatosAnularCumplidoRemesa,
  PROCESO_ID_ANULAR_CUMPLIDO_REMESA,
  valorFinalCumplido,
  TARIFA_RETENCION_FUENTE_DEFECTO,
  baseRetenciones,
  calcularRetencionFuente,
  calcularFopat,
  MOTIVOS_DESCUENTO_MANIFIESTO,
  MOTIVOS_VALOR_ADICIONAL,
  validarCumplidoRemesa,
  plazoCumplido,
  radicadoDeDuplicado,
  MAX_REMESAS_POR_MANIFIESTO,
  DatosViajeParaRndc,
  DatosRemesaParaRndc,
  ProblemaValidacion,
  TerceroRndc,
  TipoManifiesto,
  TipoOperacionRemesa,
  UnidadMedidaProducto,
} from "../rndc/builders";
import { conCandado } from "../db";
import { fechaHoraColombia } from "../fechas";
import {
  buscarManifiestoRadicado,
  buscarRemesaRadicada,
  leerTiemposCumplidoRemesa,
  leerCumplidoInicial,
  leerCumplidoManifiesto,
  leerAnulacionManifiesto,
  leerAnulacionRemesa,
  leerAnulacionCumplidoInicial,
} from "../rndc/consultas";
import { RndcClient, RndcError } from "../rndc/client";
import { estadoSincronizacion, sincronizarConRndc } from "../rndc/sincronizacion";
import { aCabeceraMunicipal, calcularPisoSicetac, horasPactadasTotales, pisoSicetacEnVivo } from "../rndc/sicetac";
import { descargarPdfManifiesto } from "../rndc/pdf";
import { estamparLogo, logoComoDataUri } from "../rndc/estampado";
import { construirHtmlRemesa } from "../rndc/remesa-impresion";

export const despachoRouter = Router();

/**
 * Vigencia de documentos. El RNDC compara contra la fecha mas alta de cita de
 * DESCARGUE de las remesas del manifiesto, no contra el dia de hoy
 * [MANIFIESTO V7 pag. 12-13]. Con multiparada eso significa la ultima parada.
 */
function validarDocumentos(
  vehiculo: Vehiculo,
  conductor: Conductor,
  conductor2: Conductor | null,
  ultimoDescargue: Date
): string[] {
  const problemas: string[] = [];
  const fecha = (d: Date) => d.toISOString().slice(0, 10);

  if (vehiculo.fechaVencSoat && vehiculo.fechaVencSoat < ultimoDescargue) {
    problemas.push(
      `El SOAT de ${vehiculo.placa} vence el ${fecha(vehiculo.fechaVencSoat)}, antes del ` +
        `ultimo descargue`
    );
  }
  if (vehiculo.fechaVencTecnomecanica && vehiculo.fechaVencTecnomecanica < ultimoDescargue) {
    problemas.push(
      `La tecnomecanica de ${vehiculo.placa} vence el ${fecha(
        vehiculo.fechaVencTecnomecanica
      )}, antes del ultimo descargue`
    );
  }
  for (const c of [conductor, conductor2]) {
    if (c?.fechaVencLicencia && c.fechaVencLicencia < ultimoDescargue) {
      problemas.push(
        `La licencia de ${c.nombre} vence el ${fecha(c.fechaVencLicencia)}, antes del ` +
          `ultimo descargue`
      );
    }
  }
  return problemas;
}

/**
 * Piso de SICETAC antes de enviar: el flete debe ser igual o mayor al costo
 * eficiente de la via, o el RNDC rechaza el manifiesto (MAN045).
 *
 * Se consulta SICETAC EN EL MOMENTO, con la misma configuracion, ruta, via y
 * horas pactadas del viaje: es el valor que va a exigir el RNDC. Antes se usaba
 * el ultimo valor guardado, que podia estar desactualizado o mal filtrado, y
 * dejaba pasar fletes que el RNDC rechazaba DESPUES de crear la remesa.
 *
 * Si SICETAC no responde, se usa el valor guardado y se avisa que no se pudo
 * verificar en vivo: es peor no poder despachar que despachar con la duda, y
 * el RNDC tiene la ultima palabra.
 */
async function validarPisoSicetac(datos: {
  codVia: string | null;
  origen: string | null;
  destino: string | null;
  configuracion: string | null;
  horasPactadas: number;
  valorFlete: number;
}): Promise<{ error: string | null; aviso: string | null }> {
  const { codVia, origen, destino, configuracion, horasPactadas, valorFlete } = datos;
  // Valor 0 = flota propia: el piso de SICETAC no aplica [Guia Cumplido 3.4].
  if (!origen || !destino || !configuracion || config.rndc.simular || valorFlete === 0) {
    return { error: null, aviso: null };
  }

  const debajoDelPiso = (piso: number, via: string) =>
    `El flete (${valorFlete}) esta por debajo del minimo de SICETAC (${piso}) para la via ${via}. ` +
    "El RNDC no permite expedir manifiestos por debajo de los costos eficientes de operacion " +
    `(MAN045). Sube el flete a ${piso} o mas, y el FOPAT al 0,1% del nuevo flete.`;

  try {
    const cliente = new RndcClient({
      wsdlUrl: config.rndc.consultasWsdlUrl,
      usuario: config.rndc.usuario,
      password: config.rndc.password,
      simular: false,
      reintentos: config.rndc.reintentos,
      soloConsultas: true,
    });
    const vivo = await pisoSicetacEnVivo(
      cliente,
      { usuario: config.rndc.usuario, password: config.rndc.password, nitEmpresa: config.rndc.empresaNit },
      {
        configuracion,
        origen,
        destino,
        codVia,
        horasPactadas,
        unidadTransporte: config.sicetac.unidadTransporte,
        tipoCarga: config.sicetac.tipoCarga,
      },
      config.sicetac.mesesHaciaAtras
    );
    if (!vivo) {
      return {
        error: null,
        aviso:
          `La via ${codVia ?? "estandar"} no aparece en SICETAC para ${origen} -> ${destino} con la ` +
          `configuracion ${configuracion}: no se pudo verificar el piso antes de enviar.`,
      };
    }
    const via = `${vivo.codVia ?? ""}${vivo.descripcion ? ` (${vivo.descripcion.slice(0, 60)})` : ""}`;
    return { error: valorFlete < vivo.piso ? debajoDelPiso(vivo.piso, via) : null, aviso: null };
  } catch (exc) {
    console.warn("SICETAC: no se pudo consultar el piso en vivo:", (exc as Error).message);
    const guardada = codVia ? (await vias.findByRuta(origen, destino)).find((v) => v.codVia === codVia) : null;
    const aviso =
      `No se pudo consultar SICETAC en vivo (${(exc as Error).message.slice(0, 120)}). ` +
      "Se uso el ultimo piso guardado, que puede estar desactualizado: si el RNDC responde MAN045, " +
      "sube el flete.";
    if (guardada?.valorSicetac && valorFlete < guardada.valorSicetac) {
      return { error: debajoDelPiso(Math.ceil(guardada.valorSicetac), codVia!), aviso };
    }
    return { error: null, aviso };
  }
}

/** Quita los campos vacios: el XML tampoco los lleva. */
function sinVacios(datos: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(datos).filter(([, v]) => v !== null && v !== undefined && v !== "")
  );
}

/**
 * Todos los datos del manifiesto y de cada remesa tal como van al RNDC (mismas
 * funciones que arman el XML), mas la via elegida con su piso de SICETAC. Si
 * algun bloque no se puede armar, se informa el motivo en vez de fallar.
 */
async function armarDatosRndc(
  viaje: Viaje,
  filas: ViajeRemesa[],
  datosViaje: DatosViajeParaRndc,
  datosRemesas: DatosRemesaParaRndc[],
  consecutivoManifiesto: string,
  rutaBase: { origen: string | null; destino: string | null }
) {
  let manifiesto: Record<string, unknown> | null = null;
  let errorManifiesto: string | null = null;
  try {
    manifiesto = sinVacios(construirDatosManifiesto(datosViaje, consecutivoManifiesto));
  } catch (exc) {
    errorManifiesto = (exc as Error).message;
  }

  const remesas = filas.map((f) => {
    const d = datosRemesas.find((x) => x.consecutivo === f.consecutivoRemesa);
    let datos: Record<string, unknown> | null = null;
    let error: string | null = null;
    try {
      datos = d ? sinVacios(construirDatosRemesa(d)) : null;
    } catch (exc) {
      error = (exc as Error).message;
    }
    return {
      consecutivo: f.consecutivoRemesa,
      estado: f.estado,
      radicado: f.numeroRemesaRndc,
      mensajeError: f.mensajeError,
      datos,
      error,
    };
  });

  // Via y piso: con la misma clave con que se consultaron a SICETAC.
  let via: { codVia: string; descripcion: string; pisoSicetac: number | null } | null = null;
  const origen = aCabeceraMunicipal(rutaBase.origen);
  const destino = aCabeceraMunicipal(rutaBase.destino);
  if (viaje.codVia && origen && destino) {
    const v = (await vias.findByRuta(origen, destino)).find((x) => x.codVia === viaje.codVia);
    if (v) via = { codVia: v.codVia, descripcion: v.descripcion, pisoSicetac: v.valorSicetac };
  }

  return {
    manifiesto,
    errorManifiesto,
    remesas,
    via,
    // Par origen-destino con el que se consultan las vias (para elegir otra).
    rutaVias: origen && destino ? { origen, destino } : null,
    valorFlete: datosViaje.valorFleteReal,
  };
}

/** Mensajes de los problemas de validacion de una gravedad (ERROR o AVISO). */
function mensajesDe(problemas: ProblemaValidacion[], gravedad: "ERROR" | "AVISO"): string[] {
  return problemas.filter((p) => p.gravedad === gravedad).map((p) => p.mensaje);
}

/**
 * Tercero de la plantilla -> los datos que necesita el RNDC (tipo y numero de
 * identificacion, sede, nombre, municipio y coordenadas).
 */
function aTerceroRndc(t: PlantillaViajeConRelaciones["contratante"]): TerceroRndc {
  return {
    codTipoId: t.codTipoId,
    nit: t.nit,
    codSede: t.codSede,
    nombre: t.nombre,
    codMunicipioRndc: t.codMunicipioRndc,
    latitud: t.latitud,
    longitud: t.longitud,
  };
}

/** Arma los datos de una remesa a partir de su plantilla y sus datos variables. */
function aDatosRemesa(
  fila: ViajeRemesa,
  plantilla: PlantillaViajeConRelaciones
): DatosRemesaParaRndc {
  return {
    consecutivo: fila.consecutivoRemesa!,
    contratante: aTerceroRndc(plantilla.contratante),
    remitente: aTerceroRndc(plantilla.remitente),
    destinatario: aTerceroRndc(plantilla.destinatario),
    tipoOperacionRemesa: plantilla.tipoOperacionRemesa as TipoOperacionRemesa,
    codTipoEmpaque: plantilla.codTipoEmpaque,
    empaquePrimario: plantilla.empaquePrimario,
    codMercancia: plantilla.codMercancia,
    subpartidaCode: plantilla.subpartidaCode,
    codigoArancelCode: plantilla.codigoArancelCode,
    // tipoMercancia es el texto libre que va como DESCRIPCIONCORTAPRODUCTO.
    descripcionCortaProducto: plantilla.tipoMercancia,
    unidadMedidaProducto: plantilla.unidadMedidaProducto as UnidadMedidaProducto,
    horasPactoCargue: plantilla.horasPactoCargue,
    minutosPactoCargue: plantilla.minutosPactoCargue,
    horasPactoDescargue: plantilla.horasPactoDescargue,
    minutosPactoDescargue: plantilla.minutosPactoDescargue,
    pesoReal: fila.pesoReal,
    cantidadReal: fila.cantidadReal,
    fechaHoraCargue: new Date(fila.fechaHoraCargue),
    fechaHoraDescargue: new Date(fila.fechaHoraDescargue),
    ordenServicioGenerador: fila.ordenServicioGenerador,
    factorIcaCargue: plantilla.factorIcaCargue,
    valorFleteRemesa: fila.valorFleteRemesa,
  };
}

/**
 * El "boton unico" del despacho.
 *
 * Recibe el vehiculo, el conductor y una lista de remesas (una por cada cliente
 * o parada), crea las remesas en el RNDC y luego el manifiesto que las agrupa.
 */
despachoRouter.post("/", async (req, res) => {
  const b = req.body;

  // El remolque es opcional: los vehiculos rigidos (camion de 2 o 3 ejes,
  // volquetas) no llevan. La pantalla lo exige para tractocamiones (config con
  // "S", semirremolque); si aun asi falta, responde el RNDC.

  // Compatibilidad: si llega el formato viejo de una sola remesa, se convierte.
  const remesasEntrada: any[] = Array.isArray(b.remesas) && b.remesas.length > 0
    ? b.remesas
    : [
        {
          plantillaId: b.plantillaId,
          pesoReal: b.pesoReal,
          cantidadReal: b.cantidadReal,
          fechaHoraCargue: b.fechaHoraCargue,
          fechaHoraDescargue: b.fechaHoraDescargue,
          ordenServicioGenerador: b.ordenServicioGenerador,
        },
      ];

  if (remesasEntrada.length > MAX_REMESAS_POR_MANIFIESTO) {
    return res.status(422).json({
      error: `Un manifiesto admite hasta ${MAX_REMESAS_POR_MANIFIESTO} remesas`,
    });
  }
  for (const [i, r] of remesasEntrada.entries()) {
    if (!r.plantillaId) {
      return res.status(422).json({ error: `La remesa ${i + 1} no tiene plantilla` });
    }
    if (!r.fechaHoraCargue || !r.fechaHoraDescargue) {
      return res.status(422).json({
        error: `La remesa ${i + 1} necesita cita de cargue y cita de descargue`,
      });
    }
  }

  // La plantilla principal es la de la primera remesa: de ella salen la ruta y
  // los terminos del manifiesto, que son del viaje completo y no de cada carga.
  const plantillaPrincipalId = Number(b.plantillaId ?? remesasEntrada[0].plantillaId);

  const [plantillaPrincipal, vehiculo, conductor, conductor2, remolque] = await Promise.all([
    plantillas.findById(plantillaPrincipalId),
    vehiculos.findById(Number(b.vehiculoId)),
    conductores.findById(Number(b.conductorId)),
    b.conductor2Id ? conductores.findById(Number(b.conductor2Id)) : Promise.resolve(null),
    b.remolqueId ? remolques.findById(Number(b.remolqueId)) : Promise.resolve(null),
  ]);

  if (!plantillaPrincipal || !vehiculo || !conductor || (b.remolqueId && !remolque)) {
    return res
      .status(404)
      .json({ error: "Plantilla, vehiculo, conductor o remolque no encontrado" });
  }

  // Plantillas de cada remesa (pueden ser distintas: varios clientes).
  const plantillasRemesa = new Map<number, PlantillaViajeConRelaciones>();
  for (const r of remesasEntrada) {
    const id = Number(r.plantillaId);
    if (!plantillasRemesa.has(id)) {
      const p = await plantillas.findById(id);
      if (!p) {
        return res.status(404).json({ error: `No encontre la plantilla ${id}` });
      }
      plantillasRemesa.set(id, p);
    }
  }

  const nuevasRemesas: NuevaViajeRemesa[] = remesasEntrada.map((r, i) => ({
    plantillaId: Number(r.plantillaId),
    orden: i + 1,
    pesoReal: r.pesoReal ? Number(r.pesoReal) : null,
    cantidadReal: r.cantidadReal ? Number(r.cantidadReal) : null,
    fechaHoraCargue: fechaHoraColombia(r.fechaHoraCargue),
    fechaHoraDescargue: fechaHoraColombia(r.fechaHoraDescargue),
    ordenServicioGenerador: r.ordenServicioGenerador ?? null,
    valorFleteRemesa: r.valorFleteRemesa ? Number(r.valorFleteRemesa) : null,
  }));

  // ---- Numeracion del viaje ----
  // Un solo numero base identifica todo: el manifiesto lo usa tal cual y las
  // remesas adicionales le agregan letra. Se puede editar en el despacho,
  // porque cuando se anula un documento hay que saltar o retomar numeros.
  //
  // Elegir el numero y guardar el viaje va bajo candado: si dos personas
  // despachan al mismo tiempo, la segunda espera y ya ve el numero de la
  // primera como usado. El envio al RNDC queda FUERA del candado para no
  // hacer esperar a nadie mientras el ministerio responde.
  const numerado = await conCandado("tms_numeracion_despacho", async () => {
    const usados = await viajes.consecutivosUsados();
    const base = b.consecutivoBase
      ? String(b.consecutivoBase).trim()
      : siguienteBase(
          mayorConsecutivo(await viajes.ultimoConsecutivo(), config.consecutivos.ultimoExterno),
          config.consecutivos.longitud,
          config.consecutivos.prefijo
        );

    const problemasNumero = validarBase(base, nuevasRemesas.length, usados);
    if (problemasNumero.length > 0) {
      return { error: problemasNumero.map((p) => p.mensaje).join(" ") };
    }

    const primerCargue = nuevasRemesas.reduce(
      (min, r) => (r.fechaHoraCargue < min ? r.fechaHoraCargue : min),
      nuevasRemesas[0].fechaHoraCargue
    );

    const viaje = await viajes.create({
      consecutivoManifiesto: base,
      plantillaId: plantillaPrincipal.id,
      vehiculoId: vehiculo.id,
      conductorId: conductor.id,
      // En viajes se guarda la fecha de expedicion del manifiesto: el cargue mas
      // temprano de todas las remesas.
      fechaHoraCargue: primerCargue,
      fechaHoraDescargue: nuevasRemesas.reduce(
        (max, r) => (r.fechaHoraDescargue > max ? r.fechaHoraDescargue : max),
        nuevasRemesas[0].fechaHoraDescargue
      ),
      pesoReal: null,
      cantidadReal: null,
      // 0 es un valor real (flota propia); solo vacio es "sin flete".
      valorFleteReal:
        b.valorFleteReal === undefined || b.valorFleteReal === null || b.valorFleteReal === ""
          ? null
          : Number(b.valorFleteReal),
      valorAnticipoManifiesto: b.valorAnticipoManifiesto ? Number(b.valorAnticipoManifiesto) : 0,
      // El despachador ve el FOPAT en pantalla y lo puede ajustar. Si no llega,
      // se calcula al armar el manifiesto.
      retencionFopat:
        b.retencionFopat !== undefined && b.retencionFopat !== null && b.retencionFopat !== ""
          ? Number(b.retencionFopat)
          : null,
      codVia: b.codVia || null,
      // EMF del viaje, en cascada: la elegida en pantalla, si no la del
      // vehiculo, si no la configurada para toda la empresa.
      nitMonitoreoFlota:
        (b.nitMonitoreoFlota ? String(b.nitMonitoreoFlota).replace(/\D/g, "") : null) ||
        vehiculo.nitMonitoreoFlota ||
        config.rndc.nitMonitoreoFlota ||
        null,
      fechaPagoSaldo: b.fechaPagoSaldo ? new Date(b.fechaPagoSaldo) : null,
      conductor2Id: conductor2 ? conductor2.id : null,
      remolqueId: remolque?.id ?? null,
      viajesDia: b.viajesDia ? Number(b.viajesDia) : null,
      ordenServicioGenerador: null,
      vacio1Origen: b.vacio1Origen ?? null,
      vacio1Destino: b.vacio1Destino ?? null,
      vacio1Valor: b.vacio1Valor ? Number(b.vacio1Valor) : 0,
      vacio2Origen: b.vacio2Origen ?? null,
      vacio2Destino: b.vacio2Destino ?? null,
      vacio2Valor: b.vacio2Valor ? Number(b.vacio2Valor) : 0,
      creadoPorId: req.usuario?.id ?? null,
    });

    await viajeRemesas.crearParaViaje(
      viaje.id,
      // Cada remesa recibe su consecutivo derivado del mismo numero base.
      nuevasRemesas.map((r, i) => ({ ...r, consecutivoRemesa: consecutivoRemesa(base, i + 1) }))
    );
    return { viaje };
  });
  if ("error" in numerado) {
    return res.status(422).json({ error: numerado.error });
  }
  const { viaje } = numerado;

  const resultado = await procesarViaje(viaje.id);
  res.status(resultado.status).json(resultado.cuerpo);
});

/**
 * Mensaje de error cuando el viaje quedo a medias: unas remesas creadas en el
 * RNDC y otras no. Decirlo explicitamente evita que alguien reintente el viaje
 * completo y duplique las que ya pasaron.
 */
function resumenParcial(creadas: string[], fallida: string, detalle: string): string {
  const previas =
    creadas.length > 0
      ? `Las remesas ${creadas.join(", ")} YA quedaron creadas en el RNDC y no se deben volver a enviar. `
      : "";
  return `${previas}Fallo la remesa ${fallida}: ${detalle}`;
}

/**
 * Estados desde los que un viaje se puede retomar: no se envio nada
 * (VALIDACION_ERROR) o se envio solo una parte (REMESA_ERROR, MANIFIESTO_ERROR).
 */
const ESTADOS_REINTENTABLES = ["VALIDACION_ERROR", "REMESA_ERROR", "MANIFIESTO_ERROR"];

/**
 * Valida y envia al RNDC lo que le falte a un viaje ya guardado.
 *
 * La usan el despacho y el reintento. Lee todo de la base (viaje, remesas,
 * plantillas, vehiculo, conductor...), asi que lo corregido en el catalogo
 * antes de reintentar se toma en cuenta.
 *
 * Las remesas que ya estan CREADA en el RNDC no se reenvian: se reutilizan en
 * el manifiesto. Reenviarlas duplicaria el documento, y el manifiesto acepta
 * remesas activas (ni cumplidas ni anuladas) [MANIFIESTO V7, validaciones de
 * REMESASMAN].
 */
async function procesarViaje(
  viajeId: number,
  opciones: { soloDatos?: boolean } = {}
): Promise<{ status: number; cuerpo: unknown }> {
  const viaje = (await viajes.findById(viajeId))!;
  const filasRemesa = await viajeRemesas.findByViaje(viajeId);
  // Un viaje expedido en el portal del RNDC no tiene plantilla: no se arma ni
  // se reenvia desde aqui (ya existe alla).
  if (viaje.origen === "PORTAL") {
    return { status: 409, cuerpo: { error: "Este viaje se expidio en el portal del RNDC: no se reenvia desde el TMS." } };
  }

  const [plantillaPrincipal, vehiculo, conductor, conductor2, remolque] = await Promise.all([
    plantillas.findById(viaje.plantillaId),
    vehiculos.findById(viaje.vehiculoId),
    conductores.findById(viaje.conductorId),
    viaje.conductor2Id ? conductores.findById(viaje.conductor2Id) : Promise.resolve(null),
    viaje.remolqueId ? remolques.findById(viaje.remolqueId) : Promise.resolve(null),
  ]);
  if (!plantillaPrincipal || !vehiculo || !conductor || (viaje.remolqueId && !remolque)) {
    if (opciones.soloDatos) {
      return { status: 404, cuerpo: { error: "Plantilla, vehiculo, conductor o remolque del viaje ya no existe." } };
    }
    const actualizado = await viajes.update(viajeId, {
      estado: "VALIDACION_ERROR",
      mensajeError: "Plantilla, vehiculo, conductor o remolque del viaje ya no existe.",
    });
    return { status: 404, cuerpo: { ...actualizado, remesas: filasRemesa } };
  }

  const plantillasRemesa = new Map<number, PlantillaViajeConRelaciones>();
  for (const fila of filasRemesa) {
    if (!plantillasRemesa.has(fila.plantillaId!)) {
      const p = await plantillas.findById(fila.plantillaId);
      if (!p) {
        if (opciones.soloDatos) {
          return { status: 404, cuerpo: { error: `No encontre la plantilla ${fila.plantillaId}.` } };
        }
        const actualizado = await viajes.update(viajeId, {
          estado: "VALIDACION_ERROR",
          mensajeError: `No encontre la plantilla ${fila.plantillaId} de la remesa ${fila.consecutivoRemesa}.`,
        });
        return { status: 404, cuerpo: { ...actualizado, remesas: filasRemesa } };
      }
      plantillasRemesa.set(fila.plantillaId!, p);
    }
  }

  const consecutivoManifiesto = viaje.consecutivoManifiesto!;
  // En viajes se guarda como fecha de cargue la mas temprana de las remesas.
  const primerCargue = new Date(viaje.fechaHoraCargue);

  const datosRemesas: DatosRemesaParaRndc[] = filasRemesa.map((fila) =>
    aDatosRemesa(fila, plantillasRemesa.get(fila.plantillaId!)!)
  );

  // Los trayectos en vacio se arman antes porque determinan el origen y el
  // destino del manifiesto cuando existen.
  const vacio1 = viaje.vacio1Origen
    ? {
        origen: viaje.vacio1Origen,
        destino: viaje.vacio1Destino ?? "",
        valor: viaje.vacio1Valor,
      }
    : null;
  const vacio2 = viaje.vacio2Origen
    ? {
        origen: viaje.vacio2Origen,
        destino: viaje.vacio2Destino ?? "",
        valor: viaje.vacio2Valor,
      }
    : null;

  // Ruta del viaje segun las plantillas, antes de ajustar por vacios. Es el
  // mismo par con el que el despacho consulto las vias a SICETAC.
  const plantillaUltima = plantillasRemesa.get(filasRemesa[filasRemesa.length - 1].plantillaId!)!;
  const rutaBase = {
    origen: plantillaPrincipal.municipioOrigen,
    destino: plantillaUltima.municipioDestino,
  };

  const datosViaje: DatosViajeParaRndc = {
    vehiculo: {
      placa: vehiculo.placa,
      // El titular del manifiesto es el tenedor/propietario registrado del
      // vehiculo, no el contratante de la carga [MANIFIESTO V7 pag. 11].
      tenedorCodTipoId: vehiculo.codTipoIdTenedor,
      tenedorNumId: vehiculo.numIdTenedor,
      aplicaFopat: vehiculo.aplicaFopat,
      capacidadKg: vehiculo.capacidadKg,
      pesoVehiculoVacio: vehiculo.pesoVehiculoVacio,
    },
    // Sin remolque (vehiculo rigido): NUMPLACAREMOLQUE no se envia.
    remolque: { placa: remolque?.placa ?? null, capacidadKg: remolque?.capacidadKg ?? null },
    conductor: { codTipoId: conductor.codTipoId, cedula: conductor.cedula },
    conductor2: conductor2
      ? { codTipoId: conductor2.codTipoId, cedula: conductor2.cedula }
      : null,
    manifiesto: {
      // La ruta base es la explicita de las plantillas: origen de la primera
      // carga y destino de la ultima (en multiparada el viaje termina donde
      // descarga el ultimo cliente). Encima se aplica el ajuste por trayectos
      // en vacio. validarReglasRndc verifica que calce con las remesas.
      ruta: {
        codigoOrigenRndc: municipioOrigenDe(rutaBase.origen, vacio1),
        codigoDestinoRndc: municipioDestinoDe(rutaBase.destino, vacio2),
        // La via elegida en el despacho. Si va vacia, el RNDC asigna la
        // estandar de SICETAC para ese par origen-destino.
        codVia: viaje.codVia,
      },
      tipoManifiesto: plantillaPrincipal.tipoManifiesto as TipoManifiesto,
      codMunicipioIntermedio: plantillaPrincipal.codMunicipioIntermedio,
      tarifaRetencionFuente: plantillaPrincipal.tarifaRetencionFuente,
      titularEsRegimenSimple: plantillaPrincipal.titularEsRegimenSimple,
      codResponsablePagoCargue: plantillaPrincipal.codResponsablePagoCargue,
      codResponsablePagoDescargue: plantillaPrincipal.codResponsablePagoDescargue,
      aceptacionElectronica: plantillaPrincipal.aceptacionElectronica,
      codMunicipioPagoSaldo: plantillaPrincipal.codMunicipioPagoSaldo,
      observaciones: plantillaPrincipal.observaciones,
    },
    remesas: datosRemesas,
    valorFleteReal: viaje.valorFleteReal,
    valorAnticipoManifiesto: viaje.valorAnticipoManifiesto,
    fechaPagoSaldo: viaje.fechaPagoSaldo,
    nitMonitoreoFlota: viaje.nitMonitoreoFlota,
    vacio1,
    vacio2,
    viajesDia: viaje.viajesDia,
    retencionFopat: viaje.retencionFopat,
    nitEmpresaTransporte: config.rndc.empresaNit,
    manifiestosMismaPlacaFecha: await viajes.contarPorVehiculoYFecha(
      vehiculo.id,
      primerCargue,
      viajeId
    ),
  };

  // Lo que se envia (o se enviaria) al RNDC, campo por campo. Va en cada
  // respuesta de error: el rechazo puede venir de cualquier dato (la via, el
  // piso de SICETAC, el FOPAT, el titular...), asi que se muestran todos.
  const datosRndc = await armarDatosRndc(
    viaje,
    filasRemesa,
    datosViaje,
    datosRemesas,
    consecutivoManifiesto,
    rutaBase
  );
  if (opciones.soloDatos) return { status: 200, cuerpo: datosRndc };

  // Remesas que ya existen en el RNDC (de un intento anterior).
  const yaCreadas = filasRemesa.filter((f) => f.estado === "CREADA").map((f) => f.consecutivoRemesa!);
  const avisoYaCreadas =
    yaCreadas.length > 0
      ? `Las remesas ${yaCreadas.join(", ")} YA estan creadas en el RNDC y no se reenvian. `
      : "";

  // 1. Validaciones locales. Cada rechazo del RNDC cuesta tiempo en el despacho
  //    nocturno, y algunos consumen cupos de la empresa.
  const reglas = validarReglasRndc(datosViaje, consecutivoManifiesto);
  // SOAT, tecnomecanica y licencia que vencen antes del ultimo descargue: solo
  // AVISO. La renovacion tarda dias en reflejarse y el manifiesto se expide
  // cuando el carro sale; si el RNDC no lo acepta, lo dira el.
  const avisosDocumentos = validarDocumentos(
    vehiculo,
    conductor,
    conductor2,
    ultimoDescargueDe(datosRemesas)
  );
  // El NIT debe estar en la lista de EMF registradas en el RNDC. Nuestro
  // catalogo es una copia de esa lista: si no esta aqui, lo mas probable es que
  // tampoco este alla. Se avisa pero no se bloquea, porque el catalogo local
  // puede estar incompleto y el RNDC es quien tiene la verdad.
  const avisosMonitoreo: string[] = [];
  if (viaje.nitMonitoreoFlota) {
    const emf = await empresasMonitoreo.findByNit(viaje.nitMonitoreoFlota);
    if (!emf) {
      avisosMonitoreo.push(
        `La empresa de monitoreo ${viaje.nitMonitoreoFlota} no esta en el catalogo. Verifica ` +
          `que sea una EMF registrada en el RNDC o el manifiesto sera rechazado.`
      );
    }
  }

  // El piso se busca con la ruta de la plantilla (sin ajuste por vacios) y en
  // cabecera municipal: es exactamente como quedaron guardadas las vias al
  // consultarlas a SICETAC. Con otra clave no se encontraria la via elegida.
  const piso = await validarPisoSicetac({
    codVia: viaje.codVia,
    origen: aCabeceraMunicipal(rutaBase.origen),
    destino: aCabeceraMunicipal(rutaBase.destino),
    configuracion: vehiculo.configuracion,
    // Las mismas horas con que Despachar consulta las vias: las de la plantilla principal.
    horasPactadas: horasPactadasTotales([
      { horas: plantillaPrincipal.horasPactoCargue, minutos: plantillaPrincipal.minutosPactoCargue },
      { horas: plantillaPrincipal.horasPactoDescargue, minutos: plantillaPrincipal.minutosPactoDescargue },
    ]),
    valorFlete: datosViaje.valorFleteReal ?? 0,
  });

  // El RNDC decide. Las reglas propias son la lectura de los manuales, no la
  // validacion real del RNDC, y a veces bloqueaban lo que el portal si acepta
  // (piso de SICETAC, capacidad del catalogo...). Ahora solo detienen el envio
  // las que impiden armar los documentos; el resto se muestran como aviso y el
  // RNDC responde con su propio error si de verdad algo esta mal.
  const ESTRUCTURALES = [/no tiene remesas/, /consecutivo/i, /repetidos/];
  const reglasError = mensajesDe(reglas, "ERROR");
  const errores = reglasError.filter((m) => ESTRUCTURALES.some((r) => r.test(m)));
  const avisos = [
    ...reglasError.filter((m) => !ESTRUCTURALES.some((r) => r.test(m))),
    ...(piso.error ? [piso.error] : []),
    ...mensajesDe(reglas, "AVISO"),
    ...avisosDocumentos,
    ...avisosMonitoreo,
    ...(piso.aviso ? [piso.aviso] : []),
  ];

  // Se reemplazan en cada intento: los de un intento anterior pueden ya no aplicar.
  await viajes.update(viajeId, { avisos: avisos.length > 0 ? avisos.join(" | ") : null });

  if (errores.length > 0) {
    const actualizado = await viajes.update(viajeId, {
      estado: "VALIDACION_ERROR",
      mensajeError: avisoYaCreadas + errores.join(" | "),
      codigoError: null,
      errorCrudo: null,
    });
    return { status: 422, cuerpo: { ...actualizado, remesas: filasRemesa, datosRndc } };
  }

  const credenciales = {
    usuario: config.rndc.usuario,
    password: config.rndc.password,
    nitEmpresa: config.rndc.empresaNit,
  };
  const cliente = new RndcClient({
    wsdlUrl: config.rndc.wsdlUrl,
    usuario: config.rndc.usuario,
    password: config.rndc.password,
    simular: config.rndc.simular,
    reintentos: config.rndc.reintentos,
  });

  // 2. PASO 1 DE 2: crear cada remesa (procesoid = 3).
  //
  // Se crean una por una. Si falla la tercera, las dos primeras YA quedaron en
  // el RNDC: por eso cada fila guarda su propio estado, y en un reintento las
  // CREADA se saltan y se reutilizan.
  const creadas: string[] = [];

  for (const fila of filasRemesa) {
    if (fila.estado === "CREADA") {
      creadas.push(fila.consecutivoRemesa!);
      continue;
    }

    const datos = datosRemesas.find((d) => d.consecutivo === fila.consecutivoRemesa)!;
    const xmlRemesa = construirXmlMensaje(
      credenciales,
      PROCESO_ID_REMESA,
      construirDatosRemesa(datos)
    );

    let resultado;
    try {
      resultado = await cliente.enviar(xmlRemesa, PROCESO_ID_REMESA);
    } catch (exc) {
      await viajeRemesas.update(fila.id, {
        estado: "ERROR",
        mensajeError: (exc as RndcError).message,
      });
      const actualizado = await viajes.update(viajeId, {
        estado: "REMESA_ERROR",
        mensajeError: resumenParcial(creadas, fila.consecutivoRemesa!, (exc as RndcError).message),
        codigoError: null,
        errorCrudo: null,
      });
      return { status: 502, cuerpo: { ...actualizado, remesas: await viajeRemesas.findByViaje(viajeId), datosRndc } };
    }

    if (!resultado.ok) {
      await viajeRemesas.update(fila.id, {
        estado: "ERROR",
        mensajeError: resultado.errorCrudo,
      });
      const actualizado = await viajes.update(viajeId, {
        estado: "REMESA_ERROR",
        mensajeError: resumenParcial(creadas, fila.consecutivoRemesa!, resultado.error ?? ""),
        codigoError: resultado.codigoError,
        errorCrudo: resultado.errorCrudo,
      });
      return { status: 422, cuerpo: { ...actualizado, remesas: await viajeRemesas.findByViaje(viajeId), datosRndc } };
    }

    await viajeRemesas.update(fila.id, {
      estado: "CREADA",
      numeroRemesaRndc: resultado.radicado,
      mensajeError: null,
    });
    creadas.push(fila.consecutivoRemesa!);
  }

  // 3. PASO 2 DE 2: crear el manifiesto (procesoid = 4), enlazando todas las
  //    remesas dentro del bloque <REMESASMAN>.
  const xmlManifiesto = construirXmlMensaje(
    credenciales,
    PROCESO_ID_MANIFIESTO,
    construirDatosManifiesto(datosViaje, consecutivoManifiesto),
    "1",
    construirBloqueRemesasManifiesto(creadas)
  );

  let resultadoManifiesto;
  try {
    resultadoManifiesto = await cliente.enviar(xmlManifiesto, PROCESO_ID_MANIFIESTO);
  } catch (exc) {
    const actualizado = await viajes.update(viajeId, {
      estado: "MANIFIESTO_ERROR",
      mensajeError:
        `Las remesas ${creadas.join(", ")} quedaron creadas en el RNDC, pero fallo el ` +
        `manifiesto: ${(exc as RndcError).message}`,
      codigoError: null,
      errorCrudo: null,
    });
    return { status: 502, cuerpo: { ...actualizado, remesas: await viajeRemesas.findByViaje(viajeId), datosRndc } };
  }

  if (!resultadoManifiesto.ok) {
    // Las remesas YA quedaron creadas en el RNDC. Se corrige lo que haga falta
    // y se reintenta solo el manifiesto (POST /:id/reintentar).
    const actualizado = await viajes.update(viajeId, {
      estado: "MANIFIESTO_ERROR",
      mensajeError:
        `Las remesas ${creadas.join(", ")} quedaron creadas en el RNDC, pero el manifiesto ` +
        `fue rechazado. ${resultadoManifiesto.error}`,
      codigoError: resultadoManifiesto.codigoError,
      errorCrudo: resultadoManifiesto.errorCrudo,
    });
    return { status: 422, cuerpo: { ...actualizado, remesas: await viajeRemesas.findByViaje(viajeId), datosRndc } };
  }

  // Se persiste el FOPAT realmente enviado, incluso cuando se calculo solo:
  // es el numero que hay que declarar a la DIAN el mes siguiente.
  const fopatEnviado = fopatEfectivo(datosViaje, datosViaje.valorFleteReal ?? 0);

  const final = await viajes.update(viajeId, {
    estado: "CONFIRMADO",
    retencionFopat: fopatEnviado,
    numeroManifiestoRndc: resultadoManifiesto.radicado,
    mec: resultadoManifiesto.mec,
    codigoSeguridadQr: resultadoManifiesto.qr,
    // Limpia el error de un intento anterior.
    mensajeError: null,
    codigoError: null,
    errorCrudo: null,
  });

  return {
    status: 201,
    cuerpo: {
      ...final,
      remesas: await viajeRemesas.findByViaje(viajeId),
      // Se devuelve el desglose del ICA para que el despachador pueda auditarlo
      // cuando el manifiesto agrupa municipios con factores distintos.
      ica: calcularIcaPonderado(datosRemesas),
    },
  };
}

/**
 * "Ya existe" en el RNDC: la remesa o el manifiesto quedaron creados en un
 * intento anterior aunque aqui figure el error (por ejemplo, se perdio la
 * respuesta). El RNDC lo dice con "DUPLICADO:<radicado>".
 *
 * No se adopta solo: el numero repetido tambien puede ser de OTRO documento
 * (asi paso con la remesa 00006728, expedida desde el portal). La persona
 * confirma que es el mismo y entonces se toma ese radicado. Solo se acepta el
 * radicado que el propio RNDC informo en el error.
 */
despachoRouter.post("/remesas/:remesaId/usar-existente", async (req, res) => {
  const remesa = await viajeRemesas.findById(Number(req.params.remesaId));
  if (!remesa) return res.status(404).json({ error: "Remesa no encontrada" });
  const viaje = await viajes.findById(remesa.viajeId);
  if (!viaje) return res.status(404).json({ error: "Viaje no encontrado" });
  const radicado = radicadoDeDuplicado(remesa.mensajeError);
  if (remesa.estado === "CREADA" || !radicado || !ESTADOS_REINTENTABLES.includes(viaje.estado)) {
    return res.status(409).json({
      error: "El RNDC no reporto esta remesa como existente: no hay radicado que tomar.",
    });
  }
  await viajeRemesas.update(remesa.id, { estado: "CREADA", numeroRemesaRndc: radicado, mensajeError: null });
  const actualizado = await viajes.update(viaje.id, {
    mensajeError:
      `La remesa ${remesa.consecutivoRemesa} se tomo del RNDC (ya existia, radicado ${radicado}). ` +
      "Reintenta para enviar lo que falta.",
    codigoError: null,
    errorCrudo: null,
  });
  res.json({ ...actualizado, remesas: await viajeRemesas.findByViaje(viaje.id) });
});

/**
 * POST /api/despacho/:id/usar-manifiesto-existente: adopta un manifiesto que
 * el RNDC reporto como existente ("DUPLICADO:<radicado>").
 *
 * Solo para viajes en MANIFIESTO_ERROR con ese radicado en el error: el viaje
 * queda CONFIRMADO con el radicado y un aviso de que se tomo del RNDC.
 */
despachoRouter.post("/:id/usar-manifiesto-existente", async (req, res) => {
  const viaje = await viajes.findById(Number(req.params.id));
  if (!viaje) return res.status(404).json({ error: "Viaje no encontrado" });
  const radicado = radicadoDeDuplicado(viaje.errorCrudo);
  if (viaje.estado !== "MANIFIESTO_ERROR" || !radicado) {
    return res.status(409).json({
      error: "El RNDC no reporto este manifiesto como existente: no hay radicado que tomar.",
    });
  }
  const final = await viajes.update(viaje.id, {
    estado: "CONFIRMADO",
    numeroManifiestoRndc: radicado,
    mensajeError: null,
    codigoError: null,
    errorCrudo: null,
    avisos: `Manifiesto tomado del RNDC: ya existia con radicado ${radicado}.`,
  });
  res.json({ ...final, remesas: await viajeRemesas.findByViaje(viaje.id) });
});

/**
 * Antes de reintentar: el manifiesto con este numero ya existe en el RNDC?
 *
 * Pasa cuando el viaje se expide por fuera del sistema (por ejemplo en el
 * portal, porque el carro tenia que salir) o cuando se perdio la respuesta de
 * un envio. Si existe y es de la misma placa, el viaje queda CONFIRMADO con el
 * radicado y los valores que tiene el RNDC (flete, FOPAT, anticipo, via), y se
 * buscan los radicados de las remesas pendientes. Si es de otra placa, el
 * numero lo uso otro despacho: no se toma nada.
 *
 * Devuelve null para seguir con el reintento normal: si no existe, si se esta
 * simulando, o si la consulta falla (el reintento no se bloquea por eso).
 */
export async function tomarSiYaExpedido(
  viaje: Viaje,
  /** Numero a buscar: el que se escribio en el reintento, o el del viaje. */
  numeroPedido?: string | null
): Promise<{ status: number; cuerpo: unknown } | null> {
  const numero = (numeroPedido || viaje.consecutivoManifiesto || "").trim().toUpperCase();
  if (config.rndc.simular || viaje.numeroManifiestoRndc || !numero) return null;
  const credenciales = {
    usuario: config.rndc.usuario,
    password: config.rndc.password,
    nitEmpresa: config.rndc.empresaNit,
  };
  // Mismo servidor que expide; soloConsultas: este cliente no puede registrar nada.
  const cliente = new RndcClient({
    wsdlUrl: config.rndc.wsdlUrl,
    usuario: config.rndc.usuario,
    password: config.rndc.password,
    simular: false,
    reintentos: config.rndc.reintentos,
    soloConsultas: true,
  });

  let m;
  try {
    m = await buscarManifiestoRadicado(cliente, credenciales, numero);
  } catch (exc) {
    console.warn(`No se pudo verificar en el RNDC el manifiesto ${numero}:`, (exc as Error).message);
    return null;
  }
  if (!m) return null;

  const vehiculo = await vehiculos.findById(viaje.vehiculoId);
  if (m.placa && vehiculo && m.placa.toUpperCase() !== vehiculo.placa.toUpperCase()) {
    const actualizado = await viajes.update(viaje.id, {
      mensajeError:
        `El manifiesto ${numero} YA EXISTE en el RNDC (radicado ${m.radicado}), pero ` +
        `con la placa ${m.placa} y no ${vehiculo.placa}: ese numero lo uso otro despacho. Cambia el ` +
        "numero de este viaje y reintenta.",
      codigoError: null,
      errorCrudo: null,
    });
    return { status: 409, cuerpo: { ...actualizado, remesas: await viajeRemesas.findByViaje(viaje.id) } };
  }

  // Las remesas que aqui no figuran como creadas: el manifiesto del RNDC las
  // ampara, asi que deben existir alla. Se toma su radicado.
  const faltantes: string[] = [];
  for (const f of await viajeRemesas.findByViaje(viaje.id)) {
    if (f.estado === "CREADA" || f.estado === "ANULADA") continue;
    let radicado: string | null = null;
    try {
      radicado = await buscarRemesaRadicada(cliente, credenciales, f.consecutivoRemesa!);
    } catch {
      radicado = null;
    }
    if (radicado) {
      await viajeRemesas.update(f.id, { estado: "CREADA", numeroRemesaRndc: radicado, mensajeError: null });
    } else {
      faltantes.push(f.consecutivoRemesa!);
    }
  }

  // Si se encontro con otro numero (el que se uso en el portal), el viaje pasa
  // a llevar ese. El indice unico impide que quede repetido con otro viaje.
  if (numero !== (viaje.consecutivoManifiesto ?? "").toUpperCase()) {
    // Los numeros del propio viaje (sus remesas) no cuentan como "de otro".
    const propios = new Set((await viajeRemesas.findByViaje(viaje.id)).map((r) => r.consecutivoRemesa));
    const otro = (await viajes.consecutivosUsados()).has(numero) && !propios.has(numero);
    if (otro) {
      const actualizado = await viajes.update(viaje.id, {
        mensajeError:
          `El manifiesto ${numero} existe en el RNDC (radicado ${m.radicado}), pero en este sistema ese ` +
          "numero ya lo tiene otro viaje. Revisa en Viajes cual es el correcto.",
      });
      return { status: 409, cuerpo: { ...actualizado, remesas: await viajeRemesas.findByViaje(viaje.id) } };
    }
    await viajes.update(viaje.id, { consecutivoManifiesto: numero });
  }

  const final = await viajes.update(viaje.id, {
    estado: "CONFIRMADO",
    numeroManifiestoRndc: m.radicado,
    // Los valores con que quedo expedido mandan sobre los del intento fallido.
    valorFleteReal: m.valorFlete ?? viaje.valorFleteReal,
    retencionFopat: m.retencionFopat ?? viaje.retencionFopat,
    valorAnticipoManifiesto: m.valorAnticipo ?? viaje.valorAnticipoManifiesto,
    codVia: m.codVia ?? viaje.codVia,
    mensajeError: null,
    codigoError: null,
    errorCrudo: null,
    avisos:
      `Manifiesto encontrado en el RNDC: ya estaba expedido (radicado ${m.radicado}` +
      `${m.fecha ? `, ${m.fecha}` : ""}). Se tomaron sus valores: flete, FOPAT, anticipo y via.` +
      (faltantes.length > 0 ? ` | OJO: no se encontraron en el RNDC las remesas ${faltantes.join(", ")}.` : ""),
  });
  return {
    status: 200,
    cuerpo: { ...final, remesas: await viajeRemesas.findByViaje(viaje.id), encontradoEnRndc: true },
  };
}

/**
 * Todos los datos que el viaje envia (o enviaria) al RNDC, sin enviar nada.
 * Para revisarlos antes de reintentar.
 */
despachoRouter.get("/:id/datos-rndc", async (req, res) => {
  const viaje = await viajes.findById(Number(req.params.id));
  if (!viaje) return res.status(404).json({ error: "Viaje no encontrado" });
  const r = await procesarViaje(viaje.id, { soloDatos: true });
  res.status(r.status).json(r.cuerpo);
});

/**
 * Reintenta un viaje que quedo a medias, despues de corregir lo necesario.
 *
 * Caso tipico: la remesa se creo pero el manifiesto fue rechazado (ej. MAN130,
 * el titular no existe como tercero). Se corrige en el catalogo o en el portal
 * del RNDC y se reintenta: las remesas ya creadas se reutilizan y solo se envia
 * lo que falta.
 *
 * El body puede corregir los datos del manifiesto: vehiculo, conductores,
 * remolque, valores, via, EMF, vacios, viajes del dia y el numero.
 *
 * Tambien las cargas (`remesas`), pero solo las que el RNDC aun no creo:
 *   - Si ninguna remesa esta creada, se reemplazan todas (se pueden agregar o
 *     quitar cargas) y se renumeran con el numero base del viaje.
 *   - Si alguna ya esta creada, esas no se tocan (en el RNDC ya existen; si
 *     tienen un error se anulan) y no se pueden agregar ni quitar cargas: solo
 *     se corrigen las pendientes, en el mismo orden.
 * Es lo que usa "Despachar" cuando el RNDC rechaza: reintenta el mismo viaje
 * en vez de crear otro con el mismo numero.
 */
despachoRouter.post("/:id/reintentar", async (req, res) => {
  const viajeId = Number(req.params.id);
  const viaje = await viajes.findById(viajeId);
  if (!viaje) return res.status(404).json({ error: "Viaje no encontrado" });

  if (!ESTADOS_REINTENTABLES.includes(viaje.estado)) {
    return res.status(409).json({
      error:
        viaje.estado === "CONFIRMADO"
          ? "Este viaje ya tiene manifiesto confirmado: no hay nada que reintentar."
          : `Un viaje en estado ${viaje.estado} no se puede reintentar.`,
    });
  }

  // Primero: si el manifiesto ya se expidio por fuera del sistema, se toma ese
  // y no se reenvia nada (las correcciones del formulario ya no aplican).
  const yaExpedido = await tomarSiYaExpedido(
    viaje,
    req.body?.consecutivoManifiesto ? String(req.body.consecutivoManifiesto) : null
  );
  if (yaExpedido) return res.status(yaExpedido.status).json(yaExpedido.cuerpo);

  const b = req.body ?? {};
  const cambios: Partial<Viaje> = {};
  const num = (v: unknown) => (v === "" || v === null || v === undefined ? null : Number(v));

  if (b.vehiculoId !== undefined) {
    const v = await vehiculos.findById(Number(b.vehiculoId));
    if (!v) return res.status(404).json({ error: "Vehiculo no encontrado" });
    cambios.vehiculoId = v.id;
    // Si cambia el vehiculo y no se eligio EMF, se toma la del vehiculo nuevo.
    if (b.nitMonitoreoFlota === undefined) {
      cambios.nitMonitoreoFlota = v.nitMonitoreoFlota || config.rndc.nitMonitoreoFlota || null;
    }
  }
  if (b.conductorId !== undefined) {
    if (!(await conductores.findById(Number(b.conductorId)))) {
      return res.status(404).json({ error: "Conductor no encontrado" });
    }
    cambios.conductorId = Number(b.conductorId);
  }
  if (b.conductor2Id !== undefined) cambios.conductor2Id = num(b.conductor2Id);
  if (b.remolqueId !== undefined) {
    // null o vacio = sin remolque (vehiculo rigido).
    if (b.remolqueId === null || b.remolqueId === "") {
      cambios.remolqueId = null;
    } else {
      if (!(await remolques.findById(Number(b.remolqueId)))) {
        return res.status(404).json({ error: "Remolque no encontrado" });
      }
      cambios.remolqueId = Number(b.remolqueId);
    }
  }
  if (b.valorFleteReal !== undefined) cambios.valorFleteReal = num(b.valorFleteReal);
  if (b.valorAnticipoManifiesto !== undefined) {
    cambios.valorAnticipoManifiesto = num(b.valorAnticipoManifiesto) ?? 0;
  }
  if (b.retencionFopat !== undefined) cambios.retencionFopat = num(b.retencionFopat);
  if (b.codVia !== undefined) cambios.codVia = b.codVia ? String(b.codVia) : null;
  if (b.nitMonitoreoFlota !== undefined) {
    cambios.nitMonitoreoFlota = b.nitMonitoreoFlota
      ? String(b.nitMonitoreoFlota).replace(/\D/g, "")
      : null;
  }
  if (b.fechaPagoSaldo !== undefined) {
    cambios.fechaPagoSaldo = b.fechaPagoSaldo ? new Date(b.fechaPagoSaldo) : null;
  }
  if (b.viajesDia !== undefined) cambios.viajesDia = num(b.viajesDia);
  for (const n of [1, 2] as const) {
    const o = `vacio${n}Origen` as const;
    const d = `vacio${n}Destino` as const;
    const v = `vacio${n}Valor` as const;
    if (b[o] !== undefined) cambios[o] = b[o] ? String(b[o]) : null;
    if (b[d] !== undefined) cambios[d] = b[d] ? String(b[d]) : null;
    if (b[v] !== undefined) cambios[v] = num(b[v]) ?? 0;
  }

  if (b.consecutivoManifiesto !== undefined) {
    const nuevo = String(b.consecutivoManifiesto).trim().toUpperCase();
    // Hasta 15 caracteres alfanumericos [MANIFIESTO V7, consecutivo del manifiesto].
    if (!/^[A-Z0-9]+$/.test(nuevo) || nuevo.length > MAX_CARACTERES_CONSECUTIVO) {
      return res.status(422).json({
        error: `El numero de manifiesto solo admite letras y digitos, maximo ${MAX_CARACTERES_CONSECUTIVO} caracteres.`,
      });
    }
    if (nuevo !== (viaje.consecutivoManifiesto ?? "").toUpperCase()) {
      // Los numeros propios del viaje no cuentan como "usados": son los que se
      // estan corrigiendo.
      const usados = await viajes.consecutivosUsados();
      if (usados.has(nuevo)) {
        return res.status(422).json({ error: `El numero ${nuevo} ya esta usado por otro viaje.` });
      }
      cambios.consecutivoManifiesto = nuevo;
    }
  }

  // ---- Cargas (remesas) ----
  const filasActuales = (await viajeRemesas.findByViaje(viajeId)).filter((r) => r.estado !== "ANULADA");
  const yaCreadas = filasActuales.filter((r) => r.estado === "CREADA");
  const base = cambios.consecutivoManifiesto ?? viaje.consecutivoManifiesto!;
  let reemplazarRemesas: NuevaViajeRemesa[] | null = null;
  const corregirRemesas: Array<{ id: number; datos: Partial<ViajeRemesa> }> = [];

  if (Array.isArray(b.remesas) && b.remesas.length > 0) {
    const entrada: any[] = b.remesas;
    if (entrada.length > MAX_REMESAS_POR_MANIFIESTO) {
      return res.status(422).json({ error: `Un manifiesto admite hasta ${MAX_REMESAS_POR_MANIFIESTO} remesas` });
    }
    for (const [i, r] of entrada.entries()) {
      if (!r.plantillaId || !(await plantillas.findById(Number(r.plantillaId)))) {
        return res.status(422).json({ error: `La carga ${i + 1} no tiene una plantilla valida.` });
      }
      if (!r.fechaHoraCargue || !r.fechaHoraDescargue) {
        return res.status(422).json({ error: `La carga ${i + 1} necesita cita de cargue y de descargue.` });
      }
    }
    const nueva = (r: any, i: number): NuevaViajeRemesa => ({
      plantillaId: Number(r.plantillaId),
      orden: i + 1,
      pesoReal: r.pesoReal ? Number(r.pesoReal) : null,
      cantidadReal: r.cantidadReal ? Number(r.cantidadReal) : null,
      fechaHoraCargue: fechaHoraColombia(r.fechaHoraCargue),
      fechaHoraDescargue: fechaHoraColombia(r.fechaHoraDescargue),
      ordenServicioGenerador: r.ordenServicioGenerador ?? null,
      valorFleteRemesa: r.valorFleteRemesa ? Number(r.valorFleteRemesa) : null,
    });

    if (yaCreadas.length === 0) {
      // Nada esta en el RNDC: las cargas se reemplazan completas.
      reemplazarRemesas = entrada.map(nueva);
    } else {
      if (entrada.length !== filasActuales.length) {
        return res.status(422).json({
          error:
            `Las remesas ${yaCreadas.map((r) => r.consecutivoRemesa).join(", ")} ya estan creadas en el ` +
            "RNDC: no se pueden agregar ni quitar cargas. Corrige solo las pendientes, o anula el viaje " +
            "para empezar de nuevo.",
        });
      }
      entrada.forEach((r, i) => {
        const fila = filasActuales[i];
        if (fila.estado === "CREADA") return; // ya existe en el RNDC: no se toca
        const n = nueva(r, i);
        corregirRemesas.push({
          id: fila.id,
          datos: {
            plantillaId: n.plantillaId,
            pesoReal: n.pesoReal,
            cantidadReal: n.cantidadReal,
            fechaHoraCargue: n.fechaHoraCargue,
            fechaHoraDescargue: n.fechaHoraDescargue,
            ordenServicioGenerador: n.ordenServicioGenerador,
            valorFleteRemesa: n.valorFleteRemesa,
          },
        });
      });
    }
  } else if (yaCreadas.length === 0 && cambios.consecutivoManifiesto) {
    // Cambio de numero sin tocar las cargas: las remesas se renumeran igual,
    // porque ninguna existe aun en el RNDC.
    reemplazarRemesas = filasActuales.map((f) => ({
      plantillaId: f.plantillaId!,
      orden: f.orden,
      pesoReal: f.pesoReal,
      cantidadReal: f.cantidadReal,
      fechaHoraCargue: new Date(f.fechaHoraCargue),
      fechaHoraDescargue: new Date(f.fechaHoraDescargue),
      ordenServicioGenerador: f.ordenServicioGenerador,
      valorFleteRemesa: f.valorFleteRemesa,
    }));
  }

  // Con remesas nuevas, el numero base debe servir para todas (con letra).
  if (reemplazarRemesas) {
    const propios = new Set(
      [viaje.consecutivoManifiesto, ...filasActuales.map((f) => f.consecutivoRemesa)].filter(Boolean) as string[]
    );
    const usados = new Set([...(await viajes.consecutivosUsados())].filter((c) => !propios.has(c)));
    const problemas = validarBase(base, reemplazarRemesas.length, usados);
    if (problemas.length > 0) {
      return res.status(422).json({ error: problemas.map((p) => p.mensaje).join(" ") });
    }
  }

  // Candado contra el doble clic: solo un reintento a la vez toma el viaje.
  if (!(await viajes.tomarParaReintento(viajeId, ESTADOS_REINTENTABLES))) {
    return res.status(409).json({ error: "El viaje ya se esta reintentando. Espera el resultado." });
  }

  try {
    if (reemplazarRemesas) {
      // El viaje guarda la plantilla principal y las fechas extremas de las cargas.
      cambios.plantillaId = reemplazarRemesas[0].plantillaId;
      cambios.fechaHoraCargue = reemplazarRemesas.reduce(
        (m, r) => (r.fechaHoraCargue < m ? r.fechaHoraCargue : m),
        reemplazarRemesas[0].fechaHoraCargue
      );
      cambios.fechaHoraDescargue = reemplazarRemesas.reduce(
        (m, r) => (r.fechaHoraDescargue > m ? r.fechaHoraDescargue : m),
        reemplazarRemesas[0].fechaHoraDescargue
      );
    } else if (corregirRemesas.length > 0) {
      const todas = filasActuales.map((f) => corregirRemesas.find((c) => c.id === f.id)?.datos ?? f);
      cambios.fechaHoraCargue = todas.reduce(
        (m, r) => (new Date(r.fechaHoraCargue!) < m ? new Date(r.fechaHoraCargue!) : m),
        new Date(todas[0].fechaHoraCargue!)
      );
      cambios.fechaHoraDescargue = todas.reduce(
        (m, r) => (new Date(r.fechaHoraDescargue!) > m ? new Date(r.fechaHoraDescargue!) : m),
        new Date(todas[0].fechaHoraDescargue!)
      );
      if (filasActuales[0].estado !== "CREADA") cambios.plantillaId = todas[0].plantillaId;
    }
    if (Object.keys(cambios).length > 0) await viajes.update(viajeId, cambios);
    if (reemplazarRemesas) {
      await viajeRemesas.borrarDeViaje(viajeId);
      await viajeRemesas.crearParaViaje(
        viajeId,
        reemplazarRemesas.map((r, i) => ({ ...r, consecutivoRemesa: consecutivoRemesa(base, i + 1) }))
      );
    }
    for (const c of corregirRemesas) {
      await viajeRemesas.update(c.id, { ...c.datos, estado: "PENDIENTE", mensajeError: null });
    }
    const resultado = await procesarViaje(viajeId);
    res.status(resultado.status).json(resultado.cuerpo);
  } catch (exc) {
    // Si algo inesperado falla, el viaje no puede quedar trabado en
    // REINTENTANDO: vuelve a su estado anterior para poder reintentarlo.
    await viajes.update(viajeId, { estado: viaje.estado });
    throw exc;
  }
});

// ---------------------------------------------------------------------------
// Anulacion
// ---------------------------------------------------------------------------

/**
 * Estados desde los que se puede anular. ANULACION_ERROR permite retomar una
 * anulacion a medias: lo ya anulado queda registrado y no se repite.
 */
const ESTADOS_ANULABLES = [
  "CONFIRMADO",
  "MANIFIESTO_ERROR",
  "REMESA_ERROR",
  "VALIDACION_ERROR",
  "ANULACION_ERROR",
];

/** Lo que falta anular de un viaje, en el orden en que se hara. */
/**
 * Antes de anular, pregunta al RNDC (solo lectura) que existe de verdad y lo
 * guarda en el viaje y sus remesas:
 * - el cumplido inicial del GPS de cada remesa (45) y si ya se anulo (54);
 * - si la remesa (9) o el manifiesto (32) ya se anularon, por ejemplo en el portal.
 * Asi la anulacion solo envia lo que falta y en el orden correcto. Devuelve
 * false si el RNDC no respondio (entonces se anula como antes, a ciegas).
 */
async function consultarEstadoParaAnular(viaje: Viaje, remesas: ViajeRemesa[]): Promise<boolean> {
  if (config.rndc.simular) return false;
  const lector = new RndcClient({
    wsdlUrl: config.rndc.wsdlUrl,
    usuario: config.rndc.usuario,
    password: config.rndc.password,
    simular: false,
    reintentos: config.rndc.reintentos,
    soloConsultas: true,
  });
  const cred = { usuario: config.rndc.usuario, password: config.rndc.password, nitEmpresa: config.rndc.empresaNit };
  try {
    if (viaje.numeroManifiestoRndc && !viaje.radicadoAnulacion && viaje.consecutivoManifiesto) {
      const a = await leerAnulacionManifiesto(lector, cred, viaje.consecutivoManifiesto);
      if (a) {
        await viajes.update(viaje.id, { radicadoAnulacion: a.radicado, motivoAnulacion: a.motivo, observacionesAnulacion: a.observaciones });
        viaje.radicadoAnulacion = a.radicado;
      }
    }
    for (const r of remesas.filter((x) => x.estado === "CREADA" && x.consecutivoRemesa)) {
      const [ci, aci, ar] = await Promise.all([
        r.radicadoCumplidoInicial ? Promise.resolve(null) : leerCumplidoInicial(lector, cred, r.consecutivoRemesa!),
        r.radicadoAnulacionCumplido ? Promise.resolve(null) : leerAnulacionCumplidoInicial(lector, cred, r.consecutivoRemesa!),
        leerAnulacionRemesa(lector, cred, r.consecutivoRemesa!),
      ]);
      const cambios: Partial<ViajeRemesa> = {};
      if (ci?.radicado) cambios.radicadoCumplidoInicial = ci.radicado;
      if (aci) cambios.radicadoAnulacionCumplido = aci.radicado;
      if (ar) Object.assign(cambios, { estado: "ANULADA", radicadoAnulacion: ar.radicado });
      if (Object.keys(cambios).length) {
        await viajeRemesas.update(r.id, cambios);
        Object.assign(r, cambios);
      }
    }
    return true;
  } catch (exc) {
    console.warn(`No se pudo consultar el estado del viaje ${viaje.id} en el RNDC antes de anular:`, (exc as Error).message);
    return false;
  }
}

/**
 * Lo que falta anular de un viaje. Con `consultado` (se sabe del RNDC que
 * existe), solo se anulan los cumplidos iniciales que existen y siguen
 * vigentes; sin consulta, se intenta en todas las remesas (como antes).
 */
function planDeAnulacion(viaje: Viaje, remesas: ViajeRemesa[], consultado = false) {
  const manifiestoVigente = !!viaje.numeroManifiestoRndc && !viaje.radicadoAnulacion;
  const remesasVigentes = remesas.filter((r) => r.estado === "CREADA");
  return {
    manifiestoVigente,
    remesasVigentes,
    consultado,
    // El cumplido inicial solo existe si hubo manifiesto (lo genera el
    // monitoreo del manifiesto), y el proceso 54 pide su numero.
    cumplidosPorAnular: manifiestoVigente
      ? remesasVigentes.filter((r) =>
          consultado ? !!r.radicadoCumplidoInicial && !r.radicadoAnulacionCumplido : !r.radicadoAnulacionCumplido
        )
      : [],
    // Nada creado en el RNDC: la "anulacion" es solo local (descartar).
    soloLocal: !manifiestoVigente && remesasVigentes.length === 0,
  };
}

/** Mes "AAAA-MM" de una fecha (para el tope mensual de anulaciones). */
function mesDe(fecha: Date): string {
  return new Date(fecha).toISOString().slice(0, 7);
}

/**
 * Vista previa: que pasos se van a ejecutar, que motivos acepta el RNDC y como
 * va el tope mensual de anulaciones de manifiestos.
 */
despachoRouter.get("/:id/anulacion", async (req, res) => {
  const viaje = await viajes.findById(Number(req.params.id));
  if (!viaje) return res.status(404).json({ error: "Viaje no encontrado" });
  const remesas = await viajeRemesas.findByViaje(viaje.id);
  const consultado = ESTADOS_ANULABLES.includes(viaje.estado) ? await consultarEstadoParaAnular(viaje, remesas) : false;
  const plan = planDeAnulacion(viaje, remesas, consultado);

  let tope = null;
  if (plan.manifiestoVigente) {
    const conteo = await viajes.conteoManifiestosMes(mesDe(viaje.fechaCreacion));
    const porcentaje = porcentajeTopeAnulaciones(conteo.expedidos);
    tope = {
      ...conteo,
      porcentaje,
      maximo: Math.floor(conteo.expedidos * porcentaje),
    };
  }

  res.json({
    anulable: ESTADOS_ANULABLES.includes(viaje.estado),
    estado: viaje.estado,
    pasos: [
      ...plan.cumplidosPorAnular.map((r) => `Anular cumplido inicial de la remesa ${r.consecutivoRemesa} (proceso 54)`),
      ...(plan.manifiestoVigente ? [`Anular manifiesto ${viaje.consecutivoManifiesto} (proceso 32)`] : []),
      ...plan.remesasVigentes.map((r) => `Anular remesa ${r.consecutivoRemesa} (proceso 9)`),
      ...(plan.soloLocal ? ["Nada quedo creado en el RNDC: el viaje solo se marca como anulado aqui"] : []),
    ],
    soloLocal: plan.soloLocal,
    tope,
    motivos: {
      manifiesto: MOTIVOS_ANULACION_MANIFIESTO,
      cumplido: MOTIVOS_ANULACION_CUMPLIDO,
      remesa: MOTIVOS_ANULACION_REMESA,
    },
  });
});

/**
 * Anula un viaje en el RNDC, en el orden que exige:
 *   1. cumplido inicial de cada remesa (54): lo genera el satelital y pide el
 *      numero del manifiesto, asi que va mientras este exista;
 *   2. el manifiesto (32);
 *   3. cada remesa (9): el RNDC no deja anular una remesa ligada a un
 *      manifiesto vigente (ANR030).
 *
 * Cada paso exitoso se guarda en el momento. Si uno falla, el viaje queda en
 * ANULACION_ERROR y al volver a llamar se retoma desde ahi.
 *
 * Un error en el paso 1 NO detiene la anulacion: no sabemos que responde el
 * RNDC cuando la remesa no tiene cumplido inicial (sin satelital, como en
 * pruebas). Si el cumplido existia y no se anulo, el paso 2 falla con su
 * propio mensaje y no se pierde nada.
 */
despachoRouter.post("/:id/anular", async (req, res) => {
  const viajeId = Number(req.params.id);
  const viaje = await viajes.findById(viajeId);
  if (!viaje) return res.status(404).json({ error: "Viaje no encontrado" });
  if (!ESTADOS_ANULABLES.includes(viaje.estado)) {
    return res.status(409).json({
      error:
        viaje.estado === "ANULADO"
          ? "Este viaje ya esta anulado."
          : `Un viaje en estado ${viaje.estado} no se puede anular.`,
    });
  }

  const cumplidas = (await viajeRemesas.findByViaje(viajeId)).filter((r) =>
    ["CUMPLIDA", "CUMPLIENDO"].includes(r.estado)
  );
  if (cumplidas.length > 0) {
    return res.status(409).json({
      error:
        `La remesa ${cumplidas.map((r) => r.consecutivoRemesa).join(", ")} ya tiene cumplido en el RNDC ` +
        "y una remesa cumplida no se puede anular. Primero hay que anular el cumplido en el portal.",
    });
  }

  const b = req.body ?? {};
  const observaciones = String(b.observaciones ?? "").trim();
  const motivoManifiesto = String(b.motivoManifiesto ?? "").toUpperCase();
  const motivoCumplido = String(b.motivoCumplido ?? "D").toUpperCase();
  const motivoRemesa = String(b.motivoRemesa ?? "D").toUpperCase();

  // Las observaciones son obligatorias en los tres procesos [Manual 6.1].
  if (observaciones.length < 5) {
    return res.status(422).json({ error: "Explica en las observaciones por que se anula (obligatorio)." });
  }
  const remesas = await viajeRemesas.findByViaje(viajeId);
  const consultado = await consultarEstadoParaAnular(viaje, remesas);
  const plan = planDeAnulacion(viaje, remesas, consultado);
  if (plan.manifiestoVigente && !(motivoManifiesto in MOTIVOS_ANULACION_MANIFIESTO)) {
    return res.status(422).json({ error: "Elige el motivo de anulacion del manifiesto." });
  }
  if (!(motivoCumplido in MOTIVOS_ANULACION_CUMPLIDO) || !(motivoRemesa in MOTIVOS_ANULACION_REMESA)) {
    return res.status(422).json({ error: "Motivo de anulacion no valido." });
  }

  if (!(await viajes.tomarConEstado(viajeId, ESTADOS_ANULABLES, "ANULANDO"))) {
    return res.status(409).json({ error: "El viaje ya se esta procesando. Espera el resultado." });
  }

  const obs = observaciones.slice(0, 200);
  const fallar = async (mensaje: string, resultado?: { codigoError: string | null; errorCrudo: string | null }) => {
    const actualizado = await viajes.update(viajeId, {
      estado: "ANULACION_ERROR",
      mensajeError: mensaje,
      codigoError: resultado?.codigoError ?? null,
      errorCrudo: resultado?.errorCrudo ?? null,
    });
    return res.status(422).json({ ...actualizado, remesas: await viajeRemesas.findByViaje(viajeId) });
  };

  try {
    // Nada en el RNDC: se descarta localmente.
    if (plan.soloLocal) {
      const final = await viajes.update(viajeId, {
        estado: "ANULADO",
        motivoAnulacion: plan.manifiestoVigente ? motivoManifiesto : null,
        observacionesAnulacion: obs,
        fechaAnulacion: new Date(),
        anuladoPorId: req.usuario?.id ?? null,
        mensajeError: null,
        codigoError: null,
        errorCrudo: null,
      });
      return res.json({ ...final, remesas });
    }

    const credenciales = {
      usuario: config.rndc.usuario,
      password: config.rndc.password,
      nitEmpresa: config.rndc.empresaNit,
    };
    const cliente = new RndcClient({
      wsdlUrl: config.rndc.wsdlUrl,
      usuario: config.rndc.usuario,
      password: config.rndc.password,
      simular: config.rndc.simular,
      reintentos: config.rndc.reintentos,
    });
    const avisos: string[] = [];

    // 1. Cumplido inicial (54). No bloqueante: ver comentario de la ruta.
    for (const r of plan.cumplidosPorAnular) {
      const xml = construirXmlMensaje(
        credenciales,
        PROCESO_ID_ANULAR_CUMPLIDO_INICIAL,
        construirDatosAnularCumplidoInicial(
          r.consecutivoRemesa!,
          viaje.consecutivoManifiesto!,
          motivoCumplido as MotivoAnulacionCumplido,
          obs
        )
      );
      const resultado = await cliente.enviar(xml, PROCESO_ID_ANULAR_CUMPLIDO_INICIAL);
      if (resultado.ok) {
        await viajeRemesas.update(r.id, { radicadoAnulacionCumplido: resultado.radicado });
      } else if (plan.consultado) {
        // Se sabe que el cumplido inicial existe: sin anularlo, el RNDC tampoco
        // deja anular el manifiesto. Se detiene aqui con el error claro.
        return await fallar(
          `No se pudo anular el cumplido inicial (GPS) de la remesa ${r.consecutivoRemesa}: ${resultado.error}. ` +
            "Mientras exista, el RNDC no deja anular el manifiesto. Nada mas se anulo.",
          resultado
        );
      } else {
        avisos.push(
          `Cumplido inicial de la remesa ${r.consecutivoRemesa}: ${resultado.errorCrudo ?? resultado.error}`
        );
      }
    }

    // 2. Manifiesto (32).
    if (plan.manifiestoVigente) {
      const xml = construirXmlMensaje(
        credenciales,
        PROCESO_ID_ANULAR_MANIFIESTO,
        construirDatosAnularManifiesto(
          viaje.consecutivoManifiesto!,
          motivoManifiesto as MotivoAnulacionManifiesto,
          obs
        )
      );
      const resultado = await cliente.enviar(xml, PROCESO_ID_ANULAR_MANIFIESTO);
      if (!resultado.ok) {
        const previos = avisos.length > 0 ? ` Antes, al anular el cumplido inicial: ${avisos.join(" | ")}` : "";
        return await fallar(
          `No se pudo anular el manifiesto ${viaje.consecutivoManifiesto}: ${resultado.error}.${previos} ` +
            `Nada de las remesas se anulo todavia.`,
          resultado
        );
      }
      await viajes.update(viajeId, {
        radicadoAnulacion: resultado.radicado,
        motivoAnulacion: motivoManifiesto,
        observacionesAnulacion: obs,
      });
    }

    // 3. Remesas (9).
    const anuladas: string[] = [];
    for (const r of plan.remesasVigentes) {
      const xml = construirXmlMensaje(
        credenciales,
        PROCESO_ID_ANULAR_REMESA,
        construirDatosAnularRemesa(r.consecutivoRemesa!, motivoRemesa as MotivoAnulacionRemesa, obs)
      );
      const resultado = await cliente.enviar(xml, PROCESO_ID_ANULAR_REMESA);
      if (!resultado.ok) {
        const hecho = [
          ...(plan.manifiestoVigente ? [`el manifiesto ${viaje.consecutivoManifiesto}`] : []),
          ...anuladas.map((c) => `la remesa ${c}`),
        ];
        return await fallar(
          `${hecho.length > 0 ? `Ya se anularon ${hecho.join(", ")}. ` : ""}` +
            `No se pudo anular la remesa ${r.consecutivoRemesa}: ${resultado.error}. ` +
            `Corrige y vuelve a anular: se retoma desde esta remesa.`,
          resultado
        );
      }
      await viajeRemesas.update(r.id, {
        estado: "ANULADA",
        radicadoAnulacion: resultado.radicado,
        mensajeError: null,
      });
      anuladas.push(r.consecutivoRemesa!);
    }

    const final = await viajes.update(viajeId, {
      estado: "ANULADO",
      observacionesAnulacion: obs,
      fechaAnulacion: new Date(),
      anuladoPorId: req.usuario?.id ?? null,
      mensajeError: null,
      codigoError: null,
      errorCrudo: null,
      // Lo del cumplido inicial queda como aviso: puede ser solo que no existia.
      avisos: avisos.length > 0 ? avisos.join(" | ") : null,
    });
    res.json({ ...final, remesas: await viajeRemesas.findByViaje(viajeId) });
  } catch (exc) {
    // Falla inesperada (red, base de datos): no dejar el viaje en ANULANDO.
    await viajes.update(viajeId, {
      estado: "ANULACION_ERROR",
      mensajeError: `Error inesperado al anular: ${(exc as Error).message}. Revisa en el portal que quedo anulado antes de reintentar.`,
    });
    throw exc;
  }
});

/**
 * Cliente y credenciales del RNDC para registrar (tipo 1). Mismo servidor que
 * la expedicion y la anulacion.
 */
function clienteRegistro() {
  return {
    credenciales: {
      usuario: config.rndc.usuario,
      password: config.rndc.password,
      nitEmpresa: config.rndc.empresaNit,
    },
    cliente: new RndcClient({
      wsdlUrl: config.rndc.wsdlUrl,
      usuario: config.rndc.usuario,
      password: config.rndc.password,
      simular: config.rndc.simular,
      reintentos: config.rndc.reintentos,
    }),
  };
}

/**
 * Cumplido de una remesa (proceso 5): reporta los kilos entregados y la hora
 * real de entrada al cargue y al descargue. El RNDC completa la llegada y la
 * salida con el cumplido inicial que genera el GPS [Guia Cumplido 2.3].
 *
 * Solo cumplido normal (tipo C); el de suspension se hace en el portal (ver
 * construirDatosCumplidoRemesa).
 */
despachoRouter.post("/remesas/:remesaId/cumplir", async (req, res) => {
  const remesa = await viajeRemesas.findById(Number(req.params.remesaId));
  if (!remesa) return res.status(404).json({ error: "Remesa no encontrada" });
  const viaje = await viajes.findById(remesa.viajeId);
  if (!viaje) return res.status(404).json({ error: "Viaje no encontrado" });

  // "La remesa debe estar ligada a un manifiesto activo" [Manual RNDC 5.3.4].
  if (viaje.estado !== "CONFIRMADO") {
    return res.status(409).json({
      error: `Solo se cumplen remesas de un viaje con manifiesto vigente (este esta ${viaje.estado}).`,
    });
  }
  if (remesa.estado === "CUMPLIDA") {
    return res.status(409).json({ error: `La remesa ${remesa.consecutivoRemesa} ya esta cumplida.` });
  }
  if (remesa.estado !== "CREADA") {
    return res.status(409).json({
      error: `La remesa ${remesa.consecutivoRemesa} esta en estado ${remesa.estado} y no se puede cumplir.`,
    });
  }

  const b = req.body ?? {};
  const datos = {
    consecutivoRemesa: remesa.consecutivoRemesa!,
    cantidadCargada: Number(remesa.pesoReal ?? 0),
    cantidadEntregada: Number(b.cantidadEntregada),
    entradaCargue: fechaHoraColombia(b.entradaCargue),
    entradaDescargue: fechaHoraColombia(b.entradaDescargue),
    llegadaCargue: b.llegadaCargue ? fechaHoraColombia(b.llegadaCargue) : null,
    salidaCargue: b.salidaCargue ? fechaHoraColombia(b.salidaCargue) : null,
    llegadaDescargue: b.llegadaDescargue ? fechaHoraColombia(b.llegadaDescargue) : null,
    salidaDescargue: b.salidaDescargue ? fechaHoraColombia(b.salidaDescargue) : null,
  };
  const problemas = validarCumplidoRemesa(datos);
  if (problemas.length > 0) return res.status(422).json({ error: problemas.join(" ") });

  if (!(await viajeRemesas.tomarConEstado(remesa.id, ["CREADA"], "CUMPLIENDO"))) {
    return res.status(409).json({ error: "Esa remesa ya se esta cumpliendo. Espera el resultado." });
  }

  try {
    const { credenciales, cliente } = clienteRegistro();
    const enviar = (d: typeof datos) =>
      cliente.enviar(
        construirXmlMensaje(credenciales, PROCESO_ID_CUMPLIR_REMESA, construirDatosCumplidoRemesa(d)),
        PROCESO_ID_CUMPLIR_REMESA
      );
    // Como el portal: lo que el GPS ya reporto (cumplido inicial, proceso 45)
    // no se reenvia igual. Si el usuario lo corrigio a mano, va su valor y el
    // RNDC decide (puede responder CRE111 si no acepta cambiar el del GPS).
    const gps = await gpsDeRemesa(remesa.consecutivoRemesa!);
    const mismoMinuto = (a: Date | null, b: Date | null | undefined) =>
      !!a && !!b && Math.floor(a.getTime() / 60000) === Math.floor(new Date(b).getTime() / 60000);
    const segunGps = (campo: "llegadaCargue" | "salidaCargue" | "llegadaDescargue" | "salidaDescargue") =>
      gps?.[campo] && (datos[campo] === null || mismoMinuto(datos[campo], gps[campo])) ? null : datos[campo];
    let enviados: typeof datos = datos;
    let resultado;
    if (gps !== undefined) {
      enviados = {
        ...datos,
        llegadaCargue: segunGps("llegadaCargue"),
        salidaCargue: segunGps("salidaCargue"),
        llegadaDescargue: segunGps("llegadaDescargue"),
        salidaDescargue: segunGps("salidaDescargue"),
      };
      resultado = await enviar(enviados);
    } else {
      // No se pudo consultar el GPS: primero solo con las entradas y, si el
      // RNDC pide llegada o salida, con todo. Un rechazo no registra nada.
      enviados = { ...datos, llegadaCargue: null, salidaCargue: null, llegadaDescargue: null, salidaDescargue: null };
      resultado = await enviar(enviados);
      if (!resultado.ok && /CRE(080|090|130|150|160)/.test(resultado.errorCrudo ?? "")) {
        enviados = datos;
        resultado = await enviar(datos);
      }
    }
    // Si ya estaba cumplida en el RNDC (por ejemplo desde el portal), se toma
    // ese radicado: el cumplido existe y no hay que repetirlo.
    const radicado = resultado.ok ? resultado.radicado : radicadoDeDuplicado(resultado.errorCrudo);

    if (!radicado) {
      await viajeRemesas.update(remesa.id, {
        estado: "CREADA",
        mensajeError: resultado.error ?? "El RNDC rechazo el cumplido.",
      });
      return res.status(422).json({
        error: resultado.error ?? "El RNDC rechazo el cumplido.",
        codigoError: resultado.codigoError,
        remesas: await viajeRemesas.findByViaje(viaje.id),
      });
    }

    await viajeRemesas.update(remesa.id, {
      estado: "CUMPLIDA",
      radicadoCumplido: radicado,
      cantidadEntregada: datos.cantidadEntregada,
      entradaCargue: datos.entradaCargue,
      entradaDescargue: datos.entradaDescargue,
      // Lo enviado (incluida una correccion al GPS); si no se envio, el del GPS.
      llegadaCargue: enviados.llegadaCargue ?? gps?.llegadaCargue ?? null,
      salidaCargue: enviados.salidaCargue ?? gps?.salidaCargue ?? null,
      llegadaDescargue: enviados.llegadaDescargue ?? gps?.llegadaDescargue ?? null,
      salidaDescargue: enviados.salidaDescargue ?? gps?.salidaDescargue ?? null,
      fechaCumplido: new Date(),
      cumplidoPorId: req.usuario?.id ?? null,
      mensajeError: resultado.ok ? null : `Ya estaba cumplida en el RNDC (radicado ${radicado}).`,
    });
    res.json({ viaje: await viajes.findById(viaje.id), remesas: await viajeRemesas.findByViaje(viaje.id) });
  } catch (exc) {
    // Falla inesperada (red, SQL): la remesa no puede quedar trabada en CUMPLIENDO.
    await viajeRemesas.update(remesa.id, { estado: "CREADA", mensajeError: (exc as Error).message });
    throw exc;
  }
});

/**
 * Cumplido inicial (GPS) de una remesa. undefined = no se pudo consultar;
 * null = no hay cumplido inicial (sin GPS).
 */
async function gpsDeRemesa(consecutivo: string) {
  if (config.rndc.simular) return null;
  try {
    return await leerCumplidoInicial(
      new RndcClient({
        wsdlUrl: config.rndc.wsdlUrl,
        usuario: config.rndc.usuario,
        password: config.rndc.password,
        simular: false,
        reintentos: config.rndc.reintentos,
        soloConsultas: true,
      }),
      { usuario: config.rndc.usuario, password: config.rndc.password, nitEmpresa: config.rndc.empresaNit },
      consecutivo
    );
  } catch (exc) {
    console.warn(`No se pudo leer el cumplido inicial (GPS) de ${consecutivo}:`, (exc as Error).message);
    return undefined;
  }
}

/** Tiempos que ya reporto el GPS, para mostrarlos bloqueados al cumplir. */
despachoRouter.get("/remesas/:remesaId/gps", async (req, res) => {
  const r = await viajeRemesas.findById(Number(req.params.remesaId));
  if (!r) return res.status(404).json({ error: "Remesa no encontrada" });
  const gps = await gpsDeRemesa(r.consecutivoRemesa!);
  res.json(gps === undefined ? { consultado: false } : { consultado: true, ...(gps ?? { radicado: null }) });
});

/**
 * Lo que quedo registrado en el cumplido de una remesa: kilos entregados y
 * los seis tiempos, leidos del RNDC (la verdad, incluso si se cumplio en el
 * portal). Si el RNDC no responde, lo que se envio desde este sistema.
 */
despachoRouter.get("/remesas/:remesaId/cumplido", async (req, res) => {
  const r = await viajeRemesas.findById(Number(req.params.remesaId));
  if (!r) return res.status(404).json({ error: "Remesa no encontrada" });
  if (!config.rndc.simular && r.consecutivoRemesa) {
    try {
      const lector = new RndcClient({
        wsdlUrl: config.rndc.wsdlUrl,
        usuario: config.rndc.usuario,
        password: config.rndc.password,
        simular: false,
        reintentos: config.rndc.reintentos,
        soloConsultas: true,
      });
      const t = await leerTiemposCumplidoRemesa(
        lector,
        { usuario: config.rndc.usuario, password: config.rndc.password, nitEmpresa: config.rndc.empresaNit },
        r.consecutivoRemesa
      );
      if (t) return res.json({ fuente: "RNDC", ...t });
      return res.json({ fuente: "RNDC", noCumplida: true });
    } catch (exc) {
      console.warn(`No se pudo leer el cumplido de ${r.consecutivoRemesa}:`, (exc as Error).message);
    }
  }
  res.json({
    fuente: "sistema",
    radicado: r.radicadoCumplido,
    cantidadEntregada: r.cantidadEntregada,
    llegadaCargue: r.llegadaCargue,
    entradaCargue: r.entradaCargue,
    salidaCargue: r.salidaCargue,
    llegadaDescargue: r.llegadaDescargue,
    entradaDescargue: r.entradaDescargue,
    salidaDescargue: r.salidaDescargue,
  });
});

/**
 * Anula el cumplido de una remesa (proceso 28) para corregirlo y volver a
 * cumplirla. La remesa vuelve a "creada" con los datos que tenia, para
 * corregir solo lo que estaba mal. Si el manifiesto ya esta cumplido, el RNDC
 * lo rechaza (ACR070): primero hay que anular el cumplido del manifiesto.
 */
despachoRouter.post("/remesas/:remesaId/anular-cumplido", async (req, res) => {
  const remesa = await viajeRemesas.findById(Number(req.params.remesaId));
  if (!remesa) return res.status(404).json({ error: "Remesa no encontrada" });
  const viaje = await viajes.findById(remesa.viajeId);
  if (!viaje) return res.status(404).json({ error: "Viaje no encontrado" });
  const motivo = String(req.body?.motivo ?? "").toUpperCase();
  const observaciones = String(req.body?.observaciones ?? "").trim() || "Anulacion de cumplido para corregir datos";

  const { credenciales, cliente } = clienteRegistro();
  // Lo registrado en el RNDC (incluidos los tiempos del GPS), para que el
  // formulario de correccion vuelva con esos mismos valores. Se lee antes de
  // anular: despues el RNDC ya no lo devuelve.
  let registrado: Awaited<ReturnType<typeof leerTiemposCumplidoRemesa>> = null;
  if (!config.rndc.simular) {
    try {
      registrado = await leerTiemposCumplidoRemesa(
        new RndcClient({
          wsdlUrl: config.rndc.wsdlUrl,
          usuario: config.rndc.usuario,
          password: config.rndc.password,
          simular: false,
          reintentos: config.rndc.reintentos,
          soloConsultas: true,
        }),
        credenciales,
        remesa.consecutivoRemesa!
      );
    } catch {
      registrado = null;
    }
  }
  const resultado = await cliente.enviar(
    construirXmlMensaje(
      credenciales,
      PROCESO_ID_ANULAR_CUMPLIDO_REMESA,
      construirDatosAnularCumplidoRemesa(remesa.consecutivoRemesa!, motivo, observaciones)
    ),
    PROCESO_ID_ANULAR_CUMPLIDO_REMESA
  );
  if (!resultado.ok) {
    let error = resultado.error ?? "El RNDC rechazo la anulacion.";
    if (/ACR070/.test(resultado.errorCrudo ?? "") && viaje.estado === "CUMPLIDO") {
      error +=
        " El manifiesto de este viaje ya esta cumplido: el RNDC no deja anular el cumplido de la " +
        "remesa hasta anular primero el cumplido del manifiesto (en el portal del RNDC).";
    }
    return res.status(422).json({ error, codigoError: resultado.codigoError });
  }

  await viajeRemesas.update(remesa.id, {
    estado: "CREADA",
    radicadoCumplido: null,
    fechaCumplido: null,
    radicadoAnulacionCumplidoRemesa: resultado.radicado,
    ...(registrado && {
      cantidadEntregada: registrado.cantidadEntregada ?? remesa.cantidadEntregada,
      llegadaCargue: registrado.llegadaCargue,
      entradaCargue: registrado.entradaCargue,
      salidaCargue: registrado.salidaCargue,
      llegadaDescargue: registrado.llegadaDescargue,
      entradaDescargue: registrado.entradaDescargue,
      salidaDescargue: registrado.salidaDescargue,
    }),
    mensajeError: `Cumplido anulado en el RNDC (radicado ${resultado.radicado}). Corrige y vuelve a cumplir.`,
  });
  res.json({ viaje: await viajes.findById(viaje.id), remesas: await viajeRemesas.findByViaje(viaje.id) });
});

/**
 * Lo que necesita la ventana de cumplido del manifiesto para calcular en
 * pantalla: valor del manifiesto, tarifa de retencion, si causa FOPAT y los
 * motivos que acepta el RNDC.
 */
async function baseCumplidoManifiesto(viaje: Viaje) {
  const [vehiculo, plantilla] = await Promise.all([
    vehiculos.findById(viaje.vehiculoId),
    plantillas.findById(viaje.plantillaId),
  ]);
  return {
    valorFlete: viaje.valorFleteReal ?? 0,
    valorAnticipo: viaje.valorAnticipoManifiesto ?? 0,
    vacio1Valor: viaje.vacio1Valor ?? 0,
    vacio2Valor: viaje.vacio2Valor ?? 0,
    tarifaRetencionFuente: plantilla?.tarifaRetencionFuente ?? TARIFA_RETENCION_FUENTE_DEFECTO,
    titularEsRegimenSimple: !!plantilla?.titularEsRegimenSimple,
    // Si al expedir se reporto FOPAT 0, el vehiculo no lo causa.
    // Sin el vehiculo en el catalogo (viaje del portal), manda lo que reporto el manifiesto.
    aplicaFopat: (vehiculo ? !!vehiculo.aplicaFopat : (viaje.retencionFopat ?? 0) > 0) && viaje.retencionFopat !== 0,
  };
}

/**
 * Tiempos logisticos del manifiesto, como los muestra el portal al cumplir:
 * pactados (de la plantilla de cada remesa) contra ejecutados (los que tiene
 * el RNDC en el cumplido de cada remesa: los del GPS o los reportados). El
 * ejecutado es salida menos entrada; asi lo calcula el portal (remesa 00006733:
 * entrada 19:10, salida 20:13 -> 1 h 3 min).
 *
 * Con el valor hora de SICETAC de la via se sugiere el adicional por las horas
 * de mas (o el descuento por las de menos): es el mismo valor con que SICETAC
 * suma las horas pactadas al piso.
 */
export async function tiemposLogisticos(viaje: Viaje) {
  const remesas = (await viajeRemesas.findByViaje(viaje.id)).filter((r) => r.estado !== "ANULADA");
  const credenciales = { usuario: config.rndc.usuario, password: config.rndc.password, nitEmpresa: config.rndc.empresaNit };
  const lector = new RndcClient({
    wsdlUrl: config.rndc.wsdlUrl,
    usuario: config.rndc.usuario,
    password: config.rndc.password,
    simular: false,
    reintentos: config.rndc.reintentos,
    soloConsultas: true,
  });
  const minutos = (a: Date | null | undefined, b: Date | null | undefined) =>
    a && b ? Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000)) : null;

  const filas: Array<{
    consecutivo: string | null;
    fuente: "RNDC" | "sistema" | null;
    tiempos: Awaited<ReturnType<typeof leerTiemposCumplidoRemesa>>;
    pactadoCargue: number | null;
    pactadoDescargue: number | null;
    ejecutadoCargue: number | null;
    ejecutadoDescargue: number | null;
    /** Desde la llegada (espera + cargue/descargue): con estos calcula el RNDC el piso del cumplido. */
    conEsperaCargue: number | null;
    conEsperaDescargue: number | null;
  }> = [];
  for (const r of remesas) {
    const p = await plantillas.findById(r.plantillaId);
    let t: Awaited<ReturnType<typeof leerTiemposCumplidoRemesa>> = null;
    let fuente: "RNDC" | "sistema" | null = null;
    if (!config.rndc.simular && r.consecutivoRemesa) {
      try {
        t = await leerTiemposCumplidoRemesa(lector, credenciales, r.consecutivoRemesa);
        if (t) fuente = "RNDC";
      } catch (exc) {
        console.warn(`No se pudieron leer los tiempos de la remesa ${r.consecutivoRemesa}:`, (exc as Error).message);
      }
    }
    // Sin respuesta del RNDC, los que se reportaron desde este sistema.
    if (!t && r.entradaCargue) {
      t = {
        llegadaCargue: r.llegadaCargue, entradaCargue: r.entradaCargue, salidaCargue: r.salidaCargue,
        llegadaDescargue: r.llegadaDescargue, entradaDescargue: r.entradaDescargue, salidaDescargue: r.salidaDescargue,
      };
      fuente = "sistema";
    }
    filas.push({
      consecutivo: r.consecutivoRemesa,
      fuente,
      tiempos: t,
      pactadoCargue: p ? p.horasPactoCargue * 60 + p.minutosPactoCargue : null,
      pactadoDescargue: p ? p.horasPactoDescargue * 60 + p.minutosPactoDescargue : null,
      ejecutadoCargue: minutos(t?.entradaCargue, t?.salidaCargue),
      ejecutadoDescargue: minutos(t?.entradaDescargue, t?.salidaDescargue),
      conEsperaCargue: minutos(t?.llegadaCargue ?? t?.entradaCargue, t?.salidaCargue),
      conEsperaDescargue: minutos(t?.llegadaDescargue ?? t?.entradaDescargue, t?.salidaDescargue),
    });
  }
  const suma = (
    k: "pactadoCargue" | "pactadoDescargue" | "ejecutadoCargue" | "ejecutadoDescargue" | "conEsperaCargue" | "conEsperaDescargue"
  ) =>
    filas.every((f) => f[k] !== null) ? filas.reduce((t, f) => t + (f[k] ?? 0), 0) : null;

  // Valor hora de SICETAC de la via del viaje.
  let valorHora: number | null = null;
  let errorSicetac: string | null = null;
  let vivo: Awaited<ReturnType<typeof pisoSicetacEnVivo>> = null;
  const [principal, vehiculo] = await Promise.all([plantillas.findById(viaje.plantillaId), vehiculos.findById(viaje.vehiculoId)]);
  const ultima = remesas.length ? await plantillas.findById(remesas[remesas.length - 1].plantillaId) : null;
  const origen = aCabeceraMunicipal(principal?.municipioOrigen);
  const destino = aCabeceraMunicipal(ultima?.municipioDestino ?? principal?.municipioDestino);
  // Las mismas horas con que se verifica el piso al despachar: las de la plantilla principal.
  const horasPactadas = principal
    ? horasPactadasTotales([
        { horas: principal.horasPactoCargue, minutos: principal.minutosPactoCargue },
        { horas: principal.horasPactoDescargue, minutos: principal.minutosPactoDescargue },
      ])
    : 0;
  if (!config.rndc.simular && origen && destino && vehiculo?.configuracion) {
    try {
      vivo = await pisoSicetacEnVivo(
        new RndcClient({ wsdlUrl: config.rndc.consultasWsdlUrl, usuario: config.rndc.usuario, password: config.rndc.password, simular: false, reintentos: config.rndc.reintentos, soloConsultas: true }),
        credenciales,
        { configuracion: vehiculo.configuracion, origen, destino, codVia: viaje.codVia, horasPactadas,
          unidadTransporte: config.sicetac.unidadTransporte, tipoCarga: config.sicetac.tipoCarga },
        config.sicetac.mesesHaciaAtras
      );
      valorHora = vivo?.valorHora ?? null;
      if (!vivo) errorSicetac = "La via no aparece en SICETAC para esta ruta y configuracion.";
    } catch (exc) {
      // RNDC13 en SICETAC: el RNDC esta limitando las consultas (ver CACHE_SICETAC).
      errorSicetac = /RNDC13/.test((exc as Error).message)
        ? "el RNDC esta limitando las consultas a SICETAC (RNDC13). Espera unos minutos y consulta de nuevo"
        : (exc as Error).message.slice(0, 160);
    }
  }

  const pactadoCargue = suma("pactadoCargue");
  const pactadoDescargue = suma("pactadoDescargue");
  const ejecutadoCargue = suma("ejecutadoCargue");
  const ejecutadoDescargue = suma("ejecutadoDescargue");
  const conEsperaCargue = suma("conEsperaCargue");
  const conEsperaDescargue = suma("conEsperaDescargue");
  // Piso del cumplido (CMA045): movilizacion + valor hora x horas desde la
  // LLEGADA hasta la salida, cargue + descargue (la espera cuenta, como dice
  // el portal: "Incluye Espera + Cargue"). Verificado en produccion con
  // 00006775 (2026-10-06): movilizacion $3.647.929, valor hora $92.958,
  // llegada->salida 8 h 13 + 2 h = 10,22 h -> piso $4.597.650. Con valor a
  // pagar $4.551.761 (horas de entrada a salida) dio CMA045; con $4.597.761
  // paso. Sin tiempos, el piso de despacho (horas pactadas).
  const horasEjecutadas =
    conEsperaCargue !== null && conEsperaDescargue !== null ? (conEsperaCargue + conEsperaDescargue) / 60 : null;
  const piso = vivo
    ? {
        // Misma formula que el piso de despacho, con otras horas (ver sicetac.test.ts).
        valor: calcularPisoSicetac(vivo, horasEjecutadas ?? horasPactadas) ?? vivo.piso,
        conHorasEjecutadas: horasEjecutadas !== null,
        horas: horasEjecutadas ?? horasPactadas,
        valorDespacho: vivo.piso,
        horasPactadas,
        valorMoviliza: vivo.valorMoviliza,
        codVia: vivo.codVia,
        via: vivo.descripcion,
        periodo: vivo.periodo,
        guardadoEn: vivo.guardadoEn ?? null,
      }
    : null;
  // Diferencia en horas (positiva = horas de mas) por el valor hora.
  const valorPor = (ejec: number | null, pact: number | null) =>
    ejec === null || pact === null || valorHora === null ? null : Math.round(((ejec - pact) / 60) * valorHora);
  return {
    remesas: filas,
    pactadoCargue,
    pactadoDescargue,
    ejecutadoCargue,
    ejecutadoDescargue,
    valorHora,
    errorSicetac,
    /**
     * Piso SICETAC del cumplido: el valor a pagar debe ser igual o mayor
     * [Guia Cumplido 3.4 y 3.9; CMA045], salvo flota propia (valor 0).
     */
    piso,
    conEsperaCargue,
    conEsperaDescargue,
    // El adicional sugerido usa las mismas horas que el piso del RNDC.
    diferenciaValorCargue: valorPor(conEsperaCargue ?? ejecutadoCargue, pactadoCargue),
    diferenciaValorDescargue: valorPor(conEsperaDescargue ?? ejecutadoDescargue, pactadoDescargue),
  };
}

/**
 * Trae del RNDC los cumplidos hechos por fuera de este sistema (en el portal):
 * remesas que aqui siguen CREADA pero en el RNDC ya estan cumplidas, y el
 * cumplido del manifiesto. Sin esto el viaje quedaba trabado: el sistema pedia
 * cumplir remesas que el RNDC ya tenia (y rechazaba el reenvio). Solo lectura
 * (tipo 3). Devuelve lo que adopto, para mostrarlo.
 */
async function sincronizarCumplidos(viajeId: number): Promise<string[]> {
  if (config.rndc.simular) return [];
  const viaje = await viajes.findById(viajeId);
  if (!viaje || viaje.estado !== "CONFIRMADO" || !viaje.consecutivoManifiesto) return [];
  const lector = new RndcClient({
    wsdlUrl: config.rndc.wsdlUrl,
    usuario: config.rndc.usuario,
    password: config.rndc.password,
    simular: false,
    reintentos: config.rndc.reintentos,
    soloConsultas: true,
  });
  const cred = { usuario: config.rndc.usuario, password: config.rndc.password, nitEmpresa: config.rndc.empresaNit };
  const adoptados: string[] = [];

  for (const r of await viajeRemesas.findByViaje(viajeId)) {
    if (r.estado !== "CREADA" || !r.consecutivoRemesa) continue;
    const t = await leerTiemposCumplidoRemesa(lector, cred, r.consecutivoRemesa);
    if (!t?.radicado) continue;
    // Se vuelve a exigir CREADA: si justo se estaba cumpliendo desde aqui, gana ese envio.
    if (!(await viajeRemesas.tomarConEstado(r.id, ["CREADA"], "CUMPLIDA"))) continue;
    const nota = `Remesa ${r.consecutivoRemesa}: ya estaba cumplida en el RNDC (radicado ${t.radicado}).`;
    await viajeRemesas.update(r.id, {
      radicadoCumplido: t.radicado,
      cantidadEntregada: t.cantidadEntregada ?? null,
      llegadaCargue: t.llegadaCargue,
      entradaCargue: t.entradaCargue,
      salidaCargue: t.salidaCargue,
      llegadaDescargue: t.llegadaDescargue,
      entradaDescargue: t.entradaDescargue,
      salidaDescargue: t.salidaDescargue,
      fechaCumplido: new Date(),
      mensajeError: `Ya estaba cumplida en el RNDC (radicado ${t.radicado}).`,
    });
    adoptados.push(nota);
  }

  const m = await leerCumplidoManifiesto(lector, cred, viaje.consecutivoManifiesto);
  if (m && (await viajes.tomarConEstado(viajeId, ["CONFIRMADO"], "CUMPLIDO"))) {
    const nota = `Ya estaba cumplido en el RNDC (radicado ${m.radicado}).`;
    await viajes.update(viajeId, {
      radicadoCumplido: m.radicado,
      // El FOPAT que se declara es el del cumplido [Manual RNDC 5.3.5].
      ...(m.retencionFopat !== null ? { retencionFopat: m.retencionFopat } : {}),
      fechaCumplido: new Date(),
      mensajeError: null,
      codigoError: null,
      errorCrudo: null,
      avisos: nota,
    });
    adoptados.push(`Manifiesto ${viaje.consecutivoManifiesto}: ya estaba cumplido en el RNDC (radicado ${m.radicado}).`);
  }
  return adoptados;
}

/**
 * POST /api/despacho/:id/cumplir/sincronizar: adopta lo cumplido en el portal
 * (sincronizarCumplidos) y devuelve lo adoptado, el viaje y sus remesas. Si el
 * RNDC no responde, devuelve el error sin fallar: la ventana sigue con lo local.
 */
despachoRouter.post("/:id/cumplir/sincronizar", async (req, res) => {
  const viajeId = Number(req.params.id);
  try {
    const adoptados = await sincronizarCumplidos(viajeId);
    res.json({ adoptados, viaje: await viajes.findById(viajeId), remesas: await viajeRemesas.findByViaje(viajeId) });
  } catch (exc) {
    // Si el RNDC no responde, la ventana sigue funcionando con lo que hay aqui.
    res.json({ adoptados: [], error: `No se pudo consultar el RNDC: ${(exc as Error).message}` });
  }
});

/**
 * GET /api/despacho/:id/cumplir/previa: datos para el formulario del cumplido
 * del manifiesto: flete, anticipo, vacios, retencion y FOPAT calculados,
 * tiempos logisticos con el piso SICETAC del cumplido, y los motivos
 * permitidos de adicional y descuento.
 */
despachoRouter.get("/:id/cumplir/previa", async (req, res) => {
  const viaje = await viajes.findById(Number(req.params.id));
  if (!viaje) return res.status(404).json({ error: "Viaje no encontrado" });
  const base = await baseCumplidoManifiesto(viaje);
  res.json({
    ...base,
    tiempos: await tiemposLogisticos(viaje),
    retencionFuente: calcularRetencionFuente(
      baseRetenciones(base.valorFlete, base.vacio1Valor, base.vacio2Valor),
      base.tarifaRetencionFuente,
      base.titularEsRegimenSimple
    ),
    retencionFopat: calcularFopat(base.valorFlete, base.aplicaFopat),
    motivosDescuento: MOTIVOS_DESCUENTO_MANIFIESTO,
    motivosAdicional: MOTIVOS_VALOR_ADICIONAL,
  });
});

/**
 * POST /api/despacho/:id/cumplir: cumple el manifiesto en el RNDC (proceso 6).
 *
 * Como funciona:
 * 1. Solo viajes CONFIRMADO. Antes de enviar adopta lo cumplido en el portal;
 *    si el manifiesto ya estaba cumplido, no lo reenvia.
 * 2. No bloquea por remesas pendientes: el RNDC exige todas cumplidas y lo
 *    dira con su error si falta alguna.
 * 3. Calcula el valor final (flete + adicionales - descuento) y, si no se
 *    escribieron a mano, la retencion en la fuente y el FOPAT sobre ese valor.
 * 4. Toma el viaje (estado CUMPLIENDO) para evitar dos envios a la vez.
 * 5. Envia fecha de entrega, via, valores y retenciones. Con radicado (o
 *    DUPLICADO) queda CUMPLIDO; con rechazo vuelve a CONFIRMADO con el error.
 */
despachoRouter.post("/:id/cumplir", async (req, res) => {
  const viajeId = Number(req.params.id);
  const viaje = await viajes.findById(viajeId);
  if (!viaje) return res.status(404).json({ error: "Viaje no encontrado" });
  if (viaje.estado === "CUMPLIDO") {
    return res.status(409).json({ error: "Este manifiesto ya esta cumplido." });
  }
  if (viaje.estado !== "CONFIRMADO") {
    return res.status(409).json({ error: `Un viaje en estado ${viaje.estado} no se puede cumplir.` });
  }

  // Lo cumplido en el portal se adopta antes de enviar. Si el manifiesto ya
  // estaba cumplido alla, no se reenvia.
  await sincronizarCumplidos(viajeId).catch((exc) =>
    console.warn(`No se pudo sincronizar el cumplido del viaje ${viajeId}:`, (exc as Error).message)
  );
  const sincronizado = await viajes.findById(viajeId);
  const remesas = (await viajeRemesas.findByViaje(viajeId)).filter((r) => r.estado !== "ANULADA");
  if (sincronizado?.estado === "CUMPLIDO") return res.json({ ...sincronizado, remesas });
  // Remesas aun pendientes: no se bloquea. El RNDC exige todas cumplidas
  // [Guia Cumplido 3.9] y lo dira con su error si falta alguna.

  // Valores del cumplido. Retencion y FOPAT se calculan sobre el valor final
  // (con adicionales y descuento); si se escribieron a mano, mandan esos.
  const b = req.body ?? {};
  const n = (v: unknown) => (v === undefined || v === null || v === "" ? 0 : Number(v));
  const base = await baseCumplidoManifiesto(viaje);
  const valores = {
    valorAdicionalHorasCargue: n(b.valorAdicionalHorasCargue),
    valorAdicionalHorasDescargue: n(b.valorAdicionalHorasDescargue),
    valorAdicionalFlete: n(b.valorAdicionalFlete),
    valorDescuentoFlete: n(b.valorDescuentoFlete),
  };
  const valorFinal = valorFinalCumplido({ valorFlete: base.valorFlete, ...valores });
  const retencionFuente =
    b.retencionFuente !== undefined && b.retencionFuente !== null && b.retencionFuente !== ""
      ? Number(b.retencionFuente)
      : calcularRetencionFuente(
          baseRetenciones(valorFinal, base.vacio1Valor, base.vacio2Valor),
          base.tarifaRetencionFuente,
          base.titularEsRegimenSimple
        );
  const retencionFopat =
    b.retencionFopat !== undefined && b.retencionFopat !== null && b.retencionFopat !== ""
      ? Number(b.retencionFopat)
      : calcularFopat(valorFinal, base.aplicaFopat);
  const fechaEntrega = b.fechaEntregaDocumentos ? fechaHoraColombia(b.fechaEntregaDocumentos) : new Date();

  if (!(await viajes.tomarConEstado(viajeId, ["CONFIRMADO"], "CUMPLIENDO"))) {
    return res.status(409).json({ error: "El manifiesto ya se esta cumpliendo. Espera el resultado." });
  }

  try {
    const { credenciales, cliente } = clienteRegistro();
    const resultado = await cliente.enviar(
      construirXmlMensaje(
        credenciales,
        PROCESO_ID_CUMPLIR_MANIFIESTO,
        construirDatosCumplidoManifiesto({
          numManifiesto: viaje.consecutivoManifiesto!,
          fechaEntregaDocumentos: fechaEntrega,
          codVia: viaje.codVia,
          retencionFuente,
          retencionFopat,
          ...valores,
          motivoValorAdicional: b.motivoValorAdicional ?? null,
          motivoDescuento: b.motivoDescuento ?? null,
          valorSobreanticipo: n(b.valorSobreanticipo),
          observaciones: b.observaciones ?? null,
        })
      ),
      PROCESO_ID_CUMPLIR_MANIFIESTO
    );
    const radicado = resultado.ok ? resultado.radicado : radicadoDeDuplicado(resultado.errorCrudo);

    if (!radicado) {
      const actualizado = await viajes.update(viajeId, {
        estado: "CONFIRMADO",
        mensajeError: `Cumplido del manifiesto: ${resultado.error ?? "el RNDC lo rechazo."}`,
        codigoError: resultado.codigoError,
        errorCrudo: resultado.errorCrudo,
      });
      return res.status(422).json({ ...actualizado, remesas });
    }

    const final = await viajes.update(viajeId, {
      estado: "CUMPLIDO",
      radicadoCumplido: radicado,
      // El FOPAT se causa con el cumplido [Manual RNDC 5.3.5]: el que se declara
      // a la DIAN es este, no el de la expedicion.
      ...(resultado.ok ? { retencionFopat: retencionFopat ?? 0 } : {}),
      fechaCumplido: new Date(),
      cumplidoPorId: req.usuario?.id ?? null,
      mensajeError: null,
      codigoError: null,
      errorCrudo: null,
      avisos: resultado.ok ? viaje.avisos : `Ya estaba cumplido en el RNDC (radicado ${radicado}).`,
    });
    res.json({ ...final, remesas });
  } catch (exc) {
    await viajes.update(viajeId, { estado: "CONFIRMADO", mensajeError: (exc as Error).message });
    throw exc;
  }
});

/**
 * PDF del manifiesto, tal como lo genera el Ministerio.
 *
 * Se pide al RNDC en vez de componerlo aqui: el formato es el oficial y trae el
 * codigo QR de seguridad que las autoridades verifican en via.
 */
despachoRouter.get("/:id/manifiesto.pdf", async (req, res) => {
  const viaje = await viajes.findById(Number(req.params.id));
  if (!viaje) {
    return res.status(404).json({ error: "Viaje no encontrado" });
  }
  if (!viaje.numeroManifiestoRndc) {
    return res.status(409).json({
      error:
        "Este viaje todavia no tiene manifiesto radicado en el RNDC, asi que no hay PDF que imprimir.",
    });
  }

  try {
    const { pdf, nombreArchivo } = await descargarPdfManifiesto(
      {
        urlBase: config.rndc.restUrl,
        usuario: config.rndc.usuario,
        password: config.rndc.password,
        simular: config.rndc.simular,
      },
      viaje.numeroManifiestoRndc,
      viaje.consecutivoManifiesto ?? undefined
    );

    // Logo de la empresa sobre el PDF oficial, sin tocar el QR (ver
    // estampado.ts). ?original=1 entrega el PDF tal cual lo dio el RNDC. Si el
    // estampado falla, se entrega el original: imprimir nunca se bloquea.
    let salida = pdf;
    if (req.query.original !== "1") {
      try {
        salida = await estamparLogo(pdf, "manifiesto");
      } catch (exc) {
        console.warn(`No se pudo estampar el logo en el manifiesto ${viaje.id}: ${(exc as Error).message}`);
      }
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${nombreArchivo}"`);
    res.send(salida);
  } catch (exc) {
    res.status(502).json({ error: (exc as Error).message });
  }
});

/**
 * Impresion de una remesa.
 *
 * Primero se intenta el PDF oficial del RNDC. Ese proceso NO esta documentado
 * para remesa (la guia solo describe el del manifiesto), asi que si el
 * Ministerio no lo entrega se cae a la representacion propia, que el Manual de
 * Operacion General autoriza expresamente.
 *
 * Con ?propia=1 se salta el intento y se va directo a la nuestra.
 */
despachoRouter.get("/remesas/:remesaId/imprimir", async (req, res) => {
  const remesaId = Number(req.params.remesaId);
  const remesa = await viajeRemesas.findById(remesaId);
  if (!remesa) {
    return res.status(404).json({ error: "Remesa no encontrada" });
  }
  if (!remesa.numeroRemesaRndc) {
    return res.status(409).json({
      error: "Esta remesa todavia no esta radicada en el RNDC, asi que no hay soporte que imprimir.",
    });
  }

  // El RNDC no entrega el PDF de la remesa por webservice: con tipo 21 y
  // procesoid 3 responde "RNDC12: El procesoid 3 no es correcto para generar
  // el PDF" (verificado 2026-09-26). Por eso se genera aqui, con los datos
  // radicados, como lo autoriza el Manual de Operacion del RNDC.
  const viaje = await viajes.findById(remesa.viajeId);
  const plantilla = await plantillas.findById(remesa.plantillaId);
  if (!viaje || !plantilla) {
    return res.status(404).json({ error: "No se encontraron los datos del viaje o la plantilla" });
  }
  const [vehiculo, conductor] = await Promise.all([
    vehiculos.findById(viaje.vehiculoId),
    conductores.findById(viaje.conductorId),
  ]);

  const html = construirHtmlRemesa({
    remesa,
    plantilla,
    viaje,
    vehiculo,
    conductor,
    empresa: {
      nombre: config.empresa.nombre,
      nit: config.rndc.empresaNit,
      direccion: config.empresa.direccion,
      telefono: config.empresa.telefono,
      municipio: config.empresa.municipio,
    },
    // La poliza de carga es una sola, de la empresa (pestana Empresa).
    poliza: await parametros.obtener(),
    logoDataUri: logoComoDataUri(),
  });

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

/** Remesas de un viaje, con su consecutivo y radicado. */
despachoRouter.get("/:id/remesas", async (req, res) => {
  res.json(await viajeRemesas.findByViaje(Number(req.params.id)));
});

/**
 * Remolque y conductor sugeridos para un vehiculo: el que mas ha usado en sus
 * ultimos viajes; si no tiene historial, el habitual del catalogo
 * (placaRemolque y cedulaConductorHabitual). Solo sugiere: el despachador
 * puede cambiarlos.
 */
despachoRouter.get("/sugerencias/:vehiculoId", async (req, res) => {
  const vehiculo = await vehiculos.findById(Number(req.params.vehiculoId));
  if (!vehiculo) return res.status(404).json({ error: "Vehiculo no encontrado" });

  const hist = await viajes.habitualesDeVehiculo(vehiculo.id);
  const [listaRemolques, listaConductores] = await Promise.all([
    remolques.findMany(),
    conductores.findMany(),
  ]);

  let remolque: { id: number; origen: string } | null = null;
  const rHist = hist.remolque && listaRemolques.find((r) => r.id === hist.remolque!.id && r.activo);
  if (rHist) {
    remolque = { id: rHist.id, origen: `usado en ${hist.remolque!.veces} de sus ultimos ${hist.viajes} viajes` };
  } else if (vehiculo.placaRemolque) {
    const r = listaRemolques.find((x) => x.placa === vehiculo.placaRemolque && x.activo);
    if (r) remolque = { id: r.id, origen: "remolque habitual del catalogo" };
  }

  let conductor: { id: number; origen: string } | null = null;
  const cHist = hist.conductor && listaConductores.find((c) => c.id === hist.conductor!.id && c.activo);
  if (cHist) {
    conductor = { id: cHist.id, origen: `manejo ${hist.conductor!.veces} de sus ultimos ${hist.viajes} viajes` };
  } else if (vehiculo.cedulaConductorHabitual) {
    const c = listaConductores.find((x) => x.cedula === vehiculo.cedulaConductorHabitual && x.activo);
    if (c) conductor = { id: c.id, origen: "conductor habitual del catalogo" };
  }

  res.json({ remolque, conductor });
});

/**
 * Siguiente numero disponible, para precargar el campo del despacho.
 * Se puede cambiar: lo devuelto es una sugerencia, no una reserva.
 */
despachoRouter.get("/siguiente-consecutivo", async (_req, res) => {
  // Nunca por debajo del ultimo numero usado en el portal (RNDC_ULTIMO_CONSECUTIVO).
  const base = siguienteBase(
    mayorConsecutivo(await viajes.ultimoConsecutivo(), config.consecutivos.ultimoExterno),
    config.consecutivos.longitud,
    config.consecutivos.prefijo
  );
  res.json({ base });
});

/** Libro de consecutivos: una fila por remesa (la hoja de control de la empresa). */
despachoRouter.get("/consecutivos", async (_req, res) => {
  res.json(await consecutivos.listar());
});

/**
 * Todo lo que se registro al despachar un viaje, para leerlo en una sola
 * ventana: documentos y radicados, vehiculo y conductores, cada remesa con sus
 * partes y su mercancia, valores, tiempos pactados, y quien hizo que.
 */
despachoRouter.get("/:id/detalle", async (req, res) => {
  const viaje = await viajes.findById(Number(req.params.id));
  if (!viaje) return res.status(404).json({ error: "Viaje no encontrado" });
  const filas = await viajeRemesas.findByViaje(viaje.id);
  const [vehiculo, conductor, conductor2, remolque, monitoreo, principal] = await Promise.all([
    vehiculos.findById(viaje.vehiculoId),
    conductores.findById(viaje.conductorId),
    viaje.conductor2Id ? conductores.findById(viaje.conductor2Id) : Promise.resolve(null),
    viaje.remolqueId ? remolques.findById(viaje.remolqueId) : Promise.resolve(null),
    viaje.nitMonitoreoFlota ? empresasMonitoreo.findByNit(viaje.nitMonitoreoFlota) : Promise.resolve(null),
    plantillas.findById(viaje.plantillaId),
  ]);
  const tercero = (t: { nombre: string; nit: string; codTipoId: string; codSede: string; ciudad: string | null; codMunicipioRndc?: string | null; direccion?: string | null } | null | undefined) =>
    t ? { nombre: t.nombre, nit: t.nit, tipoId: t.codTipoId, sede: t.codSede, ciudad: t.ciudad, codMunicipio: t.codMunicipioRndc ?? null, direccion: t.direccion ?? null } : null;
  // Remesas del portal (sin plantilla): las partes se buscan por NIT y sede.
  const catalogoTerceros = filas.some((r) => !r.plantillaId) ? await terceros.findMany() : [];
  const porNit = (nit: string | null | undefined, sede: string | null | undefined, tipoId: string | null | undefined) => {
    if (!nit) return null;
    const t = catalogoTerceros.find((x) => x.nit === nit && x.codSede === sede) ?? catalogoTerceros.find((x) => x.nit === nit);
    return t ? tercero(t) : { nombre: "(no esta en el catalogo)", nit, tipoId: tipoId ?? "", sede: sede ?? "", ciudad: null, codMunicipio: null, direccion: null };
  };
  const remesas = [];
  for (const r of filas) {
    const p = await plantillas.findById(r.plantillaId);
    remesas.push({
      ...r,
      plantilla: p?.nombre ?? (r.plantillaId ? null : "Expedida en el portal del RNDC"),
      producto: p?.tipoMercancia ?? r.producto ?? null,
      codMercancia: p?.codMercancia ?? r.codMercancia ?? null,
      codTipoEmpaque: p?.codTipoEmpaque ?? null,
      unidadMedidaProducto: p?.unidadMedidaProducto ?? null,
      pactoCargue: p ? `${p.horasPactoCargue} h ${p.minutosPactoCargue} min` : null,
      pactoDescargue: p ? `${p.horasPactoDescargue} h ${p.minutosPactoDescargue} min` : null,
      contratante: p ? tercero(p.contratante) : porNit(r.propietarioNit, r.propietarioSede, r.propietarioTipoId),
      remitente: p ? tercero(p.remitente) : porNit(r.remitenteNit, r.remitenteSede, r.remitenteTipoId),
      destinatario: p ? tercero(p.destinatario) : porNit(r.destinatarioNit, r.destinatarioSede, r.destinatarioTipoId),
    });
  }
  res.json({
    viaje,
    tipoManifiesto: principal?.tipoManifiesto ?? null,
    origen: principal?.municipioOrigen ?? viaje.origenRndc ?? null,
    destino: remesas.length
      ? (await plantillas.findById(filas[filas.length - 1].plantillaId))?.municipioDestino ?? viaje.destinoRndc ?? null
      : viaje.destinoRndc ?? null,
    // En los viajes del portal el vehiculo, el remolque o el conductor pueden no
    // estar en el catalogo: se muestra lo que reporto el RNDC.
    vehiculo: vehiculo
      ? {
          placa: vehiculo.placa, marca: vehiculo.marca, configuracion: vehiculo.configuracion,
          titular: vehiculo.nombreTenedor, titularId: vehiculo.numIdTenedor, titularTipoId: vehiculo.codTipoIdTenedor,
        }
      : viaje.placaRndc
        ? { placa: viaje.placaRndc, marca: null, configuracion: null, titular: null, titularId: null, titularTipoId: null }
        : null,
    remolque: remolque ? { placa: remolque.placa } : viaje.remolqueRndc ? { placa: viaje.remolqueRndc } : null,
    conductor: conductor
      ? { nombre: conductor.nombre, cedula: conductor.cedula, licencia: conductor.licencia }
      : viaje.conductorRndc
        ? { nombre: "(no esta en el catalogo)", cedula: viaje.conductorRndc, licencia: null }
        : null,
    conductor2: conductor2 && { nombre: conductor2.nombre, cedula: conductor2.cedula },
    monitoreo: monitoreo ? { nombre: monitoreo.nombre, nit: monitoreo.nit } : viaje.nitMonitoreoFlota ? { nombre: null, nit: viaje.nitMonitoreoFlota } : null,
    remesas,
  });
});

/** GET /api/despacho/sincronizacion: estado de la sincronizacion automatica con el RNDC. */
despachoRouter.get("/sincronizacion", async (_req, res) => {
  res.json(await estadoSincronizacion());
});

/**
 * POST /api/despacho/sincronizacion: sincroniza ya con el RNDC (los ultimos
 * dias, o todo desde septiembre con { completa: true }) y devuelve lo que cambio.
 */
despachoRouter.post("/sincronizacion", async (req, res) => {
  try {
    const resumen = await sincronizarConRndc({ completa: !!req.body?.completa });
    res.json({ resumen, estado: await estadoSincronizacion() });
  } catch (exc) {
    res.status(502).json({ error: `No se pudo sincronizar con el RNDC: ${(exc as Error).message}` });
  }
});

/**
 * GET /api/despacho/historial: todos los viajes (la tabla pagina de a 50 en
 * el navegador). A los manifiestos vigentes sin cumplir cuya cita de descargue
 * ya paso les agrega el plazo del cumplido (5 dias habiles).
 */
despachoRouter.get("/historial", async (_req, res) => {
  const ahora = new Date();
  // Todos: la tabla de Viajes pagina de a 50 en el navegador.
  const lista = await viajes.findMany(5000);
  // Plazo del cumplido: solo para manifiestos vigentes sin cumplir cuya
  // entrega (cita de descargue) ya paso; antes de eso el plazo no corre.
  res.json(
    lista.map((v) =>
      v.estado === "CONFIRMADO" && v.fechaHoraDescargue && new Date(v.fechaHoraDescargue) <= ahora
        ? { ...v, plazoCumplido: plazoCumplido(new Date(v.fechaHoraDescargue), ahora) }
        : v
    )
  );
});

/**
 * FOPAT causado por mes, con lo que falta pagar a la DIAN.
 *
 * El RNDC verifica que la empresa este al dia con el FOPAT del tercer mes
 * anterior antes de dejar expedir manifiestos nuevos, asi que conviene tener
 * el corte a la mano y no descubrirlo el dia que se bloquee el despacho.
 */
despachoRouter.get("/fopat", async (_req, res) => {
  res.json(await viajes.resumenFopat());
});

/** Marca un lote de manifiestos como incluidos en un pago de FOPAT. */
despachoRouter.post("/fopat/pagar", async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
  if (ids.length === 0) {
    return res.status(422).json({ error: "Indica los viajes incluidos en el pago" });
  }
  const fecha = req.body?.fechaPago ? new Date(req.body.fechaPago) : new Date();
  const actualizados = await viajes.marcarFopatPagado(ids, fecha);
  res.json({ actualizados });
});

/** Detalle de un viaje con sus remesas. */
despachoRouter.get("/:id", async (req, res) => {
  const viaje = await viajes.findById(Number(req.params.id));
  if (!viaje) return res.status(404).json({ error: "Viaje no encontrado" });
  res.json({ ...viaje, remesas: await viajeRemesas.findByViaje(viaje.id) });
});
