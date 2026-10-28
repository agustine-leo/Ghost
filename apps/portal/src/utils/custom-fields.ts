import type { MemberAccess, MetafieldDefinition } from '@tryghost/metafield-types';
import { FIELD_TYPE_IDS, isRecordValue, matchShape } from '@tryghost/metafield-types/structure';
import { isPreviewMode } from './check-mode';
import { hasCustomFieldsEnabled } from './helpers';

/**
 * A field the publisher has opened to members: the parts of Ghost's definition that the
 * members API client checks before handing one over, since Portal also runs beside older
 * Ghost sites. The key and type are any string here: the client checks only that they are
 * text, and a newer site may offer a type this build has never heard of.
 */
export type MemberCustomField = Pick<MetafieldDefinition, 'name' | 'access'> & {
  key: string;
  type: string;
};

/** The levels at which a member is shown a field. Stated here rather than imported, which would load zod. */
const SHOWN_TO_MEMBERS = ['read', 'write'] as const satisfies readonly MemberAccess[];

const isShownToMembers = (level: unknown): level is (typeof SHOWN_TO_MEMBERS)[number] =>
  SHOWN_TO_MEMBERS.some((shown) => shown === level);

/**
 * A field as the members API describes it, or nothing for one that can't be drawn from.
 * Every property a field is drawn from is checked, not just enough to recognise one: a name
 * that is not text is rendered as a child and takes the page down with it. The field is
 * built property by property, so one added to `MemberCustomField` has to be read here too.
 */
function readMemberCustomField(raw: unknown): MemberCustomField | null {
  if (!isRecordValue(raw)) {
    return null;
  }
  const { key, name, type, access } = raw;
  const { member } = isRecordValue(access) ? access : { member: undefined };
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    typeof name !== 'string' ||
    typeof type !== 'string' ||
    !isShownToMembers(member)
  ) {
    return null;
  }
  return { key, name, type, access: { member } };
}

/** The fields a members API response lists that Portal can draw from, in its order. */
export function readMemberCustomFields(listed: unknown[]): MemberCustomField[] {
  return listed.flatMap((raw) => {
    const field = readMemberCustomField(raw);
    return field ? [field] : [];
  });
}

interface AskFor {
  api: { member: { customFields: () => Promise<MemberCustomField[]> } };
  site: { labs?: { membersCustomFields?: boolean } } | null;
  member: unknown;
}

/**
 * The custom fields the publisher has opened to members, asked for once, beside the
 * member they belong to.
 *
 * Always a list. Nothing to ask for — the feature off, nobody signed in, a preview — and
 * a site that cannot answer come to the same thing here: no fields to draw. Every way in
 * is a page load, so there is no later moment at which the answer would differ.
 */
export async function fetchMemberCustomFields({
  api,
  site,
  member,
}: AskFor): Promise<MemberCustomField[]> {
  if (!hasCustomFieldsEnabled({ site }) || !member || isPreviewMode()) {
    return [];
  }

  try {
    return await api.member.customFields();
  } catch (err) {
    return [];
  }
}

/**
 * A field this build can draw. The site may offer a type added after this bundle
 * shipped, and there is nothing sensible to render for one, so it is left out rather
 * than guessed at.
 */
const DRAWABLE_TYPES = new Set<string>(FIELD_TYPE_IDS);

export type DrawableCustomField = Pick<MetafieldDefinition, 'name' | 'type' | 'access'> & {
  key: string;
};

const isDrawable = (field: MemberCustomField): field is DrawableCustomField =>
  DRAWABLE_TYPES.has(field.type);

export function drawableCustomFields(
  fields: MemberCustomField[] | null | undefined,
): DrawableCustomField[] {
  if (!Array.isArray(fields)) {
    return [];
  }
  return fields.filter(isDrawable);
}

/** What a composite holds: one string per part, and not every part need be filled in. */
export type CompositeValue = Record<string, string | undefined>;

/** A value as the member holds it: one string, or one per part of a composite. */
export type CustomFieldValue = string | CompositeValue | undefined;

/**
 * Narrowed rather than asserted. Which shape a value has follows from its field's type,
 * which the compiler cannot see, so the value itself is asked instead.
 */
export const compositeValue = (value: CustomFieldValue): CompositeValue | undefined =>
  isRecordValue(value) ? value : undefined;

export const scalarValue = (value: CustomFieldValue): string =>
  typeof value === 'string' ? value : '';

/** A part is changed when what the member has differs from what the site holds. */
const changedParts = (
  parts: readonly string[],
  current: CompositeValue | undefined,
  original: CompositeValue | undefined,
): string[] => parts.filter((part) => (current?.[part] ?? '') !== (original?.[part] ?? ''));

/**
 * What the member changed, in the shape the members API takes: only fields they may
 * write, since naming one they may only read refuses the whole save, and only the parts
 * of a composite they touched, since each part records who last wrote it.
 */
export function changedCustomFields(
  fields: DrawableCustomField[],
  values: Record<string, CustomFieldValue>,
  original: Record<string, CustomFieldValue>,
): { custom: Record<string, unknown> } | undefined {
  const custom: Record<string, unknown> = {};

  for (const field of fields.filter((f) => f.access.member === 'write')) {
    const value = values[field.key];
    const was = original[field.key];
    const change = matchShape<unknown>(field.type, {
      scalar: () => (scalarValue(value) !== scalarValue(was) ? value : undefined),
      // Only the parts that changed, emptied ones included. Naming the whole field would clear it,
      // and this build only knows the parts it draws.
      record: ({ parts }) => {
        const held = compositeValue(value);
        const changed = changedParts(Object.keys(parts), held, compositeValue(was));
        return changed.length === 0
          ? undefined
          : Object.fromEntries(changed.map((part) => [part, held?.[part] ?? '']));
      },
    });
    if (change !== undefined) {
      custom[field.key] = change;
    }
  }

  return Object.keys(custom).length > 0 ? { custom } : undefined;
}

export function withChange(
  field: DrawableCustomField,
  held: CustomFieldValue,
  part: string | null,
  value: string,
): CustomFieldValue {
  return matchShape<CustomFieldValue>(field.type, {
    scalar: () => value,
    record: () => (part === null ? held : { ...compositeValue(held), [part]: value }),
  });
}

/**
 * The input a refusal of a field's value belongs on, named the way the form names it, or
 * nothing when no one input holds what was refused.
 *
 * The whole of a record has no one input: a refusal of it (the field archived, or closed to
 * members, while the page was open) belongs to the field rather than to a box, and nothing
 * the member retypes would fix it. Neither does a part the field does not declare, or a
 * field this build does not draw: marking a box that is not there would say nothing while
 * still counting as something said, leaving the save to fail in silence.
 */
export function refusedInput(field: MemberCustomField, part: string): string | null {
  if (!isDrawable(field)) {
    return null;
  }
  return matchShape<string | null>(field.type, {
    scalar: () => (part === '' ? `custom:${field.key}` : null),
    record: ({ parts }) =>
      part !== '' && Object.keys(parts).includes(part) ? `custom:${field.key}:${part}` : null,
  });
}
