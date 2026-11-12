import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/errors.ts";
import { inspectOutputImage } from "../src/images/inspect-output.ts";
import { inspectSvg } from "../src/images/svg.ts";
import { MAX_SVG_BYTES } from "../src/images/types.ts";
import { makePng, makeSvg } from "./helpers/image-fixtures.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XHTML_NS = "http://www.w3.org/1999/xhtml";
const XLINK_DECLARATION = `xmlns:xlink="${XLINK_NS}"`;
const SIZE = 'width="64" height="32"';

function svgInfo(width: number, height: number) {
  return {
    format: "svg",
    mimeType: "image/svg+xml",
    width,
    height,
    hasAlpha: true,
  };
}

function isInputImageError(error: unknown): boolean {
  return error instanceof AppError && error.code === "INPUT_FILE_INVALID";
}

function rejectsSvg(document: string | Uint8Array, pattern: RegExp): void {
  const bytes = typeof document === "string" ? Buffer.from(document, "utf8") : document;
  assert.throws(
    () => inspectSvg(bytes),
    (error: unknown) => {
      if (!isInputImageError(error)) return false;
      const message = (error as AppError).message;
      assert.match(message, /^INPUT_FILE_INVALID: Invalid SVG: /);
      assert.match(message, pattern, typeof document === "string" ? document : "binary fixture");
      return true;
    },
    typeof document === "string" ? document : "binary fixture",
  );
}

function rejectsBody(body: string, pattern: RegExp, rootAttributes = SIZE): void {
  rejectsSvg(makeSvg(body, rootAttributes), pattern);
}

function swapCase(value: string): string {
  return [...value]
    .map((character) =>
      character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase(),
    )
    .join("");
}

const EXTERNAL_REFERENCE = /only same-document references are allowed/;

test("inspectSvg reports explicit root dimensions", () => {
  assert.deepEqual(inspectSvg(makeSvg()), svgInfo(64, 32));
  assert.deepEqual(inspectSvg(makeSvg("", 'width="64px" height="32.4"')), svgInfo(64, 32));
  assert.deepEqual(inspectSvg(makeSvg("", 'width=" 1e2 " height="2.5PX"')), svgInfo(100, 3));
  assert.deepEqual(inspectSvg(makeSvg("", 'width="0" height=".2"')), svgInfo(1, 1));
});

test("inspectSvg falls back to the viewBox size", () => {
  assert.deepEqual(
    inspectSvg(makeSvg("", 'width="100%" viewBox="0 0 200 100"')),
    svgInfo(200, 100),
  );
  assert.deepEqual(
    inspectSvg(makeSvg("", 'width="10em" height="5" viewBox="-10,-10, 120.6,80"')),
    svgInfo(121, 80),
  );
  assert.deepEqual(inspectSvg(makeSvg("", 'viewBox="0 0 -5 0"')), svgInfo(1, 1));
});

test("inspectSvg uses the CSS default size without size information", () => {
  assert.deepEqual(inspectSvg(makeSvg("", "")), svgInfo(300, 150));
  assert.deepEqual(inspectSvg(makeSvg("", 'viewBox="0 0 10"')), svgInfo(300, 150));
});

test("inspectSvg rejects non-finite or out-of-range dimensions", () => {
  rejectsSvg(makeSvg("", 'width="1e999" height="1"'), /not finite/);
  rejectsSvg(makeSvg("", 'viewBox="0 0 1e999 1"'), /not finite/);
  rejectsSvg(makeSvg("", 'width="1e300" height="1"'), /supported range/);
});

test("inspectSvg accepts typical generated SVG constructs", () => {
  const document = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    "<!-- generated -->",
    `<svg xmlns="${SVG_NS}" ${XLINK_DECLARATION} width="640" height="480" viewBox="0 0 320 240">`,
    "  <title>Sample &amp; test</title>",
    "  <desc>A &lt;sample&gt; with &quot;entities&quot; &apos;here&apos; &#65;&#x42;</desc>",
    "  <defs>",
    '    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
    '      <stop offset="0%" stop-color="#fff"/>',
    "      <stop offset='100%' stop-color='#000' stop-opacity='0.5'/>",
    "    </linearGradient>",
    '    <clipPath id="c"><rect width="10" height="10"/></clipPath>',
    '    <filter id="f"><feGaussianBlur stdDeviation="2"/></filter>',
    '    <style type="text/css">.a { fill: url(#g); font-family: "Inter", sans-serif; }</style>',
    "    <style><![CDATA[ .b > .c { stroke: url( '#g' ); } ]]></style>",
    '    <path id="p" d="M0 0L10 10Z"/>',
    "  </defs>",
    "  <!-- body -->",
    '  <g clip-path="url(#c)" filter="url(\'#f\')" style="fill: url( &quot;#g&quot; )">',
    '    <rect class="a" x="1" y="2" width="3" height="4" fill="url(&#35;g)"/>',
    '    <use href="#p" x="5"/>',
    '    <use xlink:href="#p" y="5"/>',
    '    <a href="#p"><text x="1" y="2" xml:space="preserve">A &amp; B &lt;3 javascript: text</text></a>',
    "    <text><![CDATA[ <script> is just text here ]]></text>",
    '    <svg x="10" y="10" width="20" height="20" viewBox="0 0 2 2"><circle cx="1" cy="1" r="1"/></svg>',
    "  </g>",
    "</svg>",
    "<!-- trailing comment -->",
    "",
  ].join("\n");
  assert.deepEqual(inspectSvg(Buffer.from(document, "utf8")), svgInfo(640, 480));
});

