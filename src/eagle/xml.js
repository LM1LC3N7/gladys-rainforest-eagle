// -----------------------------------------------------------------------------
// A small XML reader for the answers of the Eagle, which are plain element
// trees (`<DeviceList><Device><HardwareAddress>0x…</HardwareAddress>…`). The
// library uses xmltodict; this reads the same shape, and nothing more:
// - one pass over the text, each `<` and `>` found once (linear, no
//   backtracking regular expression);
// - bounded: at most MAX_ELEMENTS elements and MAX_DEPTH levels;
// - no DOCTYPE, no entity of its own (only the five XML ones and numeric
//   references): a DOCTYPE is refused, nothing is ever expanded;
// - attributes are skipped (the Eagle sends none that matter);
// - elements are `{ name, children, text }` in plain arrays: no key of the
//   answer ever becomes a property name (no prototype pollution).
// Throws XmlError on anything else.
// -----------------------------------------------------------------------------

export class XmlError extends Error {
  constructor(reason) {
    super(`not xml: ${reason}`);
    this.name = 'XmlError';
  }
}

export const MAX_ELEMENTS = 5000;
export const MAX_DEPTH = 16;

const NAME = /^[A-Za-z_][\w.:-]{0,63}$/;
const ENTITY = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** The text with its references decoded; an unknown or odd one is refused. */
export function decodeText(raw) {
  if (!raw.includes('&')) {
    return raw;
  }
  return raw.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{0,31});/gi, (all, ref) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      if (!(code >= 0x20 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) {
        throw new XmlError('reference');
      }
      return String.fromCodePoint(code);
    }
    if (!Object.hasOwn(ENTITY, ref)) {
      throw new XmlError('entity');
    }
    return ENTITY[ref];
  });
}

/** The root element of `text`. */
export function parseXml(text) {
  if (typeof text !== 'string') {
    throw new XmlError('type');
  }
  const stack = [];
  let root;
  let count = 0;
  let i = 0;
  const addText = (raw) => {
    if (stack.length > 0) {
      stack.at(-1).parts.push(raw);
    } else if (raw.trim() !== '') {
      throw new XmlError('text outside');
    }
  };
  while (i < text.length) {
    const open = text.indexOf('<', i);
    if (open === -1) {
      addText(decodeText(text.slice(i)));
      break;
    }
    if (open > i) {
      addText(decodeText(text.slice(i, open)));
    }
    if (text.startsWith('<?', open)) {
      const end = text.indexOf('?>', open + 2);
      if (end === -1) throw new XmlError('declaration');
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      if (end === -1) throw new XmlError('comment');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open + 9);
      if (end === -1) throw new XmlError('cdata');
      addText(text.slice(open + 9, end));
      i = end + 3;
      continue;
    }
    if (text.startsWith('<!', open)) {
      // A DOCTYPE (and its entities) is never read.
      throw new XmlError('doctype');
    }
    const close = text.indexOf('>', open + 1);
    if (close === -1) {
      throw new XmlError('tag');
    }
    let tag = text.slice(open + 1, close);
    i = close + 1;
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      const element = stack.pop();
      if (!element || element.name !== name) {
        throw new XmlError('mismatch');
      }
      finish(element);
      if (stack.length === 0) {
        root = element;
        onlyMiscAfter(text, i);
        break;
      }
      continue;
    }
    const selfClosing = tag.endsWith('/');
    if (selfClosing) {
      tag = tag.slice(0, -1);
    }
    const space = tag.search(/\s/);
    const name = space === -1 ? tag : tag.slice(0, space);
    if (!NAME.test(name)) {
      throw new XmlError('name');
    }
    count += 1;
    if (count > MAX_ELEMENTS) {
      throw new XmlError('too many elements');
    }
    if (root !== undefined || (stack.length === 0 && count > 1)) {
      throw new XmlError('two roots');
    }
    const element = { name, children: [], text: '', parts: [] };
    if (stack.length > 0) {
      stack.at(-1).children.push(element);
    }
    if (selfClosing) {
      finish(element);
      if (stack.length === 0) {
        root = element;
      }
      continue;
    }
    if (stack.length >= MAX_DEPTH) {
      throw new XmlError('too deep');
    }
    stack.push(element);
  }
  if (stack.length > 0 || !root) {
    throw new XmlError('unclosed');
  }
  return root;
}

/** Only whitespace, comments or declarations may follow the root (one pass). */
function onlyMiscAfter(text, from) {
  let i = from;
  while (i < text.length) {
    const open = text.indexOf('<', i);
    const gap = text.slice(i, open === -1 ? text.length : open);
    if (gap.trim() !== '') throw new XmlError('after root');
    if (open === -1) return;
    const [start, stop] = text.startsWith('<?', open)
      ? [2, '?>']
      : text.startsWith('<!--', open)
        ? [4, '-->']
        : [0, undefined];
    if (!stop) throw new XmlError('after root');
    const end = text.indexOf(stop, open + start);
    if (end === -1) throw new XmlError('after root');
    i = end + stop.length;
  }
}

function finish(element) {
  element.text = element.parts.join('').trim();
  delete element.parts;
}

/** The first child element named `name`, or undefined. */
export const child = (element, name) => element?.children?.find((c) => c.name === name);

/** Every child element named `name`. */
export const children = (element, name) => (element?.children ?? []).filter((c) => c.name === name);

/** The text of the first child named `name`, or undefined (never a nested element). */
export function textOf(element, name) {
  const found = child(element, name);
  return found && found.children.length === 0 ? found.text : undefined;
}
