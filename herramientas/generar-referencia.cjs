// Genera la referencia de funciones del repo y la escribe en README.md, entre
// los marcadores <!-- REFERENCIA:INICIO --> y <!-- REFERENCIA:FIN --> (y, si
// hay rutas de Express, la tabla de la API entre <!-- RUTAS:INICIO --> y
// <!-- RUTAS:FIN -->).
//
// Lee los comentarios de documentacion del codigo (JSDoc o // justo encima de
// cada funcion), asi el README describe cada funcion tal como esta documentada
// y no se desactualiza: despues de cambiar codigo, correr  npm run docs.
//
// Usa el compilador de TypeScript del propio proyecto para recorrer el codigo
// (no busquedas de texto): encuentra funciones, componentes de React, objetos
// con metodos (repositorios, clientes de API), clases y rutas de Express.
const path = require("path");
const fs = require("fs");

const raiz = path.resolve(__dirname, "..");
const README = path.join(raiz, "README.md");
const ts = require(path.join(raiz, "node_modules/typescript"));

/** Prefijo con que se monta cada archivo de rutas (ver src/index.ts del backend). */
const PREFIJOS = {
  "src/routes/auth.ts": "/api/auth",
  "src/routes/catalogo.ts": "/api/catalogo",
  "src/routes/despacho.ts": "/api/despacho",
  "src/routes/usuarios.ts": "/api/usuarios",
  "src/routes/cuadro.ts": "/api/cuadro",
};

const ETIQUETA_TIPO = {
  funcion: "función",
  componente: "componente React",
  objeto: "módulo",
  metodo: "método",
  clase: "clase",
  ruta: "ruta HTTP",
};

/** Archivos .ts/.tsx de src, sin pruebas ni declaraciones. */
function archivosFuente() {
  const lista = [];
  (function recorrer(dir) {
    for (const nombre of fs.readdirSync(dir).sort()) {
      const ruta = path.join(dir, nombre);
      if (fs.statSync(ruta).isDirectory()) {
        if (!/node_modules|dist/.test(nombre)) recorrer(ruta);
      } else if (/\.(ts|tsx)$/.test(nombre) && !/\.test\.|\.d\.ts$/.test(nombre)) {
        lista.push(ruta);
      }
    }
  })(path.join(raiz, "src"));
  return lista;
}

/** Texto de un bloque /** ... *\/ sin los asteriscos de cada linea. */
function limpiarBloque(crudo) {
  return crudo
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, ""))
    .join("\n")
    .trim();
}

/**
 * Comentarios pegados al nodo (sin linea en blanco de por medio y sin contar
 * los separadores de seccion "// -----"), como texto limpio.
 */
function documentacion(texto, nodo) {
  const rangos = ts.getLeadingCommentRanges(texto, nodo.getFullStart()) || [];
  const utiles = [];
  for (let i = rangos.length - 1; i >= 0; i--) {
    const r = rangos[i];
    const crudo = texto.slice(r.pos, r.end);
    const siguiente = i === rangos.length - 1 ? nodo.getStart() : rangos[i + 1].pos;
    if ((texto.slice(r.end, siguiente).match(/\n/g) || []).length > 1) break;
    if (/^\/\/\s*-{5,}/.test(crudo)) break;
    utiles.unshift(crudo.startsWith("/*") ? limpiarBloque(crudo) : crudo.replace(/^\/\/ ?/, ""));
  }
  return utiles.join("\n").trim();
}

/** Nombres de los parametros: "a, b, {...}". */
function parametros(fn) {
  if (!fn || !fn.parameters) return "";
  return fn.parameters
    .map((p) => (p.dotDotDotToken ? "..." : "") + (ts.isIdentifier(p.name) ? p.name.text : "{...}"))
    .join(", ");
}

/** Recorre un archivo y devuelve su descripcion y sus elementos documentables. */
function analizar(archivo) {
  const texto = fs.readFileSync(archivo, "utf8").replace(/\r\n/g, "\n");
  const tipo = archivo.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(archivo, texto, ts.ScriptTarget.Latest, true, tipo);
  const rel = path.relative(raiz, archivo).split(path.sep).join("/");
  const esTsx = rel.endsWith(".tsx");

  // Cabecera del archivo: un /** */ al comienzo.
  const primero = (ts.getLeadingCommentRanges(texto, 0) || []).find((r) => texto.startsWith("/**", r.pos));
  const cabecera = primero ? limpiarBloque(texto.slice(primero.pos, primero.end)) : "";

  const items = [];
  const funcion = (nombre) => (/^[A-Z]/.test(nombre) && esTsx ? "componente" : "funcion");

  for (const n of sf.statements) {
    if (ts.isFunctionDeclaration(n) && n.name) {
      items.push({ tipo: funcion(n.name.text), firma: `${n.name.text}(${parametros(n)})`, doc: documentacion(texto, n) });
    } else if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        const ini = d.initializer;
        if (!ini || !ts.isIdentifier(d.name)) continue;
        if (ts.isArrowFunction(ini) || ts.isFunctionExpression(ini)) {
          items.push({ tipo: funcion(d.name.text), firma: `${d.name.text}(${parametros(ini)})`, doc: documentacion(texto, n) });
        } else if (ts.isObjectLiteralExpression(ini)) {
          // Objetos con metodos: repositorios (viajes = { findById() {} }) y clientes de API.
          const metodos = ini.properties.filter(
            (p) =>
              ts.isMethodDeclaration(p) ||
              (ts.isPropertyAssignment(p) && p.initializer && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer)))
          );
          if (!metodos.length) continue;
          items.push({ tipo: "objeto", firma: d.name.text, doc: documentacion(texto, n) });
          for (const p of metodos) {
            const fn = ts.isMethodDeclaration(p) ? p : p.initializer;
            const nombre = p.name.getText();
            items.push({ tipo: "metodo", firma: `${d.name.text}.${nombre}(${parametros(fn)})`, doc: documentacion(texto, p), hijo: true });
          }
        }
      }
    } else if (ts.isClassDeclaration(n) && n.name) {
      items.push({ tipo: "clase", firma: n.name.text, doc: documentacion(texto, n) });
      for (const m of n.members) {
        if (ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m)) {
          const nombre = m.name ? m.name.getText() : "constructor";
          items.push({ tipo: "metodo", firma: `${n.name.text}.${nombre}(${parametros(m)})`, doc: documentacion(texto, m), hijo: true });
        }
      }
    } else if (ts.isExpressionStatement(n) && ts.isCallExpression(n.expression)) {
      // Rutas de Express: router.get("/ruta", ...)
      const c = n.expression;
      if (
        ts.isPropertyAccessExpression(c.expression) &&
        /^(get|post|put|delete|patch)$/.test(c.expression.name.text) &&
        c.arguments[0] &&
        ts.isStringLiteral(c.arguments[0])
      ) {
        items.push({ tipo: "ruta", firma: `${c.expression.name.text.toUpperCase()} ${c.arguments[0].text}`, doc: documentacion(texto, n) });
      }
    }
  }
  return { rel, cabecera, items };
}

