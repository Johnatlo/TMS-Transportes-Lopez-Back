import { Router } from "express";
import { vehiculos, conductores, plantillas, viajes, remolques, Vehiculo, Conductor } from "../repo";
import { config } from "../config";
import {
  construirXmlMensaje,
  construirDatosRemesa,
  construirDatosManifiesto,
  construirBloqueRemesasManifiesto,
  PROCESO_ID_REMESA,
  PROCESO_ID_MANIFIESTO,
  DatosViajeParaRndc,
} from "../rndc/builders";
import { RndcClient, RndcError } from "../rndc/client";

export const despachoRouter = Router();

function validarDocumentos(vehiculo: Vehiculo, conductor: Conductor): string[] {
  const problemas: string[] = [];
  const hoy = new Date();

  if (vehiculo.fechaVencSoat && vehiculo.fechaVencSoat < hoy) {
    problemas.push(`SOAT vencido desde ${vehiculo.fechaVencSoat.toISOString().slice(0, 10)}`);
  }
  if (vehiculo.fechaVencTecnomecanica && vehiculo.fechaVencTecnomecanica < hoy) {
    problemas.push(
      `Tecnomecanica vencida desde ${vehiculo.fechaVencTecnomecanica.toISOString().slice(0, 10)}`
    );
  }
  if (conductor.fechaVencLicencia && conductor.fechaVencLicencia < hoy) {
    problemas.push(`Licencia vencida desde ${conductor.fechaVencLicencia.toISOString().slice(0, 10)}`);
  }
  // TODO: sumar aqui la validacion contra el piso tarifario SICE-TAC antes de enviar.
  return problemas;
}

