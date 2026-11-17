# Vendored from AOA-RWA / Townhall Records (the aoa-rwa project, packages/engine/src)

Reused instead of rewritten, as the brief asked. Same owner, same engine lineage.

| File here | Origin | Change |
|---|---|---|
| canonical.ts | canonical.ts | none |
| crypto.ts | crypto.ts | key-derivation label `aoa-rwa/key/` -> `voter-list/key/` |
| masking.ts | masking.ts | none (maskName / maskEmail / maskPhone / scanPublic) |
| log.ts | log.ts | domain strings `aoa-rwa/...` -> `voter-list/...` (hash-chained, Ed25519-signed log) |
| zip.ts | rolltemplate.ts (crc32, zipStored) | extracted only |
| pdfdoc.ts | pdf.ts (`Doc` class: A4 text PDF, standard fonts, watermark, footer) | extracted, exported, font names unchanged |

Do not edit these in place without checking the AOA-RWA original; the masking and log formats are shared contracts.
