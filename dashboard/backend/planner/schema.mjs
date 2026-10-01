// A small validator for the exact JSON Schema subset used by this project.
// No network dependencies, coercion, defaults-to-true, or executable input.
export function validate(value, schema, path = '$') {
  const errors = [];
  const types = [].concat(schema.type ?? []);
  const matches = t => t === 'null' ? value === null
    : t === 'array' ? Array.isArray(value)
    : t === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : t === 'integer' ? Number.isSafeInteger(value)
    : t === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : typeof value === t;
  if (types.length && !types.some(matches)) return [`${path}: invalid type`];
  if (schema.enum && !schema.enum.some(x => x === value)) errors.push(`${path}: invalid enum`);
  if ('const' in schema && value !== schema.const) errors.push(`${path}: invalid constant`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) errors.push(`${path}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: invalid pattern`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: too many items`);
    if (schema.uniqueItems && new Set(value.map(x => JSON.stringify(x))).size !== value.length) errors.push(`${path}: duplicate items`);
    value.forEach((v, i) => errors.push(...validate(v, schema.items ?? {}, `${path}[${i}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: missing`);
    for (const [key, v] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) errors.push(...validate(v, schema.properties[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unknown field`);
    }
  }
  return errors;
}

export function project(value, schema) {
  if (Array.isArray(value)) return value.map(v => project(v, schema.items ?? {}));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(schema.properties ?? {})
      .filter(([k]) => Object.hasOwn(value, k)).map(([k, s]) => [k, project(value[k], s)]));
  }
  return value;
}
