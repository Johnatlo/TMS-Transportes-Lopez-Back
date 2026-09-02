import { initSchema } from "./db";
import { vehiculos, conductores, terceros, rutas, plantillas } from "./repo";

async function main() {
  await initSchema();

  const existentes = await vehiculos.findMany();
  if (existentes.some((v) => v.placa === "ABC123")) {
    console.log("El seed ya fue cargado antes (ABC123 ya existe). No se duplica.");
    process.exit(0);
  }

  const vehiculo = await vehiculos.create({
    placa: "ABC123",
    placaRemolque: null,
    marca: null,
    configuracion: "2 ejes",
    capacidadKg: null,
    propietarioNit: null,
    fechaVencSoat: new Date("2027-01-01"),
    fechaVencTecnomecanica: new Date("2027-01-01"),
  });

  const conductor = await conductores.create({
    cedula: "123456789",
    nombre: "Juan Perez",
    licencia: null,
    categoriaLicencia: null,
    fechaVencLicencia: new Date("2027-01-01"),
  });

  const cliente = await terceros.create({
    nit: "900111222",
    nombre: "Cliente Ejemplo S.A.S.",
    direccion: null,
    ciudad: "Bogota",
    telefono: null,
    rol: "CONTRATANTE",
  });

  const ruta = await rutas.create({
    ciudadOrigen: "Bogota",
    ciudadDestino: "Medellin",
    codigoOrigenRndc: null,
    codigoDestinoRndc: null,
    distanciaKm: 415,
  });

  const plantilla = await plantillas.create({
    nombre: "Cliente Ejemplo - Bogota->Medellin",
    contratanteId: cliente.id,
    remitenteId: cliente.id,
    destinatarioId: cliente.id,
    rutaId: ruta.id,
    tipoMercancia: "General",
    naturalezaCarga: null,
    unidadMedida: null,
    valorFleteBase: 500000,
    observaciones: null,
  });

  console.log("Seed cargado:", {
    vehiculo: vehiculo.placa,
    conductor: conductor.nombre,
    plantilla: plantilla.nombre,
  });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
