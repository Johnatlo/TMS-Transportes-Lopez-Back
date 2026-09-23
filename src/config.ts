import "dotenv/config";

/**
 * Ambientes del RNDC.
 *
 * El Ministerio expone una copia de la base de datos de produccion, de alguna
 * fecha pasada, en un servidor aparte. Los usuarios y contrasenas son LOS
 * MISMOS en los dos ambientes: lo unico que separa una prueba de un documento
 * real con efecto legal es la URL. De ahi el freno de mano mas abajo.
 *
 * Fuente: "Guia Uso del Web Service en el RNDC" (Grupo de Logistica), seccion
 * "Ambiente de pruebas".
 */
export const AMBIENTES_RNDC = {
  pruebas: {
    nombre: "PRUEBAS",
    // El PDF del manifiesto no sale del SOAP: es una API REST en otro puerto
    // [GUIA DE MANIFIESTO V7, seccion 9].
    restUrl: "http://plc.mintransporte.gov.co:8081",
    // Copia de produccion de una fecha pasada. Lo que registres aqui no tiene
    // efecto legal, pero los datos maestros tampoco estan al dia.
    wsdlUrl: "http://plc.mintransporte.gov.co:8080/ws",
  },
  produccion: {
    nombre: "PRODUCCION",
    // La guia V7 documenta esta misma URL para consultar el PDF. Si en
    // produccion resulta ser otra, se sobrescribe con RNDC_REST_URL.
    restUrl: "http://plc.mintransporte.gov.co:8081",
    // Servidor principal. El secundario es rndcws2.mintransporte.gov.co:8080/ws
    // y el Ministerio lo ofrece para mejorar tiempos de respuesta.
    wsdlUrl: "http://rndcws.mintransporte.gov.co:8080/ws",
  },
} as const;

export type NombreAmbiente = keyof typeof AMBIENTES_RNDC;

function leerAmbiente(): NombreAmbiente {
  const valor = (process.env.RNDC_AMBIENTE ?? "pruebas").toLowerCase();
  if (valor !== "pruebas" && valor !== "produccion") {
    throw new Error(
      `RNDC_AMBIENTE debe ser "pruebas" o "produccion" (recibido: "${valor}")`
    );
  }
  return valor;
}

const ambiente = leerAmbiente();
const simular = (process.env.RNDC_SIMULAR ?? "true").toLowerCase() === "true";

const wsdlUrl = process.env.RNDC_WSDL_URL || AMBIENTES_RNDC[ambiente].wsdlUrl;

/**
 * Coherencia entre el ambiente elegido y la URL efectiva.
 *
 * RNDC_WSDL_URL sobrescribe la URL del ambiente, asi que un .env heredado
 * puede decir RNDC_AMBIENTE=pruebas y apuntar al servidor de produccion. El
 * freno de mas abajo no se activaria (el ambiente "es" pruebas) y se
 * expedirian documentos reales creyendo que se esta probando.
 *
 * Los hosts de produccion son rndcws y rndcws2; el de pruebas es plc.
 */
const HOSTS_PRODUCCION = ["rndcws.mintransporte.gov.co", "rndcws2.mintransporte.gov.co"];
const apuntaAProduccion = HOSTS_PRODUCCION.some((h) => wsdlUrl.includes(h));

if (ambiente === "pruebas" && apuntaAProduccion && !simular) {
  throw new Error(
    [
      "",
      "  RNDC_AMBIENTE dice \"pruebas\", pero RNDC_WSDL_URL apunta al servidor de PRODUCCION:",
      `    ${wsdlUrl}`,
      "",
      "  Asi se expedirian documentos reales creyendo que se esta probando.",
      "",
      "  Para probar de verdad, borra o comenta RNDC_WSDL_URL del .env: el ambiente",
      "  de pruebas usa http://plc.mintransporte.gov.co:8080/ws",
      "",
      "  Si de verdad querias produccion, pon RNDC_AMBIENTE=produccion y agrega la",
      '  confirmacion RNDC_CONFIRMO_PRODUCCION="SI, EXPEDIR DOCUMENTOS REALES"',
      "",
    ].join("\n")
  );
}

/**
 * Freno de mano: apuntar a produccion exige una confirmacion explicita y
 * separada del propio interruptor de ambiente. Sin ella, un .env copiado de un
 * companero o un merge descuidado bastarian para empezar a expedir manifiestos
 * reales creyendo que se esta probando.
 */
