---
"@tryghost/metafield-types": minor
---

Changed how the catalog names types and parts, so a caller needs no cast to use them.

- `isFieldType(value)` tells whether a value names a type this build knows. Check a type off the wire with it before handing it to `matchShape` or `valueSchemaFor`.
- `partsOf` and `partTypesOf` name a record's parts as plain strings. Read one type's parts by name from `FIELD_STRUCTURES[type].parts`, whose keys are typed.
