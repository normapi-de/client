/**
 * Client for the NormAPI validation service — https://normapi.de
 *
 * Zero dependencies. Uses the global fetch, so it runs unchanged in Node 18+,
 * browsers, Deno, and Bun. The response is verified at runtime before it is
 * returned as typed data: this library never asserts a network payload into a
 * type it has not checked.
 */

/** One finding from the rule set — a violation, warning, or notice. */
export interface Finding {
  /** Rule identifier, e.g. `BR-CO-16`, or a `cvc-*` XML schema constraint. */
  readonly code: string
  readonly severity: 'ERROR' | 'WARNING' | 'INFORMATION'
  /** The rule set's own explanation text (German for BR-DE rules). */
  readonly text: string
  readonly origin: 'SCHEMA' | 'SCHEMATRON'
  /** XPath of the offending node; null for schema findings. */
  readonly location: string | null
  /** Line in the document; null for Schematron findings. */
  readonly line: number | null
  /** Column in the document; null for Schematron findings. */
  readonly column: number | null
  /** The assertion that failed; null for schema findings. */
  readonly test: string | null
}

export interface ValidationResult {
  /** The verdict — the one flag to base an accept/reject decision on. */
  readonly acceptable: boolean
  readonly wellFormed: boolean
  readonly schemaValid: boolean
  /**
   * Whether the business rules produced no findings at all. Not a verdict:
   * informational advisories set this false on perfectly valid invoices.
   */
  readonly schematronValid: boolean
  /**
   * False when a schema failure stopped the run early — an empty findings
   * list then means "not checked", never "nothing wrong".
   */
  readonly businessRulesEvaluated: boolean
  /** The rule set release that produced this verdict, e.g. `v2026-01-31`. */
  readonly rulesetVersion: string
  /**
   * Which rule scenario judged the document — e.g. `EN16931 XRechnung (UBL
   * Invoice)` or `EN16931 (CII)`. Null when no scenario matched, in which
   * case nothing was checked and `acceptable: false` is a refusal to judge.
   */
  readonly scenario: string | null
  readonly findings: readonly Finding[]
}

/** The service rejected or could not process the request (4xx/5xx). */
export class NormapiError extends Error {
  readonly status: number
  /** RFC 9457 problem detail from the response body, when one was sent. */
  readonly detail: string

  constructor(message: string, status: number, detail: string) {
    super(message)
    this.name = 'NormapiError'
    this.status = status
    this.detail = detail
  }
}

/** 429 — this client is over its request budget. Wait and retry. */
export class RateLimitError extends NormapiError {
  /** Seconds to wait before retrying, from the Retry-After header. */
  readonly retryAfterSeconds: number

