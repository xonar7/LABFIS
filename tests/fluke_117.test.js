// Pruebas de consistencia (fuzzing) para la calculadora de error del
// Fluke 117 (fluke_117.html).
//
// Qué hace: genera cientos de lecturas al azar dentro de cada rango de
// la Tabla 1 (Accuracy Specifications) y verifica reglas que SIEMPRE
// deben cumplirse, sin importar el valor concreto — no reemplaza la
// verificación manual de los números de la tabla contra el manual, pero
// atrapa errores de tipeo, de rango o de redondeo introducidos al editar
// el archivo.
//
// Cómo correrlo (desde la raíz del repo LABFIS):
//   node tests/fluke_117.test.js
//
// Importante: este script NO usa una copia pegada de la lógica de
// cálculo — la extrae y ejecuta directamente desde fluke_117.html en
// cada corrida. Si editás la tabla de exactitud, las pruebas corren
// contra el cambio real; no hay riesgo de que el test quede
// desactualizado respecto al HTML.

const fs = require('fs');
const path = require('path');

function cargarLogica(rutaHtml){
  const html = fs.readFileSync(rutaHtml, 'utf8');
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  if (!match){
    throw new Error(`No se encontró un bloque <script> en ${rutaHtml}`);
  }
  let js = match[1].replace('(function(){', '');
  const marcador = '// ---------- UI ----------';
  const idx = js.indexOf(marcador);
  if (idx === -1){
    throw new Error('No se encontró el marcador "// ---------- UI ----------" en el script; ¿cambió la estructura del archivo?');
  }
  const core = js.slice(0, idx);
  const fabrica = new Function(
    core + '\nreturn { FUNCIONES, calcularError, calcularComponentes, formatearConComponentes, roundHalfEven };'
  );
  return fabrica();
}

const RUTA_HTML = path.join(__dirname, '..', 'fluke_117.html');
const { FUNCIONES, calcularError } = cargarLogica(RUTA_HTML);

let pruebas = 0;
let fallos = 0;

function fallar(msg, extra){
  fallos++;
  console.log('FALLO:', msg, extra !== undefined ? JSON.stringify(extra) : '');
}

// Cuenta cuántas cifras significativas tiene un texto numérico ya
// formateado (ignora signo, punto decimal y ceros de relleno a la
// izquierda; cuenta desde el primer dígito distinto de cero).
function cifrasSignificativas(texto){
  const limpio = texto.replace('-', '').replace('.', '');
  const sinCerosIzq = limpio.replace(/^0+/, '');
  return sinCerosIzq.length === 0 ? 1 : sinCerosIzq.length;
}

function randEnRango(min, max){
  return min + Math.random() * (max - min);
}

// -------- 1) Recorre cada función con valores aleatorios dentro de cada rango --------
for (const funcKey of Object.keys(FUNCIONES)){
  const cfg = FUNCIONES[funcKey];
  const bandas = cfg.bandas ? cfg.bandas.map(b => b.key) : [null];

  for (const rango of cfg.rangos){
    const minRango = cfg.rangos.indexOf(rango) === 0 ? 0 : cfg.rangos[cfg.rangos.indexOf(rango) - 1].max;
    for (let i = 0; i < 20; i++){
      pruebas++;
      // valor aleatorio estrictamente dentro del rango (evita los bordes exactos,
      // que se prueban aparte en la sección 2)
      const valor = randEnRango(minRango + (rango.max - minRango) * 0.02, rango.max * 0.999);
      const signo = Math.random() < 0.5 ? -1 : 1;
      const bandaKey = bandas[Math.floor(Math.random() * bandas.length)];

      const r = calcularError(funcKey, valor * signo, bandaKey);
      if (r.error){
        fallar(`${funcKey}: valor dentro de rango marcado como error`, {valor, rango: rango.label, error: r.error});
        continue;
      }

      // (a) el rango detectado debe ser el mismo que el que generó el valor
      if (r.rangoLabel !== rango.label){
        fallar(`${funcKey}: rango detectado no coincide`, {valor, esperado: rango.label, obtenido: r.rangoLabel});
      }

      // (b) el error absoluto debe tener exactamente 1 cifra significativa
      const cifrasErr = cifrasSignificativas(r.textoError);
      if (cifrasErr !== 1){
        fallar(`${funcKey}: error absoluto no tiene 1 cifra significativa`, {valor, textoError: r.textoError, cifras: cifrasErr});
      }

      // (c) el error relativo (si aplica) debe tener exactamente 2 cifras significativas
      if (r.relTexto !== null){
        const cifrasRel = cifrasSignificativas(r.relTexto);
        if (cifrasRel !== 2){
          fallar(`${funcKey}: error relativo no tiene 2 cifras significativas`, {valor, relTexto: r.relTexto, cifras: cifrasRel});
        }
      }

      // (d) la medición formateada debe tener la MISMA cantidad de decimales que el error
      const decMedicion = r.textoMedicion.includes('.') ? r.textoMedicion.split('.')[1].length : 0;
      if (decMedicion !== r.decimalesMantisa){
        fallar(`${funcKey}: decimales de la medición no coinciden con los del error`, {valor, textoMedicion: r.textoMedicion, decimalesMantisa: r.decimalesMantisa});
      }

      // (e) recalcular el error absoluto "a mano" desde la tabla y comparar
      //     contra el valor sin redondear que usó calcularError (verifica que
      //     no haya bugs de referencia/mutación en la tabla de rangos)
      let pctEsperado, countsEsperado;
      if (cfg.bandas){
        const banda = cfg.bandas.find(b => b.key === bandaKey);
        pctEsperado = banda.pct; countsEsperado = banda.counts;
      } else {
        pctEsperado = rango.pct; countsEsperado = rango.counts;
      }
      if (r.pct !== pctEsperado || r.counts !== countsEsperado){
        fallar(`${funcKey}: pct/counts usados no coinciden con la tabla`, {valor, esperado: {pctEsperado, countsEsperado}, obtenido: {pct: r.pct, counts: r.counts}});
      }
      const errorEsperadoRaw = (pctEsperado / 100) * Math.abs(valor) + countsEsperado * rango.res;
      const errorObtenidoNum = parseFloat(r.textoError) * Math.pow(10, r.exponente);
      // el error mostrado es el redondeado a 1 cifra significativa: debe
      // quedar dentro de un entorno razonable del valor crudo (no exacto,
      // por el propio redondeo, pero nunca debe diferir en más del ~50%
      // del propio error, si no hay un bug de escala/exponente)
      const tolerancia = Math.max(errorEsperadoRaw * 0.5, 1e-12);
      if (Math.abs(errorObtenidoNum - errorEsperadoRaw) > tolerancia){
        fallar(`${funcKey}: error mostrado se aleja demasiado del error crudo esperado`, {valor, errorEsperadoRaw, errorObtenidoNum});
      }
    }
  }
}

