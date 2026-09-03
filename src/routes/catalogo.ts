import { Router } from "express";
import { vehiculos, conductores, terceros, rutas, plantillas, remolques } from "../repo";

export const catalogoRouter = Router();

// ---------- REMOLQUES (trailers) ----------
catalogoRouter.get("/remolques", async (_req, res) => {
  res.json(await remolques.findMany());
});

catalogoRouter.post("/remolques", async (req, res) => {
  const b = req.body;
  const creado = await remolques.create({
    placa: String(b.placa).toUpperCase().trim(),
    numEjes: b.numEjes ? Number(b.numEjes) : null,
    capacidadKg: b.capacidadKg ? Number(b.capacidadKg) : null,
    fechaVencSoat: b.fechaVencSoat ? new Date(b.fechaVencSoat) : null,
    fechaVencTecnomecanica: b.fechaVencTecnomecanica ? new Date(b.fechaVencTecnomecanica) : null,
  });
  res.status(201).json(creado);
});

// ---------- VEHICULOS ----------
catalogoRouter.get("/vehiculos", async (_req, res) => {
  res.json(await vehiculos.findMany());
});

catalogoRouter.post("/vehiculos", async (req, res) => {
  const b = req.body;
  const creado = await vehiculos.create({
    placa: String(b.placa).toUpperCase().trim(),
    placaRemolque: b.placaRemolque ? String(b.placaRemolque).toUpperCase().trim() : null,
    marca: b.marca ?? null,
    configuracion: b.configuracion ?? null,
    capacidadKg: b.capacidadKg ? Number(b.capacidadKg) : null,
    propietarioNit: b.propietarioNit ?? null,
    fechaVencSoat: b.fechaVencSoat ? new Date(b.fechaVencSoat) : null,
    fechaVencTecnomecanica: b.fechaVencTecnomecanica ? new Date(b.fechaVencTecnomecanica) : null,
    codTipoIdTenedor: b.codTipoIdTenedor ?? "N",
    numIdTenedor: b.numIdTenedor ?? null,
    codTipoCarroceria: b.codTipoCarroceria ?? "0",
    pesoVehiculoVacio: b.pesoVehiculoVacio ? Number(b.pesoVehiculoVacio) : null,
  });
  res.status(201).json(creado);
});

// ---------- CONDUCTORES ----------
catalogoRouter.get("/conductores", async (_req, res) => {
  res.json(await conductores.findMany());
});

catalogoRouter.post("/conductores", async (req, res) => {
  const b = req.body;
  const creado = await conductores.create({
    cedula: String(b.cedula).trim(),
    nombre: String(b.nombre).trim(),
    licencia: b.licencia ?? null,
    categoriaLicencia: b.categoriaLicencia ?? null,
    fechaVencLicencia: b.fechaVencLicencia ? new Date(b.fechaVencLicencia) : null,
    codTipoId: b.codTipoId ?? "C",
  });
  res.status(201).json(creado);
});

// ---------- TERCEROS (clientes) ----------
catalogoRouter.get("/terceros", async (_req, res) => {
  res.json(await terceros.findMany());
});

catalogoRouter.post("/terceros", async (req, res) => {
  const b = req.body;
  const creado = await terceros.create({
    nit: String(b.nit).trim(),
    nombre: String(b.nombre).trim(),
    direccion: b.direccion ?? null,
    ciudad: b.ciudad ?? null,
    telefono: b.telefono ?? null,
    rol: b.rol ?? null,
    codTipoId: b.codTipoId ?? "N",
    codSede: b.codSede ?? "0",
  });
  res.status(201).json(creado);
});

// ---------- RUTAS ----------
catalogoRouter.get("/rutas", async (_req, res) => {
  res.json(await rutas.findMany());
});

catalogoRouter.post("/rutas", async (req, res) => {
  const b = req.body;
  const creada = await rutas.create({
    ciudadOrigen: String(b.ciudadOrigen).trim(),
    ciudadDestino: String(b.ciudadDestino).trim(),
    codigoOrigenRndc: b.codigoOrigenRndc ?? null,
    codigoDestinoRndc: b.codigoDestinoRndc ?? null,
    distanciaKm: b.distanciaKm ? Number(b.distanciaKm) : null,
  });
  res.status(201).json(creada);
});

// ---------- PLANTILLAS DE VIAJE ----------
catalogoRouter.get("/plantillas", async (_req, res) => {
  res.json(await plantillas.findMany());
});

catalogoRouter.post("/plantillas", async (req, res) => {
  const b = req.body;
  const creada = await plantillas.create({
    nombre: String(b.nombre).trim(),
    contratanteId: Number(b.contratanteId),
    remitenteId: Number(b.remitenteId),
    destinatarioId: Number(b.destinatarioId),
    rutaId: Number(b.rutaId),
    tipoMercancia: b.tipoMercancia ?? null,
    naturalezaCarga: b.naturalezaCarga ?? null,
    unidadMedida: b.unidadMedida ?? null,
    valorFleteBase: b.valorFleteBase ? Number(b.valorFleteBase) : null,
    observaciones: b.observaciones ?? null,
    codOperacionTransporte: b.codOperacionTransporte ?? "G",
    codNaturalezaCarga: b.codNaturalezaCarga ?? "1",
    codUnidadMedida: b.codUnidadMedida ?? "1",
    codTipoEmpaque: b.codTipoEmpaque ?? "0",
    codMercancia: b.codMercancia ?? null,
    horasPactoCargue: b.horasPactoCargue ? Number(b.horasPactoCargue) : 1,
    minutosPactoCargue: b.minutosPactoCargue ? Number(b.minutosPactoCargue) : 0,
    horasPactoDescargue: b.horasPactoDescargue ? Number(b.horasPactoDescargue) : 1,
    minutosPactoDescargue: b.minutosPactoDescargue ? Number(b.minutosPactoDescargue) : 0,
    retencionIcaManifiesto: b.retencionIcaManifiesto ? Number(b.retencionIcaManifiesto) : 0,
    codResponsablePagoCargue: b.codResponsablePagoCargue ?? "E",
    codResponsablePagoDescargue: b.codResponsablePagoDescargue ?? "E",
    aceptacionElectronica: b.aceptacionElectronica ?? "NO",
    codMunicipioPagoSaldo: b.codMunicipioPagoSaldo ?? null,
    tomadorPolizaCarga: b.tomadorPolizaCarga ?? "Empresa Transporte",
    numeroPolizaTransporte: b.numeroPolizaTransporte ?? null,
    companiaSeguro: b.companiaSeguro ?? null,
    fechaVencimientoPolizaCarga: b.fechaVencimientoPolizaCarga ? new Date(b.fechaVencimientoPolizaCarga) : null,
  });
  res.status(201).json(creada);
});
