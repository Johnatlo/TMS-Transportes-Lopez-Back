import express from "express";
import cors from "cors";
import { config } from "./config";
import { initSchema } from "./db";
import { catalogoRouter } from "./routes/catalogo";
import { despachoRouter } from "./routes/despacho";

async function main() {
  await initSchema();

  const app = express();

  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, rndcSimulado: config.rndc.simular });
  });

  app.use("/api/catalogo", catalogoRouter);
  app.use("/api/despacho", despachoRouter);

  app.listen(config.port, () => {
    console.log(`Backend RNDC escuchando en http://localhost:${config.port}`);
    console.log(`Modo simulacion RNDC: ${config.rndc.simular}`);
  });
}

main().catch((err) => {
  console.error("Error fatal al arrancar el backend:", err);
  process.exit(1);
});
