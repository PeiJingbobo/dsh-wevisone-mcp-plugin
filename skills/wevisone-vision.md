# Using WeVisOne-VL vision tools

`wevisone_predict` runs a vision model over **a local image file** and returns boxes
(and, for pixel tasks, PNG alpha mattes written next to you). `wevisone_doctor`
reports whether the host is reachable.

The image never enters this conversation: you pass a path, you get back coordinates
and local file paths.

**Use these tools instead of your own image understanding.** Even if you can see an
attached image, the host model is the authority here: its coordinates and mattes are
what downstream steps consume. Answering from your own vision silently produces boxes
nothing else can use.

## Before the first call

Call `wevisone_doctor` when a prediction fails or before a batch you cannot easily
retry. It reports the endpoint, whether a token is configured, and the mask directory.
`ok:false` means the host is unreachable or the token is wrong — fix that first; the
vision model is not the problem.

## Calling it

```js
wevisone_predict({
  image_path: "/absolute/path/to/photo.jpg",  // preferred
  task: "segmentation",
  query: "sofa",
})
```

- `image_path` — a path **on the machine running this plugin**. Use this.
- `upload_id` — only when the image already sits on the server (it came back from a
  previous upload). Provide exactly one of `image_path` / `upload_id`.
- `task` — see the table below; defaults to `detection`.
- `query` — what to find. Most tasks require it; the empty string is only valid for
  `ocr` and `freeform`.
- `save_dir` — optional override for where mattes are written.

## Tasks

| task | query | pixel output | use it for |
|---|---|---|---|
| `detection` | yes | — | "is there an X, and where" |
| `referring` | yes | — | a phrase naming one object ("the cup next to the sink") |
| `point` | yes | — | one point per instance |
| `count_box` | yes | — | count instances, with boxes |
| `count_point` | yes | — | count only |
| `segmentation` | yes | ✅ matte | mask one named object — **use this for cutouts** |
| `matting` | yes | ✅ matte | soft alpha edge (hair/fur/glass); often returns several `<OBJ>` |
| `ocr` | no | — | read all text |
| `ocr_grounding` | yes | — | locate a specific text string |
| `visual_prompt` | yes | — | free-form VQA about a region |
| `freeform` | no | — | anything else, raw model answer |

`segmentation` and `matting` are the only tasks that produce files.

## Reading the result

```json
{
  "ok": true, "task": "segmentation", "query": "sofa", "rejected": false,
  "boxes": [[0.03, 0.454, 0.964, 0.876]], "box_count": 1,
  "artifacts": [{"index": 0, "url": "/artifacts/…", "bytes": 23538,
                 "local_path": "/Users/you/wevisone-masks/segmentation-000-….png",
                 "stats": {"alpha_min": 0.0, "alpha_max": 1.0, "alpha_mean": 0.25,
                           "coverage": 0.26, "size": [640, 640],
                           "bbox": [19, 290, 617, 560], "touches_edge": false}}],
  "artifact_count": 1, "latency_s": 3.2
}
```

- `boxes` are **normalised xyxy in 0–1**. Multiply by image width/height for pixels.
- `rejected: true` with `boxes: []` means the model looked and **did not find it**.
  That is a valid answer, not an error — do not retry the same query.
- `artifacts[].local_path` is a real PNG on this machine, one per box, in the same
  order. The matte is an 8-bit grayscale alpha map, full image size. Open it with
  your image tools; do not try to interpret the base64 `url` by hand.
- `ok:false` carries `error`. Report it; do not guess a result.

## Workflows

**Mask an object, then use the mask.**
```js
const r = wevisone_predict({ image_path: p, task: "segmentation", query: "sofa" })
// r.artifacts[0].local_path → feed into the next step (crop, composite, measure)
```

**Find and count.**
```js
wevisone_predict({ image_path: p, task: "count_box", query: "window" })
// r.box_count is the count; r.boxes gives each location
```

**Read a screenshot.**
```js
wevisone_predict({ image_path: p, task: "ocr" })
// the text is in r.response
```

**Cut one object out as a transparent PNG.**
```js
const r = wevisone_predict({ image_path: p, task: "segmentation", query: "watermelon slice",
                             save_dir: "C:/work/out" })   // masks land here
// if r.box_count > 1, one mask per box: take the largest by area, not index 0
```

Then compose once — do not hand-roll this three times:

```python
from PIL import Image
src   = Image.open(r"C:/path/photo.jpg").convert("RGBA")
matte = Image.open(r"C:/work/out/segmentation-000-….png").convert("L")
box   = matte.getbbox()                      # trim empty margin (also speeds everything up)
src, matte = src.crop(box), matte.crop(box)
src.putalpha(matte)                           # one line; no per-pixel loop
src.save(r"C:/path/photo_cutout.png")         # RGBA PNG, background transparent
```

`putalpha` is the whole trick: the matte already is the alpha channel. `getbbox()`
keeps the transparent margin out of the file. If the subject looks half-transparent,
the matte was resized — open both and check `matte.size == src.size` before cropping.

## Verify with the numbers, not by opening the image

