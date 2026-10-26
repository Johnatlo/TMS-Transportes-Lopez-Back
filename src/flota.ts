/**
 * Flota de un vehiculo: propia (Transportes Lopez o Transportes M&C) o de un
 * tercero. Va en su propio archivo porque la usan cuadro, anticipos y
 * reportes al armar sus consultas (cuadro y anticipos se importan entre si).
 */
import { config } from "./config";
/**
 * NIT de Transportes M&C SAS sin digito de verificacion (asi esta en
 * Clientes). Su flota es propia, igual que la de Transportes Lopez.
 */
export const NIT_MYC = "901505135";

/**
 * Expresion SQL con la flota del vehiculo de alias `ve`: la que tenga escrita
 * (LOPEZ o MYC) o, si dice TERCERO o no esta en Flota, la que sale del
 * propietario o del tenedor: con el NIT de Transportes Lopez es LOPEZ, con el
 * de M&C es MYC y con cualquier otro, TERCERO. Asi un carro de la empresa que
 * nadie marco como propio no aparece en Pago a terceros. Los NIT se comparan
 * con sus primeros 9 digitos (sin el digito de verificacion).
 */
export function sqlFlota(ve = "ve"): string {
  const nit9 = (campo: string) => `LEFT(REGEXP_REPLACE(COALESCE(${ve}.${campo}, ''), '[^0-9]', ''), 9)`;
  const de = (nit: string) => `'${nit}' IN (${nit9("propietarioNit")}, ${nit9("numIdTenedor")})`;
  const lopez = config.rndc.empresaNit.replace(/\D/g, "").slice(0, 9);
  return `CASE
    WHEN ${ve}.flota IN ('LOPEZ', 'MYC') THEN ${ve}.flota
    ${lopez ? `WHEN ${de(lopez)} THEN 'LOPEZ'` : ""}
    WHEN ${de(NIT_MYC)} THEN 'MYC'
    ELSE 'TERCERO' END`;
}
