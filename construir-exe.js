'use strict';

/*
 * Constrói o executável do PDV (arquivo único, sem instalar Node.js).
 * Uso: node construir-exe.js
 *
 * Passos:
 *  1. Empacota db.js + server.js em um único script (pdv-bundle.js)
 *  2. Prepara o blob do recurso SEA (interface embutida)
 *  3. Copia o binário do Node e injeta o blob com o postject
 *
 * Requisitos: Node.js 22+ e o pacote postject (instalado automaticamente via npx).
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RAIZ = __dirname;
const DIST = path.join(RAIZ, 'dist');
const BUNDLE = path.join(RAIZ, 'pdv-bundle.js');
const SEA_CONFIG = path.join(RAIZ, 'sea-config.json');
const BLOB = path.join(RAIZ, 'pdv.blob');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const ativos = {
  'index.html': 'public/index.html',
  'style.css': 'public/style.css',
  'app.js': 'public/app.js',
};

function gerarBundle() {
  const envoltorio = (id, arquivo) => {
    const fonte = fs.readFileSync(path.join(RAIZ, arquivo), 'utf8');
    return `_definir(${JSON.stringify(id)}, function (exports, requirir, module, __filename, __dirname, require) {\n${fonte}\n});`;
  };
  const bundle = `'use strict';

const path = require('path');
const _nodeSea = require('node:sea');
const _execDir = _nodeSea.isSea() ? path.dirname(process.execPath) : __dirname;
const MODULOS = {};
const CACHE_MODULOS = {};
const _requirirReal = require;

function _definir(id, corpo) { MODULOS[id] = corpo; }

function _exigir(id) {
  if (CACHE_MODULOS[id]) return CACHE_MODULOS[id].exports;
  if (!MODULOS[id]) return _requirirReal(id);
  const m = { exports: {} };
  CACHE_MODULOS[id] = m;
  MODULOS[id](m.exports, _exigir, m, path.join(_execDir, id), _execDir, _exigir);
  return m.exports;
}

${envoltorio('./db', 'db.js')}
${envoltorio('./server.js', 'server.js')}

_exigir('./server.js');
`;
  fs.writeFileSync(BUNDLE, bundle);
  return bundle.length;
}

function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    console.error('Precisa de Node.js 22 ou mais novo para gerar o executável.');
    process.exit(1);
  }

  console.log('[1/4] Empacotando módulos...');
  const tamanhoBundle = gerarBundle();
  console.log(`      pdv-bundle.js gerado (${Math.round(tamanhoBundle / 1024)} KB)`);

  fs.writeFileSync(SEA_CONFIG, JSON.stringify({
    main: 'pdv-bundle.js',
    output: 'pdv.blob',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: ativos,
  }, null, 2));

  console.log('[2/4] Preparando blob do executável...');
  execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: RAIZ, stdio: 'inherit' });

  fs.mkdirSync(DIST, { recursive: true });
  const ext = process.platform === 'win32' ? '.exe' : '';
  const nome = `pdv-${process.platform}-${process.arch}${ext}`;
  const alvo = path.join(DIST, nome);
  fs.copyFileSync(process.execPath, alvo);
  if (ext === '') fs.chmodSync(alvo, 0o755);

  console.log('[3/4] Injetando a aplicação no binário (postject)...');
  try {
    execFileSync('npx', [
      '-y', 'postject', alvo,
      'NODE_SEA_BLOB', BLOB,
      '--sentinel-fuse', FUSE,
    ], { cwd: RAIZ, stdio: 'inherit' });
  } catch (err) {
    console.error('\nFalha ao injetar o postject (sem internet para baixar o pacote?).');
    console.error('Depois de instalar (npm i -g postject) rode manualmente:');
    console.error(`  postject ${alvo} NODE_SEA_BLOB ${BLOB} --sentinel-fuse ${FUSE}`);
    process.exit(1);
  }

  console.log(`[4/4] Pronto! Executável em dist/${nome}`);
  console.log('Copie o executável para qualquer pasta e rode: ele sobe o PDV e abre o navegador.');
  console.log('Os dados ficam na subpasta data/ ao lado do executável.');
}

main();