test("inspectSvg accepts a BOM, an XML declaration, and an empty root", () => {
  const document = `\uFEFF<?xml version='1.0' encoding='utf-8'?><svg xmlns="${SVG_NS}" ${SIZE}/>`;
  assert.deepEqual(inspectSvg(Buffer.from(document, "utf8")), svgInfo(64, 32));
});

test("inspectSvg accepts nested svg elements and same-document references", () => {
  assert.deepEqual(
    inspectSvg(
      makeSvg(
        `<svg ${SIZE}><g id="a"/></svg><use href="  #a  "/><use xlink:href="#a"/><a href="#a">x</a>`,
        `${SIZE} ${XLINK_DECLARATION}`,
      ),
    ),
    svgInfo(64, 32),
  );
});

test("inspectSvg rejects script elements in any case or namespace prefix", () => {
  rejectsBody("<script>alert(1)</script>", /element is not allowed/);
  rejectsBody("<SCRIPT>alert(1)</SCRIPT>", /element is not allowed/);
  rejectsBody(
    `<x:script xmlns:x="${XHTML_NS}">alert(1)</x:script>`,
    /element is not allowed|namespace declaration is not allowed/,
  );
  rejectsBody(`<x:script xmlns:x="${SVG_NS}">alert(1)</x:script>`, /element is not allowed/);
});

test("inspectSvg rejects every element outside the static allow-list in any case or prefix", () => {
  const denied = [
    // Active, fetching, or animating SVG elements.
    "script",
    "foreignObject",
    "image",
    "feImage",
    "animate",
    "animateMotion",
    "animateTransform",
    "animateColor",
    "set",
    "discard",
    "handler",
    "listener",
    "mpath",
    "tref",
    "cursor",
    "color-profile",
    "font",
    "font-face",
    "font-face-uri",
    "font-face-src",
    "glyph",
    "missing-glyph",
    "altGlyph",
    "prefetch",
    // HTML names, including HTML-parser breakout and raw-text elements.
    "iframe",
    "embed",
    "object",
    "audio",
    "video",
    "canvas",
    "link",
    "meta",
    "base",
    "p",
    "img",
    "div",
    "span",
    "table",
    "textarea",
    "noscript",
    "math",
    "html",
    "body",
    "include",
  ];
  for (const name of denied) {
    rejectsBody(`<${name}/>`, /element is not allowed/);
    rejectsBody(`<${name.toUpperCase()}/>`, /element is not allowed/);
    rejectsBody(`<${swapCase(name)}></${swapCase(name)}>`, /element is not allowed/);
    rejectsBody(`<s:${name} xmlns:s="${SVG_NS}"/>`, /element is not allowed/);
  }
});

test("inspectSvg accepts every static SVG element on the allow-list", () => {
  const allowed = [
    "svg", "g", "defs", "symbol", "use", "switch", "a", "view", "path", "rect", "circle",
    "ellipse", "line", "polyline", "polygon", "text", "tspan", "textPath", "title", "desc",
    "metadata", "style", "linearGradient", "radialGradient", "stop", "pattern", "clipPath",
    "mask", "marker", "filter", "feBlend", "feColorMatrix", "feComponentTransfer",
    "feComposite", "feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap",
    "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR",
    "feGaussianBlur", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight",
    "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence",
  ];
  assert.equal(allowed.length, 54);
  for (const name of allowed) {
    assert.deepEqual(inspectSvg(makeSvg(`<${name}/>`)), svgInfo(64, 32), name);
    assert.deepEqual(
      inspectSvg(makeSvg(`<${swapCase(name)}></${swapCase(name)}>`)),
      svgInfo(64, 32),
      swapCase(name),
    );
    assert.deepEqual(
      inspectSvg(makeSvg(`<s:${name} xmlns:s="${SVG_NS}"/>`)),
      svgInfo(64, 32),
      `s:${name}`,
    );
  }
});

test("inspectSvg rejects markup that runs script when the SVG is inlined into HTML", () => {
  const cases = [
    // HTML ends a comment at "<!-->" and "<!--->".
    ["<!--><script>alert(1)</script>-->", /comment is malformed/],
    ["<!---><script>alert(1)</script>-->", /comment is malformed/],
    // An HTML element name breaks out of SVG parsing; CDATA then becomes a bogus comment.
    ["<p/><![CDATA[><img src=x onerror=alert(1)>]]>", /element is not allowed/],
    // title and desc are HTML integration points, so their children parse as HTML.
    ["<desc><style><!--</style><img src=x onerror=alert(1)>--></style></desc>", /desc element must contain only text/],
    ["<desc><style><![CDATA[</style><img src=x onerror=alert(1)>]]></style></desc>", /desc element must contain only text/],
    ["<desc><textarea><![CDATA[</textarea><img src=x onerror=alert(1)>]]></textarea></desc>", /desc element must contain only text/],
    ['<g><img src="#" srcset="https://example.test/pixel.png 1x"/></g>', /element is not allowed/],
    ['<title><img src="#" srcset="https://example.test/pixel.png"/></title>', /title element must contain only text/],
    ['<p/><table background="https://example.test/pixel.png"/>', /element is not allowed/],
  ] as const;
  for (const [body, pattern] of cases) {
    rejectsBody(body, pattern);
  }
});

