import { Router } from "express";
import { vehiculos, conductores, plantillas, viajes, Vehiculo, Conductor } from "../repo";
import { config } from "../config";
import {
  construirXmlMensaje,
  construirDatosRemesa,
  construirDatosManifiesto,
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

// El "boton unico": recibe plantillaId, vehiculoId, conductorId, fechaHoraCargue,
// pesoReal, cantidadReal, valorFleteReal -- y hace todo lo demas.
despachoRouter.post("/", async (req, res) => {
  const b = req.body;

  const [plantilla, vehiculo, conductor] = await Promise.all([
    plantillas.findById(Number(b.plantillaId)),
    vehiculos.findById(Number(b.vehiculoId)),
    conductores.findById(Number(b.conductorId)),
  ]);

  if (!plantilla || !vehiculo || !conductor) {
    return res.status(404).json({ error: "Plantilla, vehiculo o conductor no encontrado" });
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
      placaRemolque: vehiculo.placaRemolque,
      configuracion: vehiculo.configuracion,
    },
    conductor: { cedula: conductor.cedula },
    plantilla: {
      ruta: {
        ciudadOrigen: plantilla.ruta.ciudadOrigen,
        ciudadDestino: plantilla.ruta.ciudadDestino,
        codigoOrigenRndc: plantilla.ruta.codigoOrigenRndc,
        codigoDestinoRndc: plantilla.ruta.codigoDestinoRndc,
      },
      contratante: { nit: plantilla.contratante.nit },
      remitente: { nit: plantilla.remitente.nit },
      destinatario: { nit: plantilla.destinatario.nit },
      tipoMercancia: plantilla.tipoMercancia,
      naturalezaCarga: plantilla.naturalezaCarga,
      unidadMedida: plantilla.unidadMedida,
      valorFleteBase: plantilla.valorFleteBase,
      observaciones: plantilla.observaciones,
    },
    pesoReal: viaje.pesoReal,
    cantidadReal: viaje.cantidadReal,
    valorFleteReal: viaje.valorFleteReal,
    fechaHoraCargue,
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

  // 2. PASO 1 DE 2: crear la remesa
  const xmlRemesa = construirXmlMensaje(
    credenciales,
    PROCESO_ID_REMESA,
    construirDatosRemesa(datosViaje)
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

  const numeroRemesa = resultadoRemesa.radicado ?? "";
  await viajes.update(viaje.id, { numeroRemesaRndc: numeroRemesa });

  // 3. PASO 2 DE 2: crear el manifiesto, referenciando la remesa
  const xmlManifiesto = construirXmlMensaje(
    credenciales,
    PROCESO_ID_MANIFIESTO,
    construirDatosManifiesto(datosViaje, numeroRemesa)
  );

  let resultadoManifiesto;
  try {
    resultadoManifiesto = await cliente.enviar(xmlManifiesto);
  } catch (exc) {
    const actualizado = await viajes.update(viaje.id, {
      estado: "MANIFIESTO_ERROR",
      mensajeError: `Remesa ${numeroRemesa} creada, pero fallo el manifiesto: ${
        (exc as RndcError).message
      }`,
    });
    return res.status(502).json(actualizado);
  }

  if (!resultadoManifiesto.ok) {
    const actualizado = await viajes.update(viaje.id, {
      estado: "MANIFIESTO_ERROR",
      mensajeError: `Remesa ${numeroRemesa} creada, pero el RNDC rechazo el manifiesto: ${resultadoManifiesto.error}`,
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
