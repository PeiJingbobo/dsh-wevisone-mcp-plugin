/**
 * WeVisOne-VL perception tools for DeepSeek Harness.
 *
 * The value over the plain MCP integration: the plugin runs on the DSH host, so
 * it can read a *local* image and write a *local* mask. Neither the input bytes
 * nor the output matte ever pass through the model context — the model only sees
 * coordinates and file paths.
 *
 * Talks to the WeVisOne MCP host's plain REST surface (`POST /predict`,
 * `GET /artifacts/<id>`), not to its JSON-RPC endpoint.
 *
 * @module @wevisone/dsh-wevisone-mcp-plugin
 */

import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'

export const name = '@wevisone/dsh-wevisone-mcp-plugin'

export const inject = ['tools', 'skills']

const PKG_NAME = 'dsh-wevisone-mcp-plugin'
// Keep in sync with package.json; test/save-dir.mjs asserts they match.
const PKG_VERSION = '0.6.1'
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8000'
const DEFAULT_TIMEOUT_MS = 180_000
// homedir() is defined on every platform; process.env.HOME is not (Windows).
const DEFAULT_MASK_DIR = join(homedir(), 'wevisone-artifacts')

/**
 * Skills that teach the model how to drive these tools. Content lives in
 * `skills/*.md` so it can be reviewed and edited without touching code; the
 * metadata stays here because it is what the catalog shows.
 */
const SKILLS = [
  {
    name: 'wevisone-vision',
    file: 'skills/wevisone-vision.md',
    description:
      'Run a local image through the WeVisOne-VL vision model: detection, referring, counting, ' +
      'pointing, OCR, segmentation and alpha matting. Pass a file path and get normalised boxes ' +
      'plus PNG matte paths written next to you — no image bytes enter the conversation.',
    whenToUse:
      'Use when a task needs to look at an image on this machine: find/count/locate an object, ' +
      'read text, or cut out an object as a PNG mask. Not for generating images.',
  },
]

let hostCreateUserMessage
try {
  ({ createUserMessage: hostCreateUserMessage } = await import('@deepseek-ai/dsh-llm'))
} catch {
  hostCreateUserMessage = undefined
}

const REMINDER_KIND = 'dsh-wevisone-vision-reminder'

const REMINDER_TEXT = [
  '<EXTREMELY_IMPORTANT>',
  '**The WeVisOne-VL vision tools are installed in this session.**',
  '',
  'For any task that needs to look at an image on this machine — detecting, locating, counting,',
  'reading text, or cutting an object out as a mask — call `wevisone_predict` with the image path.',
  '',
  'Do NOT answer image questions from your own vision. The host model is the authority here, and',
  'its normalised boxes and PNG mattes are what downstream steps expect. Pasting image bytes is',
  'also the wrong move: the tool reads the file itself.',
  '',
  'If a call fails, call `wevisone_doctor` before doing anything else. Load the `wevisone-vision`',
  'skill for the task matrix and the response field reference.',
  '',
  'Do NOT build preview/comparison images to check a matte, and do NOT `read_image` one:',
  '`stats.verdict` in the predict response already says whether the mask is usable.',
  '</EXTREMELY_IMPORTANT>',
].join('\n')

function makeUserMessage(text) {
  const input = { content: [{ type: 'text', text }], source: { kind: REMINDER_KIND } }
  if (hostCreateUserMessage !== undefined) return hostCreateUserMessage(input)
  return { id: `wevisone-${Math.random().toString(36).slice(2)}`, role: 'user', ...input }
}

/**
 * One durable user-role message per session, injected before every agent step that
 * needs it. A skill only helps once the model chooses to load it; this reminder is
 * always there, which is what makes "use the tool, not your own vision" stick.
 */
