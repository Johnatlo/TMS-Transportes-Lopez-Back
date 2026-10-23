/**
 * Cliente al que se le cobra: varios nombres de empresa del cuadro son cobros
 * a la misma empresa con distinto concepto ("RECONOCIDO CARTONES AMERICA",
 * "CARTONES AMERICA URBANO", "CORAME RECONOCIDO CARTULINA BOGOTA" son todos
 * de CARTONES AMERICA; "RECICLAJES URBANO TOCANCIPA" es de RECICLAJES BOGOTA).
 * En cartera y en los reportes se agrupan por el cliente y se muestra su
 * concepto. El nombre original de la empresa no se cambia: sigue siendo la
 * llave de la factura (pagos, gestiones, anticipos).
 *
 * Es una lista cerrada, a proposito: solo se juntan los clientes de la lista
 * (una regla general podria juntar dos empresas que solo se parecen).
 */

/**
 * Clientes con variantes de nombre: el patron (sobre el nombre en mayusculas
 * sin puntos ni comas) y el nombre del cliente, el mismo del cuadro. El orden
 * importa: BODEGAS DE RECICLAJES y ECOAMBIENTAL RECICLAJE van antes que
 * RECICLAJES BOGOTA porque tambien dicen RECICLAJES.
 */
export const ALIAS_COBRO: Array<{ patron: RegExp; cliente: string }> = [
  { patron: /CARTONES\s+AMERICA|CORAME/, cliente: "CARTONES AMERICA" },
  { patron: /^BODEGAS?\b(\s+DE\s+RECICLAJES?)?/, cliente: "BODEGAS DE RECICLAJES SAS" },
  { patron: /ECOAMBIENTAL(\s+RECICLAJES?)?/, cliente: "ECOAMBIENTAL RECICLAJE S.A.S." },
  { patron: /TP\s+(PRODUCTOS\s+)?FORMULADOS|^PEGANTE\b/, cliente: "TP PRODUCTOS FORMULADOS S.A.S" },
  { patron: /RECICLAJES?\s+BOGOTA(\s+N\s?S)?|^RECICLAJES\b/, cliente: "RECICLAJES BOGOTA N.S. S.A.S." },
];

/** Nombre comparable: mayusculas, sin tildes, sin puntos ni comas, espacios simples. */
const normal = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Tipos de sociedad que no son concepto, esten donde esten (S A S, SAS, LTDA, S EN C). */
const SOCIEDAD = /\b(S A S|SAS|LTDA|S EN C)\b/g;
/** Letras sueltas de sociedad que solo se quitan al final (S A, N S): en medio podrian ser parte del concepto. */
const SUFIJO_LEGAL = /\s*\b(S A|N S)$/;

/** Lo que sobra del nombre, sin tipo de sociedad ni signos sueltos. */
function limpiar(t: string): string {
  let r = t.replace(/[-–·/]+/g, " ").replace(SOCIEDAD, " ").replace(/\s+/g, " ").trim();
  while (SUFIJO_LEGAL.test(r)) r = r.replace(SUFIJO_LEGAL, "").trim();
  return r.replace(/^(DE|DEL|Y)\s+|\s+(DE|DEL|Y)$/g, "").trim();
}

/**
 * Cliente de cobro y concepto de una empresa del cuadro. Si el nombre es una
 * variante de un cliente de la lista (ALIAS_COBRO), el cliente es el de la
 * lista y el concepto es lo que sobra del nombre ("URBANO", "RECONOCIDO",
 * "CARTON"). Si no, el cliente es la misma empresa. `concepto` (el de un
 * reconocido del cuadro) se usa si el nombre no trae uno.
 */
export function clienteDeCobro(empresa: string, concepto?: string | null): { cliente: string; concepto: string | null } {
  const nombre = normal(empresa);
  for (const a of ALIAS_COBRO) {
    if (!a.patron.test(nombre)) continue;
    const resto = limpiar(nombre.replace(new RegExp(a.patron.source, "g"), " "));
    return { cliente: a.cliente, concepto: resto || concepto?.trim() || null };
  }
  return { cliente: empresa.trim().toUpperCase(), concepto: concepto?.trim() || null };
}
