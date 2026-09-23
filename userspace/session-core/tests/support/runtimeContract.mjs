import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

const schema = JSON.parse(readFileSync(new URL('../../../../contracts/agent-runtime/schema.json', import.meta.url), 'utf8'));
// The public schema uses valid conditional schemas without repeating their parent type.
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(schema);
const validators = new Map();

export function assertRuntimeContract(definition, value) {
  let validate = validators.get(definition);
  if (!validate) {
    validate = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
    assert.ok(validate, `Unknown public contract: ${definition}`);
    validators.set(definition, validate);
  }
  assert.ok(validate(value), `${definition} ${value.type ?? ''}: ${ajv.errorsText(validate.errors, { separator: '\n' })}\n${JSON.stringify(validate.errors?.map(error => error.params))}`);
}
