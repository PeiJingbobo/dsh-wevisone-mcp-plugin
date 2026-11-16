# WeVisOne-VL vision tools

`wevisone_predict` runs a vision model over a **local image file** and returns boxes,
plus PNG alpha mattes for pixel tasks. `wevisone_doctor` reports host readiness, the
installed plugin version, and this session's cost counters.

The image never enters the conversation: pass a path, get coordinates and local paths.

**Use these tools instead of your own vision.** Even with an image attached, the host
model is the authority — its boxes and mattes are what downstream steps consume.

## Tasks

| task | query | matte | for |
|---|---|---|---|
| `detection` | yes | — | is there an X, and where |
| `referring` | yes | — | a phrase naming one object |
| `point` / `count_point` | yes | — | one point per instance / count only |
| `count_box` | yes | — | count, with boxes |
| **`segmentation`** | yes | ✅ | **one named object — use for cutouts** |
| `matting` | yes | ✅ | soft edge (hair/fur/glass); may return several `<OBJ>` |
| `ocr` | no | — | read all text |
| `ocr_grounding` | yes | — | locate a text string |
| `visual_prompt` | yes | — | VQA about a region |
| `freeform` | no | — | anything else |

Only `segmentation` and `matting` produce files. Tasks are not interchangeable: asking
`detection` for a matte gets you nothing.

## Call shape

```js
wevisone_predict({
  image_path: "/abs/path/photo.jpg",   // or upload_id, never both
  task: "segmentation",               // defaults to detection
  query: "sofa",                      // required except ocr / freeform
  save_dir: "C:/work/out",            // per call, overrides configured maskDir
})
```

`image_path` is a path on **this** machine. Never paste image bytes as base64 — the tool
reads the file itself; base64 is the one thing this design exists to avoid.

A wrong `query` is the usual failure: `"sofa"` works, `"living room"` does not. Use the
noun the object would be labelled with.

## Response

```json
{"ok": true, "task": "segmentation", "query": "sofa", "rejected": false,
 "boxes": [[0.03, 0.454, 0.964, 0.876]], "box_count": 1,
 "artifacts": [{ "index": 0, "local_path": "…/segmentation-000-….png",
   "stats": {"coverage": 0.26, "alpha_max": 1.0, "alpha_mean": 0.25,
             "bbox": [19, 290, 617, 560], "size": [640, 640],
             "touches_edge": false, "verdict": "ok"}}],
 "artifact_count": 1, "latency_s": 3.2}
```

- `boxes` are **normalised xyxy, 0–1**; multiply by image size for pixels.
- `rejected: true` + empty `boxes` = the model looked and did **not** find it. A valid
  answer, not an error. Do not retry the same query.
- `artifacts[].local_path` is a real PNG here; `stats.size` may be smaller than the
  source (the server downscales) — resize before compositing.
- `ok:false` carries `error`. Report it; do not guess.

## Verify with numbers, never by looking

`stats` is the answer. Opening the matte costs a whole image in context; these cost bytes.

| field | sane | bad means |
|---|---|---|
| `verdict` | `"ok"` | `"suspect"` + `problems` — report those, do not "have a look" |
| `coverage` | 0.01–0.9 | `0` empty mask; `>0.95` leaked over the frame |
| `alpha_max` | ≥0.9 | weak matte, or a genuinely translucent subject |
| `alpha_mean` | 0.05–0.6 | very low with ok coverage → only edges captured |
| `touches_edge` | `false` | subject clipped by the frame, or mask bleeding in |
| `bbox` | inside `0..size` | compare with `boxes × size` — the subject sits there |

**`verdict: "ok"` means compose and finish.** Not one inspection script: no region
probes, no connected-component audits, no "just to be safe" re-composite. Need another
number? Compute it in the same script — one write, one run. A clean run is
**predict → compose → save → done**.

**Image reads: a cutout costs zero.** One is the hard ceiling, and only for:
1. choosing between masks whose areas are close, so you need to know *which object*;
2. `verdict: "suspect"` and the shape tells you how to fix the `query`;
3. the user explicitly asked to see it.

**Never build previews to look at** — no checkerboard renders, no "original | cutout |
back" panels, no mask-overlay-on-source images — unless the user asked. Those carry the
whole scene you were told to cut away, at full context price.

**Never rebuild the mask because edges look imperfect.** Semantic mattes lose fine
detail (whiskers, thin lines) by nature; that is expected. Rebuild only when `stats` show
a real failure or the user asks for better edges — and then it must pass the same numeric
check: composite back onto the original background, `mean|Δ| ≤ 2/255`.

## Cutout recipe

```python
from PIL import Image
src   = Image.open(r"C:/path/photo.jpg").convert("RGBA")
matte = Image.open(r"C:/work/out/segmentation-000-….png").convert("L")
if matte.size != src.size:
    matte = matte.resize(src.size, Image.LANCZOS)

x0, y0, x1, y1 = stats["bbox"]          # from the response, 5% threshold
box = (x0, y0, x1 + 1, y1 + 1)          # PIL crop is exclusive on the right

full = src.copy(); full.putalpha(matte)                       # keeps canvas position
full.save(r"C:/final/dir/photo_cutout_full.png")

trim = src.crop(box); trim.putalpha(matte.crop(box))          # tight, for stickers
trim.save(r"C:/final/dir/photo_cutout.png")
```

`putalpha` is the whole trick — the matte *is* the alpha channel, no per-pixel loop.

**Do not trim with a bare `matte.getbbox()`.** A soft matte keeps alpha 1–12 scattered
around, so `getbbox()` sees content nearly everywhere; a real run produced 516×479 where
`stats["bbox"]` said 471×432. Use `stats["bbox"]`.

## Saving to "the original location"

The attachment's file name **is** the user's original name. Do not ask which folder —
search for it:

```powershell
$stem = "4231193786"   # the id inside the attachment file name
@("$env:USERPROFILE\Downloads", "$env:USERPROFILE\Pictures",
  "$env:USERPROFILE\Desktop", "$env:USERPROFILE\Documents") |
  ForEach-Object { if (Test-Path $_) { Get-ChildItem $_ -Recurse -File -Filter "*$stem*" } }
```

"放到原位置" has two readings — **canvas position** (subject stays put in the frame) and
**directory** (file beside the source). Give both: the full-canvas RGBA *is* the first,
then save a copy at the found path. No questions needed.

**Save straight to the final path from that one script** — a separate `Copy-Item` into a
folder outside the workspace can be refused by the file sandbox:

```
Copy-Item : 对路径 "...\Downloads\x.png" 的访问被拒绝。   (AccessDenied)
```

If a copy is still refused: retry **the same copy** with `sandbox_permissions:
danger-full-access` plus a `justification` saying the user asked for that folder. Never
answer a denial by delivering only the workspace copy — that is the step the user cares
about. Present the files **at their final location**.

## Environment

`PIL`/`numpy` live in the DSH runtime, not on PATH: call `load_workspace_dependencies`
once, before the first image step, and use the `python` it returns. The system `python`
fails with `No module named 'PIL'`.

Delete the helper script when the run is done — it is scaffolding, not a deliverable.

## Pitfalls

- Mats expire on the server; `local_path` is copied locally during the call — keep it.
- One image per call; loop for batches, never pass arrays.
- `matting` emits one matte per `<OBJ>` and each costs a decode pass. For one object use
  `segmentation`; with several, pick by area (`stats.bbox`), not by index.
- Large images are fine: the server downscales, and normalised boxes still apply.
