/**
 * Carga la base local a partir de datos-empresa.json.
 *
 * Se corre con:  npm run cargar-datos
 *
 * A diferencia del seed de ejemplo, esto no inventa nada: toma los datos reales
 * de la empresa desde un archivo JSON y los deja en la base local para poder
 * despachar. No crea nada en el RNDC; todo lo que se cargue aqui tiene que
 * existir ya alla.
 *
 * Es idempotente: si se corre dos veces, no duplica registros.
 */

import fs from "fs";
import path from "path";
import { initSchema, pool } from "../db";
import { terceros, vehiculos, remolques, conductores, rutas, plantillas } from "../repo";

const RUTA_ARCHIVO = path.resolve(__dirname, "../../datos-empresa.json");

interface ArchivoDatos {
  terceros?: any[];
  vehiculos?: any[];
  remolques?: any[];
  conductores?: any[];
  rutas?: any[];
  plantillas?: any[];
}

function fecha(valor: string | null | undefined): Date | null {
  return valor ? new Date(valor) : null;
}

/** Detecta los "REEMPLAZAR" que quedaron sin llenar. */
function buscarPendientes(objeto: any, ruta: string, encontrados: string[]): void {
  if (typeof objeto === "string") {
    if (objeto.includes("REEMPLAZAR")) encontrados.push(ruta);
    return;
  }
  if (Array.isArray(objeto)) {
    objeto.forEach((v, i) => buscarPendientes(v, `${ruta}[${i}]`, encontrados));
    return;
  }
  if (objeto && typeof objeto === "object") {
    for (const [k, v] of Object.entries(objeto)) {
      if (k === "_ayuda") continue;
      buscarPendientes(v, ruta ? `${ruta}.${k}` : k, encontrados);
    }
  }
}

