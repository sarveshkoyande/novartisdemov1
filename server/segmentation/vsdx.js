// Render a Flow Planner design as a native Visio .vsdx — ported from
// app/visio.py. A .vsdx is an OOXML package (a zip of XML parts), built
// directly here with jszip rather than through a Visio library — same
// reasoning as the reference project: there is no mature writer for the
// format, and a native file (real shapes, glued connectors) is the point of
// generating into Visio at all, not a picture of one.

const JSZip = require('jszip');
const { colours, extent, layout, normalise, route } = require('./drawing');

const PX_PER_INCH = 96.0;
const PAGE_MARGIN_IN = 0.4;
const END_ARROW = '4';

const NS = 'http://schemas.microsoft.com/office/visio/2012/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const MS_2010 = 'http://schemas.microsoft.com/visio/2010/relationships';

const ROUNDED = new Set(['process', 'segment', 'entry']);
const PILL = new Set(['stop', 'exit']);

function esc(text) {
  return String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inch(px) {
  return (px / PX_PER_INCH).toFixed(4);
}

function cell(name, value, formula) {
  return formula ? `<Cell N="${name}" V="${value}" F="${esc(formula)}"/>` : `<Cell N="${name}" V="${value}"/>`;
}

function geomCell(name, factor, extentIn) {
  const axis = name === 'X' ? 'Width' : 'Height';
  return `<Cell N="${name}" V="${(factor * extentIn).toFixed(4)}" F="${axis}*${factor}"/>`;
}

function row(kind, index, wIn, hIn, x, y) {
  return `<Row T="${kind}" IX="${index}">` + geomCell('X', x, wIn) + geomCell('Y', y, hIn) + '</Row>';
}

function geometry(nodeType, wIn, hIn) {
  let path;
  if (nodeType === 'decision') {
    path = [row('MoveTo', 1, wIn, hIn, 0.5, 0), row('LineTo', 2, wIn, hIn, 1, 0.5), row('LineTo', 3, wIn, hIn, 0.5, 1), row('LineTo', 4, wIn, hIn, 0, 0.5), row('LineTo', 5, wIn, hIn, 0.5, 0)];
  } else if (nodeType === 'datasource') {
    path = [
      row('MoveTo', 1, wIn, hIn, 0, 0.88),
      `<Row T="EllipticalArcTo" IX="2">${geomCell('X', 1, wIn)}${geomCell('Y', 0.88, hIn)}<Cell N="A" V="${(0.5 * wIn).toFixed(4)}" F="Width*0.5"/><Cell N="B" V="${hIn.toFixed(4)}" F="Height*1"/><Cell N="C" V="0"/><Cell N="D" V="1"/></Row>`,
      row('LineTo', 3, wIn, hIn, 1, 0.12),
      `<Row T="EllipticalArcTo" IX="4">${geomCell('X', 0, wIn)}${geomCell('Y', 0.12, hIn)}<Cell N="A" V="${(0.5 * wIn).toFixed(4)}" F="Width*0.5"/><Cell N="B" V="0" F="Height*0"/><Cell N="C" V="0"/><Cell N="D" V="1"/></Row>`,
      row('LineTo', 5, wIn, hIn, 0, 0.88),
    ];
  } else {
    path = [row('MoveTo', 1, wIn, hIn, 0, 0), row('LineTo', 2, wIn, hIn, 1, 0), row('LineTo', 3, wIn, hIn, 1, 1), row('LineTo', 4, wIn, hIn, 0, 1), row('LineTo', 5, wIn, hIn, 0, 0)];
  }
  return `<Section N="Geometry" IX="0">${cell('NoFill', '0')}${cell('NoLine', '0')}${path.join('')}</Section>`;
}

function shapeText(node) {
  const label = String(node.label || '');
  const parts = [label];
  let detail = String(node.detail || '');
  if (node.type === 'note') {
    const lines = [];
    for (const box of (node.attrs || {}).boxes || []) {
      lines.push(String(box.title || ''));
      for (const l of box.lines || []) lines.push(String(l));
    }
    detail = lines.join('\n');
  }
  if (detail) parts.push(detail);
  if (node.tbd && node.tbd.length) parts.push('TBD: ' + node.tbd.join(', '));

  const out = [];
  for (const line of parts.filter(Boolean).join('\n').split('\n')) {
    if (!out.length || line.trim() !== out[out.length - 1].trim()) out.push(line);
  }
  return out.join('\n');
}

function textShape(shapeId, text, x, y, w, h, pageHPx, { sizeIn = '0.0917', bold = false, colour = '#555250' } = {}) {
  return (
    `<Shape ID="${shapeId}" NameU="pane.line" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">` +
    cell('PinX', inch(x + w / 2)) + cell('PinY', inch(pageHPx - (y + h / 2))) +
    cell('Width', inch(w)) + cell('Height', inch(h)) +
    cell('LocPinX', inch(w / 2), 'Width*0.5') + cell('LocPinY', inch(h / 2), 'Height*0.5') +
    cell('FillPattern', '0') + cell('LinePattern', '0') +
    cell('LeftMargin', '0') + cell('RightMargin', '0') + cell('TopMargin', '0') + cell('BottomMargin', '0') +
    cell('VerticalAlign', '1') +
    `<Section N="Character"><Row IX="0">${cell('Size', sizeIn)}${cell('Color', colour)}${cell('Style', bold ? '1' : '0')}</Row></Section>` +
    `<Section N="Paragraph"><Row IX="0">${cell('HorzAlign', '0')}</Row></Section>` +
    `<Text>${esc(text)}</Text></Shape>`
  );
}

function swatchShape(shapeId, colour, x, y, pageHPx) {
  const size = 9.0;
  const wIn = size / PX_PER_INCH, hIn = wIn;
  return (
    `<Shape ID="${shapeId}" NameU="legend.swatch" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">` +
    cell('PinX', inch(x + size / 2)) + cell('PinY', inch(pageHPx - (y + size / 2))) +
    cell('Width', inch(size)) + cell('Height', inch(size)) +
    cell('LocPinX', inch(size / 2), 'Width*0.5') + cell('LocPinY', inch(size / 2), 'Height*0.5') +
    cell('FillForegnd', colour) + cell('LineColor', colour) + cell('LineWeight', '0.0069') +
    `<Section N="Geometry" IX="0">${cell('NoFill', '0')}${cell('NoLine', '0')}` +
    row('MoveTo', 1, wIn, hIn, 0, 0) + row('LineTo', 2, wIn, hIn, 1, 0) + row('LineTo', 3, wIn, hIn, 1, 1) + row('LineTo', 4, wIn, hIn, 0, 1) + row('LineTo', 5, wIn, hIn, 0, 0) +
    '</Section><Text/></Shape>'
  );
}

function paneContents(nextId, node, x, y, w, pageHPx) {
  const shapes = [];
  shapes.push(textShape(nextId, node.label || '', x + 12, y + 10, w - 24, 16, pageHPx, { sizeIn: '0.1042', bold: true, colour: '#161616' }));
  nextId += 1;

  let cy = y + 32;
  for (const box of (node.attrs || {}).boxes || []) {
    shapes.push(textShape(nextId, box.title || '', x + 12, cy, w - 24, 16, pageHPx, { sizeIn: '0.0875', bold: true, colour: '#8A8681' }));
    nextId += 1;
    cy += 16;
    const chips = {};
    for (const s of box.swatches || []) chips[s.label] = s.colour;
    for (const line of box.lines || []) {
      const colour = chips[line];
      if (colour) {
        shapes.push(swatchShape(nextId, colour, x + 12, cy + 3, pageHPx));
        nextId += 1;
      }
      shapes.push(textShape(nextId, line, x + (colour ? 26 : 12), cy, w - 38, 16, pageHPx));
      nextId += 1;
      cy += 16;
    }
    cy += 10;
  }
  return [shapes, nextId];
}

function shapeXml(shapeId, node, x, y, w, h, pageHPx) {
  const [fill, accent] = colours(node);
  const kind = node.type;
  const pinX = inch(x + w / 2), pinY = inch(pageHPx - (y + h / 2));

  const cells = [
    cell('PinX', pinX), cell('PinY', pinY),
    cell('Width', inch(w)), cell('Height', inch(h)),
    cell('LocPinX', inch(w / 2), 'Width*0.5'), cell('LocPinY', inch(h / 2), 'Height*0.5'),
    cell('FillForegnd', fill), cell('LineColor', accent), cell('LineWeight', '0.0111'),
    cell('LinePattern', node.tbd && node.tbd.length ? '2' : '1'),
    cell('TextBkgnd', '0'), cell('VerticalAlign', '1'), cell('Para', '0'),
  ];
  if (ROUNDED.has(kind)) cells.push(cell('Rounding', '0.08'));
  else if (PILL.has(kind)) cells.push(cell('Rounding', inch(h / 2)));

  const char = `<Section N="Character"><Row IX="0">${cell('Size', '0.11')}${cell('Color', '#161616')}</Row></Section>`;

  return (
    `<Shape ID="${shapeId}" NameU="${esc(node.id)}" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">` +
    cells.join('') + char + geometry(kind, w / PX_PER_INCH, h / PX_PER_INCH) +
    (kind === 'note' ? '<Text/>' : `<Text>${esc(shapeText(node))}</Text>`) + '</Shape>'
  );
}

function connectorXml(shapeId, points, label, pageHPx) {
  const page = points.map(([px, py]) => [px / PX_PER_INCH, (pageHPx - py) / PX_PER_INCH]);
  const [bxIn, byIn] = page[0], [exIn, eyIn] = page[page.length - 1];
  const run = exIn - bxIn, rise = eyIn - byIn;
  const length = Math.hypot(run, rise) || 0.0001;
  const angle = Math.atan2(rise, run);

  const cells = [
    cell('PinX', ((bxIn + exIn) / 2).toFixed(4)), cell('PinY', ((byIn + eyIn) / 2).toFixed(4)),
    cell('Width', length.toFixed(4)), cell('Height', '0.0000'),
    cell('LocPinX', (length / 2).toFixed(4), 'Width*0.5'), cell('LocPinY', '0.0000', 'Height*0.5'),
    cell('Angle', angle.toFixed(6)),
    cell('BeginX', bxIn.toFixed(4)), cell('BeginY', byIn.toFixed(4)),
    cell('EndX', exIn.toFixed(4)), cell('EndY', eyIn.toFixed(4)),
    cell('ObjType', '2'), cell('ShapeRouteStyle', '1'), cell('ConFixedCode', '0'),
    cell('LineColor', '#8A8681'), cell('LineWeight', '0.0111'),
    cell('EndArrow', END_ARROW), cell('EndArrowSize', '2'), cell('TextBkgnd', '1'),
  ];

  const cosT = Math.cos(angle), sinT = Math.sin(angle);
  const rows = page.map(([px, py], index) => {
    const vx = px - bxIn, vy = py - byIn;
    const localX = vx * cosT + vy * sinT;
    const localY = -vx * sinT + vy * cosT;
    return `<Row T="${index === 0 ? 'MoveTo' : 'LineTo'}" IX="${index + 1}"><Cell N="X" V="${localX.toFixed(4)}"/><Cell N="Y" V="${localY.toFixed(4)}"/></Row>`;
  });
  const geom = `<Section N="Geometry" IX="0">${cell('NoFill', '1')}${cell('NoLine', '0')}${rows.join('')}</Section>`;
  const char = `<Section N="Character"><Row IX="0">${cell('Size', '0.09')}${cell('Color', '#8A8681')}</Row></Section>`;
  const text = label ? `<Text>${esc(label)}</Text>` : '<Text/>';

  return `<Shape ID="${shapeId}" NameU="Dynamic connector" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">${cells.join('')}${char}${geom}${text}</Shape>`;
}

function contentTypes() {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Types xmlns="${NS_CT}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/>' +
    '<Override PartName="/visio/pages/pages.xml" ContentType="application/vnd.ms-visio.pages+xml"/>' +
    '<Override PartName="/visio/pages/page1.xml" ContentType="application/vnd.ms-visio.page+xml"/>' +
    '<Override PartName="/visio/windows.xml" ContentType="application/vnd.ms-visio.windows+xml"/>' +
    '</Types>'
  );
}

