'use strict';

const crypto = require('node:crypto');
const { v4: uuidv4 } = require('uuid');

function cleanText(value, max = 200) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function hashEntry(entry) {
  return crypto.createHash('sha256').update(stableStringify(entry)).digest('hex');
}

function safeDetails(details) {
  if (!details || typeof details !== 'object') return {};
  const result = {};
  Object.entries(details).slice(0, 20).forEach(([key, value]) => {
    if (/pass|senha|token|cookie|secret/i.test(key)) return;
    const safeKey = cleanText(key, 60);
    if (Array.isArray(value)) result[safeKey] = value.slice(0, 30).map(item => cleanText(item, 100));
    else if (typeof value === 'boolean' || typeof value === 'number' || value === null) result[safeKey] = value;
    else result[safeKey] = cleanText(value, 300);
  });
  return result;
}

function createAudit(db) {
  let writeQueue = Promise.resolve();

  function record(event = {}) {
    const operation = writeQueue.then(async () => {
      await db.ready;
      const latest = await db.audit.find({}).sort({ seq: -1 }).limit(1);
      const previous = latest[0] || null;
      const actor = event.actor ? {
        id: cleanText(event.actor.id, 80),
        username: cleanText(event.actor.username, 80),
        name: cleanText(event.actor.name, 120),
        role: cleanText(event.actor.role, 30)
      } : null;
      const entry = {
        id: uuidv4(),
        seq: previous ? previous.seq + 1 : 1,
        ts: new Date().toISOString(),
        actor,
        action: cleanText(event.action || 'unknown', 100),
        entity_type: cleanText(event.entity_type || 'system', 60),
        entity_id: cleanText(event.entity_id || '', 120) || null,
        outcome: ['success', 'failure', 'denied'].includes(event.outcome) ? event.outcome : 'success',
        ip: cleanText(event.ip || '', 80) || null,
        user_agent: cleanText(event.user_agent || '', 300) || null,
        request_id: cleanText(event.request_id || '', 80) || null,
        details: safeDetails(event.details),
        previous_hash: previous ? previous.integrity_hash : null
      };
      entry.integrity_hash = hashEntry(entry);
      await db.audit.insert(entry);
      return entry;
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }

  function fromRequest(req, event) {
    return record({
      ...event,
      actor: event.actor === undefined ? req.user : event.actor,
      ip: req.ip,
      user_agent: req.get && req.get('user-agent'),
      request_id: req.requestId
    });
  }

  async function verify() {
    await writeQueue;
    const entries = await db.audit.find({}).sort({ seq: 1 });
    let previousHash = null;
    let expectedSeq = 1;
    for (const stored of entries) {
      const entry = { ...stored };
      delete entry._id;
      const integrityHash = entry.integrity_hash;
      delete entry.integrity_hash;
      if (entry.seq !== expectedSeq || entry.previous_hash !== previousHash || hashEntry(entry) !== integrityHash) {
        return { ok: false, checked: expectedSeq - 1, total: entries.length, broken_at: entry.seq || expectedSeq };
      }
      previousHash = integrityHash;
      expectedSeq++;
    }
    return { ok: true, checked: entries.length, total: entries.length, broken_at: null };
  }

  return { record, fromRequest, verify, safeDetails };
}

module.exports = { createAudit };
