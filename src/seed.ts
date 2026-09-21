import { initSchema } from "./db";
import { vehiculos, conductores, terceros, rutas, plantillas, remolques } from "./repo";

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
    // PBV > 10.5 t, asi que el manifiesto lleva aporte FOPAT.
    aplicaFopat: true,
  });

  const conductor = await conductores.create({
    cedula: "123456789",
    nombre: "Juan Perez",
    licencia: null,
    categoriaLicencia: null,
    fechaVencLicencia: new Date("2027-01-01"),
    codTipoId: "C",
  });

  const remolque = await remolques.create({
    placa: "R37108",
    numEjes: 3,
    capacidadKg: null,
    fechaVencSoat: new Date("2027-01-01"),
    fechaVencTecnomecanica: new Date("2027-01-01"),
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
    // Sin via explicita: el RNDC asigna la via estandar de SICETAC.
    codVia: null,
  });

  const plantilla = await plantillas.create({
    nombre: "Cliente Ejemplo - Bogota->Cali",
    contratanteId: cliente.id,
    remitenteId: cliente.id,
    destinatarioId: cliente.id,
    rutaId: ruta.id,
    // tipoMercancia es el texto que viaja como DESCRIPCIONCORTAPRODUCTO
    // (obligatorio en carga general, maximo 60 caracteres).
    tipoMercancia: "PAPEL Y CARTON PARA RECICLAJE",
    naturalezaCarga: null,
    unidadMedida: null,
    observaciones: null,
    // Dos tipos distintos, aunque aqui coincidan en "G".
    tipoOperacionRemesa: "G",
    tipoManifiesto: "G",
    codMunicipioIntermedio: null,
    codNaturalezaCarga: "1", // carga general
    codUnidadMedida: "1",
    codTipoEmpaque: "0",
    // Partida 4707 = papel y carton para reciclar. Se guarda con los dos ceros
    // a la izquierda que exige el RNDC.
    codMercancia: "004707",
    subpartidaCode: null,
    codigoArancelCode: null,
    empaquePrimario: null,
    unidadMedidaProducto: "KGM",
    horasPactoCargue: 1,
    minutosPactoCargue: 0,
    horasPactoDescargue: 1,
    minutosPactoDescargue: 0,
    retencionIcaManifiesto: 0,
    tarifaRetencionFuente: 0.01,
    titularEsRegimenSimple: false,
    codResponsablePagoCargue: "R", // remitente
    codResponsablePagoDescargue: "D", // destinatario
    aceptacionElectronica: "NO",
    codMunicipioPagoSaldo: null,
    // Datos internos de la poliza: no se envian al RNDC.
    tomadorPolizaCarga: "Empresa Transporte",
    numeroPolizaTransporte: "900001238395",
    companiaSeguro: "SBS SEGUROS",
    fechaVencimientoPolizaCarga: new Date("2027-01-01"),
  });

  console.log("Seed cargado:", {
    vehiculo: vehiculo.placa,
    remolque: remolque.placa,
    conductor: conductor.nombre,
    plantilla: plantilla.nombre,
  });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
