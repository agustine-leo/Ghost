---
"@tryghost/metafield-types": minor
---

Changed `./structure` to describe each field type in one entry, including how its value is laid out.

- `FIELD_STRUCTURES` replaces `FIELD_PARTS`. Each type's entry names its shape: `scalar` with its `kind`, or `record` with its `parts`. Read a record's parts as `FIELD_STRUCTURES[type].parts`, or keep using `partsOf` and `partTypesOf`.
- `FIELD_SHAPES` lists the shapes, and `matchShape(type, { scalar, record })` calls the handler for the shape a type declares, so a caller has to say what it does with every shape. It throws for a type the package doesn't know, so check `FIELD_TYPE_IDS` and skip one first.
- `isRecordValue` tells whether a value is laid out as a record of parts.
- A record no longer has a kind: `FIELD_KINDS` no longer includes `record`, and a type's kind moved from `FIELD_TYPES[type].kind` to its entry in `FIELD_STRUCTURES`.