test("inspectSvg keeps title, desc, and metadata text-only", () => {
  for (const name of ["title", "desc", "metadata", "TITLE", "s:desc"]) {
    const declaration = name.startsWith("s:") ? ` xmlns:s="${SVG_NS}"` : "";
    rejectsBody(`<${name}${declaration}><tspan>x</tspan></${name}>`, /element must contain only text/);
    rejectsBody(`<${name}${declaration}><g/></${name}>`, /element must contain only text/);
    rejectsBody(
      `<${name}${declaration}><![CDATA[a <b> c]]></${name}>`,
      /CDATA in a text-only element must not contain </,
    );
    assert.deepEqual(
      inspectSvg(
        makeSvg(
          `<${name}${declaration}>Plain &lt;text&gt; &amp; <!-- note --><![CDATA[ a > b & c ]]></${name}>`,
        ),
      ),
      svgInfo(64, 32),
      name,
    );
  }
  assert.deepEqual(
    inspectSvg(makeSvg("<style><![CDATA[ a < b {} ]]></style><text><![CDATA[<b>]]></text>")),
    svgInfo(64, 32),
  );
});

test("inspectSvg rejects comments that HTML closes early", () => {
  rejectsBody("<!-->-->", /comment is malformed/);
  rejectsBody("<!--->-->", /comment is malformed/);
  rejectsSvg(`<!-->-->${makeSvg().toString("utf8")}`, /comment is malformed/);
  rejectsSvg(`${makeSvg().toString("utf8")}<!--->x-->`, /comment is malformed/);
  assert.deepEqual(inspectSvg(makeSvg("<!---->")), svgInfo(64, 32));
  assert.deepEqual(inspectSvg(makeSvg("<!-- > -> -->")), svgInfo(64, 32));
});

test("inspectSvg accepts realistic generated SVG samples", () => {
  const ns = `xmlns="${SVG_NS}"`;
  const samples: Array<[string, string, number, number]> = [
    [
      "typical logo",
      `<svg ${ns} viewBox="0 0 512 512" width="512" height="512" role="img" aria-labelledby="t d">
  <title id="t">Field &amp; Flour bakery logo</title>
  <desc id="d">A wheat stalk inside a circle</desc>
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#f6d365"/>
      <stop offset="100%" stop-color="#fda085" stop-opacity="0.9"/>
    </linearGradient>
    <clipPath id="c"><circle cx="256" cy="256" r="200"/></clipPath>
    <filter id="blur"><feGaussianBlur stdDeviation="2"/></filter>
  </defs>
  <style>
    .a { fill: url(#g); stroke: #333; stroke-width: 4px; font-family: "Helvetica Neue", Arial, sans-serif; }
    text { font-size: 32px; letter-spacing: .05em }
  </style>
  <g clip-path="url(#c)" filter="url(#blur)">
    <rect class="a" width="512" height="512" rx="24"/>
    <path d="M10 10 C 20 20, 40 20, 50 10 S 80 0 90 10 Z" fill="none" stroke="rgba(0,0,0,.5)" transform="translate(10,20) rotate(45 50 50)"/>
  </g>
  <use href="#t" x="1"/>
  <text x="256" y="480" text-anchor="middle">Field &amp; Flour — est. 1987</text>
</svg>`,
      512,
      512,
    ],
    ["XML declaration without encoding", `<?xml version="1.0"?>\n<svg ${ns} viewBox="0 0 10 10"/>`, 10, 10],
    [
      "XML declaration with UTF-8 and standalone",
      `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<svg ${ns} viewBox="0 0 10 10"/>`,
      10,
      10,
    ],
    ["BOM and XML declaration", `\uFEFF<?xml version="1.0" encoding="utf-8"?><svg ${ns}/>`, 300, 150],
    [
      "Chinese text and attribute values",
      `<svg ${ns} viewBox="0 0 100 50" aria-label="面包店标志"><text x="5" y="30" font-family="微软雅黑, 'PingFang SC'">田野与面粉 🍞</text></svg>`,
      100,
      50,
    ],
    [
      "aria-label prose",
      `<svg ${ns} viewBox="0 0 10 10" aria-label="JavaScript: The Good Parts"><g aria-label="expression (happy)"/></svg>`,
      10,
      10,
    ],
    ["title prose", `<svg ${ns} viewBox="0 0 10 10"><title>JavaScript: basics</title></svg>`, 10, 10],
    [
      "XLink fragment reference",
      `<svg ${ns} ${XLINK_DECLARATION} viewBox="0 0 10 10"><defs><path id="p" d="M0 0L1 1"/></defs><use xlink:href="#p"/></svg>`,
      10,
      10,
    ],
    ["style CDATA", `<svg ${ns} viewBox="0 0 10 10"><style><![CDATA[ .x{fill:red} ]]></style></svg>`, 10, 10],
    [
      "inline style attribute",
      `<svg ${ns} viewBox="0 0 10 10"><rect style="fill:#fff;stroke:url(#g)" width="1" height="1"/></svg>`,
      10,
      10,
    ],
    [
      "version and xml attributes",
      `<svg ${ns} version="1.1" baseProfile="full" xml:space="preserve" xml:lang="en" viewBox="0 0 10 10"/>`,
      10,
      10,
    ],
    ["em size falls back to viewBox", `<svg ${ns} width="10em" height="5em" viewBox="0 0 40 20"/>`, 40, 20],
    ["numeric references", `<svg ${ns} viewBox="0 0 10 10"><text>&#169; 2026 &#x2014; &#x1F35E; ok</text></svg>`, 10, 10],
    ["comments around root", `<!-- generated -->\n<svg ${ns} viewBox="0 0 10 10"/>\n<!-- end -->\n`, 10, 10],
    [
      "nested svg",
      `<svg ${ns} viewBox="0 0 10 10"><svg x="1" y="1" width="2" height="2"><rect width="1" height="1"/></svg></svg>`,
      10,
      10,
    ],
    [
      "textPath",
      `<svg ${ns} viewBox="0 0 10 10"><path id="p" d="M0 5H10"/><text><textPath href="#p">hi</textPath></text></svg>`,
      10,
      10,
    ],
  ];
  for (const [name, document, width, height] of samples) {
    assert.deepEqual(inspectSvg(Buffer.from(document, "utf8")), svgInfo(width, height), name);
  }
});