  constructor(detail: string, retryAfterSeconds: number) {
    super('rate limit exceeded', 429, detail)
    this.name = 'RateLimitError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** 503 — every validation slot is busy. Retrying shortly is the fix. */
export class ValidatorBusyError extends NormapiError {
  readonly retryAfterSeconds: number

  constructor(detail: string, retryAfterSeconds: number) {
    super('validator at capacity', 503, detail)
    this.name = 'ValidatorBusyError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * 422 from generation — the data describes an invoice the official rule set
 * does not permit. Not a bug and not a malformed request: each finding names
 * the violated rule (e.g. BR-DE-16), exactly as the validation endpoint
 * would report it.
 */
export class InvoiceNotPermittedError extends NormapiError {
  readonly findings: readonly Finding[]
  readonly rulesetVersion: string

  constructor(detail: string, findings: readonly Finding[], rulesetVersion: string) {
    super('invoice not permitted by the rule set', 422, detail)
    this.name = 'InvoiceNotPermittedError'
    this.findings = findings
    this.rulesetVersion = rulesetVersion
  }
}

export interface ValidateOptions {
  /** Filename echoed into the report; never interpreted. */
  readonly documentName?: string
  readonly signal?: AbortSignal
}

export interface GenerateOptions {
  /** Output syntax: UBL (default) or UN/CEFACT CII. */
  readonly syntax?: 'ubl' | 'cii'
  readonly signal?: AbortSignal
}

/**
 * The invoice to generate — the JSON body of {@code POST /v1/invoices}.
 *
 * Send lines; every total is computed server-side in decimal arithmetic. Money
 * fields accept strings as well as numbers: {@code "19.90"} survives JSON
 * without ever touching a float, which is the safest way to carry an amount.
 *
 * Structural minimums are typed here; whether a *combination* is permitted is
 * the rule set's verdict — violations surface as {@link InvoiceNotPermittedError}
 * naming the exact rule, not as client-side guesses.
 */
export interface InvoiceInput {
  /** BT-1. */
  readonly invoiceNumber: string
  /** BT-2, as YYYY-MM-DD. */
  readonly issueDate: string
  /** BT-9. XRechnung wants this or paymentTerms on payable invoices. */
  readonly dueDate?: string
  /** BT-72. Omitting it draws an advisory from the rule set. */
  readonly deliveryDate?: string
  /** BT-5, ISO 4217 — e.g. "EUR". */
  readonly currency: string
  /** BT-10 — mandatory in XRechnung; the Leitweg-ID for public-sector buyers. */
  readonly buyerReference: string
  /** BT-22. */
  readonly note?: string
  readonly seller: PartyInput
  readonly buyer: PartyInput
  readonly payment: PaymentInput
  /** BT-20. */
  readonly paymentTerms?: string
  readonly lines: readonly LineInput[]
}

export interface PartyInput {
  /** BT-27 / BT-44 — the legal name. */
  readonly name: string
  /**
   * BT-29 / BT-46. Sellers without a VAT id need this for BR-CO-26 — the tax
   * number alone satisfies only BR-DE-16; repeating it here is fine.
   */
  readonly identifier?: string
  /** BT-31 / BT-48, e.g. "DE123456789". */
  readonly vatId?: string
  /** BT-32 — the German Steuernummer. */
  readonly taxNumber?: string
  /** BT-34 / BT-49, usually an email address. */
  readonly electronicAddress?: string
  /** EAS code for the electronic address; defaults to "EM" (email). */
  readonly electronicAddressScheme?: string
  readonly address: AddressInput
  /** BG-6 — mandatory on the seller side (BR-DE-2 through 7). */
  readonly contact?: ContactInput
}

export interface AddressInput {
  readonly street?: string
  readonly city: string
  readonly postcode: string
  /** ISO 3166-1 alpha-2, e.g. "DE". */
  readonly country: string
}

export interface ContactInput {
  readonly name: string
  readonly phone: string
  readonly email: string
}

export interface PaymentInput {
  /** BT-81, UNTDID 4461 — "58" SEPA credit transfer, "30" credit transfer. */
  readonly meansCode: string
  /** BT-84 — required by BR-DE-23-a for transfer codes. */
  readonly iban?: string
  /** BT-83 — remittance information. */
  readonly reference?: string
}

export interface LineInput {
  /** BT-126; assigned 1..n when absent. */
  readonly id?: string
  /** BT-153. */
  readonly name: string
  /** BT-154. */
  readonly description?: string
  /** BT-129, up to six decimals. */
  readonly quantity: number | string
  /** BT-130, UN/ECE Rec 20 — "C62" piece, "HUR" hour … */
  readonly unit: string
  /** BT-146, net, up to four decimals. */
  readonly unitPrice: number | string
  /** BT-151, UNTDID 5305. */
  readonly vatCategory: 'S' | 'Z' | 'E' | 'AE' | 'K' | 'G' | 'O' | 'L' | 'M'
  /** BT-152, percent — required for category S. */
  readonly vatRate?: number | string
  /** BT-120 — demanded by the rule set for the exempt-family categories. */
  readonly vatExemptionReason?: string
}

/** What generation returns: the document, plus the provenance headers. */
export interface GeneratedInvoice {
  /** The XRechnung document, exactly as the API returned it. */
  readonly xml: string
  /** The rule set that validated the document before it left, e.g. "v2026-01-31". */
  readonly rulesetVersion: string | null
  /** The scenario the document passed, e.g. "EN16931 XRechnung (UBL Invoice)". */
  readonly scenario: string | null
}

export interface GeneratePdfOptions {
  readonly signal?: AbortSignal
}

/** A ZUGFeRD hybrid: the readable PDF with the validated invoice embedded. */
export interface GeneratedInvoicePdf {
  /** PDF/A-3 bytes — write them to a file and the invoice is ready to send. */
  readonly pdf: Uint8Array
  readonly rulesetVersion: string | null
  /** The rules the embedded invoice passed, e.g. "EN16931 XRechnung (CII)". */
  readonly scenario: string | null
}

export interface ClientOptions {
  /** Defaults to the public service. Point at your own deployment to override. */
  readonly baseUrl?: string
  /** Custom fetch, e.g. for proxies or instrumentation. Defaults to global fetch. */
  readonly fetch?: typeof fetch
}

const PUBLIC_BASE_URL = 'https://api.normapi.de'

export class Normapi {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? PUBLIC_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = options.fetch ?? fetch
  }

  /**
   * Validate one invoice document.
   *
   * Accepts XRechnung XML (UBL or CII) as a string or bytes, or a
   * ZUGFeRD/Factur-X hybrid PDF as bytes — the service detects the kind from
   * the content, never from a declared type.
   *
   * An invalid invoice is a *successful* call: the verdict is in
   * `result.acceptable`. Errors are thrown only when the request itself
   * could not be processed.
   */
  async validate(
    document: string | Uint8Array | ArrayBuffer,
    options: ValidateOptions = {},
  ): Promise<ValidationResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/xml' }
    if (options.documentName !== undefined) {
      headers['X-Document-Name'] = options.documentName
    }

    const response = await this.fetchImpl(`${this.baseUrl}/v1/validate`, {
      method: 'POST',
      headers,
      body: toBody(document),
      signal: options.signal ?? null,
    })

    const body: unknown = await response.json().catch(() => null)

    if (!response.ok) {
      throw errorFor(response, body)
    }

    const result = parseValidationResult(body)
    if (result === null) {
      throw new NormapiError(
        'unexpected response shape from the validation service',
        response.status,
        '',
      )
    }
    return result
  }

  /**
   * Generate a validated XRechnung (UBL) from invoice data.
   *
   * The server computes every total and validates the generated document
   * against the official rule set before responding — a resolved promise
   * carries XML that passed. Data the rules reject throws
   * {@link InvoiceNotPermittedError} with the findings.
   */
  async generateInvoice(
    invoice: InvoiceInput,
    options: GenerateOptions = {},
  ): Promise<GeneratedInvoice> {
    const syntax = options.syntax === undefined ? '' : `?syntax=${options.syntax}`
    const response = await this.fetchImpl(`${this.baseUrl}/v1/invoices${syntax}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invoice),
      signal: options.signal ?? null,
    })

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null)
      throw generationErrorFor(response, body)
    }

    return {
      xml: await response.text(),
      rulesetVersion: response.headers.get('X-Normapi-Ruleset'),
      scenario: response.headers.get('X-Normapi-Scenario'),
    }
  }

  /**
   * Generate a complete ZUGFeRD hybrid: a PDF/A-3 with a human-readable invoice page and
   * the validated CII invoice embedded. Same guarantee as {@link generateInvoice} — the
   * embedded document passed the official rule set before the response existed.
   */
  async generateInvoicePdf(
    invoice: InvoiceInput,
    options: GeneratePdfOptions = {},
  ): Promise<GeneratedInvoicePdf> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/invoices?syntax=zugferd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invoice),
      signal: options.signal ?? null,
    })

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null)
      throw generationErrorFor(response, body)
    }

    return {
      pdf: new Uint8Array(await response.arrayBuffer()),
      rulesetVersion: response.headers.get('X-Normapi-Ruleset'),
      scenario: response.headers.get('X-Normapi-Scenario'),
    }
  }
}

/** One-shot convenience against the public service. */
export async function validate(
  document: string | Uint8Array | ArrayBuffer,
  options: ValidateOptions & ClientOptions = {},
): Promise<ValidationResult> {
  return new Normapi(clientOptionsOf(options)).validate(document, options)
}

/** One-shot convenience against the public service. */
export async function generateInvoice(
  invoice: InvoiceInput,
  options: GenerateOptions & ClientOptions = {},
): Promise<GeneratedInvoice> {
  return new Normapi(clientOptionsOf(options)).generateInvoice(invoice, options)
}

/** One-shot convenience against the public service. */
export async function generateInvoicePdf(
  invoice: InvoiceInput,
  options: GeneratePdfOptions & ClientOptions = {},
): Promise<GeneratedInvoicePdf> {
  return new Normapi(clientOptionsOf(options)).generateInvoicePdf(invoice, options)
}

function clientOptionsOf(options: ClientOptions): ClientOptions {
  return options.fetch === undefined
    ? { ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }) }
    : {
        fetch: options.fetch,
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      }
}

function toBody(document: string | Uint8Array | ArrayBuffer): string | Uint8Array<ArrayBuffer> {
  if (typeof document === 'string') {
    return document
  }
  if (document instanceof ArrayBuffer) {
    return new Uint8Array(document)
  }
  // Copied rather than passed through: fetch's BodyInit requires a plain
  // ArrayBuffer backing, and a Uint8Array<ArrayBufferLike> could be backed by
  // a SharedArrayBuffer. Invoices are a few kilobytes; the copy is free.
  const copy = new Uint8Array(document.byteLength)
  copy.set(document)
  return copy
}

/** Generation adds one refinement: a 422 with findings names the violated rules. */
function generationErrorFor(response: Response, body: unknown): NormapiError {
  if (response.status === 422 && isRecord(body) && Array.isArray(body['findings'])) {
    const findings: Finding[] = []
    for (const candidate of body['findings']) {
      const parsed = parseFinding(candidate)
      if (parsed !== null) {
        findings.push(parsed)
      }
    }
    const rulesetVersion =
      typeof body['rulesetVersion'] === 'string' ? body['rulesetVersion'] : ''
    return new InvoiceNotPermittedError(problemDetail(body), findings, rulesetVersion)
  }
  return errorFor(response, body)
}

function errorFor(response: Response, body: unknown): NormapiError {
  const detail = problemDetail(body)
  const retryAfter = retryAfterSeconds(response)
  if (response.status === 429) {
    return new RateLimitError(detail, retryAfter)
  }
  if (response.status === 503) {
    return new ValidatorBusyError(detail, retryAfter)
  }
  return new NormapiError(
    detail.length > 0 ? detail : `request failed with status ${response.status}`,
    response.status,
    detail,
  )
}

function retryAfterSeconds(response: Response): number {
  const header = response.headers.get('Retry-After')
  if (header === null) {
    return 5
  }
  const parsed = Number.parseInt(header, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5
}

function problemDetail(body: unknown): string {
  if (isRecord(body) && typeof body['detail'] === 'string') {
    return body['detail']
  }
  return ''
}

// ---------------------------------------------------------------------------
// Runtime verification of the response shape. Hand-rolled rather than pulled
// in as a dependency: this package promises zero runtime dependencies.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOrNull(value: unknown): string | null | undefined {
  if (value === null || typeof value === 'string') {
    return value
  }
  return undefined
}

function intOrNull(value: unknown): number | null | undefined {
  if (value === null || (typeof value === 'number' && Number.isInteger(value))) {
    return value
  }
  return undefined
}

function parseFinding(value: unknown): Finding | null {
  if (!isRecord(value)) {
    return null
  }
  const { code, severity, text, origin } = value
  if (typeof code !== 'string' || typeof text !== 'string') {
    return null
  }
  if (severity !== 'ERROR' && severity !== 'WARNING' && severity !== 'INFORMATION') {
    return null
  }
  if (origin !== 'SCHEMA' && origin !== 'SCHEMATRON') {
    return null
  }
  const location = stringOrNull(value['location'])
  const line = intOrNull(value['line'])
  const column = intOrNull(value['column'])
  const test = stringOrNull(value['test'])
  if (
    location === undefined ||
    line === undefined ||
    column === undefined ||
    test === undefined
  ) {
    return null
  }
  return { code, severity, text, origin, location, line, column, test }
}

function parseValidationResult(value: unknown): ValidationResult | null {
  if (!isRecord(value)) {
    return null
  }
  const {
    acceptable,
    wellFormed,
    schemaValid,
    schematronValid,
    businessRulesEvaluated,
    rulesetVersion,
    findings,
  } = value
  if (
    typeof acceptable !== 'boolean' ||
    typeof wellFormed !== 'boolean' ||
    typeof schemaValid !== 'boolean' ||
    typeof schematronValid !== 'boolean' ||
    typeof businessRulesEvaluated !== 'boolean' ||
    typeof rulesetVersion !== 'string' ||
    !Array.isArray(findings)
  ) {
    return null
  }
  const scenario = stringOrNull(value['scenario'])
  if (scenario === undefined) {
    return null
  }
  const parsedFindings: Finding[] = []
  for (const finding of findings) {
    const parsed = parseFinding(finding)
    if (parsed === null) {
      return null
    }
    parsedFindings.push(parsed)
  }
  return {
    acceptable,
    wellFormed,
    schemaValid,
    schematronValid,
    businessRulesEvaluated,
    rulesetVersion,
    scenario,
    findings: parsedFindings,
  }
}
