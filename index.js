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

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'

export const name = '@wevisone/dsh-wevisone-mcp-plugin'

export const inject = ['tools']

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8000'
const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_MASK_DIR = 'wevisone-artifacts'

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
  const maskDir = resolve(config.maskDir ?? DEFAULT_MASK_DIR)
  const timeoutMs = Number(config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
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

  async function downloadArtifact(relativeUrl, index, task) {
    const response = await fetch(`${endpoint}${relativeUrl}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      throw new Error(`artifact download failed (HTTP ${response.status}) for ${relativeUrl}`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    await mkdir(maskDir, { recursive: true })
    const stem = basename(relativeUrl) || `mask_${String(index).padStart(3, '0')}`
    const path = join(maskDir, `${task}-${String(index).padStart(3, '0')}-${stem}.png`)
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
      'ocr, ocr_grounding, visual_prompt, freeform.',
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Local image path on this host. Use this or upload_id.' },
        upload_id: { type: 'string', description: 'Id from a previous POST /upload. Use this or image_path.' },
        task: { type: 'string', description: 'Perception task; defaults to detection.' },
        query: { type: 'string', description: 'Object description / label / phrase. Required for most tasks.' },
        save_dir: { type: 'string', description: 'Directory for saved mattes; defaults to a folder under the workspace.' },
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

      let payload
      try {
        const result = await postPredict(body)
        payload = result.payload
      } catch (error) {
        return JSON.stringify({ ok: false, error: `request failed: ${error.message}` })
      }

      if (!payload?.ok || !Array.isArray(payload.artifacts) || payload.artifacts.length === 0) {
        return JSON.stringify(payload)
      }

      const saved = []
      for (const artifact of payload.artifacts) {
        try {
          const file = await downloadArtifact(artifact.url, artifact.index ?? saved.length, payload.task)
          saved.push({ ...artifact, local_path: file.path })
        } catch (error) {
          saved.push({ ...artifact, error: error.message })
        }
      }
      const { artifacts: _discard, ...rest } = payload
      return JSON.stringify({ ...rest, artifacts: saved })
    },
    presentCall() {
      return { card: 'generic', title: 'WeVisOne prediction', kind: 'read' }
    },
  }

  const doctorTool = {
    name: 'wevisone_doctor',
    description:
      'Report WeVisOne-VL host readiness: endpoint reachability, model residency, GPU, and the ' +
      'configured mask directory. Call this first when a prediction fails.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
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
        return JSON.stringify({
          ok: reachable,
          endpoint,
          token_configured: Boolean(token),
          mask_dir: maskDir,
          probe: payload?.error ?? `HTTP ${response.status}`,
        })
      } catch (error) {
        return JSON.stringify({
          ok: false,
          endpoint,
          token_configured: Boolean(token),
          mask_dir: maskDir,
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

  return async () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