// -------- 2) Bordes exactos de cada rango (para detectar off-by-one) --------
for (const funcKey of Object.keys(FUNCIONES)){
  const cfg = FUNCIONES[funcKey];
  const bandaKey = cfg.bandas ? cfg.bandas[0].key : null;
  cfg.rangos.forEach((rango, idx) => {
    pruebas++;
    const rJusto = calcularError(funcKey, rango.max, bandaKey);
    if (rJusto.error || rJusto.rangoLabel !== rango.label){
      fallar(`${funcKey}: el valor exactamente en el borde superior no cae en su propio rango`, {max: rango.max, rango: rango.label, resultado: rJusto});
    }
    if (idx < cfg.rangos.length - 1){
      pruebas++;
      const siguiente = cfg.rangos[idx + 1];
      const rPasado = calcularError(funcKey, rango.max * 1.0001, bandaKey);
      if (rPasado.error || rPasado.rangoLabel !== siguiente.label){
        fallar(`${funcKey}: justo por encima del borde no pasa al siguiente rango`, {valor: rango.max * 1.0001, esperado: siguiente.label, obtenido: rPasado});
      }
    }
  });
  // por encima del máximo absoluto de la función: debe dar error
  pruebas++;
  const maxAbsoluto = cfg.rangos[cfg.rangos.length - 1].max;
  const rFuera = calcularError(funcKey, maxAbsoluto * 1.5, bandaKey);
  if (!rFuera.error){
    fallar(`${funcKey}: valor muy por encima del máximo no fue marcado como fuera de rango`, {valor: maxAbsoluto * 1.5, resultado: rFuera});
  }
}

// -------- 3) Aviso de "menos del 1% del rango" para funciones AC --------
for (const funcKey of Object.keys(FUNCIONES)){
  const cfg = FUNCIONES[funcKey];
  if (!cfg.acCaveat) continue;
  const bandaKey = cfg.bandas ? cfg.bandas[0].key : null;
  const rango = cfg.rangos[0];
  pruebas++;
  const rBajo = calcularError(funcKey, rango.max * 0.005, bandaKey); // 0.5% del rango
  if (!rBajo.caveat){
    fallar(`${funcKey}: no avisó "menos del 1%" cuando correspondía`, {valor: rango.max * 0.005, resultado: rBajo});
  }
  pruebas++;
  const rAlto = calcularError(funcKey, rango.max * 0.5, bandaKey); // 50% del rango
  if (rAlto.caveat){
    fallar(`${funcKey}: avisó "menos del 1%" cuando NO correspondía`, {valor: rango.max * 0.5, resultado: rAlto});
  }
}

// -------- 4) Lectura = 0 no debe romper el cálculo --------
for (const funcKey of Object.keys(FUNCIONES)){
  const cfg = FUNCIONES[funcKey];
  const bandaKey = cfg.bandas ? cfg.bandas[0].key : null;
  pruebas++;
  const r0 = calcularError(funcKey, 0, bandaKey);
  if (r0.error){
    fallar(`${funcKey}: lectura 0 no debería dar error de rango`, r0);
  } else if (r0.relTexto !== null){
    fallar(`${funcKey}: con lectura 0 el error relativo debería ser null (división por cero)`, r0);
  }
}

console.log(`\n${pruebas} pruebas ejecutadas, ${fallos} fallos.`);
process.exit(fallos > 0 ? 1 : 0);
