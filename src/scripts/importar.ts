/**
 * Carga masiva desde archivos CSV.
 *
 * Se corre con:
 *   npm run importar -- <tipo> <archivo.csv>            (revisa, no escribe)
 *   npm run importar -- <tipo> <archivo.csv> --aplicar  (escribe)
 *
 * Tipos: municipios | terceros | vehiculos | conductores | remolques | rutas
 *
 * Por defecto NO escribe nada: valida todo el archivo y muestra el informe.
 * Con 600 terceros, descubrir los errores uno por uno a medida que fallan es
 * insoportable; asi se ven todos de una vez, se corrige el archivo y se aplica.
 *
 * Es idempotente: las filas que ya existen se saltan, no se duplican.
 */

import fs from "fs";
import path from "path";
import { initSchema, pool } from "../db";
import { terceros, vehiculos, conductores, remolques, rutas, municipios, vias } from "../repo";
import { revisarCoordenadaSede } from "../rndc/builders";

// ---------------------------------------------------------------------------
// Lectura de CSV
// ---------------------------------------------------------------------------

/**
 * Lee un CSV sin dependencias externas.
 *
 * Contempla lo que de verdad sale de un Excel colombiano: separador ; o ,
 * (se detecta solo), comillas dobles con comas adentro, comillas escapadas
 * duplicadas, BOM al inicio y saltos de linea de Windows.
 */
function leerCsv(contenido: string): Array<Record<string, string>> {
  const texto = contenido.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  if (!texto) return [];

  // El separador es el que mas aparezca en la primera linea, fuera de comillas.
  const primeraLinea = texto.split("\n")[0];
  const puntoYComa = (primeraLinea.match(/;/g) ?? []).length;
  const comas = (primeraLinea.match(/,/g) ?? []).length;
  const sep = puntoYComa >= comas ? ";" : ",";

  const filas: string[][] = [];
  let campo = "";
  let fila: string[] = [];
  let enComillas = false;

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (enComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else {
          enComillas = false;
        }
      } else {
        campo += c;
      }
    } else if (c === '"') {
      enComillas = true;
    } else if (c === sep) {
      fila.push(campo);
      campo = "";
    } else if (c === "\n") {
      fila.push(campo);
      filas.push(fila);
      fila = [];
      campo = "";
    } else {
      campo += c;
    }
  }
  fila.push(campo);
  filas.push(fila);

  const encabezados = filas[0].map((h) => h.trim());
  return filas.slice(1).map((valores) => {
    const registro: Record<string, string> = {};
    encabezados.forEach((h, i) => (registro[h] = (valores[i] ?? "").trim()));
    return registro;
  });
}

/**
 * Los archivos guardados desde Excel como "CSV (delimitado por comas)" salen en
 * Windows-1252 y las tildes llegan rotas. Se detecta y se reinterpreta.
 */
function leerArchivo(ruta: string): string {
  const bytes = fs.readFileSync(ruta);
  const comoUtf8 = bytes.toString("utf8");
  if (comoUtf8.includes("\uFFFD")) {
    console.log("  (el archivo no estaba en UTF-8; se leyo como Windows-1252)");
    return bytes.toString("latin1");
  }
  return comoUtf8;
}

// ---------------------------------------------------------------------------
// Informe
// ---------------------------------------------------------------------------

interface Problema {
  fila: number;
  mensaje: string;
  grave: boolean;
}

class Informe {
  problemas: Problema[] = [];
  nuevos = 0;
  existentes = 0;
  actualizados = 0;

  error(fila: number, mensaje: string) {
    this.problemas.push({ fila, mensaje, grave: true });
  }
  aviso(fila: number, mensaje: string) {
    this.problemas.push({ fila, mensaje, grave: false });
  }
  get errores() {
    return this.problemas.filter((p) => p.grave);
  }
  get avisos() {
    return this.problemas.filter((p) => !p.grave);
  }
}

// ---------------------------------------------------------------------------
// Validaciones comunes
// ---------------------------------------------------------------------------

