import { AppError } from "../errors.ts";
import { MAX_SVG_BYTES, type OutputImageInfo } from "./types.ts";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
const DEFAULT_WIDTH = 300;
const DEFAULT_HEIGHT = 150;
const MAX_REFERENCE_NAME_LENGTH = 32;
const MAX_XML_DECLARATION_LENGTH = 256;
const MAX_LENGTH_VALUE_LENGTH = 64;
const MAX_VIEW_BOX_LENGTH = 256;
const MAX_DOCTYPE_LENGTH = 1024;
const MAX_ELEMENT_DEPTH = 512;

const LESS_THAN = 0x3c;
const GREATER_THAN = 0x3e;
const SLASH = 0x2f;
const EQUALS = 0x3d;
const DOUBLE_QUOTE = 0x22;
const APOSTROPHE = 0x27;
const NUMBER_SIGN = 0x23;
const SEMICOLON = 0x3b;

/**
 * Lowercased local names of the static SVG elements that may appear. Every
 * other name is rejected, which keeps out script, foreignObject, image,
 * feImage, SMIL animation, SVG fonts, cursor, tref, mpath, and every HTML
 * element name that would break out of SVG parsing when inlined into HTML.
 */
const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "switch",
  "a",
  "view",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textpath",
  "title",
  "desc",
  "metadata",
  "style",
  "lineargradient",
  "radialgradient",
  "stop",
  "pattern",
  "clippath",
  "mask",
  "marker",
  "filter",
  "feblend",
  "fecolormatrix",
  "fecomponenttransfer",
  "fecomposite",
  "feconvolvematrix",
  "fediffuselighting",
  "fedisplacementmap",
  "fedistantlight",
  "fedropshadow",
  "feflood",
  "fefunca",
  "fefuncb",
  "fefuncg",
  "fefuncr",
  "fegaussianblur",
  "femerge",
  "femergenode",
  "femorphology",
  "feoffset",
  "fepointlight",
  "fespecularlighting",
  "fespotlight",
  "fetile",
  "feturbulence",
]);

/**
 * Elements whose content must be text. title and desc are HTML integration
 * points, so child markup there is parsed as HTML when the SVG is inlined.
 */
const TEXT_ONLY_ELEMENTS = new Set(["style", "title", "desc", "metadata"]);

/** Attributes whose values are prose and never interpreted as CSS or URLs. */
const PROSE_ATTRIBUTE_PATTERN = /^(?:aria|data)-[a-z0-9._-]+$/i;

const STANDARD_DOCTYPES = new Set([
  '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
  '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.0//EN" "http://www.w3.org/TR/2001/REC-SVG-20010904/DTD/svg10.dtd">',
]);

/** Lowercased local names of attributes whose value is a URL. */
const REFERENCE_ATTRIBUTES = new Set(["href", "src"]);

const PREDEFINED_ENTITIES = new Map([
  ["lt", "<"],
  ["gt", ">"],
  ["amp", "&"],
  ["quot", '"'],
  ["apos", "'"],
]);

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*(?::[A-Za-z_][A-Za-z0-9._-]*)?$/;
const XML_DECLARATION_PATTERN =
  /^[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(?:"1\.[0-9]+"|'1\.[0-9]+')(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(?:"([A-Za-z][A-Za-z0-9._-]*)"|'([A-Za-z][A-Za-z0-9._-]*)'))?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\r\n]*$/;
const UTF8_ENCODING_LABELS = new Set(["utf-8", "utf8"]);
const LENGTH_PATTERN = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?(?:px)?$/i;
const NUMBER_PATTERN = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?$/i;
const DECIMAL_PATTERN = /^[0-9]+$/;
const HEXADECIMAL_PATTERN = /^[0-9A-Fa-f]+$/;

interface StartTag {
  name: string;
  attributes: Map<string, string>;
  selfClosing: boolean;
}

function invalidSvg(message: string): never {
  throw new AppError("INPUT_FILE_INVALID", `Invalid SVG: ${message}`);
}

function isXmlWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isNameCharacter(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x5f ||
    code === 0x2d ||
    code === 0x2e ||
    code === 0x3a
  );
}

