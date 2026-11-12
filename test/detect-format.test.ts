import assert from "node:assert/strict";
import test from "node:test";
import { detectOutputImageFormat } from "../src/images/detect-format.ts";
import { PNG_SIGNATURE } from "../src/images/png.ts";
import type { OutputImageFormat } from "../src/images/types.ts";
import {
  makeBaselineJpeg,
  makeGif,
  makeLosslessWebP,
  makeLossyWebP,
  makePng,
  makeProgressiveJpeg,
  makeSvg,
} from "./helpers/image-fixtures.ts";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

function text(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

/** A comment of exactly `length` bytes. */
function comment(length: number): Buffer {
  return text(`<!--${"x".repeat(length - 7)}-->`);
}

function assertDetects(
  cases: ReadonlyArray<readonly [string, Uint8Array, OutputImageFormat | undefined]>,
): void {
  for (const [label, bytes, expected] of cases) {
    assert.equal(detectOutputImageFormat(bytes), expected, label);
  }
}

test("detectOutputImageFormat recognizes each output format by its signature", () => {
  assertDetects([
    ["png", makePng(), "png"],
    ["png signature only", PNG_SIGNATURE, "png"],
    ["baseline jpeg", makeBaselineJpeg(), "jpeg"],
    ["progressive jpeg", makeProgressiveJpeg(), "jpeg"],
    ["jpeg signature only", Buffer.from([0xff, 0xd8, 0xff]), "jpeg"],
    ["lossy webp", makeLossyWebP(), "webp"],
    ["lossless webp", makeLosslessWebP(), "webp"],
    ["webp header only", text("RIFF\0\0\0\0WEBP"), "webp"],
    ["GIF89a", makeGif(), "gif"],
    ["GIF87a", makeGif({ version: "87a" }), "gif"],
    ["GIF89a signature only", text("GIF89a"), "gif"],
    ["GIF87a signature only", text("GIF87a"), "gif"],
    ["svg", makeSvg(), "svg"],
  ]);
});

test("detectOutputImageFormat sniffs signatures without decoding the payload", () => {
  assertDetects([
    ["truncated png", makePng().subarray(0, 20), "png"],
    ["truncated gif", makeGif({ frames: 2 }).subarray(0, -1), "gif"],
    ["script svg", makeSvg("<script>alert(1)</script>"), "svg"],
    [
      "webp with a corrupt body",
      Buffer.concat([text("RIFF\0\0\0\0WEBP"), Buffer.alloc(32, 0xaa)]),
      "webp",
    ],
  ]);
});

test("detectOutputImageFormat accepts an svg root followed by whitespace, > or /", () => {
  assertDetects([
    ["<svg>", text("<svg></svg>"), "svg"],
    ["<svg/>", text("<svg/>"), "svg"],
    ["<svg space", makeSvg(), "svg"],
    ["<svg tab", text('<svg\twidth="1"/>'), "svg"],
    ["<svg newline", text('<svg\nwidth="1"/>'), "svg"],
  ]);
});

test("detectOutputImageFormat skips a BOM, whitespace, and prolog constructs before the svg root", () => {
  const doctypeWithSubset = text(
    '<!DOCTYPE svg [\n  <!ENTITY accent "#f80">\n  <!ATTLIST svg role CDATA "img">\n]>',
  );
  assertDetects([
    ["bom", Buffer.concat([UTF8_BOM, text("<svg>")]), "svg"],
    ["leading whitespace", Buffer.concat([text(" \t\r\n\f "), text("<svg/>")]), "svg"],
    ["xml declaration", Buffer.concat([text(XML_DECLARATION), makeSvg()]), "svg"],
    [
      "processing instruction",
      text('<?xml-stylesheet type="text/css" href="style.css"?>\n<svg/>'),
      "svg",
    ],
    ["comment", text("<!-- generated vector -->\n<svg>"), "svg"],
    ["comments", text("<!-- one --><!----> \n<!-- <svg-icon> -->\n<svg/>"), "svg"],
    ["doctype", text("<!DOCTYPE svg>\n<svg>"), "svg"],
    ["lowercase doctype", text("<!doctype svg><svg/>"), "svg"],
    ["doctype with an internal subset", Buffer.concat([doctypeWithSubset, makeSvg()]), "svg"],
    [
      "internal subset closed by ] whitespace >",
      text('<!DOCTYPE svg [ <!ENTITY a "x"> ] \n><svg/>'),
      "svg",
    ],
    [
      "internal subset containing ] before its end",
      text('<!DOCTYPE svg [ <!ENTITY a "x]y"> ]><svg/>'),
      "svg",
    ],
    [
      "bom, whitespace, declaration, comment, doctype, and comment",
      Buffer.concat([
        UTF8_BOM,
        text("\n  "),
        text(XML_DECLARATION),
        text("\n<!-- generated -->\n"),
        doctypeWithSubset,
        text("\n<!-- root follows -->\n"),
        makeSvg(),
      ]),
      "svg",
    ],
  ]);
});

test("detectOutputImageFormat requires the first element to be the svg root", () => {
  assertDetects([
    [
      "html page with an inline svg",
      text('<!DOCTYPE html><html><body><svg width="1" height="1"></svg></body></html>'),
      undefined,
    ],
    [
      "html error page with an inline svg",
      text("<html><head><title>502 Bad Gateway</title></head><body><svg/></body></html>"),
      undefined,
    ],
    ["svg-icon inside a div", text("<div><svg-icon></svg-icon></div>"), undefined],
    [
      "xml note after a comment that mentions <svg",
      text('<?xml version="1.0"?><!-- no <svg here --><note/>'),
      undefined,
    ],
    ["svg-icon root", text("<svg-icon></svg-icon>"), undefined],
    ["prefixed svg:svg root", text("<svg:svg></svg:svg>"), undefined],
    ["<svg without a delimiter", text("<svg"), undefined],
    ["cdata before the svg root", text("<![CDATA[x]]><svg/>"), undefined],
    ["xml without svg", text('<?xml version="1.0"?><note><to>user</to></note>'), undefined],
    [
      "html error page",
      text("<!DOCTYPE html><html><head><title>Bad Gateway</title></head><body>502</body></html>"),
      undefined,
    ],
    ["json error body", text('{"error":{"message":"unsupported output format"}}'), undefined],
    ["text before the svg element", text("vector: <svg></svg>"), undefined],
    ["whitespace before the bom", Buffer.concat([text(" "), UTF8_BOM, makeSvg()]), undefined],
  ]);
});

test("detectOutputImageFormat rejects prolog constructs that do not end", () => {
  assertDetects([
    ["unterminated comment", text("<!-- never closed <svg/>"), undefined],
    ["unterminated declaration", text('<?xml version="1.0" <svg/>'), undefined],
    ["unterminated doctype", text("<!DOCTYPE svg"), undefined],
    [
      "unterminated internal subset",
      text('<!DOCTYPE svg [ <!ENTITY a "b"> <svg/>'),
      undefined,
    ],
  ]);
});

test("detectOutputImageFormat looks only at the first 1024 bytes", () => {
  const rootInside = Buffer.concat([comment(1019), text("<svg/>")]);
  const rootCrossing = Buffer.concat([comment(1020), text("<svg/>")]);
  assert.equal(rootInside.indexOf("<svg"), 1019);
  assert.equal(rootCrossing.indexOf("<svg"), 1020);
  const commentCrossing = Buffer.concat([
    text(`<!--${"x".repeat(1018)}-`),
    text("-><svg/>"),
  ]);
  assert.equal(commentCrossing.indexOf("-->"), 1022);
  assertDetects([
    ["root and delimiter end at byte 1024", rootInside, "svg"],
    ["delimiter at byte 1025", rootCrossing, undefined],
    ["comment ending after byte 1024", commentCrossing, undefined],
    ["comment far beyond the window", Buffer.concat([comment(4096), makeSvg()]), undefined],
    ["whitespace up to byte 1019", Buffer.concat([Buffer.alloc(1019, 0x20), text("<svg/>")]), "svg"],
    ["whitespace up to byte 1020", Buffer.concat([Buffer.alloc(1020, 0x20), text("<svg/>")]), undefined],
  ]);
});

test("detectOutputImageFormat returns undefined for a large all-whitespace payload", () => {
  const whitespace = Buffer.alloc(16 * 1024 * 1024, 0x20);
  assertDetects([
    ["all whitespace", whitespace, undefined],
    ["svg after the whitespace", Buffer.concat([whitespace, makeSvg()]), undefined],
  ]);
});

test("detectOutputImageFormat returns undefined for empty input and truncated signatures", () => {
  const cases: Array<readonly [string, Uint8Array, undefined]> = [
    ["empty", new Uint8Array(0), undefined],
    ["jpeg prefix", Buffer.from([0xff, 0xd8]), undefined],
    ["jpeg marker without signature", Buffer.from([0xff, 0xd8, 0x00, 0xff]), undefined],
    ["gif prefix", text("GIF8"), undefined],
    ["gif version prefix", text("GIF89"), undefined],
    ["unknown gif version", text("GIF88a"), undefined],
    ["riff without webp", text("RIFF\0\0\0\0WAVE"), undefined],
    ["lone angle bracket", text("<"), undefined],
    ["svg prefix", text("<sv"), undefined],
  ];
  const webp = makeLossyWebP();
  for (let length = 1; length <= 11; length += 1) {
    cases.push([`webp prefix ${length}`, webp.subarray(0, length), undefined]);
  }
  for (let length = 1; length < PNG_SIGNATURE.length; length += 1) {
    cases.push([`png prefix ${length}`, PNG_SIGNATURE.subarray(0, length), undefined]);
  }
  assertDetects(cases);
});

test("detectOutputImageFormat returns undefined for random bytes without throwing", () => {
  // A fixed-seed xorshift32 keeps the samples deterministic.
  let state = 0x9e3779b9;
  const nextByte = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state & 0xff;
  };
  for (let sample = 0; sample < 64; sample += 1) {
    const bytes = new Uint8Array(sample * 37);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = nextByte();
    }
    assert.equal(detectOutputImageFormat(bytes), undefined, `sample ${sample}`);
  }
});

test("detectOutputImageFormat reads plain Uint8Array views at their own offset", () => {
  const backing = Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), makePng()]);
  const view = new Uint8Array(backing.buffer, backing.byteOffset + 3, backing.length - 3);
  assert.equal(detectOutputImageFormat(view), "png");
  assert.equal(detectOutputImageFormat(new Uint8Array(makeSvg())), "svg");
  assert.equal(
    detectOutputImageFormat(new Uint8Array(backing.buffer, backing.byteOffset, 3)),
    undefined,
  );
});
