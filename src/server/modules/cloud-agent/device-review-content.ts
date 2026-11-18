const nodeFields = new Set(['type', 'id', 'key', 'text', 'originalText', 'description', 'hint', 'bounds', 'origBounds', 'hierarchy', 'bundleName', 'abilityName', 'pagePath', 'visible', 'enabled', 'selected', 'checked', 'checkable', 'clickable', 'longClickable', 'scrollable', 'focused', 'opacity', 'zIndex', 'hitTestBehavior'])

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function node(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => nodeFields.has(key) && item !== ''))
}
export function nodeTable(nodes: Record<string, unknown>[]) {
  const rows = nodes.map(node), defaults: Record<string, unknown> = {}
  for (const key of nodeFields) {
    const counts = new Map<string, number>()
    for (const row of rows) if (row[key] !== undefined) { const value = JSON.stringify(row[key]); counts.set(value, (counts.get(value) || 0) + 1) }
    const common = [...counts].sort((a, b) => b[1] - a[1])[0]
    if (common && common[1] === rows.length) defaults[key] = JSON.parse(common[0])
  }
  return { defaults, rows: rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !Object.hasOwn(defaults, key)))) }
}

// A semantic view is not the raw file: geometry, identity and interactive state stay visible.
// Commands, assertion values, provenance and motion metrics are never summarized.
export function deviceReviewContent(text: string): { text: string; view: string } {
  function project(value: unknown, key = ''): unknown {
    if (Array.isArray(value)) return key === 'nodes' ? value.map(item => object(item) ? node(item) : item) : value.map(item => project(item))
    if (!object(value)) return value
    // Native observations duplicate the complete layout. Reference the separately required
    // hash-bound layout instead; retain extracted assertion values and action provenance.
    if (object(value.provenance) && object(value.provenance.layout) && object(value.data) && Array.isArray(value.data.nodes)) {
      const { nodes: _nodes, ...data } = value.data
      return project({ ...value, data: { ...data, nodes_reference: value.provenance.layout } })
    }
    if (Array.isArray(value.nodes) && object(value.layout)) {
      const { nodes: _nodes, ...rest } = value
      return project({ ...rest, nodes_reference: value.layout })
    }
    if (object(value.attributes) && typeof value.attributes.type === 'string') {
      const nodes: Record<string, unknown>[] = []
      function flatten(current: Record<string, unknown>) {
        if (object(current.attributes)) nodes.push(current.attributes)
        if (Array.isArray(current.children)) for (const child of current.children) if (object(child)) flatten(child)
      }
      flatten(value)
      return { node_table: nodeTable(nodes) }
    }
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, name === 'attributes' && object(item) ? node(item) : project(item, name)]))
  }
  try { return { text: JSON.stringify(project(JSON.parse(text))), view: 'semantic-ui-v1; node_table.defaults apply to every row; nodes_reference points to a separately required hash-bound layout; raw=true exposes unchanged original styling and other attributes' } }
  catch { return { text, view: 'raw' } }
}

export class DeviceReviewProgress {
  private previous = ''
  private stalled = 0
  continue(pending: unknown[]) {
    const signature = JSON.stringify(pending)
    this.stalled = signature === this.previous ? this.stalled + 1 : 0
    this.previous = signature
    return this.stalled < 2
  }
}
