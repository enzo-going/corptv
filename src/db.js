const Datastore = require('nedb-promises');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const dbPath = path.join(__dirname, '../data');
require('fs').mkdirSync(dbPath, { recursive: true });

const db = {
  groups:  Datastore.create({ filename: path.join(dbPath, 'groups.db'),  autoload: true }),
  slides:  Datastore.create({ filename: path.join(dbPath, 'slides.db'),  autoload: true }),
  gslides: Datastore.create({ filename: path.join(dbPath, 'gslides.db'), autoload: true }),
  screens: Datastore.create({ filename: path.join(dbPath, 'screens.db'), autoload: true }),
};

// O NeDB grava em log append-only: cada update anexa uma linha nova em vez de
// reescrever o documento. O heartbeat atualiza last_seen a cada 20s por tela,
// entao screens.db cresce sem parar (chegou a 786 linhas para 2 telas). Como o
// arquivo inteiro e relido e reprocessado na memoria a cada boot, sem compactar
// o servico fica lento e pesado com o tempo. Compacta a cada 30 min, reescrevendo
// so o estado atual. Os dados sao preservados: muda apenas o formato em disco.
const COMPACTION_MS = 30 * 60 * 1000;
Object.keys(db).forEach(name => {
  const store = db[name];
  if (store && typeof store.setAutocompactionInterval === 'function') {
    store.setAutocompactionInterval(COMPACTION_MS);
  }
});

// Gera slug a partir do nome: "Recepção Principal" → "recepcao-principal"
function toSlug(name) {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

db.toSlug = toSlug;

// Garante slug único: se "recepcao" já existe, tenta "recepcao-2", etc.
async function uniqueSlug(name) {
  const base = toSlug(name);
  let slug = base;
  let i = 2;
  while (await db.screens.findOne({ id: slug })) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

db.uniqueSlug = uniqueSlug;

async function seed() {
  const count = await db.groups.count({});
  if (count > 0) return;

  const g1 = uuidv4(), g2 = uuidv4(), g3 = uuidv4();
  const s1 = uuidv4(), s2 = uuidv4(), s3 = uuidv4();

  await db.groups.insert([
    { id: g1, name: 'Recepção',         color: '#378ADD', created_at: new Date() },
    { id: g2, name: 'Refeitório',       color: '#1D9E75', created_at: new Date() },
    { id: g3, name: 'Salas de reunião', color: '#7F77DD', created_at: new Date() },
  ]);

  await db.slides.insert([
    { id: s1, title: 'Bem-vindos!',   body: 'Reunião geral às 14h na sala principal.', type: 'bv',  duration: 8, bg: '#0a0a1a', url: null, created_at: new Date() },
    { id: s2, title: 'Meta do mês',   body: '87% atingida — vamos fechar forte!',      type: 'kpi', duration: 8, bg: '#0a1a12', url: null, created_at: new Date() },
    { id: s3, title: 'Cardápio hoje', body: 'Frango grelhado com arroz integral.',     type: 'msg', duration: 8, bg: '#1a1a2e', url: null, created_at: new Date() },
  ]);

  await db.gslides.insert([
    { group_id: g1, slide_id: s1, position: 1 },
    { group_id: g1, slide_id: s2, position: 2 },
    { group_id: g2, slide_id: s3, position: 1 },
  ]);

  // Tela de exemplo com slug legível
  await db.screens.insert({
    id: 'recepcao-principal',
    name: 'Recepção Principal',
    group_id: g1,
    last_seen: null,
    created_at: new Date()
  });

  console.log('📦 Banco inicializado com dados de exemplo');
  console.log('   Player de exemplo: http://localhost:3000/player/recepcao-principal');
}

seed().catch(console.error);

module.exports = db;
