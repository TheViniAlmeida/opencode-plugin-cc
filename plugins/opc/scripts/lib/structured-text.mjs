import { validateInput } from './mcp-schema.mjs';

export function jsonInstruction(schema) {
  return `Reply with only one JSON object, no prose and no code fence, that validates against this JSON Schema:\n${JSON.stringify(schema)}`;
}

export function schemaValidator(schema) {
  return (value) => {
    const error = validateInput(schema, value)[0] ?? null;
    if (error === null) return null;
    // Keep one schema-shaped wrapper intact so the conclave can recover its values.
    if (value && typeof value === 'object' && !Array.isArray(value)
      && typeof value.title === 'string' && value.properties && typeof value.properties === 'object'
      && !Array.isArray(value.properties) && Object.keys(value).every((key) => key === 'title' || key === 'properties')
      && validateInput(schema, value.properties).length === 0) return null;
    return error;
  };
}
