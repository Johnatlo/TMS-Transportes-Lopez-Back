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
    codTipoIdTenedor: "N",
    numIdTenedor: "900111222",
    codTipoCarroceria: "0",
    pesoVehiculoVacio: 8000,
  });

  const conductor = await conductores.create({
    cedula: "123456789",
    nombre: "Juan Perez",
    licencia: null,
    categoriaLicencia: null,
    fechaVencLicencia: new Date("2027-01-01"),
    codTipoId: "C",
  });

  const cliente = await terceros.create({
    nit: "900111222",
    nombre: "Cliente Ejemplo S.A.S.",
    direccion: null,
    ciudad: "Bogota",
    telefono: null,
    rol: "CONTRATANTE",
    codTipoId: "N",
    codSede: "0",
  });

  // Codigos de municipio RNDC confirmados en el manual oficial (pag. 13, 15):
  // Bogota D.C. = 11001000, Cali = 76001000.
  const ruta = await rutas.create({
    ciudadOrigen: "Bogota",
    ciudadDestino: "Cali",
    codigoOrigenRndc: "11001000",
    codigoDestinoRndc: "76001000",
    distanciaKm: 461,
  });

  const plantilla = await plantillas.create({
    nombre: "Cliente Ejemplo - Bogota->Cali",
    contratanteId: cliente.id,
    remitenteId: cliente.id,
    destinatarioId: cliente.id,
    rutaId: ruta.id,
    tipoMercancia: "Carga general de prueba",
    naturalezaCarga: null,
    unidadMedida: null,
    valorFleteBase: 500000,
    observaciones: null,
    codOperacionTransporte: "G",
    codNaturalezaCarga: "1",
    codUnidadMedida: "1",
    codTipoEmpaque: "0",
    codMercancia: null,
    horasPactoCargue: 1,
    minutosPactoCargue: 0,
    horasPactoDescargue: 1,
    minutosPactoDescargue: 0,
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
