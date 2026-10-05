import "dotenv/config";
import { pool, initSchema } from "./db";
import { usuarios } from "./auth";
(async () => { const e="prueba.gps@tms.local"; const db=process.env.DB_NAME;
  if (process.argv[2]==="crear") { await initSchema(); await usuarios.crear(e,"Prueba","Gps1234567",false); }
  else { await pool.query("DELETE FROM sesiones WHERE usuarioId IN (SELECT id FROM usuarios WHERE email=?)",[e]); await pool.query("DELETE FROM usuarios WHERE email=?",[e]); }
  const [r]: any = await pool.query("SELECT COUNT(*) n FROM usuarios"); console.log(db, "usuarios:", r[0].n); await pool.end(); })();