async function main() {
  if (!fs.existsSync(RUTA_ARCHIVO)) {
    console.error(
      [
        "",
        `No encontre ${RUTA_ARCHIVO}`,
        "",
        "Copia la plantilla y llenala con los datos de tu empresa:",
        "  cp datos-empresa.example.json datos-empresa.json",
        "",
      ].join("\n")
    );
    process.exit(1);
  }

  let datos: ArchivoDatos;
  try {
    datos = JSON.parse(fs.readFileSync(RUTA_ARCHIVO, "utf8"));
  } catch (exc) {
    console.error(`El archivo no es JSON valido: ${(exc as Error).message}`);
    process.exit(1);
  }

  const pendientes: string[] = [];
  buscarPendientes(datos, "", pendientes);
  if (pendientes.length > 0) {
    console.error("\nQuedaron campos sin llenar (dicen REEMPLAZAR):\n");
    for (const p of pendientes) console.error(`  - ${p}`);
    console.error("\nCompletalos y vuelve a correr el comando.\n");
    process.exit(1);
  }

  await initSchema();
  console.log("Esquema listo. Cargando datos...\n");

  // --- Terceros ---
  const existentesTerceros = await terceros.findMany();
  const claveTercero = (nit: string, sede: string) => `${nit}|${sede}`;
  const mapaTerceros = new Map(
    existentesTerceros.map((t) => [claveTercero(t.nit, t.codSede), t])
  );

  for (const t of datos.terceros ?? []) {
    const clave = claveTercero(t.nit, t.codSede ?? "0");
    if (mapaTerceros.has(clave)) {
      console.log(`  = tercero ${t.nombre} (sede ${t.codSede}) ya existia`);
      continue;
    }
    const creado = await terceros.create({
      nit: t.nit,
      nombre: t.nombre,
      direccion: t.direccion ?? null,
      ciudad: t.ciudad ?? null,
      telefono: t.telefono ?? null,
      rol: t.rol ?? null,
      codTipoId: t.codTipoId ?? "N",
      codSede: t.codSede ?? "0",
      latitud: t.latitud ?? null,
      longitud: t.longitud ?? null,
    });
    mapaTerceros.set(clave, creado);
    console.log(`  + tercero ${creado.nombre} (sede ${creado.codSede})`);
  }

  // --- Vehiculos ---
  const existentesVehiculos = await vehiculos.findMany();
  const placasVehiculo = new Set(existentesVehiculos.map((v) => v.placa.toUpperCase()));
  for (const v of datos.vehiculos ?? []) {
    const placa = String(v.placa).toUpperCase();
    if (placasVehiculo.has(placa)) {
      console.log(`  = vehiculo ${placa} ya existia`);
      continue;
    }
    await vehiculos.create({
      placa,
      placaRemolque: null,
      marca: v.marca ?? null,
      configuracion: v.configuracion ?? null,
      capacidadKg: v.capacidadKg ?? null,
      propietarioNit: v.numIdTenedor ?? null,
      fechaVencSoat: fecha(v.fechaVencSoat),
      fechaVencTecnomecanica: fecha(v.fechaVencTecnomecanica),
      codTipoIdTenedor: v.codTipoIdTenedor ?? "C",
      numIdTenedor: v.numIdTenedor ?? null,
      codTipoCarroceria: v.codTipoCarroceria ?? "0",
      pesoVehiculoVacio: v.pesoVehiculoVacio ?? null,
      aplicaFopat: v.aplicaFopat ?? true,
    });
    console.log(`  + vehiculo ${placa}`);
  }

  // --- Remolques ---
  const existentesRemolques = await remolques.findMany();
  const placasRemolque = new Set(existentesRemolques.map((r) => r.placa.toUpperCase()));
  for (const r of datos.remolques ?? []) {
    const placa = String(r.placa).toUpperCase();
    if (placasRemolque.has(placa)) {
      console.log(`  = remolque ${placa} ya existia`);
      continue;
    }
    await remolques.create({
      placa,
      numEjes: r.numEjes ?? null,
      capacidadKg: r.capacidadKg ?? null,
      fechaVencSoat: fecha(r.fechaVencSoat),
      fechaVencTecnomecanica: fecha(r.fechaVencTecnomecanica),
    });
    console.log(`  + remolque ${placa}`);
  }

  // --- Conductores ---
  const existentesConductores = await conductores.findMany();
  const cedulas = new Set(existentesConductores.map((c) => c.cedula));
  for (const c of datos.conductores ?? []) {
    if (cedulas.has(String(c.cedula))) {
      console.log(`  = conductor ${c.nombre} ya existia`);
      continue;
    }
    await conductores.create({
      cedula: String(c.cedula),
      nombre: c.nombre,
      licencia: c.licencia ?? null,
      categoriaLicencia: c.categoriaLicencia ?? null,
      fechaVencLicencia: fecha(c.fechaVencLicencia),
      codTipoId: c.codTipoId ?? "C",
    });
    console.log(`  + conductor ${c.nombre}`);
  }

  // --- Rutas ---
  const existentesRutas = await rutas.findMany();
  const claveRuta = (o: string | null, d: string | null) => `${o}->${d}`;
  const mapaRutas = new Map(
    existentesRutas.map((r) => [claveRuta(r.codigoOrigenRndc, r.codigoDestinoRndc), r])
  );
  for (const r of datos.rutas ?? []) {
    const clave = claveRuta(r.codigoOrigenRndc, r.codigoDestinoRndc);
    if (mapaRutas.has(clave)) {
      console.log(`  = ruta ${r.ciudadOrigen} -> ${r.ciudadDestino} ya existia`);
      continue;
    }
    const creada = await rutas.create({
      ciudadOrigen: r.ciudadOrigen,
      ciudadDestino: r.ciudadDestino,
      codigoOrigenRndc: r.codigoOrigenRndc,
      codigoDestinoRndc: r.codigoDestinoRndc,
      distanciaKm: r.distanciaKm ?? null,
      codVia: r.codVia ?? null,
    });
    mapaRutas.set(clave, creada);
    console.log(`  + ruta ${creada.ciudadOrigen} -> ${creada.ciudadDestino}`);
  }

  // --- Plantillas ---
  const existentesPlantillas = await plantillas.findMany();
  const nombresPlantilla = new Set(existentesPlantillas.map((p) => p.nombre));

  for (const p of datos.plantillas ?? []) {
    if (nombresPlantilla.has(p.nombre)) {
      console.log(`  = plantilla "${p.nombre}" ya existia`);
      continue;
    }

    const contratante = mapaTerceros.get(claveTercero(p.contratanteNit, p.contratanteSede ?? "0"));
    const remitente = mapaTerceros.get(claveTercero(p.remitenteNit, p.remitenteSede ?? "0"));
    const destinatario = mapaTerceros.get(
      claveTercero(p.destinatarioNit, p.destinatarioSede ?? "0")
    );
    const ruta = mapaRutas.get(claveRuta(p.rutaOrigen, p.rutaDestino));

    const faltan: string[] = [];
    if (!contratante) faltan.push(`contratante ${p.contratanteNit} sede ${p.contratanteSede}`);
    if (!remitente) faltan.push(`remitente ${p.remitenteNit} sede ${p.remitenteSede}`);
    if (!destinatario) faltan.push(`destinatario ${p.destinatarioNit} sede ${p.destinatarioSede}`);
    if (!ruta) faltan.push(`ruta ${p.rutaOrigen} -> ${p.rutaDestino}`);
    if (faltan.length > 0) {
      console.error(`  ! plantilla "${p.nombre}" no se pudo crear. No encontre: ${faltan.join(", ")}`);
      console.error(`    Revisa que esten en las listas de terceros y rutas del mismo archivo.`);
      continue;
    }

    const codigo = String(p.codMercancia).replace(/\D/g, "");
    if (codigo.length !== 4 && codigo.length !== 6) {
      console.error(
        `  ! plantilla "${p.nombre}": codMercancia "${p.codMercancia}" debe tener 4 o 6 digitos`
      );
      continue;
    }

    await plantillas.create({
      nombre: p.nombre,
      contratanteId: contratante!.id,
      remitenteId: remitente!.id,
      destinatarioId: destinatario!.id,
      rutaId: ruta!.id,
      tipoMercancia: String(p.descripcionProducto).slice(0, 60),
      tipoOperacionRemesa: "G",
      tipoManifiesto: p.tipoManifiesto ?? "G",
      codMunicipioIntermedio: p.codMunicipioIntermedio ?? null,
      codNaturalezaCarga: "1",
      codUnidadMedida: "1",
      codTipoEmpaque: p.codTipoEmpaque ?? "0",
      empaquePrimario: p.empaquePrimario ?? null,
      codMercancia: codigo.length === 4 ? `00${codigo}` : codigo,
      subpartidaCode: p.subpartidaCode ?? null,
      codigoArancelCode: p.codigoArancelCode ?? null,
      unidadMedidaProducto: p.unidadMedidaProducto ?? "KGM",
      horasPactoCargue: p.horasPactoCargue ?? 1,
      minutosPactoCargue: p.minutosPactoCargue ?? 0,
      horasPactoDescargue: p.horasPactoDescargue ?? 1,
      minutosPactoDescargue: p.minutosPactoDescargue ?? 0,
      retencionIcaManifiesto: p.retencionIca ?? 0,
      tarifaRetencionFuente: p.tarifaRetencionFuente ?? 0.01,
      titularEsRegimenSimple: p.titularEsRegimenSimple ?? false,
      codResponsablePagoCargue: p.responsablePagoCargue ?? "R",
      codResponsablePagoDescargue: p.responsablePagoDescargue ?? "D",
      aceptacionElectronica: p.aceptacionElectronica ?? "NO",
      codMunicipioPagoSaldo: p.codMunicipioPagoSaldo ?? null,
      tomadorPolizaCarga: "Empresa Transporte",
      numeroPolizaTransporte: p.numeroPolizaTransporte ?? null,
      companiaSeguro: p.companiaSeguro ?? null,
      fechaVencimientoPolizaCarga: fecha(p.fechaVencimientoPolizaCarga),
    });
    console.log(`  + plantilla "${p.nombre}"`);
  }

  console.log("\nListo. Siguiente paso: npm run verificar\n");
  await pool.end();
}

main().catch(async (err) => {
  console.error("\nError al cargar los datos:", err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
