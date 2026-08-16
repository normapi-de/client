# @normapi/client

Validate German e-invoices — **XRechnung** (UBL and CII) and **ZUGFeRD / Factur-X**
hybrid PDFs — against the official KoSIT rule set, without running a Java
toolchain yourself.

This is the client for [NormAPI](https://normapi.de). The service embeds the
official validator and the current XRechnung rule set; this package is a thin,
zero-dependency wrapper around one HTTP call.

```bash
npm install @normapi/client
```

## Validate an invoice

```ts
import { validate } from '@normapi/client'
import { readFile } from 'node:fs/promises'

const result = await validate(await readFile('invoice.xml'), {
  documentName: 'invoice.xml',
})

if (result.acceptable) {
  console.log(`valid — checked as ${result.scenario}, rules ${result.rulesetVersion}`)
} else {
  for (const finding of result.findings) {
    console.log(`${finding.severity} ${finding.code}: ${finding.text}`)
  }
}
```

ZUGFeRD / Factur-X PDFs work the same way — pass the PDF bytes. The service
detects the content, extracts the embedded invoice XML, and validates that:

```ts
const result = await validate(await readFile('rechnung.pdf'))
```

## Generate an invoice

Send invoice data, get back a validated XRechnung 3.0.2 (UBL). The server
computes every total in decimal arithmetic, and **no invoice leaves
unvalidated**: a resolved promise carries XML the official rule set accepted.

```ts
import { generateInvoice, InvoiceNotPermittedError } from '@normapi/client'
import { writeFile } from 'node:fs/promises'

try {
  const { xml, rulesetVersion, scenario } = await generateInvoice({
    invoiceNumber: 'RE-2026-0815',
    issueDate: '2026-08-13',
    dueDate: '2026-09-12',
    currency: 'EUR',
    buyerReference: '04011000-12345-03',
    seller: {
      name: 'Muster Software GmbH',
      vatId: 'DE123456789',
      address: { street: 'Beispielstraße 12', city: 'Berlin', postcode: '10115', country: 'DE' },
      contact: { name: 'Maria Muster', phone: '+49 30 1234567', email: 'maria@muster-software.de' },
    },
    buyer: {
      name: 'Beispiel Handel AG',
      address: { city: 'Hamburg', postcode: '20095', country: 'DE' },
    },
    payment: { meansCode: '58', iban: 'DE02120300000000202051' },
    lines: [
      { name: 'Softwarelizenz', quantity: 3, unit: 'C62', unitPrice: '199.00', vatCategory: 'S', vatRate: 19 },
    ],
  })
  await writeFile('rechnung.xml', xml)
  console.log(`generated — ${scenario}, rules ${rulesetVersion}`)
} catch (error) {
  if (error instanceof InvoiceNotPermittedError) {
    // the data describes an invoice German rules do not permit —
    // each finding names the violated rule (BR-DE-16, …)
    for (const f of error.findings) console.error(`${f.code}: ${f.text}`)
  } else {
    throw error
  }
}
```

Money fields accept strings (`"199.00"`) as well as numbers — strings never
touch a float on their way to the server's BigDecimal.

Prefer CII syntax? `generateInvoice(data, { syntax: 'cii' })`.

## Generate a ZUGFeRD hybrid PDF

The complete hybrid: a human-readable A4 invoice page as PDF/A-3 with the
validated CII invoice embedded — ready to email to any recipient, with or
without e-invoicing software.

```ts
import { generateInvoicePdf } from '@normapi/client'
import { writeFile } from 'node:fs/promises'

const { pdf, scenario } = await generateInvoicePdf(invoiceData)
await writeFile('rechnung.pdf', pdf)
```

## Reading the result

- **`acceptable` is the verdict.** Base accept/reject decisions on this flag
  and nothing else.
- `schematronValid` is *not* a verdict: the German rule set emits
  informational advisories on perfectly valid invoices, and any advisory sets
  it false while `acceptable` stays true.
- `businessRulesEvaluated: false` means a schema failure stopped the pipeline
  early — an empty findings list then means "not checked", never "nothing
  wrong".
- `scenario` names the rules that judged the document: an XRechnung invoice
  gets the German CIUS (`EN16931 XRechnung (UBL Invoice)`), a plain EN 16931
  profile — typical for B2B ZUGFeRD — gets the European core rules
  (`EN16931 (CII)`). `scenario: null` means no rule scenario matched the
  declared profile: nothing was checked, and `acceptable: false` is a refusal
  to judge, not a judgement.
- Every result records `rulesetVersion`, so a verdict can always be traced to
  the rules in force when it was made.

## Errors

An **invalid invoice is not an error** — it is a successful validation with
`acceptable: false`. Errors are thrown only when the request itself could not
be processed:

```ts
import { validate, RateLimitError, ValidatorBusyError, NormapiError } from '@normapi/client'

try {
  await validate(xml)
} catch (error) {
  if (error instanceof RateLimitError) {
    // over the per-client budget — wait error.retryAfterSeconds, then retry
  } else if (error instanceof ValidatorBusyError) {
    // every validation slot busy — retry after error.retryAfterSeconds
  } else if (error instanceof NormapiError) {
    // 400 empty body, 413 too large, 415 not XML/PDF, 422 unreadable PDF …
    console.error(error.status, error.detail)
  } else {
    throw error // network failure, abort, …
  }
}
```

## Your own deployment

```ts
import { Normapi } from '@normapi/client'

const client = new Normapi({ baseUrl: 'https://api.example.com' })
const result = await client.validate(xml)
```

## Requirements

Node 18+, or any runtime with global `fetch` (browsers, Deno, Bun). No
runtime dependencies.

## Fair use

The public endpoint is rate-limited per client (HTTP 429 with `Retry-After`)
and answers 503 when all validation slots are busy. Both are momentary —
back off and retry. Uploaded invoices are validated in memory and discarded;
see the [privacy policy](https://normapi.de/datenschutz).

## Getting an API key

Validation works without one, under anonymous rate limits — the examples above
need no account. Generating invoices does: create a free account at
[normapi.de](https://normapi.de/en/account) (25 generated invoices a month,
no card), make a key, and pass it as `apiKey`.

## Issues and questions

Bugs and questions belong in
[GitHub issues](https://github.com/normapi-de/client/issues) — that way the answer
helps whoever hits it next. Anything about your account or invoice data instead
goes to kontakt@normapi.de.

## License

MIT — see [LICENSE](./LICENSE).
