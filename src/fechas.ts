/**
 * Fechas que llegan del formulario.
 *
 * <input type="datetime-local"> entrega la hora SIN zona ("2026-10-01T11:00").
 * new Date() la interpreta en la zona del SERVIDOR: en el computador de la
 * oficina (Colombia) daba la hora correcta, pero el servidor corre en UTC y la
 * corria 5 horas (11:00 quedaba como 06:00 en el RNDC). La hora que escribe el
 * despachador es SIEMPRE hora de Colombia, asi que se interpreta asi, sin
 * depender de la zona del servidor. Colombia no tiene horario de verano: UTC-5.
 */
const ZONA_COLOMBIA = "-05:00";

/** Fecha y hora escritas en Colombia. Si ya trae zona (ISO con Z u offset), se respeta. */
export function fechaHoraColombia(valor: unknown): Date {
  if (valor instanceof Date) return valor;
  const texto = String(valor ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(texto)) {
    return new Date(texto + ZONA_COLOMBIA);
  }
  return new Date(texto);
}
