# Using WeVisOne-VL vision tools

`wevisone_predict` runs a vision model over **a local image file** and returns boxes
(and, for pixel tasks, PNG alpha mattes written next to you). `wevisone_doctor`
reports whether the host is reachable.

The image never enters this conversation: you pass a path, you get back coordinates
and local file paths.

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
| `segmentation` | yes | ✅ matte | mask one named object |
| `matting` | yes | ✅ matte | soft alpha edge, hair/fur/glass |
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
                 "local_path": "/Users/you/wevisone-masks/segmentation-000-….png"}],
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