function isXmlCharacter(codePoint: number): boolean {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

/** Whitespace and control characters dropped before active-content checks. */
function isIgnoredForChecks(code: number): boolean {
  return (
    code <= 0x20 ||
    (code >= 0x7f && code <= 0xa0) ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function isAllXmlWhitespace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!isXmlWhitespace(value.charCodeAt(index))) return false;
  }
  return true;
}

function trimXmlWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isXmlWhitespace(value.charCodeAt(start))) start += 1;
  while (end > start && isXmlWhitespace(value.charCodeAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}

function collapseXmlWhitespace(value: string): string {
  let collapsed = "";
  let inWhitespace = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (isXmlWhitespace(code)) {
      if (!inWhitespace) collapsed += " ";
      inWhitespace = true;
    } else {
      collapsed += value[index];
      inWhitespace = false;
    }
  }
  return collapsed;
}

function assertAllowedCharacters(text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      invalidSvg("content contains a forbidden control character");
    }
    if (code === 0xfffe || code === 0xffff) {
      invalidSvg("content contains a non-XML character");
    }
  }
}

const UTF16LE_DECODER = new TextDecoder("utf-16le", { ignoreBOM: true });

/**
 * Collects UTF-16 code units in a preallocated byte buffer and decodes them
 * once. Building large strings from many slices costs dozens of bytes per
 * slice; this costs two bytes per code unit. Bytes are written explicitly in
 * little-endian order, and a leading U+FEFF is kept rather than treated as a
 * byte order mark.
 */
class CodeUnitBuilder {
  readonly #bytes: Uint8Array;
  #length = 0;

  constructor(maxCodeUnits: number) {
    this.#bytes = new Uint8Array(maxCodeUnits * 2);
  }

  append(code: number): void {
    this.#bytes[this.#length] = code & 0xff;
    this.#bytes[this.#length + 1] = code >>> 8;
    this.#length += 2;
  }

  appendRange(value: string, start: number, end: number): void {
    for (let index = start; index < end; index += 1) this.append(value.charCodeAt(index));
  }

  toString(): string {
    return UTF16LE_DECODER.decode(this.#bytes.subarray(0, this.#length));
  }
}

function decodeCharacterReference(name: string): number {
  const hexadecimal = name.startsWith("#x");
  const digits = name.slice(hexadecimal ? 2 : 1);
  const pattern = hexadecimal ? HEXADECIMAL_PATTERN : DECIMAL_PATTERN;
  if (!pattern.test(digits)) invalidSvg("character reference is invalid");
  const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
  if (!isXmlCharacter(codePoint)) invalidSvg("character reference is invalid");
  return codePoint;
}

/**
 * Decodes the five predefined XML entities and numeric character references.
 * Every other reference is rejected. The search for each terminating
 * semicolon is bounded, so decoding stays linear in the input length. Every
 * reference is at least four code units long and decodes to at most two, so
 * the output never exceeds the input length.
 */
function decodeReferences(raw: string): string {
  let ampersand = raw.indexOf("&");
  if (ampersand < 0) return raw;

  const decoded = new CodeUnitBuilder(raw.length);
  let start = 0;
  while (ampersand >= 0) {
    decoded.appendRange(raw, start, ampersand);
    const isCharacterReference = raw.charCodeAt(ampersand + 1) === NUMBER_SIGN;
    const limit = Math.min(raw.length, ampersand + 2 + MAX_REFERENCE_NAME_LENGTH);
    let semicolon = -1;
    for (let index = ampersand + 1; index < limit; index += 1) {
      if (raw.charCodeAt(index) === SEMICOLON) {
        semicolon = index;
        break;
      }
    }
    if (semicolon < 0) {
      invalidSvg(
        isCharacterReference
          ? "character reference is invalid"
          : "entity reference is not allowed",
      );
    }

    const name = raw.slice(ampersand + 1, semicolon);
    if (isCharacterReference) {
      const codePoint = decodeCharacterReference(name);
      if (codePoint > 0xffff) {
        const offset = codePoint - 0x10000;
        decoded.append(0xd800 + (offset >>> 10));
        decoded.append(0xdc00 + (offset & 0x3ff));
      } else {
        decoded.append(codePoint);
      }
    } else {
      const replacement = PREDEFINED_ENTITIES.get(name);
      if (replacement === undefined) invalidSvg("entity reference is not allowed");
      decoded.append(replacement.charCodeAt(0));
    }
    start = semicolon + 1;
    ampersand = raw.indexOf("&", start);
  }
  decoded.appendRange(raw, start, raw.length);
  return decoded.toString();
}

function isAsciiWhitespaceOrControl(code: number): boolean {
  return code <= 0x20;
}

/** Removes the matching code units and lowercases the rest. */
function removeCharacters(value: string, isRemoved: (code: number) => boolean): string {
  let removedAny = false;
  for (let index = 0; index < value.length; index += 1) {
    if (isRemoved(value.charCodeAt(index))) {
      removedAny = true;
      break;
    }
  }
  if (!removedAny) return value.toLowerCase();

  const kept = new CodeUnitBuilder(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!isRemoved(code)) kept.append(code);
  }
  return kept.toString().toLowerCase();
}