test("inspectSvg rejects foreignObject and embedded images", () => {
  rejectsBody(
    "<foreignObject width=\"10\" height=\"10\"><div>x</div></foreignObject>",
    /element is not allowed/,
  );
  rejectsBody('<image href="data:image/png;base64,AAAA"/>', /element is not allowed/);
});

test("inspectSvg rejects SMIL animation of references", () => {
  rejectsBody('<animate attributeName="href" values="#a;#b" dur="1s"/>', /element is not allowed/);
  rejectsBody('<set attributeName="href" to="#b"/>', /element is not allowed/);
});

test("inspectSvg rejects event handler attributes", () => {
  rejectsSvg(makeSvg("", `${SIZE} onload="x()"`), /event handler/);
  rejectsBody('<rect ONLOAD="x()"/>', /event handler/);
  rejectsBody("<rect OnClick='x()'/>", /event handler/);
  rejectsBody(`<rect s:onclick="x()" xmlns:s="${SVG_NS}"/>`, /event handler/);
  rejectsBody(`<rect xlink:onmouseover="x()"/>`, /event handler/, `${SIZE} ${XLINK_DECLARATION}`);
});

test("inspectSvg rejects external and script references", () => {
  rejectsBody('<a href="https://example.test/">x</a>', EXTERNAL_REFERENCE);
  rejectsBody("<a href='https://example.test/'>x</a>", EXTERNAL_REFERENCE);
  rejectsBody('<a HREF="https://example.test/">x</a>', EXTERNAL_REFERENCE);
  rejectsBody('<a href="&#106;avascript:alert(1)">x</a>', EXTERNAL_REFERENCE);
  rejectsBody(
    '<a xlink:href="java&#x9;script:alert(1)">x</a>',
    EXTERNAL_REFERENCE,
    `${SIZE} ${XLINK_DECLARATION}`,
  );
  rejectsBody(
    '<use xlink:HREF="https://example.test/x.svg#a"/>',
    EXTERNAL_REFERENCE,
    `${SIZE} ${XLINK_DECLARATION}`,
  );
  rejectsBody('<use href="other.svg#a"/>', EXTERNAL_REFERENCE);
  rejectsBody('<use href=""/>', EXTERNAL_REFERENCE);
  rejectsBody('<use href="\u00A0#a"/>', EXTERNAL_REFERENCE);
  rejectsBody('<g src="https://example.test/x"/>', EXTERNAL_REFERENCE);
  // A leading U+FEFF must survive decoding; it is not a byte order mark here.
  rejectsBody('<use href="&#xFEFF;#a"/>', EXTERNAL_REFERENCE);
  rejectsBody('<rect fill="url(&#xFEFF;#g)"/>', /external url\(\) reference/);
  rejectsBody("<style>&#xFEFF;rect { fill: url(&#xFEFF;#g) }</style>", /external url\(\) reference/);
  // ping takes a list of URLs and posts to each on click, so it is never allowed.
  rejectsBody('<a href="#a" ping="https://example.test/p">x</a>', /ping is not allowed/);
  rejectsBody('<a href="#a" ping="#a https://example.test/p">x</a>', /ping is not allowed/);
  rejectsBody('<a href="#a" PING="#a">x</a>', /ping is not allowed/);
});

test("inspectSvg rejects script URLs and CSS escapes in any attribute value", () => {
  rejectsBody('<rect fill="javascript:alert(1)"/>', /script URL/);
  rejectsBody('<rect class="VB&#x0A;Script:x"/>', /script URL/);
  rejectsBody(String.raw`<rect fill="u\72l(https://example.test/x)"/>`, /CSS escape/);
  rejectsBody(String.raw`<rect style="fill:u\72l(https://example.test/x)"/>`, /CSS escape/);
});

