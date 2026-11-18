import { createHash } from 'node:crypto'

export function harnessRequestName(command: string, operationId: string, serialized: string) {
  return createHash('sha256').update(JSON.stringify([command, operationId, serialized])).digest('hex') + '.json'
}