/** True for code units that can continue a CSS identifier. */
function isCssNameCharacter(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2d ||
    code === 0x5f ||
    code >= 0x80
  );
}

/**
 * Rejects the CSS src() and image() functions, which take string URLs. A
 * function token needs the name directly before "(" and must start a token,
 * so the check runs on the decoded text without removing whitespace.
 */
function assertNoFetchFunctions(value: string, where: string): void {
  const lower = value.toLowerCase();
  for (const name of ["src(", "image("]) {
    let index = lower.indexOf(name);
    while (index >= 0) {
      if (index === 0 || !isCssNameCharacter(lower.charCodeAt(index - 1))) {
        invalidSvg(`${where} contains an image() or src() reference`);
      }
      index = lower.indexOf(name, index + 1);
    }
  }
}

function assertFragmentUrls(normalized: string, where: string): void {
  let url = normalized.indexOf("url(");
  while (url >= 0) {
    let target = url + 4;
    const quote = normalized.charCodeAt(target);
    if (quote === DOUBLE_QUOTE || quote === APOSTROPHE) target += 1;
    if (normalized.charCodeAt(target) !== NUMBER_SIGN) {
      invalidSvg(`${where} contains an external url() reference`);
    }
    url = normalized.indexOf("url(", target);
  }
}

/**
 * Rejects decoded attribute values and style text that could run script or
 * load an external resource.
 */
function assertNoActiveContent(value: string, where: string): void {
  const normalized = removeCharacters(value, isIgnoredForChecks);
  if (normalized.includes("javascript:") || normalized.includes("vbscript:")) {
    invalidSvg(`${where} contains a script URL`);
  }
  if (normalized.includes("@import")) invalidSvg(`${where} contains an @import rule`);
  if (normalized.includes("image-set(")) {
    invalidSvg(`${where} contains an image-set() reference`);
  }
  if (normalized.includes("\\")) invalidSvg(`${where} contains a CSS escape`);
  assertNoFetchFunctions(value, where);

  // Removing extra characters can only add matches to the deny checks above,
  // but it could hide a character in front of a url() target. CSS and the URL
  // parser strip only ASCII whitespace and C0 controls, so the fragment check
  // must also hold when nothing else is removed.
  assertFragmentUrls(normalized, where);
  assertFragmentUrls(removeCharacters(value, isAsciiWhitespaceOrControl), where);
}

function isSameDocumentReference(value: string): boolean {
  let start = 0;
  while (start < value.length && value.charCodeAt(start) <= 0x20) start += 1;
  return value.charCodeAt(start) === NUMBER_SIGN;
}

function isProseAttribute(name: string): boolean {
  return PROSE_ATTRIBUTE_PATTERN.test(name) || name.toLowerCase() === "xlink:title";
}

