import { type Part, SEPARATOR } from '@tryghost/metafield-types/identity';
import { isRecordValue } from '@tryghost/metafield-types/structure';

// A value is a tree, stored as one row per leaf under the path of parts that leads to it; a value
// with no parts is one row at the root. Nothing here consults a field type: rows are rebuilt as the
// tree they describe, and reading that tree as its field's shape is the values service's job.

/** Empty rather than null, because the path is part of a value row's primary key. */
export const ROOT_PATH = '';

/** The path the value of these parts is stored under, written the way an identity writes them. */
export function pathOf(parts: readonly Part[]): string {
  return parts.join(SEPARATOR);
}

export interface ValueRow {
  path: string;
  value_text: string;
}

/**
 * A value as rows describe it: a string, or parts that are trees themselves. Every rule must parse
 * to one of these, so a type whose value isn't one fails to compile where writes are stored. An
 * undefined part is one the value doesn't name, which a write leaves unchanged.
 */
export type ValueTree = string | { readonly [part: string]: ValueTree | undefined };

export interface StoredValueRow extends ValueRow {
  member_id: string;
  namespace: string;
  key: string;
}

/**
 * Values are rebuilt into plain objects, so a segment naming something every object
 * already has would reach the prototype instead of the value — and a write through
 * `__proto__` reaches every object in the process. Paths come out of the database, so
 * this holds here rather than trusting whatever put them there.
 */
function isSafeSegment(segment: string): boolean {
  return !(segment in Object.prototype);
}

/** A row for every part a value names, at any depth, including the ones it names as empty. */
export function valueRowsOf(value: ValueTree, path: string = ROOT_PATH): ValueRow[] {
  if (typeof value === 'string') {
    return [{ path, value_text: value }];
  }

  // Undefined means the value does not name the part, which is not the same as naming
  // it empty: the first leaves what is stored alone, the second clears it.
  return Object.entries(value).flatMap(([key, part]) =>
    part === undefined
      ? []
      : valueRowsOf(part, path === ROOT_PATH ? key : `${path}${SEPARATOR}${key}`),
  );
}

/** A value split into the rows it sets and the paths it clears. */
export function valueRowsToWrite(value: ValueTree): { set: ValueRow[]; cleared: string[] } {
  const named = valueRowsOf(value);

  return {
    set: named.filter((row) => row.value_text !== ''),
    cleared: named.filter((row) => row.value_text === '').map((row) => row.path),
  };
}

/** The value a set of rows adds up to, rebuilt to whatever depth their paths describe. */
export function valueFromRows(rows: readonly ValueRow[]): unknown {
  const root = rows.find((row) => row.path === ROOT_PATH);
  if (root) {
    return root.value_text;
  }

  const value: Record<string, unknown> = {};
  for (const row of rows) {
    const segments = row.path.split(SEPARATOR);
    if (!segments.every(isSafeSegment)) {
      continue;
    }

    const last = segments[segments.length - 1];
    // A segment already holding a string is replaced rather than descended into: this
    // runs over every member of a list response, so a contradictory pair of paths
    // should cost one odd value rather than the whole response.
    let parent = value;
    for (const segment of segments.slice(0, -1)) {
      const held = parent[segment];
      const child: Record<string, unknown> = isRecordValue(held) ? held : {};
      parent[segment] = child;
      parent = child;
    }
    parent[last] = row.value_text;
  }

  return value;
}

/**
 * Every member's values, keyed by member, then namespace, then field key. `valueOf` gets one of a
 * field's rows and what its rows add up to, and returns what the field holds; a field it returns
 * undefined for is left out, and so is a namespace or member left with nothing.
 */
export function valuesFromRows<Row extends StoredValueRow>(
  rows: readonly Row[],
  valueOf: (row: Row, value: unknown) => unknown,
): Map<string, Record<string, Record<string, unknown>>> {
  type FieldRows = { row: Row; rows: ValueRow[] };
  const byMember = new Map<string, Map<string, Map<string, FieldRows>>>();

  for (const row of rows) {
    const { member_id: memberId, namespace, key, path, value_text: valueText } = row;
    const namespaces = byMember.get(memberId) ?? new Map<string, Map<string, FieldRows>>();
    const fields = namespaces.get(namespace) ?? new Map<string, FieldRows>();
    const forField: FieldRows = fields.get(key) ?? { row, rows: [] };
    forField.rows.push({ path, value_text: valueText });
    fields.set(key, forField);
    namespaces.set(namespace, fields);
    byMember.set(memberId, namespaces);
  }

  const values = new Map<string, Record<string, Record<string, unknown>>>();
  for (const [memberId, namespaces] of byMember) {
    const held: Record<string, Record<string, unknown>> = {};
    for (const [namespace, fields] of namespaces) {
      const inNamespace = Object.fromEntries(
        [...fields].flatMap(([key, forField]) => {
          const value = valueOf(forField.row, valueFromRows(forField.rows));
          return value === undefined ? [] : [[key, value]];
        }),
      );
      if (Object.keys(inNamespace).length > 0) {
        held[namespace] = inNamespace;
      }
    }
    if (Object.keys(held).length > 0) {
      values.set(memberId, held);
    }
  }
  return values;
}