// El "boton unico": recibe plantillaId, vehiculoId, conductorId, remolqueId, fechaHoraCargue,
// pesoReal, cantidadReal, valorFleteReal -- y hace todo lo demas.
despachoRouter.post("/", async (req, res) => {
  const b = req.body;

  if (!b.remolqueId) {
    return res.status(422).json({ error: "Debes indicar el remolque (trailer) usado en este viaje" });
  }

  const [plantilla, vehiculo, conductor, conductor2, remolque] = await Promise.all([
    plantillas.findById(Number(b.plantillaId)),
    vehiculos.findById(Number(b.vehiculoId)),
    conductores.findById(Number(b.conductorId)),
    b.conductor2Id ? conductores.findById(Number(b.conductor2Id)) : Promise.resolve(null),
    remolques.findById(Number(b.remolqueId)),
  ]);

  if (!plantilla || !vehiculo || !conductor || !remolque) {
    return res.status(404).json({ error: "Plantilla, vehiculo, conductor o remolque no encontrado" });
  }

  const fechaHoraCargue = new Date(b.fechaHoraCargue);

  const viaje = await viajes.create({
    plantillaId: plantilla.id,
    vehiculoId: vehiculo.id,
    conductorId: conductor.id,
    fechaHoraCargue,
    pesoReal: b.pesoReal ? Number(b.pesoReal) : null,
    cantidadReal: b.cantidadReal ? Number(b.cantidadReal) : null,
    valorFleteReal: b.valorFleteReal ? Number(b.valorFleteReal) : null,
    valorAnticipoManifiesto: b.valorAnticipoManifiesto ? Number(b.valorAnticipoManifiesto) : 0,
    fechaPagoSaldo: b.fechaPagoSaldo ? new Date(b.fechaPagoSaldo) : null,
    conductor2Id: conductor2 ? conductor2.id : null,
    remolqueId: remolque.id,
  });

  // 1. Validaciones locales primero (sin red, evita gastar intentos contra el RNDC)
  const problemas = validarDocumentos(vehiculo, conductor);
  if (problemas.length > 0) {
    const actualizado = await viajes.update(viaje.id, {
      estado: "VALIDACION_ERROR",
      mensajeError: problemas.join(" | "),
    });
    return res.status(422).json(actualizado);
  }

  const datosViaje: DatosViajeParaRndc = {
    vehiculo: {
      placa: vehiculo.placa,
      // El titular del manifiesto es el tenedor/propietario registrado del
      // vehiculo (confirmado contra un caso real del portal RNDC).
      tenedorCodTipoId: vehiculo.codTipoIdTenedor,
      tenedorNumId: vehiculo.numIdTenedor,
    },
    remolque: { placa: remolque.placa },
    conductor: { codTipoId: conductor.codTipoId, cedula: conductor.cedula },
    conductor2: conductor2 ? { codTipoId: conductor2.codTipoId, cedula: conductor2.cedula } : null,
    plantilla: {
      ruta: {
        codigoOrigenRndc: plantilla.ruta.codigoOrigenRndc,
        codigoDestinoRndc: plantilla.ruta.codigoDestinoRndc,
      },
      contratante: {
        codTipoId: plantilla.contratante.codTipoId,
        nit: plantilla.contratante.nit,
        codSede: plantilla.contratante.codSede,
      },
      remitente: {
        codTipoId: plantilla.remitente.codTipoId,
        nit: plantilla.remitente.nit,
        codSede: plantilla.remitente.codSede,
      },
      destinatario: {
        codTipoId: plantilla.destinatario.codTipoId,
        nit: plantilla.destinatario.nit,
        codSede: plantilla.destinatario.codSede,
      },
      codOperacionTransporte: plantilla.codOperacionTransporte,
      codNaturalezaCarga: plantilla.codNaturalezaCarga,
      codUnidadMedida: plantilla.codUnidadMedida,
      codTipoEmpaque: plantilla.codTipoEmpaque,
      codMercancia: plantilla.codMercancia,
      tipoMercancia: plantilla.tipoMercancia,
      observaciones: plantilla.observaciones,
      horasPactoCargue: plantilla.horasPactoCargue,
      minutosPactoCargue: plantilla.minutosPactoCargue,
      horasPactoDescargue: plantilla.horasPactoDescargue,
      minutosPactoDescargue: plantilla.minutosPactoDescargue,
      valorFleteBase: plantilla.valorFleteBase,
      retencionIcaManifiesto: plantilla.retencionIcaManifiesto,
      codResponsablePagoCargue: plantilla.codResponsablePagoCargue,
      codResponsablePagoDescargue: plantilla.codResponsablePagoDescargue,
      aceptacionElectronica: plantilla.aceptacionElectronica,
      codMunicipioPagoSaldo: plantilla.codMunicipioPagoSaldo,
      tomadorPolizaCarga: plantilla.tomadorPolizaCarga,
      numeroPolizaTransporte: plantilla.numeroPolizaTransporte,
      companiaSeguro: plantilla.companiaSeguro,
      fechaVencimientoPolizaCarga: plantilla.fechaVencimientoPolizaCarga,
    },
    pesoReal: viaje.pesoReal,
    cantidadReal: viaje.cantidadReal,
    valorFleteReal: viaje.valorFleteReal,
    fechaHoraCargue,
    valorAnticipoManifiesto: viaje.valorAnticipoManifiesto,
    fechaPagoSaldo: viaje.fechaPagoSaldo,
    nitMonitoreoFlota: config.rndc.nitMonitoreoFlota,
  };

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
  });

  const consecutivoRemesa = viaje.consecutivoRemesa!;
  const consecutivoManifiesto = viaje.consecutivoManifiesto!;

  // 2. PASO 1 DE 2: crear la remesa (procesoid=3)
  const xmlRemesa = construirXmlMensaje(
    credenciales,
    PROCESO_ID_REMESA,
    construirDatosRemesa(datosViaje, consecutivoRemesa)
  );

  let resultadoRemesa;
  try {
    resultadoRemesa = await cliente.enviar(xmlRemesa);
  } catch (exc) {
    const actualizado = await viajes.update(viaje.id, {
      estado: "REMESA_ERROR",
      mensajeError: (exc as RndcError).message,
    });
    return res.status(502).json(actualizado);
  }

  if (!resultadoRemesa.ok) {
    const actualizado = await viajes.update(viaje.id, {
      estado: "REMESA_ERROR",
      mensajeError: `El RNDC rechazo la remesa: ${resultadoRemesa.error}`,
    });
    return res.status(422).json(actualizado);
  }

  // El radicado (ingresoid) que devuelve el RNDC es solo para trazabilidad --
  // el manifiesto se referencia con consecutivoRemesa (nuestro propio consecutivo),
  // no con este radicado.
  await viajes.update(viaje.id, { numeroRemesaRndc: resultadoRemesa.radicado ?? "" });

  // 3. PASO 2 DE 2: crear el manifiesto (procesoid=4), enlazando la remesa por
  // su CONSECUTIVOREMESA dentro del bloque <REMESASMAN>.
  const bloqueRemesas = construirBloqueRemesasManifiesto([consecutivoRemesa]);
  const xmlManifiesto = construirXmlMensaje(
    credenciales,
    PROCESO_ID_MANIFIESTO,
    construirDatosManifiesto(datosViaje, consecutivoManifiesto),
    "1",
    bloqueRemesas
  );

  let resultadoManifiesto;
  try {
    resultadoManifiesto = await cliente.enviar(xmlManifiesto);
  } catch (exc) {
    const actualizado = await viajes.update(viaje.id, {
      estado: "MANIFIESTO_ERROR",
      mensajeError: `Remesa ${consecutivoRemesa} creada, pero fallo el manifiesto: ${
        (exc as RndcError).message
      }`,
    });
    return res.status(502).json(actualizado);
  }

  if (!resultadoManifiesto.ok) {
    const actualizado = await viajes.update(viaje.id, {
      estado: "MANIFIESTO_ERROR",
      mensajeError: `Remesa ${consecutivoRemesa} creada, pero el RNDC rechazo el manifiesto: ${resultadoManifiesto.error}`,
    });
    return res.status(422).json(actualizado);
  }

  const final = await viajes.update(viaje.id, {
    estado: "CONFIRMADO",
    numeroManifiestoRndc: resultadoManifiesto.radicado,
    mec: resultadoManifiesto.mec,
    codigoSeguridadQr: resultadoManifiesto.qr,
  });

  res.status(201).json(final);
});

despachoRouter.get("/historial", async (_req, res) => {
  res.json(await viajes.findMany(100));
});