function assertAllowedAttribute(name: string, value: string): void {
  const lowerName = name.toLowerCase();
  const lowerLocalName = localName(lowerName);
  if (lowerName === "xmlns") {
    if (value !== SVG_NAMESPACE) {
      invalidSvg("default namespace declaration must name the SVG namespace");
    }
  } else if (lowerName.startsWith("xmlns:")) {
    if (value !== SVG_NAMESPACE && value !== XLINK_NAMESPACE) {
      invalidSvg("namespace declaration is not allowed");
    }
  }
  if (lowerName === "xml:base") invalidSvg("xml:base is not allowed");
  if (lowerName.startsWith("on") || lowerLocalName.startsWith("on")) {
    invalidSvg("event handler attributes are not allowed");
  }
  // ping takes a space-separated URL list and posts to each one on click.
  if (lowerLocalName === "ping") invalidSvg("ping is not allowed");
  if (REFERENCE_ATTRIBUTES.has(lowerLocalName) && !isSameDocumentReference(value)) {
    invalidSvg("only same-document references are allowed");
  }
  if (isProseAttribute(name)) return;
  assertNoActiveContent(value, "attribute value");
}

function assertAllowedElement(tag: StartTag): void {
  if (!ALLOWED_ELEMENTS.has(localName(tag.name).toLowerCase())) {
    invalidSvg("element is not allowed");
  }
  for (const [name, value] of tag.attributes) {
    assertAllowedAttribute(name, value);
  }
}

/**
 * Single forward pass over the decoded document. Every boundary search starts
 * at the current position and the position never moves backward, so the scan
 * is linear in the document length.
 */
class SvgScanner {
  readonly #text: string;
  #position = 0;

  constructor(text: string) {
    this.#text = text;
  }

