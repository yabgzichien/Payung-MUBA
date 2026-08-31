import { describe, it, expect } from 'vitest';
import { TOOLS, openAiToolSchemas, toolByName } from '../src/tools.js';

describe('tool registry contract', () => {
  it('gives every tool a unique name', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('declares a JSON Schema object for every tool', () => {
    for (const t of TOOLS) {
      expect(t.parameters).toBeTypeOf('object');
      expect((t.parameters as any).type).toBe('object');
    }
  });

  it('marks exactly the fund-touching tools as not read-only', () => {
    const writers = TOOLS.filter((t) => !t.readOnly).map((t) => t.name).sort();
    expect(writers).toEqual(['propose_execution', 'simulate_fill']);
  });

  it('exposes no tool that executes a fill', () => {
    expect(TOOLS.some((t) => /^execute/.test(t.name))).toBe(false);
  });

  it('emits OpenAI-shaped schemas for every tool', () => {
    const schemas = openAiToolSchemas();
    expect(schemas).toHaveLength(TOOLS.length);
    expect(schemas[0]).toHaveProperty('type', 'function');
    expect(schemas[0].function).toHaveProperty('name');
    expect(schemas[0].function).toHaveProperty('parameters');
  });

  it('resolves tools by name and returns undefined for unknown ones', () => {
    expect(toolByName('get_spot')?.name).toBe('get_spot');
    expect(toolByName('drop_tables')).toBeUndefined();
  });
});
