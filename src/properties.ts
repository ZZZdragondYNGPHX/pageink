/** Property data and optimistic edits; independent of Obsidian and drawing history. */
export type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };
export type JsonProperties = { [key: string]: JsonValue };
export type PropertyValue = string | number | boolean | string[];
export type PropertyType = 'text' | 'number' | 'boolean' | 'list';
export type PropertyChange = { key: string; op: 'set'; value: PropertyValue } | { key: string; op: 'delete' };
export interface PropertiesSnapshot {
  readonly path: string;
  readonly kind: 'markdown' | 'drawing' | 'pdf';
  readonly properties: Readonly<Record<string, unknown>>;
  readonly documentId?: string;
}
export const PROPERTY_TYPES: Record<PropertyType, string> = {
  text: '文本', number: '数字', boolean: '是／否', list: '文字列表',
};

/** Dangerous names may exist as inert data, but must never be edited or traversed. */
export function editableKey(key: string): boolean {
  return !!key.trim() && ![...key].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) && !['__proto__', 'constructor', 'prototype'].includes(key);
}

export function assertPropertiesRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) ||
    Reflect.ownKeys(value).some(key => typeof key !== 'string' || !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) {
    throw Error('属性必须是按名称组织的对象；原有内容未修改。');
  }
}

/** JSON-only manifest extension. Own data keys, including reserved names, are retained. */
export function validateProperties(value: unknown): asserts value is JsonProperties {
  assertPropertiesRecord(value);
  const ancestors = new Set<object>();
  const visit = (item: unknown) => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || ancestors.has(item)) throw Error('属性包含非 JSON 值或循环引用；原有内容未修改。');
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (Reflect.ownKeys(item).length !== item.length + 1 || Object.keys(item).length !== item.length || Object.keys(item).some((key, i) => key !== String(i))) throw Error('属性列表必须是完整的 JSON 数组。');
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw Error('属性列表不能包含访问器。');
        visit(descriptor.value);
      }
    } else {
      assertPropertiesRecord(item);
      for (const entry of Object.values(item)) visit(entry);
    }
    ancestors.delete(item);
  };
  visit(value);
}

export function propertyType(value: unknown): PropertyType | undefined {
  if (typeof value === 'string') return 'text';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1 && Object.keys(value).length === value.length &&
    Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i)))
      .every(descriptor => descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string')) return 'list';
  return undefined;
}

export function sameProperty(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return propertyType(a) === 'list' && propertyType(b) === 'list' &&
    (a as string[]).length === (b as string[]).length && (a as string[]).every((value, i) => value === (b as string[])[i]);
}

export function copyProperties(value: unknown): Record<string, unknown> {
  assertPropertiesRecord(value);
  const copy = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) copy[key] = structuredClone(item);
  return copy;
}

export function propertiesSnapshot(path: string, kind: PropertiesSnapshot['kind'], value: unknown, documentId?: string): PropertiesSnapshot {
  const properties = copyProperties(value);
  for (const item of Object.values(properties)) if (propertyType(item) === 'list') Object.freeze(item);
  return Object.freeze({ path, kind, properties: Object.freeze(properties), documentId });
}

export class PropertiesConflict extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`这些属性在打开后已变化：${keys.join('、')}。未覆盖当前值；请保留草稿，重新打开属性后核对。`);
    this.name = 'PropertiesConflict';
  }
}

/** Validate the entire edit before any mutation; omit edits reverted to the opening value. */
export function propertyChanges(base: Readonly<Record<string, unknown>>, changes: readonly PropertyChange[]): PropertyChange[] {
  assertPropertiesRecord(base);
  const keys = new Set<string>(), result: PropertyChange[] = [];
  for (const change of changes) {
    const { key } = change;
    if (typeof key !== 'string' || !editableKey(key)) throw Error(`属性名不可编辑：${String(key)}。请使用非空名称，避开保留名称和控制字符。`);
    if (keys.has(key)) throw Error(`属性名重复：${key}`);
    keys.add(key);
    const exists = Object.hasOwn(base, key);
    if (exists && !propertyType(base[key])) throw Error(`属性「${key}」包含复杂值，只读保留。`);
    if (change.op === 'delete') { if (exists) result.push({ key, op: 'delete' }); }
    else if (change.op === 'set' && propertyType(change.value)) {
      if (!exists || !sameProperty(base[key], change.value)) result.push({ key, op: 'set', value: structuredClone(change.value) });
    } else throw Error(`属性「${key}」的值无效，请填写文本、数字、是／否或文字列表。`);
  }
  return result;
}

/** This function is synchronous so it can run inside processFrontMatter's atomic callback. */
export function applyPropertyChanges(current: Record<string, unknown>, base: Readonly<Record<string, unknown>>, changes: readonly PropertyChange[]): void {
  assertPropertiesRecord(current);
  const edits = propertyChanges(base, changes);
  const conflicts = edits.filter(({ key }) => Object.hasOwn(current, key) !== Object.hasOwn(base, key) ||
    Object.hasOwn(base, key) && !sameProperty(current[key], base[key])).map(({ key }) => key);
  if (conflicts.length) throw new PropertiesConflict(conflicts);
  for (const change of edits) {
    if (change.op === 'delete') delete current[change.key];
    else Object.defineProperty(current, change.key, { value: structuredClone(change.value), enumerable: true, writable: true, configurable: true });
  }
}

/** Strict decimal input: empty strings, hex, NaN and infinities never silently become numbers. */
export function parsePropertyNumber(text: string): number {
  const value = text.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(Number(value))) {
    throw Error('请输入有效数字，例如 12 或 -3.5。');
  }
  return Number(value);
}

export function propertyPreview(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? String(value); }
  catch { return '包含循环引用或特殊 YAML 值；只读保留。'; }
}