const confirmacionProduccion = process.env.RNDC_CONFIRMO_PRODUCCION ?? "";
if (ambiente === "produccion" && !simular) {
  if (confirmacionProduccion !== "SI, EXPEDIR DOCUMENTOS REALES") {
    throw new Error(
      [
        "",
        "  Estas apuntando al ambiente de PRODUCCION del RNDC con la simulacion apagada.",
        "  Los documentos que se expidan seran reales y tendran efecto legal.",
        "",
        '  Si es lo que quieres, agrega al .env:  RNDC_CONFIRMO_PRODUCCION="SI, EXPEDIR DOCUMENTOS REALES"',
        "  Si querias probar, cambia:             RNDC_AMBIENTE=pruebas",
        "",
      ].join("\n")
    );
  }
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  empresa: {
    // Solo para encabezar los documentos que imprime la empresa.
    nombre: process.env.EMPRESA_NOMBRE ?? "Empresa de Transporte",
  },
  sicetac: {
    // SICETAC cotiza por combinacion de unidad de transporte y tipo de carga,
    // y cada una tiene un piso distinto. Estos son los de la operacion de la
    // empresa; se usan para quedarse con la fila correcta de la respuesta.
    unidadTransporte: process.env.SICETAC_UNIDAD_TRANSPORTE ?? "ESTACAS",
    tipoCarga: process.env.SICETAC_TIPO_CARGA ?? "Granel Solido",
    // Meses hacia atras que se reintentan si el periodo actual no trae datos
    // (la guia avisa que un mes puede heredar los valores del anterior).
    mesesHaciaAtras: Number(process.env.SICETAC_MESES_ATRAS ?? 3),
  },
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:4200",
  rndc: {
    ambiente,
    nombreAmbiente: AMBIENTES_RNDC[ambiente].nombre,
    esProduccion: ambiente === "produccion",
    // La URL sale del ambiente elegido. RNDC_WSDL_URL solo se usa para
    // sobrescribirla a mano (por ejemplo para probar el servidor secundario).
    wsdlUrl,
    restUrl: process.env.RNDC_REST_URL || AMBIENTES_RNDC[ambiente].restUrl,
    usuario: process.env.RNDC_USUARIO ?? "",
    password: process.env.RNDC_PASSWORD ?? "",
    empresaNit: process.env.RNDC_EMPRESA_NIT ?? "",
    simular,
    nitMonitoreoFlota: process.env.RNDC_NIT_MONITOREO_FLOTA || null,
    // Reintentos ante fallas de RED (no ante rechazos del RNDC). El despacho es
    // de noche y el servicio del Ministerio se cae con frecuencia.
    reintentos: Number(process.env.RNDC_REINTENTOS ?? 1),
  },
  // Consecutivos propios (CONSECUTIVOREMESA / NUMMANIFIESTOCARGA). El RNDC exige
  // que la empresa los asigne y NUNCA se repitan. Por defecto se generan como
  // "REM{id}" / "MAN{id}" a partir del id interno (garantiza unicidad), pero si
  // la empresa ya tenia una numeracion propia en uso (ej. viniendo de Excel),
  // estas variables permiten continuarla en vez de reiniciar en 1.
  consecutivos: {
    /**
     * Un mismo numero base identifica el viaje: el manifiesto lo usa tal cual y
     * las remesas adicionales le agregan una letra (00006692, 00006692A...).
     */
    longitud: Number(process.env.RNDC_LONGITUD_CONSECUTIVO ?? 8),
    /** Prefijo opcional delante del numero. Vacio por defecto. */
    prefijo: process.env.RNDC_PREFIJO_CONSECUTIVO ?? "",
  },
};

/** Banner de arranque: que ambiente esta activo nunca deberia ser una sorpresa. */
export function describirAmbiente(): string {
  if (config.rndc.simular) {
    const nota = apuntaAProduccion && ambiente === "pruebas"
      ? "  [OJO: RNDC_WSDL_URL apunta a PRODUCCION; al apagar la simulacion no arrancara]"
      : "";
    return `RNDC: SIMULACION (no se envia nada al Ministerio)${nota}`;
  }
  const marca = config.rndc.esProduccion ? "!!! PRODUCCION - DOCUMENTOS REALES !!!" : "PRUEBAS";
  return `RNDC: ${marca} -> ${config.rndc.wsdlUrl}`;
}