test("inspectSvg rejects external url() references in attributes", () => {
  rejectsBody('<rect style="fill:url(https://example.test/x)"/>', /external url\(\) reference/);
  rejectsBody(`<rect style='fill:url( "https://example.test/x" )'/>`, /external url\(\) reference/);
  rejectsBody('<rect fill="URL(https://example.test/x)"/>', /external url\(\) reference/);
  rejectsBody(`<rect fill="url('https://example.test/x')"/>`, /external url\(\) reference/);
  rejectsBody('<rect filter="url(#f) url(https://example.test/x)"/>', /external url\(\) reference/);
  rejectsBody('<rect fill="u&#114;l(https://example.test/x)"/>', /external url\(\) reference/);
  rejectsBody('<rect fill="url(data:image/png;base64,AAAA)"/>', /external url\(\) reference/);
  rejectsBody(
    `<rect style="mask-image:image-set('https://example.test/x.png' 1x)"/>`,
    /image-set\(\) reference/,
  );
});

test("inspectSvg rejects url() targets hidden behind characters CSS does not strip", () => {
  for (const hidden of ["\u00A0", "\u3000", "\uFEFF", "\u0085", "&#xA0;"]) {
    rejectsBody(`<rect fill="url(${hidden}#g)"/>`, /external url\(\) reference/);
    rejectsBody(`<rect fill="url('${hidden}#g')"/>`, /external url\(\) reference/);
    rejectsBody(`<rect style="fill:url( &quot;${hidden}#g&quot; )"/>`, /external url\(\) reference/);
    rejectsBody(`<style>rect { fill: url(${hidden}#g) }</style>`, /external url\(\) reference/);
  }
});

test("inspectSvg accepts url() fragment targets after CSS whitespace", () => {
  assert.deepEqual(
    inspectSvg(
      makeSvg(
        `<rect fill="url( '#g' )" stroke="url(&#9;#g)" style="fill:url(\n&quot;#g&quot;\t)"/>` +
          "<style>rect { fill: url(\r\n'#g' ) }</style>",
      ),
    ),
    svgInfo(64, 32),
  );
});

test("inspectSvg rejects xml:base", () => {
  rejectsBody('<g xml:base="https://example.test/"><use href="#a"/></g>', /xml:base/);
  rejectsSvg(makeSvg("", `${SIZE} XML:BASE="https://example.test/"`), /xml:base/);
});

test("inspectSvg skips value-content checks for aria-*, data-*, and xlink:title prose", () => {
  assert.deepEqual(
    inspectSvg(
      makeSvg(
        [
          '<g aria-label="JavaScript: The Good Parts"/>',
          '<g aria-label="expression (happy)"/>',
          String.raw`<g aria-label="Folder C:\Users"/>`,
          '<g data-note="see url (docs)"/>',
          '<g DATA-Note="@import notes; image-set( src(x) image(y)"/>',
          '<a href="#a" xlink:title="JavaScript: intro">x</a>',
        ].join(""),
        `${SIZE} ${XLINK_DECLARATION}`,
      ),
    ),
    svgInfo(64, 32),
  );

  // Name rules still apply to exempt-looking attributes.
  rejectsBody('<g data-x:href="javascript:alert(1)"/>', EXTERNAL_REFERENCE);
  rejectsBody('<g aria-x:onload="x()"/>', /event handler/);
  rejectsBody('<g data-x="1" xmlns:data-x="http://www.w3.org/1999/xhtml"/>', /namespace declaration/);
  rejectsBody('<g aria-label="x" xml:base="https://example.test/"/>', /xml:base/);
  rejectsBody('<g x:aria-label="javascript:alert(1)" xmlns:x="http://www.w3.org/2000/svg"/>', /script URL/);
  rejectsBody('<g aria-="javascript:alert(1)"/>', /script URL/);
  rejectsBody('<rect fill="url(https://example.test/x)"/>', /external url\(\) reference/);
  rejectsBody('<rect title="javascript:alert(1)"/>', /script URL/);
});

test("inspectSvg no longer treats expression() as active content", () => {
  assert.deepEqual(
    inspectSvg(
      makeSvg('<rect style="width:expression(1)"/><style>rect { width: expression(1) }</style>'),
    ),
    svgInfo(64, 32),
  );
});

test("inspectSvg rejects src() and image() CSS fetch functions", () => {
  const fetchFunction = /image\(\) or src\(\) reference/;
  rejectsBody(`<rect style="mask-image:src(&quot;https://example.test/x&quot;)"/>`, fetchFunction);
  rejectsBody(`<rect fill="image('https://example.test/x')"/>`, fetchFunction);
  rejectsBody(`<rect fill="IMAGE('#a')"/>`, fetchFunction);
  rejectsBody("<style>@font-face{src:src(https://example.test/f)}</style>", fetchFunction);
  rejectsBody("<style>rect{mask-image:image(&quot;x.png&quot;)}</style>", fetchFunction);
  rejectsBody("<style>rect{mask:(image('x.png'))}</style>", fetchFunction);
  rejectsBody("<style>rect{mask:,src(x)}</style>", fetchFunction);

  assert.deepEqual(
    inspectSvg(
      makeSvg(
        '<g aria-label="image (left)"/><g class="src (draft) image (left) feimage(x) resrc(y)"/>' +
          "<style>rect{x:feimage(1);y:mysrc(2)}</style>",
      ),
    ),
    svgInfo(64, 32),
  );
});

test("inspectSvg limits element nesting depth to 512", () => {
  // The root svg element is depth 1.
  assert.deepEqual(inspectSvg(makeSvg("<g>".repeat(511) + "</g>".repeat(511))), svgInfo(64, 32));
  assert.deepEqual(inspectSvg(makeSvg("<g>".repeat(510) + "<g/>" + "</g>".repeat(510))), svgInfo(64, 32));
  rejectsBody("<g>".repeat(512) + "</g>".repeat(512), /nested too deeply/);
  rejectsBody("<g>".repeat(511) + "<g/>" + "</g>".repeat(511), /nested too deeply/);
});