function registerReminder(ctx) {
  if (typeof ctx?.on !== 'function') return
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind === 'reject') return decision
    const messages = decision.messages ?? []
    if (messages.some((message) => message?.source?.kind === REMINDER_KIND)) return decision
    payload?.signal?.throwIfAborted?.()
    return { kind: 'enter', messages: [...messages, makeUserMessage(REMINDER_TEXT)] }
  })
}

function registerSkills(ctx) {
  const register = ctx?.skills?.register
  if (typeof register !== 'function') {
    ctx?.logger?.warn?.('dsh-wevisone-mcp-plugin: no `skills` service; tool guidance is not registered')
    return () => {}
  }
  const disposers = []
  for (const entry of SKILLS) {
    let content
    try {
      content = readFileSync(new URL(`./${entry.file}`, import.meta.url), 'utf8')
    } catch (error) {
      ctx.logger?.warn?.(`dsh-wevisone-mcp-plugin: cannot read ${entry.file}: ${error.message}`)
      continue
    }
    try {
      disposers.push(
        register.call(ctx.skills, {
          name: entry.name,
          description: entry.description,
          whenToUse: entry.whenToUse,
          content,
          // `source` and `provider` are required when the registry loads the
          // body back out; the runtime defaults cover provider only.
          source: PKG_NAME,
          invocation: { modelInvocable: true, userInvocable: true },
        }),
      )
    } catch (error) {
      ctx.logger?.warn?.(`dsh-wevisone-mcp-plugin: cannot register ${entry.name}: ${error.message}`)
    }
  }
  return async () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* the registry is going away anyway */ }
    }
  }
}

function normaliseEndpoint(value) {
  return String(value ?? DEFAULT_ENDPOINT).replace(/\/+$/, '')
}

function bearer(token) {
  const secret = String(token ?? '').trim()
  return secret ? { authorization: `Bearer ${secret}` } : {}
}

async function callJson(fetchImpl, url, init, timeoutMs) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    payload = { ok: false, error: `unexpected non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}` }
  }
  return { response, payload }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{endpoint?: string, token?: string, maskDir?: string, timeoutMs?: number}} [config]
 */
