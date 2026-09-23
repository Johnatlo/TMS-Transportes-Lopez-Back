/**
 * Numeracion de remesas y manifiestos.
 *
 * Convencion historica de la empresa: un mismo numero base identifica todo el
 * viaje. El manifiesto lo usa tal cual, y cuando el viaje lleva varias remesas,
 * la primera tambien va sin sufijo y las siguientes llevan una letra.
 *
 *   Un cliente:    REM 00006692            MAN 00006692
 *   Tres clientes: REM 00006692            MAN 00006692
 *                  REM 00006692A
 *                  REM 00006692B
 *
 * Asi, viendo cualquier remesa se sabe a que manifiesto pertenece.
 *
 * El RNDC solo exige que el consecutivo sea alfanumerico, de maximo 15
 * caracteres y que no se repita dentro de la empresa [MANIFIESTO V7 pag. 5,
 * REMESA V5 pag. 7]. La convencion de la letra cabe sin problema.
 */

/** Letras de sufijo. La primera remesa no lleva. */
const LETRAS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const MAX_CARACTERES_CONSECUTIVO = 15;

/**
 * Consecutivo de una remesa segun su posicion en el viaje.
 *
 * @param base  Numero base del viaje, ej. "00006692".
 * @param orden Posicion de la remesa, empezando en 1.
 */
export function consecutivoRemesa(base: string, orden: number): string {
  if (orden < 1) throw new Error("El orden de la remesa empieza en 1");
  if (orden === 1) return base;

  const indice = orden - 2;
  if (indice >= LETRAS.length) {
    // Con el tope de 5 remesas por manifiesto esto no deberia pasar nunca,
    // pero es mejor fallar claro que generar un consecutivo raro.
    throw new Error(
      `No hay sufijo para la remesa numero ${orden}: la convencion solo llega hasta la ${LETRAS.length + 1}`
    );
  }
  return `${base}${LETRAS[indice]}`;
}

/** Los consecutivos de todas las remesas de un viaje, en orden. */
export function consecutivosDeViaje(base: string, cantidadRemesas: number): string[] {
  return Array.from({ length: cantidadRemesas }, (_, i) => consecutivoRemesa(base, i + 1));
}

/**
 * Siguiente numero base a partir del ultimo usado.
 *
 * Solo mira la parte numerica, asi que ignora los sufijos de letra: si el
 * ultimo viaje llego hasta 00006692B, el siguiente base es 00006693.
 */
export function siguienteBase(
  ultimoUsado: string | null,
  longitud: number,
  prefijo = ""
): string {
  const soloDigitos = (ultimoUsado ?? "").replace(/\D/g, "");
  const numero = soloDigitos ? Number(soloDigitos) + 1 : 1;
  return `${prefijo}${String(numero).padStart(longitud, "0")}`;
}

export interface ProblemaConsecutivo {
  mensaje: string;
}

/**
 * Revisa que el numero base sirva antes de intentar el despacho.
 *
 * El RNDC rechaza el manifiesto completo si el consecutivo se repite, y ese
 * rechazo llega despues de haber creado las remesas: mas vale atajarlo aqui.
 */
export function validarBase(
  base: string,
  cantidadRemesas: number,
  yaUsados: Set<string>
): ProblemaConsecutivo[] {
  const problemas: ProblemaConsecutivo[] = [];
  const limpio = (base ?? "").trim();

  if (!limpio) {
    problemas.push({ mensaje: "Falta el numero de remesa y manifiesto." });
    return problemas;
  }
  if (!/^[A-Za-z0-9]+$/.test(limpio)) {
    problemas.push({
      mensaje: `El numero "${limpio}" solo puede llevar letras y digitos, sin espacios ni guiones.`,
    });
    return problemas;
  }

  // El sufijo suma caracteres: hay que medir el mas largo, no el base.
  let consecutivos: string[];
  try {
    consecutivos = consecutivosDeViaje(limpio, cantidadRemesas);
  } catch (exc) {
    return [{ mensaje: (exc as Error).message }];
  }

  for (const c of consecutivos) {
    if (c.length > MAX_CARACTERES_CONSECUTIVO) {
      problemas.push({
        mensaje: `El consecutivo "${c}" pasa de ${MAX_CARACTERES_CONSECUTIVO} caracteres, el maximo del RNDC.`,
      });
    }
    if (yaUsados.has(c.toUpperCase())) {
      problemas.push({
        mensaje: `El consecutivo "${c}" ya se uso antes. El RNDC no permite repetirlos; usa otro numero base.`,
      });
    }
  }

  return problemas;
}