function rootRels() {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${MS_2010}/document" Target="visio/document.xml"/>` +
    `<Relationship Id="rId2" Type="${NS_PKG_REL}/metadata/core-properties" Target="docProps/core.xml"/>` +
    `<Relationship Id="rId3" Type="${NS_REL}/extended-properties" Target="docProps/app.xml"/>` +
    '</Relationships>'
  );
}

function documentXml() {
  const style =
    '<StyleSheet ID="0" NameU="No Style" Name="No Style" IsCustomName="0" IsCustomNameU="0">' +
    cell('EnableLineProps', '1') + cell('EnableFillProps', '1') + cell('EnableTextProps', '1') +
    cell('LineWeight', '0.0111') + cell('LineColor', '#000000') + cell('LinePattern', '1') +
    cell('FillForegnd', '#FFFFFF') + cell('FillPattern', '1') +
    '<Section N="Character"><Row IX="0">' + cell('Font', 'Calibri') + cell('Size', '0.1111') + cell('Color', '#000000') + '</Row></Section>' +
    '<Section N="Paragraph"><Row IX="0">' + cell('HorzAlign', '1') + '</Row></Section>' +
    '</StyleSheet>';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<VisioDocument xmlns="${NS}" xmlns:r="${NS_REL}" xml:space="preserve">` +
    '<DocumentSettings TopPage="0" DefaultTextStyle="0" DefaultLineStyle="0" DefaultFillStyle="0" DefaultGuideStyle="0">' +
    '<GlueSettings>9</GlueSettings><SnapSettings>65847</SnapSettings></DocumentSettings>' +
    '<Colors/><FaceNames/>' +
    `<StyleSheets>${style}</StyleSheets></VisioDocument>`
  );
}

function windowsXml(pageWPx, pageHPx) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Windows xmlns="${NS}" xmlns:r="${NS_REL}" ClientWidth="1000" ClientHeight="700">` +
    '<Window ID="0" WindowType="Drawing" WindowState="1073741824" WindowLeft="0" WindowTop="0" WindowWidth="1000" WindowHeight="700" ' +
    `ContainerType="Page" Page="0" ViewScale="-1" ViewCenterX="${inch(pageWPx / 2)}" ViewCenterY="${inch(pageHPx / 2)}"/></Windows>`
  );
}