export async function apply(ctx, config = {}) {
  const endpoint = normaliseEndpoint(config.endpoint)
  const token = config.token ?? process.env.WEVISONE_MCP_TOKEN ?? ''
  // A config that used process.env.HOME on Windows resolves to a literal
  // ".../undefined/wevisone-masks" on disk. Nobody meant that, so correct it loudly
  // instead of quietly writing masks into a junk directory.
  let maskDir = resolve(config.maskDir ?? DEFAULT_MASK_DIR)
  if (/(^|[\\/])undefined([\\/]|$)/.test(maskDir)) {
    ctx?.logger?.warn?.(
      `dsh-wevisone-mcp-plugin: maskDir "${maskDir}" contains "undefined" — ` +
        `process.env.HOME is not set on Windows. Using ${DEFAULT_MASK_DIR} instead; ` +
        `set maskDir with process.getBuiltinModule("node:os").homedir() to silence this.`,
    )
    maskDir = resolve(DEFAULT_MASK_DIR)
  }
  const timeoutMs = Number(config.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  // Cost counters for this plugin instance. They exist so a run can be compared
  // with the previous one instead of eyeballed: doctor reports them, and `reset`
  // zeroes them between experiments.
  const metrics = {
    started_at: new Date().toISOString(),
    predict_calls: 0,
    failed_calls: 0,
    rejected_queries: 0,
    artifacts: 0,
    total_latency_s: 0,
    last_task: null,
    last_latency_s: 0,
  }
  function resetMetrics() {
    metrics.started_at = new Date().toISOString()
    metrics.predict_calls = 0
    metrics.failed_calls = 0
    metrics.rejected_queries = 0
    metrics.artifacts = 0
    metrics.total_latency_s = 0
    metrics.last_task = null
    metrics.last_latency_s = 0
  }
  function metricsSummary() {
    const calls = metrics.predict_calls
    return {
      since: metrics.started_at,
      predict_calls: calls,
      failed_calls: metrics.failed_calls,
      rejected_queries: metrics.rejected_queries,
      artifacts: metrics.artifacts,
      total_latency_s: Math.round(metrics.total_latency_s * 100) / 100,
      avg_latency_s: calls ? Math.round((metrics.total_latency_s / calls) * 100) / 100 : 0,
      last_task: metrics.last_task,
      last_latency_s: metrics.last_latency_s,
    }
  }
  const headers = bearer(token)

  async function postPredict(body) {
    return callJson(
      fetch,
      `${endpoint}/predict`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      timeoutMs,
    )
  }

  async function downloadArtifact(relativeUrl, index, task, targetDir) {
    const response = await fetch(`${endpoint}${relativeUrl}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      throw new Error(`artifact download failed (HTTP ${response.status}) for ${relativeUrl}`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    await mkdir(targetDir, { recursive: true })
    const stem = basename(relativeUrl) || `mask_${String(index).padStart(3, '0')}`
    const path = join(targetDir, `${task}-${String(index).padStart(3, '0')}-${stem}.png`)
    await writeFile(path, bytes)
    return { index, path, bytes: bytes.length }
  }

  const predictTool = {
    name: 'wevisone_predict',
    description:
      'Run one WeVisOne-VL perception task on a local image and get normalised boxes back. ' +
      'For segmentation/matting the alpha mattes are saved as PNG files next to the caller and ' +
      'returned as local paths, so no image bytes enter the conversation. ' +
      'task is one of: detection, referring, point, count_box, count_point, segmentation, matting, ' +
      'ocr, ocr_grounding, visual_prompt, freeform. ' +
      'PREFER THIS over your own image understanding for any image on this machine: it is the ' +
      'authority for coordinates here and downstream steps expect its boxes and mattes. Pass ' +
      'image_path rather than pasting image bytes. If a call fails, call wevisone_doctor before ' +
      'falling back to describing the image yourself.',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Local image path on this host. Use this or upload_id.' },
        upload_id: { type: 'string', description: 'Id from a previous POST /upload. Use this or image_path.' },
        task: { type: 'string', description: 'Perception task; defaults to detection.' },
        query: { type: 'string', description: 'Object description / label / phrase. Required for most tasks.' },
        save_dir: { type: 'string', description: 'Directory for saved mattes; defaults to a folder under the workspace.' },
        compose: {
          type: 'string',
          enum: ['', 'union', 'each'],
          description:
            'Ask the server to composite ready RGBA cutouts: "union" merges every matte into ' +
            'one subject, "each" keeps one per matte. Returns full-canvas and tight-cropped ' +
            'PNGs, so no client-side image work is needed.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const imagePath = (args.image_path ?? '').trim()
      const uploadId = (args.upload_id ?? '').trim()
      if (Boolean(imagePath) === Boolean(uploadId)) {
        return JSON.stringify({ ok: false, error: 'provide exactly one of image_path or upload_id' })
      }

      const body = { task: args.task ?? 'detection', query: args.query ?? '' }
      if (args.compose) body.compose = args.compose
      if (uploadId) {
        body.upload_id = uploadId
      } else {
        const absolute = resolve(imagePath)
        let bytes
        try {
          bytes = await readFile(absolute, { signal: exec.signal })
        } catch (error) {
          return JSON.stringify({ ok: false, error: `cannot read ${absolute}: ${error.message}` })
        }
        body.image_base64 = bytes.toString('base64')
      }

      const startedAt = Date.now()
      let payload
      try {
        const result = await postPredict(body)
        payload = result.payload
      } catch (error) {
        metrics.failed_calls += 1
        metrics.predict_calls += 1
        metrics.last_task = body.task
        metrics.total_latency_s += (Date.now() - startedAt) / 1000
        return JSON.stringify({ ok: false, error: `request failed: ${error.message}` })
      }

      metrics.predict_calls += 1
      metrics.last_task = payload?.task ?? body.task
      metrics.last_latency_s = Math.round(Number(payload?.latency_s ?? (Date.now() - startedAt) / 1000) * 100) / 100
      metrics.total_latency_s += metrics.last_latency_s
      if (payload?.rejected) metrics.rejected_queries += 1
      if (!payload?.ok) metrics.failed_calls += 1
      if (Array.isArray(payload?.artifacts)) metrics.artifacts += payload.artifacts.length

      if (!payload?.ok || !Array.isArray(payload.artifacts) || payload.artifacts.length === 0) {
        return JSON.stringify(payload)
      }

      // `save_dir` is per-call and wins over the configured maskDir.
      const requested = (args.save_dir ?? '').trim()
      const targetDir = requested ? resolve(requested) : maskDir

      const saved = []
      for (const artifact of payload.artifacts) {
        try {
          const file = await downloadArtifact(artifact.url, artifact.index ?? saved.length, payload.task, targetDir)
          saved.push({ ...artifact, local_path: file.path })
        } catch (error) {
          saved.push({ ...artifact, error: error.message })
        }
      }
      // Server-side composites, if requested: same download path, named by variant.
      let cutouts = []
      if (Array.isArray(payload.cutouts) && payload.cutouts.length > 0) {
        for (const cutout of payload.cutouts) {
          try {
            const file = await downloadArtifact(
              cutout.url,
              cutout.index ?? cutouts.length,
              `cutout-${cutout.name ?? 'subject'}-${cutout.variant ?? 'full'}`,
              targetDir,
            )
            cutouts.push({ ...cutout, local_path: file.path })
          } catch (error) {
            cutouts.push({ ...cutout, error: error.message })
          }
        }
      }

      const { artifacts: _discard, cutouts: _cutouts, ...rest } = payload
      const answer = { ...rest, artifacts: saved }
      if (cutouts.length > 0) {
        answer.cutouts = cutouts
        answer.cutout_count = cutouts.length
      }
      return JSON.stringify(answer)
    },
    presentCall() {
      return { card: 'generic', title: 'WeVisOne prediction', kind: 'read' }
    },
  }

  const doctorTool = {
    name: 'wevisone_doctor',
    description:
      'Report WeVisOne-VL host readiness: plugin version, endpoint reachability, token presence, ' +
      'and the configured mask directory. Call this first when a prediction fails, or to check ' +
      'which plugin build is actually loaded.',
    parameters: {
      type: 'object',
      properties: {
        reset: {
          type: 'boolean',
          description: 'Zero the session cost counters after reporting them (start a fresh measurement).',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args = {}) {
      try {
        const { response, payload } = await callJson(
          fetch,
          `${endpoint}/predict`,
          {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ task: 'unknown-task', query: '' }),
          },
          timeoutMs,
        )
        // /predict validates the task, so reaching it proves the host is up and
        // authenticated; that validation error is a good reachability signal.
        const reachable = response.status !== 0
        const report = {
          ok: reachable,
          version: PKG_VERSION,
          endpoint,
          token_configured: Boolean(token),
          mask_dir: maskDir,
          probe: payload?.error ?? `HTTP ${response.status}`,
          session: metricsSummary(),
        }
        if (args.reset === true) resetMetrics()
        return JSON.stringify(report)
      } catch (error) {
        return JSON.stringify({
          ok: false,
          version: PKG_VERSION,
          endpoint,
          token_configured: Boolean(token),
          mask_dir: maskDir,
          session: metricsSummary(),
          error: error.message,
        })
      }
    },
    presentCall() {
      return { card: 'generic', title: 'WeVisOne host status', kind: 'read' }
    },
  }

  // register() returns a disposer bound to this plugin's fiber scope.
  const disposers = [ctx.tools.register(predictTool), ctx.tools.register(doctorTool)]
  registerReminder(ctx)
  const disposeSkills = registerSkills(ctx)

  return async () => {
    await disposeSkills()
    for (const dispose of disposers.reverse()) dispose()
  }
}
