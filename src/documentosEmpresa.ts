/**
 * Documentos con vencimiento de las dos empresas (Transportes Lopez y M&C):
 * camara de comercio, habilitacion, polizas, certificados... Se guarda solo el
 * nombre, el numero y la fecha de vencimiento (el sistema no guarda archivos).
 * Se editan en Configuracion y avisan en "Sofi te cuenta" del Inicio.
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "./db";
import { dia, ErrorCuadro } from "./cuadro";
import type { EmpresaVehiculo } from "./roles";

/** Un documento de una empresa. */
export interface DocumentoEmpresa {
  id: number;
  empresa: EmpresaVehiculo;
  nombre: string;
  numero: string | null;
  /** "AAAA-MM-DD" o null (sin fecha registrada). */
  fechaVencimiento: string | null;
  nota: string | null;
}

/** Nombre de cada empresa para mostrar. */
export const NOMBRE_EMPRESA: Record<EmpresaVehiculo, string> = { LOPEZ: "Transportes Lopez", MYC: "Transportes M&C" };

/** Texto recortado o null si viene vacio. */
const texto = (v: unknown, max: number): string | null => {
  const t = String(v ?? "").trim();
  return t ? t.slice(0, max) : null;
};

/**
 * Valida lo que llega del formulario: empresa LOPEZ o MYC, nombre obligatorio
 * y fecha "AAAA-MM-DD" (o vacia). Exportado para las pruebas.
 */
export function validarDocumento(d: Record<string, unknown>): Omit<DocumentoEmpresa, "id"> {
  const empresa = String(d.empresa ?? "").toUpperCase();
  if (empresa !== "LOPEZ" && empresa !== "MYC") throw new ErrorCuadro("Elige la empresa: Transportes Lopez o Transportes M&C.");
  const nombre = texto(d.nombre, 100);
  if (!nombre) throw new ErrorCuadro("Escribe el nombre del documento.");
  const fecha = texto(d.fechaVencimiento, 10);
  if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new ErrorCuadro("La fecha de vencimiento no es valida.");
  return { empresa, nombre, numero: texto(d.numero, 60), fechaVencimiento: fecha, nota: texto(d.nota, 255) };
}

/** Lectura y escritura de los documentos de las empresas. */
export const documentosEmpresa = {
  /** Todos, por empresa y por vencimiento (los sin fecha al final). */
  async listar(): Promise<DocumentoEmpresa[]> {
    const [filas] = await pool.query<RowDataPacket[]>("SELECT * FROM documentos_empresa ORDER BY empresa, fechaVencimiento IS NULL, fechaVencimiento, nombre");
    return filas.map((f) => ({
      id: Number(f.id),
      empresa: f.empresa as EmpresaVehiculo,
      nombre: String(f.nombre),
      numero: f.numero ?? null,
      fechaVencimiento: dia(f.fechaVencimiento),
      nota: f.nota ?? null,
    }));
  },

  /** Agrega un documento. Devuelve su id. */
  async crear(d: Record<string, unknown>): Promise<number> {
    const v = validarDocumento(d);
    const [r] = await pool.query<ResultSetHeader>("INSERT INTO documentos_empresa (empresa, nombre, numero, fechaVencimiento, nota) VALUES (?, ?, ?, ?, ?)", [
      v.empresa,
      v.nombre,
      v.numero,
      v.fechaVencimiento,
      v.nota,
    ]);
    return r.insertId;
  },

  /** Cambia un documento (por ejemplo, la fecha al renovarlo). */
  async actualizar(id: number, d: Record<string, unknown>): Promise<void> {
    const v = validarDocumento(d);
    const [r] = await pool.query<ResultSetHeader>(
      "UPDATE documentos_empresa SET empresa = ?, nombre = ?, numero = ?, fechaVencimiento = ?, nota = ? WHERE id = ?",
      [v.empresa, v.nombre, v.numero, v.fechaVencimiento, v.nota, id],
    );
    if (!r.affectedRows) throw new ErrorCuadro("Ese documento ya no existe.");
  },

  /** Borra un documento (queda en la papelera de Control interno). */
  async borrar(id: number): Promise<void> {
    await pool.query("DELETE FROM documentos_empresa WHERE id = ?", [id]);
  },
};
