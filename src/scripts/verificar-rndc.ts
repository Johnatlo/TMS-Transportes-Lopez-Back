/**
 * Verificacion previa contra el RNDC.
 *
 * Se corre con:  npm run verificar
 *
 * Comprueba, en orden, lo que tiene que estar bien ANTES de intentar expedir un
 * documento. Cada paso que falla se explica en vez de dejar un error suelto.
 *
 * No escribe nada: solo hace consultas de lectura.
 */

import { config, describirAmbiente } from "../config";
import { RndcClient } from "../rndc/client";
import { CredencialesRndc } from "../rndc/builders";
import { consultarPlaca, probarAcceso } from "../rndc/consultas";
import { vehiculos } from "../repo";

const LINEA = "-".repeat(72);

function titulo(texto: string): void {
  console.log(`\n${LINEA}\n${texto}\n${LINEA}`);
}

function ok(texto: string): void {
  console.log(`  [OK]    ${texto}`);
}
function falla(texto: string): void {
  console.log(`  [FALLA] ${texto}`);
}
function nota(texto: string): void {
  console.log(`          ${texto}`);
}

async function main() {
  titulo("1. Configuracion local");

  console.log(`  ${describirAmbiente()}`);

  if (config.rndc.simular) {
    falla(
      "RNDC_SIMULAR=true: no se va a contactar al Ministerio. Ponlo en false para verificar de verdad."
    );
    process.exit(1);
  }

  if (config.rndc.esProduccion) {
    console.log("");
    console.log("  *** Estas apuntando a PRODUCCION. Esta verificacion solo lee datos,");
    console.log("  *** pero revisa que sea lo que querias antes de seguir con el despacho.");
    console.log("");
  }

  const faltantes: string[] = [];
  if (!config.rndc.usuario) faltantes.push("RNDC_USUARIO");
  if (!config.rndc.password) faltantes.push("RNDC_PASSWORD");
  if (!config.rndc.empresaNit) faltantes.push("RNDC_EMPRESA_NIT");
  if (faltantes.length > 0) {
    falla(`Faltan variables en el .env: ${faltantes.join(", ")}`);
    process.exit(1);
  }
  ok(`Usuario ${config.rndc.usuario}, NIT ${config.rndc.empresaNit}`);

  const credenciales: CredencialesRndc = {
    usuario: config.rndc.usuario,
    password: config.rndc.password,
    nitEmpresa: config.rndc.empresaNit,
  };
  const cliente = new RndcClient({
    wsdlUrl: config.rndc.wsdlUrl,
    usuario: config.rndc.usuario,
    password: config.rndc.password,
    simular: false,
    reintentos: config.rndc.reintentos,
  });

  // --- 2. Vehiculos registrados localmente ---
  titulo("2. Vehiculos en la base local");

  let flota: Awaited<ReturnType<typeof vehiculos.findMany>> = [];
  try {
    flota = (await vehiculos.findMany()).filter((v) => v.activo);
  } catch (exc) {
    falla(`No se pudo leer la base de datos local: ${(exc as Error).message}`);
    nota("Revisa las variables DB_* del .env y que MySQL este arriba.");
    process.exit(1);
  }

  if (flota.length === 0) {
    falla("No hay vehiculos activos en la base local. Carga al menos uno antes de verificar.");
    process.exit(1);
  }
  ok(`${flota.length} vehiculo(s) activo(s): ${flota.map((v) => v.placa).join(", ")}`);

  // --- 3. Conexion y credenciales ---
  titulo("3. Conexion con el RNDC");
  console.log(`  WSDL: ${config.rndc.wsdlUrl}`);

  try {
    const acceso = await probarAcceso(cliente, credenciales, flota[0].placa);
    if (acceso.ok) {
      ok(acceso.detalle);
    } else {
      falla(acceso.detalle);
      nota("Recuerda: el usuario y la clave son los MISMOS en pruebas y en produccion.");
      nota("Si la clave es correcta en el portal web, revisa que el usuario sea tipo 1 (dependiente).");
      process.exit(1);
    }
  } catch (exc) {
    falla(`No se pudo contactar al servidor: ${(exc as Error).message}`);
    nota("Verifica que la URL del WSDL abra en el navegador y que no haya un firewall de por medio.");
    process.exit(1);
  }

  // --- 4. Estado de cada placa en el RNA ---
  titulo("4. Estado de las placas en el RNA del RNDC");

  let placasOk = 0;
  for (const v of flota) {
    try {
      const estado = await consultarPlaca(cliente, credenciales, v.placa);
      if (estado.encontrada && !estado.fechaBloqueo) {
        ok(`${v.placa}: ${estado.diagnostico}`);
        placasOk++;
        // El RUNT manda sobre la configuracion: si la local difiere, gana la del RNDC.
        if (estado.codConfiguracion && v.configuracion && estado.codConfiguracion !== v.configuracion) {
          nota(
            `Tu base dice configuracion "${v.configuracion}" pero el RNDC dice ` +
              `"${estado.codConfiguracion}". Corrige la local: manda la del RNDC.`
          );
        }
      } else {
        falla(`${v.placa}: ${estado.diagnostico}`);
      }
    } catch (exc) {
      falla(`${v.placa}: error al consultar (${(exc as Error).message})`);
    }
  }

  // --- Resumen ---
  titulo("Resumen");
  if (placasOk === 0) {
    console.log("  Ninguna placa quedo utilizable. Revisa los mensajes de arriba.");
    process.exit(1);
  }
  console.log(`  ${placasOk} de ${flota.length} placa(s) listas para despachar.`);
  console.log("");
  console.log("  Lo que este script NO puede verificar por ti, y toca revisar en el portal web:");
  console.log("   - Que los vehiculos esten vinculados a tu parque automotor");
  console.log("     (Herramientas -> Vehiculos Remolques).");
  console.log("   - Que los terceros (generador, remitente, destinatario) existan en el");
  console.log("     maestro de terceros CON la sede que vas a usar (Herramientas -> Terceros).");
  console.log("   - Que tu usuario tenga asignado un rango de consecutivos de manifiesto");
  console.log("     (el usuario principal tipo 6 se lo asigna a los tipo 1).");
  console.log("   - Que la habilitacion de la empresa este activa.");
  console.log("");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nError inesperado durante la verificacion:", err);
  process.exit(1);
});
