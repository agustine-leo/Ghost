---
"@tryghost/metafield-types": minor
---

Changed how a value's rule is read, so it is asked of the field rather than its type.

- `valueSchemaFor(field)` is the rule a value of one field must satisfy. Ghost and Admin check every value through it, so a rule that comes to depend on how a field is set up changes in one place. It throws for a type the package doesn't know, as `matchShape` does.
- `FIELD_TYPES` is no longer exported. Read a type's rule as `valueSchemaFor({ type })`.
- `AddressValue` is no longer exported either. The `Address` type stays.
