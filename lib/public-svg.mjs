// Static SVG is teaching content, but SVG also supports scripts, embedded HTML,
// URL loads and animation. Rebuild a closed, balanced drawing vocabulary instead
// of sending model-authored SVG markup to the browser unchanged.
const TAGS = new Map("svg g path rect circle line text tspan polyline polygon ellipse defs marker clipPath title desc linearGradient radialGradient stop".split(" ").map(tag => [tag.toLowerCase(), tag]));
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,99}$/;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const LENGTH = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:%|px|em|rem)?$/;
const NUMBERS = /^[\d\s.,eE+-]+$/;
const escapeAttribute = value => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeText = value => value.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const GEOMETRY = new Set("x y x1 y1 x2 y2 cx cy r rx ry width height dx dy refx refy markerwidth markerheight stroke-width stroke-dashoffset font-size".split(" "));
const CAMEL = { viewbox: "viewBox", preserveaspectratio: "preserveAspectRatio", refx: "refX", refy: "refY", markerwidth: "markerWidth", markerheight: "markerHeight", markerunits: "markerUnits", clippathunits: "clipPathUnits", gradientunits: "gradientUnits", gradienttransform: "gradientTransform", spreadmethod: "spreadMethod" };
const ENUMS = {
  "text-anchor": /^(?:start|middle|end)$/, "dominant-baseline": /^(?:auto|middle|central|hanging|text-before-edge|text-after-edge|alphabetic)$/,
  "stroke-linecap": /^(?:butt|round|square)$/, "stroke-linejoin": /^(?:miter|round|bevel)$/, "fill-rule": /^(?:nonzero|evenodd)$/, "clip-rule": /^(?:nonzero|evenodd)$/,
  "font-weight": /^(?:normal|bold|[1-9]00)$/, "font-style": /^(?:normal|italic|oblique)$/, "vector-effect": /^(?:none|non-scaling-stroke)$/,
  markerunits: /^(?:strokeWidth|userSpaceOnUse)$/, clippathunits: /^(?:userSpaceOnUse|objectBoundingBox)$/, gradientunits: /^(?:userSpaceOnUse|objectBoundingBox)$/,
  spreadmethod: /^(?:pad|reflect|repeat)$/,
};

function transform(value) {
  return value.length <= 1000 && /^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\(\s*[\d\s.,eE+-]+\)\s*)+$/.test(value);
}

function parsedAttributes(token) {
  const result = [], names = new Set();
  for (const attr of token.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = attr[1].toLowerCase(), value = attr[2] ?? attr[3] ?? attr[4] ?? "";
    if (names.has(name)) continue;
    names.add(name); result.push({ name, value });
  }
  return result;
}