/** Seccion de referencia: indice y, por archivo, su cabecera y cada elemento. */
function referencia(analizados) {
  const conItems = analizados.filter((a) => a.items.length);
  const total = conItems.reduce((t, a) => t + a.items.length, 0);
  const lineas = [`_${total} funciones, componentes, métodos y rutas en ${conItems.length} archivos._`, ""];
  for (const { rel, items } of conItems) {
    lineas.push(`- [\`${rel}\`](#${rel.toLowerCase().replace(/[^a-z0-9]+/g, "")}) (${items.length})`);
  }
  lineas.push("");
  for (const { rel, cabecera, items } of conItems) {
    lineas.push(`### \`${rel}\``, "");
    if (cabecera) lineas.push(...cabecera.split("\n").map((l) => `> ${l}`.trimEnd()), "");
    for (const it of items) {
      const sangria = it.hijo ? "  " : "";
      const doc = (it.doc || "_(sin descripción)_").replace(/\n{3,}/g, "\n\n");
      const cuerpo = doc.split("\n").map((l) => (l.trim() ? `${sangria}  ${l.trimEnd()}` : "")).join("\n");
      lineas.push(`${sangria}- **\`${it.firma}\`** · _${ETIQUETA_TIPO[it.tipo]}_`, cuerpo, "");
    }
  }
  return { texto: lineas.join("\n"), total, archivos: conItems.length };
}

/** Tabla de la API: metodo, ruta completa y primer parrafo de la descripcion. */
function tablaRutas(analizados) {
  const filas = [];
  for (const { rel, items } of analizados) {
    if (!PREFIJOS[rel]) continue;
    for (const it of items.filter((x) => x.tipo === "ruta")) {
      const [metodo, ruta] = it.firma.split(" ");
      const completa = PREFIJOS[rel] + (ruta === "/" ? "" : ruta);
      let desc = (it.doc.split(/\n\s*\n/)[0] || "")
        .replace(/\s*\n\s*/g, " ")
        .replace(/^[A-Z]+ \/api\/\S+:\s*/, "")
        .replace(/\|/g, "\\|");
      desc = desc ? desc.charAt(0).toUpperCase() + desc.slice(1) : "-";
      filas.push(`| \`${metodo}\` | \`${completa}\` | ${desc} |`);
    }
  }
  return filas.length ? { texto: ["| Método | Ruta | Qué hace |", "|---|---|---|", ...filas].join("\n"), total: filas.length } : null;
}

/** Reemplaza lo que hay entre dos marcadores del README. */
function reemplazar(texto, marca, contenido) {
  const ini = `<!-- ${marca}:INICIO -->`;
  const fin = `<!-- ${marca}:FIN -->`;
  const a = texto.indexOf(ini);
  const b = texto.indexOf(fin);
  if (a < 0 || b < a) throw new Error(`README.md no tiene los marcadores ${ini} y ${fin}`);
  return `${texto.slice(0, a + ini.length)}\n${contenido}\n${texto.slice(b)}`;
}

const analizados = archivosFuente().map(analizar);
const ref = referencia(analizados);
const rutas = tablaRutas(analizados);

const original = fs.readFileSync(README, "utf8");
const eol = original.includes("\r\n") ? "\r\n" : "\n";
let readme = reemplazar(original.replace(/\r\n/g, "\n"), "REFERENCIA", ref.texto);
if (rutas) readme = reemplazar(readme, "RUTAS", rutas.texto);
fs.writeFileSync(README, readme.split("\n").join(eol));

const sinDoc = analizados.flatMap((a) => a.items.filter((i) => !i.doc).map((i) => `${a.rel}: ${i.firma}`));
console.log(`README.md: ${ref.total} elementos en ${ref.archivos} archivos${rutas ? `, ${rutas.total} rutas` : ""}.`);
if (sinDoc.length) {
  console.log(`\nSin documentar (${sinDoc.length}):\n  ${sinDoc.join("\n  ")}`);
  process.exitCode = 1;
}
