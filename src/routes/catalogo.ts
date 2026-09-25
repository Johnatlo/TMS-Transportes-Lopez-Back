import { Router, type Response } from "express";
import { revisarCoordenadaSede, normalizarCodigoMercancia } from "../rndc/builders";
import { config } from "../config";
import { revisarVencimientos } from "../alertas";
import { RndcClient } from "../rndc/client";
import {
  consultarSicetac,
  filasDeLaOperacion,
  calcularPisoSicetac,
  aCabeceraMunicipal,
  periodoDe,
  CONDICION_CARGA,
  CONFIGURACIONES_SICETAC,
} from "../rndc/sicetac";
import {
  vehiculos,
  conductores,
  terceros,
  rutas,
  plantillas,
  remolques,
  parametros,
  vias,
  empresasMonitoreo,
  municipios,
  ErrorDuplicado,
  ErrorValidacion,
  type NuevaPlantilla,
} from "../repo";

export const catalogoRouter = Router();

// ---------- Edicion desde el catalogo ----------

/**
 * Corre una edicion y traduce los errores conocidos a respuestas claras:
 * 404 si no existe, 409 si choca con otro registro (placa/cedula/NIT
 * repetidos) y 422 si un dato no tiene el formato esperado.
 */
async function responderEdicion<T>(
  res: Response,
  editar: () => Promise<T | null>,
  extra: Record<string, unknown> = {}
) {
  try {
    const actualizado = await editar();
    if (!actualizado) return res.status(404).json({ error: "Registro no encontrado" });
    res.json({ ...actualizado, ...extra });
  } catch (exc) {
    if (exc instanceof ErrorDuplicado) return res.status(409).json({ error: exc.message });
    if (exc instanceof ErrorValidacion) return res.status(422).json({ error: exc.message });
    throw exc;
  }
}

/** Copia del body solo las llaves que llegaron, para no pisar lo que no se edito. */
function soloPresentes(b: Record<string, unknown>, llaves: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of llaves) if (k in b) out[k] = b[k];
  return out;
}

const soloDigitos = (v: unknown) => (v === null || v === undefined ? v : String(v).replace(/\D/g, ""));
const mayusculas = (v: unknown) => (v === null || v === undefined ? v : String(v).toUpperCase().trim());

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

catalogoRouter.put("/remolques/:id", async (req, res) => {
  const datos = soloPresentes(req.body ?? {}, [
    "placa", "numEjes", "capacidadKg", "fechaVencSoat", "fechaVencTecnomecanica", "activo",
  ]);
  if ("placa" in datos) datos.placa = mayusculas(datos.placa);
  await responderEdicion(res, () => remolques.update(Number(req.params.id), datos));
});

// ---------- VEHICULOS ----------
catalogoRouter.get("/vehiculos", async (_req, res) => {
  res.json(await vehiculos.findMany());
});

catalogoRouter.post("/vehiculos", async (req, res) => {
  const b = req.body;
  // El FOPAT aplica a toda la flota salvo excepcion explicita, asi que el
  // valor por defecto viene de los parametros de la empresa y no se pide en
  // el formulario de cada vehiculo.
  const params = await parametros.obtener();
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
    nombreTenedor: b.nombreTenedor ?? null,
  });
  res.status(201).json(creado);
});

/**
 * Edicion completa de un vehiculo desde el catalogo.
 *
 * El titular del manifiesto (codTipoIdTenedor + numIdTenedor) es lo que viaja
 * en CODIDTITULARMANIFIESTO / NUMIDTITULARMANIFIESTO [MANIFIESTO V7 pag. 11].
 * En la flota propia la empresa usa la cedula del propietario y no su NIT,
 * porque con la empresa como titular el RNDC exige valor a pagar 0 (MAN006).
 */
