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
  Viaje,
  NuevaViajeRemesa,
  vias,
  empresasMonitoreo,
} from "../repo";
import { config } from "../config";
import {
  consecutivoRemesa,
  siguienteBase,
  validarBase,
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
import { aCabeceraMunicipal } from "../rndc/sicetac";
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

  // ---- Numeracion del viaje ----
  // Un solo numero base identifica todo: el manifiesto lo usa tal cual y las
  // remesas adicionales le agregan letra. Se puede editar en el despacho,
  // porque cuando se anula un documento hay que saltar o retomar numeros.
  const usados = await viajes.consecutivosUsados();
  const base = b.consecutivoBase
    ? String(b.consecutivoBase).trim()
    : siguienteBase(await viajes.ultimoConsecutivo(), config.consecutivos.longitud, config.consecutivos.prefijo);

  const problemasNumero = validarBase(base, nuevasRemesas.length, usados);
  if (problemasNumero.length > 0) {
    return res.status(422).json({ error: problemasNumero.map((p) => p.mensaje).join(" ") });
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
    valorFleteReal: b.valorFleteReal ? Number(b.valorFleteReal) : null,
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

  await viajeRemesas.crearParaViaje(
    viaje.id,
    // Cada remesa recibe su consecutivo derivado del mismo numero base.
    nuevasRemesas.map((r, i) => ({ ...r, consecutivoRemesa: consecutivoRemesa(base, i + 1) }))
  );
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
async function procesarViaje(viajeId: number): Promise<{ status: number; cuerpo: unknown }> {
  const viaje = (await viajes.findById(viajeId))!;
  const filasRemesa = await viajeRemesas.findByViaje(viajeId);

  const [plantillaPrincipal, vehiculo, conductor, conductor2, remolque] = await Promise.all([
    plantillas.findById(viaje.plantillaId),
    vehiculos.findById(viaje.vehiculoId),
    conductores.findById(viaje.conductorId),
    viaje.conductor2Id ? conductores.findById(viaje.conductor2Id) : Promise.resolve(null),
    viaje.remolqueId ? remolques.findById(viaje.remolqueId) : Promise.resolve(null),
  ]);
  if (!plantillaPrincipal || !vehiculo || !conductor || !remolque) {
    const actualizado = await viajes.update(viajeId, {
      estado: "VALIDACION_ERROR",
      mensajeError: "Plantilla, vehiculo, conductor o remolque del viaje ya no existe.",
    });
    return { status: 404, cuerpo: { ...actualizado, remesas: filasRemesa } };
  }

  const plantillasRemesa = new Map<number, PlantillaViajeConRelaciones>();
  for (const fila of filasRemesa) {
    if (!plantillasRemesa.has(fila.plantillaId)) {
      const p = await plantillas.findById(fila.plantillaId);
      if (!p) {
        const actualizado = await viajes.update(viajeId, {
          estado: "VALIDACION_ERROR",
          mensajeError: `No encontre la plantilla ${fila.plantillaId} de la remesa ${fila.consecutivoRemesa}.`,
        });
        return { status: 404, cuerpo: { ...actualizado, remesas: filasRemesa } };
      }
      plantillasRemesa.set(fila.plantillaId, p);
    }
  }

  const consecutivoManifiesto = viaje.consecutivoManifiesto!;
  // En viajes se guarda como fecha de cargue la mas temprana de las remesas.
  const primerCargue = new Date(viaje.fechaHoraCargue);

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

  // Ruta del viaje segun las plantillas, antes de ajustar por vacios. Es el
  // mismo par con el que el despacho consulto las vias a SICETAC.
  const plantillaUltima = plantillasRemesa.get(filasRemesa[filasRemesa.length - 1].plantillaId)!;
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
    remolque: { placa: remolque.placa, capacidadKg: remolque.capacidadKg },
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

  // Remesas que ya existen en el RNDC (de un intento anterior).
  const yaCreadas = filasRemesa.filter((f) => f.estado === "CREADA").map((f) => f.consecutivoRemesa!);
  const avisoYaCreadas =
    yaCreadas.length > 0
      ? `Las remesas ${yaCreadas.join(", ")} YA estan creadas en el RNDC y no se reenvian. `
      : "";

  // 1. Validaciones locales. Cada rechazo del RNDC cuesta tiempo en el despacho
  //    nocturno, y algunos consumen cupos de la empresa.
  const reglas = validarReglasRndc(datosViaje, consecutivoManifiesto);
  const erroresDocumentos = validarDocumentos(
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
  const avisoPiso = await validarPisoSicetac(
    viaje.codVia,
    aCabeceraMunicipal(rutaBase.origen),
    aCabeceraMunicipal(rutaBase.destino),
    datosViaje.valorFleteReal ?? 0
  );

  const errores = [
    ...mensajesDe(reglas, "ERROR"),
    ...erroresDocumentos,
    ...(avisoPiso ? [avisoPiso] : []),
  ];
  const avisos = [...mensajesDe(reglas, "AVISO"), ...avisosMonitoreo];

  // Se reemplazan en cada intento: los de un intento anterior pueden ya no aplicar.
  await viajes.update(viajeId, { avisos: avisos.length > 0 ? avisos.join(" | ") : null });

  if (errores.length > 0) {
    const actualizado = await viajes.update(viajeId, {
      estado: "VALIDACION_ERROR",
      mensajeError: avisoYaCreadas + errores.join(" | "),
      codigoError: null,
      errorCrudo: null,
    });
    return { status: 422, cuerpo: { ...actualizado, remesas: filasRemesa } };
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
      return { status: 502, cuerpo: { ...actualizado, remesas: await viajeRemesas.findByViaje(viajeId) } };
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
      return { status: 422, cuerpo: { ...actualizado, remesas: await viajeRemesas.findByViaje(viajeId) } };
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
    return { status: 502, cuerpo: { ...actualizado, remesas: await viajeRemesas.findByViaje(viajeId) } };
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
    return { status: 422, cuerpo: { ...actualizado, remesas: await viajeRemesas.findByViaje(viajeId) } };
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
 * Reintenta un viaje que quedo a medias, despues de corregir lo necesario.
 *
 * Caso tipico: la remesa se creo pero el manifiesto fue rechazado (ej. MAN130,
 * el titular no existe como tercero). Se corrige en el catalogo o en el portal
 * del RNDC y se reintenta: las remesas ya creadas se reutilizan y solo se envia
 * lo que falta.
 *
 * El body puede corregir los datos que son SOLO del manifiesto: vehiculo,
 * conductores, remolque, valores, via, EMF y el numero del manifiesto. Las
 * remesas no llevan placa ni conductor, asi que cambiarlos no las afecta. Lo
 * que es de la remesa (pesos, citas, clientes) no se cambia aqui: una remesa
 * creada con datos errados se corrige anulandola en el RNDC.
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
    if (!(await remolques.findById(Number(b.remolqueId)))) {
      return res.status(404).json({ error: "Remolque no encontrado" });
    }
    cambios.remolqueId = Number(b.remolqueId);
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

  // Candado contra el doble clic: solo un reintento a la vez toma el viaje.
  if (!(await viajes.tomarParaReintento(viajeId, ESTADOS_REINTENTABLES))) {
    return res.status(409).json({ error: "El viaje ya se esta reintentando. Espera el resultado." });
  }

  try {
    if (Object.keys(cambios).length > 0) await viajes.update(viajeId, cambios);
    const resultado = await procesarViaje(viajeId);
    res.status(resultado.status).json(resultado.cuerpo);
  } catch (exc) {
    // Si algo inesperado falla, el viaje no puede quedar trabado en
    // REINTENTANDO: vuelve a su estado anterior para poder reintentarlo.
    await viajes.update(viajeId, { estado: viaje.estado });
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

/**
 * Siguiente numero disponible, para precargar el campo del despacho.
 * Se puede cambiar: lo devuelto es una sugerencia, no una reserva.
 */
despachoRouter.get("/siguiente-consecutivo", async (_req, res) => {
  const base = siguienteBase(
    await viajes.ultimoConsecutivo(),
    config.consecutivos.longitud,
    config.consecutivos.prefijo
  );
  res.json({ base });
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