test("inspectSvg inspects multi-megabyte style text and attribute values", { timeout: 60_000 }, () => {
  const size = 6 * 1024 * 1024;
  const benignStyle = "a { fill: url(#g) }\n".repeat(size / 20);
  const benignValue = "1 2,3\t".repeat(size / 6);
  assert.deepEqual(inspectSvg(makeSvg(`<style>${benignStyle}</style>`)), svgInfo(64, 32));
  assert.deepEqual(inspectSvg(makeSvg(`<g class="${benignValue}"/>`)), svgInfo(64, 32));
  rejectsBody(
    `<style>${benignStyle}b { fill: url(https://example.test/x) }</style>`,
    /style content contains an external url\(\) reference/,
  );
  rejectsBody(
    `<g class="${benignValue} url(https://example.test/x)"/>`,
    /attribute value contains an external url\(\) reference/,
  );
});

test("inspectSvg rejects active content in style elements", () => {
  rejectsBody("<style>@import 'theme.css';</style>", /@import rule/);
  rejectsBody("<style>@IMPORT url(#a);</style>", /@import rule/);
  rejectsBody("<style>&#64;import 'theme.css';</style>", /@import rule/);
  rejectsBody("<style>@im<!-- split -->port 'theme.css';</style>", /@import rule/);
  rejectsBody("<style>@im<![CDATA[port 'theme.css';]]></style>", /@import rule/);
  rejectsBody(
    "<style><![CDATA[ rect { fill: url(https://example.test/x) } ]]></style>",
    /external url\(\) reference/,
  );
  rejectsBody(
    '<style>rect { fill: url( "https://example.test/x" ) }</style>',
    /external url\(\) reference/,
  );
  rejectsBody(String.raw`<style>rect { fill: u\72l(https://example.test/x) }</style>`, /CSS escape/);
  rejectsBody(
    `<s:STYLE xmlns:s="${SVG_NS}">@import 'theme.css';</s:STYLE>`,
    /@import rule/,
  );
  rejectsBody("<style><g/></style>", /style element must contain only text/);
});

const SVG11_DOCTYPE =
  '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">';
const SVG10_DOCTYPE =
  '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.0//EN" "http://www.w3.org/TR/2001/REC-SVG-20010904/DTD/svg10.dtd">';