catalogoRouter.put("/vehiculos/:id", async (req, res) => {
  const datos = soloPresentes(req.body ?? {}, [
    "placa", "placaRemolque", "marca", "configuracion", "capacidadKg", "pesoVehiculoVacio",
    "codTipoCarroceria", "propietarioNit", "codTipoIdTenedor", "numIdTenedor", "nombreTenedor",
    "fechaVencSoat", "fechaVencTecnomecanica", "aplicaFopat", "nitMonitoreoFlota", "activo",
  ]);
  if ("placa" in datos) datos.placa = mayusculas(datos.placa);
  if ("placaRemolque" in datos) datos.placaRemolque = mayusculas(datos.placaRemolque);
  if ("numIdTenedor" in datos) datos.numIdTenedor = soloDigitos(datos.numIdTenedor);
  if ("propietarioNit" in datos) datos.propietarioNit = soloDigitos(datos.propietarioNit);
  if ("nitMonitoreoFlota" in datos) datos.nitMonitoreoFlota = soloDigitos(datos.nitMonitoreoFlota);

  if ("configuracion" in datos && datos.configuracion) {
    const c = String(datos.configuracion).toUpperCase().trim();
    if (!(CONFIGURACIONES_SICETAC as readonly string[]).includes(c)) {
      return res.status(422).json({
        error: `Configuracion "${c}" no valida para SICETAC. Usa una de: ${CONFIGURACIONES_SICETAC.join(", ")}.`,
      });
    }
    datos.configuracion = c;
  }
  if ("numIdTenedor" in datos && !datos.numIdTenedor) {
    return res.status(422).json({
      error: "El titular del manifiesto es obligatorio: sin el no se puede expedir el manifiesto.",
    });
  }
  await responderEdicion(res, () => vehiculos.update(Number(req.params.id), datos));
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

catalogoRouter.put("/conductores/:id", async (req, res) => {
  const datos = soloPresentes(req.body ?? {}, [
    "codTipoId", "cedula", "nombre", "licencia", "categoriaLicencia", "fechaVencLicencia", "activo",
  ]);
  if ("cedula" in datos) datos.cedula = soloDigitos(datos.cedula);
  if ("categoriaLicencia" in datos) datos.categoriaLicencia = mayusculas(datos.categoriaLicencia);
  if (("cedula" in datos && !datos.cedula) || ("nombre" in datos && !String(datos.nombre ?? "").trim())) {
    return res.status(422).json({ error: "La cedula y el nombre del conductor son obligatorios." });
  }
  await responderEdicion(res, () => conductores.update(Number(req.params.id), datos));
});

// ---------- TERCEROS (clientes) ----------
catalogoRouter.get("/terceros", async (_req, res) => {
  res.json(await terceros.findMany());
});

catalogoRouter.post("/terceros", async (req, res) => {
  const b = req.body;

  // Las coordenadas llegan como texto desde el formulario. Se conserva el valor
  // tal cual lo escribio el usuario para no perder decimales: el RNDC exige 6 y
  // parseFloat de una cadena corta no los inventa.
  const coordenada = (valor: unknown): number | null => {
    if (valor === null || valor === undefined || String(valor).trim() === "") return null;
    const n = Number(String(valor).trim());
    return Number.isFinite(n) ? n : null;
  };

  const latitud = coordenada(b.latitud);
  const longitud = coordenada(b.longitud);

  // Se avisa, pero no se rechaza: puede que la sede aun no tenga coordenada en
  // el portal y el usuario quiera dejarla registrada de todas formas.
  const revision = revisarCoordenadaSede(latitud, longitud, `Sede ${b.codSede ?? "0"}`);

  const creado = await terceros.create({
    nit: String(b.nit).trim(),
    nombre: String(b.nombre).trim(),
    direccion: b.direccion ?? null,
    ciudad: b.ciudad ?? null,
    telefono: b.telefono ?? null,
    rol: b.rol ?? null,
    codTipoId: b.codTipoId ?? "N",
    codSede: b.codSede ?? "0",
    latitud,
    longitud,
    // Codigo DIVIPOLA del municipio de la sede. Sirve para verificar que el
    // origen y el destino del manifiesto coincidan con algun sitio de cargue y
    // de descargue de las remesas.
    codMunicipioRndc: b.codMunicipioRndc || null,
  });
  res.status(201).json({ ...creado, avisoCoordenada: revision.problema });
});

catalogoRouter.put("/terceros/:id", async (req, res) => {
  const datos = soloPresentes(req.body ?? {}, [
    "codTipoId", "nit", "nombre", "codSede", "direccion", "ciudad", "telefono",
    "codMunicipioRndc", "latitud", "longitud",
  ]);
  if ("nit" in datos) datos.nit = soloDigitos(datos.nit);
  if (("nit" in datos && !datos.nit) || ("nombre" in datos && !String(datos.nombre ?? "").trim())) {
    return res.status(422).json({ error: "El NIT y el nombre del cliente son obligatorios." });
  }
  if ("codMunicipioRndc" in datos && datos.codMunicipioRndc && !/^\d{8}$/.test(String(datos.codMunicipioRndc))) {
    return res.status(422).json({
      error: "El codigo de municipio debe ser DIVIPOLA de 8 digitos (ej. 11001000).",
    });
  }
  // Igual que al crear: la coordenada rara se avisa pero no se rechaza.
  const actual = await terceros.findById(Number(req.params.id));
  const lat = "latitud" in datos ? (datos.latitud === "" ? null : Number(datos.latitud)) : actual?.latitud ?? null;
  const lon = "longitud" in datos ? (datos.longitud === "" ? null : Number(datos.longitud)) : actual?.longitud ?? null;
  const revision = revisarCoordenadaSede(lat, lon, `Sede ${datos.codSede ?? actual?.codSede ?? "0"}`);
  await responderEdicion(res, () => terceros.update(Number(req.params.id), datos), {
    avisoCoordenada: revision.problema,
  });
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

// ---------- MUNICIPIOS (DIVIPOLA) ----------
// Para elegir la ruta de una plantilla por nombre y no por codigo. Puede venir
// vacio si aun no se importo el CSV de municipios.
catalogoRouter.get("/municipios", async (_req, res) => {
  res.json(await municipios.findMany());
});

// ---------- EMPRESAS DE MONITOREO DE FLOTA ----------
// El NIT de la EMF es obligatorio en el manifiesto (error MAN067) y depende del
// proveedor de GPS del vehiculo, asi que se mantiene como catalogo.

catalogoRouter.get("/monitoreo", async (_req, res) => {
  res.json(await empresasMonitoreo.findMany());
});

catalogoRouter.post("/monitoreo", async (req, res) => {
  const nit = String(req.body?.nit ?? "").replace(/\D/g, "");
  const nombre = String(req.body?.nombre ?? "").trim();
  if (!nit || !nombre) {
    return res.status(422).json({ error: "Indica el NIT y el nombre de la empresa de monitoreo" });
  }
  if (nit.length > 15) {
    return res.status(422).json({ error: "El NIT de la empresa de monitoreo admite maximo 15 digitos" });
  }
  await empresasMonitoreo.guardar(nit, nombre);
  res.status(201).json(await empresasMonitoreo.findByNit(nit));
});

catalogoRouter.put("/monitoreo/:id", async (req, res) => {
  const datos: { nit?: string; nombre?: string } = {};
  if (req.body?.nit !== undefined) datos.nit = String(req.body.nit).replace(/\D/g, "");
  if (req.body?.nombre !== undefined) datos.nombre = String(req.body.nombre).trim();
  if (datos.nit === "" || datos.nombre === "") {
    return res.status(422).json({ error: "Indica el NIT y el nombre de la empresa de monitoreo" });
  }
  if (datos.nit && datos.nit.length > 15) {
    return res.status(422).json({ error: "El NIT de la empresa de monitoreo admite maximo 15 digitos" });
  }
  await responderEdicion(res, () => empresasMonitoreo.update(Number(req.params.id), datos));
});

catalogoRouter.delete("/monitoreo/:id", async (req, res) => {
  const ok = await empresasMonitoreo.desactivar(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: "Empresa de monitoreo no encontrada" });
  res.status(204).send();
});

/** Fija el proveedor de GPS por defecto de un vehiculo. */
catalogoRouter.put("/vehiculos/:id/monitoreo", async (req, res) => {
  const nit = req.body?.nitMonitoreoFlota
    ? String(req.body.nitMonitoreoFlota).replace(/\D/g, "")
    : null;
  await vehiculos.fijarMonitoreo(Number(req.params.id), nit);
  res.json(await vehiculos.findById(Number(req.params.id)));
});

// ---------- VIAS (CODVIA) ----------
// La via elegida cambia el valor de referencia de SICETAC y por lo tanto el
// piso del flete, asi que se ofrece en cada despacho.

/**
 * Vias consultadas en linea a SICETAC para un par de municipios.
 *
 * Devuelve tambien el piso tarifario de cada via, que es el dato que decide si
 * el flete pactado es valido. Las vias se guardan en la tabla local para poder
 * seguir despachando si el servicio del Ministerio no responde.
 */
catalogoRouter.get("/vias/sicetac", async (req, res) => {
  const origen = aCabeceraMunicipal(String(req.query.origen ?? ""));
  const destino = aCabeceraMunicipal(String(req.query.destino ?? ""));
  const configuracion = String(req.query.configuracion ?? "").toUpperCase();
  // Horas pactadas de cargue y descargue del viaje: entran en el piso.
  const horas = Number(req.query.horas ?? 0);

  if (!origen || !destino) {
    return res.status(422).json({ error: "Origen y destino deben ser codigos DIVIPOLA" });
  }
  if (!configuracion) {
    return res.status(422).json({
      error:
        "Falta la configuracion del vehiculo (3S3, 2S2, 3...). Revisala en el catalogo o corre npm run verificar.",
    });
  }

  const credenciales = {
    usuario: config.rndc.usuario,
    password: config.rndc.password,
    nitEmpresa: config.rndc.empresaNit,
  };
  // SICETAC va al servidor de consultas (rndcws2) tambien en pruebas: ver
  // config.rndc.consultasWsdlUrl. soloConsultas bloquea cualquier registro.
  const cliente = new RndcClient({
    wsdlUrl: config.rndc.consultasWsdlUrl,
    usuario: config.rndc.usuario,
    password: config.rndc.password,
    simular: config.rndc.simular,
    reintentos: config.rndc.reintentos,
    soloConsultas: true,
  });

  try {
    const resultado = await consultarSicetac(
      cliente,
      credenciales,
      {
        periodo: periodoDe(new Date()),
        configuracion,
        origen,
        destino,
        condicionCarga: CONDICION_CARGA.CARGADO,
      },
      config.sicetac.mesesHaciaAtras
    );

    const propias = filasDeLaOperacion(
      resultado.filas,
      config.sicetac.unidadTransporte,
      config.sicetac.tipoCarga
    );

    const salida = propias.map((f) => ({
      codVia: f.rutasId,
      descripcion: f.via || `Ruta ${f.rutasId}`,
      esEstandar: f.esEstandar,
      kilometros: f.kilometros,
      valorMoviliza: f.valorMoviliza,
      valorHora: f.valorHora,
      // Piso real: movilizacion mas las horas pactadas [SIC21].
      valorSicetac: calcularPisoSicetac(f, horas),
      unidadTransporte: f.nombreUnidadTransporte,
      tipoCarga: f.nombreTipoCarga,
    }));

    // Se cachean para poder despachar si el servicio se cae mas tarde.
    for (const v of salida) {
      if (!v.codVia) continue;
      await vias.guardar({
        codVia: v.codVia,
        codMunicipioOrigen: origen,
        codMunicipioDestino: destino,
        descripcion: v.descripcion,
        valorSicetac: v.valorSicetac,
        esEstandar: v.esEstandar,
      });
    }

    res.json({
      vias: salida,
      periodoUsado: resultado.periodoUsado,
      periodosSinDatos: resultado.periodosVacios,
      origen,
      destino,
    });
  } catch (exc) {
    // Sin conexion se cae a lo ultimo consultado: es preferible una tarifa de
    // hace unos dias a no poder despachar.
    const enCache = await vias.findByRuta(origen, destino);
    res.status(enCache.length > 0 ? 200 : 502).json({
      vias: enCache.map((v) => ({
        codVia: v.codVia,
        descripcion: v.descripcion,
        esEstandar: v.esEstandar,
        valorSicetac: v.valorSicetac,
      })),
      desdeCache: true,
      error: (exc as Error).message,
    });
  }
});

catalogoRouter.get("/vias", async (req, res) => {
  const origen = String(req.query.origen ?? "");
  const destino = String(req.query.destino ?? "");
  if (!/^\d{8}$/.test(origen) || !/^\d{8}$/.test(destino)) {
    return res
      .status(422)
      .json({ error: "Origen y destino deben ser codigos DIVIPOLA de 8 digitos" });
  }
  res.json(await vias.findByRuta(origen, destino));
});

catalogoRouter.post("/vias", async (req, res) => {
  const b = req.body;
  if (!b.codVia || !b.codMunicipioOrigen || !b.codMunicipioDestino || !b.descripcion) {
    return res.status(422).json({
      error: "Faltan datos: codVia, codMunicipioOrigen, codMunicipioDestino y descripcion",
    });
  }
  await vias.guardar({
    codVia: String(b.codVia).trim(),
    codMunicipioOrigen: String(b.codMunicipioOrigen).padStart(8, "0"),
    codMunicipioDestino: String(b.codMunicipioDestino).padStart(8, "0"),
    descripcion: String(b.descripcion).slice(0, 500),
    valorSicetac: b.valorSicetac ? Number(b.valorSicetac) : null,
    esEstandar: !!b.esEstandar,
  });
  res.status(201).json({ ok: true });
});

// ---------- TARIFAS POR RUTA ----------
// Cuando cambia SICETAC hay que mover la tarifa de todas las plantillas de una
// misma ruta. Hacerlo plantilla por plantilla, con cientos de clientes, es
// donde se cuelan los errores.

/** Rutas existentes con su rango de tarifas, para ver donde hay dispersion. */
catalogoRouter.get("/tarifas/rutas", async (_req, res) => {
  res.json(await plantillas.rutasConTarifas());
});

/** Plantillas afectadas por una ruta, para revisar ANTES de actualizar. */
catalogoRouter.get("/tarifas/previsualizar", async (req, res) => {
  const origen = String(req.query.origen ?? "");
  const destino = String(req.query.destino ?? "");
  if (!/^\d{8}$/.test(origen) || !/^\d{8}$/.test(destino)) {
    return res
      .status(422)
      .json({ error: "Origen y destino deben ser codigos DIVIPOLA de 8 digitos" });
  }
  const afectadas = await plantillas.buscarPorRuta(origen, destino);
  res.json(
    afectadas.map((p) => ({
      id: p.id,
      nombre: p.nombre,
      valorFleteBase: p.valorFleteBase,
      fleteActualizadoEn: p.fleteActualizadoEn,
      municipioCargue: (p as any).municipioCargue,
      municipioDescargue: (p as any).municipioDescargue,
    }))
  );
});

/** Aplica la nueva tarifa a todas las plantillas de la ruta. */
catalogoRouter.put("/tarifas", async (req, res) => {
  const { origen, destino, valorFleteBase } = req.body ?? {};
  if (!/^\d{8}$/.test(String(origen ?? "")) || !/^\d{8}$/.test(String(destino ?? ""))) {
    return res
      .status(422)
      .json({ error: "Origen y destino deben ser codigos DIVIPOLA de 8 digitos" });
  }
  const valor = Number(valorFleteBase);
  if (!Number.isFinite(valor) || valor <= 0) {
    return res.status(422).json({ error: "El valor del flete debe ser mayor a cero" });
  }

  const actualizadas = await plantillas.actualizarFletePorRuta(
    String(origen),
    String(destino),
    valor
  );
  res.json({ actualizadas, valorFleteBase: valor });
});

// ---------- ALERTAS DE VENCIMIENTO ----------
// El RNDC valida SOAT, tecnomecanica y licencia contra la fecha de descargue,
// no contra hoy: conviene ver lo que vence pronto y no solo lo vencido.
catalogoRouter.get("/alertas", async (req, res) => {
  const dias = Number(req.query.dias ?? 30);
  // ?inactivos=1 agrega los documentos de vehiculos, remolques y conductores
  // inactivos, para poder actualizarlos desde el modal de alertas.
  const inactivos = req.query.inactivos === "1" || req.query.inactivos === "true";
  res.json(await revisarVencimientos(Number.isFinite(dias) ? dias : 30, inactivos));
});

// ---------- PARAMETROS DE LA EMPRESA ----------
// Poliza de carga, FOPAT y tarifa de retefuente. Cambian una vez al ano, asi
// que viven aqui y no en cada plantilla.
/**
 * nitEmpresa / nombreEmpresa / ambienteRndc vienen del .env y son de solo
 * lectura: el catalogo los muestra (y usa el NIT para marcar los vehiculos
 * cuyo titular es la propia empresa), pero no se editan desde la pantalla.
 */
function datosFijosEmpresa() {
  return {
    nitEmpresa: config.rndc.empresaNit,
    nombreEmpresa: config.empresa.nombre,
    ambienteRndc: config.rndc.nombreAmbiente,
  };
}

catalogoRouter.get("/parametros", async (_req, res) => {
  const p = await parametros.obtener();
  res.json({ ...p, ...datosFijosEmpresa(), avisoPoliza: await parametros.revisarVigenciaPoliza() });
});

catalogoRouter.put("/parametros", async (req, res) => {
  const b = req.body;
  // Solo se tocan los campos que llegan: antes un campo ausente se guardaba
  // como null y un guardado parcial borraba la poliza.
  const presente = (k: string) => k in (b ?? {});
  const guardados = await parametros.guardar({
    tomadorPolizaCarga: b.tomadorPolizaCarga ?? undefined,
    numeroPolizaTransporte: presente("numeroPolizaTransporte") ? b.numeroPolizaTransporte || null : undefined,
    companiaSeguro: presente("companiaSeguro") ? b.companiaSeguro || null : undefined,
    fechaVencimientoPolizaCarga: presente("fechaVencimientoPolizaCarga")
      ? b.fechaVencimientoPolizaCarga
        ? new Date(b.fechaVencimientoPolizaCarga)
        : null
      : undefined,
    aplicaFopat: b.aplicaFopat !== undefined ? !!b.aplicaFopat : undefined,
    tarifaRetencionFuente:
      b.tarifaRetencionFuente !== undefined ? Number(b.tarifaRetencionFuente) : undefined,
  });
  res.json({ ...guardados, ...datosFijosEmpresa(), avisoPoliza: await parametros.revisarVigenciaPoliza() });
});

// ---------- PLANTILLAS DE VIAJE ----------
catalogoRouter.get("/plantillas", async (_req, res) => {
  res.json(await plantillas.findMany());
});

/**
 * "Elimina" una plantilla (en realidad la desactiva: ver plantillas.desactivar
 * en el repo). No se borra de verdad porque el historial de viajes y remesas
 * la referencia por id.
 */
catalogoRouter.delete("/plantillas/:id", async (req, res) => {
  const ok = await plantillas.desactivar(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: "Plantilla no encontrada" });
  res.status(204).send();
});

/**
 * Convierte el cuerpo de la peticion en los datos de una plantilla.
 *
 * Lo comparten la creacion y la edicion, para que las dos normalicen igual.
 * Devuelve un mensaje de error si falta algo sin lo cual no se puede
 * despachar.
 */
async function plantillaDesdeCuerpo(
  b: any
): Promise<{ datos: NuevaPlantilla } | { error: string }> {
  const params = await parametros.obtener();

  // Ruta explicita. Lo que no llegue se precarga con el municipio del
  // remitente y del destinatario; si aun asi falta, no se guarda: sin ruta no
  // se pueden pedir las vias a SICETAC ni validar el manifiesto.
  const ruta = await plantillas.resolverRuta(
    Number(b.remitenteId),
    Number(b.destinatarioId),
    b.municipioOrigen,
    b.municipioDestino
  );
  for (const [etiqueta, codigo] of [
    ["origen", ruta.municipioOrigen],
    ["destino", ruta.municipioDestino],
  ] as const) {
    if (!codigo) {
      return {
        error:
          `Falta el municipio de ${etiqueta} de la ruta y el tercero tampoco tiene uno ` +
          `registrado. Escribelo en la plantilla o completalo en el catalogo de terceros.`,
      };
    }
    if (!/^\d{8}$/.test(codigo)) {
      return {
        error: `El municipio de ${etiqueta} de la ruta (${codigo}) debe ser un codigo DIVIPOLA de 8 digitos`,
      };
    }
  }

  // El codigo de mercancia se guarda normalizado a 6 digitos, igual que como se
  // envia al RNDC, para que lo almacenado y lo enviado nunca difieran.
  const codMercancia = normalizarCodigoMercancia(b.codMercancia ?? null);

  return {
    datos: {
      nombre: String(b.nombre).trim(),
      contratanteId: Number(b.contratanteId),
      remitenteId: Number(b.remitenteId),
      destinatarioId: Number(b.destinatarioId),
      // Columna heredada de la vieja tabla de rutas. Se conserva por
      // compatibilidad; la ruta vive en municipioOrigen/municipioDestino.
      rutaId: b.rutaId ? Number(b.rutaId) : null,
      municipioOrigen: ruta.municipioOrigen,
      municipioDestino: ruta.municipioDestino,
      // tipoMercancia viaja como DESCRIPCIONCORTAPRODUCTO (maximo 60 caracteres).
      tipoMercancia: b.tipoMercancia ? String(b.tipoMercancia).slice(0, 60) : null,
      // Tarifa pactada para la ruta. Se actualiza cuando cambia SICETAC, no en
      // cada despacho; alli solo se precarga y se puede ajustar.
      valorFleteBase: b.valorFleteBase ? Number(b.valorFleteBase) : null,
      naturalezaCarga: b.naturalezaCarga ?? null,
      unidadMedida: b.unidadMedida ?? null,
      observaciones: b.observaciones ?? null,

      // Dos tipos distintos con el mismo nombre de etiqueta en el RNDC.
      tipoOperacionRemesa: b.tipoOperacionRemesa ?? "G",
      tipoManifiesto: b.tipoManifiesto ?? "G",
      codMunicipioIntermedio: b.codMunicipioIntermedio ?? null,

      // Esta empresa solo mueve carga general.
      codNaturalezaCarga: "1",
      codUnidadMedida: b.codUnidadMedida ?? "1",
      codTipoEmpaque: b.codTipoEmpaque ?? "0",
      empaquePrimario: b.empaquePrimario ?? null,
      codMercancia,
      subpartidaCode: b.subpartidaCode ?? null,
      codigoArancelCode: b.codigoArancelCode ?? null,
      unidadMedidaProducto: b.unidadMedidaProducto ?? "KGM",

      horasPactoCargue: b.horasPactoCargue !== undefined ? Number(b.horasPactoCargue) : 1,
      minutosPactoCargue: b.minutosPactoCargue !== undefined ? Number(b.minutosPactoCargue) : 0,
      horasPactoDescargue: b.horasPactoDescargue !== undefined ? Number(b.horasPactoDescargue) : 1,
      minutosPactoDescargue:
        b.minutosPactoDescargue !== undefined ? Number(b.minutosPactoDescargue) : 0,

      // Factor de ICA (por mil) del municipio donde carga esta remesa. Con varias
      // remesas de municipios distintos, el manifiesto lleva el promedio ponderado.
      factorIcaCargue: b.factorIcaCargue !== undefined ? Number(b.factorIcaCargue) : 0,
      retencionIcaManifiesto: b.factorIcaCargue !== undefined ? Number(b.factorIcaCargue) : 0,

      // Si la plantilla no la especifica, se hereda la tarifa de la empresa.
      tarifaRetencionFuente:
        b.tarifaRetencionFuente !== undefined
          ? Number(b.tarifaRetencionFuente)
          : params.tarifaRetencionFuente,
      titularEsRegimenSimple: !!b.titularEsRegimenSimple,

      // Solo admiten R (remitente) o D (destinatario).
      codResponsablePagoCargue: b.codResponsablePagoCargue ?? "R",
      codResponsablePagoDescargue: b.codResponsablePagoDescargue ?? "D",
      aceptacionElectronica: b.aceptacionElectronica ?? "NO",
      codMunicipioPagoSaldo: b.codMunicipioPagoSaldo ?? null,

      // La poliza es la misma para toda la empresa: se copia de los parametros y
      // ya no se pide plantilla por plantilla.
      tomadorPolizaCarga: params.tomadorPolizaCarga,
      numeroPolizaTransporte: params.numeroPolizaTransporte,
      companiaSeguro: params.companiaSeguro,
      fechaVencimientoPolizaCarga: params.fechaVencimientoPolizaCarga,
    },
  };
}

catalogoRouter.post("/plantillas", async (req, res) => {
  const r = await plantillaDesdeCuerpo(req.body);
  if ("error" in r) return res.status(422).json({ error: r.error });
  res.status(201).json(await plantillas.create(r.datos));
});

/**
 * Edita una plantilla.
 *
 * Lo que no venga en el cuerpo conserva su valor actual (se mezcla sobre la
 * plantilla guardada), asi un cliente que mande solo algunos campos no borra
 * el resto con los valores por defecto.
 */
catalogoRouter.put("/plantillas/:id", async (req, res) => {
  const actual = await plantillas.findById(Number(req.params.id));
  if (!actual || !actual.activa) {
    return res.status(404).json({ error: "Plantilla no encontrada" });
  }
  const r = await plantillaDesdeCuerpo({ ...actual, ...req.body });
  if ("error" in r) return res.status(422).json({ error: r.error });
  res.json(await plantillas.update(actual.id, r.datos));
});
