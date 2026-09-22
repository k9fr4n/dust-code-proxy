import { z } from 'zod'

// Mapping of Claude Code's Anthropic `tools[]` entries onto the official MCP SDK's
// `McpServer.registerTool`, which expects a Zod schema for `inputSchema`. This file
// covers the JSON-Schema subset Claude Code emits for its built-in tools and falls
// back to a loose record for anything exotic.

export interface AnthropicTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  const s = (schema ?? {}) as Record<string, unknown>
  const type = typeof s.type === 'string' ? s.type : undefined

  if (
    Array.isArray(s.enum) &&
    s.enum.length > 0 &&
    s.enum.every((v) => typeof v === 'string')
  ) {
    return z.enum(s.enum as [string, ...string[]])
  }

  if (Array.isArray(s.anyOf) && s.anyOf.length > 0) {
    if (s.anyOf.length === 1) return jsonSchemaToZod(s.anyOf[0])
    return z.union(
      s.anyOf.map((sub) => jsonSchemaToZod(sub)) as [
        z.ZodTypeAny,
        z.ZodTypeAny,
        ...z.ZodTypeAny[],
      ],
    )
  }

  switch (type) {
    case 'string':
      return z.string()
    case 'number':
      return z.number()
    case 'integer':
      return z.number().int()
    case 'boolean':
      return z.boolean()
    case 'null':
      return z.null()
    case 'array':
      return z.array(
        s.items === undefined ? z.unknown() : jsonSchemaToZod(s.items),
      )
    case 'object':
    default: {
      const properties = s.properties
      if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
        // JSON Schema: absent `required` means *no* property is required, so every
        // field defaults to optional; a field is required only when named in
        // `required`.
        const required = Array.isArray(s.required)
          ? new Set(s.required.filter((r): r is string => typeof r === 'string'))
          : new Set<string>()
        const shape: Record<string, z.ZodTypeAny> = {}
        for (const [key, sub] of Object.entries(properties)) {
          let field = jsonSchemaToZod(sub)
          if (!required.has(key)) field = field.optional()
          shape[key] = field
        }
        return z.object(shape)
      }
      // No `properties`: an arbitrary key/value object.
      return z.record(z.string(), z.unknown())
    }
  }
}

// Claude Code sends a `tool_result` block whose `content` is a string or an array of
// content blocks (usually `{ type: "text", text }`). Collapse it into plain text for
// the MCP `CallToolResult.content` text block.
export function toolResultToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>
          if (typeof b.text === 'string') return b.text
        }
        return JSON.stringify(block)
      })
      .filter(Boolean)
      .join('\n')
  }
  return JSON.stringify(content ?? '')
}