test("inspectSvg accepts only the standard SVG 1.0 and 1.1 document type declarations", () => {
  const svg = makeSvg().toString("utf8");
  assert.deepEqual(inspectSvg(Buffer.from(`${SVG11_DOCTYPE}${svg}`)), svgInfo(64, 32));
  assert.deepEqual(inspectSvg(Buffer.from(`${SVG10_DOCTYPE}\n${svg}`)), svgInfo(64, 32));
  assert.deepEqual(
    inspectSvg(
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>\n<!-- exported -->\n${SVG11_DOCTYPE.replace(" PUBLIC ", "\n  PUBLIC\t").replace('EN" "', 'EN"\n  "')}\n${svg}`,
      ),
    ),
    svgInfo(64, 32),
  );

  const doctype = /document type declaration/;
  rejectsSvg(`<!DOCTYPE svg>${svg}`, doctype);
  rejectsSvg(
    `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [<!ENTITY xxe SYSTEM "https://example.test/x">]>${makeSvg("&xxe;").toString("utf8")}`,
    doctype,
  );
  rejectsSvg(
    `<!DOCTYPE svg [<!ENTITY xxe SYSTEM "https://example.test/x">]>${makeSvg("&xxe;").toString("utf8")}`,
    doctype,
  );
  rejectsSvg(`<!DOCTYPE svg SYSTEM "https://example.test/x.dtd">${svg}`, doctype);
  rejectsSvg(`${SVG11_DOCTYPE.replace("1.1//EN", "1.1//XX")}${svg}`, doctype);
  rejectsSvg(`${SVG11_DOCTYPE.replace(">", " >")}${svg}`, doctype);
  rejectsSvg(`${SVG11_DOCTYPE.replace("<!DOCTYPE", "<!doctype")}${svg}`, /markup declarations/);
  rejectsSvg(`${SVG11_DOCTYPE}${SVG11_DOCTYPE}${svg}`, /at most once/);
  rejectsSvg(`${svg}${SVG11_DOCTYPE}`, /markup declarations/);
  rejectsSvg(makeSvg(SVG11_DOCTYPE), /markup declarations/);
  rejectsSvg(`<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"`, doctype);
});

test("inspectSvg rejects markup declarations and processing instructions", () => {
  rejectsSvg(`<!ENTITY xxe "x">${makeSvg().toString("utf8")}`, /markup declarations/);
  rejectsBody("<!ELEMENT g ANY>", /markup declarations/);
  rejectsSvg(
    `<?xml-stylesheet href="https://example.test/x.css"?>${makeSvg().toString("utf8")}`,
    /processing instructions/,
  );
  rejectsBody("<?foo bar?>", /processing instructions/);
  rejectsSvg(`<?xml version="1.0"?><?xml version="1.0"?>${makeSvg().toString("utf8")}`, /processing instructions/);
  rejectsSvg(` <?xml version="1.0"?>${makeSvg().toString("utf8")}`, /processing instructions/);
  rejectsSvg(`<!-- x --><?xml version="1.0"?>${makeSvg().toString("utf8")}`, /processing instructions/);
  rejectsSvg(`<?XML version="1.0"?>${makeSvg().toString("utf8")}`, /processing instructions/);
});

test("inspectSvg rejects malformed or non-UTF-8 XML declarations", () => {
  rejectsSvg(`<?xml version="1.0" encoding="ISO-8859-1"?>${makeSvg().toString("utf8")}`, /UTF-8/);
  rejectsSvg(`<?xml version="1.0" encoding="UTF-16"?>${makeSvg().toString("utf8")}`, /UTF-8/);
  rejectsSvg(`<?xml encoding="UTF-8"?>${makeSvg().toString("utf8")}`, /XML declaration is malformed/);
  rejectsSvg(`<?xml version="1.0"${makeSvg().toString("utf8")}`, /XML declaration is malformed/);
});

test("inspectSvg rejects undefined and invalid entity references", () => {
  rejectsBody("<text>&xxe;</text>", /entity reference is not allowed/);
  rejectsBody('<rect id="&xxe;"/>', /entity reference is not allowed/);
  rejectsBody("<text>&nbsp;</text>", /entity reference is not allowed/);
  rejectsBody("<text>a & b</text>", /entity reference is not allowed/);
  rejectsBody(`<text>&${"a".repeat(64)};</text>`, /entity reference is not allowed/);
  for (const reference of ["&#0;", "&#x1;", "&#xD800;", "&#x110000;", "&#X41;", "&#;", "&#x;", "&#12a;"]) {
    rejectsBody(`<text>${reference}</text>`, /character reference is invalid/);
  }
});

test("inspectSvg requires an unprefixed svg root element", () => {
  rejectsSvg(`<html xmlns="${SVG_NS}"></html>`, /root element/);
  rejectsSvg(`<SVG xmlns="${SVG_NS}"></SVG>`, /root element/);
  rejectsSvg(`<s:svg xmlns:s="${SVG_NS}"></s:svg>`, /root element/);
});

test("inspectSvg rejects namespace declarations other than SVG and XLink", () => {
  rejectsSvg(`<svg xmlns="${XHTML_NS}"></svg>`, /namespace declaration/);
  rejectsSvg(`<svg xmlns=""></svg>`, /namespace declaration/);
  rejectsBody(`<g xmlns:h="${XHTML_NS}"/>`, /namespace declaration/);
  rejectsBody(`<g xmlns="${SVG_NS} "/>`, /namespace declaration/);
});

test("inspectSvg requires default namespace declarations to name the SVG namespace", () => {
  rejectsSvg(`<svg xmlns="${XLINK_NS}" ${SIZE}/>`, /default namespace/);
  rejectsBody(`<g xmlns="${XLINK_NS}"><rect/></g>`, /default namespace/);
  rejectsBody(`<g XMLNS="${XLINK_NS}"/>`, /default namespace/);
  assert.deepEqual(inspectSvg(makeSvg(`<g xmlns="${SVG_NS}"/>`)), svgInfo(64, 32));
  assert.deepEqual(inspectSvg(makeSvg(`<g xmlns:s="${SVG_NS}" xmlns:q="${XLINK_NS}"/>`)), svgInfo(64, 32));
  assert.deepEqual(inspectSvg(Buffer.from(`<svg ${SIZE}><rect/></svg>`)), svgInfo(64, 32));
});

test("inspectSvg rejects unbalanced or malformed tags", () => {
  rejectsBody("<g>", /end tag does not match|not closed/);
  rejectsBody("<g></rect>", /end tag does not match/);
  rejectsSvg(`<svg xmlns="${SVG_NS}"><g>`, /not closed/);
  rejectsSvg(`<svg xmlns="${SVG_NS}">`, /not closed/);
  rejectsSvg(`<svg xmlns="${SVG_NS}"></svg></g>`, /outside the root element/);
  rejectsBody("<g", /tag is malformed/);
  rejectsBody("<g/ >", /tag is malformed/);
  rejectsBody('<g a="1"b="2"/>', /tag is malformed/);
  rejectsBody("<1g/>", /name is malformed/);
  rejectsBody("<a:b:c/>", /name is malformed/);
  rejectsBody("< g/>", /name is malformed/);
  rejectsBody("<g a=1/>", /must be quoted/);
  rejectsBody('<g a="1/>', /tag is malformed/);
  rejectsBody('<g a="1" a="2"/>', /duplicate attribute/);
  rejectsBody('<g a="<"/>', /less-than/);
  rejectsBody("<text>a ]]> b</text>", /\]\]>/);
  rejectsBody("<!-- a -- b -->", /comment is malformed/);
  rejectsBody("<!-- a --->", /comment is malformed/);
  rejectsBody("<!-- a", /comment is malformed/);
  rejectsBody("<![CDATA[ a", /CDATA section is not terminated/);
});

