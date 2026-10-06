// Text-only charts, so the pane draws the same in the terminal and in the
// Desktop app. A chart is a list of rows; a row is a list of segments
// `{ text, color?, dim?, bold? }` that the view turns into Text elements.

const EIGHTHS = ['', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/** Joins neighbouring cells of the same style into one segment. */
function pack(cells) {
  const row = []
  for (const cell of cells) {
    const last = row.at(-1)
    if (last && last.color === cell.color && last.dim === cell.dim && last.bold === cell.bold) last.text += cell.text
    else row.push({ ...cell })
  }
  return row
}

const pad = (text, width, align = 'left') => {
  const t = text.length > width ? text.slice(0, width) : text
  return align === 'right' ? t.padStart(width) : align === 'center' ? t.padStart(Math.floor((width + t.length) / 2)).padEnd(width) : t.padEnd(width)
}

/**
 * Merges consecutive columns so they fit in `slots`, summing their parts.
 * Returns the merged columns and, for each, the range of source indexes.
 */
export function fitColumns(columns, slots) {
  const size = Math.max(1, Math.ceil(columns.length / Math.max(1, slots)))
  const merged = []
  for (let start = 0; start < columns.length; start += size) {
    const group = columns.slice(start, start + size)
    const parts = new Map()
    for (const column of group) {
      for (const part of column.parts) {
        const prev = parts.get(part.key)
        parts.set(part.key, { ...part, value: (prev?.value ?? 0) + part.value })
      }
    }
    merged.push({
      total: group.reduce((sum, c) => sum + c.total, 0),
      parts: [...parts.values()],
      label: group[0].label,
      lastLabel: group.at(-1).label,
      first: start,
      last: start + group.length - 1,
    })
  }
  return merged
}

/**
 * A stacked bar chart with eighth-block tops, a y axis, a cursor marker and
 * x labels, in the style of Codex's /usage.
 *
 * `columns`: `{ total, label, parts: [{ key, value, color }] }`, oldest first.
 * `cursor`: index into `columns` to mark, or null.
 */
export function barChart({ columns, width, height, cursor = null, format = String, showValues = true }) {
  const max = Math.max(...columns.map((c) => c.total), 0)
  const axisLabels = [format(max), format(max / 2), format(0)]
  const axisW = Math.max(...axisLabels.map((l) => l.length)) + 1
  const plotW = Math.max(4, width - axisW - 1)
  const merged = fitColumns(columns, plotW)
  const slot = Math.max(1, Math.floor(plotW / merged.length))
  const barW = slot >= 3 ? slot - 1 : slot
  const heights = merged.map((c) => (max > 0 ? Math.round((c.total / max) * height * 8) : 0))
  const valueRow = merged.map((c, i) => (showValues && barW >= 5 && c.total > 0 ? Math.max(-1, height - 2 - Math.floor(heights[i] / 8)) : -1))

  const rows = []
  for (let r = 0; r < height; r++) {
    const cells = []
    const axis = r === 0 ? axisLabels[0] : r === Math.floor((height - 1) / 2) ? axisLabels[1] : r === height - 1 ? axisLabels[2] : ''
    cells.push({ text: pad(axis, axisW - 1, 'right') + ' ', dim: true })
    cells.push({ text: r === height - 1 ? '┼' : '┤', dim: true })
    const bottom = (height - 1 - r) * 8
    merged.forEach((column, i) => {
      if (valueRow[i] === r) {
        cells.push({ text: pad(format(column.total), barW, 'center'), dim: true })
      } else {
        const h = heights[i]
        if (h <= bottom) {
          cells.push({ text: ' '.repeat(barW) })
        } else {
          const fill = Math.min(8, h - bottom)
          // The part that covers the middle of this cell's filled share colours it.
          const probe = ((bottom + fill / 2) / h) * column.total
          let acc = 0
          let color = '#888888'
          for (const part of column.parts) {
            acc += part.value
            color = part.color
            if (acc >= probe) break
          }
          cells.push({ text: EIGHTHS[fill].repeat(barW), color })
        }
      }
      if (slot > barW) cells.push({ text: ' '.repeat(slot - barW) })
    })
    rows.push(pack(cells))
  }

  // Cursor marker and x labels.
  const marker = []
  const selected = cursor === null ? -1 : merged.findIndex((c) => cursor >= c.first && cursor <= c.last)
  marker.push({ text: ' '.repeat(axisW) })
  merged.forEach((_, i) => {
    marker.push(i === selected ? { text: pad('▲', barW, 'center'), bold: true } : { text: ' '.repeat(barW) })
    if (slot > barW) marker.push({ text: ' '.repeat(slot - barW) })
  })
  rows.push(pack(marker))

  const span = merged.length * slot
  const first = merged[0]?.label ?? ''
  const last = merged.at(-1)?.lastLabel ?? ''
  const mid = merged[Math.floor(merged.length / 2)]?.label ?? ''
  let labels = pad(first, span)
  if (span >= first.length + mid.length + last.length + 4 && merged.length > 2) {
    const midAt = Math.floor(merged.length / 2) * slot
    labels = labels.slice(0, midAt) + mid + labels.slice(midAt + mid.length)
  }
  if (merged.length > 1) labels = labels.slice(0, Math.max(0, span - last.length)) + last
  rows.push([{ text: ' '.repeat(axisW) + labels, dim: true }])
  return { rows, merged }
}

/** A one-line bar split in proportion to `parts` (`{ value, color }`), each nonzero part at least one cell wide. */
export function splitBar(parts, width) {
  const total = parts.reduce((sum, p) => sum + Math.max(0, p.value), 0)
  if (!(total > 0)) return [{ text: '░'.repeat(width), dim: true }]
  const live = parts.filter((p) => p.value > 0)
  const widths = live.map((p) => Math.max(1, Math.round((p.value / total) * width)))
  let over = widths.reduce((a, b) => a + b, 0) - width
  while (over > 0) {
    const i = widths.indexOf(Math.max(...widths))
    widths[i] -= 1
    over -= 1
  }
  if (over < 0) widths[widths.indexOf(Math.max(...widths))] -= over
  return live.map((p, i) => ({ text: '█'.repeat(widths[i]), color: p.color }))
}

/** A meter of `fraction` (0..1) filled in `color`, the rest shaded. */
export function meter(fraction, width, color) {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width)
  return [
    { text: '█'.repeat(filled), color },
    { text: '░'.repeat(width - filled), dim: true },
  ].filter((s) => s.text.length > 0)
}
