import {
  INTEGRATION_TASK_STATUSES,
  IntegrationApiContractError,
} from './integration-api'
import type { IntegrationTaskStatus } from './integration-domain'
import type { IntegrationProjectConfig } from './integration-projects'
import { IntegrationStoreError } from './integration-store'

export const DEFAULT_INTEGRATION_JSON_BODY_LIMIT = 32 * 1024

type IntegrationHttpErrorCode =
  | 'BODY_TOO_LARGE'
  | 'INVALID_JSON'
  | 'INVALID_QUERY'
  | 'INVALID_RESOURCE_ID'
  | 'PROJECT_NOT_FOUND'
  | 'TASK_NOT_FOUND'
  | 'CONFLICT_CHECK_NOT_ALLOWED'
  | 'CONFLICT_CHECK_BUSY'
  | 'MERGE_CONFLICT_CHECK_FAILED'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'EXPECTED_RUN_ID_REQUIRED'

export class IntegrationHttpError extends Error {
  readonly code: IntegrationHttpErrorCode
  readonly httpStatus: number
  readonly field?: string

  constructor(
    code: IntegrationHttpErrorCode,
    httpStatus: number,
    field?: string,
  ) {
    super(code)
    this.name = 'IntegrationHttpError'
    this.code = code
    this.httpStatus = httpStatus
    this.field = field
  }
}

function validateContentLength(request: Request, maxBytes: number): void {
  const raw = request.headers.get('content-length')
  if (raw === null) return
  if (!/^\d+$/.test(raw)) {
    throw new IntegrationHttpError('INVALID_JSON', 400, 'body')
  }
  const contentLength = Number(raw)
  if (!Number.isSafeInteger(contentLength) || contentLength > maxBytes) {
    throw new IntegrationHttpError('BODY_TOO_LARGE', 413, 'body')
  }
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array()

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel()
        throw new IntegrationHttpError('BODY_TOO_LARGE', 413, 'body')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export async function readIntegrationJsonBody(
  request: Request,
  options: { maxBytes?: number } = {},
): Promise<unknown> {
  const maxBytes = options.maxBytes ?? DEFAULT_INTEGRATION_JSON_BODY_LIMIT
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes 必须是正整数')
  }

  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new IntegrationHttpError('UNSUPPORTED_MEDIA_TYPE', 415, 'body')
  }
  validateContentLength(request, maxBytes)

  const bytes = await readBoundedBody(request, maxBytes)
  if (bytes.byteLength === 0) {
    throw new IntegrationHttpError('INVALID_JSON', 400, 'body')
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return JSON.parse(text) as unknown
  } catch {
    throw new IntegrationHttpError('INVALID_JSON', 400, 'body')
  }
}

export function parseIntegrationTaskFilters(
  url: URL,
  projects: readonly IntegrationProjectConfig[],
): {
  projectId?: string
  status?: IntegrationTaskStatus
} {
  const allowedKeys = new Set(['projectId', 'status'])
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new IntegrationHttpError('INVALID_QUERY', 400)
    }
  }

  const filters: {
    projectId?: string
    status?: IntegrationTaskStatus
  } = {}
  const projectId = url.searchParams.get('projectId')
  if (projectId !== null) {
    if (!projectId || !projects.some((project) => project.id === projectId)) {
      throw new IntegrationApiContractError(
        'PROJECT_NOT_FOUND',
        '未配置请求的集成项目',
        'projectId',
        404,
      )
    }
    filters.projectId = projectId
  }

  const status = url.searchParams.get('status')
  if (status !== null) {
    if (!(INTEGRATION_TASK_STATUSES as readonly string[]).includes(status)) {
      throw new IntegrationApiContractError(
        'INVALID_STATUS',
        'status 必须是合法的集成任务状态',
        'status',
      )
    }
    filters.status = status as IntegrationTaskStatus
  }
  return filters
}

export function requireIntegrationResourceId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new IntegrationHttpError('INVALID_RESOURCE_ID', 400, 'id')
  }
  return value
}

const STORE_ERROR_HTTP_STATUS: Readonly<Record<string, number>> = {
  INVALID_INPUT: 400,
  ARTIFACT_NOT_FOUND: 404,
  ARTIFACT_NOT_REVIEW: 409,
  ARTIFACT_NOT_SUCCEEDED: 409,
  INVALID_STATUS_TRANSITION: 409,
  RERUN_STAGE_NOT_ALLOWED: 409,
  REVIEW_NOTE_CAS_CONFLICT: 409,
  RUN_ACTIVE: 409,
  RUN_CAS_CONFLICT: 409,
  RUN_CLEANUP_PENDING: 409,
  RUN_NOT_FAILED: 409,
  RUN_NOT_FOUND: 404,
  STATUS_CAS_CONFLICT: 409,
  TASK_DELETE_BLOCKED: 409,
  TASK_NOT_FOUND: 404,
}

export function integrationErrorResponse(error: unknown): Response {
  let code = 'INTERNAL_ERROR'
  let status = 500
  let field: string | undefined

  if (error instanceof IntegrationApiContractError) {
    code = error.code
    status = error.httpStatus
    field = error.field
  } else if (error instanceof IntegrationHttpError) {
    code = error.code
    status = error.httpStatus
    field = error.field
  } else if (error instanceof IntegrationStoreError) {
    const mappedStatus = STORE_ERROR_HTTP_STATUS[error.code]
    if (mappedStatus !== undefined) {
      code = error.code
      status = mappedStatus
    }
  }

  return Response.json(
    field ? { error: code, field } : { error: code },
    {
      status,
      headers: {
        'cache-control': 'no-store',
      },
    },
  )
}