test("inspectSvg rejects content outside the root element", () => {
  const svg = makeSvg().toString("utf8");
  rejectsSvg(`${svg}text`, /outside the root element/);
  rejectsSvg(`text${svg}`, /outside the root element/);
  rejectsSvg(`${svg}&amp;`, /outside the root element/);
  rejectsSvg(`${svg}${svg}`, /only one root element/);
  rejectsSvg(`${svg}<g/>`, /only one root element/);
  rejectsSvg(`<![CDATA[x]]>${svg}`, /CDATA/);
  rejectsSvg(`${svg}<![CDATA[x]]>`, /CDATA/);
  rejectsSvg("", /missing root element/);
  rejectsSvg("  <!-- only a comment -->  ", /missing root element/);
});

test("inspectSvg rejects invalid encodings and control characters", () => {
  const svg = makeSvg("<text>x</text>");
  const textOffset = svg.indexOf("<text>x") + "<text>".length;
  assert.equal(svg[textOffset], "x".charCodeAt(0));

  const invalidUtf8 = Buffer.from(svg);
  invalidUtf8[textOffset] = 0xff;
  rejectsSvg(invalidUtf8, /not valid UTF-8/);

  rejectsSvg(Buffer.concat([Buffer.from([0xff, 0xfe]), svg]), /not valid UTF-8/);

  const withNul = Buffer.from(svg);
  withNul[textOffset] = 0x00;
  rejectsSvg(withNul, /control character/);

  const withEscape = Buffer.from(svg);
  withEscape[textOffset] = 0x1b;
  rejectsSvg(withEscape, /control character/);

  for (const code of [0xfffe, 0xffff]) {
    const nonCharacter = String.fromCharCode(code);
    rejectsBody(`<text>${nonCharacter}</text>`, /non-XML character/);
    rejectsBody(`<rect id="a${nonCharacter}"/>`, /non-XML character/);
    rejectsSvg(`${makeSvg().toString("utf8")}<!--${nonCharacter}-->`, /non-XML character/);
  }
  assert.deepEqual(
    inspectSvg(makeSvg(`<text>${String.fromCharCode(0xfffd, 0xe000)}${String.fromCodePoint(0x10ffff)}</text>`)),
    svgInfo(64, 32),
  );

  rejectsSvg(`\uFEFF\uFEFF${svg.toString("utf8")}`, /outside the root element/);
});

test("inspectSvg accepts exactly the byte limit and rejects one byte more", () => {
  const padding = MAX_SVG_BYTES - makeSvg().length;
  const atLimit = makeSvg(" ".repeat(padding));
  assert.equal(atLimit.length, MAX_SVG_BYTES);
  assert.deepEqual(inspectSvg(atLimit), svgInfo(64, 32));

  const overLimit = makeSvg(" ".repeat(padding + 1));
  assert.equal(overLimit.length, MAX_SVG_BYTES + 1);
  rejectsSvg(overLimit, /byte limit/);
});

test("inspectOutputImage validates SVG output", async () => {
  assert.deepEqual(await inspectOutputImage(makeSvg(), "svg"), svgInfo(64, 32));
  await assert.rejects(() => inspectOutputImage(makeSvg("<script/>"), "svg"), isInputImageError);
  await assert.rejects(() => inspectOutputImage(makePng(), "svg"), isInputImageError);
  await assert.rejects(() => inspectOutputImage(makeSvg(), "png"), isInputImageError);
});

test("inspectSvg stays linear on adversarial input shapes", { timeout: 60_000 }, () => {
  const count = 200_000;
  assert.deepEqual(inspectSvg(makeSvg("<text>" + "&amp;".repeat(count) + "</text>")), svgInfo(64, 32));
  assert.deepEqual(
    inspectSvg(makeSvg(("<g>".repeat(500) + "</g>".repeat(500)).repeat(count / 500))),
    svgInfo(64, 32),
  );
  rejectsBody("<g>".repeat(count) + "</g>".repeat(count), /nested too deeply/);
  assert.deepEqual(inspectSvg(makeSvg("<!--x-->".repeat(count))), svgInfo(64, 32));
  assert.deepEqual(inspectSvg(makeSvg("<g/>a".repeat(count))), svgInfo(64, 32));
  assert.deepEqual(
    inspectSvg(makeSvg(`<g ${Array.from({ length: count }, (_, index) => `a${index}="1"`).join(" ")}/>`)),
    svgInfo(64, 32),
  );
  assert.deepEqual(
    inspectSvg(makeSvg("<style>" + "a{fill:url(#g)}".repeat(count) + "</style>")),
    svgInfo(64, 32),
  );
  assert.deepEqual(
    inspectSvg(makeSvg("<style>" + "<![CDATA[a]]><!--b-->&amp;".repeat(count) + "</style>")),
    svgInfo(64, 32),
  );
  assert.deepEqual(
    inspectSvg(makeSvg(`<rect fill="${"url(#g)".repeat(count)}"/>`)),
    svgInfo(64, 32),
  );
  assert.deepEqual(
    inspectSvg(makeSvg("<style>a{}</style>".repeat(count))),
    svgInfo(64, 32),
  );
  rejectsBody("<text>" + "&#".repeat(count) + "</text>", /character reference is invalid/);
  rejectsBody("<".repeat(count), /name is malformed/);
  rejectsBody(`<g a="${"&".repeat(count)}"/>`, /entity reference is not allowed/);
  rejectsSvg("<!--" + "-".repeat(count), /comment is malformed/);
  rejectsBody(`<g a="${"]".repeat(count)}`, /tag is malformed/);
});