function documentRels() {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${MS_2010}/pages" Target="pages/pages.xml"/>` +
    `<Relationship Id="rId2" Type="${MS_2010}/windows" Target="windows.xml"/></Relationships>`
  );
}

function pagesXml(title, pageWPx, pageHPx) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Pages xmlns="${NS}" xmlns:r="${NS_REL}" xml:space="preserve">` +
    `<Page ID="0" NameU="${esc(title)}" Name="${esc(title)}" ViewScale="-1" ViewCenterX="${inch(pageWPx / 2)}" ViewCenterY="${inch(pageHPx / 2)}">` +
    '<PageSheet LineStyle="0" FillStyle="0" TextStyle="0">' +
    cell('PageWidth', inch(pageWPx)) + cell('PageHeight', inch(pageHPx)) +
    cell('PageScale', '1') + cell('DrawingScale', '1') + cell('DrawingSizeType', '3') + cell('DrawingScaleType', '0') +
    '</PageSheet><Rel r:id="rId1"/></Page></Pages>'
  );
}

function pagesRels() {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${MS_2010}/page" Target="page1.xml"/></Relationships>`
  );
}

function coreProps(title) {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${esc(title)}</dc:title><dc:creator>Accelerate</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified></cp:coreProperties>`
  );
}

function appProps() {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>Microsoft Visio</Application><AppVersion>15.0000</AppVersion></Properties>'
  );
}

async function flowVsdx(spec, title) {
  const [nodes, edges] = normalise(spec);
  const pos = layout(nodes, edges);
  const marginPx = PAGE_MARGIN_IN * PX_PER_INCH;

  // Same collision-avoidance as the SVG renderer (see drawing.js's route())
  // — computed up front so a detour that reaches further right than any
  // block can still grow the page instead of landing off it.
  const routes = edges.map((edge) => {
    const src = pos[edge.from];
    const dst = pos[edge.to];
    if (!src || !dst) return null;
    const obstacles = Object.entries(pos)
      .filter(([id]) => id !== edge.from && id !== edge.to)
      .map(([, rect]) => rect);
    return { edge, points: route(src, dst, obstacles) };
  }).filter(Boolean);

  let [pageW, pageH] = extent(pos);
  for (const { points } of routes) {
    for (const [x, y] of points) {
      pageW = Math.max(pageW, x);
      pageH = Math.max(pageH, y);
    }
  }
  pageW += marginPx;
  pageH += marginPx;

  const shapeIds = {};
  const shapes = [];
  let nextId = 1;
  for (const node of nodes) {
    const placed = pos[node.id];
    if (!placed) continue;
    shapeIds[node.id] = nextId;
    shapes.push(shapeXml(nextId, node, ...placed, pageH));
    nextId += 1;
    if (node.type === 'note') {
      const [paneShapes, newNext] = paneContents(nextId, node, placed[0], placed[1], placed[2], pageH);
      shapes.push(...paneShapes);
      nextId = newNext;
    }
  }

  const connects = [];
  for (const { edge, points } of routes) {
    const cid = nextId;
    nextId += 1;
    shapes.push(connectorXml(cid, points, edge.label, pageH));
    connects.push(`<Connect FromSheet="${cid}" FromCell="BeginX" FromPart="9" ToSheet="${shapeIds[edge.from]}" ToCell="PinX" ToPart="3"/>`);
    connects.push(`<Connect FromSheet="${cid}" FromCell="EndX" FromPart="12" ToSheet="${shapeIds[edge.to]}" ToCell="PinX" ToPart="3"/>`);
  }

  const page =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<PageContents xmlns="${NS}" xmlns:r="${NS_REL}" xml:space="preserve"><Shapes>${shapes.join('')}</Shapes>` +
    (connects.length ? `<Connects>${connects.join('')}</Connects>` : '') +
    '</PageContents>';

  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes());
  zip.file('_rels/.rels', rootRels());
  zip.file('docProps/app.xml', appProps());
  zip.file('docProps/core.xml', coreProps(title));
  zip.file('visio/document.xml', documentXml());
  zip.file('visio/windows.xml', windowsXml(pageW, pageH));
  zip.file('visio/_rels/document.xml.rels', documentRels());
  zip.file('visio/pages/pages.xml', pagesXml(title, pageW, pageH));
  zip.file('visio/pages/_rels/pages.xml.rels', pagesRels());
  zip.file('visio/pages/page1.xml', page);

  return zip.generateAsync({ type: 'nodebuffer' });
}

module.exports = { flowVsdx };
