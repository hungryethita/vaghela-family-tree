// GET  /api/tree  -> everything added or corrected since the original chart (public, read-only)
// POST /api/tree  -> one change; needs the family password in the x-family-password header
import { Redis } from '@upstash/redis';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { put, del } from '@vercel/blob';
import seed from '../data/seed.js';

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = url && token ? new Redis({ url, token }) : null;

const K = { people: 'vft:people', edits: 'vft:edits', orders: 'vft:orders', photos: 'vft:photos', seeded: 'vft:seeded' };
// Vercel names the token BLOB_READ_WRITE_TOKEN unless a custom prefix was chosen when connecting the store,
// so also accept any *_READ_WRITE_TOKEN that holds a Blob token.
function blobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  for (const [k, v] of Object.entries(process.env)) {
    if (/READ_WRITE_TOKEN$/.test(k) && typeof v === 'string' && v.startsWith('vercel_blob_rw_')) return v;
  }
  return null;
}
// Newer Blob stores have no token: they set BLOB_STORE_ID and sign in with Vercel's per-request OIDC token.
const photosOn = () => !!(blobToken() || process.env.BLOB_STORE_ID);
function blobAuth(req) {
  const token = blobToken();
  if (token) return { token };
  const oidcToken = req.headers['x-vercel-oidc-token'] || process.env.VERCEL_OIDC_TOKEN;
  return oidcToken ? { oidcToken, storeId: process.env.BLOB_STORE_ID } : { storeId: process.env.BLOB_STORE_ID };
}
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
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
  const spouses = (Array.isArray(d.spouses) ? d.spouses : [d.spouse])
    .map(x => text(x, 80)).filter(Boolean).slice(0, 6);
  return { name, gender: gender(d.gender), spouses, spouse: spouses.join(', '), note: text(d.note, 300) };
}

async function merge(key, id, patch) {
  const cur = (await redis.hget(key, id)) || {};
  await redis.hset(key, { [id]: { ...cur, ...patch } });
}

async function personExists(id) {
  return BASE_ID.test(id) || (ID.test(id) && !!(await redis.hexists(K.people, id)));
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
      const [people, edits, orders, photos] = await Promise.all([
        redis.hgetall(K.people), redis.hgetall(K.edits), redis.hgetall(K.orders), redis.hgetall(K.photos),
      ]);
      return res.status(200).json({
        people: people || {}, edits: edits || {}, orders: orders || {}, photos: photos || {},
        editable: !!process.env.FAMILY_PASSWORD, photosEnabled: photosOn(),
      });
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
      await merge(K.edits, id, { ...personFields(d), resolved: !!d.resolved, editedAt: now() });
      return res.status(200).json({ ok: true });
    }

    if (action === 'setOrder') {
      const parentId = text(body.parentId, 40);
      const ids = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string' && ID.test(x)).slice(0, 200) : [];
      if (!ID.test(parentId) || !ids.length) reject('That move could not be saved.');
      await redis.hset(K.orders, { [parentId]: { ids, movedAt: now() } });
      return res.status(200).json({ ok: true });
    }

    if (action === 'setRemoved') {
      const id = text(body.id, 40);
      if (id === 'p0') reject('The founder cannot be removed.');
      const patch = { removed: !!body.removed, removedAt: now() };
      if (BASE_ID.test(id)) await merge(K.edits, id, patch);
      else if (ID.test(id) && (await redis.hexists(K.people, id))) await merge(K.people, id, patch);
      else reject('That person is no longer on the tree.');
      return res.status(200).json({ ok: true });
    }

    if (action === 'setParent') {
      const id = text(body.id, 40), parentId = text(body.parentId, 40);
      if (id === 'p0') reject('The founder cannot be moved.');
      if (!ID.test(id) || id === parentId) reject('Choose a different parent.');
      if (!(await personExists(parentId))) reject('That parent is no longer on the tree.');
      if (BASE_ID.test(id)) await merge(K.edits, id, { parentId, movedAt: now() });
      else if (await redis.hexists(K.people, id)) await merge(K.people, id, { parentId, movedAt: now() });
      else reject('That person is no longer on the tree.');
      return res.status(200).json({ ok: true });
    }

    if (action === 'addPhoto') {
      if (!photosOn()) reject('Photos are not switched on yet. Connect Vercel Blob storage to this project.');
      const personId = text(body.personId, 40);
      if (!(await personExists(personId))) reject('That person is no longer on the tree.');
      const m = typeof body.dataUrl === 'string' && body.dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
      if (!m) reject('That file is not a photo this site can use. Try a JPEG or PNG.');
      const bytes = Buffer.from(m[2], 'base64');
      if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) reject('That photo is too large.');
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const blob = await put(`photos/${personId}/${randomBytes(8).toString('hex')}.${ext}`, bytes, {
        access: 'public', contentType: `image/${m[1]}`, addRandomSuffix: false, ...blobAuth(req),
      });
      const photoId = randomBytes(10).toString('hex');
      await redis.hset(K.photos, { [photoId]: { personId, url: blob.url, caption: text(body.caption, 200), addedAt: now() } });
      return res.status(200).json({ ok: true, id: photoId, url: blob.url });
    }

    if (action === 'deletePhoto') {
      const photoId = text(body.photoId, 40);
      const cur = ID.test(photoId) ? await redis.hget(K.photos, photoId) : null;
      if (!cur) reject('That photo has already been deleted.');
      if (photosOn() && cur.url) { try { await del(cur.url, blobAuth(req)); } catch (e) { console.error(e); } }
      await redis.hdel(K.photos, photoId);
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
