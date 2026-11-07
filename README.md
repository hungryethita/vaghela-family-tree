# Vaghela Family Tree

An interactive family tree descending from Sabhabhai, transcribed from the hand-drawn chart dated 20-09-09.
Anyone with the link can view, zoom and search it. Family members who know the shared password can add people,
correct names, record more than one wife or husband, set gender, reorder brothers and sisters, move a person (and everyone below them) to a different parent,
remove people (they can be restored from "Removed"), attach photos (and switch to a Photos view of faces), download the tree or any branch as a PDF, and clear the yellow "please check" flags.

## Deploy on Vercel

1. **Import the repo** in Vercel (Add New → Project → pick this repo). No build settings are needed.
2. **Add storage**: in the project, open **Storage → Create / Connect → Upstash for Redis** (free tier is fine)
   and connect it to the project. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
3. **Set the family password**: **Settings → Environment Variables → `FAMILY_PASSWORD`** = a password you'll share
   with family members who should be able to edit.
4. **Turn on photos**: in **Storage**, create a **Blob** store and connect it to the project. This adds
   `BLOB_READ_WRITE_TOKEN` automatically (a custom prefix also works). Choose **Public** access. Until it's connected,
   the "+ Add photos" button stays hidden and editors see a note saying photos are switched off.
5. **Redeploy** (Deployments → ⋯ → Redeploy) so the new settings take effect.

The first time the site loads, the additions already made on the claude.ai version (`data/seed.js`) are copied into the database.

## How it's built

- `index.html`: the whole page (D3 for the tree, loaded from cdnjs). The original chart lives in the `RAW` block.
- `api/tree.js`: one serverless function. `GET` returns everything added or corrected; `POST` saves one change
  and requires the `x-family-password` header.
- Storage is three Redis hashes: `vft:people` (added people), `vft:edits` (corrections to chart people),
  `vft:orders` (children order per parent), `vft:photos` (photo records; the images live in Vercel Blob).
  Removing and moving are stored as flags (`removed`, `parentId`), so nothing is ever hard-deleted from the tree.

People from the original chart have ids `p0`, `p1`, … in the order they appear in `RAW`, so add new people through
the site rather than editing `RAW`, or the ids will shift.