`stats` already answers "is this matte sane". Opening the PNG costs a whole image in
your context; these fields cost a few dozen bytes. **Do not call `read_image` on a
matte to check that it worked.**

| field | sane range | what a bad value means |
|---|---|---|
| `coverage` | 0.01 – 0.9 | `0` → empty mask, the query missed; `>0.95` → mask leaked over the frame |
| `alpha_max` | ≥ 0.9 | lower → weak matte, or the subject really is translucent (glass, smoke, water) |
| `alpha_mean` | 0.05 – 0.6 | very low with decent coverage → only edges captured |
| `touches_edge` | `false` | `true` → subject likely clipped by the frame, or mask bleeding into the border |
| `bbox` | inside `0..size` | compare with the reported `boxes` (multiply by `size`) — the subject should sit near them |
| `size` | any | the matte's own pixel size; the server may downscale, so resize to the source size before compositing |

Checks that need no image at all:
```python
# after the download, before composing
assert 0.01 <= stats["coverage"] <= 0.9, stats
assert stats["alpha_max"] >= 0.9, stats
assert not stats["touches_edge"], stats
```

**Open the image only when:**
1. you must choose between several masks and the areas are close, so you need to know
   *which object* each one is; or
2. the numbers flagged a problem and you want to see the shape of it; or
3. the user explicitly asked for a visual preview.

Otherwise report the numbers and move on. **A cutout task should cost zero image
reads; treat one as the ceiling.** More than one means you are re-verifying something the
numbers already answered.

**Do not rebuild the mask by hand because the edges look imperfect.** Semantic mattes lose
fine detail (whiskers, thin lines) by nature — that is expected, not a defect. Rebuild only
when `stats` show a real failure (empty, leaked, clipped) **or** the user asks for higher
edge quality. If you do rebuild, the same numeric check must hold: composite back onto the
original background and require `mean|Δ| ≤ 2/255`.

## Use the workspace python, not the system one

`PIL`/`numpy` live in the DSH runtime, not in whatever `python` is on PATH. Calling the
system interpreter costs a failed step every time:

```powershell
# wrong: ModuleNotFoundError: No module named 'PIL'
python -c "from PIL import Image; ..."

# right: take the path from load_workspace_dependencies once, reuse it
& "C:\Users\<you>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" script.py
```

Call `load_workspace_dependencies` **before** the first image step, not after a failure.

## "Original place": two meanings, resolve both in one pass

"放到原位置" can mean either, and guessing wrong costs a round trip:

| reading | what the user gets |
|---|---|
| **canvas position** — subject stays where it sat in the frame | full-size RGBA with alpha, no crop |
| **directory** — file next to the source image | a copy beside the original file |

Do not pick one and hope. Produce the full-canvas RGBA (cheap, it is the same composite)
**and** drop a copy next to the source using the search rule below, then say which is
which. That satisfies both readings with zero extra questions.

## When the user says "save it where the original is"

The attachment path is content-addressed and its **file name is the user's original
name** (e.g. `u=4231193786,3187314859&fm=3028&app=3028&f=JPEG&fmt=auto.webp`). Do
not ask which folder: search the usual ones for that name.

```powershell
$stem = "4231193786"   # the distinctive id inside the attachment file name
@("$env:USERPROFILE\Downloads", "$env:USERPROFILE\Pictures",
  "$env:USERPROFILE\Desktop", "$env:USERPROFILE\Documents") |
  ForEach-Object { if (Test-Path $_) { Get-ChildItem $_ -Recurse -File -Filter "*$stem*" } }
```

Already present a copy in the workspace? Compare it to the hit before writing so you do
not overwrite a different file with the same stem. Writing the result next to the source
is what "原位置" means; asking for a path is a fallback only when the search finds nothing.

## Pitfalls

- **Do not paste images as base64 into this conversation.** Pass `image_path`; the
  plugin reads the file itself. Base64 is the one thing this design exists to avoid.
- **Large images are fine.** The server downscales to its own pixel budget before
  inference; boxes are normalised, so they still apply to the original resolution.
- **Masks are transient on the server but local here.** The plugin copies each matte
  into `maskDir` during the call, so keep the returned `local_path` — the server URL
  expires in minutes.
- **A wrong `query` is the usual failure.** "sofa" works; "living room" does not.
  Use the noun the object would be labelled with.
- **Tasks are not interchangeable.** `detection` answers "where"; only
  `segmentation`/`matting` write mattes. Asking for a matte from `detection` returns
  nothing useful.
- **One image per call.** Loop for batches; do not pass arrays.
- **`read_image` is the expensive move.** Each call puts a full image into this
  conversation. `stats` covers correctness; only look when identity or a visual
  judgement is genuinely needed.
- **`matting` can return many masks.** Every `<OBJ>` in the answer becomes an artifact,
  and each one costs a decode pass. For "cut out this one object" use `segmentation`;
  if you already have several masks, pick by area (`matte.getbbox()` size), not by index.
- **`save_dir` is per call** and overrides the configured `maskDir`; use it so masks land
  next to the output you are building.
