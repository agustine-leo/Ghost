# Add a field type

What adding a member custom field type to Ghost takes, and what the compiler checks along
the way. This is for contributors to the Ghost monorepo; the package README covers using
the package.

A type of a shape that already exists takes an entry in each of these places, and the
compiler fails until each is there:

1. In [`src/structure.ts`](../src/structure.ts), add the type's id to `FIELD_TYPE_IDS`
   and its entry to `FIELD_STRUCTURES`: its shape, and its kind for a scalar or its
   parts for a record.
2. In [`src/index.ts`](../src/index.ts), give it a rule in `FIELD_TYPES`. The rule has to
   parse to what its shape lays out: a string for a scalar, and a string per part for a
   record. A record's rule is `record()` for that same type, built from its parts.
3. In Admin's [`fieldTypePresentation`](../../../apps/admin-x-framework/src/api/member-custom-fields.ts),
   give it a name, an icon, a control and, for a record, a label for each part.
4. In Portal's [`DRAWN_BY`](../../../apps/portal/src/components/common/member-custom-fields.tsx),
   say which component draws it.

A text scalar can use the text input or text area both already have, so a scalar is text
only if a member types its value. A scalar of another kind has no control yet, and the
compiler won't let it borrow the text ones. A record's
parts are laid out by a control of its own in Admin and a component of its own in Portal,
and the compiler won't let a new record borrow the address's.

Then add its id to the `type` column's list in Ghost's
[`schema.js`](../../../ghost/core/server/data/schema/schema.js), which can't import this
package; a unit test fails until you do.

Storing, filtering, CSV import and export, how Admin's member editor prepares and saves
a value, value display and Portal's change detection all follow from the type's shape
and kind, so they need nothing more.

A type that brings something new leads the compiler further:

- A new kind fails to compile at Admin's
  [`KIND_FILTER`](../../../apps/admin/src/members/custom-fields/filter-fields.ts)
  until it says how values of that kind are filtered. The first type of it fails at Admin's
  presentation and Portal's `DRAWN_BY` until each has a control for it.
- A new part type fails to compile at its rule in `PART_TYPES` and at Admin's
  `PART_FILTER_TYPE`. How it reads in Admin's one-line value, and the picker a filter
  offers for it, are written by hand: only countries have either today.
- A new shape fails to compile at every `matchShape` call and every map keyed by shape
  until each says what it does with a value of that shape: the value a rule parses to,
  Ghost's value reads and writes, CSV columns, Admin's controls, editor, value display
  and filters, and Portal's components, changes and error placement.

A new record can also name parts that read as one run in Admin's one-line value, such as
a state and its postal code, and Portal's labels for its parts need translating like any
other string.

The catalog already declares the `date` and `number` kinds, and Admin already knows which
filters they offer, but no type has used them yet. The first type of either fails to
compile until Admin and Portal each have a control for it. The compiler won't ask about the
rest: Admin's value display and filter value box show the stored text, and Ghost's filters
compare it as text, so ordering numbers needs a look too.

## A type set up per field

No type is set up per field yet. The first, a select whose options belong to the field
rather than its type, needs somewhere in the definition to keep them. Its value is picked
rather than typed, so it is a kind of its own, and the compiler then asks how it filters
and for a control in Admin and Portal. Values are checked only through
`valueSchemaFor(field)`, so checking one against the field's own options changes there
alone. Showing an option's label and offering the options in a filter need the field
too, and Admin's value display and filter picker take only its type today, so those
change by hand.
