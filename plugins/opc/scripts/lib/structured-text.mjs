import { validateInput } from './mcp-schema.mjs';

export function jsonInstruction(schema) {
  return `Reply with only one JSON object, no prose and no code fence, that validates against this JSON Schema:\n${JSON.stringify(schema)}`;
}

export function schemaValidator(schema) {
  return (value) => validateInput(schema, value)[0] ?? null;
}
