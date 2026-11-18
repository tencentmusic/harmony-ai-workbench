import { register } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
register(pathToFileURL(path.join(scriptDirectory, 'ts-resolve-hook.mjs')).href, import.meta.url)
