import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:4200",
  rndc: {
    wsdlUrl: process.env.RNDC_WSDL_URL ?? "",
    usuario: process.env.RNDC_USUARIO ?? "",
    password: process.env.RNDC_PASSWORD ?? "",
    empresaNit: process.env.RNDC_EMPRESA_NIT ?? "",
    simular: (process.env.RNDC_SIMULAR ?? "true").toLowerCase() === "true",
    nitMonitoreoFlota: process.env.RNDC_NIT_MONITOREO_FLOTA || null,
  },
  // Consecutivos propios (CONSECUTIVOREMESA / NUMMANIFIESTOCARGA). El RNDC exige
  // que la empresa los asigne y NUNCA se repitan. Por defecto se generan como
  // "REM{id}" / "MAN{id}" a partir del id interno (garantiza unicidad), pero si
  // la empresa ya tenia una numeracion propia en uso (ej. viniendo de Excel),
  // estas variables permiten continuarla en vez de reiniciar en 1.
  consecutivos: {
    prefijoRemesa: process.env.RNDC_PREFIJO_REMESA ?? "REM",
    inicioRemesa: Number(process.env.RNDC_INICIO_REMESA ?? 0),
    prefijoManifiesto: process.env.RNDC_PREFIJO_MANIFIESTO ?? "MAN",
    inicioManifiesto: Number(process.env.RNDC_INICIO_MANIFIESTO ?? 0),
  },
};