const TIPOS_ID = ["C", "N", "E", "P", "T", "D", "U", "X"];

function validarIdentificacion(
  inf: Informe,
  nFila: number,
  tipo: string,
  numero: string,
  etiqueta = "identificacion"
): boolean {
  if (!numero) {
    inf.error(nFila, `Falta el numero de ${etiqueta}`);
    return false;
  }
  if (!/^\d+$/.test(numero)) {
    inf.error(nFila, `La ${etiqueta} "${numero}" debe ser solo digitos, sin puntos ni guiones`);
    return false;
  }
  if (tipo && !TIPOS_ID.includes(tipo.toUpperCase())) {
    inf.aviso(nFila, `Tipo de identificacion "${tipo}" poco comun. Los usuales son C (cedula) y N (NIT)`);
  }
  return true;
}

function limpioTexto(valor: string | undefined): string | null {
  const v = (valor ?? "").trim();
  return v === "" ? null : v;
}

function numeroOpcional(valor: string): number | null {
  if (!valor) return null;
  const n = Number(valor.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function fechaOpcional(inf: Informe, nFila: number, valor: string, campo: string): Date | null {
  if (!valor) return null;
  // Se aceptan AAAA-MM-DD y DD/MM/AAAA, que es como suele salir de Excel.
  let iso = valor;
  const conBarras = valor.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (conBarras) iso = `${conBarras[3]}-${conBarras[2]}-${conBarras[1]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (isNaN(d.getTime())) {
    inf.error(nFila, `La fecha de ${campo} ("${valor}") no se entiende. Usa AAAA-MM-DD`);
    return null;
  }
  return d;
}

// ---------------------------------------------------------------------------
// Importadores
// ---------------------------------------------------------------------------

type Importador = (
  filas: Array<Record<string, string>>,
  aplicar: boolean,
  inf: Informe,
  actualizar: boolean
) => Promise<void>;

const importadores: Record<string, { columnas: string[]; ejecutar: Importador }> = {
  // -------------------------------------------------------------------------
  municipios: {
    columnas: ["codigo", "nombre", "departamento"],
    async ejecutar(filas, aplicar, inf) {
      const existentes = new Set((await municipios.findMany()).map((m) => m.codigo));
      const lote: Array<{ codigo: string; nombre: string; departamento: string }> = [];

      for (const [i, f] of filas.entries()) {
        const nFila = i + 2;
        const codigo = f.codigo?.replace(/\D/g, "");
        if (!codigo) {
          inf.error(nFila, "Falta el codigo del municipio");
          continue;
        }
        // DIVIPOLA del RNDC: 5 del municipio + 3 del centro poblado.
        if (codigo.length !== 8) {
          inf.error(
            nFila,
            `El codigo "${f.codigo}" tiene ${codigo.length} digitos y deben ser 8 ` +
              `(5 del municipio + 3 del centro poblado, 000 para la cabecera)`
          );
          continue;
        }
        if (!f.nombre) {
          inf.error(nFila, "Falta el nombre del municipio");
          continue;
        }
        if (existentes.has(codigo)) {
          inf.existentes++;
          continue;
        }
        existentes.add(codigo);
        lote.push({ codigo, nombre: f.nombre, departamento: f.departamento ?? "" });
        inf.nuevos++;
      }

      if (aplicar && lote.length > 0) await municipios.crearLote(lote);
    },
  },

  // -------------------------------------------------------------------------
  terceros: {
    columnas: [
      "nit", "nombre", "codTipoId", "codSede", "direccion",
      "municipio", "codMunicipioRndc", "latitud", "longitud", "telefono", "rol",
    ],
    async ejecutar(filas, aplicar, inf) {
      const existentes = await terceros.findMany();
      const clave = (nit: string, sede: string) => `${nit}|${sede}`;
      const vistos = new Set(existentes.map((t) => clave(t.nit, t.codSede)));

      // Para poder escribir el municipio por nombre en vez de por codigo.
      const catalogo = await municipios.findMany();
      const porNombre = new Map<string, string>();
      for (const m of catalogo) {
        porNombre.set(m.nombre.toUpperCase().trim(), m.codigo);
      }
      const codigosValidos = new Set(catalogo.map((m) => m.codigo));

      for (const [i, f] of filas.entries()) {
        const nFila = i + 2;
        const nit = f.nit?.replace(/\D/g, "");
        const codTipoId = (f.codTipoId || "N").toUpperCase();
        const codSede = f.codSede || "0";

        if (!validarIdentificacion(inf, nFila, codTipoId, nit, "identificacion del tercero")) continue;
        if (!f.nombre) {
          inf.error(nFila, "Falta el nombre del tercero");
          continue;
        }

        if (vistos.has(clave(nit, codSede))) {
          inf.existentes++;
          continue;
        }

        // Municipio: por codigo si viene, si no por nombre contra el catalogo.
        let codMunicipio: string | null = f.codMunicipioRndc?.replace(/\D/g, "") || null;
        if (codMunicipio && codMunicipio.length !== 8) {
          inf.error(nFila, `El codigo de municipio "${f.codMunicipioRndc}" debe tener 8 digitos`);
          continue;
        }
        if (!codMunicipio && f.municipio) {
          if (catalogo.length === 0) {
            inf.aviso(
              nFila,
              "Escribiste el municipio por nombre pero no hay catalogo cargado. " +
                "Importa primero los municipios, o usa codMunicipioRndc"
            );
          } else {
            codMunicipio = porNombre.get(f.municipio.toUpperCase().trim()) ?? null;
            if (!codMunicipio) {
              inf.error(
                nFila,
                `No encontre el municipio "${f.municipio}" en el catalogo. ` +
                  `Revisa como esta escrito o pon el codigo en codMunicipioRndc`
              );
              continue;
            }
          }
        }
        if (codMunicipio && codigosValidos.size > 0 && !codigosValidos.has(codMunicipio)) {
          inf.aviso(nFila, `El codigo de municipio ${codMunicipio} no esta en el catalogo`);
        }

        const latitud = numeroOpcional(f.latitud);
        const longitud = numeroOpcional(f.longitud);
        const revision = revisarCoordenadaSede(latitud, longitud, `${f.nombre} (sede ${codSede})`);
        if (!revision.ok && revision.problema) {
          inf.aviso(nFila, revision.problema);
        }

        vistos.add(clave(nit, codSede));
        inf.nuevos++;

        if (aplicar) {
          await terceros.create({
            nit,
            nombre: f.nombre,
            direccion: f.direccion || null,
            ciudad: f.municipio || null,
            telefono: f.telefono || null,
            rol: f.rol || null,
            codTipoId,
            codSede,
            latitud,
            longitud,
            codMunicipioRndc: codMunicipio,
          });
        }
      }
    },
  },

  // -------------------------------------------------------------------------
  vehiculos: {
    columnas: [
      "placa", "marca", "configuracion", "capacidadKg", "pesoVehiculoVacio",
      "codTipoIdTenedor", "numIdTenedor", "fechaVencSoat", "fechaVencTecnomecanica",
    ],
    async ejecutar(filas, aplicar, inf, actualizar) {
      const vistos = new Set((await vehiculos.findMany()).map((v) => v.placa.toUpperCase()));

      for (const [i, f] of filas.entries()) {
        const nFila = i + 2;
        const placa = f.placa?.toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (!placa || placa.length < 5 || placa.length > 7) {
          inf.error(nFila, `La placa "${f.placa}" no parece valida`);
          continue;
        }
        const soatPrevio = fechaOpcional(inf, nFila, f.fechaVencSoat, "vencimiento del SOAT");
        const rtmPrevio = fechaOpcional(
          inf, nFila, f.fechaVencTecnomecanica, "vencimiento de la tecnomecanica"
        );

        if (vistos.has(placa)) {
          if (!actualizar) {
            inf.existentes++;
            continue;
          }
          inf.actualizados++;
          if (aplicar) {
            await vehiculos.actualizarPorPlaca(placa, {
              fechaVencSoat: soatPrevio,
              fechaVencTecnomecanica: rtmPrevio,
              configuracion: f.configuracion || null,
              pesoVehiculoVacio: numeroOpcional(f.pesoVehiculoVacio),
            });
          }
          continue;
        }
        const codTipoIdTenedor = (f.codTipoIdTenedor || "C").toUpperCase();
        const numIdTenedor = f.numIdTenedor?.replace(/\D/g, "") || null;
        if (!numIdTenedor) {
          // Sin tenedor no hay titular de manifiesto y el despacho falla.
          inf.error(nFila, `El vehiculo ${placa} no tiene tenedor, y ese es el titular del manifiesto`);
          continue;
        }

        const soat = fechaOpcional(inf, nFila, f.fechaVencSoat, "vencimiento del SOAT");
        const rtm = fechaOpcional(inf, nFila, f.fechaVencTecnomecanica, "vencimiento de la tecnomecanica");
        const hoy = new Date();
        if (soat && soat < hoy) inf.aviso(nFila, `El SOAT de ${placa} ya esta vencido`);
        if (rtm && rtm < hoy) inf.aviso(nFila, `La tecnomecanica de ${placa} ya esta vencida`);

        vistos.add(placa);
        inf.nuevos++;

        if (aplicar) {
          await vehiculos.create({
            placa,
            placaRemolque: null,
            marca: f.marca || null,
            configuracion: f.configuracion || null,
            capacidadKg: numeroOpcional(f.capacidadKg),
            propietarioNit: numIdTenedor,
            fechaVencSoat: soat,
            fechaVencTecnomecanica: rtm,
            codTipoIdTenedor,
            numIdTenedor,
            codTipoCarroceria: "0",
            pesoVehiculoVacio: numeroOpcional(f.pesoVehiculoVacio),
          });
        }
      }
    },
  },

  // -------------------------------------------------------------------------
  conductores: {
    columnas: ["cedula", "nombre", "codTipoId", "licencia", "categoriaLicencia", "fechaVencLicencia"],
    async ejecutar(filas, aplicar, inf, actualizar) {
      const vistos = new Set((await conductores.findMany()).map((c) => c.cedula));

      for (const [i, f] of filas.entries()) {
        const nFila = i + 2;
        const cedula = f.cedula?.replace(/\D/g, "");
        const codTipoId = (f.codTipoId || "C").toUpperCase();
        if (!validarIdentificacion(inf, nFila, codTipoId, cedula, "cedula del conductor")) continue;
        if (!f.nombre) {
          inf.error(nFila, "Falta el nombre del conductor");
          continue;
        }
        const venc = fechaOpcional(inf, nFila, f.fechaVencLicencia, "vencimiento de la licencia");
        if (venc && venc < new Date()) {
          inf.aviso(nFila, `La licencia de ${f.nombre} ya esta vencida`);
        }

        if (vistos.has(cedula)) {
          // Con --actualizar se refresca la licencia en vez de saltar la fila.
          // Es lo que permite reimportar el Maestro de Terceros del RNDC para
          // mantener al dia las alertas de vencimiento.
          if (!actualizar) {
            inf.existentes++;
            continue;
          }
          inf.actualizados++;
          if (aplicar) {
            await conductores.actualizarPorCedula(cedula, {
              licencia: f.licencia || null,
              categoriaLicencia: f.categoriaLicencia || null,
              fechaVencLicencia: venc,
              nombre: f.nombre || null,
            });
          }
          continue;
        }

        vistos.add(cedula);
        inf.nuevos++;

        if (aplicar) {
          await conductores.create({
            cedula,
            nombre: f.nombre,
            licencia: f.licencia || null,
            categoriaLicencia: f.categoriaLicencia || null,
            fechaVencLicencia: venc,
            codTipoId,
          });
        }
      }
    },
  },

  // -------------------------------------------------------------------------
  remolques: {
    columnas: ["placa", "numEjes", "capacidadKg", "fechaVencTecnomecanica"],
    async ejecutar(filas, aplicar, inf) {
      const vistos = new Set((await remolques.findMany()).map((r) => r.placa.toUpperCase()));

      for (const [i, f] of filas.entries()) {
        const nFila = i + 2;
        const placa = f.placa?.toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (!placa) {
          inf.error(nFila, "Falta la placa del remolque");
          continue;
        }
        if (vistos.has(placa)) {
          inf.existentes++;
          continue;
        }
        vistos.add(placa);
        inf.nuevos++;

        if (aplicar) {
          await remolques.create({
            placa,
            numEjes: numeroOpcional(f.numEjes),
            capacidadKg: numeroOpcional(f.capacidadKg),
            fechaVencSoat: null,
            fechaVencTecnomecanica: fechaOpcional(
              inf, nFila, f.fechaVencTecnomecanica, "vencimiento de la tecnomecanica"
            ),
          });
        }
      }
    },
  },

  // -------------------------------------------------------------------------
  vias: {
    columnas: [
      "codVia", "codMunicipioOrigen", "codMunicipioDestino", "descripcion",
      "valorSicetac", "esEstandar",
    ],
    async ejecutar(filas, aplicar, inf) {
      for (const [i, f] of filas.entries()) {
        const nFila = i + 2;
        const codVia = limpioTexto(f.codVia);
        const origen = f.codMunicipioOrigen?.replace(/\D/g, "").padStart(8, "0");
        const destino = f.codMunicipioDestino?.replace(/\D/g, "").padStart(8, "0");

        if (!codVia) {
          inf.error(nFila, "Falta el codigo de via (CODVIA)");
          continue;
        }
        if (origen?.length !== 8 || destino?.length !== 8) {
          inf.error(nFila, "Origen y destino deben ser codigos DIVIPOLA de 8 digitos");
          continue;
        }
        if (!limpioTexto(f.descripcion)) {
          inf.error(
            nFila,
            "Falta la descripcion de la via. Copiala tal cual del desplegable del portal " +
              "para poder reconocerla despues"
          );
          continue;
        }

        inf.nuevos++;
        if (aplicar) {
          await vias.guardar({
            codVia,
            codMunicipioOrigen: origen,
            codMunicipioDestino: destino,
            descripcion: f.descripcion,
            valorSicetac: numeroOpcional(f.valorSicetac),
            esEstandar: ["1", "si", "SI", "true"].includes((f.esEstandar ?? "").trim()),
          });
        }
      }
    },
  },

  // -------------------------------------------------------------------------
  rutas: {
    columnas: ["ciudadOrigen", "codigoOrigenRndc", "ciudadDestino", "codigoDestinoRndc", "distanciaKm"],
    async ejecutar(filas, aplicar, inf) {
      const clave = (o: string | null, d: string | null) => `${o}->${d}`;
      const vistos = new Set(
        (await rutas.findMany()).map((r) => clave(r.codigoOrigenRndc, r.codigoDestinoRndc))
      );

      for (const [i, f] of filas.entries()) {
        const nFila = i + 2;
        const origen = f.codigoOrigenRndc?.replace(/\D/g, "");
        const destino = f.codigoDestinoRndc?.replace(/\D/g, "");
        if (origen?.length !== 8 || destino?.length !== 8) {
          inf.error(nFila, "Origen y destino deben ser codigos DIVIPOLA de 8 digitos");
          continue;
        }
        if (vistos.has(clave(origen, destino))) {
          inf.existentes++;
          continue;
        }
        vistos.add(clave(origen, destino));
        inf.nuevos++;

        if (aplicar) {
          await rutas.create({
            ciudadOrigen: f.ciudadOrigen || origen,
            ciudadDestino: f.ciudadDestino || destino,
            codigoOrigenRndc: origen,
            codigoDestinoRndc: destino,
            distanciaKm: numeroOpcional(f.distanciaKm),
            codVia: null,
          });
        }
      }
    },
  },
};

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const tipo = args[0];
  const archivo = args[1];
  const aplicar = args.includes("--aplicar");
  // Refresca fechas de documentos en registros que ya existen, en vez de
  // saltarlos. Solo tiene efecto en conductores y vehiculos.
  const actualizar = args.includes("--actualizar");

  if (!tipo || !archivo || !importadores[tipo]) {
    console.log(`
Carga masiva desde CSV.

  npm run importar -- <tipo> <archivo.csv>             revisa el archivo, no escribe
  npm run importar -- <tipo> <archivo.csv> --aplicar   escribe en la base
  npm run importar -- <tipo> <archivo.csv> --aplicar --actualizar
                                                      ademas refresca fechas de
                                                      documentos ya existentes

Tipos disponibles: ${Object.keys(importadores).join(", ")}

Hay un CSV de ejemplo por cada tipo en la carpeta plantillas-csv/.
`);
    process.exit(1);
  }

  if (!fs.existsSync(archivo)) {
    console.error(`No encontre el archivo ${path.resolve(archivo)}`);
    process.exit(1);
  }

  const filas = leerCsv(leerArchivo(archivo));
  if (filas.length === 0) {
    console.error("El archivo no tiene filas de datos.");
    process.exit(1);
  }

  const columnasEsperadas = importadores[tipo].columnas;
  const columnasArchivo = Object.keys(filas[0]);
  const faltantes = columnasEsperadas.filter(
    (c) => !columnasArchivo.includes(c) && ["nit", "placa", "cedula", "codigo"].includes(c)
  );
  if (faltantes.length > 0) {
    console.error(`\nAl archivo le faltan columnas obligatorias: ${faltantes.join(", ")}`);
    console.error(`Columnas esperadas: ${columnasEsperadas.join(", ")}`);
    console.error(`Columnas encontradas: ${columnasArchivo.join(", ")}\n`);
    process.exit(1);
  }

  await initSchema();

  console.log(`\n${aplicar ? "APLICANDO" : "REVISANDO (no se escribe nada)"}: ${tipo}`);
  console.log(`Archivo: ${path.resolve(archivo)}`);
  console.log(`Filas de datos: ${filas.length}\n`);

  const inf = new Informe();
  await importadores[tipo].ejecutar(filas, aplicar, inf, actualizar);

  if (inf.errores.length > 0) {
    console.log(`ERRORES (${inf.errores.length}) -- estas filas no se cargan:`);
    for (const p of inf.errores) console.log(`  Fila ${p.fila}: ${p.mensaje}`);
    console.log("");
  }
  if (inf.avisos.length > 0) {
    console.log(`AVISOS (${inf.avisos.length}) -- se cargan igual, pero revisalos:`);
    for (const p of inf.avisos.slice(0, 40)) console.log(`  Fila ${p.fila}: ${p.mensaje}`);
    if (inf.avisos.length > 40) console.log(`  ... y ${inf.avisos.length - 40} mas`);
    console.log("");
  }

  console.log("RESUMEN");
  console.log(`  Nuevos:      ${inf.nuevos}`);
  if (actualizar) {
    console.log(`  Actualizados: ${inf.actualizados}`);
  } else {
    console.log(`  Ya existian:  ${inf.existentes}`);
  }
  console.log(`  Con error:    ${inf.errores.length}`);
  if (!actualizar && inf.existentes > 0 && ["conductores", "vehiculos"].includes(tipo)) {
    console.log(
      `\n  ${inf.existentes} registro(s) ya existian y se saltaron. Si lo que quieres es ` +
        `refrescar\n  sus fechas de vencimiento, agrega --actualizar.`
    );
  }

  if (!aplicar) {
    console.log(`
No se escribio nada. Si el informe se ve bien, repite con --aplicar:
  npm run importar -- ${tipo} ${archivo} --aplicar
`);
  } else {
    console.log(`\nListo. Se cargaron ${inf.nuevos} registro(s).\n`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error("\nError durante la importacion:", err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