  scan(): Map<string, string> {
    const text = this.#text;
    this.#skipXmlDeclaration();

    let rootAttributes: Map<string, string> | undefined;
    let rootClosed = false;
    let doctypeSeen = false;
    const openElements: string[] = [];
    // Set while inside a text-only element: its lowercased local name, and for
    // style elements the decoded text and CDATA collected for the CSS checks.
    let textOnly: { name: string; styleText: string[] | undefined } | undefined;

    while (this.#position < text.length) {
      if (text.charCodeAt(this.#position) !== LESS_THAN) {
        const next = text.indexOf("<", this.#position);
        const end = next < 0 ? text.length : next;
        const run = text.slice(this.#position, end);
        this.#position = end;
        if (openElements.length === 0) {
          if (!isAllXmlWhitespace(run)) {
            invalidSvg("content is not allowed outside the root element");
          }
          continue;
        }
        if (run.includes("]]>")) invalidSvg("text contains ]]>");
        const decoded = decodeReferences(run);
        textOnly?.styleText?.push(decoded);
        continue;
      }

      if (text.startsWith("<!--", this.#position)) {
        this.#skipComment();
        continue;
      }
      if (text.startsWith("<![CDATA[", this.#position)) {
        if (openElements.length === 0) {
          invalidSvg("CDATA is only allowed inside the root element");
        }
        const content = this.#readCdata();
        if (textOnly !== undefined) {
          // Defense in depth for inlining into HTML: title and desc are HTML
          // integration points, so "<" is kept out of their CDATA content.
          if (textOnly.styleText === undefined && content.includes("<")) {
            invalidSvg("CDATA in a text-only element must not contain <");
          }
          textOnly.styleText?.push(content);
        }
        continue;
      }
      if (text.startsWith("<!DOCTYPE", this.#position) && rootAttributes === undefined) {
        if (doctypeSeen) invalidSvg("document type declaration must appear at most once");
        this.#skipStandardDoctype();
        doctypeSeen = true;
        continue;
      }
      if (text.startsWith("<!", this.#position)) {
        invalidSvg("markup declarations are not allowed");
      }
      if (text.startsWith("<?", this.#position)) {
        invalidSvg("processing instructions are not allowed");
      }

      if (text.startsWith("</", this.#position)) {
        if (openElements.length === 0) {
          invalidSvg("content is not allowed outside the root element");
        }
        const name = this.#readEndTag();
        if (openElements.pop() !== name) {
          invalidSvg("end tag does not match the open element");
        }
        if (textOnly?.styleText !== undefined) {
          assertNoActiveContent(textOnly.styleText.join(""), "style content");
        }
        textOnly = undefined;
        if (openElements.length === 0) rootClosed = true;
        continue;
      }

      if (rootClosed) invalidSvg("only one root element is allowed");
      if (textOnly !== undefined) invalidSvg(`${textOnly.name} element must contain only text`);
      if (openElements.length >= MAX_ELEMENT_DEPTH) invalidSvg("elements are nested too deeply");
      const tag = this.#readStartTag();
      if (rootAttributes === undefined) {
        if (tag.name !== "svg") {
          invalidSvg("root element must be an unprefixed svg element");
        }
        rootAttributes = tag.attributes;
      }
      assertAllowedElement(tag);
      if (tag.selfClosing) {
        if (openElements.length === 0) rootClosed = true;
        continue;
      }
      openElements.push(tag.name);
      const lowerLocalName = localName(tag.name).toLowerCase();
      if (TEXT_ONLY_ELEMENTS.has(lowerLocalName)) {
        textOnly = {
          name: lowerLocalName,
          styleText: lowerLocalName === "style" ? [] : undefined,
        };
      }
    }

    if (rootAttributes === undefined) invalidSvg("missing root element");
    if (openElements.length > 0) invalidSvg("element is not closed");
    return rootAttributes;
  }

  #skipXmlDeclaration(): void {
    const text = this.#text;
    if (!text.startsWith("<?xml") || !isXmlWhitespace(text.charCodeAt(5))) return;
    const end = text.indexOf("?>", 5);
    if (end < 0 || end - 5 > MAX_XML_DECLARATION_LENGTH) {
      invalidSvg("XML declaration is malformed");
    }
    const match = XML_DECLARATION_PATTERN.exec(text.slice(5, end));
    if (match === null) invalidSvg("XML declaration is malformed");
    const encoding = match[1] ?? match[2];
    if (encoding !== undefined && !UTF8_ENCODING_LABELS.has(encoding.toLowerCase())) {
      invalidSvg("XML declaration must declare UTF-8 encoding");
    }
    this.#position = end + 2;
  }

  /**
   * Accepts one of the two standard SVG document type declarations, compared
   * after collapsing whitespace. Internal subsets and other identifiers are
   * rejected.
   */
  #skipStandardDoctype(): void {
    const text = this.#text;
    const end = text.indexOf(">", this.#position);
    if (
      end < 0 ||
      end - this.#position > MAX_DOCTYPE_LENGTH ||
      !STANDARD_DOCTYPES.has(collapseXmlWhitespace(text.slice(this.#position, end + 1)))
    ) {
      invalidSvg("only the standard SVG 1.0 or 1.1 document type declaration is allowed");
    }
    this.#position = end + 1;
  }

  #skipComment(): void {
    const text = this.#text;
    const bodyStart = this.#position + 4;
    const end = text.indexOf("-->", bodyStart);
    // The HTML parser closes "<!-->" and "<!--->" immediately, so a comment
    // body that starts with ">" or "->" would expose its content when inlined.
    const closesEarlyInHtml =
      text.charCodeAt(bodyStart) === GREATER_THAN || text.startsWith("->", bodyStart);
    // The first "--" must be the one that closes the comment; XML forbids
    // "--" inside a comment and a comment body that ends with "-".
    if (end < 0 || closesEarlyInHtml || text.indexOf("--", bodyStart) !== end) {
      invalidSvg("comment is malformed");
    }
    this.#position = end + 3;
  }

  #readCdata(): string {
    const text = this.#text;
    const contentStart = this.#position + 9;
    const end = text.indexOf("]]>", contentStart);
    if (end < 0) invalidSvg("CDATA section is not terminated");
    this.#position = end + 3;
    return text.slice(contentStart, end);
  }

  #skipWhitespace(): number {
    const start = this.#position;
    while (
      this.#position < this.#text.length &&
      isXmlWhitespace(this.#text.charCodeAt(this.#position))
    ) {
      this.#position += 1;
    }
    return this.#position - start;
  }

  #readName(): string {
    const text = this.#text;
    const start = this.#position;
    while (this.#position < text.length && isNameCharacter(text.charCodeAt(this.#position))) {
      this.#position += 1;
    }
    const name = text.slice(start, this.#position);
    if (!NAME_PATTERN.test(name)) invalidSvg("name is malformed");
    return name;
  }

  #readStartTag(): StartTag {
    const text = this.#text;
    this.#position += 1;
    const name = this.#readName();
    const attributes = new Map<string, string>();

    while (true) {
      const whitespace = this.#skipWhitespace();
      const code = text.charCodeAt(this.#position);
      if (code === GREATER_THAN) {
        this.#position += 1;
        return { name, attributes, selfClosing: false };
      }
      if (code === SLASH) {
        if (text.charCodeAt(this.#position + 1) !== GREATER_THAN) {
          invalidSvg("tag is malformed");
        }
        this.#position += 2;
        return { name, attributes, selfClosing: true };
      }
      if (whitespace === 0) invalidSvg("tag is malformed");

      const attributeName = this.#readName();
      this.#skipWhitespace();
      if (text.charCodeAt(this.#position) !== EQUALS) invalidSvg("tag is malformed");
      this.#position += 1;
      this.#skipWhitespace();
      const quote = text.charCodeAt(this.#position);
      if (quote !== DOUBLE_QUOTE && quote !== APOSTROPHE) {
        invalidSvg("attribute value must be quoted");
      }
      const valueStart = this.#position + 1;
      const valueEnd = text.indexOf(quote === DOUBLE_QUOTE ? '"' : "'", valueStart);
      if (valueEnd < 0) invalidSvg("tag is malformed");
      const raw = text.slice(valueStart, valueEnd);
      if (raw.includes("<")) invalidSvg("attribute value contains a raw less-than sign");
      if (attributes.has(attributeName)) invalidSvg("duplicate attribute");
      attributes.set(attributeName, decodeReferences(raw));
      this.#position = valueEnd + 1;
    }
  }

  #readEndTag(): string {
    this.#position += 2;
    const name = this.#readName();
    this.#skipWhitespace();
    if (this.#text.charCodeAt(this.#position) !== GREATER_THAN) {
      invalidSvg("tag is malformed");
    }
    this.#position += 1;
    return name;
  }
}

function parseLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = trimXmlWhitespace(value);
  if (trimmed.length > MAX_LENGTH_VALUE_LENGTH || !LENGTH_PATTERN.test(trimmed)) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  return Number(lower.endsWith("px") ? lower.slice(0, -2) : lower);
}

function parseViewBoxSize(value: string | undefined): [number, number] | undefined {
  if (value === undefined) return undefined;
  const trimmed = trimXmlWhitespace(value);
  if (trimmed.length === 0 || trimmed.length > MAX_VIEW_BOX_LENGTH) return undefined;
  const parts = trimmed.split(/[ \t\r\n,]+/);
  if (parts.length !== 4 || !parts.every((part) => NUMBER_PATTERN.test(part))) {
    return undefined;
  }
  return [Number(parts[2]), Number(parts[3])];
}

function toPixels(value: number): number {
  if (!Number.isFinite(value)) invalidSvg("dimensions are not finite");
  const rounded = Math.max(1, Math.round(value));
  if (!Number.isSafeInteger(rounded)) invalidSvg("dimensions exceed the supported range");
  return rounded;
}

function svgDimensions(attributes: Map<string, string>): { width: number; height: number } {
  const width = parseLength(attributes.get("width"));
  const height = parseLength(attributes.get("height"));
  if (width !== undefined && height !== undefined) {
    return { width: toPixels(width), height: toPixels(height) };
  }
  const viewBox = parseViewBoxSize(attributes.get("viewBox"));
  if (viewBox !== undefined) {
    return { width: toPixels(viewBox[0]), height: toPixels(viewBox[1]) };
  }
  return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

/**
 * Validates provider SVG output as a self-contained, script-free document and
 * reports its intrinsic size. Dimensions come from the root width and height,
 * then the viewBox, then the CSS default of 300x150.
 */
export function inspectSvg(bytes: Uint8Array): OutputImageInfo {
  if (bytes.byteLength > MAX_SVG_BYTES) invalidSvg("document exceeds the byte limit");

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalidSvg("content is not valid UTF-8");
  }
  assertAllowedCharacters(text);

  const rootAttributes = new SvgScanner(text).scan();
  const { width, height } = svgDimensions(rootAttributes);
  return {
    format: "svg",
    mimeType: "image/svg+xml",
    width,
    height,
    hasAlpha: true,
  };
}
