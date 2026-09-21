import { Router } from "express";
import {
  vehiculos,
  conductores,
  plantillas,
  viajes,
  viajeRemesas,
  remolques,
  Vehiculo,
  Conductor,
  PlantillaViajeConRelaciones,
  ViajeRemesa,
  NuevaViajeRemesa,
  vias,
} from "../repo";
import { config } from "../config";
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
  MAX_REMESAS_POR_MANIFIESTO,
  DatosViajeParaRndc,
  DatosRemesaParaRndc,
  ProblemaValidacion,
  TerceroRndc,
  TipoManifiesto,
  TipoOperacionRemesa,
  UnidadMedidaProducto,
} from "../rndc/builders";
import { RndcClient, RndcError } from "../rndc/client";
import { descargarPdfManifiesto, descargarPdfRemesa } from "../rndc/pdf";
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
 * Verifica el flete contra el piso de SICETAC de la via elegida.
 *
 * Se hace tambien en el servidor y no solo en pantalla: el aviso del navegador
 * se puede ignorar, y un manifiesto por debajo del piso lo rechaza el RNDC.
 *
 * Usa el valor guardado al consultar SICETAC. Si no hay via elegida o no se
 * conoce su piso, no se afirma nada: es peor bloquear un despacho por un dato
 * que no tenemos que dejarlo pasar al RNDC, que si tiene la verdad.
 */
async function validarPisoSicetac(
  codVia: string | null,
  origen: string | null,
  destino: string | null,
  valorFlete: number
): Promise<string | null> {
  if (!codVia || !origen || !destino) return null;

  const disponibles = await vias.findByRuta(origen, destino);
  const via = disponibles.find((v) => v.codVia === codVia);
  if (!via?.valorSicetac) return null;

  if (valorFlete < via.valorSicetac) {
    return (
      `El flete (${valorFlete}) esta por debajo del minimo de SICETAC para la via elegida ` +
      `(${via.valorSicetac}). El RNDC no permite expedir manifiestos por debajo de los costos ` +
      `eficientes de operacion.`
    );
  }
  return null;
}

