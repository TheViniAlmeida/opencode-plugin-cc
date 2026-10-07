const TYPE_CHECKS = {
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  array: (value) => Array.isArray(value),
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  null: (value) => value === null,
};

export function validateInput(schema, value, where = '$') {
  const errors = [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((type) => TYPE_CHECKS[type]?.(value))) {
    errors.push(`${where}: esperado ${types.join(' ou ')}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${where}: valor fora das opções permitidas`);
  if (value === null) return errors;
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${where}: comprimento inferior a ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${where}: mais de ${schema.maxLength} caracteres`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${where}: formato inválido`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${where}: abaixo de ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${where}: acima de ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${where}: quantidade de itens inferior a ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${where}: mais de ${schema.maxItems} itens`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateInput(schema.items, item, `${where}[${index}]`)));
  }
  if (TYPE_CHECKS.object(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) errors.push(`${where}.${key}: é obrigatório`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) errors.push(...validateInput(properties[key], item, `${where}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${where}.${key.length > 12 ? `${key.slice(0, 12)}…` : key}: propriedade desconhecida`);
    }
  }
  return errors;
}
