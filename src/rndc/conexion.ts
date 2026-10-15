/**
 * Credenciales y clientes del RNDC armados desde la configuracion, para no
 * repetirlos en cada ruta. Tres clientes:
 *
 * - clienteRegistro: expide, cumple y anula (servidor del ambiente). Respeta
 *   la simulacion (RNDC_SIMULAR).
 * - clienteLectura: consultas de solo lectura (tipo 3/6) al mismo servidor.
 *   soloConsultas bloquea cualquier mensaje que registre algo.
 * - clienteSicetac: consultas de SICETAC al servidor de consultas
 *   (config.rndc.consultasWsdlUrl), tambien solo lectura.
 *
 * Las lecturas no simulan por defecto (se usan solo cuando no hay simulacion);
 * quien quiera respetar RNDC_SIMULAR pasa simular = config.rndc.simular.
 */
import { config } from "../config";
import type { CredencialesRndc } from "./builders";
import { RndcClient } from "./client";

/** Usuario, clave y NIT de la empresa ante el RNDC. */
export function credencialesRndc(): CredencialesRndc {
  return { usuario: config.rndc.usuario, password: config.rndc.password, nitEmpresa: config.rndc.empresaNit };
}

/** Cliente que registra documentos (expedir, cumplir, anular). */
export function clienteRegistro(): RndcClient {
  return new RndcClient({
    wsdlUrl: config.rndc.wsdlUrl,
    usuario: config.rndc.usuario,
    password: config.rndc.password,
    simular: config.rndc.simular,
    reintentos: config.rndc.reintentos,
  });
}

/** Cliente de solo lectura contra el servidor del ambiente. */
export function clienteLectura(simular = false): RndcClient {
  return new RndcClient({
    wsdlUrl: config.rndc.wsdlUrl,
    usuario: config.rndc.usuario,
    password: config.rndc.password,
    simular,
    reintentos: config.rndc.reintentos,
    soloConsultas: true,
  });
}

/** Cliente de solo lectura contra el servidor de consultas (SICETAC). */
export function clienteSicetac(simular = false): RndcClient {
  return new RndcClient({
    wsdlUrl: config.rndc.consultasWsdlUrl,
    usuario: config.rndc.usuario,
    password: config.rndc.password,
    simular,
    reintentos: config.rndc.reintentos,
    soloConsultas: true,
  });
}