function mensajesDe(problemas: ProblemaValidacion[], gravedad: "ERROR" | "AVISO"): string[] {
  return problemas.filter((p) => p.gravedad === gravedad).map((p) => p.mensaje);
}

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

  if (!b.remolqueId) {
    return res.status(422).json({ error: "Debes indicar el remolque usado en este viaje" });
  }

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
    remolques.findById(Number(b.remolqueId)),
  ]);

  if (!plantillaPrincipal || !vehiculo || !conductor || !remolque) {
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
    fechaHoraCargue: new Date(r.fechaHoraCargue),
    fechaHoraDescargue: new Date(r.fechaHoraDescargue),
    ordenServicioGenerador: r.ordenServicioGenerador ?? null,
    valorFleteRemesa: r.valorFleteRemesa ? Number(r.valorFleteRemesa) : null,
  }));

  const primerCargue = nuevasRemesas.reduce(
    (min, r) => (r.fechaHoraCargue < min ? r.fechaHoraCargue : min),
    nuevasRemesas[0].fechaHoraCargue
  );

  const viaje = await viajes.create({
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
    valorFleteReal: b.valorFleteReal ? Number(b.valorFleteReal) : null,
    valorAnticipoManifiesto: b.valorAnticipoManifiesto ? Number(b.valorAnticipoManifiesto) : 0,
    // El despachador ve el FOPAT en pantalla y lo puede ajustar. Si no llega,
    // se calcula al armar el manifiesto.
    retencionFopat:
      b.retencionFopat !== undefined && b.retencionFopat !== null && b.retencionFopat !== ""
        ? Number(b.retencionFopat)
        : null,
    codVia: b.codVia || null,
    fechaPagoSaldo: b.fechaPagoSaldo ? new Date(b.fechaPagoSaldo) : null,
    conductor2Id: conductor2 ? conductor2.id : null,
    remolqueId: remolque.id,
    viajesDia: b.viajesDia ? Number(b.viajesDia) : null,
    ordenServicioGenerador: null,
    vacio1Origen: b.vacio1Origen ?? null,
    vacio1Destino: b.vacio1Destino ?? null,
    vacio1Valor: b.vacio1Valor ? Number(b.vacio1Valor) : 0,
    vacio2Origen: b.vacio2Origen ?? null,
    vacio2Destino: b.vacio2Destino ?? null,
    vacio2Valor: b.vacio2Valor ? Number(b.vacio2Valor) : 0,
  });

  const filasRemesa = await viajeRemesas.crearParaViaje(viaje.id, nuevasRemesas);
  const consecutivoManifiesto = viaje.consecutivoManifiesto!;

  const datosRemesas: DatosRemesaParaRndc[] = filasRemesa.map((fila) =>
    aDatosRemesa(fila, plantillasRemesa.get(fila.plantillaId)!)
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
    remolque: { placa: remolque.placa, capacidadKg: remolque.capacidadKg },
    conductor: { codTipoId: conductor.codTipoId, cedula: conductor.cedula },
    conductor2: conductor2
      ? { codTipoId: conductor2.codTipoId, cedula: conductor2.cedula }
      : null,
    manifiesto: {
      // Origen y destino se deducen de los sitios de cargue y descargue de las
      // remesas. Ya no hay una "ruta" configurada aparte que pueda quedar
      // desincronizada con los terceros.
      ruta: {
        codigoOrigenRndc: municipioOrigenDe(datosRemesas, vacio1),
        codigoDestinoRndc: municipioDestinoDe(datosRemesas, vacio2),
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
    nitMonitoreoFlota: config.rndc.nitMonitoreoFlota,
    vacio1,
    vacio2,
    viajesDia: viaje.viajesDia,
    retencionFopat: viaje.retencionFopat,
    nitEmpresaTransporte: config.rndc.empresaNit,
    manifiestosMismaPlacaFecha: await viajes.contarPorVehiculoYFecha(vehiculo.id, primerCargue),
  };

  // 1. Validaciones locales. Cada rechazo del RNDC cuesta tiempo en el despacho
  //    nocturno, y algunos consumen cupos de la empresa.
  const reglas = validarReglasRndc(datosViaje, consecutivoManifiesto);
  const erroresDocumentos = validarDocumentos(
    vehiculo,
    conductor,
    conductor2,
    ultimoDescargueDe(datosRemesas)
  );
  const avisoPiso = await validarPisoSicetac(
    viaje.codVia,
    datosViaje.manifiesto.ruta.codigoOrigenRndc,
    datosViaje.manifiesto.ruta.codigoDestinoRndc,
    datosViaje.valorFleteReal ?? 0
  );

  const errores = [
    ...mensajesDe(reglas, "ERROR"),
    ...erroresDocumentos,
    ...(avisoPiso ? [avisoPiso] : []),
  ];
  const avisos = mensajesDe(reglas, "AVISO");

  if (avisos.length > 0) {
    await viajes.update(viaje.id, { avisos: avisos.join(" | ") });
  }

  if (errores.length > 0) {
    const actualizado = await viajes.update(viaje.id, {
      estado: "VALIDACION_ERROR",
      mensajeError: errores.join(" | "),
    });
    return res.status(422).json({ ...actualizado, remesas: filasRemesa });
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
  // el RNDC: por eso cada fila guarda su propio estado, para saber cuales hay
  // que reusar al reintentar en vez de generar consecutivos nuevos.
  const creadas: string[] = [];

  for (const fila of filasRemesa) {
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
      const actualizado = await viajes.update(viaje.id, {
        estado: "REMESA_ERROR",
        mensajeError: resumenParcial(creadas, fila.consecutivoRemesa!, (exc as RndcError).message),
      });
      return res.status(502).json({ ...actualizado, remesas: await viajeRemesas.findByViaje(viaje.id) });
    }

    if (!resultado.ok) {
      await viajeRemesas.update(fila.id, {
        estado: "ERROR",
        mensajeError: resultado.errorCrudo,
      });
      const actualizado = await viajes.update(viaje.id, {
        estado: "REMESA_ERROR",
        mensajeError: resumenParcial(creadas, fila.consecutivoRemesa!, resultado.error ?? ""),
        codigoError: resultado.codigoError,
        errorCrudo: resultado.errorCrudo,
      });
      return res.status(422).json({ ...actualizado, remesas: await viajeRemesas.findByViaje(viaje.id) });
    }

    await viajeRemesas.update(fila.id, {
      estado: "CREADA",
      numeroRemesaRndc: resultado.radicado,
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
    const actualizado = await viajes.update(viaje.id, {
      estado: "MANIFIESTO_ERROR",
      mensajeError:
        `Las remesas ${creadas.join(", ")} quedaron creadas en el RNDC, pero fallo el ` +
        `manifiesto: ${(exc as RndcError).message}`,
    });
    return res.status(502).json({ ...actualizado, remesas: await viajeRemesas.findByViaje(viaje.id) });
  }

  if (!resultadoManifiesto.ok) {
    // Las remesas YA quedaron creadas en el RNDC. Al corregir y reintentar hay
    // que reusar esos mismos consecutivos, no generar unos nuevos.
    const actualizado = await viajes.update(viaje.id, {
      estado: "MANIFIESTO_ERROR",
      mensajeError:
        `Las remesas ${creadas.join(", ")} quedaron creadas en el RNDC, pero el manifiesto ` +
        `fue rechazado. ${resultadoManifiesto.error}`,
      codigoError: resultadoManifiesto.codigoError,
      errorCrudo: resultadoManifiesto.errorCrudo,
    });
    return res.status(422).json({ ...actualizado, remesas: await viajeRemesas.findByViaje(viaje.id) });
  }

  // Se persiste el FOPAT realmente enviado, incluso cuando se calculo solo:
  // es el numero que hay que declarar a la DIAN el mes siguiente.
  const fopatEnviado = fopatEfectivo(datosViaje, datosViaje.valorFleteReal ?? 0);

  const final = await viajes.update(viaje.id, {
    estado: "CONFIRMADO",
    retencionFopat: fopatEnviado,
    numeroManifiestoRndc: resultadoManifiesto.radicado,
    mec: resultadoManifiesto.mec,
    codigoSeguridadQr: resultadoManifiesto.qr,
  });

  res.status(201).json({
    ...final,
    remesas: await viajeRemesas.findByViaje(viaje.id),
    // Se devuelve el desglose del ICA para que el despachador pueda auditarlo
    // cuando el manifiesto agrupa municipios con factores distintos.
    ica: calcularIcaPonderado(datosRemesas),
  });
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
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${nombreArchivo}"`);
    res.send(pdf);
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

  const forzarPropia = req.query.propia === "1";
  let motivo: string | null = null;

  if (!forzarPropia) {
    try {
      const { pdf, nombreArchivo } = await descargarPdfRemesa(
        {
          urlBase: config.rndc.restUrl,
          usuario: config.rndc.usuario,
          password: config.rndc.password,
          simular: config.rndc.simular,
        },
        remesa.numeroRemesaRndc,
        remesa.consecutivoRemesa ?? undefined
      );
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${nombreArchivo}"`);
      return res.send(pdf);
    } catch (exc) {
      // No es un fallo: lo mas probable es que el RNDC simplemente no exponga
      // el PDF de remesa. Se deja constancia en el documento propio.
      motivo =
        "El RNDC no entrego un PDF oficial para esta remesa, por lo que se imprime la " +
        "representacion generada por la empresa.";
      console.warn(`PDF oficial de remesa ${remesaId} no disponible: ${(exc as Error).message}`);
    }
  }

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
    nombreEmpresa: config.empresa.nombre,
    nitEmpresa: config.rndc.empresaNit,
    motivoRepresentacionPropia: motivo,
  });

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

/** Remesas de un viaje, con su consecutivo y radicado. */
despachoRouter.get("/:id/remesas", async (req, res) => {
  res.json(await viajeRemesas.findByViaje(Number(req.params.id)));
});

despachoRouter.get("/historial", async (_req, res) => {
  res.json(await viajes.findMany(100));
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
