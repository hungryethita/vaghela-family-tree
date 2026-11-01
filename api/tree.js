// GET  /api/tree  -> everything added or corrected since the original chart (public, read-only)
// POST /api/tree  -> one change; needs the family password in the x-family-password header
import { Redis } from '@upstash/redis';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import seed from '../data/seed.js';

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = url && token ? new Redis({ url, token }) : null;

const K = { people: 'vft:people', edits: 'vft:edits', orders: 'vft:orders', seeded: 'vft:seeded' };
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const BASE_ID = /^p\d{1,4}$/;

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const gender = v => (v === 'f' ? 'f' : 'm');
const now = () => new Date().toISOString();
const sha = s => createHash('sha256').update(String(s)).digest();

function passwordOk(given) {
  const expected = process.env.FAMILY_PASSWORD;
  if (!expected || !given) return false;
  return timingSafeEqual(sha(given), sha(expected));
}

async function ensureSeed() {
  const first = await redis.set(K.seeded, now(), { nx: true });
  if (!first) return;
  const w = [];
  if (Object.keys(seed.people).length) w.push(redis.hset(K.people, seed.people));
  if (Object.keys(seed.edits).length) w.push(redis.hset(K.edits, seed.edits));
  if (Object.keys(seed.orders).length) w.push(redis.hset(K.orders, seed.orders));
  await Promise.all(w);
}

class Rejected extends Error {}
const reject = m => { throw new Rejected(m); };

function personFields(d = {}) {
  const name = text(d.name, 80);
  if (!name) reject('Enter a name.');
  return { name, gender: gender(d.gender), spouse: text(d.spouse, 80), note: text(d.note, 300) };
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!redis) {
    return res.status(503).json({ error: 'Storage is not connected. Add an Upstash Redis database to this Vercel project.' });
  }
  try {
    if (req.method === 'GET') {
      await ensureSeed();
      const [people, edits, orders] = await Promise.all([
        redis.hgetall(K.people), redis.hgetall(K.edits), redis.hgetall(K.orders),
      ]);
      return res.status(200).json({ people: people || {}, edits: edits || {}, orders: orders || {}, editable: !!process.env.FAMILY_PASSWORD });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed.' });
    }
    if (!passwordOk(req.headers['x-family-password'])) {
      return res.status(401).json({ error: 'Wrong family password.' });
    }

    const body = await readJson(req);
    const { action } = body;

    if (action === 'check') return res.status(200).json({ ok: true });

    if (action === 'addPerson') {
      const d = body.data || {};
      const parentId = text(d.parentId, 40);
      if (!ID.test(parentId)) reject('Choose who this person is a child of.');
      if (!BASE_ID.test(parentId) && !(await redis.hexists(K.people, parentId))) reject('That parent is no longer on the tree.');
      const id = randomBytes(10).toString('hex');
      await redis.hset(K.people, { [id]: { ...personFields(d), parentId, addedAt: now() } });
      return res.status(200).json({ ok: true, id });
    }

    if (action === 'updatePerson') {
      const id = text(body.id, 40);
      const cur = ID.test(id) ? await redis.hget(K.people, id) : null;
      if (!cur) reject('That person is no longer on the tree.');
      await redis.hset(K.people, { [id]: { ...cur, ...personFields(body.data), editedAt: now() } });
      return res.status(200).json({ ok: true });
    }

    if (action === 'deletePerson') {
      const id = text(body.id, 40);
      if (!ID.test(id) || !(await redis.hexists(K.people, id))) reject('That person is no longer on the tree.');
      const all = (await redis.hgetall(K.people)) || {};
      if (Object.values(all).some(p => p && p.parentId === id)) reject('Remove their children first.');
      await redis.hdel(K.people, id);
      await redis.hdel(K.orders, id);
      return res.status(200).json({ ok: true });
    }

    if (action === 'setEdit') {
      const id = text(body.id, 10);
      if (!BASE_ID.test(id)) reject('Only people from the original chart can be corrected this way.');
      const d = body.data || {};
      await redis.hset(K.edits, { [id]: { ...personFields(d), resolved: !!d.resolved, editedAt: now() } });
      return res.status(200).json({ ok: true });
    }

    if (action === 'setOrder') {
      const parentId = text(body.parentId, 40);
      const ids = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string' && ID.test(x)).slice(0, 200) : [];
      if (!ID.test(parentId) || !ids.length) reject('That move could not be saved.');
      await redis.hset(K.orders, { [parentId]: { ids, movedAt: now() } });
      return res.status(200).json({ ok: true });
    }

    reject('Unknown change.');
  } catch (e) {
    if (e instanceof Rejected) return res.status(400).json({ error: e.message });
    if (e instanceof SyntaxError) return res.status(400).json({ error: 'The request was not valid.' });
    console.error(e);
    return res.status(500).json({ error: 'Something went wrong saving the tree.' });
  }
}