function attributes(token, prefix, identifiers) {
  const result = [];
  for (const { name, value } of parsedAttributes(token)) {
    if (value.length > 20000) continue;
    let keep = false, rendered = value;
    if (name === "id" && ID.test(value) && identifiers.get(value)?.length === 1) { keep = true; rendered = prefix + value; }
    else if (["class", "title", "role", "aria-label", "aria-hidden"].includes(name)) keep = value.length <= 500;
    else if (GEOMETRY.has(name)) keep = value.length <= 64 && LENGTH.test(value);
    else if (["opacity", "fill-opacity", "stroke-opacity", "stop-opacity"].includes(name)) keep = NUMBER.test(value) && Number(value) >= 0 && Number(value) <= 1;
    else if (name === "viewbox") keep = value.length <= 150 && NUMBERS.test(value) && value.trim().split(/[\s,]+/).length === 4;
    else if (name === "preserveaspectratio") keep = /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/.test(value);
    else if (name === "d") keep = /^[MmLlHhVvCcSsQqTtAaZz\d\s.,eE+-]+$/.test(value);
    else if (name === "points") keep = NUMBERS.test(value);
    else if (name === "transform" || name === "gradienttransform") keep = transform(value);
    else if (name === "stroke-dasharray") keep = value.length <= 200 && (value === "none" || NUMBERS.test(value));
    else if (name === "stroke-miterlimit") keep = NUMBER.test(value) && Number(value) >= 1;
    else if (name === "orient") keep = /^(?:auto|auto-start-reverse|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:deg)?)$/.test(value);
    else if (name === "offset") keep = /^(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(value);
    else if (ENUMS[name]) keep = ENUMS[name].test(value);
    else if (["fill", "stroke", "color", "stop-color"].includes(name)) {
      // CSS variables retain the book palette. Whole-book CSS is checked by
      // public-render, so these cannot hide a URL-bearing custom property.
      keep = /^(?:[a-zA-Z]+|#[\da-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+-]+\)|var\(--[a-zA-Z][a-zA-Z0-9_-]*\))$/.test(value);
    }
    if (!keep && ["fill", "stroke", "clip-path", "marker-start", "marker-mid", "marker-end"].includes(name)) {
      const ref = value.match(/^url\(#([A-Za-z][A-Za-z0-9_-]{0,99})\)$/), targets = ref && identifiers.get(ref[1]);
      const expected = name === "clip-path" ? ["clipPath"] : name.startsWith("marker-") ? ["marker"] : ["linearGradient", "radialGradient"];
      if (targets?.length === 1 && expected.includes(targets[0])) { keep = true; rendered = `url(#${prefix}${ref[1]})`; }
    }
    if (keep) result.push(`${CAMEL[name] || name}="${escapeAttribute(rendered)}"`);
  }
  return result.length ? " " + result.join(" ") : "";
}

// Called at a known <svg> start. Return its consumed source range separately so
// malformed SVG cannot switch the surrounding HTML sanitizer into a new mode.
export function readStaticSvg(source, start, ordinal) {
  const stack = [], identifiers = new Map();
  let root = null, offset = start;
  const appendText = value => { if (stack.length && !stack.at(-1).blocked) stack.at(-1).children.push(escapeText(value)); };
  while (offset < source.length) {
    const next = source.indexOf("<", offset);
    if (next < 0) { appendText(source.slice(offset)); offset = source.length; break; }
    appendText(source.slice(offset, next));
    if (source.startsWith("<!--", next)) {
      const end = source.indexOf("-->", next + 4); offset = end < 0 ? source.length : end + 3; continue;
    }
    if (source.startsWith("<![CDATA[", next)) {
      const end = source.indexOf("]]>", next + 9);
      appendText(source.slice(next + 9, end < 0 ? source.length : end)); offset = end < 0 ? source.length : end + 3; continue;
    }
    let end = next + 1, quote = null;
    for (; end < source.length; end++) {
      const char = source[end];
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (end === source.length) { appendText(source.slice(next)); offset = source.length; break; }
    const token = source.slice(next, end + 1), match = token.match(/^<(\/?)\s*([a-z][a-z0-9:-]*)\b/i);
    offset = end + 1;
    if (!match) continue;
    const tag = match[2].toLowerCase();
    if (match[1]) {
      const index = stack.map(node => node.sourceTag).lastIndexOf(tag);
      if (index >= 0) stack.length = index;
      if (!stack.length) break;
      continue;
    }
    const parent = stack.at(-1);
    // Bound both parser and serializer work for malicious nesting. The already
    // accepted tree remains balanced; deeply malformed trailing input is omitted.
    if (stack.length >= 64) { offset = source.length; break; }
    const node = { sourceTag: tag, tag: TAGS.get(tag), attrs: token.slice(match[0].length, -1), children: [],
      blocked: !TAGS.has(tag) || Boolean(parent?.blocked) || ["title", "desc"].includes(parent?.tag) };
    if (!root) root = node;
    else if (!node.blocked) parent?.children.push(node);
    if (!node.blocked) {
      // Attribute parsing and output share the same strict ID grammar. Keep all
      // duplicates here so ambiguous references are rejected, even forward refs.
      const value = parsedAttributes(node.attrs).find(attr => attr.name === "id")?.value;
      if (value && ID.test(value)) { const matches = identifiers.get(value) || []; matches.push(node.tag); identifiers.set(value, matches); }
    }
    if (!/\/\s*>$/.test(token)) stack.push(node);
    else if (!parent) break;
  }
  const prefix = `shelf-figure-${ordinal}-`;
  const render = node => typeof node === "string" ? node : `<${node.tag}${attributes(node.attrs, prefix, identifiers)}>${node.children.map(render).join("")}</${node.tag}>`;
  return { html: root && !root.blocked ? render(root) : "", offset };
}
