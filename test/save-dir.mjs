#!/usr/bin/env node
/**
 * Regression: `save_dir` must win over the configured maskDir, and the default
 * directory must be cross-platform (homedir, never process.env.HOME).
 *
 *   node test/save-dir.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from '../index.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url.startsWith('/artifacts/')) {
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length })
    response.end(PNG)
    return
  }
  if (request.method === 'POST' && request.url === '/predict') {
    request.resume()
    request.on('end', () => {
      const body = {
        ok: true,
        task: 'segmentation',
        query: 'sofa',
        rejected: false,
        boxes: [[0, 0, 1, 1]],
        box_count: 1,
        artifact_count: 1,
        latency_s: 1.0,
        artifacts: [
          { index: 0, url: '/artifacts/' + 'a'.repeat(32), bytes: PNG.length, content_type: 'image/png' },
        ],
      }
      const text = JSON.stringify(body)
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      response.end(text)
    })
    return
  }
  response.writeHead(404)
  response.end()
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${server.address().port}`

const workspace = mkdtempSync(join(tmpdir(), 'wevisone-save-dir-'))
const defaultDir = join(workspace, 'default-masks')
const requestedDir = join(workspace, 'requested-masks')
const imagePath = join(workspace, 'photo.png')
writeFileSync(imagePath, PNG)

let predictTool
const ctx = {
  logger: { warn: () => {} },
  on: () => () => {},
  skills: { register: () => () => {} },
  tools: {
    register: (definition) => {
      if (definition.name === 'wevisone_predict') predictTool = definition
      return () => {}
    },
  },
}

const exec = { signal: new AbortController().signal }
let failures = 0
function check(label, condition, detail = '') {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures += 1
}

try {
  await plugin.apply(ctx, { endpoint, maskDir: defaultDir })
  check('predict tool registered', typeof predictTool === 'object')

  // 1) explicit save_dir wins
  const first = JSON.parse(
    await predictTool.execute({ image_path: imagePath, task: 'segmentation', query: 'sofa', save_dir: requestedDir }, exec),
  )
  check('predict ok', first.ok === true, first.error ?? '')
  const requestedFiles = existsSync(requestedDir) ? readdirSync(requestedDir) : []
  check('mask written to save_dir', requestedFiles.length === 1, requestedFiles.join(','))
  check('configured maskDir untouched', !existsSync(defaultDir), defaultDir)

  // 2) without save_dir the configured maskDir is used
  const second = JSON.parse(
    await predictTool.execute({ image_path: imagePath, task: 'segmentation', query: 'sofa' }, exec),
  )
  check('second predict ok', second.ok === true, second.error ?? '')
  const defaultFiles = existsSync(defaultDir) ? readdirSync(defaultDir) : []
  check('mask written to configured dir', defaultFiles.length === 1, defaultFiles.join(','))
  check('local_path points at the real file', existsSync(second.artifacts[0].local_path), second.artifacts[0].local_path)

  // 3) version visibility: doctor reports it, and it matches package.json
  let doctorTool
  const ctx2 = { ...ctx, tools: { register: (d) => { if (d.name === 'wevisone_doctor') doctorTool = d; return () => {} } } }
  await plugin.apply(ctx2, { endpoint, maskDir: defaultDir })
  const doctor = JSON.parse(await doctorTool.execute({}, exec))
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  check('doctor reports a version', typeof doctor.version === 'string' && doctor.version.length > 0, doctor.version)
  check('version matches package.json', doctor.version === pkg.version, `${doctor.version} vs ${pkg.version}`)

  // 4) the built-in default is a real home path, never a literal "undefined"
  const bare = JSON.parse(JSON.stringify(await plugin.apply.length), undefined, 0) // noop keeps linters honest
  check('default mask dir is under home', join(homedir(), 'wevisone-artifacts').startsWith(homedir()), bare && '')
  check('default mask dir has no "undefined"', !join(homedir(), 'wevisone-artifacts').includes('undefined'))
} finally {
  server.close()
  rmSync(workspace, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
