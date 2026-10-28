/**
 * What a field type is made of, with no opinion on what a valid value looks like.
 *
 * This is the half of the catalog a renderer needs. Drawing an address means knowing
 * it has six parts, in that order, and that the last of them holds a country code —
 * nothing about lengths, formats, or what happens when one is left blank.
 *
 * It is separate from `./index` because that half is built out of zod, and zod is
 * sixty-odd kilobytes. Ghost's server enforces the rules and can afford them; Portal
 * only draws the inputs, and it loads on every page view of every themed site. Split
 * this way a renderer imports well under a kilobyte and still gets the types.
 *
 * The two halves cannot drift, because the schemas are built from these declarations
 * rather than beside them: adding a part here without a rule in `./index` fails to
 * compile.
 */

/** The source for the union type, the zod enum and the `FIELD_TYPES` keys alike. */
export const FIELD_TYPE_IDS = ['short_text', 'long_text', 'address'] as const;
export type FieldType = (typeof FIELD_TYPE_IDS)[number];

/**
 * How a type's value is laid out: a scalar is one string, and a record is a string for each named
 * part. Everything that stores, exports, edits or compares a value asks the type for its shape
 * through `matchShape` rather than inspecting the value, so a new shape fails to compile at each of
 * them.
 */
export const FIELD_SHAPES = ['scalar', 'record'] as const;
export type FieldShape = (typeof FIELD_SHAPES)[number];

/**
 * What kind of thing a scalar's value is, as anything comparing values needs to know.
 *
 * Coarser than the type: `short_text` and `long_text` are both text, and differ only in
 * how much of it. This is the level at which a value can be ordered, matched or grouped,
 * so it is what a filter, a sort or an export reads to decide how to treat a value —
 * without either of them enumerating the types themselves. A record has no kind of its
 * own: it is compared part by part, each by what its part type holds.
 *
 * Deliberately not presentation: it says a value is a date, not that its operator is
 * called "is before". Naming the operators stays with whoever renders them.
 */
export const FIELD_KINDS = ['text', 'date', 'number'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/**
 * The types a composite's parts can declare. A country code and a postal code both
 * store short text, but they are different things — the part's type is what a control
 * or a filter dispatches on, the way a field's own type is for a scalar.
 */
export const PART_TYPE_IDS = ['short_text', 'postal_code', 'country_code'] as const;
export type PartType = (typeof PART_TYPE_IDS)[number];

export interface ScalarStructure {
  readonly shape: 'scalar';
  readonly kind: FieldKind;
}

/**
 * Parts are listed in the order they are shown, and that order is relied on wherever parts are laid
 * out.
 */
export interface RecordStructure {
  readonly shape: 'record';
  readonly parts: Readonly<Record<string, PartType>>;
}

export type FieldStructure = ScalarStructure | RecordStructure;

/**
 * What each type is made of: its shape, and for a scalar its kind or for a record its parts.
 * This and a type's rule in `./index` are all that adding a type of an existing shape takes
 * in this package.
 *
 * An address is a delivery address, modeled on Stripe's Address object. Who the parcel
 * is addressed to is not here: a parcel needs a name as well as an address, but that is
 * a fact about posting parcels rather than about either type, and the name is often not
 * the account name — gift subscriptions, workplace deliveries, c/o. A site that needs
 * one keeps it in a field of its own, which is also how Stripe hands it back.
 */
export const FIELD_STRUCTURES = {
  short_text: { shape: 'scalar', kind: 'text' },
  long_text: { shape: 'scalar', kind: 'text' },
  address: {
    shape: 'record',
    parts: {
      line1: 'short_text',
      line2: 'short_text',
      city: 'short_text',
      state: 'short_text',
      postal_code: 'postal_code',
      country: 'country_code',
    },
  },
} as const satisfies Record<FieldType, FieldStructure>;

export type ShapeOf<T extends FieldType> = (typeof FIELD_STRUCTURES)[T]['shape'];

export type FieldTypeOfShape<S extends FieldShape> = {
  [T in FieldType]: ShapeOf<T> extends S ? T : never;
}[FieldType];

/**
 * The kind a scalar type declares, or never for another shape. Distributes over `T`, so a union of
 * types gives the kinds of its scalars.
 */
export type KindOf<T extends FieldType> = T extends FieldType
  ? (typeof FIELD_STRUCTURES)[T] extends { shape: 'scalar'; kind: infer K extends FieldKind }
    ? K
    : never
  : never;

export type FieldTypeOfKind<K extends FieldKind> = {
  [T in FieldType]: (typeof FIELD_STRUCTURES)[T] extends { shape: 'scalar'; kind: K } ? T : never;
}[FieldType];

export type ShapeHandlers<R> = {
  [S in FieldShape]: (structure: Extract<FieldStructure, { shape: S }>) => R;
};

/**
 * Whether a value names a type this build knows. A site newer than an integration can send a type
 * the integration doesn't know, so check a type from the wire with this first. `constructor` and
 * other names every object has are not types.
 */
export function isFieldType(value: unknown): value is FieldType {
  return FIELD_TYPE_IDS.some((id) => id === value);
}

/**
 * The type's structure, or undefined for a type this build doesn't know, which a plain JavaScript
 * caller can still pass.
 */
function structureOf(type: FieldType): FieldStructure | undefined {
  return isFieldType(type) ? FIELD_STRUCTURES[type] : undefined;
}

/**
 * Calls the handler for the shape `type` declares. Throws, naming the type, for one this build
 * doesn't know; check with `isFieldType` first.
 */
export function matchShape<R>(type: FieldType, handlers: ShapeHandlers<R>): R {
  const structure = structureOf(type);
  if (!structure) {
    // A native error, because this module imports nothing, @tryghost/errors included.
    // oxlint-disable-next-line ghost/ghost-custom/no-native-error
    throw new Error(`Unknown field type: ${type}`);
  }
  switch (structure.shape) {
    case 'scalar':
      return handlers.scalar(structure);
    case 'record':
      return handlers.record(structure);
  }
}

/**
 * Whether a value is laid out as a record: an object of parts, which a list is not. What a record
 * must hold is its type's rule to decide.
 */
export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The parts a record type declares, or never for a type whose value is a single thing.
 *
 * Distributed over `T`, so a caller holding a type it only knows as `FieldType` gets
 * every part any type declares rather than the empty intersection of all of them.
 */
export type PartsOf<T extends FieldType> = T extends FieldType
  ? (typeof FIELD_STRUCTURES)[T] extends { parts: infer P }
    ? Extract<keyof P, string>
    : never
  : never;

function declaredParts(type: FieldType): Readonly<Record<string, PartType>> | null {
  const structure = structureOf(type);
  return structure?.shape === 'record' ? structure.parts : null;
}

/**
 * A record type's parts in declaration order, or null for a type with none. Parts are plain strings
 * here; `FIELD_STRUCTURES[type].parts` gives one type's parts with typed keys.
 */
export function partsOf(type: FieldType): string[] | null {
  const parts = declaredParts(type);
  return parts ? Object.keys(parts) : null;
}

/** Each part's declared type, keyed by part; null for a type with none, and for one this build has never heard of. */
export function partTypesOf(type: FieldType): Readonly<Record<string, PartType>> | null {
  const parts = declaredParts(type);
  return parts ? { ...parts } : null;
}
